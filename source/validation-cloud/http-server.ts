import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, resolve, sep } from "node:path";

import { ValidationConflictError, ValidationInputError } from "./model.js";
import { statValidationArtifact } from "./artifacts.js";
import { ValidationTaskStore } from "./task-store.js";
import { VALIDATION_CLOUD_WEB_HTML } from "./web.js";

export { ValidationTaskStore } from "./task-store.js";

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendHtml(response: ServerResponse): void {
  const body = Buffer.from(VALIDATION_CLOUD_WEB_HTML, "utf8");
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new ValidationInputError("request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationInputError("request body must be valid JSON");
  }
}

function taskIdFromPath(pathname: string, suffix = ""): string | null {
  const pattern = suffix.length === 0
    ? /^\/api\/tasks\/([^/]+)$/
    : new RegExp(`^/api/tasks/([^/]+)/${suffix}$`);
  const match = pattern.exec(pathname);
  if (match?.[1] == null) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export interface ValidationCloudHttpServerOptions {
  readonly store: ValidationTaskStore;
  readonly accessToken: string;
  readonly artifactsRoot?: string;
  readonly repositoryHosts?: readonly string[];
  readonly onTaskAccepted?: (taskId: string) => void;
  readonly onStopRequested?: (taskId: string) => void;
}

function assertRepositoryHostAllowed(raw: unknown, hosts: readonly string[]): void {
  if (typeof raw !== "object" || raw == null || Array.isArray(raw)) return;
  const repository = (raw as Record<string, unknown>).repository;
  if (typeof repository !== "object" || repository == null || Array.isArray(repository)) return;
  const urlValue = (repository as Record<string, unknown>).url;
  if (typeof urlValue !== "string") return;
  let hostname: string;
  try { hostname = new URL(urlValue).hostname.toLowerCase(); } catch { return; }
  if (!hosts.includes(hostname)) {
    throw new ValidationInputError(`repository host is not allowed; expected one of: ${hosts.join(", ")}`);
  }
}

export function createValidationCloudHttpServer(options: ValidationCloudHttpServerOptions): Server {
  if (options.accessToken.length < 24) throw new Error("validation cloud access token must contain at least 24 characters");
  return createServer((request, response) => {
    void handleRequest(options, request, response).catch((error: unknown) => {
      if (error instanceof ValidationInputError) return sendJson(response, 400, { error: error.message });
      if (error instanceof ValidationConflictError) return sendJson(response, 409, { error: error.message });
      sendJson(response, 500, { error: "internal validation service error" });
    });
  });
}

async function handleRequest(
  options: ValidationCloudHttpServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://validation.local");
  if (request.method === "GET" && url.pathname === "/") return sendHtml(response);
  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { ok: true, service: "vcoder-validation-cloud" });
  }
  if (!url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "not found" });
  if (!authorized(request, options.accessToken)) return sendJson(response, 401, { error: "unauthorized" });

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJsonBody(request);
    assertRepositoryHostAllowed(body, options.repositoryHosts ?? ["github.com"]);
    const result = options.store.createTask(body);
    if (result.created) options.onTaskAccepted?.(result.task.taskId);
    return sendJson(response, result.created ? 201 : 200, result);
  }
  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    return sendJson(response, 200, { tasks: options.store.listTasks(requestedLimit) });
  }
  const detailTaskId = taskIdFromPath(url.pathname);
  if (request.method === "GET" && detailTaskId != null) {
    const task = options.store.getTask(detailTaskId);
    if (task == null) return sendJson(response, 404, { error: "task not found" });
    return sendJson(response, 200, {
      task,
      runs: options.store.listRuns(detailTaskId),
      artifacts: options.store.listArtifacts(detailTaskId),
      events: options.store.listEvents(detailTaskId),
    });
  }
  const stopTaskId = taskIdFromPath(url.pathname, "stop");
  if (request.method === "POST" && stopTaskId != null) {
    const existing = options.store.getTask(stopTaskId);
    if (existing == null) return sendJson(response, 404, { error: "task not found" });
    const task = options.store.requestStop(stopTaskId);
    options.onStopRequested?.(stopTaskId);
    return sendJson(response, 200, { task });
  }
  const eventsTaskId = taskIdFromPath(url.pathname, "events\\.jsonl");
  if (request.method === "GET" && eventsTaskId != null) {
    if (options.store.getTask(eventsTaskId) == null) return sendJson(response, 404, { error: "task not found" });
    const body = Buffer.from(options.store.listEvents(eventsTaskId).map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-length": body.byteLength,
      "content-disposition": `attachment; filename="${eventsTaskId.replace(/[^a-zA-Z0-9_-]/g, "_")}-events.jsonl"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
    return;
  }
  const artifactId = /^\/api\/artifacts\/([^/]+)\/download$/.exec(url.pathname)?.[1];
  if (request.method === "GET" && artifactId != null) {
    const artifact = options.store.getArtifact(decodeURIComponent(artifactId));
    if (artifact == null || options.artifactsRoot == null) return sendJson(response, 404, { error: "artifact not found" });
    const root = resolve(options.artifactsRoot);
    const path = resolve(root, artifact.relativePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) return sendJson(response, 404, { error: "artifact not found" });
    let metadata;
    let integrity;
    try {
      metadata = await stat(path);
      integrity = await statValidationArtifact(path);
    } catch {
      return sendJson(response, 404, { error: "artifact file is unavailable" });
    }
    if (!metadata.isFile() || integrity.sizeBytes !== artifact.sizeBytes || integrity.sha256 !== artifact.sha256) {
      return sendJson(response, 409, { error: "artifact file does not match its immutable record" });
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": metadata.size,
      "content-disposition": `attachment; filename="${basename(artifact.relativePath).replace(/["\\]/g, "_")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(path).pipe(response);
    return;
  }
  return sendJson(response, 404, { error: "not found" });
}
