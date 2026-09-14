import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-tool-activity-outline-"));
  const output = path.join(temporary, "conversation-outline.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/runner/conversation-outline.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  try {
    return await import(`${pathToFileURL(output).href}?t=${Date.now()}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function communicateToolCall(payload) {
  return {
    tool: {
      case: "communicateUpdateToolCall",
      value: { args: { toJson: () => ({ currentStep: JSON.stringify(payload) }) } },
    },
  };
}

test("display-only tool activity resolves to the reported tool name and detail", async () => {
  const outline = await loadModule();
  const started = communicateToolCall({ __sand_tool__: true, phase: "activity", tool: "Bash", detail: "ls -la /workspace" });
  assert.equal(outline.getOutlineToolCallName(started), "Bash");
  assert.equal(outline.getOutlineToolCallSummary(started), "ls -la /workspace");
  const completed = communicateToolCall({ __sand_tool__: true, phase: "activity", tool: "Read", result: "file contents" });
  assert.equal(outline.getOutlineToolCallName(completed), "Read");
  assert.equal(outline.getOutlineToolCallSummary(completed), "file contents");
});

test("real Communicate-tool payloads keep the existing outline naming", async () => {
  const outline = await loadModule();
  const executing = communicateToolCall({ __sand_tool__: true, phase: "executing", tool: "InstallMcpServer", detail: "linear" });
  assert.equal(outline.getOutlineToolCallName(executing), "communicateUpdateToolCall");
  assert.equal(outline.getOutlineToolCallSummary(executing), undefined);
  const completed = communicateToolCall({ __sand_tool__: true, result: "done" });
  assert.equal(outline.getOutlineToolCallName(completed), "communicateUpdateToolCall");
  assert.equal(outline.getOutlineToolCallSummary(completed), undefined);
});
