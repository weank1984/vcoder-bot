import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { buildBackgroundTasksRenderer } from "../scripts/lib/background-tasks-renderer.mjs";
import { Script } from "node:vm";

async function load(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vbot-background-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "client.mjs");
  await build({ entryPoints: ["source/electron-main/background-tasks.ts"], outfile, bundle: true, platform: "node", format: "esm", external: ["electron"] });
  return import(pathToFileURL(outfile).href);
}
const token = "test-only-background-service-token";
test("background service config rejects insecure remote URLs and hides credentials", async t => {
  const { createBackgroundTaskClient, normalizeBackgroundServiceUrl } = await load(t);
  for (const url of ["http://example.org", "https://user:secret@example.org", "https://example.org/path", "https://example.org?token=secret"]) assert.throws(() => normalizeBackgroundServiceUrl(url));
  assert.equal(normalizeBackgroundServiceUrl("http://127.0.0.1:18791/"), "http://127.0.0.1:18791");
  let stored;
  const deps = { read: async () => stored, write: async value => { stored = value; }, persistent: () => true, fetch: async (url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, "error");
    return Response.json(url.endsWith("/health") ? { service: "vcoder-validation-cloud" } : { tasks: [] });
  } };
  const client = createBackgroundTaskClient(deps);
  const config = await client({ action: "configure", url: "https://example.org", token });
  assert.equal(config.configured, true);
  assert.equal(config.local, false);
  assert.ok(!JSON.stringify(config).includes(token));
  assert.deepEqual(await createBackgroundTaskClient(deps)({ action: "config" }), config);
  assert.deepEqual(await client({ action: "list" }), { tasks: [] });
});
test("background service rejects token leakage on errors and does not save failed config", async t => {
  const { createBackgroundTaskClient } = await load(t);
  let writes = 0;
  const client = createBackgroundTaskClient({ read: async () => null, write: async () => { writes++; }, persistent: () => false, fetch: async () => { throw new Error(token); } });
  await assert.rejects(client({ action: "configure", url: "https://example.org", token }), error => !error.message.includes(token) && error.message.includes("无法连接"));
  assert.equal(writes, 0);
  const malformed = createBackgroundTaskClient({ read: async () => null, write: async () => { writes++; }, persistent: () => false, fetch: async () => new Response(token) });
  await assert.rejects(malformed({ action: "configure", url: "https://example.org", token }), error => !error.message.includes(token) && error.message.includes("无效的数据"));
  assert.equal(writes, 0);
});
test("background artifact checks task membership and verifies bytes before returning", async t => {
  const { createBackgroundTaskClient } = await load(t);
  const body = "diff --git a/a b/a\n";
  let corrupt = false;
  const client = createBackgroundTaskClient({ read: async () => JSON.stringify({ url: "https://example.org", token }), write: async () => {}, persistent: () => true, fetch: async url => Response.json(url.endsWith("/task_one") ? { artifacts: [{ artifactId: "artifact_one", relativePath: "task_one/changes.patch", sha256: createHash("sha256").update(body).digest("hex") }] } : {}) });
  await assert.rejects(client({ action: "artifact", taskId: "task_one", artifactId: "missing" }), /不属于/);
  const verified = createBackgroundTaskClient({ read: async () => JSON.stringify({ url: "https://example.org", token }), write: async () => {}, persistent: () => true, fetch: async url => url.endsWith("/task_one") ? Response.json({ artifacts: [{ artifactId: "artifact_one", relativePath: "task_one/changes.patch", sha256: createHash("sha256").update(body).digest("hex") }] }) : new Response(corrupt ? "changed" : body) });
  const result = await verified({ action: "artifact", taskId: "task_one", artifactId: "artifact_one" });
  assert.equal(Buffer.from(result.base64, "base64").toString(), body);
  assert.equal(result.filename, "changes.patch");
  corrupt = true;
  await assert.rejects(verified({ action: "artifact", taskId: "task_one", artifactId: "artifact_one" }), /校验失败/);
  await assert.rejects(verified({ action: "detail", taskId: "../health" }), /无效/);
});
test("production background UI is a self-contained script and tolerates an older preload", async () => {
  const code = await buildBackgroundTasksRenderer();
  const script = new Script(code);
  script.runInNewContext({ window: {} });
  assert.match(code, /vbot-background-tasks/);
});

test("desktop gateway submits once, reconnects, retrieves verified delivery and stops via real HTTP", async t => {
  const { createBackgroundTaskClient } = await load(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), "vbot-desktop-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "server.mjs");
  await build({ entryPoints: ["source/validation-cloud/http-server.ts"], outfile, bundle: true, platform: "node", format: "esm" });
  const { createValidationCloudHttpServer, ValidationTaskStore } = await import(pathToFileURL(outfile).href);
  const store = new ValidationTaskStore(path.join(dir, "state.sqlite"));
  const artifactsRoot = path.join(dir, "artifacts");
  const server = createValidationCloudHttpServer({ store, accessToken: token, artifactsRoot });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let stored;
  const deps = { read: async () => stored, write: async value => { stored = value; }, persistent: () => true, fetch };
  const client = createBackgroundTaskClient(deps);
  await client({ action: "configure", url: `http://127.0.0.1:${server.address().port}`, token });
  const input = { requestId: "desktop-request-1", repository: { url: "https://github.com/example/project.git", commit: "0123456789abcdef0123456789abcdef01234567" }, goal: "Create a document", acceptanceCriteria: ["Document exists"], limits: { wallClockMinutes: 3, maxTurns: 16 } };
  const first = await client({ action: "submit", input });
  const reconnect = createBackgroundTaskClient(deps);
  assert.equal((await reconnect({ action: "submit", input })).task.taskId, first.task.taskId);
  assert.equal((await reconnect({ action: "list" })).tasks.length, 1);
  const claimed = store.claimNextTask("test-worker");
  store.markRunRunning(claimed.run.runId);
  const relativePath = `${first.task.taskId}/${claimed.run.runId}/summary.md`;
  await mkdir(path.dirname(path.join(artifactsRoot, relativePath)), { recursive: true });
  const bytes = Buffer.from("# Delivery\nNo project tests executed.\n");
  await writeFile(path.join(artifactsRoot, relativePath), bytes);
  const artifact = store.recordArtifact({ taskId: first.task.taskId, runId: claimed.run.runId, kind: "summary", relativePath, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const detail = await reconnect({ action: "detail", taskId: first.task.taskId });
  assert.equal(detail.task.status, "running");
  assert.equal(detail.artifacts.length, 1);
  assert.equal((await reconnect({ action: "artifact", taskId: first.task.taskId, artifactId: artifact.artifactId })).text, bytes.toString());
  const stopped = await reconnect({ action: "stop", taskId: first.task.taskId });
  assert.equal(stopped.task.status, "stopping");
  assert.equal((await reconnect({ action: "detail", taskId: first.task.taskId })).task.status, "stopping");
});
