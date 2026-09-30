// Background work VCoder keeps running after a turn ends (Bash/PowerShell
// run_in_background, background Task subagents). Grok Bot's own background
// shells and subagents mark their agent as running and list themselves in the
// async-tasks panel; VCoder's did neither, so a bot with a 10-minute test
// suite in flight looked completely idle. The runtime reports these through
// `background_shell_task` / `subagent_run` events; this registry turns them
// into the same AsyncTask shape the roster already projects.

export interface VCoderBackgroundTask {
  readonly kind: "shell" | "subagent";
  readonly id: string;
  readonly label: string;
  readonly status: "running";
  readonly startedAtMs: number;
  readonly detail?: string;
}

type Listener = (agentId: string) => void;

const tasksByAgent = new Map<string, Map<string, VCoderBackgroundTask>>();
const listeners = new Set<Listener>();

// VCoder session ids are grok-<conversationId> or grok-<conversationId>-g<N>;
// conversation ids are agent ids.
export function agentIdForVCoderSession(sessionId: string): string | null {
  const match = /^grok-(.+?)(?:-g\d+)?$/.exec(sessionId);
  return match?.[1] ?? null;
}

function notify(agentId: string): void {
  for (const listener of listeners) {
    try { listener(agentId); } catch (error) { console.error("[vcoder] background task listener failed:", error); }
  }
}

function shortCommand(command: string): string {
  const collapsed = command.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}

export function recordVCoderBackgroundEvent(event: { readonly type: string; readonly sessionId: string; readonly task?: any; readonly run?: any }): void {
  const agentId = agentIdForVCoderSession(event.sessionId);
  if (agentId == null) return;
  let key: string; let running: boolean; let task: VCoderBackgroundTask | null = null;
  if (event.type === "background_shell_task" && event.task != null) {
    key = `shell:${event.task.id}`;
    running = event.task.status === "running";
    if (running) task = { kind: "shell", id: String(event.task.id), label: shortCommand(String(event.task.command ?? "Background command")), status: "running", startedAtMs: Number(event.task.startedAt) || Date.now(), detail: "后台命令" };
  } else if (event.type === "subagent_run" && event.run != null) {
    key = `subagent:${event.run.id}`;
    running = event.run.status === "running";
    if (running) task = { kind: "subagent", id: String(event.run.id), label: String(event.run.title ?? "Background task"), status: "running", startedAtMs: Number(event.run.startedAt) || Date.now(), ...(event.run.subagentType ? { detail: String(event.run.subagentType) } : {}) };
  } else {
    return;
  }
  const tasks = tasksByAgent.get(agentId) ?? new Map<string, VCoderBackgroundTask>();
  const had = tasks.has(key);
  if (task != null) tasks.set(key, task); else tasks.delete(key);
  if (tasks.size === 0) tasksByAgent.delete(agentId); else tasksByAgent.set(agentId, tasks);
  if (had || task != null) notify(agentId);
}

export function listVCoderBackgroundTasks(agentId: string): VCoderBackgroundTask[] {
  return [...(tasksByAgent.get(agentId)?.values() ?? [])];
}

export function vcoderAgentsWithBackgroundTasks(): string[] {
  return [...tasksByAgent.keys()];
}

export function onVCoderBackgroundTasksChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
