# Cursor 完整技术方案（供 VCoder 替换用）

> 本文档基于对 `vcoder-bot`（Grok Bot 0.18.0 逆向重建项目）的只读代码调查整理而成，
> 目的是让后续开发者无需再回头研究 Cursor 专有协议代码，即可设计 VCoder 完整替换
> Cursor 作为推理后端的适配层。

## 1. 认证与会话

- **登录/token 刷新**：`source/electron-main/account/cursor-auth.ts`；深链回调注册在
  `source/electron-main/auth/auth-callback-registration.ts`
- **token 格式/校验**：`source/shared/node/cursor-token.ts`
- **请求侧认证头/checksum 拦截器**：`source/shared/node/cursor-backend/cursor-inference.ts:34-159`
  ——每次请求附带 access token + checksum header，身份和防重放绑定在这一层

## 2. 推理请求协议

Cursor 走的是 **ConnectRPC + Protobuf 流式协议**，不是 coordinator 的 HTTP+SSE 通道
（那是给远程网关/其他 provider 用的）：

- proto 消息定义：`source/packages/proto/generated/aiserver/v1/inference_pb.ts`
- RPC service 定义：`inference_connect.ts`
- 客户端组装/解析：`source/packages/chat-inference-proto/client.ts`
  （`ProtoPromptExecutor.stream()`，出站在 169-180 行，入站在 211-322 行）
- 出站转换（内部通用消息 → proto）：`converters.ts` 的
  `coreMessageToProto`/`agentToolToProto`/`buildStreamRequest`
- 入站转换（proto 流 → 内部 chunk）：把 proto oneof 分支映射回 AI SDK 风格的
  `text-delta/reasoning/tool-call/finish` chunk，外加
  `usage/extendedUsage/providerMetadata/invocationId/response` 四个旁路 Promise

**关键认知**：内部"通用对话格式"其实就是 Vercel AI SDK 的 `CoreMessage`/流式 chunk
协议。Cursor 只是把这套通用格式在两端各做一次 proto 编解码；其他 provider
（claude-code/codex/openrouter）直接用各自 SDK 消费同一份通用消息，无需 proto 转换。

## 3. 工具调用机制

- 工具通过 `agentToolToProto`/`namedProviderDefinedToolToProto` 转成 proto 格式随请求发出
- 模型返回 tool_call 后，在 `source/host/runner/sand-agent-runner.ts` 的 agent 循环里执行，
  工具注册总表在 `source/host/runner/tools/turn-toolset.ts`
- 与 MCP 工具路径是同一套工具 schema，只是 MCP 工具额外走
  `source/packages/agent/tools/mcp/*` 做聚合注入（细节见第 7 节）

## 4. Plugin 机制

- 加载器：`source/packages/cursor-plugins/loader.ts`；manifest schema：
  `manifest-parser.ts`；市场/远程安装：
  `{cursor-marketplace,backend-marketplace-client,tarball}.ts`
- Plugin **不是独立进程**，加载结果（skills/agents/commands/mcpConfig/hooks）直接合并
  进 host 的 agent 运行时上下文：skills→system prompt、agents→subagent、commands→slash
  命令表、mcpConfig→MCP client 配置、hooks→`CursorHooksConfig`
- **关键**：Plugin 机制与推理协议完全解耦，替换后端为 VCoder 时无需改动

## 5. 计费/用量上报

- 请求侧不显式携带计费字段，服务端按身份/model/conversationId 自行核算
- 响应侧两级用量：`InferenceUsageInfo`（基础 token 计数）与
  `InferenceExtendedUsageInfo`（含 cache read/write 细分，proto: `usage_pb.ts`）
- 本地账本：`source/shared/inference-router.ts` 定义
  `SAND_INFERENCE_PROVIDERS = ["cursor","claude-code","codex","openrouter","vcoder"]`，
  **`"vcoder"` 已是一等公民 provider key**，`SandSettingsStore.recordInferenceUsage()`
  （`sand-settings-store.ts:161`）按 provider 分桶持久化

## 6. Router 层适配点（最关键，决定 VCoder 如何接入）

**分流逻辑**（三处独立判断点，需同步处理）：
- `inference-service.ts`：`selectedProvider()` 读 `SAND_INFERENCE_PROVIDER` 环境变量或
  `SandSettingsStore`（默认 `"cursor"`），`createSession()` 里 `provider==="cursor"`
  走 proto 通道，否则走 `createProviderPromptSession(provider)`（`provider-session.ts:366`）
- `cursor-session.ts:114-115`、`cursor-inference.ts:189-190` 各自也有一次同样判断

**VCoder 接入建议**：
1. 不动 `chat-inference-proto/`（Cursor 专有，仅 `provider==="cursor"` 时触发）
2. 在 `provider-session.ts` 新增/完善 `"vcoder"` 分支（类型层已包含），参照
   `claude-code`（用 `@anthropic-ai/claude-agent-sdk` 的 `query()`）或 `openrouter`
   （`ai` 包 `streamText`）写法，接收内部 `CoreMessage[]`，返回
   `{fullStream, usage, extendedUsage, providerMetadata, invocationId, response}` 五件套
3. 复用 `recordRoutedUsage`（`provider-session.ts:39-41`）调用
   `recordInferenceUsage("vcoder",...)`，用量 UI 零改动
4. Plugin/MCP/工具执行层完全不用碰
5. 需注意能力降级：若 VCoder 后端模型不支持 Anthropic 专有字段
   （reasoning/redacted-reasoning 等），需在 provider-session 分支里做兼容处理

## 7. MCP Client Transport 细节

**双 transport 支持**，声明在配置层：`source/shared/node/mcp/mcp-display-runtime.ts:2`
```ts
type McpServerConfig = { url; type?: "sse"|"http"; headers? } | { command; args?; env? }
```
- 有 `command` 字段 → stdio 子进程；有 `url` 字段 → SSE 或 Streamable HTTP（`type` 区分）
- 判别函数 `getTransport()`（`mcp-validation.ts:3`）：
  `"command" in config ? "stdio" : type==="sse" ? "sse" : "http"`
- `tools-discovery.ts:471-476` 的 `resolveProviderTransport()` 运行时再判一次
  `"http"|"stdio"|"unknown"`，区分远程 provider 与 box 内 stdio provider
  (`isBoxStdioProvider`)
- Builtin MCP server（`builtin-mcp.ts:19,85`）固定 `type:"stdio"`

**消息格式**：并非裸 JSON-RPC，而是走 protobuf/Connect（`agent.v1` 命名空间）：
- 调用请求 `McpArgs`（`mcp_exec_pb.ts:14-33`）：`name, args(map<string,Value>),
  toolCallId, providerIdentifier, toolName, serverIdentifier, smartModeApproval,
  smartModeApprovalOnly, skipApproval`
- 调用结果 `McpResult`/`McpToolResult`（`mcp_tool_pb.ts`）：oneof
  `success|error|rejected|permissionDenied`，success 内含 `content[]`(text/image)、
  `isError`、`structuredContent`
- 发现相关有独立 `McpStateExecArgs`（`serverIdentifiers[]`, `kickOnly`）

**与 host `SandMcpManager`/`mcp-service.ts` 对接**
（`source/host/extensions/mcp/mcp-service.ts:151`）：暴露
`mcp.listTools/getTools/createExecutor/refreshAccountConfig/resolveToolTransport`
等接口给 extension 层；`listTools` 合并 `manager.listConnectedBackendTools()`
（远程已连接工具）与 `discovery.getTools(ctx)`（本地/box 发现）两路结果去重。真正调用
经 `SandMcpExecutor` → `mcpExecutorResource`。

**box 内实际执行**走 `box-mcp-exec.ts`：`BoxMcpExecPort.listTools/executeTool` 通过
`boxMcpResourceAccessor(box, ctx)` 拿到一个 Connect-RPC accessor，对 box 内运行的
exec-daemon 发 `McpStateExecArgs`/`McpArgs` 消息（非裸 stdio pipe，是走 gRPC/Connect
隧道）。`box-mcp.ts` 里的 `loadBoxMcpServersViaTransport()` 用同一 transport 把
`mcpConfigJson` 整体推送给 box 侧的 `loadMcpServers`（未实现时返回
`UNIMPLEMENTED`→`SandBoxMcpUnsupportedError`，用于旧镜像兼容检测）。

## 8. Box 内 Token/认证传递（本地 Docker 沙箱）

关键文件 `source/electron-main/box/local-docker-host-connector.ts`。**三种方式并用，
均是只读挂载 + 少量 env，无 TCP 传递 token**：

1. **推理凭据**（Cursor/Anthropic access token）：`persistInferenceCredential()`
   (L60-67) 把 `{accessToken, expiresAtMs}` 写入宿主机
   `local-docker-credential/inference.json`（`mode 0o600`），再以
   `--mount type=bind,...,dst=/run/grok-bot,readonly` 挂进容器，容器内通过 env
   `SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json` 找到该文件读取(L213)
2. **VCoder settings（含 provider API key 的 env block）**：
   `stageVCoderBoxSettings()`(L177-196) 把宿主机 `~/.vcoder/settings.json` 原样复制
   一份，`--mount ...dst=/root/.vcoder/settings.json,readonly` 挂进容器；容器内嵌入式
   `VcoderCoreRuntimeImpl` 用 `readVCoderSettingsEnv()` 读取（见注释 L165-169）
3. **Gateway 自身鉴权**：`readOrCreateToken()`(L70-79) 生成/复用一个 32-byte hex
   token，落盘到 `local-docker-vm.json`，通过 `--env SAND_GATEWAY_TOKEN=${token}`
   注入容器；host 侧 `gatewayReady()`(L86-93) 用 `Bearer ${token}` 访问容器暴露的
   `127.0.0.1:1340/health`，用于宿主机↔容器 gateway 通信鉴权（这是唯一走 env 注入
   token 的场景）
4. **第三方 CLI 认证目录**（`~/.codex`、`~/.claude`）：`localAuthMountArguments()`
   (L149-154) 只读 bind mount 整个目录进容器对应路径，复用宿主机已有登录态

容器变更时通过 label（`host-sha256`/`vcoder-settings-sha256`/`inference-provider`/
`schema-version`）做 staleness 校验，任一凭据或运行时内容变化即 `docker rm --force`
重建容器（L204-210），保证挂载文件与容器内容同步，而非依赖运行时热更新。

## 文件速查表

| 主题 | 文件 |
|---|---|
| 登录/token 刷新 | `source/electron-main/account/cursor-auth.ts` |
| 认证头/checksum 拦截器 | `source/shared/node/cursor-backend/cursor-inference.ts:34-159` |
| Cursor session 创建入口 | `source/host/extensions/inference/cursor-session.ts` |
| 多 provider 路由分发 | `source/host/extensions/inference/inference-service.ts` |
| 非 Cursor provider 实现 | `source/host/extensions/inference/provider-session.ts` |
| proto 请求/响应转换 | `source/packages/chat-inference-proto/{client.ts,converters.ts}` |
| proto 消息定义 | `source/packages/proto/generated/aiserver/v1/inference_pb.ts` |
| 用量 proto | `.../usage_pb.ts` |
| 本地用量账本 | `source/shared/inference-router.ts`, `sand-settings-store.ts` |
| 工具注册总表 | `source/host/runner/tools/turn-toolset.ts` |
| Agent 循环 | `source/host/runner/sand-agent-runner.ts` |
| Plugin 加载器 | `source/packages/cursor-plugins/loader.ts` |
| MCP server 配置类型 | `source/shared/node/mcp/mcp-display-runtime.ts` |
| MCP transport 判别 | `source/shared/node/mcp/mcp-validation.ts` |
| MCP 工具发现 | `source/host/extensions/mcp/tools-discovery.ts` |
| MCP host 管理器 | `source/host/extensions/mcp/mcp-service.ts` |
| Box 内 MCP 执行 | `source/host/box/box-mcp-exec.ts`, `box-mcp.ts` |
| Box token/凭据传递 | `source/electron-main/box/local-docker-host-connector.ts` |

## 结论

- Cursor 走 **ConnectRPC + Protobuf** 流式协议，内部统一格式基于 AI SDK 的
  `CoreMessage`；MCP 工具走另一套 protobuf（`agent.v1` 命名空间），支持 stdio 与
  HTTP/SSE 双 transport。
- 仓库里已存在多 provider 路由骨架（`inference-router.ts`、`provider-session.ts`），
  `"vcoder"` 是已声明但未完整实现的 provider 分支，本地用量账本、Plugin、MCP 执行层
  均已与推理协议解耦，无需为接入 VCoder 而改动。
- 接入 VCoder 的核心工作集中在 `provider-session.ts` 新增一个分支，以及在本地 Docker
  box 场景下沿用第 8 节的凭据挂载模式（`stageVCoderBoxSettings` 已经是为 VCoder 预留
  的机制）。
