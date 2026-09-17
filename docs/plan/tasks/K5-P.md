# 任务 K5-P：Codex Plugin 与 Marketplace 打包

> 本文只维护该任务的实施与验收详情。状态、优先级、依赖、执行顺序和阻塞以 [Dashboard](../Dashboard.md) 为唯一权威来源。

## 背景与目标

从统一源码生成 codex 可安装产物，并提供对应格式校验和安装说明。

## 执行上下文

- **权威需求**：[设计文档](../../../../dev-harness-runtime-design.md) §19.1、§25、§41、§45 K5；[资料评估](../Readiness.md)。
- **平台输入**：[R1 平台基线](../../integration/PLATFORM_BASELINE.md)、[fixture 与离线命令](../../../tests/fixtures/platform-specs/README.md)。
- **代码入口**：从下列影响文件进入。初始化时目标项目为空，所列实现与测试路径均为建议新建路径，不能当作已有代码。
- **相关测试**：最小 fixture 与真实生成目录逐项比较；解包后检查引用、Skill 和 runtime 资源；宿主可用时隔离安装、发现、调用 smoke、卸载。
- **必须保持的不变量**：业务流程保持共享；最终包不依赖开发机绝对路径；未通过 probe 的能力不启用。


## 范围

- **包含**：Codex plugin 目录、Marketplace source 布局及 ZIP；doctor / probe 明确区分打包能力和执行能力；静态 validator 与 golden tree。
- **不包含**：增加独立 Orchestrator；未经实测启用自动 Session 编排；自动提交 Marketplace。

## 影响文件

以下路径以 `dev-harness-runtime/` 为根；执行前核对已建立的目录与命令，已有文件按职责更新。

- `packages/adapter-codex/src/`
- `packages/adapter-codex/tests/`
- `build/targets/codex.ts`
- `tests/fixtures/expected/codex/`

## 建议实施顺序

1. 重读 Dashboard 与本任务，检查来源是否漂移；从资料评估对应条目和已形成的决策记录确认输入。
2. 先建立本任务验收所列的正常、异常和边界样例，再在范围内实现或完成决策取证；不为迁就实现修改公共协议。
3. 按下列验收逐项验证，记录真实命令、环境、结果和稳定证据；更新相关事实文档，再按 Planning 生命周期收口。

## 验收标准

- [ ] 产物树、manifest、版本、依赖、Skill 数量和资源引用通过静态与 golden 验证。
- [ ] 缺少必需文件、非法字段、绝对本机路径、重复 Skill 和版本不一致均失败。
- [ ] 安装说明使用原生机制；宿主 smoke 与离线校验分别报告，缺少宿主不得记为通过。

## 验证证据

| 验证项 | 命令 / 操作 | 结果 / 证据链接 |
|---|---|---|
| 本任务验收 | 最小 fixture 与真实生成目录逐项比较；解包后检查引用、Skill 和 runtime 资源；宿主可用时隔离安装、发现、调用 smoke、卸载。 | 尚未执行；交付时记录真实结果与稳定证据。 |
| 共享回归 | 采用 Dashboard 的共享验证基线与届时 HARNESS 已验证入口 | 尚未执行；当前无 Runtime 实现或命令通过记录。 |

## 已确认决策

- 项目名 `dev-harness-runtime`，CLI 全部使用 `dhr`。
- 状态根目录统一为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`；具体布局以设计 §10 为准。
- 业务流程保持共享；最终包不依赖开发机绝对路径；未通过 probe 的能力不启用。

## 未知项与停止条件

- **已知风险**：来源升级、接口不完整或环境不足可能使验收不可复现；不能将设计示例或历史通过记录当作本次运行证据。
- **未决问题**：格式与最小样例见平台基线；尚需完整生产字段校验、两种 manifest 的目标宿主选择、离线 runtime bundle 及安装后路径测试。
- **停止条件**：需要扩大范围、改变公共语义或验收、使用无证据宿主能力，或发现 Git / Planning 外部漂移时停止实现，回到 Dashboard 对齐。

---

*最后更新：2026-09-17（依据设计初始化执行包，未开始实现）*
