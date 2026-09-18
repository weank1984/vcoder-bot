# 单机云验证部署

本目录只服务 10 天受控验证，不是生产部署方案。默认一台 Linux 主机、单 worker、SQLite WAL、本机持久盘和 Docker runner。

## 前提

- Linux amd64 主机，Docker 可用，Node.js 26.x 已安装。
- 域名已指向主机；只对公网开放 `443/tcp`，控制面端口 `8787` 仅监听 loopback。
- 创建无登录 shell 的 `vcoder-validation` 用户，并允许它访问 Docker socket。Docker 组等价于高权限；该主机不得混跑其他敏感工作负载。
- `/opt/vcoder-bot` 放置固定 commit 的代码，`/var/lib/vcoder-validation` 独占持久盘或目录。

## 构建

在 `/opt/vcoder-bot`：

```sh
npm ci
npm run check
npm run validation:build
npm run validation:build-runner-image
```

记录代码 commit、runner 镜像 ID、Node/Docker 版本和检查输出。镜像必须在目标 amd64 主机重新构建；本地 arm64 smoke 不能替代它。

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
