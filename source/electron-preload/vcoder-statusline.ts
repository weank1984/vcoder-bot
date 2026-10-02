// A VCoder-CLI-style status line for the active bot (model, context usage,
// running turn, current tool, background work). The chat view is a locked,
// minified renderer bundle with no stable insertion point, so this is a
// fixed-position bar injected from preload into its own Shadow DOM.

interface StatusTool { readonly name: string; readonly detail?: string; readonly startedAtMs: number }
export interface VCoderStatusSnapshot {
  readonly provider: string | null;
  readonly model: string | null;
  readonly contextUsed: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
  readonly turnRunning: boolean;
  readonly turnStartedAtMs: number | null;
  readonly currentTool: StatusTool | null;
  readonly compactions: number;
  readonly backgroundTasks: readonly unknown[];
  readonly nowMs: number;
}

const POLL_MS = 2_000;
const WARN_PERCENT = 80;

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = seconds % 60;
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export interface VCoderStatusSegment { readonly text: string; readonly tone?: "warn" | "running" }

// Elapsed time is anchored to the host's clock (nowMs) and advanced by the
// local delta since that snapshot, so host/desktop clock skew does not matter.
export function formatVCoderStatus(status: VCoderStatusSnapshot, localElapsedMs = 0): VCoderStatusSegment[] {
  const segments: VCoderStatusSegment[] = [];
  segments.push({ text: [status.provider, status.model].filter(Boolean).join(" · ") || "VCoder" });
  const ctx = status.contextUsed == null ? `ctx –/${tokens(status.contextWindow)}` : `ctx ${tokens(status.contextUsed)}/${tokens(status.contextWindow)} (${status.percent ?? 0}%)`;
  segments.push({ text: ctx, ...((status.percent ?? 0) >= WARN_PERCENT ? { tone: "warn" as const } : {}) });
  if (status.turnRunning) {
    const since = status.turnStartedAtMs == null ? "" : ` ${elapsed(status.nowMs + localElapsedMs - status.turnStartedAtMs)}`;
    const tool = status.currentTool == null ? "" : ` · ${status.currentTool.name}${status.currentTool.detail == null ? "" : `: ${status.currentTool.detail}`}`;
    segments.push({ text: `● 运行中${since}${tool}`, tone: "running" });
  } else {
    segments.push({ text: "○ 空闲" });
  }
  const extras: string[] = [];
  if (status.backgroundTasks.length > 0) extras.push(`后台 ${status.backgroundTasks.length}`);
  if (status.compactions > 0) extras.push(`压缩 ${status.compactions}`);
  if (extras.length > 0) segments.push({ text: extras.join(" · ") });
  return segments;
}

const STYLE = `
:host { all: initial; }
.bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; height: 20px; display: flex; align-items: center; gap: 0;
  padding: 0 10px; font: 11px/20px ui-monospace, SFMono-Regular, Menlo, monospace; color: #9aa0a6; background: rgba(20,20,22,0.92);
  border-top: 1px solid rgba(255,255,255,0.08); white-space: nowrap; overflow: hidden; pointer-events: none; }
.sep { opacity: 0.4; padding: 0 8px; }
.warn { color: #e5c07b; }
.running { color: #61afef; }
.seg:last-child { overflow: hidden; text-overflow: ellipsis; }
@media (prefers-color-scheme: light) { .bar { color: #555; background: rgba(246,246,248,0.95); border-top-color: rgba(0,0,0,0.08); } .warn { color: #b8860b; } .running { color: #1a73e8; } }
`;

export function installVCoderStatusLine(options: {
  readonly getStatus: () => Promise<unknown>;
  readonly getInferenceRouter: () => Promise<unknown>;
}): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  let bar: HTMLDivElement | null = null;
  let host: HTMLElement | null = null;
  let last: { status: VCoderStatusSnapshot; receivedAt: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polls = 0;
  let isVCoder = false;

  const render = () => {
    if (!isVCoder || last == null) { if (host != null) host.style.display = "none"; return; }
    if (host == null) {
      host = document.createElement("div");
      host.id = "vcoder-statusline";
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style"); style.textContent = STYLE; root.append(style);
      bar = document.createElement("div"); bar.className = "bar"; root.append(bar);
      document.body.append(host);
    }
    host.style.display = "";
    const segments = formatVCoderStatus(last.status, Date.now() - last.receivedAt);
    bar!.replaceChildren(...segments.flatMap((segment, index) => {
      const span = document.createElement("span"); span.className = `seg${segment.tone == null ? "" : ` ${segment.tone}`}`; span.textContent = segment.text;
      if (index === 0) return [span];
      const sep = document.createElement("span"); sep.className = "sep"; sep.textContent = "│";
      return [sep, span];
    }));
  };

  const poll = async () => {
    timer = null;
    if (document.visibilityState === "hidden") return;
    try {
      // The provider rarely changes; re-check it every ~30s instead of every poll.
      if (polls++ % 15 === 0) {
        const router = await options.getInferenceRouter() as { provider?: unknown } | null;
        isVCoder = router?.provider === "vcoder";
      }
      if (isVCoder) {
        const status = await options.getStatus() as VCoderStatusSnapshot | null;
        last = status == null ? null : { status, receivedAt: Date.now() };
      }
    } catch { /* box may be restarting; keep the last snapshot */ }
    render();
    schedule();
  };
  const schedule = () => { if (timer == null && document.visibilityState !== "hidden") timer = setTimeout(() => { void poll(); }, POLL_MS); };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { if (timer != null) { clearTimeout(timer); timer = null; } } else { void poll(); }
  });
  // Advance the elapsed-time counter between polls.
  setInterval(() => { if (last?.status.turnRunning === true && document.visibilityState !== "hidden") render(); }, 1_000);
  const start = () => { void poll(); };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true }); else start();
}
