// Live per-bot VCoder state (model, context usage, running turn, current tool)
// for the desktop status line. Each bot is an embedded VCoder; without this a
// long turn looks exactly like a hang.
import { agentIdForVCoderSession, listVCoderBackgroundTasks, type VCoderBackgroundTask } from "./vcoder-background-tasks.js";

export const DEFAULT_VCODER_CONTEXT_WINDOW = 300_000;

export function effectiveVCoderContextWindow(env: NodeJS.ProcessEnv = process.env): number {
  for (const raw of [env.SAND_VCODER_CONTEXT_WINDOW, env.VCODER_MAX_CONTEXT_TOKENS]) {
    const parsed = Number.parseInt(raw?.trim() ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_VCODER_CONTEXT_WINDOW;
}

interface MutableStatus {
  provider: string | null;
  model: string | null;
  contextUsed: number | null;
  contextWindow: number;
  turnRunning: boolean;
  turnStartedAtMs: number | null;
  currentTool: { name: string; detail?: string; startedAtMs: number } | null;
  lastActivityAtMs: number | null;
  compactions: number;
}

export interface VCoderAgentStatus {
  readonly agentId: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly contextUsed: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
  readonly turnRunning: boolean;
  readonly turnStartedAtMs: number | null;
  readonly currentTool: { readonly name: string; readonly detail?: string; readonly startedAtMs: number } | null;
  readonly lastActivityAtMs: number | null;
  readonly compactions: number;
  readonly backgroundTasks: readonly VCoderBackgroundTask[];
  readonly nowMs: number;
}

const statusByAgent = new Map<string, MutableStatus>();

function entry(agentId: string): MutableStatus {
  let status = statusByAgent.get(agentId);
  if (status == null) {
    const provider = process.env.SAND_VCODER_PROVIDER?.trim() || null;
    const model = process.env.SAND_VCODER_MODEL?.trim() || null;
    status = { provider, model, contextUsed: null, contextWindow: effectiveVCoderContextWindow(), turnRunning: false, turnStartedAtMs: null, currentTool: null, lastActivityAtMs: null, compactions: 0 };
    statusByAgent.set(agentId, status);
  }
  return status;
}

function forSession(sessionId: string): MutableStatus | null {
  const agentId = agentIdForVCoderSession(sessionId);
  return agentId == null ? null : entry(agentId);
}

function shortDetail(detail: string | undefined): string | undefined {
  if (detail == null) return undefined;
  const collapsed = detail.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
}

export function noteVCoderTurnStarted(sessionId: string, now = Date.now()): void {
  const status = forSession(sessionId);
  if (status == null) return;
  status.turnRunning = true;
  status.turnStartedAtMs = now;
  status.currentTool = null;
  status.lastActivityAtMs = now;
}

export function noteVCoderToolStarted(sessionId: string, name: string, detail: string | undefined, now = Date.now()): void {
  const status = forSession(sessionId);
  if (status == null) return;
  const short = shortDetail(detail);
  status.currentTool = { name, ...(short == null ? {} : { detail: short }), startedAtMs: now };
  status.lastActivityAtMs = now;
}

export function noteVCoderToolFinished(sessionId: string, now = Date.now()): void {
  const status = forSession(sessionId);
  if (status == null) return;
  status.currentTool = null;
  status.lastActivityAtMs = now;
}

export function noteVCoderTurnEnded(sessionId: string, now = Date.now()): void {
  const status = forSession(sessionId);
  if (status == null) return;
  status.turnRunning = false;
  status.turnStartedAtMs = null;
  status.currentTool = null;
  status.lastActivityAtMs = now;
}

// Runtime-wide events (context_detail / context_compacted).
export function recordVCoderStatusEvent(event: { readonly type: string; readonly sessionId: string; readonly detail?: any }, now = Date.now()): void {
  const status = forSession(event.sessionId);
  if (status == null) return;
  if (event.type === "context_detail" && event.detail != null) {
    if (typeof event.detail.model === "string" && event.detail.model.length > 0) status.model = event.detail.model;
    const used = Number(event.detail.usedTokens);
    if (Number.isFinite(used) && used >= 0) status.contextUsed = used;
    const reported = Number(event.detail.contextWindow);
    const cap = effectiveVCoderContextWindow();
    status.contextWindow = Number.isFinite(reported) && reported > 0 ? Math.min(reported, cap) : cap;
    status.lastActivityAtMs = now;
  } else if (event.type === "context_compacted") {
    status.compactions += 1;
    status.lastActivityAtMs = now;
  }
}

export function getVCoderAgentStatus(agentId: string, now = Date.now()): VCoderAgentStatus {
  const status = entry(agentId);
  const percent = status.contextUsed == null ? null : Math.min(100, Math.round((status.contextUsed / status.contextWindow) * 100));
  return { agentId, ...status, currentTool: status.currentTool == null ? null : { ...status.currentTool }, percent, backgroundTasks: listVCoderBackgroundTasks(agentId), nowMs: now };
}

export function resetVCoderAgentStatusForTests(): void {
  statusByAgent.clear();
}
