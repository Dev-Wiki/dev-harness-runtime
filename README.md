# dev-harness-runtime

## 项目简介

dev-harness 的统一执行 Runtime 与多平台插件分发层。任务选择、状态、授权、恢复和编排由公共 Core 承担，宿主接入由 Adapter 负责，安装产物由 Packager 生成。

## 当前阶段

公共 Core 已接通串行任务编排、独立验收、状态与恢复；共享 run / status / worker Skill 已建立。`dhr` 提供只读 doctor / status 和运行命令的可信服务入口。三任务流程通过 Fake Executor 与真实本地验收验证。共享打包流水线已通过 Fake Packager 验证；各平台真实 Executor / Packager 仍待后续任务接入。

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
- packages/adapter-* / build/targets：统一 PlatformRegistry 为 run 和 build / validate / pack 提供同一平台注册表；现有描述符没有真实宿主 Executor / Packager。
- build/manifests、build/validators、build/transforms：来源与共享元数据校验、静态包检查、受限 Skill 转换和确定性归档。
- skills/run、skills/status、skills/worker：唯一共享 Skill 业务源码，平台差异留给后续转换。

## 使用说明

- 安装：pnpm install --frozen-lockfile --ignore-scripts
- 构建：pnpm build
- 运行：pnpm dhr --help

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

已验证环境为 WSL2；Windows / 原生 Linux 的 CI 已配置，尚无远端运行结果。构建、测试及命令语义以 [HARNESS](HARNESS.md) 为准；模块边界见 [ARCHITECTURE](ARCHITECTURE.md)。

`protocol-lock.json` 固定上游提交和文件摘要。需要验证上游 checkout 时运行 `pnpm verify:protocol --source <checkout>`，不会自动下载或更新协议。
