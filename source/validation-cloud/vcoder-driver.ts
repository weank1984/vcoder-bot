import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import type { RuntimeEvent } from "@vcoder/agent-core/runtime";
import { VcoderCoreRuntimeImpl } from "@vcoder/server/runtime";

import type {
  ValidationPreparedRun,
  ValidationProducedArtifact,
  ValidationRunDriver,
  ValidationRunResult,
} from "./worker.js";
import { isPreapprovedValidationPermission } from "./validation-permissions.js";
import { collectGitDelivery } from "./git-delivery.js";

const MAX_COMMAND_OUTPUT_BYTES = 5 * 1024 * 1024;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface ValidationTestResult {
  readonly command: string;
  readonly status: "passed" | "failed";
  readonly exitCode: 0 | "unknown";
  readonly output: string;
}

function toolResultText(content: string | Array<{ type: string; text?: string }>): string {
  return (typeof content === "string" ? content : content.map((block) => block.text ?? "").join("\n")).slice(0, 10_000);
}

function safeWorkspacePath(workspace: string, candidate: string): string {
  const root = resolve(workspace);
  const path = resolve(root, candidate);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`path escapes validation workspace: ${candidate}`);
  return path;
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly signal: AbortSignal;
    readonly env?: Readonly<Record<string, string>>;
    readonly acceptedExitCodes?: readonly number[];
  },
): Promise<CommandResult> {
  const commandLabel = [command, ...args].join(" ");
  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd == null ? {} : { cwd: options.cwd }),
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total <= MAX_COMMAND_OUTPUT_BYTES) target.push(chunk);
      else child.kill("SIGTERM");
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    const abort = () => child.kill("SIGTERM");
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      options.signal.removeEventListener("abort", abort);
      if (options.signal.aborted) return reject(options.signal.reason ?? new Error("command aborted"));
      const output = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (total > MAX_COMMAND_OUTPUT_BYTES) return reject(new Error(`${commandLabel} output exceeded 5 MiB`));
      if (!(options.acceptedExitCodes ?? [0]).includes(code ?? -1)) {
        return reject(new Error(`${commandLabel} failed (${code ?? signal ?? "unknown"}): ${output.stderr.slice(-2_000)}`));
      }
      resolvePromise(output);
    });
  });
}

function validationPrompt(input: Parameters<ValidationRunDriver["execute"]>[0]["input"]): string {
  return [
    "You are executing one bounded repository-change task in an isolated validation workspace.",
    "Modify only files inside the current workspace. Do not push, create a pull request, publish, send external messages, read credentials, or access paths outside the workspace.",
    "Inspect the repository, implement the smallest correct change, and run relevant tests that are already available in the repository.",
    "When the task requests git diff --check, run exactly git diff --check as a standalone Bash command; it is the only shell command preauthorized by this validation runner.",
    "If required information, network access, credentials, or tools are missing, stop and report the exact blocker without expanding scope.",
    "Finish with a concise delivery summary containing changed files, tests actually run and their results, and anything not verified.",
    "",
    `Goal:\n${input.goal}`,
    "",
    `Acceptance criteria:\n${input.acceptanceCriteria.map((value, index) => `${index + 1}. ${value}`).join("\n")}`,
  ].join("\n");
}

function assertNoInjectedSecret(text: string): void {
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i.test(name)) continue;
    if (value == null || value.length < 8) continue;
    if (text.includes(value)) throw new Error(`delivery contains injected secret value from ${name}`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    throw new Error("delivery contains a private key marker");
  }
}

function artifact(
  kind: string,
  artifactsRoot: string,
  artifactDirectory: string,
  filename: string,
): ValidationProducedArtifact {
  return {
    kind,
    relativePath: relative(artifactsRoot, join(artifactDirectory, filename)),
    absolutePath: join(artifactDirectory, filename),
  };
}

export class VCoderValidationDriver implements ValidationRunDriver {
  readonly workspacesRoot: string;
  readonly artifactsRoot: string;
  private readonly allowedRepositoryHosts: ReadonlySet<string>;

  constructor(dataDirectory: string, options: { readonly allowedRepositoryHosts?: readonly string[] } = {}) {
    this.workspacesRoot = resolve(dataDirectory, "workspaces");
    this.artifactsRoot = resolve(dataDirectory, "artifacts");
    this.allowedRepositoryHosts = new Set((options.allowedRepositoryHosts ?? ["github.com"]).map((host) => host.toLowerCase()));
  }

  async prepare(args: Parameters<ValidationRunDriver["prepare"]>[0]): Promise<ValidationPreparedRun> {
    const repositoryHost = new URL(args.input.repository.url).hostname.toLowerCase();
    if (!this.allowedRepositoryHosts.has(repositoryHost)) {
      throw new Error(`repository host is not allowed by the worker: ${repositoryHost}`);
    }
    const workspacePath = safeWorkspacePath(this.workspacesRoot, `${args.taskId}/${args.runId}`);
    const artifactDirectory = safeWorkspacePath(this.artifactsRoot, `${args.taskId}/${args.runId}`);
    await mkdir(workspacePath, { recursive: true });
    await mkdir(artifactDirectory, { recursive: true });
    args.report("workspace.preparing", { repository: args.input.repository.url, commit: args.input.repository.commit });
    await runCommand("git", ["init", "--quiet"], { cwd: workspacePath, signal: args.signal });
    await runCommand("git", ["remote", "add", "origin", args.input.repository.url], { cwd: workspacePath, signal: args.signal });
    try {
      await runCommand("git", ["fetch", "--quiet", "--depth=1", "--no-tags", "origin", args.input.repository.commit], { cwd: workspacePath, signal: args.signal });
      await runCommand("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
        cwd: workspacePath,
        signal: args.signal,
        env: { GIT_LFS_SKIP_SMUDGE: "1" },
      });
    } finally {
      await runCommand("git", ["remote", "remove", "origin"], { cwd: workspacePath, signal: new AbortController().signal }).catch(() => {});
    }
    const resolved = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: workspacePath, signal: args.signal })).stdout.trim().toLowerCase();
    if (resolved !== args.input.repository.commit) throw new Error(`checked out ${resolved}, expected ${args.input.repository.commit}`);
    args.report("workspace.ready", { commit: resolved, lfsHydration: "skipped" });
    return { workspacePath, artifactDirectory };
  }

  async execute(args: Parameters<ValidationRunDriver["execute"]>[0]): Promise<ValidationRunResult> {
    if (process.env.VALIDATION_CLOUD_SANDBOX !== "1") {
      throw new Error("VCoder validation execution is disabled outside an explicitly isolated sandbox");
    }
    const runtime = new VcoderCoreRuntimeImpl(args.prepared.workspacePath);
    const sessionId = `validation_${randomUUID()}`;
    let summary = "";
    let deliveredViaMessage = false;
    let inputTokens = 0;
    let outputTokens = 0;
    const approvedTestCommands = new Map<string, string>();
    const testResults: ValidationTestResult[] = [];
    const executeStartedAt = Date.now();
    const sessionCompletion = Promise.withResolvers<void>();
    // A provider can fail and emit session_complete before sendMessage()
    // settles. Attach a rejection observer immediately so Node does not treat
    // that short window as an unhandled rejection; the original promise is
    // still awaited below and preserves the failure for the runner boundary.
    void sessionCompletion.promise.catch(() => {});
    const subscription = runtime.on("event", (event: RuntimeEvent) => {
      if (event.sessionId !== sessionId) return;
      if (event.type === "text_delta") {
        if (!deliveredViaMessage) summary += event.text;
        return;
      }
      if (event.type === "user_message") {
        summary = event.message;
        deliveredViaMessage = true;
        return;
      }
      if (event.type === "token_usage") {
        inputTokens += event.usage.inputTokens;
        outputTokens += event.usage.outputTokens;
        args.report("run.usage_updated", { inputTokens, outputTokens });
        return;
      }
      if (event.type === "tool_use") {
        args.report("run.tool_changed", { toolCallId: event.toolCall.id, toolName: event.toolCall.name, status: event.toolCall.status });
        if (isPreapprovedValidationPermission(event.toolCall.name, event.toolCall.input, args.input.allowedOperations)) {
          approvedTestCommands.set(event.toolCall.id, String(event.toolCall.input.command).trim());
        }
        return;
      }
      if (event.type === "tool_result") {
        args.report("run.tool_changed", { toolCallId: event.toolResult.id, status: event.toolResult.isError === true ? "failed" : "completed" });
        const command = approvedTestCommands.get(event.toolResult.id);
        if (command != null) {
          approvedTestCommands.delete(event.toolResult.id);
          testResults.push({
            command,
            status: event.toolResult.isError === true ? "failed" : "passed",
            exitCode: event.toolResult.isError === true ? "unknown" : 0,
            output: toolResultText(event.toolResult.content),
          });
        }
        return;
      }
      if (event.type === "permission_request") {
        const testAllowed = isPreapprovedValidationPermission(event.request.toolName, event.request.toolInput, args.input.allowedOperations);
        const allowed = ["SendUserMessage", "Brief"].includes(event.request.toolName) || testAllowed;
        runtime.resolvePermission(sessionId, event.request.id, { approved: allowed, ...(!allowed ? { reason: "The validation task did not pre-authorize this capability." } : {}) });
        return;
      }
      if (event.type === "session_complete") {
        if (["cancelled", "error", "timeout", "blocking"].includes(event.reason)) {
          sessionCompletion.reject(new Error(event.message ?? event.error?.message ?? `VCoder runtime session ended: ${event.reason}`));
        } else {
          sessionCompletion.resolve();
        }
      }
    });
    const abort = () => { void runtime.cancel(sessionId); };
    args.signal.addEventListener("abort", abort, { once: true });
    try {
      await runtime.startSession({
        sessionId,
        workingDirectory: args.prepared.workspacePath,
        settings: {
          permissionMode: "acceptEdits",
          maxTurns: args.input.limits.maxTurns,
          appendSystemPrompt: "This is a non-interactive validation run. Do not ask the user questions; report a blocker in the final answer instead.",
        },
      });
      await runtime.sendMessage(sessionId, { content: validationPrompt(args.input) });
      await sessionCompletion.promise;
      if (args.signal.aborted) throw args.signal.reason ?? new Error("validation run aborted");
    } finally {
      args.signal.removeEventListener("abort", abort);
      subscription.dispose();
      await runtime.shutdown();
    }

    const { files, patch } = await collectGitDelivery(args.prepared.workspacePath, args.signal);
    const normalizedSummary = summary.trim() || "VCoder completed without a textual delivery summary.";
    const summaryDocument = [
      "# Validation delivery",
      "",
      `Task: ${args.taskId}`,
      `Run: ${args.runId}`,
      `Input commit: ${args.input.repository.commit}`,
      "",
      normalizedSummary,
      "",
      "## Evidence limitation",
      "",
      "Independent post-run test commands are not configured yet. Test claims above come from the VCoder run and must be checked against tool events or rerun manually.",
      "",
    ].join("\n");
    const usage = JSON.stringify({
      inputTokens,
      outputTokens,
      modelRequests: "unknown",
      durationMs: Date.now() - executeStartedAt,
      provider: process.env.VALIDATION_VCODER_PROVIDER?.trim() || "unknown",
      model: process.env.VALIDATION_VCODER_MODEL?.trim() || "unknown",
    }, null, 2) + "\n";
    const filesJson = JSON.stringify(files, null, 2) + "\n";
    const testsJson = JSON.stringify(testResults.length === 0
      ? { status: "unknown", reason: "no preapproved validation test command completed" }
      : { status: testResults.every((result) => result.status === "passed") ? "passed" : "failed", commands: testResults.map(({ output: _output, ...result }) => result) }, null, 2) + "\n";
    const testOutput = testResults.length === 0
      ? "No preapproved validation test command completed.\n"
      : testResults.map((result) => `$ ${result.command}\n${result.output}${result.output.endsWith("\n") || result.output.length === 0 ? "" : "\n"}[status=${result.status} exitCode=${result.exitCode}]\n`).join("\n");
    for (const value of [summaryDocument, patch, filesJson, usage, testsJson, testOutput]) assertNoInjectedSecret(value);

    await Promise.all([
      writeFile(join(args.prepared.artifactDirectory, "summary.md"), summaryDocument),
      writeFile(join(args.prepared.artifactDirectory, "changes.patch"), patch),
      writeFile(join(args.prepared.artifactDirectory, "files.json"), filesJson),
      writeFile(join(args.prepared.artifactDirectory, "tests.json"), testsJson),
      writeFile(join(args.prepared.artifactDirectory, "test-output.txt"), testOutput),
      writeFile(join(args.prepared.artifactDirectory, "usage.json"), usage),
    ]);
    return {
      summary: normalizedSummary.slice(0, 4_000),
      artifacts: [
        artifact("summary", this.artifactsRoot, args.prepared.artifactDirectory, "summary.md"),
        artifact("patch", this.artifactsRoot, args.prepared.artifactDirectory, "changes.patch"),
        artifact("files", this.artifactsRoot, args.prepared.artifactDirectory, "files.json"),
        artifact("tests", this.artifactsRoot, args.prepared.artifactDirectory, "tests.json"),
        artifact("test_output", this.artifactsRoot, args.prepared.artifactDirectory, "test-output.txt"),
        artifact("usage", this.artifactsRoot, args.prepared.artifactDirectory, "usage.json"),
      ],
    };
  }
}
