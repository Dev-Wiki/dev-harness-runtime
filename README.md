# dev-harness-runtime

## 项目简介

dev-harness 的统一执行 Runtime 与多平台插件分发层。任务选择、状态、授权、恢复和编排由公共 Core 承担，宿主接入由 Adapter 负责，安装产物由 Packager 生成。

## 当前阶段

公共 Core 已接通串行任务编排、独立验收、状态与恢复；共享 run / status / worker Skill 已建立。`dhr` 提供只读 doctor / status 和运行命令的可信服务入口。Codex 与 DSH Executor 已通过原始 Worker、三任务链、独立验收、逐任务提交及恢复验收。Codex、DSH、Cursor、OpenCode、Antigravity 和 Portable 的九个本地产物已通过统一打包验证；Antigravity 模型会话内 Skill 调用经用户豁免，尚未实测。各平台能力边界见[能力矩阵](docs/PLATFORM_MATRIX.md)及逐平台验证记录。

- 项目与仓库名：`dev-harness-runtime`
- CLI：`dhr`
- DSH 适配目标：`0.1.5-rc.1`
- Run 状态根：`$(git rev-parse --git-path dev-harness-runtime)/runs/`
- 每个 Run 的唯一权威状态文件：`<run-id>/run.json`

## 编程语言

TypeScript、JavaScript（ESM）与 Python fixture 校验。

## 构建系统

pnpm workspace、TypeScript 编译和 esbuild CLI bundle。

## 核心模块

- packages/contracts：版本化 TypeBox Schema、严格结构 / 关联校验、执行结果身份绑定与 JSON Schema 导出。
- packages/core/src/discovery：真实 Git / worktree 发现、docs root 选择和项目契约读取。
- packages/core/src/planning：结构化 Markdown 读取、依赖归档核验和权威顺序单任务选择。
- packages/core/src/snapshot：原始文件 / index / HEAD 内容快照、漂移和授权变更校验。
- packages/core/src/state / lock：私有 Run 持久化、revision CAS、操作证据、互斥 owner 与无锁只读状态检查。
- packages/core/src/recovery：按持久证据与真实边界分类恢复、显式对齐和新 Run 门禁；partial 的 noncompleted ending 安全停止，可信 worker-checkpoint 支持继续剩余工作。
- packages/core/src/result：冻结原验收输入、单任务 Planning delta、独立受控验收与接受 capability。
- packages/core/src/authorization：Linux 隔离验证 provider 与按冻结 Git policy 执行的受控提交 / 提交恢复。
- packages/core/src/worker：共享 Worker 请求构造、递归保护与紧凑父上下文投影。
- packages/core/src/orchestrator：可信 RuntimeAdapter 注册接入、任务执行循环、接受后重读计划及 resume / reconcile 桥接。
- packages/cli：参数、退出码与信号边界；doctor / status 只读入口，以及显式 RuntimeServices / BuildPipeline 注入入口；构建生成独立 bundle。
- packages/adapter-* / build/targets：统一 PlatformRegistry 为 run 和 build / validate / pack 提供同一平台注册表；可信宿主 Executor 仅在真实 probe 通过后注册，六平台 Packager 已接通。
- build/manifests、build/validators、build/transforms：来源与共享元数据校验、静态包检查、受限 Skill 转换和确定性归档。
- skills/run、skills/status、skills/worker：唯一共享 Skill 业务源码，平台差异留给后续转换。

## 使用说明

- 安装：pnpm install --frozen-lockfile --ignore-scripts
- 构建：pnpm build
- 运行：pnpm dhr --help
- Codex 插件：安装本地 Marketplace 后，在新线程显式使用 `$dev-harness:status` 或 `$dev-harness:run`；Skill 会调用同一插件包内的 `scripts/dhr.mjs`，不要求全局 `dhr` alias。

### Codex 插件体验

每次从新的 Codex 线程显式调用插件。安装自检不会读取项目或创建 Run：

```text
$dev-harness:run 插件安装自检
```

实际执行前，项目需要有可领取的 Planning Task，并按[执行契约](docs/CONTRACTS.md#自动执行-task-的冻结声明)声明有界写入范围、归档目标和已确认的验证命令。可按需选择一种模式：

```text
$dev-harness:run 执行任务 ID K5，不提交
$dev-harness:run 执行下一个 ready Task，不提交
$dev-harness:run 执行全部 ready Task，按任务提交
```

默认不提交；只有第三种示例中的明确授权才允许 Core 在每个 Task 独立验收通过后提交。运行返回 `runId` 后，可在新线程查询或恢复：

```text
$dev-harness:status 查询 Run <run-id>
$dev-harness:run 恢复 Run <run-id>
```

Linux 上执行 Task 还需要已登录的 Codex CLI 和可信 bubblewrap；Runtime 会在创建 Run 前探测实际能力，缺失时返回诊断并停止。父 Codex 的命令沙箱无法启动嵌套隔离时，会只为已校验的包内 `dhr` 精确命令请求升级；批准前应核对插件缓存路径、任务 ID、项目路径和提交模式。

## 与 dev-harness 协作

[`dev-harness`](https://github.com/Dev-Wiki/dev-harness) 维护工程契约与 8 个 Skill；本项目提供统一执行 Runtime、`dhr` 和平台插件。Skills Bundle 与 Runtime 插件分别安装；本项目的 `run / status / worker` 是执行入口，不替代上游 Planning、Commands 或 Git Workflow 契约。

构建消费 [`protocol-lock.json`](protocol-lock.json) 固定的上游来源；项目执行读取目标仓库的 Context、Planning、HARNESS 与 Git 规范。完整 Audit / Finding / Auto Fix / QA 流程不作为内建自动流水线，已准备好的 Planning Task 按公共 Core 契约执行。

各平台的打包、安装与自动执行能力见 [平台能力矩阵](docs/PLATFORM_MATRIX.md)。DSH 是本仓库中的 Adapter / Packager 目标，其宿主能力由本仓库的实现与验证记录维护。

## 项目入口

- [文档导航](docs/README.md)
- [开发看板](docs/plan/Dashboard.md)
- [资料完整性评估](docs/plan/Readiness.md)
- [Git 提交与发布规范](docs/GIT_WORKFLOW.md)
- [共享打包契约](docs/PACKAGING.md)

## 本地开发

使用 Node `24.15.0`、pnpm `11.1.0`，fixture 校验另需 Python 3.12。依赖版本由锁文件固定。

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
pnpm dhr --help
```

WSL2 已完成本机验证；Ubuntu / Windows 原生 CI 的离线验证与九产物 dry-run 已通过，见 [CI run 36394754252](https://github.com/Dev-Wiki/dev-harness-runtime/actions/runs/36394754252)。构建、测试及命令语义以 [HARNESS](HARNESS.md) 为准；模块边界见 [ARCHITECTURE](ARCHITECTURE.md)。

`protocol-lock.json` 固定上游提交和文件摘要。需要验证上游 checkout 时运行 `pnpm verify:protocol --source <checkout>`，不会自动下载或更新协议。
