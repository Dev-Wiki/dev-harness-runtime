# 公共 Runtime 契约决策

本文记录 R0 对设计缺口的处理决定和理由。字段、算法边界与异常语义以 [CONTRACTS.md](../CONTRACTS.md) 为准；DSH 迁移清单以 [DSH_MIGRATION.md](../DSH_MIGRATION.md) 为准。任务状态只在 [Dashboard](../plan/Dashboard.md) 维护。

这些是实施前的设计决定，不是 Runtime 已实现或已通过测试的声明。后续若发现无法满足不变量，应修改本决策并同步受影响执行包，不能由 Adapter 自行放宽。

## 1. 来源与已确认约束

- [原始设计](../design/runtime-design.md) §5–18、§22–28、§37–40、§45–47 定义架构和范围；其中 TypeScript 片段是设计示例，完整公共契约由本次文档细化。
- 上游协议基线为本地 `dev-harness` 提交 `1ed830aa0d696b52dbd666118ced475f4d6e8f79`，`VERSION` 为 `1.11.8`。引用 [Planning](../../../dev-harness/planning/SKILL.md)、[Commands](../../../dev-harness/commands/SKILL.md)、[Git Workflow](../../../dev-harness/git-workflow/SKILL.md)；不能用本机已安装 Skill 的版本替代项目锁定来源。
- 旧 DSH 参考提交为 `cb53f228246a39ef8fd2ebcf372b60e0f1cffbf6`，仅作为迁移证据，不作为新公共协议。
- 用户已确认项目名 `dev-harness-runtime`、CLI `dhr`、唯一状态根 `$(git rev-parse --git-path dev-harness-runtime)/runs/`，以及 `<run-id>/run.json` 的唯一状态权威。
- 用户已确认 DSH 目标为 `0.1.5-rc.1`；首版只迁移通用机制，旧 Audit / 修复 / QA 流程留在旧仓；旧 Run 由旧实现读取，新 Runtime 不自动转换。
- 本仓库采用 `main` 上的 `single-branch`；身份和提交发布规则见 [Git 工作流](../GIT_WORKFLOW.md)。执行 R0 不包含提交或发布授权。

## 2. 决策清单

| 编号 | 对应缺口 | 决定 | 理由与来源 |
|---|---|---|---|
| D01 | G1 | TypeScript + Node.js ESM，pnpm workspace；公共 Core 不依赖 DSH 包 | 原始设计 §5、§43；消除宿主依赖向 Core 的传播 |
| D02 | G1 | 固定上游版本、提交和所用文件哈希；构建不读取任意最新安装 Skill | 原始设计 §6、§27；相同输入必须产生相同语义 |
| D03 | G1 | 根 ARCHITECTURE.md 管架构；docs/CONTRACTS.md 管公共接口；V0 将原设计迁入项目并修复链接 | 原始设计 §5 有两个架构入口，应避免双份正文 |
| D04 | G2 | 只接受上游 Planning 的一个明确 Markdown 子集；无法解析时拒绝自动运行 | 原始设计 §7；不从自然语言推断可执行资格 |
| D05 | G2 | explicit / next / all-ready 共用资格门禁；优先级不参与重排 | 原始设计 §7；显式指定任务也不能绕过证据与阻塞 |
| D06 | G3 | Worker 负责单任务修改、项目验收和按上游规则收口计划；Core 负责独立核验、可选提交及 Run 状态 | 原始设计 §15–16、§37；只有一个 Planning 生命周期写入方 |
| D07 | G3 | Worker 的 completed 是候选声明；Core 接受验证与收口后才记入 completedTasks | 原始设计 §13、§30、§34；不把自报结果当事实 |
| D08 | G3 | Run 授权不可扩张；Worker 不持有提交权限；Core 依据项目 Git Workflow 执行精确提交 | 原始设计 §9、§37；把提交安排在独立核验之后 |
| D09 | G4 | MVP 保证进程异常退出下的完整状态与保守恢复；断电持久性不作跨平台统一保证 | 原始设计 §10；旧实现明确未证明 fsync crash durability |
| D10 | G4 | 锁、CAS、持久操作意图和静止检查点先于副作用；未知中间态停下，不承诺任意工具副作用 exactly-once | 原始设计 §11–12；以可证明的当前状态决定恢复 |
| D11 | G5 | 迁移通用行为和验证性质，保留旧产品流程与旧 Run 读取实现 | 用户已确认；新 Task 模型与旧 Finding 模型不同 |
| D12 | G7 | Core protocol 从 1 开始；Adapter SemVer 独立；构建元数据和来源锁集中维护 | 原始设计 §25–28；宿主变动不迫使其他 Adapter 改版 |
| D13 | G7 | build 只编译，generate 只生成目录，validate 校验目录，pack 打包已验证目录；release dry-run 显式串联 | 原始设计 §24、§40；避免 build / generate 循环和隐式发布 |
| D14 | G7 | 首版只生成本地私有产物；分发前校验所含文件的许可来源，缺失即阻止分发 | 原始设计 §40；源码许可信息与发布动作不能靠推断补全 |

## 3. 工程和来源基线

V0 采用以下起点，精确版本写入 package.json / lockfile；不以“最新版”为输入：

| 项目 | 决定 | 当前证据与落地责任 |
|---|---|---|
| Node.js | 开发和首版 CI 使用 `24.15.0`；包 engines 首先限定 `>=24.15.0 <25` | 本次本地 `node --version` 返回 v24.15.0；V0 验证后才在 HARNESS 标为 confirmed |
| pnpm | `11.1.0` | 本次本地 `pnpm --version` 返回 11.1.0；V0 写 packageManager 与锁文件 |
| TypeScript / lint | 以旧项目锁定的 `typescript@6.0.3`、`oxlint@1.76.0` 为工程起点 | 来源为 [旧 package.json](../../../dev-harness-dsh/package.json)，不是本轮安装验证；V0 验证不兼容时回到本决策调整 |
| 单元测试 | 编译后的 ESM + `node:test`，不新增测试框架 | 可以在无宿主、无模型凭据时验证公共逻辑 |
| Git | 首版验证下限 `2.43.0` | 本次本地 Git 为 2.43.0；V0 必须用最低版本需要的命令验证 |
| 平台 | Windows、Linux、WSL 为设计支持目标；各自证据分开记录 | 本次只检查当前终端工具版本，未证明其他 OS 可用 |

类型声明必须覆盖 Node 24，不能照搬旧项目的 Node 26 类型并调用超出运行时基线的 API。V0 在 24 系列中选定精确的 `@types/node` 版本并验证锁文件；这属于依赖落地，不改变支持范围。

上游来源采用一个 `protocol-lock.json`（由 V0 建立），至少保存 `schemaVersion`、仓库标识、完整 commit、协议版本、所用文件的仓库相对路径与 SHA-256。上游工作树必须与锁定提交及文件摘要一致。开发时可显式传入本地 checkout 路径；路径本身不写入发布产物。离线构建使用锁定 checkout 或按同一摘要校验的缓存，不自动更新。

Runtime 自有的 `skills/run`、`skills/status`、`skills/worker` 是唯一可编辑源码。首版通过 doctor 检查目标项目所需 dev-harness 协议是否安装且兼容，不默认把整个上游仓库重新分发；如果某个平台确需随包包含上游文件，必须经过 K10-B 的来源和许可校验并记录清单。

V0 将工作区外原始设计移动到 `docs/design/runtime-design.md`，原路径只保留短导航，并修复所有入站和相对链接；不保存两个可变设计正文。R0 暂时保留原链接，执行本次任务不扩大为文档搬迁。根 `ARCHITECTURE.md` 是架构事实源，不再创建同内容的 `docs/ARCHITECTURE.md`。

## 4. Planning 与执行责任

Runtime 的 Reader 接受 [CONTRACTS §2](../CONTRACTS.md#2-planning-读取协议) 指定的语法。这个子集是自动化接入条件，不改变上游 Skill 允许人工维护的格式。非兼容计划可以继续人工使用，但 dhr 必须指出具体歧义而非猜测。

Worker 按锁定的上游 Planning 规则修改当前任务的验收证据、归档和 Dashboard。Core 不实现另一个 backlog 编辑器，不增加一个任务状态数据库。Core 只比较本次允许的单任务生命周期差异，并把被接受的运行检查点写进 run.json。

Worker 在宿主中只能写入本次授权范围，不能提交。Core 在 Worker 停止后重新取得项目实况、执行权威验证入口、核对收口和所有权，再根据本次 Run 授权决定是否调用 Git 提交桥接。桥接必须消费项目 Git Workflow 的已确认策略；无法解析策略或缺少明确提交信息时停下，不使用 Runtime 私有默认提交规则。

Worker 的计划收口可能先于 Core 接受。此时归档文件的存在不代表 Run 完成，Core 不选下一任务，新 Run 也不能把这份未接受归档当作历史完成证据。验证失败会保留现场和证据并停止；不自动覆盖已写文件。恢复只接受当前状态与持久操作意图、检查点一致的情况，不能通过“路径在 scope 内”就认定中断改动属于本任务。无法自动恢复时，由操作者先修复项目，再用 `dhr reconcile` 验证并记录处置；原 Run 的失败历史不改写。

## 5. 版本、打包与分发

开发起始 package version 使用 `0.1.0` 且 `private: true`；这不是发布完成声明。`coreProtocolVersion=1` 约束 request/result、snapshot、Run state、authorization 与 Adapter contract。MVP 只接受精确支持的协议版本；未知版本不自动迁移。向后不兼容变更增加协议整数。

Adapter 各自维护 SemVer 和支持的协议版本集合；releaseVersion 标识一组本地分发产物。统一元数据位于 `build/manifests/metadata.json`，来源锁位于 `protocol-lock.json`，两者由 K10-B 消费。平台 generator 只补必需格式字段，不改业务流程。

构建阶段严格单向：`verify → build → generate → validate:plugins → pack → hash/manifest`。pack 不隐式生成或修复输入；检测到旧生成内容或校验摘要不匹配即失败。CLI 的 dhr build / validate / pack 与脚本复用同一实现入口；dhr release --dry-run 执行完整顺序并只写本地输出。

每次构建记录源码提交（本地无提交时标明 local-unversioned）、协议来源摘要、工具链、Adapter 版本和目标格式版本。可分发 release 必须来自有提交标识且输入无漂移的源码；未提交状态可以做开发验证，不能被记录成可追溯 release。

路径排序、文本换行、JSON 字段顺序、ZIP/TAR 时间戳、权限与 UID/GID 均固定。时间戳从显式构建输入或提交时间取得，不能用当前时钟制造差异。每个产物记录 SHA-256；golden 更新只反映经过审阅的输入变化。

上游 README 标示 MIT，但本次未找到独立许可文件；不能据此在新仓创建猜测版权归属的 LICENSE。首版不新增对外发布承诺。K10 在任何对外分发前要求维护者提供本项目许可与实际包含的第三方声明；缺少时允许本地验证，阻止对外分发。此项是明确的分发门禁，不影响公共协议与本地工程实现。

## 6. 缺口处理结果与验证范围

G2、G3、G4 的设计语义由 CONTRACTS 定义；G5 由用户选择和 DSH_MIGRATION 定义。G1 已确定工程、来源和归属方案，物理脚手架与来源迁移交给 V0。G7 已确定流水线与版本规则，实际构建和分发证据交给 K10-B / K10。平台格式和宿主能力 G6、G8 继续由 R1 与对应实现任务取证。

设计走查和源码映射的证据见 [R0 验证记录](../verification/R0.md)。R0 的完成不表示上述 Runtime 行为已经实现，也不表示 DSH 0.1.5-rc.1 已验证。
