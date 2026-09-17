# 任务 K3-R：实现 Run 恢复与中断重入

> 本文只维护该任务的实施与验收详情。状态、优先级、依赖、执行顺序和阻塞以 [Dashboard](../Dashboard.md) 为唯一权威来源。

## 背景与目标

从持久 Run 与当前项目实况恢复执行，避免重新使用旧对话或重复提交已完成任务。

## 执行上下文

- **权威需求**：[设计文档](../../design/runtime-design.md) §10–12、§17、§45 K3；[资料评估](../Readiness.md)。
- **公共实施依据**：[CONTRACTS](../../CONTRACTS.md)、[R0 决策](../../decisions/runtime-contracts.md)、[DSH 迁移边界](../../DSH_MIGRATION.md)。
- **代码入口**：已有 core/snapshot、state、lock；恢复模块尚未建立。RunState.repoIdentity 固定创建身份，当前 Git 边界须读取 acceptedSnapshot。需补持锁诊断读取 / 枚举和无 Task 的初始证据初始化，不能伪造 attempt。
- **相关测试**：在 execute、result、计划收口、commit、state persist 边界注入崩溃后启动新的 Fake Executor。
- **必须保持的不变量**：恢复 Run 必须新建执行 Session；不能把已产生的副作用盲目重放。


## 范围

- **包含**：各 phase 的恢复决策、遗留 RUNNING 的中断判定、attempt 递增、锁接管、snapshot 重校验、结果与收口的恢复，以及 dhr reconcile 所用的显式人工对齐验证接口。
- **不包含**：恢复 Agent Conversation；忽略外部漂移强制继续。

## 影响文件

以下路径以 `dev-harness-runtime/` 为根；执行前核对已建立的目录与命令，已有文件按职责更新。

- `packages/core/src/recovery/`
- `packages/core/tests/recovery/`
- `docs/RECOVERY.md`

## 建议实施顺序

1. 重读 Dashboard 与本任务，检查来源是否漂移；从资料评估对应条目和已形成的决策记录确认输入。
2. 先建立本任务验收所列的正常、异常和边界样例，再在范围内实现或完成决策取证；不为迁就实现修改公共协议。
3. 按下列验收逐项验证，记录真实命令、环境、结果和稳定证据；更新相关事实文档，再按 Planning 生命周期收口。

## 验收标准

- [ ] 每个可中断阶段都有恢复、拒绝或人工处理的明确结果。
- [ ] HEAD / 计划 / dirty paths / Run 版本不匹配时拒绝并保留原始证据。
- [ ] 重复 resume 不重复提交或领取已完成任务；新 attempt 与旧证据可区分。
- [ ] 未接受的归档在新 Run 中同样触发 PENDING_RECONCILIATION；显式对齐只记录验证过的处置，不改写失败历史或 Planning。

## 验证证据

| 验证项 | 命令 / 操作 | 结果 / 证据链接 |
|---|---|---|
| 本任务验收 | 在 execute、result、计划收口、commit、state persist 边界注入崩溃后启动新的 Fake Executor。 | 尚未执行；交付时记录真实结果与稳定证据。 |
| 共享回归 | 采用 Dashboard 的共享验证基线与届时 HARNESS 已验证入口 | K3-L 已有 289 项完整回归通过；恢复任务按 Dashboard 节奏运行类型 / lint 与相关测试，M1 收口全量验证。 |

## 已确认决策

- 项目名 `dev-harness-runtime`，CLI 全部使用 `dhr`。
- 状态根目录统一为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`；具体布局以设计 §10 为准。
- 恢复 Run 必须新建执行 Session；不能把已产生的副作用盲目重放。

## 未知项与停止条件

- **已知风险**：来源升级、接口不完整或环境不足可能使验收不可复现；不能将设计示例或历史通过记录当作本次运行证据。
- **未决问题**：遗留 RUNNING、终态、partial、可信检查点和显式对齐已在 [CONTRACTS §5–6](../../CONTRACTS.md#6-崩溃恢复协议) 定义。
- **停止条件**：需要扩大范围、改变公共语义或验收、使用无证据宿主能力，或发现 Git / Planning 外部漂移时停止实现，回到 Dashboard 对齐。

---

*最后更新：2026-09-17（接入 R0 已确定契约，尚未开始实现）*
