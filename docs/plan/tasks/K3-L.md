# 任务 K3-L：实现私有状态、原子写入与互斥锁

> 本文只维护该任务的实施与验收详情。状态、优先级、依赖、执行顺序和阻塞以 [Dashboard](../Dashboard.md) 为唯一权威来源。

## 背景与目标

保证同一 worktree 只有一个 active orchestrator，状态更新不会因并发和中断静默丢失。

## 执行上下文

- **权威需求**：[设计文档](../../design/runtime-design.md) §10–11、§35、§45 K3；[资料评估](../Readiness.md)。
- **公共实施依据**：[CONTRACTS](../../CONTRACTS.md)、[R0 决策](../../decisions/runtime-contracts.md)、[DSH 迁移边界](../../DSH_MIGRATION.md)。
- **代码入口**：已有 contracts 的 RunState / LockMetadata 校验、core/discovery 的 privateGitDir / stateRoot 以及 K3 快照 API；state / lock 实现仍需新建。
- **相关测试**：多进程写入争用、revision 冲突、半写与进程退出故障注入、linked worktree 隔离。
- **必须保持的不变量**：唯一状态根为 $(git rev-parse --git-path dev-harness-runtime)/runs/；状态不进入 worktree 或 Git 提交。


## 范围

- **包含**：Git private state 路径、Run / attempt 持久化、schemaVersion、revision CAS、原子写入、锁 owner 与 stale lock 处置。
- **不包含**：用 Unix-only 锁作为唯一实现；按 PID 或过期时长猜测后删除锁。

## 影响文件

以下路径以 `dev-harness-runtime/` 为根；执行前核对已建立的目录与命令，已有文件按职责更新。

- `packages/core/src/state/`
- `packages/core/src/lock/`
- `packages/core/tests/state/`
- `packages/core/tests/lock/`

## 建议实施顺序

1. 重读 Dashboard 与本任务，检查来源是否漂移；从资料评估对应条目和已形成的决策记录确认输入。
2. 先建立本任务验收所列的正常、异常和边界样例，再在范围内实现或完成决策取证；不为迁就实现修改公共协议。
3. 按下列验收逐项验证，记录真实命令、环境、结果和稳定证据；更新相关事实文档，再按 Planning 生命周期收口。

## 验收标准

- [ ] 并发启动最多一个 owner；CAS 冲突不会覆盖较新状态。
- [ ] 每个 Run 仅以 `<run-id>/run.json` 为权威状态文件；同级 attempts/ 保存日志、results/ 保存执行结果、summary.json 保存派生摘要，不形成第二份 Run 状态。
- [ ] 主仓与 linked worktree 独立；Windows / Linux / WSL 的差异被实测或明确报告。
- [ ] 中断后可识别完整状态或可恢复旧状态；stale lock 处理遵循明确 owner 校验。

## 验证证据

| 验证项 | 命令 / 操作 | 结果 / 证据链接 |
|---|---|---|
| 本任务验收 | 多进程写入争用、revision 冲突、半写与进程退出故障注入、linked worktree 隔离。 | 尚未执行；交付时记录真实结果与稳定证据。 |
| 共享回归 | 采用 Dashboard 的共享验证基线与届时 HARNESS 已验证入口 | K3 全套回归已通过；状态与锁尚未实现，需本任务独立取证。 |

## 已确认决策

- 项目名 `dev-harness-runtime`，CLI 全部使用 `dhr`。
- 状态根目录统一为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`；具体布局以设计 §10 为准。
- 唯一状态根为 $(git rev-parse --git-path dev-harness-runtime)/runs/；状态不进入 worktree 或 Git 提交。

## 未知项与停止条件

- **已知风险**：来源升级、接口不完整或环境不足可能使验收不可复现；不能将设计示例或历史通过记录当作本次运行证据。
- **未决问题**：进程崩溃保证、锁 owner、CAS 与人工处置边界按 [CONTRACTS §5](../../CONTRACTS.md#5-run-状态日志与锁) 实施；断电保证不得由设计推定。
- **停止条件**：需要扩大范围、改变公共语义或验收、使用无证据宿主能力，或发现 Git / Planning 外部漂移时停止实现，回到 Dashboard 对齐。

---

*最后更新：2026-09-17（接入 R0 已确定契约，尚未开始实现）*
