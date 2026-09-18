# 验证服务运行手册

> 对应目标：[VALIDATION-SPRINT.md](VALIDATION-SPRINT.md)  
> 当前阶段：本机 Docker + DeepSeek 的 B01 模型闭环与交付已验证；Linux 云主机和跨设备试用尚待执行。

Linux 云主机安装模板和启动门槛见 [deploy/validation-cloud/README.md](../deploy/validation-cloud/README.md)。

## B01 独立验收

任务结束后运行以下命令，任何断言失败都会返回非零退出码。可选最后一个参数是本机 `0600` 凭据文件路径，用于扫描注入密钥；脚本不会打印密钥。

```sh
node scripts/verify-validation-b01.mjs \
  /path/to/run/workspace /path/to/run/artifacts \
  5e2bc4e535b93e5ca792606c62d266c732fb8adc \
  /secure/vcoder-validation-runner.env
```

脚本检查固定文本、唯一修改文件、结构化测试结果、Git remote、补丁在干净仓库的实际还原及产物哈希。无网络出口审计，因此“没有 remote”不等价于已证明没有任何远程副作用。

## 本地启动

需要 Node.js 26.5.x。访问令牌只用于受控单用户验证，至少 24 个字符；不要提交到仓库或放入 URL。

```sh
npm run validation:build
VALIDATION_CLOUD_TOKEN='<高熵令牌>' npm run validation:start
```

默认监听 `127.0.0.1:8787`，数据保存在 `.validation-cloud/`。浏览器打开 `http://127.0.0.1:8787`，令牌仅保存在当前标签页的 `sessionStorage`。

可配置项：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `VALIDATION_CLOUD_TOKEN` | 无，必须提供 | API Bearer 访问令牌 |
| `VALIDATION_CLOUD_HOST` | `127.0.0.1` | 监听地址；外部访问时应由 TLS 反向代理保护 |
| `VALIDATION_CLOUD_PORT` | `8787` | HTTP 端口 |
| `VALIDATION_CLOUD_DATA_DIR` | `.validation-cloud` | SQLite、workspace 和产物根目录 |
| `VALIDATION_CLOUD_REPOSITORY_HOSTS` | `github.com` | 允许 clone 的精确 DNS 主机名，多个值用逗号分隔；API 和 worker 双重校验 |
| `VALIDATION_CLOUD_EXECUTOR` | `disabled` | `disabled`、`vcoder-docker`、仅限开发的 `vcoder-in-process`，或仅限基础设施演练的 `fixture-docker` |
| `VALIDATION_CLOUD_RUNNER_IMAGE` | `vcoder-validation-runner:dev` | Docker runner 镜像 |
| `VALIDATION_CLOUD_RUNNER_ENV_FILE` | 无 | Docker runner 的专用模型配置和凭据文件；必须是非软链普通文件且权限为 `0600` |

当前不要直接把服务裸露到公网。跨设备验证应在云主机前配置 HTTPS 反向代理、防火墙和单一试点来源限制。

真实验证使用 `vcoder-docker`。每个 Run 在独立容器中执行，容器使用只读根文件系统、非 root 用户、CPU/内存/PID 上限、移除 Linux capabilities，并且只挂载该 Run 的 workspace、input 和 artifacts。控制面令牌、SQLite 和其他任务目录不会传入容器。

先构建 runner 镜像：

```sh
npm run validation:build
npm run validation:build-runner-image
```

在数据目录之外创建专用凭据文件，例如 `/secure/vcoder-validation-runner.env`，权限设为 `0600`：

```text
VALIDATION_VCODER_PROVIDER=<settings.json 中已有的 provider 名称>
VALIDATION_VCODER_MODEL=<可选；不填则使用 provider 默认模型>
<该 provider 所需的专用低价值凭据环境变量>=...
```

随后启动服务：

```sh
VALIDATION_CLOUD_TOKEN='<高熵令牌>' \
VALIDATION_CLOUD_EXECUTOR=vcoder-docker \
VALIDATION_CLOUD_RUNNER_ENV_FILE=/secure/vcoder-validation-runner.env \
npm run validation:start
```

`vcoder-in-process` 只用于开发自有 fixture；它与控制面共享进程和文件系统，不能用于试点。Docker runner 已隔离控制面，但模型凭据仍会存在于任务容器环境中，因此验证期必须使用可独立撤销、限额且不复用的低价值凭据。正式化阶段应改为模型代理，使任务容器拿不到上游凭据。当前还没有容器级网络域名白名单，不应运行陌生第三方仓库。

`fixture-docker` 只验证控制面和容器基础设施，必须同时设置 `VALIDATION_CLOUD_ENABLE_FIXTURE=1` 以及 `VALIDATION_CLOUD_FIXTURE_SCENARIO=success` 或 `partial-wait`。它不调用模型，页面和交付摘要会明确标记 fixture；任何结果都不得计入 VCoder 质量或成功率。

## API 契约

除 `/` 和 `/health` 外，所有接口需要：

```text
Authorization: Bearer <VALIDATION_CLOUD_TOKEN>
```

### 接收任务

`POST /api/tasks`

```json
{
  "requestId": "客户端生成并在重试时复用的 UUID",
  "repository": {
    "url": "https://github.com/example/project.git",
    "commit": "40 位完整 commit SHA",
    "branch": "可选展示字段"
  },
  "goal": "有限、可验收的变更目标",
  "acceptanceCriteria": ["验收条件一", "验收条件二"],
  "limits": {
    "wallClockMinutes": 30,
    "maxTurns": 16
  }
}
```

相同 `requestId` 和相同规范化 payload 返回原任务；相同 `requestId` 配合不同 payload 返回 `409`，避免提交响应丢失后创建重复任务。

### 查询和停止

- `GET /api/tasks`：最近任务。
- `GET /api/tasks/:taskId`：任务快照和有序事件。
- `POST /api/tasks/:taskId/stop`：记录停止请求。尚未开始的任务直接取消；活跃任务先进入 `stopping`。
- `GET /api/tasks/:taskId/events.jsonl`：下载该任务当前的脱敏事件快照，供离线分析。

## 当前恢复语义

- `accepted` 任务在服务重启后仍保持待执行。
- `preparing`、`running`、`stopping` 任务在启动时变为 `interrupted`，并记录 `run.interrupted`。
- 已交付、失败、取消或中断的任务不会被旧事件重新打开。
- 当前没有自动重试；后续重试必须创建新 Run，并保留前一次记录。

## 验证命令

```sh
npm run source:typecheck
node --test tests/validation-cloud-control-plane.test.mjs
npm run validation:build
```

HTTP 契约测试需要绑定本机 loopback 端口；受限沙箱内运行时可能需要相应授权。
