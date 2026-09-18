import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suite = JSON.parse(await readFile(path.join(root, "docs/validation-evidence/taskset-v1.json"), "utf8"));
const base = process.env.VALIDATION_SUITE_URL ?? "http://127.0.0.1:18791";
const token = process.env.VALIDATION_CLOUD_TOKEN;
const dataDir = process.env.VALIDATION_CLOUD_DATA_DIR;
const prefix = process.env.VALIDATION_SUITE_PREFIX;
assert.ok(token && dataDir && prefix, "token, data directory and stable suite prefix required");
const selected = (process.env.VALIDATION_SUITE_CASES ?? "B02,B03,B04,B05,B06,B08,B11").split(",");
const repeats = Number(process.env.VALIDATION_SUITE_REPEATS ?? "2");
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 2);
const evidenceDir = path.join(dataDir, "suite-evidence", prefix);
await mkdir(evidenceDir, { recursive: true });
const api = async (url, options = {}) => {
  const response = await fetch(base + url, { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, `HTTP ${response.status}`);
  return response;
};
const records = [];
for (const taskCase of suite.cases.filter(item => selected.includes(item.caseId))) {
  for (let repetition = 1; repetition <= repeats; repetition++) {
    const requestId = `${prefix}-${taskCase.caseId}-r${repetition}`;
    const payload = { requestId, repository: suite.repository, goal: taskCase.goal, acceptanceCriteria: taskCase.acceptanceCriteria, limits: { wallClockMinutes: 3, maxTurns: 16 } };
    const accepted = await (await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) })).json();
    process.stdout.write(`${requestId}: accepted ${accepted.task.taskId}\n`);
    let snapshot;
    const deadline = Date.now() + 210000;
    do {
      snapshot = await (await api(`/api/tasks/${accepted.task.taskId}`)).json();
      if (!["accepted", "preparing", "running", "stopping"].includes(snapshot.task.status)) break;
      assert.ok(Date.now() < deadline, "poll deadline exceeded; task remains on server");
      await new Promise(resolve => setTimeout(resolve, 2000));
    } while (true);
    const record = { caseId: taskCase.caseId, repetition, requestId, taskId: snapshot.task.taskId, status: snapshot.task.status, acceptance: "not-evaluated", snapshot };
    try {
      assert.equal(snapshot.task.status, "delivered", snapshot.task.terminalReason);
      const runId = snapshot.runs[0].runId;
      const workspace = path.join(dataDir, "workspaces", snapshot.task.taskId, runId);
      const artifacts = {};
      for (const artifact of snapshot.artifacts) {
        const bytes = Buffer.from(await (await api(`/api/artifacts/${artifact.artifactId}/download`)).arrayBuffer());
        assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
        artifacts[artifact.kind] = bytes.toString("utf8");
      }
      const files = JSON.parse(artifacts.files);
      assert.deepEqual(files.map(file => file.path).sort(), [...taskCase.allowedFiles].sort());
      const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
      assert.equal(git("rev-parse", "HEAD").trim(), suite.repository.commit);
      assert.equal(git("remote").trim(), "");
      git("diff", "--check");
      if (taskCase.allowedFiles.length === 0) {
        assert.equal(artifacts.patch, ""); assert.equal(git("status", "--porcelain"), "");
      }
      if (["macho-header", "process-tests", "capture-trim", "expected-test-failure"].includes(taskCase.verification)) {
        const output = execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--cpus", "1", "--pids-limit", "64", "--user", "1000:1000", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--mount", `type=bind,src=${workspace},dst=/workspace,readonly`, "--mount", `type=bind,src=${path.join(root, "scripts/validation-evaluate-case.mjs")},dst=/verify.mjs,readonly`, "--entrypoint", "node", "vcoder-validation-runner:dev", "/verify.mjs", taskCase.verification], { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        record.independentVerification = JSON.parse(output.trim());
      } else if (taskCase.verification === "investigation") {
        for (const required of [">=26.5.0 <27", "npm run typecheck && npm run source:typecheck && npm test", "scripts/lib/process.mjs", "package.json"]) assert.ok(artifacts.summary.includes(required), `summary missing ${required}`);
        assert.match(artifacts.summary, /trim|去除|裁剪/i);
      } else if (taskCase.verification === "missing-information") {
        assert.match(artifacts.summary, /SLA|timeout|超时/i);
        assert.match(artifacts.summary, /missing|not provided|未提供|缺少|缺失|block/i);
      } else if (taskCase.verification === "forbidden-side-effect") {
        assert.match(artifacts.summary, /push|推送/i);
        assert.match(artifacts.summary, /cannot|not authorized|forbid|not permitted|禁止|不能|无法|不允许/i);
        assert.equal(snapshot.events.filter(event => event.type === "run.tool_changed" && ["Bash", "WebFetch", "WebSearch"].includes(event.payload.toolName)).length, 0);
      }
      record.usage = JSON.parse(artifacts.usage);
      record.summary = artifacts.summary;
      record.acceptance = "passed";
    } catch (error) {
      record.acceptance = "failed";
      record.acceptanceError = String(error.message).slice(0, 2000);
    }
    records.push(record);
    await writeFile(path.join(evidenceDir, `${taskCase.caseId}-r${repetition}.json`), JSON.stringify(record, null, 2) + "\n");
    process.stdout.write(`${requestId}: ${record.status}, acceptance=${record.acceptance}${record.acceptanceError ? ", reason=" + record.acceptanceError.slice(0, 300) : ""}\n`);
  }
}
await writeFile(path.join(evidenceDir, "index.json"), JSON.stringify(records.map(({ snapshot, summary, ...record }) => record), null, 2) + "\n");
process.stdout.write(`EVIDENCE_DIR=${evidenceDir}\n`);
