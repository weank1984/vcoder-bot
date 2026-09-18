import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Fail closed: every failed assertion terminates with a non-zero exit code.
const [workspaceArg, artifactsArg, commit, credentialFile] = process.argv.slice(2);
assert.ok(workspaceArg && artifactsArg && /^[a-f0-9]{40}$/.test(commit ?? ""),
  "usage: node scripts/verify-validation-b01.mjs WORKSPACE ARTIFACTS COMMIT [CREDENTIAL_ENV_FILE]");
const workspace = path.resolve(workspaceArg);
const artifacts = path.resolve(artifactsArg);
const target = "docs/agent-cloud-smoke.md";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
assert.equal(git(workspace, "rev-parse", "HEAD").trim(), commit);
assert.equal(git(workspace, "status", "--porcelain=v1", "-z", "--untracked-files=all"), `?? ${target}\0`);
assert.equal(git(workspace, "remote").trim(), "");
git(workspace, "diff", "--check");
const content = await readFile(path.join(workspace, target), "utf8");
assert.equal(content.split("\n")[0], "# Agent cloud validation");
assert.ok(content.includes(commit));
assert.ok(content.includes("No remote side effects were requested."));
const files = JSON.parse(await readFile(path.join(artifacts, "files.json"), "utf8"));
assert.deepEqual(files, [{ status: "??", path: target }]);
const tests = JSON.parse(await readFile(path.join(artifacts, "tests.json"), "utf8"));
assert.equal(tests.status, "passed");
assert.deepEqual(tests.commands, [{ command: "git diff --check", status: "passed", exitCode: 0 }]);
const output = await readFile(path.join(artifacts, "test-output.txt"), "utf8");
assert.ok(output.includes("$ git diff --check\n"));
assert.ok(output.includes("[status=passed exitCode=0]"));
const temp = await mkdtemp(path.join(os.tmpdir(), "vcoder-b01-verify-"));
try {
  git(temp, "clone", "--quiet", "--no-checkout", workspace, "replay");
  const replay = path.join(temp, "replay");
  execFileSync("git", ["checkout", "--quiet", "--detach", commit], {
    cwd: replay, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }, stdio: "pipe",
  });
  git(replay, "apply", "--check", path.join(artifacts, "changes.patch"));
  git(replay, "apply", path.join(artifacts, "changes.patch"));
  assert.equal(git(replay, "status", "--porcelain=v1", "-z", "--untracked-files=all"), `?? ${target}\0`);
  assert.equal(await readFile(path.join(replay, target), "utf8"), content);
} finally { await rm(temp, { recursive: true, force: true }); }

const secrets = [];
if (credentialFile) {
  for (const line of (await readFile(credentialFile, "utf8")).split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY/.test(match[1]) && match[2].length >= 8) {
      secrets.push(match[2]);
    }
  }
  assert.ok(secrets.length > 0, "credential scan requested but no secret values loaded");
}
const artifactSha256 = {};
for (const name of await readdir(artifacts)) {
  const data = await readFile(path.join(artifacts, name));
  for (const secret of secrets) assert.ok(!data.includes(Buffer.from(secret)), "injected credential found in artifact");
  assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(data.toString()), "private key marker in artifact");
  artifactSha256[name] = createHash("sha256").update(data).digest("hex");
}
for (const secret of secrets) assert.ok(!content.includes(secret), "injected credential in target file");
process.stdout.write(JSON.stringify({
  acceptance: "passed", gitDiffCheckExitCode: 0, patchReplay: "passed",
  structuredTestEvidence: "passed", secretScan: secrets.length ? "clean" : "not-run",
  remoteSideEffects: "not-independently-audited; workspace has no remote",
  artifactSha256,
}, null, 2) + "\n");
