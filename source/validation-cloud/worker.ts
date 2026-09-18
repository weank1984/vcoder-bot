import { randomUUID } from "node:crypto";

import type { ValidationTaskInput } from "./model.js";
import { ValidationTaskStore, type ValidationRunSnapshot } from "./task-store.js";

export { ValidationTaskStore } from "./task-store.js";

const MAX_SINGLE_ARTIFACT_BYTES = 10 * 1024 * 1024;

export interface ValidationPreparedRun {
  readonly workspacePath: string;
  readonly artifactDirectory: string;
}

export interface ValidationProducedArtifact {
  readonly kind: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface ValidationRunResult {
  readonly summary: string;
  readonly artifacts: readonly ValidationProducedArtifact[];
}

export interface ValidationRunDriver {
  prepare(args: {
    readonly taskId: string;
    readonly runId: string;
    readonly input: ValidationTaskInput;
    readonly signal: AbortSignal;
    readonly report: (type: string, payload: Readonly<Record<string, unknown>>) => void;
  }): Promise<ValidationPreparedRun>;
  execute(args: {
    readonly taskId: string;
    readonly runId: string;
    readonly input: ValidationTaskInput;
    readonly prepared: ValidationPreparedRun;
    readonly signal: AbortSignal;
    readonly report: (type: string, payload: Readonly<Record<string, unknown>>) => void;
  }): Promise<ValidationRunResult>;
  collectPartialArtifacts?(args: {
    readonly taskId: string;
    readonly runId: string;
    readonly input: ValidationTaskInput;
    readonly prepared: ValidationPreparedRun;
  }): Promise<readonly ValidationProducedArtifact[]>;
}

interface ActiveValidationRun {
  readonly taskId: string;
  readonly run: ValidationRunSnapshot;
  readonly controller: AbortController;
}

export interface ValidationTaskWorkerOptions {
  readonly store: ValidationTaskStore;
  readonly driver: ValidationRunDriver;
  readonly workerId?: string;
  readonly pollIntervalMs?: number;
  readonly statArtifact: (path: string) => Promise<{ sizeBytes: number; sha256: string }>;
  readonly onError?: (error: unknown) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ValidationTaskWorker {
  readonly workerId: string;
  private readonly active = new Map<string, ActiveValidationRun>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;

  constructor(private readonly options: ValidationTaskWorkerOptions) {
    this.workerId = options.workerId ?? `worker_${randomUUID()}`;
  }

  start(): void {
    if (this.disposed || this.running || this.timer != null) return;
    this.wake();
  }

  wake(): void {
    if (this.disposed || this.running) return;
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, 0);
  }

  requestStop(taskId: string): void {
    this.active.get(taskId)?.controller.abort(new Error("stop requested"));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = undefined;
    for (const active of this.active.values()) active.controller.abort(new Error("worker shutting down"));
    while (this.running) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (this.disposed) break;
        const claimed = this.options.store.claimNextTask(this.workerId);
        if (claimed == null) break;
        await this.runClaimed(claimed.task.taskId, claimed.run);
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
      if (!this.disposed) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.drain();
        }, this.options.pollIntervalMs ?? 1_000);
      }
    }
  }

  private async runClaimed(taskId: string, run: ValidationRunSnapshot): Promise<void> {
    const task = this.options.store.getTask(taskId);
    if (task == null) throw new Error(`claimed task disappeared: ${taskId}`);
    const controller = new AbortController();
    this.active.set(taskId, { taskId, run, controller });
    const timeout = setTimeout(
      () => controller.abort(new Error(`wall clock limit reached after ${task.input.limits.wallClockMinutes} minute(s)`)),
      task.input.limits.wallClockMinutes * 60_000,
    );
    const report = (type: string, payload: Readonly<Record<string, unknown>>) => {
      this.options.store.appendEvent(taskId, type, { runId: run.runId, ...payload });
    };
    let prepared: ValidationPreparedRun | undefined;
    let phase: "preparation" | "execution" | "artifact_recording" = "preparation";
    try {
      prepared = await this.options.driver.prepare({
        taskId,
        runId: run.runId,
        input: task.input,
        signal: controller.signal,
        report,
      });
      if (controller.signal.aborted || this.options.store.markRunRunning(run.runId) == null) {
        this.options.store.finishRun(run.runId, "cancelled", {
          detail: "stopped before execution began",
          errorClass: "stop_requested",
        });
        return;
      }
      phase = "execution";
      const result = await this.options.driver.execute({
        taskId,
        runId: run.runId,
        input: task.input,
        prepared,
        signal: controller.signal,
        report,
      });
      phase = "artifact_recording";
      for (const artifact of result.artifacts) {
        const stat = await this.options.statArtifact(artifact.absolutePath);
        if (stat.sizeBytes > MAX_SINGLE_ARTIFACT_BYTES) {
          throw new Error(`artifact exceeds the 10 MiB validation limit: ${artifact.relativePath}`);
        }
        this.options.store.recordArtifact({
          taskId,
          runId: run.runId,
          kind: artifact.kind,
          relativePath: artifact.relativePath,
          sizeBytes: stat.sizeBytes,
          sha256: stat.sha256,
        });
      }
      this.options.store.finishRun(run.runId, "delivered", { detail: result.summary });
    } catch (error) {
      if (prepared != null && this.options.driver.collectPartialArtifacts != null) {
        try {
          const recordedPaths = new Set(this.options.store.listArtifacts(taskId).map((artifact) => artifact.relativePath));
          for (const artifact of await this.options.driver.collectPartialArtifacts({
            taskId,
            runId: run.runId,
            input: task.input,
            prepared,
          })) {
            if (recordedPaths.has(artifact.relativePath)) continue;
            const stat = await this.options.statArtifact(artifact.absolutePath);
            if (stat.sizeBytes > MAX_SINGLE_ARTIFACT_BYTES) continue;
            this.options.store.recordArtifact({
              taskId,
              runId: run.runId,
              kind: artifact.kind,
              relativePath: artifact.relativePath,
              sizeBytes: stat.sizeBytes,
              sha256: stat.sha256,
            });
          }
        } catch (partialError) {
          report("artifact.partial_collection_failed", { detail: errorMessage(partialError).slice(0, 1_000) });
        }
      }
      const stopped = controller.signal.aborted || this.options.store.getTask(taskId)?.status === "stopping";
      const detail = errorMessage(error);
      const errorClass = controller.signal.aborted
        ? (detail.includes("wall clock limit reached") ? "wall_clock_limit" : "stop_requested")
        : phase;
      this.options.store.finishRun(run.runId, stopped ? "cancelled" : "failed", { detail, errorClass });
    } finally {
      clearTimeout(timeout);
      this.active.delete(taskId);
    }
  }
}
