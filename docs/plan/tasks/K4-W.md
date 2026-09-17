# 任务 K4-W：共享 Worker 与父上下文输出

> 本文只维护该任务的实施与验收详情。状态、优先级、依赖、执行顺序和阻塞以 [Dashboard](../Dashboard.md) 为唯一权威来源。

## 背景与目标

提供唯一的 run / status / worker Skill 源码与紧凑结果出口，让宿主转换不改变业务语义。

## 执行上下文

- **权威需求**：[设计文档](../../../../dev-harness-runtime-design.md) §16–17、§27、§34–35；[资料评估](../Readiness.md)。
- **公共实施依据**：[CONTRACTS](../../CONTRACTS.md)、[R0 决策](../../decisions/runtime-contracts.md)、[DSH 迁移边界](../../DSH_MIGRATION.md)。
- **代码入口**：从下列影响文件进入。初始化时目标项目为空，所列实现与测试路径均为建议新建路径，不能当作已有代码。
- **相关测试**：prompt fixture、环境传播与递归入口测试、长日志下的摘要输出测试。
- **必须保持的不变量**：一次只执行一个 Task；不自动领取下一任务；完整日志进入唯一私有状态根。


## 范围

- **包含**：单 Task Worker prompt、四个环境标记、禁止递归的入口检查、父上下文摘要字段和私有日志引用。
- **不包含**：给每个平台复制业务流程；向父上下文回灌完整日志、源码和 JSONL。

## 影响文件

以下路径以 `dev-harness-runtime/` 为根；执行前核对已建立的目录与命令，已有文件按职责更新。

- `skills/run/SKILL.md`
- `skills/status/SKILL.md`
- `skills/worker/SKILL.md`
- `packages/core/src/worker/`
- `packages/core/tests/worker/`

## 建议实施顺序

1. 重读 Dashboard 与本任务，检查来源是否漂移；从资料评估对应条目和已形成的决策记录确认输入。
2. 先建立本任务验收所列的正常、异常和边界样例，再在范围内实现或完成决策取证；不为迁就实现修改公共协议。
3. 按下列验收逐项验证，记录真实命令、环境、结果和稳定证据；更新相关事实文档，再按 Planning 生命周期收口。

## 验收标准

- [ ] 三个 Skill 源码各只有一份；Worker 指向 AGENTS、HARNESS、Dashboard 和当前 Task。
- [ ] DEV_HARNESS_WORKER=1 时所有 dhr run 模式、resume 和 reconcile 被拒绝；Worker 无提交权限。
- [ ] 摘要只包含 §34 允许字段；日志引用指向存在的私有文件。

## 验证证据

| 验证项 | 命令 / 操作 | 结果 / 证据链接 |
|---|---|---|
| 本任务验收 | prompt fixture、环境传播与递归入口测试、长日志下的摘要输出测试。 | 尚未执行；交付时记录真实结果与稳定证据。 |
| 共享回归 | 采用 Dashboard 的共享验证基线与届时 HARNESS 已验证入口 | 尚未执行；当前无 Runtime 实现或命令通过记录。 |

## 已确认决策

- 项目名 `dev-harness-runtime`，CLI 全部使用 `dhr`。
- 状态根目录统一为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`；具体布局以设计 §10 为准。
- 一次只执行一个 Task；不自动领取下一任务；完整日志进入唯一私有状态根。

## 未知项与停止条件

- **已知风险**：来源升级、接口不完整或环境不足可能使验收不可复现；不能将设计示例或历史通过记录当作本次运行证据。
- **未决问题**：协议来源锁定按 [R0 决策](../../decisions/runtime-contracts.md)；Worker 缩窄授权、摘要与递归门禁按 [CONTRACTS](../../CONTRACTS.md)。
- **停止条件**：需要扩大范围、改变公共语义或验收、使用无证据宿主能力，或发现 Git / Planning 外部漂移时停止实现，回到 Dashboard 对齐。

---

*最后更新：2026-09-17（接入 R0 已确定契约，尚未开始实现）*
