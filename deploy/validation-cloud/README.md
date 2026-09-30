# 单机云验证部署

本目录只服务 10 天受控验证，不是生产部署方案。默认一台 Linux 主机、单 worker、SQLite WAL、本机持久盘和 Docker runner。

## 前提

- Linux amd64 主机，Docker 可用，Node.js 26.x 已安装。
- 域名已指向主机；只对公网开放 `443/tcp`，控制面端口 `8787` 仅监听 loopback。
- 创建无登录 shell 的 `vcoder-validation` 用户，并允许它访问 Docker socket。Docker 组等价于高权限；该主机不得混跑其他敏感工作负载。
- `/opt/vcoder-bot` 放置固定 commit 的代码，`/var/lib/vcoder-validation` 独占持久盘或目录。

## 构建与发布身份

每次部署都必须从固定 commit 生成，并保存以下非敏感身份信息：代码 commit、Node/npm/Docker 版本、`build-manifest.json` 中的 bundle SHA-256，以及 runner 镜像的 immutable digest。不要只记录 `:dev` 标签。

在 `/opt/vcoder-bot`：

```sh
npm ci --no-audit --no-fund
npm run check
npm run validation:build
npm run validation:build-runner-image

docker image inspect vcoder-validation-runner:dev --format '{{index .RepoDigests 0}}'
```

镜像必须在目标 amd64 主机重新构建；本地 arm64 smoke 不能替代它。构建完成后，将 `.build/validation-cloud/` 作为当前发布目录的一部分保留，至少包含 `server.cjs`、`runner.cjs`、source maps 和 `build-manifest.json`。发布目录不得包含 env 文件、SQLite、workspace 或 artifacts。

部署前，将两个 env 文件放到目标主机并执行：

```sh
node scripts/check-validation-deployment.mjs \
  --control-env /etc/vcoder-validation/control.env \
  --runner-env /etc/vcoder-validation/runner.env
```

该检查会 fail-closed 验证 `0600` 普通文件、loopback 绑定、`vcoder-docker` executor、非占位 provider 和 bundle manifest；它不会打印令牌或模型凭据。

建议将发布目录按 commit 保存，例如 `/opt/vcoder-bot-releases/<commit>/`，再让 `/opt/vcoder-bot` 指向当前发布目录。切换前停止服务或使用原子 symlink 替换；保留至少一个上一版本，回滚时只切回上一版本并重启服务，不删除 `/var/lib/vcoder-validation`。

回滚条件包括 bundle manifest 校验失败、runner digest 不匹配、health 检查失败、首条 B01 违反验收条件或发现越权副作用。回滚后保留事件和产物用于调查，并撤销本次专用凭据。

## 配置

1. 将 `control.env.example` 复制到 `/etc/vcoder-validation/control.env`，生成独立高熵访问令牌。
2. 将 `runner.env.example` 复制到 `/etc/vcoder-validation/runner.env`，只放验证专用、限额、可撤销的模型凭据。
3. 两个文件均归 `vcoder-validation:vcoder-validation`，权限 `0600`；不要放入仓库、数据目录、shell history 或聊天。
4. 根据实际 provider 改名凭据变量；`VALIDATION_VCODER_PROVIDER` 必须与 VCoder 支持的 provider 名称一致。
5. 将 service 文件安装到 `/etc/systemd/system/vcoder-validation.service`。安装 Caddy 或等价 TLS 代理，并替换 `Caddyfile.example` 中的域名。

## 启动门槛

启动前逐项确认：

- `VALIDATION_CLOUD_HOST=127.0.0.1`，公网不能绕过 TLS 代理直连控制面。
- `VALIDATION_CLOUD_EXECUTOR=vcoder-docker`，不得把 `fixture-docker` 用于真实任务。
- runner env 是普通文件、非软链且权限 `0600`。
- 防火墙只开放 SSH 的受控来源和 HTTPS；Docker API 不监听 TCP。
- 仓库白名单只包含试点需要的精确域名。
- 试点仓库不含生产秘密；模型凭据达到预算或速率上限后会自动拒绝。

然后执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now vcoder-validation
curl -fsS http://127.0.0.1:8787/health
```

从外部设备访问 HTTPS 地址，确认 HTTP 端口不可达、无令牌 API 返回 `401`、正确令牌可以读取空任务列表。

## 首条任务与回退

先执行 [VALIDATION-TASKSET.md](../../docs/VALIDATION-TASKSET.md) 的 B01，不直接开放给试用者。保存任务详情、`events.jsonl`、全部产物、镜像 ID和主机资源数据。

若发现密钥泄漏、未授权网络访问、宿主目录可见、停止失效或产物错配，立即：

1. 停止服务并终止所有 `vcoder-validation-*` 容器。
2. 撤销 runner 专用模型凭据和仓库凭据。
3. 保留脱敏事件与系统时间线，不把可能含密钥的原始产物复制到其他位置。
4. 在原因修复并重新通过安全演练前，不恢复试用。

SQLite 与 artifacts 的备份、7 天删除任务和磁盘配额尚未自动化。验证期间每日检查磁盘，结束后按批准的保留决策人工清理。
