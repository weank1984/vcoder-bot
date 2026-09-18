import { createHash } from "node:crypto";

export const VALIDATION_TASK_STATUSES = [
  "accepted",
  "preparing",
  "running",
  "stopping",
  "delivered",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type ValidationTaskStatus = (typeof VALIDATION_TASK_STATUSES)[number];

export interface ValidationTaskInput {
  readonly requestId: string;
  readonly repository: {
    readonly url: string;
    readonly commit: string;
    readonly branch?: string;
  };
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly limits: {
    readonly wallClockMinutes: number;
    readonly maxTurns: number;
  };
  readonly allowedOperations: readonly ["workspace_write", "test"];
}

export interface ValidationTaskSnapshot {
  readonly taskId: string;
  readonly status: ValidationTaskStatus;
  readonly version: number;
  readonly input: ValidationTaskInput;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly stopRequestedAt?: string;
  readonly terminalReason?: string;
}

export interface ValidationTaskEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class ValidationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationInputError";
  }
}

export class ValidationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationConflictError";
  }
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") throw new ValidationInputError(`${name} must be a string`);
  const result = value.trim();
  if (result.length === 0) throw new ValidationInputError(`${name} is required`);
  if (result.length > maximum) throw new ValidationInputError(`${name} exceeds ${maximum} characters`);
  return result;
}

function integerInRange(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ValidationInputError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function normalizeRepositoryUrl(value: unknown): string {
  const raw = requiredString(value, "repository.url", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationInputError("repository.url must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:") throw new ValidationInputError("repository.url must use HTTPS");
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ValidationInputError("repository.url must not contain credentials");
  }
  parsed.hash = "";
  return parsed.toString();
}

function normalizeAcceptanceCriteria(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationInputError("acceptanceCriteria must contain at least one item");
  }
  if (value.length > 20) throw new ValidationInputError("acceptanceCriteria exceeds 20 items");
  return value.map((entry, index) => requiredString(entry, `acceptanceCriteria[${index}]`, 1_000));
}

export function normalizeValidationTaskInput(value: unknown): ValidationTaskInput {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new ValidationInputError("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const repository = input.repository;
  if (typeof repository !== "object" || repository == null || Array.isArray(repository)) {
    throw new ValidationInputError("repository must be an object");
  }
  const repo = repository as Record<string, unknown>;
  const commit = requiredString(repo.commit, "repository.commit", 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new ValidationInputError("repository.commit must be a full 40-character Git commit SHA");
  }
  const branch = repo.branch === undefined ? undefined : requiredString(repo.branch, "repository.branch", 255);
  const limitsValue = input.limits;
  if (typeof limitsValue !== "object" || limitsValue == null || Array.isArray(limitsValue)) {
    throw new ValidationInputError("limits must be an object");
  }
  const limits = limitsValue as Record<string, unknown>;
  return {
    requestId: requiredString(input.requestId, "requestId", 128),
    repository: {
      url: normalizeRepositoryUrl(repo.url),
      commit,
      ...(branch === undefined ? {} : { branch }),
    },
    goal: requiredString(input.goal, "goal", 10_000),
    acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria),
    limits: {
      wallClockMinutes: integerInRange(limits.wallClockMinutes, "limits.wallClockMinutes", 1, 30),
      maxTurns: integerInRange(limits.maxTurns, "limits.maxTurns", 1, 16),
    },
    allowedOperations: ["workspace_write", "test"],
  };
}

export function validationTaskInputHash(input: ValidationTaskInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

const TRANSITIONS: Readonly<Record<ValidationTaskStatus, readonly ValidationTaskStatus[]>> = {
  accepted: ["preparing", "stopping", "cancelled"],
  preparing: ["running", "stopping", "failed", "interrupted"],
  running: ["stopping", "delivered", "failed", "interrupted"],
  stopping: ["cancelled", "failed", "interrupted"],
  delivered: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function canTransitionValidationTask(from: ValidationTaskStatus, to: ValidationTaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isValidationTaskStatus(value: unknown): value is ValidationTaskStatus {
  return typeof value === "string" && (VALIDATION_TASK_STATUSES as readonly string[]).includes(value);
}

