import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface LocalInferenceCliStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly executablePath: string | null;
}

function firstExecutable(candidates: readonly (string | undefined)[]): string | null {
  for (const candidate of candidates) if (candidate != null && candidate.length > 0 && existsSync(candidate)) return candidate;
  return null;
}

function pathCandidates(name: string): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, name));
}

export function resolveCodexCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.CODEX_PATH, join(home, ".local", "bin", "codex"), join(home, ".codex", "bin", "codex"), ...pathCandidates("codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
}

export function resolveClaudeCodeCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.CLAUDE_CODE_PATH, join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), ...pathCandidates("claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
}

export function resolveVCoderCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.SAND_VCODER_CLI_PATH, process.env.VCODER_CLI_PATH, join(home, ".local", "bin", "vcoder"), ...pathCandidates("vcoder"), "/opt/homebrew/bin/vcoder", "/usr/local/bin/vcoder"]);
}

// The local Docker connector stages the Linux CLI content-addressed under
// ~/.grokbot/local-docker-runtime/vcoder-<sha>/vcoder-cli.
function resolveVCoderBoxCliPath(home: string): string | null {
  const fromEnv = process.env.SAND_VCODER_BOX_CLI_PATH?.trim();
  if (fromEnv != null && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv;
  const runtimeRoot = join(home, ".grokbot", "local-docker-runtime");
  try {
    for (const entry of readdirSync(runtimeRoot)) {
      if (!entry.startsWith("vcoder-")) continue;
      const candidate = join(runtimeRoot, entry, "vcoder-cli");
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export function readVCoderSettingsEnv(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), ".vcoder", "settings.json"), "utf8")) as Record<string, any>;
    const env = parsed?.env;
    if (typeof env !== "object" || env == null || Array.isArray(env)) return {};
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0));
  } catch { return {}; }
}

function hasUsableCodexLogin(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    return parsed.auth_mode === "chatgpt"
      && typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.length > 0
      && typeof parsed.tokens?.refresh_token === "string" && parsed.tokens.refresh_token.length > 0
      && typeof parsed.tokens?.id_token === "string" && parsed.tokens.id_token.length > 0
      && typeof parsed.tokens?.account_id === "string" && parsed.tokens.account_id.length > 0;
  } catch { return false; }
}

export function getLocalInferenceCliStatus(options?: { readonly boxRuntime?: string }): { readonly codex: LocalInferenceCliStatus; readonly "claude-code": LocalInferenceCliStatus; readonly vcoder: LocalInferenceCliStatus } {
  const home = homedir();
  const codexPath = resolveCodexCliPath();
  const claudePath = resolveClaudeCodeCliPath();
  const vcoderPath = resolveVCoderCliPath();
  // With the local Docker VM, VCoder turns run inside the box using the staged
  // Linux binary, so a desktop-side install is not required.
  const vcoderBoxPath = options?.boxRuntime === "local-docker" ? resolveVCoderBoxCliPath(home) : null;
  const codexAuthPath = join(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "auth.json");
  const hasCodexAuthFile = existsSync(codexAuthPath);
  const hasCodexLogin = hasUsableCodexLogin(codexAuthPath);
  return {
    // Codex inference is a Grok Bot-owned HTTP transport authenticated by the
    // existing Codex login. The CLI binary is not in the request path.
    codex: { installed: hasCodexAuthFile, authenticated: hasCodexLogin, executablePath: codexPath },
    "claude-code": { installed: claudePath != null, authenticated: existsSync(join(home, ".claude", ".credentials.json")) || (process.env.ANTHROPIC_API_KEY?.length ?? 0) > 0, executablePath: claudePath },
    // VCoder's print/SDK mode does not load the settings.json env block, so any
    // credential stored there counts as configured and is injected at spawn time.
    vcoder: { installed: vcoderPath != null || vcoderBoxPath != null, authenticated: Object.keys(readVCoderSettingsEnv()).length > 0, executablePath: vcoderPath ?? vcoderBoxPath },
  };
}
