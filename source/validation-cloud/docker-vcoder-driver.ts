import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

import { VCoderValidationDriver } from "./vcoder-driver.js";
import type { ValidationRunDriver, ValidationRunResult } from "./worker.js";

interface RunnerResult {
  readonly kind: "result";
  readonly summary: string;
  readonly artifacts: readonly { readonly kind: string; readonly relativePath: string; readonly filename: string }[];
}

interface RunnerFailure {
  readonly kind: "failure";
  readonly errorClass: string;
  readonly detail: string;
}

function dockerName(runId: string): string {
  return `vcoder-validation-${runId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(-50)}`;
}

export class DockerVCoderValidationDriver implements ValidationRunDriver {
  private readonly workspaceDriver: VCoderValidationDriver;
  private readonly runnerImage: string;
  private readonly runnerEnvFile: string | undefined;
  private readonly runnerFixtureScenario: "success" | "partial-wait" | undefined;

  constructor(readonly dataDirectory: string, options: {
    readonly runnerImage: string;
    readonly runnerEnvFile?: string;
    readonly runnerFixtureScenario?: "success" | "partial-wait";
    readonly allowedRepositoryHosts?: readonly string[];
  }) {
    this.workspaceDriver = new VCoderValidationDriver(dataDirectory, options.allowedRepositoryHosts == null
      ? {}
      : { allowedRepositoryHosts: options.allowedRepositoryHosts });
    this.runnerImage = options.runnerImage;
    this.runnerEnvFile = options.runnerEnvFile == null ? undefined : resolve(options.runnerEnvFile);
    this.runnerFixtureScenario = options.runnerFixtureScenario;
  }

  prepare(args: Parameters<ValidationRunDriver["prepare"]>[0]) {
    return this.workspaceDriver.prepare(args);
  }

  async execute(args: Parameters<ValidationRunDriver["execute"]>[0]): Promise<ValidationRunResult> {
    const runnerInputDir = resolve(this.dataDirectory, "runner-inputs", args.taskId, args.runId);
    await mkdir(runnerInputDir, { recursive: true });
    const runnerInputPath = join(runnerInputDir, "task.json");
    await writeFile(runnerInputPath, JSON.stringify({ taskId: args.taskId, runId: args.runId, input: args.input }), { mode: 0o600 });
    const name = dockerName(args.runId);
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    const dockerArgs = [
      "run", "--rm", "--name", name,
      "--cpus", "2",
      "--memory", "4g",
      "--pids-limit", "256",
      "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", `${uid}:${gid}`,
      ...(this.runnerEnvFile == null ? [] : ["--env-file", this.runnerEnvFile]),
      "--env", "VALIDATION_RUN_INPUT=/run-input/task.json",
      ...(this.runnerFixtureScenario == null ? [] : ["--env", `VALIDATION_RUNNER_FIXTURE_SCENARIO=${this.runnerFixtureScenario}`]),
      "--mount", `type=bind,src=${args.prepared.workspacePath},dst=/workspace`,
      "--mount", `type=bind,src=${args.prepared.artifactDirectory},dst=/artifacts`,
      "--mount", `type=bind,src=${runnerInputPath},dst=/run-input/task.json,readonly`,
      this.runnerImage,
    ];
    const result = await new Promise<RunnerResult>((resolvePromise, reject) => {
      const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let settledResult: RunnerResult | undefined;
      let settledFailure: RunnerFailure | undefined;
      const acceptLine = (line: string) => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { return; }
        if (typeof value !== "object" || value == null) return;
        const message = value as { kind?: unknown; type?: unknown; payload?: unknown };
        if (message.kind === "event" && typeof message.type === "string" && typeof message.payload === "object" && message.payload != null) {
          args.report(message.type, message.payload as Record<string, unknown>);
        } else if (message.kind === "result") {
          settledResult = value as RunnerResult;
        } else if (message.kind === "failure") {
          settledFailure = value as RunnerFailure;
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) acceptLine(line);
      });
      child.stderr.resume();
      const abort = () => {
        const stop = spawn("docker", ["stop", "--time", "5", name], { stdio: "ignore" });
        stop.unref();
      };
      args.signal.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        args.signal.removeEventListener("abort", abort);
        if (stdout.trim()) acceptLine(stdout.trim());
        if (args.signal.aborted) return reject(args.signal.reason ?? new Error("runner stopped"));
        if (code !== 0) {
          const diagnostic = settledFailure?.detail?.trim();
          return reject(new Error(diagnostic == null || diagnostic.length === 0
            ? `VCoder runner failed (${code ?? signal ?? "unknown"}); diagnostics were not persisted`
            : `VCoder runner failed [${settledFailure?.errorClass || "RunnerError"}]: ${diagnostic}`));
        }
        if (settledResult == null) return reject(new Error("VCoder runner exited without a result record"));
        resolvePromise(settledResult);
      });
    });
    return {
      summary: result.summary,
      artifacts: result.artifacts.map((artifact) => ({
        kind: artifact.kind,
        relativePath: relative(this.workspaceDriver.artifactsRoot, join(args.prepared.artifactDirectory, basename(artifact.filename))),
        absolutePath: join(args.prepared.artifactDirectory, basename(artifact.filename)),
      })),
    };
  }

  async collectPartialArtifacts(args: Parameters<NonNullable<ValidationRunDriver["collectPartialArtifacts"]>>[0]) {
    const entries = await readdir(args.prepared.artifactDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.name))
      .map((entry) => ({
        kind: "partial",
        relativePath: relative(this.workspaceDriver.artifactsRoot, join(args.prepared.artifactDirectory, entry.name)),
        absolutePath: join(args.prepared.artifactDirectory, entry.name),
      }));
  }
}
