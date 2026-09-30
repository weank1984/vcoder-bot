import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-vcoder-bg-"));
  const output = path.join(temporary, "mod.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/host/extensions/inference/vcoder-background-tasks.ts")], outfile: output, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  try { return await import(`${pathToFileURL(output).href}?t=${Date.now()}`); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

test("tracks VCoder background shells and subagents per agent until they finish", async () => {
  const m = await loadModule();
  const changes = [];
  m.onVCoderBackgroundTasksChanged(id => changes.push(id));
  assert.equal(m.agentIdForVCoderSession("grok-abc-123-g2"), "abc-123");
  m.recordVCoderBackgroundEvent({ type: "background_shell_task", sessionId: "grok-abc-123", task: { id: "b1", command: "tools/gate_p0.sh > log", status: "running", startedAt: 1 } });
  m.recordVCoderBackgroundEvent({ type: "subagent_run", sessionId: "grok-abc-123-g1", run: { id: "s1", title: "review", status: "running", startedAt: 2 } });
  assert.deepEqual(m.vcoderAgentsWithBackgroundTasks(), ["abc-123"]);
  assert.deepEqual(m.listVCoderBackgroundTasks("abc-123").map(t => [t.kind, t.label]), [["shell", "tools/gate_p0.sh > log"], ["subagent", "review"]]);
  m.recordVCoderBackgroundEvent({ type: "background_shell_task", sessionId: "grok-abc-123", task: { id: "b1", status: "completed", exitCode: 0 } });
  m.recordVCoderBackgroundEvent({ type: "subagent_run", sessionId: "grok-abc-123", run: { id: "s1", status: "failed" } });
  assert.deepEqual(m.vcoderAgentsWithBackgroundTasks(), []);
  assert.equal(changes.length, 4);
  m.recordVCoderBackgroundEvent({ type: "background_shell_task", sessionId: "other-session", task: { id: "x", status: "running" } });
  assert.deepEqual(m.vcoderAgentsWithBackgroundTasks(), []);
});
