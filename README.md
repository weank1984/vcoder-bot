# Grok Bot 0.18 — 重建与扩展版

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/weank1984/vcoder-bot/check.yml)

![Grok Bot 路由设置界面，已选中 Codex 并显示本地用量统计](docs/assets/router-settings.png)

本仓库是对公开发行的 Grok Bot 0.18.0 macOS 应用的**非官方、源码导向的逆向重建**。

项目最初只是为了理解这款桌面应用的构造方式。如今它已包含可读的 TypeScript 实现，覆盖 Electron 主进程、host、协调器(coordinator)、本地执行、协议和渲染层边界，并配有一套确定性(deterministic)工具链，能将这些源码重新构建为可运行的 macOS 应用。

此外还加入了一些实用性的实验特性：

- 面向 Cursor、Claude Code、Codex 和 OpenRouter 的推理路由器；
- 跨路由 provider 的 Grok Bot 插件/MCP 工具；
- 路由推理的本地用量追踪；
- 可选的本地 Docker 沙箱，用以替代远程 box；
- 集成在原版精美 UI 中的重建设置界面。

这是一个技术研究项目，**不是** Anysphere 的原始 monorepo，也**不是**官方的 Grok Bot 发行版。从编译产物反推得到的名称和模块边界可能与原始源码有出入。

## 仓库中有什么？

已提交的目录树包含经过审阅的重建代码、测试、清单(manifests)、构建脚本，以及通过 Git LFS 保存的原始 macOS arm64 和 Windows x64 安装包副本。项目刻意**不**提交解压后的上游应用本体、构建产物、本地凭据，或体积庞大的取证式恢复工作区。

公开发行的 Grok Bot 0.18.0 应用被当作一份"锁定版本的构建输入"处理。在 bootstrap 阶段，工具链会下载该应用、校验其 SHA-256 一致性，并抽取组装重建版所需的部分。

最终产出的应用是刻意设计成混合体：

- 应用运行时由 `source/` 下的可读源码编译而成；
- 精美的原版渲染层(renderer)仍作为 UI 基线保留；
- 一个范围很窄的确定性变换(transform)添加了重建后的 Router 设置界面；
- 原始与打过补丁的渲染层代码块哈希均被记录并校验；
- 最终应用使用独立的 bundle identifier 和 ad-hoc 签名。

机器上已安装的上游应用**永远不会被覆盖**。

### 为什么保留原版渲染层？

发行版应用并未包含原始前端源码或 source map，只包含经过优化压缩的生产环境 JavaScript 和 CSS 代码块——足以检查行为、恢复契约(contract)，但无法还原出作者编写的 React 组件、命名、注释、文件结构或设计系统源码。

要以同等的精致度和行为完整重现前端，将是另一个规模大得多的独立逆向工程项目，对于一个"周末项目"而言并不现实。因此实际做出的选择是：重建运行时与控制面代码，保留经过校验和锁定的原版渲染层，并只对新增的 Router 设置做最小、可审计的 UI 补丁。

`frontend/` 是一份可读的部分重建及设计工作区，有助于理解 UI 契约、实验干净的组件写法，但不应被误认为是 Anysphere 缺失的原始前端源码，也不是对打包渲染层的像素级完美替代。

## 保留的原始安装包

0.18.0 原始安装包的研究副本存放于 `research-archives/original/0.18.0/`，通过 Git LFS 存储：

| 平台 | 文件 | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `macos-arm64/Grok_Bot_0.18.0.dmg` | `a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb` |
| Windows x64 | `windows-x64/Grok_Bot_0.18.0_Setup.exe` | `464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e` |

来源 URL、文件大小、校验命令和机器可读的产物清单见 [research-archives/README.md](research-archives/README.md)。

## 当前功能

### 推理路由器(Inference Router)

打开 **Settings → Router** 可选择新对话轮次所使用的后端：

| Provider | 认证方式 | 工具支持 |
| --- | --- | --- |
| Cursor | 已有的 Grok Bot/Cursor 会话 | 原生 Grok Bot 工具与插件 |
| Claude Code | 已有的 Claude Code 登录 | 路由后的 Grok Bot MCP 工具 |
| Codex | 已有的本地 ChatGPT/Codex 登录 | 直连 Responses 传输 + Grok Bot 工具 |
| VCoder | 已有的本地 VCoder CLI 登录 | 路由后的 Grok Bot MCP 工具 |
| OpenRouter | 通过桌面端 secrets bridge 保存的 API key | Grok Bot 工具执行循环 |

Cursor 为默认选项。Claude Code 和 Codex 在本地客户端已认证的情况下无需额外配置 API key。应用在路由对话中保留了流式响应、思考状态、表情反应、富文本插件提及以及 MCP 工具执行。

启用本地 Docker 沙箱后，VCoder 遵循原版 Grok Bot 的拓扑结构：对话轮次在 box 内运行，host 直接在其中启动一个预置的 Linux 版 VCoder CLI，因此文件与 shell 副作用都落在 box 的文件系统上。将 `SAND_VCODER_BOX_CLI_PATH` 指向一个 Linux(x64 baseline) 的 `vcoder-cli` 构建产物即可完成预置。

**Usage & Billing** 展示的是本地记录的请求与 token 用量总计（仅针对会返回用量数据的 provider）。这些数字是活动记录，并非权威的 provider 账单。

### 中和后的默认配置

在公开发布版本中，原本指向上游 Cursor 基础设施的运行时连接默认值已被中和处理。遥测、更新器、实验标记以及客户端标识符现默认关闭或指向占位值(`*.example.com`)。若要连接 Cursor 路由或兼容后端，需通过环境变量提供自己的配置，例如：

- `SAND_BACKEND_URL`（或 `CURSOR_API_BASE_URL`）—— 推理/认证后端地址；
- `SAND_AUTH_CLIENT_ID` —— OAuth client ID；
- `SAND_CURSOR_WEBSITE_URL`（或 `CURSOR_WEBSITE_URL`）—— 门户/官网 origin；
- `SAND_SENTRY_DSN` —— 使用自己的项目开启错误上报。

使用本地会话的 provider 路由（Claude Code、Codex、VCoder、OpenRouter）不受影响。

### 本地 Docker 沙箱

Router 页面还有一个 **Use local Docker VM** 开关。启用后，Grok Bot 会在自有的本地容器中运行 box host 和执行守护进程，而不是连接远程沙箱。

该容器：

- 仅绑定 loopback 端口；
- 以只读方式挂载内容寻址的 host 与 daemon 产物；
- 在需要时复用用户已有的 provider 认证；
- 在协调器连接前会先经过校验；
- 通过同一套设置生命周期进行停止或替换。

需要运行 Docker Desktop 或其他兼容的本地 Docker daemon。远程模式仍是默认选项。

## 环境要求

- Apple Silicon 芯片的 macOS
- Node.js 26.5.x
- Xcode Command Line Tools
- Git LFS
- Docker Desktop（可选，仅本地沙箱需要）
- 若选用对应路由，需要本地已有 Claude Code 或 Codex 认证

## 快速开始

```sh
git clone https://github.com/weank1984/vcoder-bot.git
cd vcoder-bot
git lfs install
git lfs pull
npm ci
npm run bootstrap
npm run check
npm run package
open "dist/Grok Bot 0.18 Reconstructed.app"
```

`npm run bootstrap` 首先使用 Git LFS 保存的锁定版本 0.18.0 DMG 副本。若该归档不存在，则回退到原始公开下载地址；也可以通过 `GROK_BOT_018_APP` 指向一份已有的应用副本。Bootstrap 会校验 DMG 和 `app.asar`，缓存匹配的 Electron 运行时，并还原被 `.gitignore` 忽略的 `src/app/dist` 构建输入。

`npm run package` 会编译重建后的运行时、应用范围很窄的渲染层/设置变换、创建 app bundle、分配重建后的 bundle identity、进行 ad-hoc 签名，并校验结果。产物输出至：

```text
dist/Grok Bot 0.18 Reconstructed.app
```

重建版安装包在打包阶段会禁用上游更新器，并默认关闭上游 Sentry 与遥测上报。显式提供的环境变量配置仍会被尊重。

## 架构

```text
精美的原版渲染层
          │
          │ 桌面端 preload / RPC
          ▼
     Electron 主进程
          │
          ├── 设置、密钥、认证与插件生命周期
          ├── 远程 box 连接器
          └── 自有本地 Docker 连接器
                       │
                       ▼
              协调器(coordinator) + host
                       │
                 推理路由器
           ┌───────────┼───────────┐
        Cursor      Claude       Codex / OpenRouter
                       │
                 Grok Bot MCP 工具
```

主要源码区域：

- `source/electron-main/` —— 桌面端生命周期、设置、认证、box 连接器、协调器归属关系及 RPC 处理器；
- `source/electron-preload/` —— 暴露给 UI 的窄范围可信桥接层；
- `source/host/` —— 推理、工具、MCP、设置与对话轮次执行；
- `source/node-agent-coordinator/` —— 会话记录路由、流式活动、表情反应及路由后的 MCP bridge；
- `source/shared/` —— 共享契约、设置、协议及 provider 辅助逻辑；
- `frontend/` —— 可读的 React/TypeScript 渲染层重建及设计工作区；
- `scripts/` —— bootstrap、编译、渲染层打补丁、打包、签名及校验；
- `tests/` —— 发布与路由回归测试。

更多细节参见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发命令

```sh
npm test                  # 聚焦式回归测试
npm run typecheck         # 渲染层 TypeScript 类型检查
npm run source:typecheck  # 运行时 TypeScript 类型检查
npm run frontend:build    # 构建可读的渲染层重建版本
npm run package           # 构建、签名并校验 macOS 应用
npm run verify            # 校验一份已打包的应用
npm run smoke             # 有限范围的原生冒烟测试
npm run publication:check # 验证全新历史导出是否无损
```

包括 `.cache`、`.build`、`dist`、`src/app/dist`、`recovered`、`recovery` 以及本地探测根目录在内的生成目录均已忽略。

## 项目状态

应用可以启动，核心重建流程可用，包括路由推理、已连接插件以及本地 Docker 沙箱。这仍是一个实验性重建项目：仅针对一个锁定的 macOS/arm64 版本，依赖外部 provider 会话，不承诺与未来 Grok Bot 版本兼容。

本仓库公开且欢迎贡献，但项目本质仍是一项非官方、独立的研究工作。与 Anysphere、Cursor、xAI 或原版 Grok Bot 团队均无关联、未获其背书，也非由其维护。

关于变更流程，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；关于行为准则，请参见 [Code of Conduct](CODE_OF_CONDUCT.md) 和 [GOVERNANCE.md](GOVERNANCE.md)；常见问题见 [docs/FAQ.md](docs/FAQ.md)；干净历史导出流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)；技术溯源与保留的上游边界描述见 [PROVENANCE.md](PROVENANCE.md) 和 [NOTICE.md](NOTICE.md)。

## 许可证

本仓库中的重建源代码依据 Apache License, Version 2.0 授权，完整文本见 [LICENSE](LICENSE) 文件。

该许可证仅覆盖本仓库中的原创重建工作。保留的上游安装包、上游应用本体、商标以及渲染层素材不受本仓库许可证覆盖——详见 [NOTICE.md](NOTICE.md) 和 [PROVENANCE.md](PROVENANCE.md)。
