import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_PATCH_BYTES = 5 * 1024 * 1024;

export async function collectGitDelivery(workspace: string, signal: AbortSignal) {
  const git = async (args: string[], allowDifference = false) => {
    try {
      return (await exec("git", args, {
        cwd: workspace, signal, maxBuffer: MAX_PATCH_BYTES,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      })).stdout;
    } catch (error) {
      const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      if (allowDifference && result.code === 1 && typeof result.stdout === "string" && !result.stderr) {
        return result.stdout;
      }
      throw error;
    }
  };
  const entries = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0");
  const files: Array<{ status: string; path: string; originalPath?: string }> = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (/[RC]/.test(status)) {
      files.push({ status, path, originalPath: entries[++index]! });
    } else {
      files.push({ status, path });
    }
  }
  let patch = await git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]);
  for (const file of files) {
    if (file.status !== "??") continue;
    const addition = await git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-index", "--", "/dev/null", file.path], true);
    if (Buffer.byteLength(patch) + Buffer.byteLength(addition) > MAX_PATCH_BYTES) {
      throw new Error("combined delivery patch exceeds 5 MiB");
    }
    patch += addition;
  }
  return { files, patch };
}
