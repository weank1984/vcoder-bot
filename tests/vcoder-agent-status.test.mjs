import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-vcoder-status-"));
  const output = path.join(temporary, "mod.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile: output, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  try { return await import(`${pathToFileURL(output).href}?t=${Date.now()}`); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

test("tracks a VCoder turn: start → tool → context_detail → end, capped at 300k", async () => {
  delete process.env.SAND_VCODER_CONTEXT_WINDOW;
  delete process.env.VCODER_MAX_CONTEXT_TOKENS;
  process.env.SAND_VCODER_PROVIDER = "dashscope";
  process.env.SAND_VCODER_MODEL = "deepseek-v4-flash-0731";
  const status = await loadModule("source/host/extensions/inference/vcoder-agent-status.ts");

  let s = status.getVCoderAgentStatus("agent-a", 1000);
  assert.equal(s.provider, "dashscope");
  assert.equal(s.model, "deepseek-v4-flash-0731");
  assert.equal(s.contextWindow, 300_000);
  assert.equal(s.percent, null);
  assert.equal(s.turnRunning, false);

  status.noteVCoderTurnStarted("grok-agent-a", 1000);
  status.noteVCoderToolStarted("grok-agent-a", "Bash", "pytest   -q\n", 2000);
  s = status.getVCoderAgentStatus("agent-a", 3000);
  assert.equal(s.turnRunning, true);
  assert.equal(s.turnStartedAtMs, 1000);
  assert.deepEqual(s.currentTool, { name: "Bash", detail: "pytest -q", startedAtMs: 2000 });

  status.noteVCoderToolFinished("grok-agent-a", 4000);
  status.recordVCoderStatusEvent({ type: "context_detail", sessionId: "grok-agent-a-g2", detail: { model: "deepseek-v4-flash-0731", usedTokens: 150_000, contextWindow: 1_000_000, percentage: 15 } }, 5000);
  s = status.getVCoderAgentStatus("agent-a", 5000);
  assert.equal(s.currentTool, null);
  assert.equal(s.contextUsed, 150_000);
  assert.equal(s.contextWindow, 300_000);
  assert.equal(s.percent, 50);

  status.recordVCoderStatusEvent({ type: "context_compacted", sessionId: "grok-agent-a" });
  status.noteVCoderTurnEnded("grok-agent-a", 6000);
  s = status.getVCoderAgentStatus("agent-a", 6000);
  assert.equal(s.compactions, 1);
  assert.equal(s.turnRunning, false);
  assert.equal(s.turnStartedAtMs, null);

  // A smaller reported window is kept; other agents are independent.
  status.recordVCoderStatusEvent({ type: "context_detail", sessionId: "grok-agent-b", detail: { usedTokens: 64_000, contextWindow: 128_000 } });
  assert.equal(status.getVCoderAgentStatus("agent-b").contextWindow, 128_000);
  assert.equal(status.getVCoderAgentStatus("agent-b").percent, 50);
  status.recordVCoderStatusEvent({ type: "context_detail", sessionId: "not-a-grok-session", detail: { usedTokens: 1 } });
});

test("context window cap honours SAND_VCODER_CONTEXT_WINDOW", async () => {
  const status = await loadModule("source/host/extensions/inference/vcoder-agent-status.ts");
  assert.equal(status.effectiveVCoderContextWindow({}), 300_000);
  assert.equal(status.effectiveVCoderContextWindow({ SAND_VCODER_CONTEXT_WINDOW: "200000" }), 200_000);
  assert.equal(status.effectiveVCoderContextWindow({ VCODER_MAX_CONTEXT_TOKENS: "128000" }), 128_000);
  assert.equal(status.effectiveVCoderContextWindow({ SAND_VCODER_CONTEXT_WINDOW: "junk" }), 300_000);
});

test("status line formats like the VCoder CLI", async () => {
  const line = await loadModule("source/electron-preload/vcoder-statusline.ts");
  const running = line.formatVCoderStatus({ provider: "dashscope", model: "deepseek-v4-flash-0731", contextUsed: 182_000, contextWindow: 300_000, percent: 61, turnRunning: true, turnStartedAtMs: 0, currentTool: { name: "Bash", detail: "pytest -q", startedAtMs: 0 }, compactions: 1, backgroundTasks: [{}, {}], nowMs: 250_000 }, 2_000);
  assert.equal(running.map(s => s.text).join(" │ "), "dashscope · deepseek-v4-flash-0731 │ ctx 182k/300k (61%) │ ● 运行中 4m12s · Bash: pytest -q │ 后台 2 · 压缩 1");
  const idle = line.formatVCoderStatus({ provider: null, model: "m", contextUsed: 250_000, contextWindow: 300_000, percent: 83, turnRunning: false, turnStartedAtMs: null, currentTool: null, compactions: 0, backgroundTasks: [], nowMs: 0 });
  assert.equal(idle[1].tone, "warn");
  assert.equal(idle[2].text, "○ 空闲");
  assert.equal(idle.length, 3);
});
