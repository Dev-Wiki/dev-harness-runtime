# dev-harness-runtime 开发看板

> 本文是唯一活跃计划入口。任务实现与验收见 `tasks/`；资料判断见 [Readiness.md](Readiness.md)。已完成任务见里程碑归档，不维护第二份 TaskDetails 索引。

## 1. 进度快照

- **核心阶段**：M0 / M1 已收口；接下来建立共享打包流水线。
- **当前瓶颈**：公共 Core 的串行执行、状态、验收和恢复已通过 Fake Executor 与真实本地验证；共享构建、平台包及真实宿主执行能力仍待落实。
- **本轮目标**：完成设计 §45–47 的 MVP，先建公共 Core，再接 Codex / DSH，最后交付五平台和 Portable 产物。
- **需求状态**：R0 / R1 / V0 和 M1 全部任务已验收；已有公共 Contracts、项目发现、Planning 读取、快照 / 漂移门禁、私有状态 / 锁、恢复 / 显式对齐、Registry、包骨架、独立验收、受控提交、共享 Worker 与紧凑摘要；串行编排已验证，实际 Adapter 接入尚未实现，不继承旧 DSH 的完成状态。
- **命名与路径**：项目 `dev-harness-runtime`；CLI `dhr`；唯一状态根 `$(git rev-parse --git-path dev-harness-runtime)/runs/`。
- **Run 布局**：`<run-id>/run.json` 是每个 Run 唯一权威状态文件；同级 `attempts/`、`results/`、`summary.json` 分别保存日志、结果与派生摘要。
- **DSH 目标**：`0.1.5-rc.1`（本轮复跑；实际为 rc.1 启动器 + rc.2 组件）；旧 rc.8 仅作历史迁移参考，适配与验证以设计 §19.2 为准。

## 2. 当前产品目标

面向使用 dev-harness 的工程维护者，以统一 Core 承担任务选择、授权、状态、漂移门禁、恢复、结果验证和串行编排。Adapter 只处理宿主接口，Packager 从同一份 Skill 与 Runtime 源码生成平台产物。一次 Task 使用一个新 Session，持久连续性来自项目与 Run 状态。

MVP 包含 Codex / DSH Executor 与五平台打包，不包含默认并行、跳过阻塞、旧对话续接、隐式 push / PR / tag / release / deploy。统一安装器保留远期；其他平台 Executor 先评估能力，不预设实现承诺。

| 里程碑 | 交付门槛 | 当前阶段 |
|---|---|---|
| M0 资料与工程基线 | 公共决策、平台资料基线、可运行 workspace | R0 / R1 / V0 已归档；工程门槛已完成 |
| M1 公共 Runtime | Fake Executor 下三任务、漂移、授权、中断恢复闭环 | 已收口；见 [M1 归档](archive/M1/README.md)，496 项 Node 回归零跳过 |
| M2 Codex / DSH | 同一 Core 上的独立 Session、共享契约与迁移等价证据 | 尚未开始 |
| M3 多平台分发 | 五平台与 Portable 静态验证、golden、能力矩阵和本地 dry-run | 尚未开始 |

## 3. 当前工作顺序

1. [K10-B — 共享生成、校验与打包流水线](tasks/K10-B.md)：按活跃表核对前置任务后执行。

上述执行包已接入 R0 契约；待执行不表示依赖已完成，必须先检查活跃表。平台实施包已接入 R1 基线，待剩余实施输入与验证条件明确后再进入本顺序。

## 4. 活跃任务

保留设计的 V0、K1–K10 主编号。K3-L / K3-R 拆出状态锁与恢复，K4-V / K4-W 拆出验证与共享 Worker，K5-P / K6-P 拆出打包，K10-B / K10-G 拆出共享构建与 Portable 产物；这些任务合起来覆盖对应设计阶段。

| 任务 | 优先级 | 状态 | 依赖 | 下一步 / 阻塞 | 详情 |
|---|---|---|---|---|---|
| **K10-B — 共享生成、校验与打包流水线** | 🔴 P0 | 🟢 待执行 | [K1](archive/M1/K1.md)、[K4-W](archive/M1/K4-W.md) | 无 | [执行包](tasks/K10-B.md) |
| **K5-P — Codex Plugin 与 Marketplace 打包** | 🔴 P0 | 📋 规划中 | [R1](archive/M0/R1.md)、[K10-B](tasks/K10-B.md) | G6、G7、G8 | [执行包](tasks/K5-P.md) |
| **K5 — Codex fresh-session Executor** | 🔴 P0 | 📋 规划中 | [R1](archive/M0/R1.md)、[K4](archive/M1/K4.md)、[K5-P](tasks/K5-P.md) | G6、G8 | [执行包](tasks/K5.md) |
| **K6-P — DSH Bundle 打包** | 🔴 P0 | 📋 规划中 | [R1](archive/M0/R1.md)、[K10-B](tasks/K10-B.md) | G6、G7、G8 | [执行包](tasks/K6-P.md) |
| **K6 — DSH Executor 与行为等价迁移** | 🔴 P0 | 📋 规划中 | [R0](archive/M0/R0.md)、[R1](archive/M0/R1.md)、[K4](archive/M1/K4.md)、[K6-P](tasks/K6-P.md) | G5、G6、G8 | [执行包](tasks/K6.md) |
| **K7 — Cursor Native Plugin 打包** | 🟡 P1 | 📋 规划中 | [R1](archive/M0/R1.md)、[K10-B](tasks/K10-B.md) | G6、G7、G8 | [执行包](tasks/K7.md) |
| **K8 — OpenCode npm 与本地插件打包** | 🟡 P1 | 📋 规划中 | [R1](archive/M0/R1.md)、[K10-B](tasks/K10-B.md) | G6、G7、G8 | [执行包](tasks/K8.md) |
| **K9 — Antigravity Plugin 与 Skills 打包** | 🟡 P1 | 📋 规划中 | [R1](archive/M0/R1.md)、[K10-B](tasks/K10-B.md) | G6、G7、G8 | [执行包](tasks/K9.md) |
| **K10-G — Portable Agent Plugin 打包** | 🟡 P1 | 📋 规划中 | [R1](archive/M0/R1.md)、[K10-B](tasks/K10-B.md) | G6、G7 | [执行包](tasks/K10-G.md) |
| **K10 — 统一验证、能力矩阵与本地产物收口** | 🟡 P1 | 📋 规划中 | [K5](tasks/K5.md)、[K6](tasks/K6.md)、[K7](tasks/K7.md)、[K8](tasks/K8.md)、[K9](tasks/K9.md)、[K10-G](tasks/K10-G.md) | G7、G8 | [执行包](tasks/K10.md) |
| **F1 — 原生安装机制的统一入口** | 🟢 P2 | 📋 远期 | [K10](tasks/K10.md) | 远期候选；未进入当前里程碑 | [执行包](tasks/F1.md) |

## 5. 共享验证基线

执行节奏：每个任务先运行类型检查、lint 与本次影响范围的测试，通过后提交并继续；里程碑收口时运行 `pnpm verify` 全量回归。公共接口、依赖或跨模块行为变更按影响范围扩大测试；不要求每个任务无条件重复全量。命令定义仍以 HARNESS 为准。

K4 / M1 全量 `pnpm verify` 已通过：496 项 Node 测试、21 份 Schema、10 项平台 fixture 与 CLI 空 store 离线安装；未跳过真实 bubblewrap 专项。全量后仅修正三处测试 getter 的 lint 提示，定向复验及 quick 无警告通过。详见 [K4 记录](../verification/K4.md) 和 [HARNESS](../../HARNESS.md)。以下平台产物入口仍由 K10-B / K10 落实，当前未实现：

```bash
# 工作目录：dev-harness-runtime；以下是后续目标，不是已通过命令
pnpm generate
pnpm validate:plugins
pnpm pack
dhr release --dry-run
```

- V0 已建立固定工具链、workspace、CLI 骨架和 HARNESS；Windows / 原生 Linux CI 已配置但未实跑。build 编译并生成独立 CLI bundle；K10-B 接通平台生成与打包。
- 公共验证覆盖 task selector、完整内容快照、CAS / 锁、crash / resume、授权与结果独立校验；Windows / Linux / WSL 分别报告。
- 所有 Executor 使用相同 Contract Tests；Codex / DSH 另有三任务、独立 Session 身份、取消与恢复证据。
- 五平台与 Portable 均需静态校验和 golden；真实安装 smoke 缺少宿主时记录无法运行，不能冒充通过。
- 产物从干净输入生成，扫描错误 manifest、缺文件、重复 Skill、非法版本、本机绝对路径和未完成标记；核对 SHA-256 与 manifest。
- 完整日志位于唯一私有状态根，父上下文只输出摘要与引用；外部发布动作不进入默认流水线。
- R0 文档交付与收口校验见 [验证记录](../verification/R0.md)：检查链接、锚点、任务唯一性、ready 顺序、依赖、归档与范围外漂移；不替代后续 Runtime 测试。
- R1 平台取证与离线检查见 [验证记录](../verification/R1.md)；`python3 tests/fixtures/platform-specs/check.py` 已通过，不能替代上述目标入口或真实宿主验收。

## 6. 最近完成

| 任务 | 完成日期 | 验收摘要 | 归档 |
|---|---|---|---|
| K4 — 统一 Orchestrator 与运行 CLI | 2026-09-17 | 三任务、取消、只读状态、恢复与 CLI 通过；M1 全量 496 项 Node 测试零跳过 | [M1 / K4](archive/M1/K4.md) |
| K4-W — 共享 Worker 与父上下文输出 | 2026-09-17 | 单一 Skill 源码、递归门禁、完整私有日志和紧凑摘要通过；69 项相关测试通过 | [M1 / K4-W](archive/M1/K4-W.md) |
| K4-V — 执行结果、授权与收口验证 | 2026-09-17 | 独立验收、实际隔离、精确提交与持久证据恢复通过；真实宿主仍待取证 | [M1 / K4-V](archive/M1/K4-V.md) |
| K3-R — Run 恢复与中断重入 | 2026-09-17 | 恢复、新执行身份、精确证据复用及唯一 successor 通过；相关 144 项测试通过 | [M1 / K3-R](archive/M1/K3-R.md) |
| K3-L — 私有状态与互斥锁 | 2026-09-17 | 唯一 run.json、revision CAS、多进程锁和进程崩溃测试通过；全套 289 项 Node 测试通过 | [M1 / K3-L](archive/M1/K3-L.md) |

[M0 归档索引](archive/M0/README.md)、[M1 归档索引](archive/M1/README.md)；本节最多保留五项摘要。

## 7. 需求覆盖与缺口

“纳入”表示已进入计划，不表示已实现。

| 设计来源 | 覆盖判断 | 任务 |
|---|---|---|
| §1–6、§43–45 架构与工程骨架 | 纳入 | R0、V0 |
| §7 Planning / Discovery / Selector | 纳入 | K2 |
| §8–12 快照、授权、状态、锁、恢复 | 纳入 | K1、K3、K3-L、K3-R、K4-V |
| §13–17、§30、§32–37 执行契约、编排、Worker、隔离、日志、提交 | 纳入 | K1、K4-V、K4-W、K4、K5、K6 |
| §18–19、§41 平台包与安装方式 | 纳入 | R1、K5-P、K6-P、K7、K8、K9 |
| §20 Portable Agent Plugin | 纳入 | K10-G |
| §21–31、§39–40 统一 CLI、构建、版本、校验、CI、本地产物 | 纳入 | V0、K1、K4、K10-B、各 Packager、K10 |
| §38 DSH 迁移 | 纳入公共行为与新 Adapter；弃用动作另议 | R0、K6 |
| §42 统一安装器 | 远期候选 | F1 |
| §46–47 MVP 验收与核心成功标准 | 纳入，必须有真实证据 | K10 |
| §48–50 产品说明、外部格式与架构约束 | 纳入资料与事实文档维护 | R0、R1、V0、K10 |
| Cursor / OpenCode / Antigravity 自动 Executor | 仅能力评估，不承诺 MVP 实现 | R1、K7、K8、K9；启用前另建执行包 |

### 缺口处理登记

原始依据见 [资料评估](Readiness.md)；本表是缺口处理状态和解除条件的唯一来源。

| 缺口 | 处理任务 | 当前处理状态 | 解除条件 |
|---|---|---|---|
| G1 工程与协议来源 | R0、V0 | 已完成工程、protocol-lock、设计归属和 HARNESS | 后续执行前重验 HEAD、协议来源与工具链漂移 |
| G2 Planning 解析规则 | R0、K1、K2 | 已实现读取与资格选择，正反例及真实看板 smoke 通过 | 后续快照与执行前重验证复用该语义 |
| G3 结果与收口责任 | R0、K1、K3、K4-V | Core 独立验收、单任务收口、Linux 验证隔离与受控提交已验证 | Adapter 仍须证明实际 Worker 权限与静止；宿主能力归 G6 / G8 |
| G4 持久性与恢复 | R0、K1、K3-L、K3-R | 设计已解决 | 实现锁 / CAS / pending intent / reconcile 与进程崩溃测试；不泛化断电保证 |
| G5 DSH 等价范围 | R0、K6 | 用户已确认；映射清单已完成 | K6 证明通用行为等价；旧流程与旧 Run 留在旧实现 |
| G6 平台格式与能力 | R1、各平台任务 | 六类格式与最小 fixture 已取证；生产校验与宿主能力仍缺 | 针对目标版本固定规范与 fixture；启用 Executor 另需实际能力证据 |
| G7 构建与分发规则 | R0、K1、K10-B、K10 | 设计已确定；分发许可材料仍缺 | 落地版本与可重复构建；对外分发前取得项目许可与随包声明 |
| G8 实测环境与证据 | R1、K3-L、K5、K6、K10 | WSL2 工程验证通过；原生 OS、插件 smoke 与 Executor 未验证 | OS / 宿主实际可运行且对应验收有可追溯证据 |

## 8. 验收口径

- Core 的 Orchestrator / State / Authorization / Snapshot / Recovery 只有一套；新增平台不复制流程。
- Codex 与 DSH 对同一三任务依赖链均使用新 Session；commit-each 与 no-commit 遵循统一授权；漂移、异常和中断均有负向测试。
- 五平台与 Portable 产物由源码统一生成；本地 dry-run 和 hash manifest 可复现；平台能力矩阵来自证据。
- 若仅离线验证通过，记录为对应任务的部分证据，不能宣称完整 MVP 完成。

## 9. 维护规则

- 状态、优先级、依赖、执行顺序和阻塞只在本文件维护；任务文件只维护实施与验收详情。
- 规划中的任务在目标、来源、不变量、验收、验证方法与未决问题足够明确后，才能转为待执行；ready 任务须在工作顺序中恰好出现一次。
- 开始或恢复任务前记录实际 Git HEAD、Dashboard / Task 哈希及原有工作区修改；若尚无提交，明确记录 unborn HEAD，不伪造提交基线。
- 更新计划或收口前重算快照，外部漂移先重读权威文件；归档、Dashboard 更新和链接修复作为一次完整生命周期变更。
- 完成需要实现和验证证据，按 M0 / M1 / M2 / M3 归档；旧 DSH 的已完成编号与本项目编号属于不同项目，不能继承。
- 不把日期、工时或资源能力写成未经确认的承诺。

---

*最后更新：2026-09-17（K4 归档，M1 收口；下一项 K10-B）*
