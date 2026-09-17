# 任务 K6-P：DSH Bundle 打包

> 本文只维护该任务的实施与验收详情。状态、优先级、依赖、执行顺序和阻塞以 [Dashboard](../Dashboard.md) 为唯一权威来源。

## 背景与目标

从统一源码生成 dsh 可安装产物，并提供对应格式校验和安装说明。

## 执行上下文

- **权威需求**：[设计文档](../../design/runtime-design.md) §19.2、§25、§38、§41、§45 K6；[资料评估](../Readiness.md)。
- **平台输入**：[R1 平台基线](../../integration/PLATFORM_BASELINE.md)、[fixture 与离线命令](../../../tests/fixtures/platform-specs/README.md)。
- **代码入口**：从下列影响文件进入。初始化时目标项目为空，所列实现与测试路径均为建议新建路径，不能当作已有代码。
- **相关测试**：最小 fixture 与真实生成目录逐项比较；解包后检查引用、Skill 和 runtime 资源；宿主可用时隔离安装、发现、调用 smoke、卸载。
- **必须保持的不变量**：业务流程保持共享；最终包不依赖开发机绝对路径；未通过 probe 的能力不启用。


## 范围

- **包含**：DSH lib、package.json、cordis.patch.yml 与 tgz；doctor / probe 明确区分打包能力和执行能力；静态 validator 与 golden tree。
- **不包含**：增加独立 Orchestrator；未经实测启用自动 Session 编排；自动提交 Marketplace。

## 影响文件

以下路径以 `dev-harness-runtime/` 为根；执行前核对已建立的目录与命令，已有文件按职责更新。

- `packages/adapter-dsh/src/`
- `packages/adapter-dsh/tests/`
- `build/targets/dsh.ts`
- `tests/fixtures/expected/dsh/`

## 建议实施顺序

1. 重读 Dashboard 与本任务，检查来源是否漂移；从资料评估对应条目和已形成的决策记录确认输入。
2. 先建立本任务验收所列的正常、异常和边界样例，再在范围内实现或完成决策取证；不为迁就实现修改公共协议。
3. 按下列验收逐项验证，记录真实命令、环境、结果和稳定证据；更新相关事实文档，再按 Planning 生命周期收口。

## 验收标准

- [ ] 产物树、manifest、版本、依赖、Skill 数量和资源引用通过静态与 golden 验证。
- [ ] 缺少必需文件、非法字段、绝对本机路径、重复 Skill 和版本不一致均失败。
- [ ] 安装说明使用原生机制；宿主 smoke 与离线校验分别报告，缺少宿主不得记为通过。
- [ ] Bundle、依赖声明及安装 / 发现 / 卸载在 DSH `0.1.5-rc.1` 上验证；实际组件版本来自该宿主的依赖解析与公开接口依据。

## 验证证据

| 验证项 | 命令 / 操作 | 结果 / 证据链接 |
|---|---|---|
| 本任务验收 | 最小 fixture 与真实生成目录逐项比较；解包后检查引用、Skill 和 runtime 资源；宿主可用时隔离安装、发现、调用 smoke、卸载。 | 尚未执行；交付时记录真实结果与稳定证据。 |
| 共享回归 | 采用 Dashboard 的共享验证基线与届时 HARNESS 已验证入口 | 尚未执行；当前无 Runtime 实现或命令通过记录。 |

## 已确认决策

- 项目名 `dev-harness-runtime`，CLI 全部使用 `dhr`。
- DSH 目标宿主固定为 `0.1.5-rc.1`，以设计 §19.2 为准；rc.8 仅作历史迁移参考。
- 状态根目录统一为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`；具体布局以设计 §10 为准。
- 业务流程保持共享；最终包不依赖开发机绝对路径；未通过 probe 的能力不启用。

## 未知项与停止条件

- **已知风险**：来源升级、接口不完整或环境不足可能使验收不可复现；不能将设计示例或历史通过记录当作本次运行证据。
- **未决问题**：Bundle 字段与本机 rc.1 启动器 / rc.2 组件已取证；完整依赖锁、tgz 安装和生命周期兼容性尚待本任务验证。
- **停止条件**：需要扩大范围、改变公共语义或验收、使用无证据宿主能力，或发现 Git / Planning 外部漂移时停止实现，回到 Dashboard 对齐。

---

*最后更新：2026-09-17（固定 DSH 0.1.5-rc.1 打包与安装验收目标）*
