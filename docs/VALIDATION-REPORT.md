# Bot + 云服务验证报告

> 状态：执行中，尚不能作继续/调整/停止决策  
> 统计截止：2026-09-18  
> 验证方案：[VALIDATION-SPRINT.md](VALIDATION-SPRINT.md)  
> 任务集：[VALIDATION-TASKSET.md](VALIDATION-TASKSET.md)

## 1. 当前结论

控制面到独立 Docker runner、真实 DeepSeek 模型、workspace 修改、受限命令、交付物保存和鉴权下载的闭环已在本机走通。B01 修复后的两次重复均通过独立验收，耗时分别为 13.1 秒和 13.7 秒；任务准备通过跳过无关 Git LFS hydration 从 108 秒量级降到 3.2—4.2 秒。

扩展任务集 B02—B06、B08、B11 各重复两次，14/14 达到冻结的有限验收条件；执行阶段耗时 2.8—62.0 秒。包含单文件逻辑、多文件修改、新增测试、只读分析和诚实报告缺少输入。独立测试在无密钥、无网络的第二个容器执行。

相同镜像、provider、模型、任务和权限下，绕过 HTTP/worker 的直接 Docker 对照完成 B02、B04 各两次，4/4 通过；对应服务组也是 4/4。仅能说明这两个小任务未观察到质量退化，不能外推到所有任务。

这证明了 bot + 服务 + 隔离容器 + provider 的最短技术链路可行，但还不能证明完整产品假设成立。尚未完成 Linux 云主机离场、跨物理设备取回、扩大本地质量对照、用户实际试用和全部边界任务。H2、H3、H5 获得局部正证据，其余假设仍未判定。

## 2. 证据台账

| 日期 | 证据 | 结果 | 适用范围 |
| --- | --- | --- | --- |
| 2026-09-18 | 控制面单元与 HTTP 集成测试 | 完整项目检查通过，32/32 测试通过 | 包含补丁实际还原、交付结果可读格式和浏览器脚本语法检查；不等于浏览器交互验收 |
| 2026-09-17 | runner 镜像构建与工具 smoke | 通过；非 root，Node/Git/ripgrep 可用 | 本机 arm64 Docker，不代表 Linux amd64 云主机 |
| 2026-09-17 | 无 provider 全链路故障演练 | 按预期失败，状态和原因持久化 | 证明链路故障路径，不证明模型能力 |
| 2026-09-17 | 构建产物模块兼容回归 | 首次发现 ESM/动态 CommonJS 冲突；改为 CJS 后通过 | server/runner bundle 启动配置闸门 |
| 2026-09-17 | 基础设施 fixture 成功、停止和超时 | 3/3 达到预期；明确不计入模型结果成功率 | 离场连接、产物、主动停止、墙钟限制、API 重启 |
| 2026-09-18 | B01 DeepSeek 本机 Docker | 修复后 2/2 独立验收通过；所有失败、部分通过和证据回归样本均保留 | 真实模型、写文件、受限命令、patch、测试结果、用量和鉴权下载；不代表云主机 |

原始结构化记录保存在 [validation-evidence/2026-09-17-e2e-no-provider.json](validation-evidence/2026-09-17-e2e-no-provider.json)。
基础设施 fixture 记录保存在 [validation-evidence/2026-09-17-infrastructure-fixtures.json](validation-evidence/2026-09-17-infrastructure-fixtures.json)。
B01 真实模型记录保存在 [validation-evidence/2026-09-18-b01-deepseek-local-docker.json](validation-evidence/2026-09-18-b01-deepseek-local-docker.json)。

B07 不存在 commit 的真实 API 演练在 1,067 ms 内以 `preparation` 原因失败，未进入 running、无模型用量事件或产物。完整服务快照见 [validation-evidence/2026-09-18-b07-missing-commit.json](validation-evidence/2026-09-18-b07-missing-commit.json)。

扩展冻结任务集的 14 次运行 ID、用量与独立测试证据见 [2026-09-18-taskset-v1.json](validation-evidence/2026-09-18-taskset-v1.json)。14/14 不是历史全量成功率，也不是完整安全性通过。B08 仅证明交付了预期失败测试、模型未谎称执行且独立测试 exit 1；B11 仅证明遵守明确禁止 push/PR 的任务指令，不证明能抵抗恶意仓库注入。

B01 r8 已用 `scripts/verify-validation-b01.mjs` 重新验收：补丁在干净仓库实际还原、精确文件范围、固定文本、结构化测试及密钥扫描均通过。该脚本对 r7 的 unknown 测试结果返回退出码 1。早期 shell 检查未开启失败即退出，不再作为独立的充分证据。

## 3. 假设状态

| 假设 | 状态 | 已有证据 | 缺少证据 |
| --- | --- | --- | --- |
| H1 发起设备可离场 | 未判定 | 任务状态由服务端持久化 | 云主机执行、发起端断网、另一设备取回 |
| H2 链路稳定 | 部分成立 | B01 修复后 2/2；扩展任务 14/14 达到有限验收条件，历史失败保留 | 恶意注入、真实模型中断/恢复及云环境分母 |
| H3 结果质量不明显恶化 | 部分成立 | B02、B04 服务组和直接 Docker 组各 4/4 通过 | 更大任务集、原生桌面及物理云主机对照 |
| H4 用户无需盯日志 | 未判定 | 最小 Web 已实现 | 非实现者试用和观察记录 |
| H5 成本和边界可测 | 部分成立 | 准备、workspace、状态、模型 token 和执行时间可记录 | 模型请求数、单价、云资源和并发分布 |

## 4. 已观察边界

直接运行对照见 [2026-09-18-local-baseline-v1.json](validation-evidence/2026-09-18-local-baseline-v1.json)，可用 `scripts/run-validation-baseline.mjs` 重跑（新前缀，不覆盖旧记录）。B02 服务组执行时长 8.6/11.7 秒、直接组 10.5/15.2 秒；B04 服务组 16.1/17.0 秒、直接组 18.2/19.0 秒。各组均 2/2 通过。直接组使用干净的本地 Git 对象克隆，准备时间不可与远程 clone 比较；这是同一 Docker runtime 的控制面对照，不是原生桌面与物理云主机对照，不能推断服务使模型更快。

- `vcoder-bot` 固定快照首次准备约 133.1 秒，workspace 最终约 596 MiB；这只是一次本机样本，尚未包含依赖安装和模型运行。
- 根因是仓库含两个约 580 MiB 的 Git LFS 安装包。runner 缺少 Git LFS 时会把已展开对象误判为修改；安装 Git LFS 后正确性恢复。验证任务现默认跳过 LFS hydration，workspace 约 39 MiB、准备约 3—5 秒；需要读取 LFS 实体的任务当前不支持。
- VCoder runtime 的 `sendMessage` 只表示消息已提交，必须等待 `session_complete` 才能收集结果；不等待会产生 0 token、空 patch 的假 `delivered`。该路径已加入回归约束。
- 新文件不会出现在普通 `git diff HEAD` 中；交付器现对未跟踪文件生成 `git diff --no-index` 补丁，否则会出现“文件正确、patch 为空”的假完整交付。
- 用户指定的 `deepseek-v4.1-flash` 被当前 DeepSeek API 拒绝；受权 `/models` 仅返回 `deepseek-flash` 和 `deepseek-v4-pro`。本次实际执行使用 `deepseek-flash`，不能把 API ID 差异静默隐藏。
- API 可接受 `deepseek-flash` 并不能证明它与用户指定的 V4.1 Flash 完全相同；当前证据只归属于实际 API ID，具体版本对应关系未核实。
- 2026-09-18 用户明确确认后续使用 `deepseek-flash`；后续不再等待模型选择，仍不宣称其版本等同于 V4.1。
- 无远程副作用目前只有运行记录、无写凭据和移除 remote 的佐证，未实施独立网络审计，不能声称已经完整证明。
- 首次构建产物在容器启动前暴露 ESM 与 VCoder runtime 动态 CommonJS `require` 不兼容。源码级测试不会自动发现这类打包故障，因此构建脚本现已检查 server/runner 至少能到达各自配置闸门。
- Docker runner 已限制 CPU、内存、PID、capabilities 和只读根文件系统，但网络域名白名单尚未实现；当前只适用于自有、无敏感数据的仓库。
- 仓库来源现由 `VALIDATION_CLOUD_REPOSITORY_HOSTS` 做 API 与 worker 双重精确主机白名单，默认仅 `github.com`；这限制 Git 输入面，但不等价于容器运行期网络出口白名单。
- 模型凭据在验证阶段仍进入任务容器环境；必须使用独立、限额、可撤销的低价值凭据。正式架构需要模型代理消除此暴露面。
- B01 的安全命令结果现由 runtime 工具事件写入 `tests.json` 与 `test-output.txt`，并经宿主独立复跑验证；尚未实现脱离模型工具循环的控制面二次测试执行。
- runner 目前只预授权精确的独立命令 `git diff --check`，且任务必须声明 `test`；带分号、改 cwd 或其他 Bash 命令均拒绝。这足以验证 B01，但尚不能承载通用项目测试。
- 扩展任务通过宿主触发的无密钥、无网络独立容器执行验收；尚未自动回写服务的交付测试状态，因此用户页面不包含这部分独立测试结果。
- B06 缺少 SLA 信息时摘要正确说明阻塞、未猜值或改文件，但任务状态仍是 `delivered`：产物交付不等于用户目标完成，现有状态呈现容易误解。
- 浏览器控制接口连续两次超时，本轮只完成页面脚本语法与格式化回归；不得将其当作视觉或真实交互验收。
- 主动停止当前最多等待 Docker 5 秒优雅停止，因此实测停止延迟约 5.3 秒；1 分钟墙钟限制实测约 65.3 秒才形成持久终态。若用户预期“立即停止”，需要缩短 grace 或先显示明确的终止窗口。

## 5. 下一判定门

下一里程碑是收集首位用户实际反馈、扩大对照，并补充恶意注入与真实中断边界。独立测试应保持无模型密钥隔离，不直接开放任意测试命令给持有凭据的模型容器。安全与交付证据稳定后，再迁移到 Linux 云主机做发起端离场和另一设备取回；在此之前不开始正式产品规范开发。

继续执行需要以下外部输入：

1. 一台可运行 Docker 的 Linux 云主机及 HTTPS 入口，用于补齐本机 Docker 无法证明的 H1；当前按用户选择先在本机推进。
2. 用户已确认自己先试用，其他人稍后安排；[首轮流程与反馈记录](VALIDATION-USER-TRIAL.md)已就绪，实际反馈待收集。后续仍需补充其他试用者，不能把首位反馈算作全部试用完成。
3. 当前验证凭据已在对话中出现；完成本轮后必须撤销，不得复用于正式环境。

## 6. 最终决策

待 Day 10 填写：`继续规范开发 / 调整后再验证 / 停止独立产品化`。当前证据不足，不提前选择。
