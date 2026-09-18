import { join, resolve } from "node:path";
import { lstatSync } from "node:fs";

import { createValidationCloudHttpServer } from "./http-server.js";
import { statValidationArtifact } from "./artifacts.js";
import { DockerVCoderValidationDriver } from "./docker-vcoder-driver.js";
import { ValidationTaskStore } from "./task-store.js";
import { VCoderValidationDriver } from "./vcoder-driver.js";
import { ValidationTaskWorker } from "./worker.js";

function positivePort(value: string | undefined): number {
  const parsed = Number(value ?? "8787");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("VALIDATION_CLOUD_PORT must be a valid TCP port");
  return parsed;
}

function repositoryHosts(value: string | undefined): string[] {
  const hosts = (value ?? "github.com").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.length === 0 || hosts.some((host) => !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith("."))) {
    throw new Error("VALIDATION_CLOUD_REPOSITORY_HOSTS must be a comma-separated list of exact DNS hostnames");
  }
  return [...new Set(hosts)];
}

const accessToken = process.env.VALIDATION_CLOUD_TOKEN?.trim();
if (accessToken == null || accessToken.length < 24) {
  throw new Error("Set VALIDATION_CLOUD_TOKEN to a high-entropy value containing at least 24 characters");
}

const dataDir = resolve(process.env.VALIDATION_CLOUD_DATA_DIR?.trim() || ".validation-cloud");
const host = process.env.VALIDATION_CLOUD_HOST?.trim() || "127.0.0.1";
const port = positivePort(process.env.VALIDATION_CLOUD_PORT);
const allowedRepositoryHosts = repositoryHosts(process.env.VALIDATION_CLOUD_REPOSITORY_HOSTS);
const store = new ValidationTaskStore(join(dataDir, "validation.sqlite"));
const recovered = store.recoverInterruptedTasks();
if (recovered.length > 0) process.stderr.write(`marked ${recovered.length} active validation task(s) as interrupted after restart\n`);

const executor = process.env.VALIDATION_CLOUD_EXECUTOR?.trim() || "disabled";
if (!new Set(["disabled", "vcoder-docker", "vcoder-in-process", "fixture-docker"]).has(executor)) {
  throw new Error("VALIDATION_CLOUD_EXECUTOR must be disabled, vcoder-docker, vcoder-in-process, or fixture-docker");
}
const runnerEnvFile = process.env.VALIDATION_CLOUD_RUNNER_ENV_FILE?.trim();
if (executor === "vcoder-docker" && !runnerEnvFile) {
  throw new Error("VALIDATION_CLOUD_RUNNER_ENV_FILE is required for vcoder-docker execution");
}
if (executor === "vcoder-docker") {
  const runnerEnvStat = lstatSync(runnerEnvFile!);
  if (!runnerEnvStat.isFile() || runnerEnvStat.isSymbolicLink()) {
    throw new Error("VALIDATION_CLOUD_RUNNER_ENV_FILE must be a regular file, not a symbolic link");
  }
  if ((runnerEnvStat.mode & 0o077) !== 0) {
    throw new Error("VALIDATION_CLOUD_RUNNER_ENV_FILE must not be accessible by group or other users (chmod 600)");
  }
}
const fixtureScenario = process.env.VALIDATION_CLOUD_FIXTURE_SCENARIO?.trim();
if (executor === "fixture-docker") {
  if (process.env.VALIDATION_CLOUD_ENABLE_FIXTURE !== "1") {
    throw new Error("fixture-docker requires VALIDATION_CLOUD_ENABLE_FIXTURE=1");
  }
  if (fixtureScenario !== "success" && fixtureScenario !== "partial-wait") {
    throw new Error("VALIDATION_CLOUD_FIXTURE_SCENARIO must be success or partial-wait");
  }
}
const driver = executor === "vcoder-docker"
  ? new DockerVCoderValidationDriver(dataDir, {
      runnerImage: process.env.VALIDATION_CLOUD_RUNNER_IMAGE?.trim() || "vcoder-validation-runner:dev",
      runnerEnvFile: runnerEnvFile!,
      allowedRepositoryHosts,
    })
  : executor === "fixture-docker"
    ? new DockerVCoderValidationDriver(dataDir, {
        runnerImage: process.env.VALIDATION_CLOUD_RUNNER_IMAGE?.trim() || "vcoder-validation-runner:dev",
        runnerFixtureScenario: fixtureScenario as "success" | "partial-wait",
        allowedRepositoryHosts,
      })
  : executor === "vcoder-in-process"
    ? new VCoderValidationDriver(dataDir, { allowedRepositoryHosts })
    : undefined;
const worker = driver == null
  ? undefined
  : new ValidationTaskWorker({
      store,
      driver,
      statArtifact: statValidationArtifact,
      onError: (error) => process.stderr.write(`validation worker error: ${String(error)}\n`),
    });
const server = createValidationCloudHttpServer({
  store,
  accessToken,
  artifactsRoot: join(dataDir, "artifacts"),
  repositoryHosts: allowedRepositoryHosts,
  ...(worker == null ? {} : {
    onTaskAccepted: () => worker.wake(),
    onStopRequested: (taskId: string) => worker.requestStop(taskId),
  }),
});
server.listen(port, host, () => {
  process.stdout.write(`VCoder validation cloud listening on http://${host}:${port}\n`);
  if (worker == null) process.stdout.write("Validation worker is disabled; accepted tasks will remain queued.\n");
  else worker.start();
});

function shutdown(): void {
  server.close(() => {
    void (async () => {
      await worker?.dispose();
      store.close();
      process.exit(0);
    })();
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
