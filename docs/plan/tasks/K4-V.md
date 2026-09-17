# 任务 K4-V：执行结果、授权与收口验证

> 本文只维护该任务的实施与验收详情。状态、优先级、依赖、执行顺序和阻塞以 [Dashboard](../Dashboard.md) 为唯一权威来源。

## 背景与目标

在继续下一个任务前独立确认执行结果、验证证据和计划收口符合当前授权。

## 执行上下文

- **权威需求**：[设计文档](../../design/runtime-design.md) §9、§13、§15、§30、§37；[资料评估](../Readiness.md)。
- **公共实施依据**：[CONTRACTS](../../CONTRACTS.md)、[R0 决策](../../decisions/runtime-contracts.md)、[DSH 迁移边界](../../DSH_MIGRATION.md)。
- **代码入口**：从下列影响文件进入。初始化时目标项目为空，所列实现与测试路径均为建议新建路径，不能当作已有代码。
- **相关测试**：伪造成功、跨 attempt 结果、证据缺失、未授权 commit、混入用户修改和不完整归档的失败 fixture。
- **必须保持的不变量**：push / PR / tag / release / deploy 保持 false；Worker 返回值不能成为唯一完成证据。
- 参考 [Git Workflow Skill](../../../../dev-harness/git-workflow/SKILL.md) 与 [旧授权测试](../../../../dev-harness-dsh/tests/authorization.test.mjs)。

## 范围

- **包含**：结果身份与 schema 校验、verification 证据核验、计划生命周期、commit-each / no-commit 的实际提交边界验证。
- **不包含**：仅凭 completed 文本关闭任务；复制 Git Workflow 的提交策略。

## 影响文件

以下路径以 `dev-harness-runtime/` 为根；执行前核对已建立的目录与命令，已有文件按职责更新。

- `packages/core/src/result/`
- `packages/core/src/authorization/`
- `packages/core/tests/result/`
- `packages/core/tests/authorization/`

## 建议实施顺序

1. 重读 Dashboard 与本任务，检查来源是否漂移；从资料评估对应条目和已形成的决策记录确认输入。
2. 先建立本任务验收所列的正常、异常和边界样例，再在范围内实现或完成决策取证；不为迁就实现修改公共协议。
3. 按下列验收逐项验证，记录真实命令、环境、结果和稳定证据；更新相关事实文档，再按 Planning 生命周期收口。

## 验收标准

- [ ] 结果、实际文件变化、验收证据和计划收口一致才接受 completed。
- [ ] 授权在创建 Run 后不可被放大，resume 不能扩大权限。
- [ ] Core 在独立验证后按项目 Git Workflow 精确提交；commitSha、parent、tree、内容范围与当前 HEAD 相符；Worker、验证进程和 hook 的权限边界均可强制执行。

## 验证证据

| 验证项 | 命令 / 操作 | 结果 / 证据链接 |
|---|---|---|
| 本任务验收 | 伪造成功、跨 attempt 结果、证据缺失、未授权 commit、混入用户修改和不完整归档的失败 fixture。 | 尚未执行；交付时记录真实结果与稳定证据。 |
| 共享回归 | 采用 Dashboard 的共享验证基线与届时 HARNESS 已验证入口 | 尚未执行；当前无 Runtime 实现或命令通过记录。 |

## 已确认决策

- 项目名 `dev-harness-runtime`，CLI 全部使用 `dhr`。
- 状态根目录统一为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`；具体布局以设计 §10 为准。
- push / PR / tag / release / deploy 保持 false；Worker 返回值不能成为唯一完成证据。

## 未知项与停止条件

- **已知风险**：来源升级、接口不完整或环境不足可能使验收不可复现；不能将设计示例或历史通过记录当作本次运行证据。
- **未决问题**：Worker / Core 责任、可信验证、单任务收口和 Core 提交已在 [CONTRACTS §3–4](../../CONTRACTS.md#4-所有权验证与提交) 定义。
- **停止条件**：需要扩大范围、改变公共语义或验收、使用无证据宿主能力，或发现 Git / Planning 外部漂移时停止实现，回到 Dashboard 对齐。

---

*最后更新：2026-09-17（接入 R0 已确定契约，尚未开始实现）*
