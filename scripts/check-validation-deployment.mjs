import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--") || !process.argv[index + 1]) throw new Error("Usage: node scripts/check-validation-deployment.mjs --control-env FILE --runner-env FILE");
  args.set(argument, process.argv[++index]);
}
const controlEnv = args.get("--control-env");
const runnerEnv = args.get("--runner-env");
if (!controlEnv || !runnerEnv) throw new Error("Both --control-env and --runner-env are required");

async function secureRegularFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`${file} must be a regular file with mode 0600`);
}
function parseEnv(text) {
  return new Map(text.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Invalid environment entry in ${controlEnv}`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}
await secureRegularFile(controlEnv);
await secureRegularFile(runnerEnv);
const control = parseEnv(await readFile(controlEnv, "utf8"));
const runner = parseEnv(await readFile(runnerEnv, "utf8"));
if ((control.get("VALIDATION_CLOUD_TOKEN") ?? "").length < 24 || control.get("VALIDATION_CLOUD_TOKEN")?.startsWith("replace-with")) throw new Error("control env must contain a high-entropy validation token");
if (control.get("VALIDATION_CLOUD_HOST") !== "127.0.0.1") throw new Error("control plane must bind to 127.0.0.1 behind the TLS proxy");
if (control.get("VALIDATION_CLOUD_EXECUTOR") !== "vcoder-docker") throw new Error("deployment executor must be vcoder-docker");
if (!/^.+@sha256:[a-f0-9]{64}$/.test(control.get("VALIDATION_CLOUD_RUNNER_IMAGE") ?? "")) throw new Error("runner image must be pinned by an immutable sha256 digest");
if (path.resolve(control.get("VALIDATION_CLOUD_RUNNER_ENV_FILE")) !== path.resolve(runnerEnv)) throw new Error("control env runner file does not match the checked runner env");
if (!runner.get("VALIDATION_VCODER_PROVIDER") || runner.get("VALIDATION_VCODER_PROVIDER")?.startsWith("replace-with")) throw new Error("runner env must name a configured provider");
if ([...runner.values()].some(value => value.includes("replace-with"))) throw new Error("runner env still contains a placeholder");

const manifestPath = path.join(root, ".build/validation-cloud/build-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const [name, entry] of Object.entries(manifest.bundles ?? {})) {
  const file = path.join(root, entry.path);
  const bytes = await readFile(file);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== entry.sha256 || bytes.byteLength !== entry.bytes) throw new Error(`bundle manifest mismatch: ${name}`);
}
process.stdout.write(JSON.stringify({ schemaVersion: 1, sourceCommit: manifest.sourceCommit, bundles: Object.keys(manifest.bundles), checks: ["env-permissions", "deployment-boundary", "bundle-integrity"] }) + "\n");
