import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import {
  ValidationConflictError,
  canTransitionValidationTask,
  isValidationTaskStatus,
  normalizeValidationTaskInput,
  validationTaskInputHash,
  type ValidationTaskEvent,
  type ValidationTaskInput,
  type ValidationTaskSnapshot,
  type ValidationTaskStatus,
} from "./model.js";

interface TaskRow {
  task_id: string;
  request_id: string;
  request_hash: string;
  status: string;
  version: number;
  input_json: string;
  accepted_at: string;
  updated_at: string;
  stop_requested_at: string | null;
  terminal_reason: string | null;
}

interface EventRow {
  event_id: string;
  task_id: string;
  sequence: number;
  type: string;
  occurred_at: string;
  payload_json: string;
}

export interface ValidationArtifactSnapshot {
  readonly artifactId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly kind: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: string;
}

interface ArtifactRow {
  artifact_id: string;
  task_id: string;
  run_id: string;
  kind: string;
  relative_path: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

function parseArtifactRow(row: ArtifactRow): ValidationArtifactSnapshot {
  return {
    artifactId: row.artifact_id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function parseTaskRow(row: TaskRow): ValidationTaskSnapshot {
  if (!isValidationTaskStatus(row.status)) throw new Error(`unknown stored task status: ${row.status}`);
  return {
    taskId: row.task_id,
    status: row.status,
    version: row.version,
    input: JSON.parse(row.input_json) as ValidationTaskInput,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
    ...(row.stop_requested_at == null ? {} : { stopRequestedAt: row.stop_requested_at }),
    ...(row.terminal_reason == null ? {} : { terminalReason: row.terminal_reason }),
  };
}

function parseEventRow(row: EventRow): ValidationTaskEvent {
  return {
    eventId: row.event_id,
    taskId: row.task_id,
    sequence: row.sequence,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function row<T>(statement: StatementSync, ...values: SQLInputValue[]): T | null {
  return (statement.get(...values) as T | undefined) ?? null;
}

export interface CreateValidationTaskResult {
  readonly task: ValidationTaskSnapshot;
  readonly created: boolean;
}

export interface ValidationRunSnapshot {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly status: "preparing" | "running" | "delivered" | "failed" | "cancelled" | "interrupted";
  readonly workerId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly detail?: string;
}

interface RunRow {
  run_id: string;
  task_id: string;
  attempt: number;
  status: ValidationRunSnapshot["status"];
  worker_id: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  detail: string | null;
}

function parseRunRow(row: RunRow): ValidationRunSnapshot {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    attempt: row.attempt,
    status: row.status,
    workerId: row.worker_id,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.finished_at == null ? {} : { finishedAt: row.finished_at }),
    ...(row.detail == null ? {} : { detail: row.detail }),
  };
}

export class ValidationTaskStore {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = resolve(databasePath);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS validation_tasks (
        task_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        stop_requested_at TEXT,
        terminal_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS validation_task_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES validation_tasks(task_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(task_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS validation_tasks_updated_at_idx
        ON validation_tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS validation_task_events_task_idx
        ON validation_task_events(task_id, sequence);
      CREATE TABLE IF NOT EXISTS validation_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES validation_tasks(task_id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        detail TEXT,
        UNIQUE(task_id, attempt)
      );
      CREATE INDEX IF NOT EXISTS validation_runs_task_idx
        ON validation_runs(task_id, attempt);
      CREATE TABLE IF NOT EXISTS validation_artifacts (
        artifact_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES validation_tasks(task_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES validation_runs(run_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS validation_artifacts_task_idx
        ON validation_artifacts(task_id, run_id);
    `);
  }

  createTask(rawInput: unknown, now = new Date()): CreateValidationTaskResult {
    const input = normalizeValidationTaskInput(rawInput);
    const inputHash = validationTaskInputHash(input);
    const timestamp = now.toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = row<TaskRow>(
        this.database.prepare("SELECT * FROM validation_tasks WHERE request_id = ?"),
        input.requestId,
      );
      if (existing != null) {
        if (existing.request_hash !== inputHash) {
          throw new ValidationConflictError("requestId is already used for a different task payload");
        }
        this.database.exec("COMMIT");
        return { task: parseTaskRow(existing), created: false };
      }

      const taskId = `task_${randomUUID()}`;
      this.database.prepare(`
        INSERT INTO validation_tasks (
          task_id, request_id, request_hash, status, version, input_json,
          accepted_at, updated_at
        ) VALUES (?, ?, ?, 'accepted', 1, ?, ?, ?)
      `).run(taskId, input.requestId, inputHash, JSON.stringify(input), timestamp, timestamp);
      this.insertEvent(taskId, 1, "task.accepted", timestamp, {
        repository: { url: input.repository.url, commit: input.repository.commit },
        limits: input.limits,
      });
      this.database.exec("COMMIT");
      const created = this.getTask(taskId);
      if (created == null) throw new Error("created task could not be read back");
      return { task: created, created: true };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  listTasks(limit = 50): ValidationTaskSnapshot[] {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.database.prepare(
      "SELECT * FROM validation_tasks ORDER BY updated_at DESC, task_id DESC LIMIT ?",
    ).all(bounded) as unknown as TaskRow[];
    return rows.map(parseTaskRow);
  }

  getTask(taskId: string): ValidationTaskSnapshot | null {
    const found = row<TaskRow>(
      this.database.prepare("SELECT * FROM validation_tasks WHERE task_id = ?"),
      taskId,
    );
    return found == null ? null : parseTaskRow(found);
  }

  listEvents(taskId: string): ValidationTaskEvent[] {
    const rows = this.database.prepare(
      "SELECT * FROM validation_task_events WHERE task_id = ? ORDER BY sequence ASC",
    ).all(taskId) as unknown as EventRow[];
    return rows.map(parseEventRow);
  }

  listRuns(taskId: string): ValidationRunSnapshot[] {
    const rows = this.database.prepare(
      "SELECT * FROM validation_runs WHERE task_id = ? ORDER BY attempt ASC",
    ).all(taskId) as unknown as RunRow[];
    return rows.map(parseRunRow);
  }

  listArtifacts(taskId: string): ValidationArtifactSnapshot[] {
    const rows = this.database.prepare(
      "SELECT * FROM validation_artifacts WHERE task_id = ? ORDER BY created_at ASC, artifact_id ASC",
    ).all(taskId) as unknown as ArtifactRow[];
    return rows.map(parseArtifactRow);
  }

  getArtifact(artifactId: string): ValidationArtifactSnapshot | null {
    const artifact = row<ArtifactRow>(this.database.prepare(
      "SELECT * FROM validation_artifacts WHERE artifact_id = ?",
    ), artifactId);
    return artifact == null ? null : parseArtifactRow(artifact);
  }

  recordArtifact(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly kind: string;
    readonly relativePath: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly now?: Date;
  }): ValidationArtifactSnapshot {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.kind)) throw new ValidationConflictError("invalid artifact kind");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(input.relativePath) || input.relativePath.includes("..")) {
      throw new ValidationConflictError("invalid artifact relative path");
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) throw new ValidationConflictError("invalid artifact size");
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new ValidationConflictError("invalid artifact sha256");
    const artifactId = `artifact_${randomUUID()}`;
    const timestamp = (input.now ?? new Date()).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO validation_artifacts (
          artifact_id, task_id, run_id, kind, relative_path, size_bytes, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(artifactId, input.taskId, input.runId, input.kind, input.relativePath, input.sizeBytes, input.sha256, timestamp);
      this.insertEvent(input.taskId, this.nextEventSequence(input.taskId), "artifact.created", timestamp, {
        artifactId,
        runId: input.runId,
        kind: input.kind,
        path: input.relativePath,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
      });
      this.database.exec("COMMIT");
      const artifact = row<ArtifactRow>(this.database.prepare(
        "SELECT * FROM validation_artifacts WHERE artifact_id = ?",
      ), artifactId);
      if (artifact == null) throw new Error("artifact could not be read back");
      return parseArtifactRow(artifact);
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  appendEvent(
    taskId: string,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    now = new Date(),
  ): ValidationTaskEvent {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(type)) throw new ValidationConflictError("invalid event type");
    const timestamp = now.toISOString();
    const eventId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.getTask(taskId) == null) throw new ValidationConflictError(`task not found: ${taskId}`);
      const sequence = this.nextEventSequence(taskId);
      this.database.prepare(`
        INSERT INTO validation_task_events (
          event_id, task_id, sequence, type, occurred_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(eventId, taskId, sequence, type, timestamp, JSON.stringify(payload));
      this.database.exec("COMMIT");
      return { eventId, taskId, sequence, type, occurredAt: timestamp, payload };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  claimNextTask(workerId: string, now = new Date()): { task: ValidationTaskSnapshot; run: ValidationRunSnapshot } | null {
    const timestamp = now.toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = row<TaskRow>(this.database.prepare(
        "SELECT * FROM validation_tasks WHERE status = 'accepted' ORDER BY accepted_at ASC, task_id ASC LIMIT 1",
      ));
      if (existing == null) {
        this.database.exec("COMMIT");
        return null;
      }
      const runId = `run_${randomUUID()}`;
      const attemptRow = row<{ attempt: number }>(this.database.prepare(
        "SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM validation_runs WHERE task_id = ?",
      ), existing.task_id);
      const attempt = attemptRow?.attempt ?? 1;
      this.database.prepare(`
        UPDATE validation_tasks
        SET status = 'preparing', version = version + 1, updated_at = ?
        WHERE task_id = ? AND status = 'accepted'
      `).run(timestamp, existing.task_id);
      this.database.prepare(`
        INSERT INTO validation_runs (
          run_id, task_id, attempt, status, worker_id, started_at, updated_at
        ) VALUES (?, ?, ?, 'preparing', ?, ?, ?)
      `).run(runId, existing.task_id, attempt, workerId, timestamp, timestamp);
      this.insertEvent(existing.task_id, this.nextEventSequence(existing.task_id), "run.started", timestamp, {
        runId,
        workerId,
        attempt,
      });
      this.insertEvent(existing.task_id, this.nextEventSequence(existing.task_id), "run.stage_changed", timestamp, {
        runId,
        from: "accepted",
        to: "preparing",
      });
      this.database.exec("COMMIT");
      const task = this.getTask(existing.task_id);
      const run = row<RunRow>(this.database.prepare("SELECT * FROM validation_runs WHERE run_id = ?"), runId);
      if (task == null || run == null) throw new Error("claimed run could not be read back");
      return { task, run: parseRunRow(run) };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  markRunRunning(runId: string, now = new Date()): { task: ValidationTaskSnapshot; run: ValidationRunSnapshot } | null {
    const timestamp = now.toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = row<RunRow>(this.database.prepare("SELECT * FROM validation_runs WHERE run_id = ?"), runId);
      if (run == null) throw new ValidationConflictError(`run not found: ${runId}`);
      const task = row<TaskRow>(this.database.prepare("SELECT * FROM validation_tasks WHERE task_id = ?"), run.task_id);
      if (task == null) throw new Error(`run task not found: ${run.task_id}`);
      if (task.status === "stopping" || task.status === "cancelled") {
        this.database.exec("COMMIT");
        return null;
      }
      if (task.status !== "preparing" || run.status !== "preparing") {
        throw new ValidationConflictError(`run cannot start from task=${task.status}, run=${run.status}`);
      }
      this.database.prepare("UPDATE validation_runs SET status = 'running', updated_at = ? WHERE run_id = ?").run(timestamp, runId);
      this.database.prepare("UPDATE validation_tasks SET status = 'running', version = version + 1, updated_at = ? WHERE task_id = ?").run(timestamp, task.task_id);
      this.insertEvent(task.task_id, this.nextEventSequence(task.task_id), "run.stage_changed", timestamp, {
        runId,
        from: "preparing",
        to: "running",
      });
      this.database.exec("COMMIT");
      const updatedTask = this.getTask(task.task_id);
      const updatedRun = row<RunRow>(this.database.prepare("SELECT * FROM validation_runs WHERE run_id = ?"), runId);
      if (updatedTask == null || updatedRun == null) throw new Error("running state could not be read back");
      return { task: updatedTask, run: parseRunRow(updatedRun) };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  finishRun(
    runId: string,
    outcome: "delivered" | "failed" | "cancelled" | "interrupted",
    options: { readonly detail?: string; readonly errorClass?: string; readonly now?: Date } = {},
  ): { task: ValidationTaskSnapshot; run: ValidationRunSnapshot } {
    const timestamp = (options.now ?? new Date()).toISOString();
    const detail = options.detail?.trim().slice(0, 4_000) || null;
    const errorClass = options.errorClass?.trim();
    if (errorClass != null && !/^[a-z][a-z0-9_.-]{0,63}$/.test(errorClass)) {
      throw new ValidationConflictError("invalid run error class");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = row<RunRow>(this.database.prepare("SELECT * FROM validation_runs WHERE run_id = ?"), runId);
      if (run == null) throw new ValidationConflictError(`run not found: ${runId}`);
      const task = row<TaskRow>(this.database.prepare("SELECT * FROM validation_tasks WHERE task_id = ?"), run.task_id);
      if (task == null) throw new Error(`run task not found: ${run.task_id}`);
      if (["delivered", "failed", "cancelled", "interrupted"].includes(run.status)) {
        this.database.exec("COMMIT");
        return { task: parseTaskRow(task), run: parseRunRow(run) };
      }
      const resolvedOutcome = task.status === "stopping" && outcome === "delivered" ? "cancelled" : outcome;
      const durationMs = Math.max(0, new Date(timestamp).getTime() - new Date(run.started_at).getTime());
      this.database.prepare(`
        UPDATE validation_runs
        SET status = ?, updated_at = ?, finished_at = ?, detail = ?
        WHERE run_id = ?
      `).run(resolvedOutcome, timestamp, timestamp, detail, runId);
      this.database.prepare(`
        UPDATE validation_tasks
        SET status = ?, version = version + 1, updated_at = ?, terminal_reason = ?
        WHERE task_id = ?
      `).run(resolvedOutcome, timestamp, resolvedOutcome === "delivered" ? null : detail, task.task_id);
      this.insertEvent(task.task_id, this.nextEventSequence(task.task_id), "run.finished", timestamp, {
        runId,
        outcome: resolvedOutcome,
        durationMs,
        ...(errorClass == null ? {} : { errorClass }),
        ...(detail == null ? {} : { detail }),
      });
      this.database.exec("COMMIT");
      const updatedTask = this.getTask(task.task_id);
      const updatedRun = row<RunRow>(this.database.prepare("SELECT * FROM validation_runs WHERE run_id = ?"), runId);
      if (updatedTask == null || updatedRun == null) throw new Error("finished state could not be read back");
      return { task: updatedTask, run: parseRunRow(updatedRun) };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  transitionTask(
    taskId: string,
    target: ValidationTaskStatus,
    options: {
      readonly eventType?: string;
      readonly payload?: Readonly<Record<string, unknown>>;
      readonly terminalReason?: string;
      readonly now?: Date;
    } = {},
  ): ValidationTaskSnapshot {
    const timestamp = (options.now ?? new Date()).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = row<TaskRow>(
        this.database.prepare("SELECT * FROM validation_tasks WHERE task_id = ?"),
        taskId,
      );
      if (existing == null) throw new ValidationConflictError(`task not found: ${taskId}`);
      if (!isValidationTaskStatus(existing.status)) throw new Error(`unknown stored task status: ${existing.status}`);
      if (!canTransitionValidationTask(existing.status, target)) {
        throw new ValidationConflictError(`task cannot transition from ${existing.status} to ${target}`);
      }
      const nextVersion = existing.version + 1;
      this.database.prepare(`
        UPDATE validation_tasks
        SET status = ?, version = ?, updated_at = ?, terminal_reason = ?
        WHERE task_id = ? AND version = ?
      `).run(target, nextVersion, timestamp, options.terminalReason ?? null, taskId, existing.version);
      this.insertEvent(
        taskId,
        this.nextEventSequence(taskId),
        options.eventType ?? "task.status_changed",
        timestamp,
        { from: existing.status, to: target, ...(options.payload ?? {}) },
      );
      this.database.exec("COMMIT");
      const updated = this.getTask(taskId);
      if (updated == null) throw new Error("updated task could not be read back");
      return updated;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  requestStop(taskId: string, now = new Date()): ValidationTaskSnapshot {
    const timestamp = now.toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = row<TaskRow>(
        this.database.prepare("SELECT * FROM validation_tasks WHERE task_id = ?"),
        taskId,
      );
      if (existing == null) throw new ValidationConflictError(`task not found: ${taskId}`);
      if (!isValidationTaskStatus(existing.status)) throw new Error(`unknown stored task status: ${existing.status}`);
      if (["delivered", "failed", "cancelled", "interrupted"].includes(existing.status)) {
        this.database.exec("COMMIT");
        return parseTaskRow(existing);
      }
      if (existing.status === "stopping") {
        this.database.exec("COMMIT");
        return parseTaskRow(existing);
      }
      const target: ValidationTaskStatus = existing.status === "accepted" ? "cancelled" : "stopping";
      const nextVersion = existing.version + 1;
      this.database.prepare(`
        UPDATE validation_tasks
        SET status = ?, version = ?, updated_at = ?, stop_requested_at = ?
        WHERE task_id = ? AND version = ?
      `).run(target, nextVersion, timestamp, timestamp, taskId, existing.version);
      this.insertEvent(taskId, this.nextEventSequence(taskId), "stop.requested", timestamp, {
        from: existing.status,
        to: target,
      });
      this.database.exec("COMMIT");
      const updated = this.getTask(taskId);
      if (updated == null) throw new Error("stopped task could not be read back");
      return updated;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  recoverInterruptedTasks(now = new Date()): ValidationTaskSnapshot[] {
    const active = this.database.prepare(
      "SELECT task_id FROM validation_tasks WHERE status IN ('preparing', 'running', 'stopping') ORDER BY task_id",
    ).all() as unknown as Array<{ task_id: string }>;
    return active.map(({ task_id }) => {
      const run = row<RunRow>(this.database.prepare(
        "SELECT * FROM validation_runs WHERE task_id = ? AND status IN ('preparing', 'running') ORDER BY attempt DESC LIMIT 1",
      ), task_id);
      if (run != null) return this.finishRun(run.run_id, "interrupted", {
        detail: "validation service restarted while the run was active",
        errorClass: "service_restart",
        now,
      }).task;
      return this.transitionTask(task_id, "interrupted", {
        eventType: "run.interrupted",
        terminalReason: "validation service restarted while the run was active",
        now,
      });
    });
  }

  private nextEventSequence(taskId: string): number {
    const result = row<{ next_sequence: number }>(
      this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM validation_task_events WHERE task_id = ?",
      ),
      taskId,
    );
    return result?.next_sequence ?? 1;
  }

  private insertEvent(
    taskId: string,
    sequence: number,
    type: string,
    occurredAt: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.database.prepare(`
      INSERT INTO validation_task_events (
        event_id, task_id, sequence, type, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), taskId, sequence, type, occurredAt, JSON.stringify(payload));
  }
}
