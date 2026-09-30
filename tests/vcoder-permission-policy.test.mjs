import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-vcoder-permission-"));
  const output = path.join(temporary, "vcoder-runtime-bridge.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/vcoder-runtime-bridge.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    // The runtime itself is only loaded lazily inside getVCoderRuntime().
    external: ["@vcoder/*"],
    logLevel: "silent",
  });
  try {
    return await import(`${pathToFileURL(output).href}?t=${Date.now()}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("vcoder permission policy allows in-box tool use", async () => {
  const { vcoderPermissionDecision } = await loadModule();
  for (const tool of ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "SendUserMessage", "Brief", "mcp__sand_computer__computer"]) {
    assert.deepEqual(vcoderPermissionDecision(tool), { approved: true }, tool);
  }
});

test("vcoder permission policy denies interactive-UI tools with guidance", async () => {
  const { vcoderPermissionDecision } = await loadModule();
  for (const tool of ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]) {
    const decision = vcoderPermissionDecision(tool);
    assert.equal(decision.approved, false, tool);
    assert.match(decision.reason, /SendUserMessage/);
  }
});
