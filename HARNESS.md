# HARNESS — 项目构建与验证契约

本文件是项目构建、验证和执行环境的唯一事实源。
它定义可执行命令、运行条件和验证边界，不替代 `AGENTS.md` 中的行为、安全与修改约束。

## 项目类型

TypeScript / Node.js ESM workspace；统一 Runtime 已接通 Core 编排与 CLI，平台 Adapter 仍为元数据骨架。

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

工作目录均为仓库根；前提为固定工具链已安装、`pnpm install --frozen-lockfile --ignore-scripts` 成功。下列记录适用于 WSL2 / development，设备要求为 none，不需要宿主、模型凭据或用户插件。证据见 [V0 验证记录](docs/verification/V0.md)、[K1 验证记录](docs/verification/K1.md)、[K2 验证记录](docs/verification/K2.md)、[K3 验证记录](docs/verification/K3.md)、[K3-L 验证记录](docs/verification/K3-L.md)、[K3-R 验证记录](docs/verification/K3-R.md)、[K4-V 验证记录](docs/verification/K4-V.md)、[K4-W 验证记录](docs/verification/K4-W.md)、[K4 / M1 完整回归](docs/verification/K4.md) 与 `package.json`。

| 用途 | 命令 | 语义 | 状态 |
|---|---|---|---|
| build | `pnpm build` | TypeScript workspace 编译及独立 CLI bundle；不生成平台插件产物 | confirmed |
| test | `pnpm test` | 编译后执行 node:test | confirmed |
| quick | `pnpm harness:quick` | typecheck + lint | confirmed |
| bugfix | `pnpm harness:bugfix` | 编译及 node:test 回归 | confirmed |
| full | `pnpm verify` | 类型、lint、测试、Schema 一致性、R1 fixture 和独立 CLI 包检查 | confirmed |

`harness:build/test/full` 分别映射对应入口。`pnpm dhr --help` / `--version`、`doctor` 与 `status --run <run-id>` 可运行；run / resume / reconcile 已接入可信服务接口，当前生产包未提供宿主 Executor 时返回 CAPABILITY_MISSING。

- Node `24.15.0`，包 engines 为 `>=24.15.0 <25`；pnpm `11.1.0`。
- TypeScript `6.0.3`、Oxlint `1.76.0`、esbuild `0.28.0`、`@types/node 24.12.2`，精确依赖见锁文件。
- fixture 使用 Python 3.12；Windows 通过 `python`、其他系统通过 `python3` 调用。
- Git `2.43.0` 为当前验证下限；上游 checkout 验证入口为 `pnpm verify:protocol --source <checkout>`。普通 verify 不隐式获取上游源码。
- `pnpm test:fixtures` 单独校验 R1 最小样例；`pnpm test:cli-package` 在临时目录离线安装 CLI tarball；不安装宿主插件。
- `pnpm schemas:write` 先编译再从 TypeBox 定义写入 packages/contracts/schemas；`pnpm schemas:check` 在编译后核对导出一致性，已纳入 full。
- `pnpm clean` 仅移除 packages/*/dist 和 build/dist；后续 `pnpm build` 重建。
- 安装和验证分开；workspace 设置 `verifyDepsBeforeRun: error`，依赖不一致时先显式安装。
- Windows / 原生 Linux 为支持目标，CI 已配置而未实跑；当前成功记录仅限 WSL2。当前受限沙箱的 Node 子进程输出捕获返回 EPERM，需要可执行该测试的环境。
- `generate`、`validate:plugins`、平台 `pack`、`dhr release --dry-run` 尚未实现，不属于本阶段 full；没有以空脚本代替验收。

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

- 当前分发包没有真实宿主 Executor；已有 Core 编排与受控验收 / Git API，真实 Agent 会话与权限证明由 Adapter 任务验证。
- 分发许可材料尚需落实，当前独立 CLI tarball 保持 private。
- 原生 Windows / Linux、真实插件安装和模型 Session 尚未取得本轮运行证据。

## K4-V 实际隔离专项

Linux 验证 provider 需要可用的 user / PID / mount / network / IPC / UTS / cgroup namespace、pidfd、原生 bubblewrap 与 Python。当前 WSL2 Linux 6.6.87.2 已使用 bubblewrap 0.9.0（Ubuntu 包 0.9.0-1ubuntu0.1）、Python 3.12 和 `/usr/bin/git` 2.43.0 实测。bubblewrap 本轮仅解包到临时目录，没有安装进系统或列为 npm 依赖。

调用者必须显式提供 canonical bubblewrap 路径及只读工具链目录。专项使用 `DHR_TEST_BWRAP=/absolute/path/to/bwrap`；未提供时相关测试会标记跳过，不能据此宣称隔离或提交链已验证。命令与边界见 [K4-V](docs/verification/K4-V.md)。常规 full 不自动下载 bubblewrap，也不隐式安装宿主插件。
