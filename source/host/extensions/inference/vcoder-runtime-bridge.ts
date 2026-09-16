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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeEvent } from "@vcoder/agent-core/runtime";
import type { VcoderCoreRuntimeImpl as VcoderCoreRuntimeImplType } from "@vcoder/server/runtime";

import { getSandRootDir } from "../../host-paths.js";

export interface VCoderRuntimeStreamChunk {
  readonly type: "text-delta" | "reasoning" | "tool-activity";
  readonly textDelta?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly phase?: "started" | "completed";
  readonly isError?: boolean;
  readonly detail?: string;
}

export interface VCoderRuntimeResult {
  readonly text: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
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
function renderVCoderRuntimeSettings(home: VCoderRuntimeHome, options: { readonly provider?: string; readonly model?: string; readonly env: Record<string, string> }): void {
  mkdirSync(home.vcoderHome, { recursive: true });
  const settingsPath = join(home.vcoderHome, "settings.json");
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch { existing = {}; }
  const merged = {
    ...existing,
    ...(options.provider == null ? {} : { provider: options.provider }),
    ...(options.model == null ? {} : { model: options.model }),
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
    renderVCoderRuntimeSettings(home, { ...(provider == null || provider.length === 0 ? {} : { provider }), ...(model == null || model.length === 0 ? {} : { model }), env: readVCoderSettingsEnv() });
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
  readonly systemPromptAddendum?: string;
  readonly maxTurns?: number;
  readonly mcpServers?: readonly { readonly type: "http"; readonly name?: string; readonly url: string }[];
}

// Runs exactly one turn: a fresh session (mirroring the CLI executor's
// persistSession:false — Grok Bot owns conversation history and re-sends it
// in full each turn) that sends one message and resolves once the runtime
// reports session_complete.
export function runVCoderRuntimeTurn(prompt: string, options?: VCoderRuntimeTurnOptions): VCoderRuntimeTurnHandle {
  const queue = new RuntimeEventQueue();
  const pendingToolNames = new Map<string, string>();
  let accumulatedText = "";
  let cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
  const resultDeferred = Promise.withResolvers<VCoderRuntimeResult>();

  (async () => {
    const runtime = await getVCoderRuntime();
    const sessionId = randomUUID();
    const home = resolveVCoderRuntimeHome();
    const subscription = runtime.on("event", (event: RuntimeEvent) => {
      if (event.sessionId !== sessionId) return;
      switch (event.type) {
        case "text_delta":
          accumulatedText += event.text;
          queue.push({ type: "text-delta", textDelta: event.text });
          return;
        case "thinking_delta":
          queue.push({ type: "reasoning", textDelta: event.text });
          return;
        // session_complete never actually carries `usage` in the current
        // VcoderCoreRuntimeImpl (confirmed empirically and by reading
        // vcoder-core.ts's query-loop terminal handling — it tracks
        // per-request usage on an internal `session.tokenUsage` the host
        // cannot reach and never attaches it to the session_complete event).
        // token_usage is emitted once per model request instead, so this
        // sums across every request in the turn's tool-calling loop.
        case "token_usage":
          cumulativeUsage = {
            inputTokens: cumulativeUsage.inputTokens + event.usage.inputTokens,
            outputTokens: cumulativeUsage.outputTokens + event.usage.outputTokens,
          };
          return;
        case "tool_use": {
          if (event.toolCall.status === "failed" || event.toolCall.status === "completed") return;
          pendingToolNames.set(event.toolCall.id, event.toolCall.name);
          const detail = toolActivityDetail(event.toolCall.input);
          queue.push({ type: "tool-activity", toolCallId: event.toolCall.id, toolName: event.toolCall.name, phase: "started", ...(detail == null ? {} : { detail }) });
          return;
        }
        case "tool_result": {
          const toolName = pendingToolNames.get(event.toolResult.id) ?? "tool";
          pendingToolNames.delete(event.toolResult.id);
          const detail = toolResultPreview(event.toolResult.content);
          queue.push({ type: "tool-activity", toolCallId: event.toolResult.id, toolName, phase: "completed", isError: event.toolResult.isError === true, ...(detail == null ? {} : { detail }) });
          return;
        }
        case "session_complete": {
          subscription.dispose();
          if (event.reason === "cancelled" || event.reason === "error" || event.reason === "timeout" || event.reason === "blocking") {
            queue.fail(new Error(event.message ?? event.error?.message ?? `VCoder runtime session ended: ${event.reason}`));
            resultDeferred.reject(new Error(event.message ?? event.error?.message ?? `VCoder runtime session ended: ${event.reason}`));
            return;
          }
          queue.finish();
          resultDeferred.resolve({ text: accumulatedText, usage: event.usage ?? cumulativeUsage });
          return;
        }
        case "error": {
          // Non-terminal errors (a single failed tool call, etc.) surface as
          // tool-activity failures above via tool_result; this handles
          // runtime-level errors that arrive without a session_complete.
          return;
        }
        default:
          return;
      }
    });

    try {
      await runtime.startSession({
        sessionId,
        workingDirectory: home.workingDirectory,
        settings: {
          permissionMode: "dontAsk",
          maxTurns: options?.maxTurns ?? 16,
          ...(options?.systemPromptAddendum == null ? {} : { appendSystemPrompt: options.systemPromptAddendum }),
        },
        ...(options?.mcpServers == null || options.mcpServers.length === 0 ? {} : { mcpServers: options.mcpServers.map(server => ({ type: server.type, url: server.url, ...(server.name == null ? {} : { name: server.name }) })) }),
      });
      await runtime.sendMessage(sessionId, { content: prompt });
    } catch (error) {
      subscription.dispose();
      const failure = error instanceof Error ? error : new Error(String(error));
      queue.fail(failure);
      resultDeferred.reject(failure);
    }
  })();

  return { chunks: queue[Symbol.asyncIterator](), result: resultDeferred.promise };
}
