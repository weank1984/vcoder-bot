// Embeds @vcoder/server's VcoderCoreRuntimeImpl in-process instead of spawning
// the VCoder CLI as a subprocess. This is the library-form agent-core the CLI
// itself is built on (see the vcoder-agent-core-direction project memory):
// running it in-process gets a real token-level text_delta stream straight
// from the provider (instead of the CLI's whole-message stream-json framing),
// removes the per-turn subprocess cold start, and shrinks the crash blast
// radius to a single sendMessage() call instead of an entire CLI process.
//
// Provider selection is deliberately NOT passed via startSession's runtime
// settings: @vcoder/agent-core's default provider-resolution policy
// (SERVER_PROVIDER_RESOLUTION_POLICY, allowCustomProviders:false) only trusts
// the userSettings layer (VCODER_HOME/settings.json) for `provider`/
// `providers` selection and silently ignores the same fields when supplied as
// runtime overrides — confirmed empirically (see the project memory) before
// writing this file. So provider/model selection is rendered into a
// VCODER_HOME-scoped settings.json once per host process instead.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeEvent } from "@vcoder/agent-core/runtime";
import type { VcoderCoreRuntimeImpl as VcoderCoreRuntimeImplType } from "@vcoder/server/runtime";

import { getSandRootDir } from "../../host-paths.js";

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

// Renders the model/provider/credential selection into the userSettings layer
// (VCODER_HOME/settings.json) that @vcoder/agent-core's resolveSettings()
// actually trusts for provider selection (see file header). Desktop-side
// ~/.vcoder/settings.json already holds this in the non-box topology; the box
// topology has no such file, so this always writes one, scoped to
// SAND_VCODER_RUNTIME_HOME so it never touches a real user's ~/.vcoder.
function renderVCoderRuntimeSettings(home: VCoderRuntimeHome, options: { readonly provider?: string; readonly model?: string; readonly env: Record<string, string>; readonly outputStyle?: { readonly name: string; readonly prompt: string } }): void {
  mkdirSync(home.vcoderHome, { recursive: true });
  const settingsPath = join(home.vcoderHome, "settings.json");
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch { existing = {}; }
  const merged = {
    ...existing,
    ...(options.provider == null ? {} : { provider: options.provider }),
    ...(options.model == null ? {} : { model: options.model }),
    ...(options.outputStyle == null ? {} : { outputStyle: options.outputStyle }),
    env: { ...(typeof existing.env === "object" && existing.env != null ? existing.env as Record<string, string> : {}), ...options.env },
  };
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
}

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
    renderVCoderRuntimeSettings(home, { ...(provider == null || provider.length === 0 ? {} : { provider }), ...(model == null || model.length === 0 ? {} : { model }), env: readVCoderSettingsEnv(), outputStyle: { name: "Grok Bot chat", prompt: GROK_BOT_OUTPUT_STYLE } });
    // VCODER_HOME must be set in this process's env before constructing the
    // runtime: @vcoder/agent-core's getVcoderHome() reads process.env at call
    // time (not just at import time), and every session start re-resolves
    // settings from it.
    process.env.VCODER_HOME = home.vcoderHome;
    const { VcoderCoreRuntimeImpl } = await import("@vcoder/server/runtime");
    return new VcoderCoreRuntimeImpl(home.workingDirectory);
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
  // to the user content because the runtime has no per-session system prompt
  // hook (see GROK_BOT_OUTPUT_STYLE).
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
}

interface ConversationSessionRecord {
  readonly sessionId: string;
  historyFingerprint: string | undefined;
  mcpKey: string;
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
// model). NOTE: StartSessionParams.settings.appendSystemPrompt is declared by
// @vcoder/agent-core but never read by VcoderCoreRuntimeImpl — text passed
// there never reached the model (verified: the model quoted only the stock
// SendUserMessage description when asked). The working system-prompt hook is
// the userSettings `outputStyle` {name, prompt}, which
// readCliParitySystemPromptOptions feeds into buildCliParitySystemPrompt
// (vcoder-core.ts ~1246 / ~2495), so it is rendered into VCODER_HOME/settings.json.
const GROK_BOT_OUTPUT_STYLE = [
  "You are Grok Bot, a warm, concise assistant running in a chat app. The user only sees messages you send with the SendUserMessage tool; plain assistant text is NOT shown to them.",
  "Each SendUserMessage call is delivered immediately as its own chat message. Always deliver your answer with SendUserMessage — never finish a turn having only written plain text.",
  "For work that takes more than one or two tool calls: first send a one-line acknowledgement of what you are about to do, send a short progress update at meaningful milestones (not after every tool call), then send the result. For a quick question, send one message with the answer. Once the result is sent, end your turn — do not send a closing or \"anything else?\" message.",
  "Format messages in Markdown. Do not use the built-in SendMessage tool at all: it cannot reach the user, and it cannot reach the user's other bots either (use the sand_agents SendToAgent tool for those when available).",
].join("\n");

export function runVCoderRuntimeTurn(prompt: string, options?: VCoderRuntimeTurnOptions): VCoderRuntimeTurnHandle {
  const queue = new RuntimeEventQueue();
  const pendingToolNames = new Map<string, string>();
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
    let record: ConversationSessionRecord | undefined;
    if (conversationId == null) {
      sessionId = randomUUID();
    } else {
      record = conversationSessions.get(conversationId);
      const diverged = record != null && options?.historyFingerprint !== record.historyFingerprint;
      if (record == null || diverged) {
        // First turn in this process, or Grok Bot history no longer matches
        // what the session saw. Try the stable id first so a host restart
        // reattaches to the on-disk transcript; on divergence move to a new
        // generation so stale history is never replayed.
        const generation = diverged ? (Number(/-g(\d+)$/.exec(record!.sessionId)?.[1] ?? 0) + 1) : 0;
        sessionId = sessionIdForConversation(conversationId, generation);
        const hasTranscript = !diverged && transcriptExists(home, sessionId);
        if (!hasTranscript && options?.fullPrompt != null) content = options.fullPrompt;
        record = { sessionId, historyFingerprint: undefined, mcpKey };
        conversationSessions.set(conversationId, record);
      } else {
        sessionId = record.sessionId;
        // MCP server URLs are bound at startSession; if they changed (e.g. a
        // new computer-use bridge) re-start the same session id, which keeps
        // the transcript but re-registers tools.
        needsStart = record.mcpKey !== mcpKey || !(await runtimeHasSession(runtime, sessionId));
        record.mcpKey = mcpKey;
      }
    }

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
          queue.push({ type: "tool-activity", toolCallId: event.toolCall.id, toolName: event.toolCall.name, phase: "started", ...(detail == null ? {} : { detail }) });
          return;
        }
        case "tool_result": {
          const toolName = pendingToolNames.get(event.toolResult.id);
          if (toolName == null) return;
          pendingToolNames.delete(event.toolResult.id);
          logTiming(sessionId, "tool-end", startedAt, { tool: toolName, isError: event.toolResult.isError === true });
          const detail = toolResultPreview(event.toolResult.content);
          queue.push({ type: "tool-activity", toolCallId: event.toolResult.id, toolName, phase: "completed", isError: event.toolResult.isError === true, ...(detail == null ? {} : { detail }) });
          return;
        }
        case "session_complete": {
          subscription.dispose();
          logTiming(sessionId, "complete", startedAt, { reason: event.reason, delivered: deliveredMessages, usage: cumulativeUsage });
          if (event.reason === "cancelled" || event.reason === "error" || event.reason === "timeout" || event.reason === "blocking") {
            // A failed turn leaves the session state uncertain; drop the
            // fingerprint so the next turn re-validates.
            if (record != null) record.historyFingerprint = undefined;
            const failure = new Error(event.message ?? event.error?.message ?? `VCoder runtime session ended: ${event.reason}`);
            queue.fail(failure);
            resultDeferred.reject(failure);
            return;
          }
          if (record != null) record.historyFingerprint = options?.nextHistoryFingerprint;
          const fallbackText = textSegments.map(segment => segment.trim()).filter(segment => segment.length > 0).join("\n\n");
          queue.finish();
          resultDeferred.resolve({ text: fallbackText, deliveredMessages, usage: cumulativeUsage });
          return;
        }
        case "permission_request": {
          // permissionMode "default" (not "dontAsk", which silently denies
          // everything that needs approval, including the messaging tools)
          // makes the broker ask here. Nobody can click "approve" inside the
          // box, so decide automatically: the box container is the isolation
          // boundary (same as the original Grok Bot box shell), so tool use
          // inside it is allowed. Previously only the messaging tools were
          // approved, which silently denied every write/mutating Bash call
          // ("Permission denied") and left the agent unable to do real work.
          runtime.resolvePermission(sessionId, event.request.id, vcoderPermissionDecision(event.request.toolName));
          return;
        }
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
            permissionMode: "default",
            maxTurns: options?.maxTurns ?? 16,
          },
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
        });
        logTiming(sessionId, "session-ready", startedAt, { reused: false, seededWithHistory: content !== prompt });
      } else {
        logTiming(sessionId, "session-ready", startedAt, { reused: true });
      }
      const addendum = options?.systemPromptAddendum;
      await runtime.sendMessage(sessionId, { content: addendum == null || addendum.length === 0 ? content : `<system-reminder>\n${addendum}\n</system-reminder>\n\n${content}`, displayContent: content });
    } catch (error) {
      subscription.dispose();
      if (record != null) record.historyFingerprint = undefined;
      const failure = error instanceof Error ? error : new Error(String(error));
      queue.fail(failure);
      resultDeferred.reject(failure);
    }
  })();

  return { chunks: queue[Symbol.asyncIterator](), result: resultDeferred.promise };
}

const MESSAGING_TOOLS = new Set(["SendUserMessage", "Brief", "SendMessage"]);

// Tools whose "approval" is really an interactive UI round-trip with the user
// (answer a question, accept a plan). The Grok Bot chat has no surface for
// them, so they are denied with guidance instead of being auto-accepted with
// no answer.
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);
const INTERACTIVE_TOOL_DENIAL = "This chat has no interactive question/plan UI. Ask the user with SendUserMessage instead, then end your turn and wait for their reply.";

export function vcoderPermissionDecision(toolName: string): { approved: boolean; reason?: string } {
  if (INTERACTIVE_TOOLS.has(toolName)) return { approved: false, reason: INTERACTIVE_TOOL_DENIAL };
  return { approved: true };
}

function transcriptExists(home: VCoderRuntimeHome, sessionId: string): boolean {
  // Best-effort: the runtime stores <sessionDir>/transcript.jsonl under
  // VCODER_HOME; the exact layout is internal, so search shallowly.
  try {
    return findFile(home.vcoderHome, sessionId, 4);
  } catch { return false; }
}

function findFile(dir: string, sessionId: string, depth: number): boolean {
  if (depth < 0) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    if (entry.name === sessionId && existsSync(join(child, "transcript.jsonl"))) return true;
    if (findFile(child, sessionId, depth - 1)) return true;
  }
  return false;
}

async function runtimeHasSession(runtime: VcoderCoreRuntimeImplType, sessionId: string): Promise<boolean> {
  // resume() only succeeds for a session still held in memory.
  try { await runtime.resume(sessionId); return true; } catch { return false; }
}
