# HARNESS — 项目构建与验证契约

本文件是项目构建、验证和执行环境的唯一事实源。
它定义可执行命令、运行条件和验证边界，不替代 `AGENTS.md` 中的行为、安全与修改约束。

## 项目类型

TypeScript / Node.js ESM workspace；统一 Runtime 已接通 Core 编排与 CLI。六平台 Packager 均可从固定来源生成本地包；Codex / DSH 已通过原始 Worker 三任务链，Cursor / OpenCode 已通过会话 Skill 调用，Antigravity 已通过原生安装 / 发现 / 卸载，模型会话调用经用户豁免且未实测。Ubuntu / Windows 原生 CI 已通过离线验证与九产物 dry-run。

## 编译与启动问题排查

- **WorkingDirectory**（工作目录）：仓库根目录
- **RecommendedTerminal**（建议终端）：PowerShell（Windows）或项目兼容 shell
- **CanRunBuildHere**（当前环境能否构建）：yes（WSL2，本轮 `pnpm build` 已通过；其他 OS 未验证）
- **BuildCommand**（构建命令）：`pnpm build`
- **FailureEvidence**（失败证据）：记录完整命令、工作目录、终端类型、退出码、前 50 行和最后 100 行构建日志

## 自动识别构建命令候选

- **build**: `pnpm build`
- **test**: `pnpm test`
- **quick**: `pnpm harness:quick`
- **bugfix**: `pnpm harness:bugfix`
- **full**: `pnpm verify`

## 已确认命令（人工维护）

工作目录均为仓库根；前提为固定工具链已安装、`pnpm install --frozen-lockfile --ignore-scripts` 成功。下列记录适用于 WSL2 / development，设备要求为 none，不需要宿主、模型凭据或用户插件。证据见 [V0 验证记录](docs/verification/V0.md)、[K1 验证记录](docs/verification/K1.md)、[K2 验证记录](docs/verification/K2.md)、[K3 验证记录](docs/verification/K3.md)、[K3-L 验证记录](docs/verification/K3-L.md)、[K3-R 验证记录](docs/verification/K3-R.md)、[K4-V 验证记录](docs/verification/K4-V.md)、[K4-W 验证记录](docs/verification/K4-W.md)、[K4 / M1 完整回归](docs/verification/K4.md)、[K10-B 打包专项](docs/verification/K10-B.md) 与 `package.json`。

| 用途 | 命令 | 语义 | 状态 |
|---|---|---|---|
| build | `pnpm build` | TypeScript workspace 编译、独立 CLI bundle 与 Codex 自包含 Adapter / MCP bridge bundle；不生成平台插件产物 | confirmed |
| test | `pnpm test` | 编译后执行 node:test，包含 tests/packaging 专项 | confirmed |
| quick | `pnpm harness:quick` | typecheck + lint | confirmed |
| bugfix | `pnpm harness:bugfix` | 编译及 node:test 回归 | confirmed |
| full | `pnpm verify` | 类型、lint、测试、Schema 一致性、R1 fixture 和独立 CLI 包检查 | confirmed |

`harness:build/test/full` 分别映射对应入口。`pnpm dhr --help` / `--version`、`doctor` 与 `status --run <run-id>` 可运行；run / resume / reconcile 已接入可信服务接口，build / validate / pack 已接入可信 BuildPipeline 接口。六平台 Packager 可由仓库可信工厂注入；默认独立 CLI 尚未装配平台 Packager 或宿主 Executor。Codex 插件的独立 launcher 会校验包内锁定来源并装配服务；临时 Git 项目中的自主合成 Task 已通过包内 CLI 派发、受控应用、Planning 收口和 Core 独立验证。

仓库级 `pnpm dhr` 使用固定源码中的可信 Packager；`pnpm dhr release --dry-run --protocol-checkout <path>` 已在 WSL2 为六平台生成九个本地产物并重复验证摘要一致。逐阶段入口为 `pnpm generate`、`pnpm validate:plugins`、`pnpm run pack`，均需 `--protocol-checkout <path>`；`pnpm pack` 属于 pnpm 内建命令。`pnpm matrix:check` 核对实际摘要与 [能力矩阵](docs/PLATFORM_MATRIX.md)。这些命令不安装模型宿主，也不发布，详见 [RELEASE](docs/RELEASE.md)。独立 CLI tarball 仍无默认 Packager 和 Executor。

- Node `24.15.0`，包 engines 为 `>=24.15.0 <25`；pnpm `11.1.0`。
- TypeScript `6.0.3`、Oxlint `1.76.0`、esbuild `0.28.0`、`@types/node 24.12.2`，精确依赖见锁文件。
- fixture 使用 Python 3.12；Windows 通过 `python`、其他系统通过 `python3` 调用。
- Git `2.43.0` 为当前验证下限；上游 checkout 验证入口为 `pnpm verify:protocol --source <checkout>`。普通 verify 不隐式获取上游源码。
- `pnpm test:fixtures` 单独校验 R1 最小样例；`pnpm test:cli-package` 在临时目录离线安装 CLI tarball；不安装宿主插件。
- `pnpm schemas:write` 先编译再从 TypeBox 定义写入 packages/contracts/schemas；`pnpm schemas:check` 在编译后核对导出一致性，已纳入 full。
- `pnpm clean` 仅移除 packages/*/dist 和 build/dist；后续 `pnpm build` 重建。
- 安装和验证分开；workspace 设置 `verifyDepsBeforeRun: error`，依赖不一致时先显式安装。
- Windows / 原生 Linux 为支持目标，CI 已配置而未实跑；Runtime 自动执行成功记录仍限 WSL2。原生 Windows 已通过 Codex Marketplace 安装、Skill 发现和包内 CLI 只读自检，不代表 Linux 隔离 Executor 可在 Windows 执行。当前受限沙箱的 Node 子进程输出捕获返回 EPERM，需要可执行该测试的环境。
- `pnpm smoke:codex-host` 是显式选用的合成宿主测试：先 `pnpm build`，并要求本机已登录的 Codex CLI；只在临时目录向模型发送合成请求、Schema 和 `HELLO` 文件内容，不在常规 `pnpm verify` 中运行。可显式设置 `DHR_TEST_BWRAP` 为可信 bubblewrap 的绝对路径，改由隔离 MCP 子进程处理桥接；未设置时运行直接子进程模式。它验证真实桥接与解码入口，不构成实际 Planning Task 或整个宿主进程树的授权证据，见 [K5 验证记录](docs/verification/K5.md)。
- `DHR_TEST_BWRAP=<absolute> DHR_TEST_CODEX_HOST=1 pnpm smoke:codex-host` 在上述合成输入上将 Codex 宿主放入受监控的独立 PID / 网络命名空间，模型请求经独立网络内的 loopback Relay、私有 Unix socket 和宿主侧精确目的地主机代理转发；MCP bridge 位于嵌套的无网络命名空间。`pnpm smoke:codex-host-namespace` 只使用合成空目录检查宿主 PID 1 会话；两者都不属于常规 full，也不证明生产 Adapter 的完整授权。
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-runtime` 以临时 Git 项目和合成 Worker Skill 显式验证 Codex 能力探测、Core 派发、受控提案应用与宿主回执；需要本机 Codex CLI 登录，不进入常规 `pnpm verify`。该用例返回合成 `blocked`，不代表真实 Planning Task 或多任务验收。
- `DHR_TEST_BWRAP=<absolute> DHR_TEST_CANCEL_RESUME=1 pnpm smoke:codex-runtime` 在同一合成项目中取消已启动 thread 的 Codex 会话，由 Core 标为 `INTERRUPTED`，再经 `resumeRuntimeRun` 创建新 attempt；脚本核对不同 thread ID、工作树在取消后未改及恢复后由 Core 应用提案。该显式 smoke 不进入常规 full。
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-planning` 在临时合成 Git 项目中，让真实 Codex 连续为 A、B、C 三个 Planning Task 返回五项精确提案和不含 Worker 验证声明的 `completed` 候选；Core 逐项受控应用并独立运行冻结验收命令。脚本核对 Run `COMPLETED`、三条不同 thread、无隐式提交与独立验证输出。测试使用合成 Worker Skill 和测试控制器提供的预期文件内容，不代表模型自主完成真实项目任务；需要本机 Codex 登录，不进入常规 full。
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-autonomous` 在临时 Git 项目中使用包内 CLI 和通用合成 Worker 指引，由真实 Codex 自行读取需求、生成实现与 node:test、更新验证记录并完成 Planning 收口；测试控制器不预置提案文件内容。`pnpm smoke:codex-packaged-worker` 在同一场景改用包内未替换的原始 Worker Skill。两者均由 Core 独立运行冻结命令并核对 Run `COMPLETED`、HEAD / index 未变。显式 smoke 需要本机 Codex CLI 登录，不进入常规 full，也不替代真实项目、交互式插件 Skill 调用或提交链验收。
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-commit` 使用原始 Worker Skill 和临时项目内已冻结的中文 Conventional Commits 规范运行 `--commit-each`。Worker 先通过 `dhr_identity` 核对 Core 绑定的请求与四个环境标记，只返回提交候选；Core 独立验收后创建唯一提交。脚本核对 commitSha、父提交、精确七路径、中文标题、空 index 与干净工作树。该显式 smoke 不进入常规 full。
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-restart` 在原始 Worker thread 启动后向第一段包内 CLI 发送 `SIGTERM`。Core 等宿主静止后持久化 `INTERRUPTED`、保留已完成 Worker 的检查点和应用结果并释放锁；全新的 CLI 进程随后 `resume` 同一 Run，只重做独立验收而不重复开发，最终核对 `COMPLETED`。强制杀死且无法证明后代静止时仍按恢复协议保留锁并拒绝自动接管。
- `pnpm smoke:codex-plugin` 把当前生成的 Codex Marketplace 安装到带现有登录凭据副本的隔离临时配置。第一个新模型会话显式调用 `$dev-harness:status`，核对唯一 `run.json` 权威状态和禁止的 run / resume / reconcile 入口且不退回 shell / MCP 资源查找；第二个新会话显式调用 `$dev-harness:run` 的安装自检，从该 Skill 所在插件根解析并执行包内 `scripts/dhr.mjs --version`，核对版本 0.1.1。结束后清理临时配置。该显式 smoke 不进入常规 full。
- `DHR_TEST_DSH_ENTRY=<absolute-rc.1-bin.js> DHR_TEST_DSH_PACKAGE=<absolute-local-tgz> DHR_TEST_BWRAP=<absolute> pnpm smoke:dsh-runtime` 还需可信环境中的 `DEEPSEEK_API_KEY`。它把本地包离线安装到临时 headless profile，核对包内插件摘要，以合成文件和 Task 在隔离的新 DSH Session 中依次调用身份、目录、读取、搜索、删除提议；检查精确主机模型代理、整个宿主静止和原文件未变。它不进入常规 `pnpm verify`，也不证明生产 RuntimeAdapter、Core 应用、取消恢复或 Planning 三任务验收；见 [K6 验证记录](docs/verification/K6.md)。
- 同一命令加 `DHR_TEST_DSH_PROBE=1`，会追加两个真实新 Session 与独立命名空间取消的能力 probe；加 `DHR_TEST_DSH_CORE=1`，会让 RuntimeAdapter 在临时 Git 项目完成合成 Core 派发、提议精确应用和宿主回执复核。这些显式模式仍不代表包内 CLI、真实 Run 取消恢复或 Planning 三任务验收。
- 加 `DHR_TEST_DSH_PACKAGE_CLI=1` 会先核验新安装包的锁定来源、可信服务工厂和包内 CLI，然后仅在临时复制包中替换并重新锁定合成 Worker Skill，用包内 `scripts/dhr.mjs run` 执行一个临时 Planning Task，核对 Core 应用提议、`BLOCKED` 状态和未改动的 HEAD / index。此模式不验证未替换 Worker 或三任务链。
- 加 `DHR_TEST_DSH_CANCEL_RESUME=1` 会在合成 Core Run 的持久宿主启动记录出现后取消 DSH Worker，核对 `INTERRUPTED`、原文件未变及锁释放，再用新 Adapter 实例恢复到 attempt 2 并核对 Core 应用提议。它不证明被取消 Session 的持久身份、原始 Worker 或三任务链。
- `DHR_TEST_DSH_ENTRY=<absolute-rc.1-bin.js> DHR_TEST_DSH_PACKAGE=<absolute-local-tgz> DHR_TEST_BWRAP=<absolute> pnpm smoke:dsh-autonomous` 从实际安装的包内 CLI 调用未替换的 Worker Skill，在临时 Git 项目自主完成 Planning Task、提交受控结果候选并由 Core 独立运行冻结检查。默认单 Task `--no-commit`；追加 `--commit-each` 检查 Core 受控提交；追加 `--three-task --commit-each` 检查 A→B→C 三任务各用新 Session、独立验收与三次精确提交。此显式真实模型 smoke 不进入常规 `pnpm verify`。
- 公共 BuildPipeline 的 generate / validate / pack 阶段和 `dhr build|validate|pack --adapter ID` 已实现；仓库级固定来源工厂可为全部六个平台生成产物。独立 CLI 分发包仍不隐式读取项目可执行配置。分平台证据见 [能力矩阵](docs/PLATFORM_MATRIX.md)。

## 高风险目录

- scripts/：临时 CLI 包安装、已知编译输出清理、外部 checkout 校验和 bundle 生成。
- packages/core/src/authorization、state、lock、recovery、orchestrator：子进程权限、Git 提交、私有状态发布、互斥与崩溃恢复边界。

## 禁改区域

- packages/*/dist、build/dist：编译输出；build/targets 是可编辑源码。
- node_modules、.cache/pnpm：依赖和缓存，通过安装器维护。
- .git: 版本控制元数据

## 自动识别候选

- Windows / Ubuntu CI 已配置，当前仓库验证记录仍区分 WSL2、原生 OS 与真实宿主。

## 需人工确认

- 通用独立 CLI 未预装宿主 Executor；Codex 插件已通过包内原始 Worker Skill 的自主合成 Task、逐任务提交、跨进程检查点恢复与会话内显式 Skill 调用。
- 项目采用 MIT 许可并附第三方声明；独立 CLI tarball 仍保持 private，本轮只将九个平台产物作为 GitHub Release 附件分发。
- 原生 Windows 已有 Codex 插件安装和 `$dev-harness:status` 自检 Session，尚无 Runtime Task 执行证据；Ubuntu / Windows CI 已通过离线验证与九产物 dry-run，不能据此推断原生 Linux 宿主模型会话能力。WSL2 Codex / DSH 已通过完整任务链，其余平台按各自任务记录边界。

## K4-V 实际隔离专项

Linux 验证 provider 需要可用的 user / PID / mount / network / IPC / UTS / cgroup namespace、pidfd、原生 bubblewrap 与 Python。当前 WSL2 Linux 6.6.87.2 已使用 bubblewrap 0.9.0（Ubuntu 包 0.9.0-1ubuntu0.1）、Python 3.12 和 `/usr/bin/git` 2.43.0 实测。bubblewrap 本轮仅解包到临时目录，没有安装进系统或列为 npm 依赖。

调用者必须显式提供 canonical bubblewrap 路径及只读工具链目录。专项使用 `DHR_TEST_BWRAP=/absolute/path/to/bwrap`；未提供时相关测试会标记跳过，不能据此宣称隔离或提交链已验证。命令与边界见 [K4-V](docs/verification/K4-V.md)。常规 full 不自动下载 bubblewrap，也不隐式安装宿主插件。
