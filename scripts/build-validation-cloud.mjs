import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const [entry, output, format] of [["main.ts", "server.cjs", "cjs"], ["runner-main.ts", "runner.cjs", "cjs"]]) {
  await build({
    entryPoints: [path.join(root, "source/validation-cloud", entry)],
    outfile: path.join(root, ".build/validation-cloud", output),
    bundle: true,
    format,
    platform: "node",
    target: "node22",
    sourcemap: true,
  });
}

const serverPath = path.join(root, ".build/validation-cloud/server.cjs");
const serverSmoke = spawnSync(process.execPath, [serverPath], {
  encoding: "utf8",
  env: { ...process.env, VALIDATION_CLOUD_TOKEN: "" },
});
if (serverSmoke.status === 0 || !serverSmoke.stderr.includes("Set VALIDATION_CLOUD_TOKEN")) {
  throw new Error(`validation server bundle did not reach its configuration gate: ${serverSmoke.stderr || serverSmoke.stdout}`);
}

const runnerPath = path.join(root, ".build/validation-cloud/runner.cjs");
const runnerSmoke = spawnSync(process.execPath, [runnerPath], {
  encoding: "utf8",
  env: { ...process.env, VALIDATION_RUN_INPUT: path.join(root, ".build/validation-cloud/nonexistent-smoke-input.json") },
});
let runnerFailure;
try { runnerFailure = JSON.parse(runnerSmoke.stdout.trim()); } catch {}
if (runnerSmoke.status === 0 || runnerFailure?.kind !== "failure") {
  throw new Error(`validation runner bundle did not reach its structured failure gate: ${runnerSmoke.stderr || runnerSmoke.stdout}`);
}

process.stdout.write("Built validation cloud server and runner bundles\n");
