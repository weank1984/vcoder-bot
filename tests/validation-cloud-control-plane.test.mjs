import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry, name) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `vcoder-validation-${name}-`));
  const output = path.join(temporary, `${name}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, temporary, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function taskInput(overrides = {}) {
  return {
    requestId: "request-001",
    repository: {
      url: "https://github.com/example/project.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    goal: "Change the greeting without pushing any code.",
    acceptanceCriteria: ["The focused test passes", "A patch is produced"],
    limits: { wallClockMinutes: 10, maxTurns: 8 },
    ...overrides,
  };
}

test("delivery presentation preserves nested test commands and unknown usage", async () => {
  const loaded = await loadModule("source/validation-cloud/presentation.ts", "presentation");
  try {
    const format = loaded.module.formatValidationArtifact;
    assert.match(format("tests", { status: "passed", commands: [{ command: "git diff --check", status: "passed", exitCode: 0 }] }), /git diff --check[\s\S]*退出码：0/);
    assert.match(format("tests", { status: "unknown", reason: "not run" }), /未验证[\s\S]*not run/);
    assert.match(format("usage", { modelRequests: "unknown", durationMs: 1250 }), /模型请求数：未知[\s\S]*1.3 秒/);
  } finally { await loaded.dispose(); }
});

test("served validation page contains executable client JavaScript", async () => {
  const loaded = await loadModule("source/validation-cloud/web.ts", "web");
  try {
    const script = loaded.module.VALIDATION_CLOUD_WEB_HTML.match(/<script>([\s\S]*)<\/script>/)[1];
    assert.doesNotThrow(() => new Script(script));
  } finally { await loaded.dispose(); }
});

test("validation runner image configures Git LFS for bind-mounted workspaces", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/validation-cloud/runner.Dockerfile"), "utf8");
  assert.match(dockerfile, /apt-get install[^\n]*\bgit-lfs\b/);
  assert.match(dockerfile, /git lfs install --system/);
});

test("validation VCoder driver waits for runtime session completion", async () => {
  const driver = await readFile(path.join(repoRoot, "source/validation-cloud/vcoder-driver.ts"), "utf8");
  assert.match(driver, /event\.type === "session_complete"/);
  assert.match(driver, /sessionCompletion\.promise\.catch/);
  assert.match(driver, /await sessionCompletion\.promise/);
  assert.ok(driver.indexOf("await sessionCompletion.promise") > driver.indexOf("await runtime.sendMessage"));
  assert.match(driver, /GIT_LFS_SKIP_SMUDGE: "1"/);
});

test("Git delivery includes nested untracked files, unusual names, binary files and staged renames", async () => {
  const loaded = await loadModule("source/validation-cloud/git-delivery.ts", "git-delivery");
  const workspace = path.join(loaded.temporary, "repository");
  await mkdir(workspace);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
  try {
    git("init", "--quiet");
    await writeFile(path.join(workspace, "old.txt"), "original\n");
    git("add", "old.txt");
    git("-c", "user.name=Validation", "-c", "user.email=validation@example.invalid", "commit", "--quiet", "-m", "baseline");
    git("mv", "old.txt", "renamed.txt");
    await mkdir(path.join(workspace, "new"));
    const names = ["new/中文 文档.md", "new/line\nbreak.md", "new/binary.bin"];
    for (const name of names) await writeFile(path.join(workspace, name), name.endsWith(".bin") ? Buffer.from([0, 1, 2, 3]) : "new content\n");
    const before = git("diff", "--cached");
    const result = await loaded.module.collectGitDelivery(workspace, new AbortController().signal);
    assert.deepEqual(result.files.map(file => file.path).sort(), [...names, "renamed.txt"].sort());
    assert.equal(result.files.find(file => file.path === "renamed.txt").originalPath, "old.txt");
    assert.match(result.patch, /GIT binary patch/);
    assert.equal(git("diff", "--cached"), before, "collecting evidence must not modify the index");
    const patchFile = path.join(loaded.temporary, "changes.patch");
    await writeFile(patchFile, result.patch);
    const target = path.join(loaded.temporary, "target");
    execFileSync("git", ["clone", "--quiet", workspace, target]);
    execFileSync("git", ["apply", "--check", patchFile], { cwd: target });
    execFileSync("git", ["apply", patchFile], { cwd: target });
    for (const name of [...names, "renamed.txt"]) {
      assert.deepEqual(await readFile(path.join(target, name)), await readFile(path.join(workspace, name)));
    }
  } finally { await loaded.dispose(); }
});

test("validation shell permission only preapproves the exact diff check", async () => {
  const loaded = await loadModule("source/validation-cloud/validation-permissions.ts", "validation-permissions");
  try {
    assert.equal(loaded.module.isPreapprovedValidationPermission("Bash", { command: "git diff --check" }, ["test"]), true);
    assert.equal(loaded.module.isPreapprovedValidationPermission("Bash", { command: " git diff --check " }, ["test"]), true);
    assert.equal(loaded.module.isPreapprovedValidationPermission("Bash", { command: "git diff --check; env" }, ["test"]), false);
    assert.equal(loaded.module.isPreapprovedValidationPermission("Bash", { command: "git diff --check", cwd: "/tmp" }, ["test"]), false);
    assert.equal(loaded.module.isPreapprovedValidationPermission("Bash", { command: "git diff --check" }, ["workspace_write"]), false);
  } finally {
    await loaded.dispose();
  }
});

test("validation task acceptance is durable and idempotent", async () => {
  const loaded = await loadModule("source/validation-cloud/task-store.ts", "task-store");
  const databasePath = path.join(loaded.temporary, "data", "validation.sqlite");
  try {
    const store = new loaded.module.ValidationTaskStore(databasePath);
    const first = store.createTask(taskInput(), new Date("2026-09-17T00:00:00.000Z"));
    const replay = store.createTask(taskInput(), new Date("2026-09-17T00:00:01.000Z"));
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.task.taskId, first.task.taskId);
    assert.equal(first.task.status, "accepted");
    assert.equal(store.listEvents(first.task.taskId).length, 1);
    assert.throws(
      () => store.createTask(taskInput({ goal: "A different operation" })),
      error => error?.name === "ValidationConflictError",
    );
    store.close();

    const reopened = new loaded.module.ValidationTaskStore(databasePath);
    assert.equal(reopened.getTask(first.task.taskId)?.input.repository.commit, taskInput().repository.commit);
    assert.equal(reopened.listTasks().length, 1);
    reopened.close();
  } finally {
    await loaded.dispose();
  }
});

test("validation task stop and restart states do not overclaim execution", async () => {
  const loaded = await loadModule("source/validation-cloud/task-store.ts", "task-recovery");
  const databasePath = path.join(loaded.temporary, "validation.sqlite");
  const artifactsRoot = path.join(loaded.temporary, "artifacts");
  try {
    const store = new loaded.module.ValidationTaskStore(databasePath);
    const cancelled = store.createTask(taskInput({ requestId: "stop-before-run" })).task;
    const afterStop = store.requestStop(cancelled.taskId, new Date("2026-09-17T01:00:00.000Z"));
    assert.equal(afterStop.status, "cancelled");
    assert.equal(store.requestStop(cancelled.taskId).status, "cancelled");

    const active = store.createTask(taskInput({ requestId: "active-on-restart" })).task;
    const claimed = store.claimNextTask("test-worker");
    assert.equal(claimed.task.taskId, active.taskId);
    store.markRunRunning(claimed.run.runId);
    store.close();

    const reopened = new loaded.module.ValidationTaskStore(databasePath);
    const recovered = reopened.recoverInterruptedTasks(new Date("2026-09-17T02:00:00.000Z"));
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "interrupted");
    assert.match(recovered[0].terminalReason, /restarted/);
    assert.equal(reopened.listEvents(active.taskId).at(-1)?.type, "run.finished");
    assert.equal(reopened.listEvents(active.taskId).at(-1)?.payload.errorClass, "service_restart");
    assert.equal(typeof reopened.listEvents(active.taskId).at(-1)?.payload.durationMs, "number");
    assert.equal(reopened.listRuns(active.taskId)[0].status, "interrupted");
    reopened.close();
  } finally {
    await loaded.dispose();
  }
});

test("validation worker drives a task through a durable run and records immutable artifacts", async () => {
  const loaded = await loadModule("source/validation-cloud/worker.ts", "worker");
  const databasePath = path.join(loaded.temporary, "validation.sqlite");
  const artifactPath = path.join(loaded.temporary, "summary.md");
  const store = new loaded.module.ValidationTaskStore(databasePath);
  const accepted = store.createTask(taskInput({ requestId: "worker-success" })).task;
  const driver = {
    async prepare() {
      return { workspacePath: loaded.temporary, artifactDirectory: loaded.temporary };
    },
    async execute() {
      await import("node:fs/promises").then(fs => fs.writeFile(artifactPath, "validated\n"));
      return { summary: "Validated successfully", artifacts: [{ kind: "summary", relativePath: "summary.md", absolutePath: artifactPath }] };
    },
  };
  const worker = new loaded.module.ValidationTaskWorker({
    store,
    driver,
    pollIntervalMs: 5,
    statArtifact: async () => ({ sizeBytes: 10, sha256: "a".repeat(64) }),
  });
  try {
    worker.start();
    const deadline = Date.now() + 2_000;
    while (store.getTask(accepted.taskId)?.status !== "delivered" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(store.getTask(accepted.taskId)?.status, "delivered");
    assert.equal(store.listRuns(accepted.taskId)[0].status, "delivered");
    assert.equal(store.listArtifacts(accepted.taskId)[0].relativePath, "summary.md");
    assert.deepEqual(store.listEvents(accepted.taskId).map(event => event.type), [
      "task.accepted",
      "run.started",
      "run.stage_changed",
      "run.stage_changed",
      "artifact.created",
      "run.finished",
    ]);
    assert.equal(typeof store.listEvents(accepted.taskId).at(-1)?.payload.durationMs, "number");
  } finally {
    await worker.dispose();
    store.close();
    await loaded.dispose();
  }
});

test("validation worker preserves bounded partial artifacts when execution fails", async () => {
  const loaded = await loadModule("source/validation-cloud/worker.ts", "worker-partial-artifact");
  const databasePath = path.join(loaded.temporary, "validation.sqlite");
  const store = new loaded.module.ValidationTaskStore(databasePath);
  const accepted = store.createTask(taskInput({ requestId: "worker-partial-artifact" })).task;
  const partialPath = path.join(loaded.temporary, "partial-summary.md");
  const driver = {
    async prepare() {
      return { workspacePath: loaded.temporary, artifactDirectory: loaded.temporary };
    },
    async execute() {
      await writeFile(partialPath, "partial\n");
      throw new Error("synthetic execution failure");
    },
    async collectPartialArtifacts() {
      return [{ kind: "partial", relativePath: "task/run/partial-summary.md", absolutePath: partialPath }];
    },
  };
  const worker = new loaded.module.ValidationTaskWorker({
    store,
    driver,
    pollIntervalMs: 5,
    statArtifact: async () => ({ sizeBytes: 8, sha256: "b".repeat(64) }),
  });
  try {
    worker.start();
    const deadline = Date.now() + 2_000;
    while (store.getTask(accepted.taskId)?.status !== "failed" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(store.getTask(accepted.taskId)?.status, "failed");
    assert.equal(store.getTask(accepted.taskId)?.terminalReason, "synthetic execution failure");
    assert.equal(store.listArtifacts(accepted.taskId)[0]?.kind, "partial");
    assert.deepEqual(store.listEvents(accepted.taskId).slice(-2).map(event => event.type), ["artifact.created", "run.finished"]);
    assert.equal(store.listEvents(accepted.taskId).at(-1)?.payload.errorClass, "execution");
  } finally {
    await worker.dispose();
    store.close();
    await loaded.dispose();
  }
});

test("validation HTTP API authenticates every task operation and preserves request idempotency", async () => {
  const loaded = await loadModule("source/validation-cloud/http-server.ts", "http-server");
  const databasePath = path.join(loaded.temporary, "validation.sqlite");
  const artifactsRoot = path.join(loaded.temporary, "artifacts");
  const token = "validation-test-token-at-least-24-characters";
  const store = new loaded.module.ValidationTaskStore(databasePath);
  const server = loaded.module.createValidationCloudHttpServer({ store, accessToken: token, artifactsRoot });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/tasks`)).status, 401);

    const request = () => fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(taskInput({ requestId: "http-idempotency" })),
    });
    const first = await request();
    const replay = await request();
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    const firstBody = await first.json();
    const replayBody = await replay.json();
    assert.equal(firstBody.task.taskId, replayBody.task.taskId);
    assert.equal(replayBody.created, false);

    const disallowedRepository = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(taskInput({
        requestId: "http-disallowed-repository",
        repository: { url: "https://gitlab.com/example/project.git", commit: taskInput().repository.commit },
      })),
    });
    assert.equal(disallowedRepository.status, 400);
    assert.match((await disallowedRepository.json()).error, /repository host is not allowed/);

    const detail = await fetch(`${base}/api/tasks/${firstBody.task.taskId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).events[0].type, "task.accepted");

    const eventsDownload = await fetch(`${base}/api/tasks/${firstBody.task.taskId}/events.jsonl`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(eventsDownload.status, 200);
    const eventLines = (await eventsDownload.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(eventLines[0].type, "task.accepted");

    const claimed = store.claimNextTask("download-test-worker");
    store.markRunRunning(claimed.run.runId);
    const relativePath = `${firstBody.task.taskId}/${claimed.run.runId}/summary.md`;
    const absolutePath = path.join(artifactsRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "download\n");
    const recorded = store.recordArtifact({
      taskId: firstBody.task.taskId,
      runId: claimed.run.runId,
      kind: "summary",
      relativePath,
      sizeBytes: 9,
      sha256: createHash("sha256").update("download\n").digest("hex"),
    });
    const unauthenticatedDownload = await fetch(`${base}/api/artifacts/${recorded.artifactId}/download`);
    assert.equal(unauthenticatedDownload.status, 401);
    const download = await fetch(`${base}/api/artifacts/${recorded.artifactId}/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "download\n");
    await writeFile(absolutePath, "tampered\n");
    const tamperedDownload = await fetch(`${base}/api/artifacts/${recorded.artifactId}/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(tamperedDownload.status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
    await loaded.dispose();
  }
});

test("validation input rejects embedded repository credentials and non-immutable refs", async () => {
  const loaded = await loadModule("source/validation-cloud/model.ts", "model");
  try {
    assert.throws(
      () => loaded.module.normalizeValidationTaskInput(taskInput({ repository: { url: "https://secret@example.com/repo.git", commit: taskInput().repository.commit } })),
      /must not contain credentials/,
    );
    assert.throws(
      () => loaded.module.normalizeValidationTaskInput(taskInput({ repository: { url: taskInput().repository.url, commit: "main" } })),
      /full 40-character Git commit SHA/,
    );
  } finally {
    await loaded.dispose();
  }
});
