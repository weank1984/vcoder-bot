import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// Invoked in a separate network-disabled container with a read-only workspace,
// no provider env-file, and no control-plane directory mounted.
const kind = process.argv[2];
const runTests = filename => {
  const run = spawnSync(process.execPath, ["--test", filename], { cwd: "/workspace", encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(run.error, undefined, "test process failed to start or exceeded bounds");
  assert.equal(run.signal, null);
  return { exitCode: run.status, output: run.stdout + run.stderr };
};
let testRun;
if (kind === "macho-header") {
  const { parseMachO } = await import("file:///workspace/scripts/lib/macos-shell-invariant.mjs");
  for (let size = 0; size < 32; size++) {
    assert.throws(() => parseMachO(Buffer.alloc(size)), error => error.message === "Mach-O header is truncated");
  }
  assert.throws(() => parseMachO(Buffer.alloc(32)), /expected a thin arm64 Mach-O executable/);
  const valid = Buffer.alloc(48);
  valid.writeUInt32LE(0xfeedfacf, 0); valid.writeUInt32LE(1, 16);
  valid.writeUInt32LE(0x1d, 32); valid.writeUInt32LE(16, 36); valid.writeUInt32LE(48, 40);
  assert.equal(parseMachO(valid).signature.dataOffset, 48);
} else if (kind === "process-tests" || kind === "capture-trim") {
  testRun = runTests("tests/validation-process.test.mjs");
  assert.equal(testRun.exitCode, 0, testRun.output);
  if (kind === "process-tests") {
    const count = /(?:#|ℹ) tests (\d+)/.exec(testRun.output);
    assert.ok(count && Number(count[1]) >= 3, "at least three tests required");
  } else {
    const { capture } = await import("file:///workspace/scripts/lib/process.mjs");
    const args = ["-e", "process.stdout.write('  preserved \\n')"];
    assert.equal(await capture(process.execPath, args), "preserved");
    assert.equal(await capture(process.execPath, args, { trim: false }), "  preserved \n");
    assert.match(await readFile("/workspace/docs/validation-capture.md", "utf8"), /trim/);
  }
} else if (kind === "expected-test-failure") {
  testRun = runTests("tests/validation-intentional-failure.test.mjs");
  assert.equal(testRun.exitCode, 1, testRun.output);
  assert.match(testRun.output, /intentional validation failure/);
  assert.match(testRun.output, /(?:#|ℹ) fail 1/);
} else { throw new Error("unknown verification kind"); }
process.stdout.write(JSON.stringify({ acceptance: "passed", verification: kind, ...(testRun ? { testRun } : {}) }) + "\n");
