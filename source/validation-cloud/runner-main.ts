import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { ValidationTaskInput } from "./model.js";
import { VCoderValidationDriver } from "./vcoder-driver.js";

interface RunnerInput {
  readonly taskId: string;
  readonly runId: string;
  readonly input: ValidationTaskInput;
}

interface RunnerOutputArtifact {
  readonly kind: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

interface RunnerOutput {
  readonly summary: string;
  readonly artifacts: readonly RunnerOutputArtifact[];
}

function runnerErrorDetail(error: unknown): string {
  let detail = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i.test(name)) continue;
    if (value == null || value.length < 8) continue;
    detail = detail.split(value).join("[REDACTED]");
  }
  detail = detail.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
  return detail.slice(0, 2_000);
}

function fixtureArtifact(kind: string, filename: string): RunnerOutputArtifact {
  return { kind, relativePath: filename, absolutePath: `/artifacts/${filename}` };
}

async function runFixture(scenario: "success" | "partial-wait", parsed: RunnerInput): Promise<RunnerOutput> {
  process.stdout.write(`${JSON.stringify({ kind: "event", type: "fixture.started", payload: { scenario } })}\n`);
  await writeFile("/workspace/fixture-output.txt", `fixture task ${parsed.taskId}\n`);
  if (scenario === "partial-wait") {
    await writeFile("/artifacts/partial-summary.md", [
      "# Partial validation delivery",
      "",
      `Task: ${parsed.taskId}`,
      `Run: ${parsed.runId}`,
      "",
      "The fixture reached its waiting stage before cancellation or timeout.",
      "",
    ].join("\n"));
    process.stdout.write(`${JSON.stringify({ kind: "event", type: "fixture.partial_written", payload: { filename: "partial-summary.md" } })}\n`);
    const delay = Number(process.env.VALIDATION_RUNNER_FIXTURE_DELAY_MS ?? "120000");
    if (!Number.isFinite(delay) || delay < 1_000 || delay > 600_000) throw new Error("invalid fixture delay");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delay));
  }

  const summary = "Infrastructure fixture completed; this is not model-backed VCoder evidence.";
  const documents: Readonly<Record<string, string>> = {
    "summary.md": `# Fixture delivery\n\n${summary}\n`,
    "changes.patch": "diff --git a/fixture-output.txt b/fixture-output.txt\nnew file mode 100644\n--- /dev/null\n+++ b/fixture-output.txt\n@@ -0,0 +1 @@\n+fixture output\n",
    "files.json": `${JSON.stringify([{ status: "fixture", path: "fixture-output.txt" }], null, 2)}\n`,
    "tests.json": `${JSON.stringify({ status: "fixture", command: "fixture self-check", exitCode: 0 }, null, 2)}\n`,
    "test-output.txt": "fixture self-check: passed\n",
    "usage.json": `${JSON.stringify({ inputTokens: 0, outputTokens: 0, modelRequests: 0, evidenceClass: "infrastructure-fixture" }, null, 2)}\n`,
  };
  await Promise.all(Object.entries(documents).map(([filename, content]) => writeFile(`/artifacts/${filename}`, content)));
  process.stdout.write(`${JSON.stringify({ kind: "event", type: "fixture.completed", payload: { artifactCount: Object.keys(documents).length } })}\n`);
  return {
    summary,
    artifacts: [
      fixtureArtifact("summary", "summary.md"),
      fixtureArtifact("patch", "changes.patch"),
      fixtureArtifact("files", "files.json"),
      fixtureArtifact("tests", "tests.json"),
      fixtureArtifact("test_output", "test-output.txt"),
      fixtureArtifact("usage", "usage.json"),
    ],
  };
}

async function main(): Promise<void> {
  const inputPath = process.env.VALIDATION_RUN_INPUT?.trim() || "/run-input/task.json";
  const parsed = JSON.parse(await readFile(inputPath, "utf8")) as RunnerInput;
  if (typeof parsed.taskId !== "string" || typeof parsed.runId !== "string" || typeof parsed.input !== "object" || parsed.input == null) {
    throw new Error("invalid validation runner input");
  }

  const fixtureScenario = process.env.VALIDATION_RUNNER_FIXTURE_SCENARIO?.trim();
  let result: RunnerOutput;
  if (fixtureScenario === "success" || fixtureScenario === "partial-wait") {
    result = await runFixture(fixtureScenario, parsed);
  } else {
    if (fixtureScenario) throw new Error("unknown validation runner fixture scenario");
    const provider = process.env.VALIDATION_VCODER_PROVIDER?.trim();
    if (!provider) throw new Error("VALIDATION_VCODER_PROVIDER is required in the runner");
    const vcoderHome = "/tmp/vcoder-home";
    await mkdir(vcoderHome, { recursive: true });
    const credentialEnv = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
      value != null && /(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BASE_URL|ENDPOINT)$/i.test(name),
    ));
    await writeFile(`${vcoderHome}/settings.json`, JSON.stringify({
      provider,
      ...(process.env.VALIDATION_VCODER_MODEL?.trim() ? { model: process.env.VALIDATION_VCODER_MODEL.trim() } : {}),
      env: credentialEnv,
    }, null, 2), { mode: 0o600 });
    process.env.VCODER_HOME = vcoderHome;
    process.env.VALIDATION_CLOUD_SANDBOX = "1";

    const driver = new VCoderValidationDriver("/");
    result = await driver.execute({
      taskId: parsed.taskId,
      runId: parsed.runId,
      input: parsed.input,
      prepared: { workspacePath: "/workspace", artifactDirectory: "/artifacts" },
      signal: new AbortController().signal,
      report: (type, payload) => process.stdout.write(`${JSON.stringify({ kind: "event", type, payload })}\n`),
    });
  }
  process.stdout.write(`${JSON.stringify({
    kind: "result",
    summary: result.summary,
    artifacts: result.artifacts.map((artifact) => ({
      kind: artifact.kind,
      relativePath: artifact.relativePath,
      filename: artifact.absolutePath.split("/").at(-1),
    })),
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({
    kind: "failure",
    errorClass: error instanceof Error ? error.name : "RunnerError",
    detail: runnerErrorDetail(error),
  })}\n`);
  process.exitCode = 1;
});
