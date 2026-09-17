# 任务 K4-W：共享 Worker 与父上下文输出

> 本文只维护该任务的实施与验收详情。状态、优先级、依赖、执行顺序和阻塞以 [Dashboard](../../Dashboard.md) 为唯一权威来源。

## 背景与目标

提供唯一的 run / status / worker Skill 源码与紧凑结果出口，让宿主转换不改变业务语义。

## 执行上下文

- **权威需求**：[设计文档](../../../design/runtime-design.md) §16–17、§27、§34–35；[资料评估](../../Readiness.md)。
- **公共实施依据**：[CONTRACTS](../../../CONTRACTS.md)、[R0 决策](../../../decisions/runtime-contracts.md)、[DSH 迁移边界](../../../DSH_MIGRATION.md)。
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

- [x] 三个 Skill 源码各只有一份；Worker 指向 AGENTS、HARNESS、Dashboard 和当前 Task。
- [x] DEV_HARNESS_WORKER=1 时所有 dhr run 模式、resume 和 reconcile 被拒绝；Worker 无提交权限。
- [x] 摘要只包含 §34 允许字段；日志引用指向存在的私有文件。

## 验证证据

| 验证项 | 命令 / 操作 | 结果 / 证据链接 |
|---|---|---|
| 本任务验收 | prompt fixture、环境传播与递归入口测试、长日志下的摘要输出测试。 | 69 项相关 Node 测试、CLI 离线安装与三份 Skill 格式校验通过，见 [K4-W 验证记录](../../../verification/K4-W.md)。 |
| 共享回归 | 采用 Dashboard 的共享验证基线与届时 HARNESS 已验证入口 | 类型 / lint、编译和受影响状态回归通过；M1 收口执行全量。 |

## 已确认决策

- 项目名 `dev-harness-runtime`，CLI 全部使用 `dhr`。
- 状态根目录统一为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`；具体布局以设计 §10 为准。
- 一次只执行一个 Task；不自动领取下一任务；完整日志进入唯一私有状态根。

## 未知项与停止条件

- **已知风险**：来源升级、接口不完整或环境不足可能使验收不可复现；不能将设计示例或历史通过记录当作本次运行证据。
- **未决问题**：协议来源锁定按 [R0 决策](../../../decisions/runtime-contracts.md)；Worker 缩窄授权、摘要与递归门禁按 [CONTRACTS](../../../CONTRACTS.md)。
- **停止条件**：需要扩大范围、改变公共语义或验收、使用无证据宿主能力，或发现 Git / Planning 外部漂移时停止实现，回到 Dashboard 对齐。

---

*最后更新：2026-09-17（完成共享 Worker、日志与父上下文验收）*


## 完成验收结果

run / status / worker 各有唯一共享源码。Core 使用固定请求、校验过的 Skill 摘要和四个标记构造 Worker invocation；CLI 在模式解析前拒绝 Worker 的所有 run、resume、reconcile 入口。Worker 始终无提交权限，Skill 的成功候选须交 Core 独立验收。

私有日志由 Core 持锁逐块追加并流式核验引用；多 MiB 日志不回灌父上下文。八字段投影只读 run.json 和被接受结果，Worker completed、长 summary 或伪造 summary.json 不能改变状态。CLI 业务调度与真实宿主仍由后续任务接通。集成涉及 state 日志 API、CLI 门禁及 Core 导出；完整证据与支持限制见 [K4-W 记录](../../../verification/K4-W.md)。
