import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Direct, isolated runner comparison: no HTTP API or worker scheduling.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = process.env.VALIDATION_CLOUD_DATA_DIR;
const envFile = process.env.VALIDATION_RUNNER_ENV_FILE;
assert.ok(data && envFile, "data directory and runner env file required");
const suite = JSON.parse(await readFile(path.join(root, "docs/validation-evidence/taskset-v1.json"), "utf8"));
const prefix = process.env.VALIDATION_BASELINE_PREFIX;
assert.match(prefix ?? "", /^[a-zA-Z0-9_-]+$/);
const records = [];
await mkdir(path.join(data, "baseline-evidence"), { recursive: true });
for (const caseId of ["B02", "B04"]) {
  const taskCase = suite.cases.find(item => item.caseId === caseId);
  const source = JSON.parse(await readFile(path.join(data, "suite-evidence/suite-20260918-v1", `${caseId}-r1.json`), "utf8"));
  for (let repetition = 1; repetition <= 2; repetition++) {
    const taskId = `${prefix}-${caseId}-r${repetition}`;
    const folder = path.join(data, "baseline-evidence", taskId);
    await mkdir(folder, { recursive: false }); // Never overwrite an earlier run.
    const workspace = path.join(folder, "workspace");
    const artifacts = path.join(folder, "artifacts");
    await mkdir(artifacts);
    const preparationStarted = Date.now();
    execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", path.join(data, "workspaces", source.taskId, source.snapshot.runs[0].runId), workspace], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }, stdio: "pipe" });
    execFileSync("git", ["checkout", "--detach", suite.repository.commit], { cwd: workspace, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }, stdio: "pipe" });
    execFileSync("git", ["remote", "remove", "origin"], { cwd: workspace });
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }), "");
    const preparationMs = Date.now() - preparationStarted;
    const inputPath = path.join(folder, "task.json");
    await writeFile(inputPath, JSON.stringify({ taskId, runId: taskId, input: source.snapshot.task.input }), { mode: 0o600 });
    const record = { caseId, repetition, taskId, mode: "direct-local-docker", preparationMs, preparationComparable: false, acceptance: "failed", limitations: ["Local Git object clone, not remote preparation timing", "Same Linux Docker runtime; not native desktop or physical cloud comparison"] };
    const started = Date.now();
    const name = `baseline-${taskId}`;
    process.stdout.write(`${taskId}: started\n`);
    try {
      const output = execFileSync("docker", ["run", "--rm", "--name", name, "--cpus", "2", "--memory", "4g", "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${process.getuid()}:${process.getgid()}`, "--env-file", envFile, "--mount", `type=bind,src=${workspace},dst=/workspace`, "--mount", `type=bind,src=${artifacts},dst=/artifacts`, "--mount", `type=bind,src=${inputPath},dst=/run-input/task.json,readonly`, "vcoder-validation-runner:dev"], { encoding: "utf8", timeout: 180000, maxBuffer: 5 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      await writeFile(path.join(folder, "events.jsonl"), output);
      assert.ok(output.split("\n").some(line => { try { return JSON.parse(line).kind === "result"; } catch { return false; } }), "runner did not return result");
      const files = JSON.parse(await readFile(path.join(artifacts, "files.json"), "utf8"));
      assert.deepEqual(files.map(file => file.path).sort(), [...taskCase.allowedFiles].sort());
      const evaluation = execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--cpus", "1", "--pids-limit", "64", "--user", "1000:1000", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--mount", `type=bind,src=${workspace},dst=/workspace,readonly`, "--mount", `type=bind,src=${path.join(root, "scripts/validation-evaluate-case.mjs")},dst=/verify.mjs,readonly`, "--entrypoint", "node", "vcoder-validation-runner:dev", "/verify.mjs", taskCase.verification], { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      record.independentVerification = JSON.parse(evaluation.trim());
      record.usage = JSON.parse(await readFile(path.join(artifacts, "usage.json"), "utf8"));
      record.acceptance = "passed";
    } catch (error) {
      // Do not persist Docker errors containing runtime output or environment secrets.
      record.failure = { code: error.code ?? null, status: error.status ?? null, name: error.name };
    } finally {
      try { execFileSync("docker", ["stop", "--time", "5", name], { stdio: "ignore", timeout: 10000 }); } catch {}
    }
    record.totalExecutionAndVerificationMs = Date.now() - started;
    await writeFile(path.join(folder, "record.json"), JSON.stringify(record, null, 2) + "\n");
    records.push(record);
    process.stdout.write(`${taskId}: ${record.acceptance}\n`);
  }
}
await writeFile(path.join(data, "baseline-evidence", `${prefix}-index.json`), JSON.stringify(records, null, 2) + "\n");
