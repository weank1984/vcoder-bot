import { createHash } from "node:crypto";
import { readSecret, writeSecret, isEncryptedStorageAvailable } from "./secrets/secret-store.js";

const CONFIG_KEY = "vbot-background-service-v1";
type RecordValue = Record<string, any>;
function record(value: unknown): RecordValue {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的后台任务请求");
  return value as RecordValue;
}
export function normalizeBackgroundServiceUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("请填写后台服务地址");
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("远程服务必须使用 HTTPS；本机可使用 HTTP");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("请填写不含凭据、路径或参数的服务地址");
  return url.origin;
}
async function limitedBody(response: Response, max = 10 * 1024 * 1024): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > max) throw new Error("服务响应超过大小上限");
      parts.push(result.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts);
}

export function createBackgroundTaskClient(deps = {
  read: () => readSecret(CONFIG_KEY),
  write: (value: string) => writeSecret(CONFIG_KEY, value),
  persistent: isEncryptedStorageAvailable,
  fetch: globalThis.fetch,
}) {
  const readConfig = async () => {
    const raw = await deps.read();
    if (!raw) return null;
    const parsed = record(JSON.parse(raw));
    return { url: normalizeBackgroundServiceUrl(parsed.url), token: String(parsed.token) };
  };
  const publicConfig = (config: { url: string } | null) => ({
    configured: config != null, url: config?.url ?? "http://127.0.0.1:18791", persistent: deps.persistent(),
    local: config == null || ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.url).hostname),
  });
  const request = async (config: { url: string; token: string }, path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await deps.fetch(config.url + path, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error("无法连接后台服务，请检查服务地址和网络。提交重试将复用原请求 ID。"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 ? "访问令牌无效，请重新配置" : `后台服务请求失败（${response.status}）`);
    }
    return limitedBody(response);
  };
  const json = async (config: { url: string; token: string }, path: string, body?: unknown) => {
    const bytes = await request(config, path, body);
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("后台服务返回了无效的数据，请检查服务版本"); }
  };
  const identifier = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,150}$/.test(value)) throw new Error("无效的任务或交付物 ID");
    return value;
  };
  return async (input: unknown) => {
    const args = record(input);
    if (args.action === "config") return publicConfig(await readConfig());
    if (args.action === "configure") {
      const url = normalizeBackgroundServiceUrl(args.url);
      if (typeof args.token !== "string" || args.token.trim().length < 24 || args.token.length > 4096 || /[\r\n]/.test(args.token)) throw new Error("请填写有效的服务访问令牌（不是模型 API 密钥）");
      const config = { url, token: args.token.trim() };
      const health = await json(config, "/health");
      if (health.service !== "vcoder-validation-cloud") throw new Error("该地址不是兼容的任务服务");
      await json(config, "/api/tasks?limit=1");
      await deps.write(JSON.stringify(config));
      return publicConfig(config);
    }
    const config = await readConfig();
    if (!config) throw new Error("请先连接后台任务服务");
    if (args.serviceUrl !== undefined && args.serviceUrl !== config.url) throw new Error("服务连接已变更，请刷新任务面板后重试");
    if (args.action === "list") return json(config, "/api/tasks?limit=100");
    if (args.action === "submit") return json(config, "/api/tasks", record(args.input));
    if (args.action === "detail") return json(config, `/api/tasks/${identifier(args.taskId)}`);
    if (args.action === "stop") return json(config, `/api/tasks/${identifier(args.taskId)}/stop`, {});
    if (args.action === "artifact") {
      const detail = await json(config, `/api/tasks/${identifier(args.taskId)}`);
      const artifactId = identifier(args.artifactId);
      const artifact = detail.artifacts.find((item: RecordValue) => item.artifactId === artifactId);
      if (!artifact) throw new Error("该交付物不属于此任务");
      const bytes = await request(config, `/api/artifacts/${artifactId}/download`);
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("交付物校验失败，请重新获取");
      return { text: bytes.toString("utf8"), base64: bytes.toString("base64"), filename: String(artifact.relativePath).split(/[\\/]/).pop() };
    }
    throw new Error("不支持的后台任务操作");
  };
}

export const backgroundTaskRequest = createBackgroundTaskClient();
