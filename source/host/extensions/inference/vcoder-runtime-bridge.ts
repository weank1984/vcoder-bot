// Embeds @vcoder/server's VcoderCoreRuntimeImpl in-process instead of spawning
// the VCoder CLI as a subprocess. This is the library-form agent-core the CLI
// itself is built on (see the vcoder-agent-core-direction project memory):
// running it in-process gets a real token-level text_delta stream straight
// from the provider (instead of the CLI's whole-message stream-json framing),
// removes the per-turn subprocess cold start, and shrinks the crash blast
// radius to a single sendMessage() call instead of an entire CLI process.
//
// Runs against the bot-only VCoder branch (vcoder.lock), whose runtime
// accepts provider/model/credentials and appendSystemPrompt directly via
// startSession settings (trustRuntimeProviderOverrides), so nothing is
// written into VCODER_HOME/settings.json any more.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeEvent } from "@vcoder/agent-core/runtime";
import type { VcoderCoreRuntimeImpl as VcoderCoreRuntimeImplType } from "@vcoder/server/runtime";

import { getSandRootDir } from "../../host-paths.js";
import { effectiveVCoderContextWindow, noteVCoderToolFinished, noteVCoderToolStarted, noteVCoderTurnEnded, noteVCoderTurnStarted, recordVCoderStatusEvent } from "./vcoder-agent-status.js";

export interface VCoderRuntimeStreamChunk {
  readonly type: "reasoning" | "tool-activity" | "message";
  readonly textDelta?: string;
  // type "message": one complete user-facing message (SendUserMessage/Brief).
  readonly text?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly phase?: "started" | "completed";
  readonly isError?: boolean;
  readonly detail?: string;
}

export interface VCoderRuntimeResult {
  // Plain assistant text, used only as a fallback reply when the model
  // delivered no SendUserMessage in this turn.
  readonly text: string;
  readonly deliveredMessages: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number };
}

export interface VCoderRuntimeTurnHandle {
  readonly chunks: AsyncGenerator<VCoderRuntimeStreamChunk>;
  readonly result: Promise<VCoderRuntimeResult>;
}

interface VCoderRuntimeHome {
  readonly vcoderHome: string;
  readonly workingDirectory: string;
}

function resolveVCoderRuntimeHome(): VCoderRuntimeHome {
  const inSandBox = process.env.SAND_SUPERVISOR_ENABLED === "1";
  const vcoderHome = process.env.SAND_VCODER_RUNTIME_HOME?.trim()
    || (inSandBox ? "/home/box/sand-data/vcoder-home" : join(getSandRootDir(), "vcoder-runtime-home"));
  const workingDirectory = inSandBox ? "/workspace" : getSandRootDir();
  return { vcoderHome, workingDirectory };
}

// Earlier builds rendered provider/model/env/outputStyle into
// VCODER_HOME/settings.json. That file still wins as the userSettings layer
// (and its outputStyle would duplicate the bot prompt), so strip those keys.
function removeLegacyRuntimeSettings(home: VCoderRuntimeHome): void {
  mkdirSync(home.vcoderHome, { recursive: true });
  const settingsPath = join(home.vcoderHome, "settings.json");
  let existing: Record<string, unknown>;
  try { existing = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch { return; }
  const { provider: _provider, model: _model, providers: _providers, outputStyle: _outputStyle, env: _env, ...rest } = existing;
  if (Object.keys(rest).length !== Object.keys(existing).length) writeFileSync(settingsPath, JSON.stringify(rest, null, 2));
}

interface VCoderSessionBaseSettings {
  readonly provider?: string;
  readonly model?: string;
  readonly providers?: Record<string, Record<string, unknown>>;
  readonly env: Record<string, string>;
}

let sessionBaseSettings: VCoderSessionBaseSettings | null = null;

let runtimeSingleton: Promise<VcoderCoreRuntimeImplType> | null = null;

// The runtime is a single in-process instance for the lifetime of the host
// process (analogous to how the box's virtual desktop or box-exec-daemon are
// process-lifetime singletons), not one per turn. Sessions, not runtimes, are
// the per-turn unit (see runVCoderRuntimeTurn).
function getVCoderRuntime(): Promise<VcoderCoreRuntimeImplType> {
  runtimeSingleton ??= (async () => {
    const home = resolveVCoderRuntimeHome();
    // Credentials read from the desktop-side ~/.vcoder/settings.json (the
    // pre-existing readVCoderSettingsEnv() source of truth) are re-rendered
    // into the runtime-scoped VCODER_HOME so the embedded runtime can resolve
    // them without also inheriting an unrelated real ~/.vcoder config.
    const { readVCoderSettingsEnv } = await import("../../../shared/node/inference-router-local.js");
    const provider = process.env.SAND_VCODER_PROVIDER?.trim();
    const model = process.env.SAND_VCODER_MODEL?.trim();
    // Models degrade well before their declared window (DeepSeek flash
    // declares 1M but gets slow and sloppy past ~300k), so cap the window
    // the runtime uses for context_detail and the auto-compact threshold.
    const contextWindow = effectiveVCoderContextWindow();
    process.env.VCODER_MAX_CONTEXT_TOKENS ??= String(contextWindow);
    removeLegacyRuntimeSettings(home);
    // A `providers.<builtinId>` entry merges onto the builtin definition, so
    // this caps the declared window (e.g. 1M for deepseek).
    sessionBaseSettings = {
      ...(provider == null || provider.length === 0 ? {} : { provider, providers: { [provider]: { contextWindow, ...(model == null || model.length === 0 ? {} : { contextWindows: { [model]: contextWindow } }) } } }),
      ...(model == null || model.length === 0 ? {} : { model }),
      env: readVCoderSettingsEnv(),
    };
    // VCODER_HOME must be set in this process's env before constructing the
    // runtime: @vcoder/agent-core's getVcoderHome() reads process.env at call
    // time (not just at import time), and every session start re-resolves
    // settings from it.
    process.env.VCODER_HOME = home.vcoderHome;
    const { VcoderCoreRuntimeImpl } = await import("@vcoder/server/runtime");
    const runtime = new VcoderCoreRuntimeImpl(home.workingDirectory, undefined, { trustRuntimeProviderOverrides: true });
    // Background shells/subagents outlive the turn that started them, so
    // they are tracked from a runtime-wide subscription, not the per-turn one.
    const { recordVCoderBackgroundEvent } = await import("./vcoder-background-tasks.js");
    runtime.on("event", (event: RuntimeEvent) => {
      if (event.type === "background_shell_task" || event.type === "subagent_run") recordVCoderBackgroundEvent(event as never);
      else if (event.type === "context_detail" || event.type === "context_compacted") recordVCoderStatusEvent(event as never);
    });
    return runtime;
  })();
  return runtimeSingleton;
}

// Bridges the runtime's callback-based `on('event', ...)` subscription model
// into an async generator so callers can `for await` chunks the same way they
// already do for the CLI-subprocess-backed executors (codex/claude-code).
class RuntimeEventQueue {
  private readonly pending: VCoderRuntimeStreamChunk[] = [];
  private waiter: ((value: IteratorResult<VCoderRuntimeStreamChunk>) => void) | null = null;
  private done = false;
  private failure: unknown;

  push(chunk: VCoderRuntimeStreamChunk): void {
    if (this.waiter != null) { const resolve = this.waiter; this.waiter = null; resolve({ value: chunk, done: false }); return; }
    this.pending.push(chunk);
  }

  finish(): void {
    this.done = true;
    if (this.waiter != null) { const resolve = this.waiter; this.waiter = null; resolve({ value: undefined, done: true }); }
  }

  fail(error: unknown): void {
    this.failure = error;
    this.finish();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<VCoderRuntimeStreamChunk> {
    for (;;) {
      if (this.pending.length > 0) { yield this.pending.shift()!; continue; }
      if (this.done) { if (this.failure != null) throw this.failure; return; }
      const next = await new Promise<IteratorResult<VCoderRuntimeStreamChunk>>(resolve => { this.waiter = resolve; });
      if (next.done === true) { if (this.failure != null) throw this.failure; return; }
      yield next.value;
    }
  }
}

function toolActivityDetail(input: Record<string, unknown>): string | undefined {
  const candidate = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  if (typeof candidate === "string") return candidate.length > 200 ? `${candidate.slice(0, 200)}…` : candidate;
  try { const json = JSON.stringify(input); return json.length > 200 ? `${json.slice(0, 200)}…` : json; } catch { return undefined; }
}

function toolResultPreview(content: string | Array<{ type: string; text?: string }>): string | undefined {
  const text = typeof content === "string" ? content : content.map(block => block.text ?? "").join("");
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

export interface VCoderRuntimeTurnOptions {
  // Extra per-turn instructions (e.g. computer-use availability). Prepended
  // to the user content: it changes every turn, and putting it in the system
  // prompt would defeat prompt caching.
  readonly systemPromptAddendum?: string;
  readonly maxTurns?: number;
  readonly mcpServers?: readonly { readonly type: "http"; readonly name?: string; readonly url: string }[];
  // Stable Grok Bot conversation id. When present the turn runs on a
  // long-lived VCoder session keyed by it (one session per conversation,
  // mirroring VCoder's own VCoderAgent in packages/server/src/agent.ts):
  // `prompt` must then contain only the new input since the last turn, and
  // the runtime's own transcript.jsonl carries the history. When absent the
  // turn runs on a throwaway session and `prompt` must be self-contained.
  readonly conversationId?: string;
  // Used only when the conversation's session cannot be reused (first turn,
  // transcript lost, or history diverged): a self-contained prompt that
  // re-injects the Grok Bot-side history.
  readonly fullPrompt?: string;
  // Fingerprint of the Grok Bot history the session is expected to have
  // seen. A mismatch (edit/delete/compaction on the Grok Bot side) forces a
  // fresh session seeded with fullPrompt.
  readonly historyFingerprint?: string;
  readonly nextHistoryFingerprint?: string;
  // Aborted when Grok Bot interrupts the run (user said stop, or a new
  // message superseded it). Without this the embedded runtime kept running
  // the abandoned turn in the background.
  readonly signal?: AbortSignal;
}

interface ConversationSessionRecord {
  readonly sessionId: string;
  // Grok Bot history fingerprints this session is consistent with. Both the
  // pre-turn and post-turn fingerprints of the latest turn are accepted as
  // soon as the input is sent: an interrupted, failed or still-running turn
  // has still delivered its input to the session, and Grok Bot may or may not
  // have recorded an assistant reply for it. Treating those as divergence
  // re-seeded a fresh session with the whole history on every interruption.
  acceptedFingerprints: Set<string>;
  mcpKey: string;
}

function acceptTurnFingerprints(record: ConversationSessionRecord, options: VCoderRuntimeTurnOptions | undefined): void {
  record.acceptedFingerprints = new Set([options?.historyFingerprint, options?.nextHistoryFingerprint].filter((value): value is string => value != null));
}

// Conversation → VCoder session registry. In-memory, but backed by the
// runtime's on-disk transcript: after a host restart the same sessionId is
// re-started and the runtime reloads transcript.jsonl before the next query
// (vcoder-core.ts messageStore.load), which is exactly VCoderAgent.resumeSession.
const conversationSessions = new Map<string, ConversationSessionRecord>();

function sessionIdForConversation(conversationId: string, generation: number): string {
  return generation === 0 ? `grok-${conversationId}` : `grok-${conversationId}-g${generation}`;
}

function logTiming(sessionId: string, stage: string, startedAt: number, extra?: Record<string, unknown>): void {
  console.info(`[vcoder-timing] ${JSON.stringify({ sessionId, stage, ms: Date.now() - startedAt, ...extra })}`);
}

// How the model should talk to the user (design A: Grok Bot's SendMessage
// model). Passed as RuntimeSettings.appendSystemPrompt.
const GROK_BOT_OUTPUT_STYLE = [
  "You are Grok Bot, a warm, concise assistant running in a chat app. The user only sees messages you send with the SendUserMessage tool; plain assistant text is NOT shown to them.",
  "Each SendUserMessage call is delivered immediately as its own chat message. Always deliver your answer with SendUserMessage — never finish a turn having only written plain text.",
  "For work that takes more than one or two tool calls: first send a one-line acknowledgement of what you are about to do, send a short progress update at meaningful milestones (not after every tool call), then send the result. For a quick question, send one message with the answer. Once the result is sent, end your turn — do not send a closing or \"anything else?\" message.",
  "Your tool calls are approved automatically: the user never sees approval cards, permission prompts or dialogs, and cannot approve anything. Never tell the user a card will appear or ask them to approve a tool. If a tool refuses or blocks a call, say plainly what it returned and what you did instead; do not invent a cause or a next step that did not happen.",
  "Format messages in Markdown. To reach the user's other bots, use the sand_agents SendToAgent tool when available.",
  "",
  "## Working as a team",
  "You are one of several bots this user runs; each has its own chat, persona and memory. Your identity, your teammates' ids and the groups you are in are given to you in a system reminder each turn.",
  "- SendToAgent(target_id, message) delivers to one teammate or posts into a group you belong to. It is asynchronous: it returns immediately, and any reply arrives later as a new turn that starts with the cue [agent] and names the sender. Never wait or poll for a reply inside a turn.",
  "- Hand work off instead of stopping: when your part of a task is done and a teammate owns the next step (review, testing, a decision in their area), send them a short, concrete message with what you did and what you need. When only the user can decide, ask them plainly in your reply.",
  "- When the user asks you to involve a teammate (\"@ the tester\", \"tell my other bot\", \"ask the group\"), use SendToAgent; writing an @-name in your own chat reaches nobody.",
  "- Judgment: message one clearly relevant teammate as part of normal work; do not fan out to several teammates or a whole group unless the user asked for it. Keep agent messages purposeful and minimal, never relay the user's venting verbatim, and do not ping-pong acknowledgements.",
  "- When an [agent] message wakes you, it is another bot, not the user. Act on it if it asks something of you, reply with SendToAgent to its id when you have something to say, and tell the user with SendUserMessage only when there is something new for them. If there is nothing to add, end the turn silently.",
].join("\n");

export function runVCoderRuntimeTurn(prompt: string, options?: VCoderRuntimeTurnOptions): VCoderRuntimeTurnHandle {
  const queue = new RuntimeEventQueue();
  const pendingToolNames = new Map<string, string>();
  // Long-running tools (a multi-minute test suite, a build) otherwise look
  // exactly like a hang in the chat. Re-announce them with elapsed time.
  const pendingToolStarts = new Map<string, { readonly name: string; readonly detail: string | undefined; readonly at: number }>();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, tool] of pendingToolStarts) {
      const seconds = Math.round((now - tool.at) / 1000);
      if (seconds < TOOL_HEARTBEAT_MS / 1000) continue;
      const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
      queue.push({ type: "tool-activity", toolCallId: id, toolName: tool.name, phase: "started", detail: `（已运行 ${elapsed}）${tool.detail ?? ""}` });
    }
  }, TOOL_HEARTBEAT_MS);
  heartbeat.unref?.();
  // Plain text per model request, kept only as a fallback reply if the model
  // never calls SendUserMessage in this turn. Separate requests are joined
  // with a blank line instead of being glued together.
  const textSegments: string[] = [];
  let lastEventWasText = false;
  let deliveredMessages = 0;
  let cumulativeUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const resultDeferred = Promise.withResolvers<VCoderRuntimeResult>();
  const startedAt = Date.now();

  (async () => {
    const runtime = await getVCoderRuntime();
    const home = resolveVCoderRuntimeHome();
    const mcpServers = (options?.mcpServers ?? []).map(server => ({ type: server.type, url: server.url, ...(server.name == null ? {} : { name: server.name }) }));
    const mcpKey = JSON.stringify(mcpServers);
    const conversationId = options?.conversationId;

    let sessionId: string;
    let content = prompt;
    let needsStart = true;
    let mcpChanged = false;
    let record: ConversationSessionRecord | undefined;
    if (conversationId == null) {
      sessionId = randomUUID();
    } else {
      record = conversationSessions.get(conversationId);
      const diverged = record != null && (options?.historyFingerprint == null || !record.acceptedFingerprints.has(options.historyFingerprint));
      if (record == null || diverged) {
        // First turn in this process, or Grok Bot history no longer matches
        // what the session saw. After a host restart reattach the newest
        // on-disk generation (not always g0: that silently dropped whatever
        // happened in later generations); on divergence move past every
        // existing generation so stale history is never replayed.
        const latest = latestTranscriptGeneration(await runtime.listPersistedSessionIds(sessionIdForConversation(conversationId, 0)), conversationId);
        const generation = diverged ? Math.max(latest ?? 0, Number(/-g(\d+)$/.exec(record!.sessionId)?.[1] ?? 0)) + 1 : latest ?? 0;
        sessionId = sessionIdForConversation(conversationId, generation);
        const hasTranscript = !diverged && latest != null;
        if (!hasTranscript && options?.fullPrompt != null) content = options.fullPrompt;
        record = { sessionId, acceptedFingerprints: new Set(), mcpKey };
        conversationSessions.set(conversationId, record);
      } else {
        sessionId = record.sessionId;
        // A changed MCP set (e.g. a new computer-use bridge) is swapped into
        // the live session instead of restarting it.
        needsStart = !runtime.hasSession(sessionId);
        mcpChanged = !needsStart && record.mcpKey !== mcpKey;
        record.mcpKey = mcpKey;
      }
    }

    const onAbort = () => {
      logTiming(sessionId, "cancelled", startedAt);
      void runtime.cancel(sessionId).catch(error => console.error("[vcoder] cancel failed:", error));
    };
    if (options?.signal?.aborted === true) { clearInterval(heartbeat); const failure = new Error("VCoder turn cancelled before start"); queue.fail(failure); resultDeferred.reject(failure); return; }
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    const subscription = runtime.on("event", (event: RuntimeEvent) => {
      if (event.sessionId !== sessionId) return;
      switch (event.type) {
        case "text_delta":
          if (!lastEventWasText) { textSegments.push(""); lastEventWasText = true; if (textSegments.length === 1) logTiming(sessionId, "first-text", startedAt); }
          textSegments[textSegments.length - 1] += event.text;
          queue.push({ type: "reasoning", textDelta: event.text });
          return;
        case "thinking_delta":
          lastEventWasText = false;
          queue.push({ type: "reasoning", textDelta: event.text });
          return;
        case "user_message": {
          lastEventWasText = false;
          deliveredMessages += 1;
          logTiming(sessionId, "message-delivered", startedAt, { index: deliveredMessages });
          queue.push({ type: "message", text: event.message });
          return;
        }
        case "token_usage":
          cumulativeUsage = {
            inputTokens: cumulativeUsage.inputTokens + event.usage.inputTokens,
            outputTokens: cumulativeUsage.outputTokens + event.usage.outputTokens,
            cacheReadTokens: cumulativeUsage.cacheReadTokens + (event.usage.cacheReadInputTokens ?? 0),
            cacheWriteTokens: cumulativeUsage.cacheWriteTokens + (event.usage.cacheCreationInputTokens ?? 0),
          };
          return;
        case "tool_use": {
          lastEventWasText = false;
          if (event.toolCall.status === "failed" || event.toolCall.status === "completed") return;
          // The messaging tools surface as user_message; don't also show them as activity.
          if (MESSAGING_TOOLS.has(event.toolCall.name)) return;
          pendingToolNames.set(event.toolCall.id, event.toolCall.name);
          logTiming(sessionId, "tool-start", startedAt, { tool: event.toolCall.name });
          const detail = toolActivityDetail(event.toolCall.input);
          noteVCoderToolStarted(sessionId, event.toolCall.name, detail);
          pendingToolStarts.set(event.toolCall.id, { name: event.toolCall.name, detail, at: Date.now() });
          queue.push({ type: "tool-activity", toolCallId: event.toolCall.id, toolName: event.toolCall.name, phase: "started", ...(detail == null ? {} : { detail }) });
          return;
        }
        case "tool_result": {
          const toolName = pendingToolNames.get(event.toolResult.id);
          if (toolName == null) return;
          pendingToolNames.delete(event.toolResult.id);
          pendingToolStarts.delete(event.toolResult.id);
          noteVCoderToolFinished(sessionId);
          logTiming(sessionId, "tool-end", startedAt, { tool: toolName, isError: event.toolResult.isError === true });
          const detail = toolResultPreview(event.toolResult.content);
          queue.push({ type: "tool-activity", toolCallId: event.toolResult.id, toolName, phase: "completed", isError: event.toolResult.isError === true, ...(detail == null ? {} : { detail }) });
          return;
        }
        case "session_complete": {
          subscription.dispose();
          options?.signal?.removeEventListener("abort", onAbort);
          clearInterval(heartbeat);
          noteVCoderTurnEnded(sessionId);
          // The runtime emits context_detail only on demand; ask for it so
          // the status line shows real context usage after every turn.
          runtime.refreshContext(sessionId);
          logTiming(sessionId, "complete", startedAt, { reason: event.reason, delivered: deliveredMessages, usage: cumulativeUsage });
          if (event.reason === "cancelled" || event.reason === "error" || event.reason === "timeout" || event.reason === "blocking") {
            const failure = new Error(event.message ?? event.error?.message ?? `VCoder runtime session ended: ${event.reason}`);
            queue.fail(failure);
            resultDeferred.reject(failure);
            return;
          }
          if (event.reason === "max_turns_reached") {
            // Never stop silently: tell the user the turn hit the step limit.
            deliveredMessages += 1;
            const steps = event.turnCount == null ? "" : `（${event.turnCount} 步）`;
            queue.push({ type: "message", text: `（已达到单轮步数上限${steps}，任务可能还没做完。回复"继续"我接着做。）` });
          }
          const fallbackText = textSegments.map(segment => segment.trim()).filter(segment => segment.length > 0).join("\n\n");
          queue.finish();
          resultDeferred.resolve({ text: fallbackText, deliveredMessages, usage: cumulativeUsage });
          return;
        }
        case "permission_request":
          // bypassPermissions should never ask; nobody could answer inside
          // the box anyway, and the container is the isolation boundary.
          runtime.resolvePermission(sessionId, event.request.id, { approved: true });
          return;
        default:
          return;
      }
    });

    try {
      if (needsStart) {
        await runtime.startSession({
          sessionId,
          workingDirectory: home.workingDirectory,
          settings: {
            ...sessionBaseSettings,
            // The box container is the isolation boundary (same as the
            // original Grok Bot box shell); nobody can approve inside it.
            permissionMode: "bypassPermissions",
            // No surface for these in the chat: SendMessage only reaches
            // in-process teammates, the others need interactive UI.
            disallowedTools: [...BOT_DISALLOWED_TOOLS],
            appendSystemPrompt: GROK_BOT_OUTPUT_STYLE,
            effort: vcoderEffort(),
            // No default turn cap (CLI interactive parity): a cap cut long
            // tasks mid-way. Callers may still pass one explicitly.
            ...(options?.maxTurns == null ? {} : { maxTurns: options.maxTurns }),
          },
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
        });
        logTiming(sessionId, "session-ready", startedAt, { reused: false, seededWithHistory: content !== prompt });
      } else {
        if (mcpChanged) await runtime.updateMcpServers(sessionId, mcpServers);
        logTiming(sessionId, "session-ready", startedAt, { reused: true, mcpChanged });
      }
      noteVCoderTurnStarted(sessionId);
      if (record != null) acceptTurnFingerprints(record, options);
      const addendum = options?.systemPromptAddendum;
      await runtime.sendMessage(sessionId, { content: addendum == null || addendum.length === 0 ? content : `<system-reminder>\n${addendum}\n</system-reminder>\n\n${content}`, displayContent: content });
    } catch (error) {
      subscription.dispose();
      options?.signal?.removeEventListener("abort", onAbort);
      clearInterval(heartbeat);
      noteVCoderTurnEnded(sessionId);
      const failure = error instanceof Error ? error : new Error(String(error));
      queue.fail(failure);
      resultDeferred.reject(failure);
    }
  })();

  return { chunks: queue[Symbol.asyncIterator](), result: resultDeferred.promise };
}

const TOOL_HEARTBEAT_MS = 15_000;

// Reasoning effort for bot turns. Defaults to the endpoint's own behaviour
// (DeepSeek's official endpoint already reasons briefly). "low" turns
// DeepSeek reasoning off entirely (thinking: disabled) and cut DashScope
// thinking ~60% (2026-10-01).
// Override with SAND_VCODER_EFFORT=low|medium|high|max|auto.
export function vcoderEffort(env: NodeJS.ProcessEnv = process.env): "low" | "medium" | "high" | "max" | "auto" {
  const value = env.SAND_VCODER_EFFORT?.trim().toLowerCase();
  return value === "medium" || value === "high" || value === "max" || value === "auto" || value === "low" ? value : "auto";
}

const MESSAGING_TOOLS = new Set(["SendUserMessage", "Brief"]);

export const BOT_DISALLOWED_TOOLS = ["SendMessage", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"] as const;

// Newest generation among this conversation's persisted session ids
// (runtime.listPersistedSessionIds), or null. Without it every session
// looked new after a host restart and the full Grok Bot history was re-sent
// on top of the transcript the runtime reloads anyway.
export function latestTranscriptGeneration(sessionIds: readonly string[], conversationId: string): number | null {
  const pattern = new RegExp(`^${sessionIdForConversation(conversationId, 0).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-g(\\d+))?$`);
  let latest: number | null = null;
  for (const id of sessionIds) {
    const match = pattern.exec(id);
    if (match != null) latest = Math.max(latest ?? 0, Number(match[1] ?? 0));
  }
  return latest;
}
