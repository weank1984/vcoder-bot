export function formatValidationArtifact(kind: string, value: Record<string, unknown>): string {
  if (kind === "tests") {
    const labels: Record<string, string> = { passed: "通过", failed: "失败", unknown: "未验证" };
    const lines = [`测试结论：${labels[String(value.status)] ?? String(value.status)}`];
    if (value.reason) lines.push(`说明：${value.reason}`);
    if (Array.isArray(value.commands)) {
      for (const command of value.commands) {
        lines.push(`命令：${command.command}`, `结果：${labels[command.status] ?? command.status}；退出码：${command.exitCode ?? "未知"}`);
      }
    }
    return lines.join("\n");
  }
  if (kind === "usage") {
    return [
      `服务商：${value.provider ?? "未知"}`, `模型：${value.model ?? "未知"}`,
      `输入 token：${value.inputTokens ?? "未知"}`, `输出 token：${value.outputTokens ?? "未知"}`,
      `模型请求数：${value.modelRequests === "unknown" || value.modelRequests == null ? "未知" : value.modelRequests}`,
      `执行耗时：${typeof value.durationMs === "number" ? (value.durationMs / 1000).toFixed(1) + " 秒" : "未知"}`,
    ].join("\n");
  }
  return JSON.stringify(value, null, 2);
}
