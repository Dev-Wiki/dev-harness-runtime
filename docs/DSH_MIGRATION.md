# DSH 通用行为迁移边界

本文定义 `dev-harness-runtime` 的 DSH 适配范围、公共 Core 行为与兼容性边界，不维护开发进度。公共协议见 [CONTRACTS](CONTRACTS.md)，原因见 [公共契约决策](decisions/runtime-contracts.md)，任务入口见 [Dashboard](plan/Dashboard.md)。

## 1. 已确认范围

Runtime 使用 Planning Task 模型执行任务，公共 Core 承担通用运行机制。Audit → Router → Auto Fix → Full Verification → QA → Final Reconciliation → Report 不属于内建自动流水线。

Runtime 不读取或自动转换历史 Run。旧 Run schema v5 不作为新协议 v1 的早期版本，不提供原地覆盖、复制目录后续跑或自动导入。

新 DSH Adapter 的目标宿主为 `0.1.5-rc.1`，依据用户提供的本机版本输出。旧 `0.1.0-rc.8` 只用于历史行为对照；所有公开 API、组件依赖、安装和运行能力必须在新目标版本重新取得证据。

历史对照采用的源码提交为 `cb53f228246a39ef8fd2ebcf372b60e0f1cffbf6`。以下旧入口与测试名仅为该基线的历史记录，不要求保留外部源码 checkout；当前实现与测试均以本仓库为准。选定旧测试 36/36、新 Core 对应专项在真实 bubblewrap 下 216/216 已分别执行，均无跳过。它们仍不能代替 DSH rc.1 Executor 等价证明。详见 [K6 当前验证](verification/K6.md)。

## 2. 通用行为映射

| 通用行为 | 历史实现入口（记录） | 当前实现责任 | 需要证明的保持性质 |
|---|---|---|---|
| 状态 schema 与 revision CAS | `state.ts`：parseRunState、readStateFile、writeStateFile、updateRun | Core state；K1 / K3-L | 不接受未知 schema，revision 冲突不能覆盖较新状态，读取不接受半份 JSON |
| worktree 身份与互斥 | state.ts：captureRepositoryIdentity、resolveStateRoot、createRun | Core discovery / lock；K2 / K3-L | 主仓与 linked worktree 状态隔离，同一 worktree 最多一个 owner |
| 内容快照与漂移检查 | state.ts：fingerprintWorktree、captureWorktreeBoundary、captureContextFingerprint、captureDependencies、validateResume | Core snapshot / recovery；K3 / K3-R | HEAD、index、原有修改、治理文档和依赖变化不能静默采纳；新增 Planning 与 Executor 输入快照 |
| 精确变更边界 | state.ts：diffWorktreeBoundaries、adoptWorktreeBoundary | Core snapshot / result；K3 / K4-V | 实际变更集、允许范围和可信操作证据一致，不能仅信 changedFiles |
| 不可变 Run 授权 | `authorization.ts`：createRunAuthorization、assertExternalActionAuthorized；state.ts：assertImmutable | Core authorization；K4-V | 默认 no-commit，所有外部动作独立禁止，resume 不扩权 |
| 独立提交核验 | state.ts：adoptCommitBoundary；`orchestrator.ts`：assertCommittedAutoFixWorkspace | Core Git 桥接与 result；K4-V | 精确 parent、tree、路径、HEAD、工作区边界；新协议由 Core 在独立验证后提交 |
| 派发前持久化意图 | orchestrator.ts：advanceAuditRun、advanceRemediationRun、advanceFullVerification | Core orchestrator / recovery；K3-R / K4 | 先持久化身份与允许范围，再发生副作用；恢复不猜测未知中间态 |
| 验证身份与静止边界 | `verification.ts`：validateFullVerificationObservation；orchestrator.ts：assertMonotonicVerification、assertReadOnlyVerificationWorkspace | Core result / verification；K4-V | 可信命令来自项目 HARNESS，验证结果绑定确切快照，验证不得改变未授权项目内容 |
| 摘要由权威证据派生 | `report.ts`：createRunSummary、validateRunSummary、assertRunSummaryMatchesState | Core result / summary；K4-W / K4 | 不回灌完整对话，不允许无证据成功，摘要引用真实持久记录 |

这些映射复用行为性质和测试思路，不意味着直接复制旧文件。新 Core 不导入 `@deepseek-ai/dsh-*`；若旧原语有价值，必须提取为宿主无关接口或用跨平台实现替换，并证明相应性质。

## 3. 测试对照清单

| 对照目标 | 历史测试记录 | 当前验证入口与额外差异 |
|---|---|---|
| CAS 与状态转移 | `state.test.mjs`：`serializes revision updates and enforces phase and terminal transitions` | packages/core/tests/state；使用新 Task phase/status，不复制旧枚举 |
| 非法状态与冲突 | state.test.mjs：`rejects duplicate active runs, invalid ids, corrupt state, and symlink state files` | packages/core/tests/state、lock；新增 owner identity 与受控 stale 回收 |
| linked worktree 隔离 | state.test.mjs：`isolates primary and linked worktree run namespaces` | packages/core/tests/state；新状态根和 run.json 布局 |
| HEAD / 工作区 / 依赖漂移 | state.test.mjs：`fails closed on worktree, HEAD, lockfile, and runtime dependency drift` | packages/core/tests/snapshot、recovery；新增 Dashboard、Task、归档依赖和协议来源 |
| 显式文档变更边界 | state.test.mjs：`accepts one explicit docs mutation boundary without weakening later drift checks` | packages/core/tests/snapshot；只允许当前任务收口，其他任务行不得变动 |
| 默认授权和拒绝扩权 | `authorization.test.mjs`：`defaults to fix-only and maps only explicit commit-each to commit mode`；`rejects implicit expansion and every independently authorized external action` | packages/core/tests/authorization；对齐 no-commit / commit-each 的新语义和 Worker 缩窄授权 |
| 拒绝越界修改 | `remediation.test.mjs`：`rejects undeclared changes and retains the open mutation lease` | packages/core/tests/result；保留失败现场与 pending intent |
| 提交精确性 | remediation.test.mjs：`rejects a downstream commit containing undeclared files and retains its lease` | packages/core/tests/authorization；Core 桥接范围核验以及 Worker 非法提交拒绝 |
| 下游崩溃后重入 | `orchestrator.test.mjs`：`an OPEN Audit lease recovers after the Adapter wrote outputs and crashed`；remediation.test.mjs：`recovers an idempotent start after the Adapter wrote a fix and crashed` | packages/core/tests/recovery；新 Task 使用新 attempt / Session，不能继承旧 Conversation |
| 验证证据有效性 | `verification-contract.test.mjs`：`requires the canonical full command, exact snapshot identity, and fresh terminal evidence` | tests/contract；命令由目标 HARNESS 提供，不硬编码 npm run harness:full |
| 验证工作区边界 | `verification.test.mjs`：`rejects verification worktree mutations and retains the OPEN lease` | packages/core/tests/result；明确允许生成物，拒绝源码、计划与 index 变化 |
| 不一致成功声明 | `report.test.mjs`：`refuses incomplete QA, verification, reconciliation, and inconsistent overall claims` | packages/core/tests/result；改用 Task acceptance + Planning closure，不要求旧 QA / Finding 字段 |

本表逐项记录保持性质、旧入口、新位置和新模型差异；旧、新测试运行数量及后续 rc.1 宿主 Task Executor parity 分别记录在 [K6 验证](verification/K6.md)。旧测试数量不能直接继承给新 Adapter；新宿主已另以未替换 Worker Skill 跑通合成 A→B→C 依赖链、三个独立 Session 和三次 Core 受控提交。

## 4. 留在 Adapter 的宿主逻辑

- Cordis plugin 注入、注册和 lifecycle / disposer。
- DSH Human Command、Agent / Session 创建、取消、等待静止、事件转换。
- Workflow API 的宿主差异由 Adapter 评估；当前 Worker 作用域不暴露原生 Workflow 工具，Task 顺序和恢复由 Core 实现，不另建产品状态机。
- DSH host detection、`0.1.5-rc.1` 能力探测、结构化结果翻译和 Session 身份证据。
- Bundle / manifest、实际组件依赖和安装卸载机制。

Adapter 不拥有自己的 Task 选择、Planning 状态、Snapshot 算法、Run Authorization、Recovery 或完整 Orchestrator。探测不能强制执行 Core 的权限边界时，不启用自动 Executor；不能用 prompt 约束代替宿主证明。

## 5. 不迁移的旧产品语义

| 旧内容 | 首版处理 |
|---|---|
| Audit / Finding Router / 修复队列 / QA / Reconciliation / Report 产品流程 | 不作为 Runtime 内建流程；可执行项目明确规划的 Task，但不自动调度这些 phase |
| Finding ID、AutoFixRunRef、QaFinding、重试计数和旧完成条件 | 不进入公共 RunState；没有“一一更名即可迁移”的字段映射 |
| ctx.agents.resume 与旧 JSONL 对话恢复 | 不提供旧对话恢复；Runtime 按可信检查点恢复，需继续 Worker 工作时创建 fresh session |
| 旧 fix-only / commit-each 授权对象 | 不直接复用 schema；新 RunAuthorization 与 Worker 缩窄授权按 CONTRACTS 定义 |
| 旧硬编码 canonical full 命令 | 不进入 Core；统一消费各项目 HARNESS |
| 旧 state.json 与 schema v5 | 不支持导入、覆盖或转换 |

## 6. 旧 Run 与能力边界

历史状态不属于当前 Runtime 的读取入口。新 Runtime 的唯一状态根仍为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`，唯一 Run 状态仍为 `<run-id>/run.json`。迁移文档仅描述旧文件类型，不引入第二个新状态根。

旧 `state.ts` 固定 `RUN_STATE_SCHEMA_VERSION = 5`，parseRunState 只接受该值；没有通用 schema upgrade/import 链。旧 JSON 不能自动注册为 Runtime Run。对误输入的新格式或旧格式错误，保持原文件字节不变并返回明确错误。

历史 rc.8 基线曾记录多进程加锁更新和完整 JSON 读取；同时注明 atomic-write 不承诺 fsync crash durability、orphan lock 由操作员处理。新 Core 必须自行证明跨平台进程中断恢复和锁策略，不能把这些未保证性质写成迁移继承能力。

旧系统有 stable downstream identity 与幂等 start / resume，但不等于任意 TaskExecutor 的副作用恰好一次。新系统按 CONTRACTS 的持久意图和可信检查点恢复；无法证明的中间态停下。

## 7. 适配验收与维护边界

1. 公共 Fake Executor 契约先通过，再验证 DSH `0.1.5-rc.1` 的宿主集成。
2. 同一三任务项目分别由 Codex / DSH 执行，Core 状态、授权、快照、恢复和收口门禁一致；每个 Task 的宿主 Session 身份不同。
3. 覆盖 completed / blocked / failed / partial、取消、非法结果、越界变化、授权违规及恢复后 fresh session。
4. 对照清单中的保持性质由本仓库 Core 与 Adapter 测试证明；不要求 Runtime 复现完整 Audit / QA 产品路径。
5. DSH 的实现、平台基线与后续验证统一在本仓库维护；历史行为记录不作为外部仓库保留或继续维护的要求，也不代表完整产品功能替代。
