# 开发资料完整性评估

> 评估日期：2026-09-17。本文保存本次规划输入与缺口依据，不维护跨任务状态；处理顺序和解除条件以 [Dashboard](Dashboard.md) 为准。

后续决定见 [公共契约](../CONTRACTS.md)、[决策记录](../decisions/runtime-contracts.md) 和 [DSH 迁移边界](../DSH_MIGRATION.md)。下列 G1–G8 保留为初次评估依据，解除情况以 Dashboard 为准。

R1 后续取证见 [平台基线](../integration/PLATFORM_BASELINE.md) 和 [验证记录](../verification/R1.md)。下文“本次未复跑 / 未定位”等描述属于初次评估；R1 已复跑 DSH 版本、找到 Codex 精确格式和可读的 Antigravity Plugin 教程。运行能力仍未验证。

## 结论

现有资料足以明确产品边界、拆分 MVP 并启动契约澄清和平台取证；尚不足以把所有实施任务交给新会话直接执行。关键缺项集中在机器可读契约、收口与恢复的责任边界、DSH 等价范围以及平台运行证据。无需等待额外 PRD 才能建立计划，但不能把接口示例当作完整协议。

初次规划只创建计划并按用户决定修正设计中的命名和状态路径，没有运行旧项目测试、安装宿主或验证 Runtime 实现。目标目录初始为空；后续已按用户要求初始化本地 Git 仓库和项目入口。后续任务的提交基线从实际 Git HEAD 取得，不沿用初次规划的 unborn HEAD。

## 已有资料

| 资料 | 能支持的判断 | 证据边界 |
|---|---|---|
| [Runtime 设计](../../../dev-harness-runtime-design.md) §1–50 | 目标、Core / Adapter / Packager 分层、V0 与 K1–K10、最终验收 | 设计输入，尚无目标实现 |
| [Planning 协议](../../../dev-harness/planning/SKILL.md) | Dashboard 唯一权威、任务执行包、归档与漂移门禁 | 文字协议，尚非完整 Markdown 解析规范 |
| [dev-harness 文档入口](../../../dev-harness/docs/README.md) | 上游 Context / HARNESS / Git / Docs 的来源定位 | Runtime 不应复制这些业务协议 |
| [旧 DSH 架构](../../../dev-harness-dsh/ARCHITECTURE.md)、[HARNESS](../../../dev-harness-dsh/HARNESS.md) | 已有工程入口与历史验证说明 | 历史记录，本次未重跑 |
| [DSH rc.8 集成基线](../../../dev-harness-dsh/docs/integration/DSH_API_BASELINE.md) | Cordis、Agent、Session、Workflow、private state 的已记录证据 | 锁定 rc.8，不能推广到其他版本或新任务模型 |
| [旧 state.ts](../../../dev-harness-dsh/src/state.ts)、[orchestrator.ts](../../../dev-harness-dsh/src/orchestrator.ts)、[tests](../../../dev-harness-dsh/tests) | 通用状态与授权行为的迁移参考 | 旧流程以 Audit / 修复 / QA 为中心，非 Planning Task 队列 |

只读参考源码版本：`dev-harness` 为 `1ed830aa0d696b52dbd666118ced475f4d6e8f79`，`dev-harness-dsh` 为 `cb53f228246a39ef8fd2ebcf372b60e0f1cffbf6`。两个参考仓库检查时工作树干净。

## 用户已确认的统一约定

- 项目名为 `dev-harness-runtime`，缩写和 CLI 命令均为 `dhr`。
- DSH 迁移与适配目标为 `0.1.5-rc.1`，依据是用户于 2026-09-17 提供的本机 `dsh --version` 输出。本次未重新执行该命令，版本信息不等同于 Adapter 兼容性证据。旧 rc.8 基线仅作历史参考。
- 状态根目录只有 `$(git rev-parse --git-path dev-harness-runtime)/runs/`。
- 设计 §10 与 §35 已对齐为每个 Run 一个目录，其中 `run.json` 是该 Run 唯一权威状态文件，`attempts/` 保存日志，`results/` 保存执行结果，`summary.json` 保存派生摘要。日志、结果与摘要都不构成第二份 Run 状态。
- 新项目没有既有 doc/docs 根，按 Planning 规则选用 `dev-harness-runtime/docs/`，不建立第二套文档根。Git 已单独按用户要求初始化，规范见 [Git 工作流](../GIT_WORKFLOW.md)。

## 资料缺口依据

### G1 工程与协议来源基线

初次评估时，设计推荐 TypeScript / Node.js / pnpm，但未固定目标版本、测试框架、模块形式、最低 OS / Git 版本。目标仓库已有 README、本地 Git 和提交发布规范，尚无 AGENTS、HARNESS 或构建配置。需要确定上游 dev-harness Skill 的版本、获取方式、兼容性检查与独立仓库内设计文档的归属。当前计划使用工作区相对链接；独立分发前应迁移到稳定引用，避免复制两个权威设计。设计 §5 同时列出根 ARCHITECTURE 与 docs/ARCHITECTURE，需明确唯一事实源与导航关系；后续决定见本页开头的 R0 文档链接。

### G2 Planning 的机器读取契约

设计 §7 和上游 Skill 定义了字段与原则，但没有限定 Markdown 可接受语法、状态别名、依赖表达、blocker 解除表达和归档依赖的完成证明。需要明确 explicit 模式是否同样要求 ready、重复 ID 或多链接怎么处理、没有可执行任务时如何区分真正完成与被阻塞。解析器不能靠自然语言猜测完成状态。

### G3 结果信任、任务所有权与收口责任

设计 §13 的 VerificationEvidence 等类型尚未展开；请求未完整描述允许改动范围与执行尝试关联。§8 要区分 task-owned 修改，却不能只信 Worker 自报 changedFiles。§15 只有结果重验证与持久化，§37 又包含 task closure / Git Workflow / commit，需要明确由谁写 Dashboard、迁移归档、验收证据和提交，以及如何独立核验这些结果。授权模型还需说明如何映射宿主权限及检测违规，不能只依赖 prompt。

### G4 持久性、锁和恢复语义

状态根与日志布局已统一，但 schema 字段、phase 转移、取消映射、终态恢复资格、revision CAS 冲突、stale lock 所有者判断、崩溃后的 finalization 重入规则尚未完整定义。旧 DSH 集成基线 §3.7 明确其 atomic-write 不承诺 fsync crash durability，孤儿锁需要人工处置；新设计的 crash safe 与 stale lock recovery 不能直接继承为已实现能力。

### G5 DSH 行为等价范围

旧 DSH 为 Audit → Router → Auto Fix → Full Verification → QA → Reconciliation → Report，新设计为 Planning Task 串行执行。须定义迁移的是哪些通用安全性质、哪些旧产品流程保持在旧仓、旧 Run 是否支持转换。必须建立模块与测试的映射；不能仅因两个项目都有 orchestrator.ts 就宣称等价。旧仓弃用或归档不属于本次规划写入动作。

### G6 平台格式与能力依据

设计 §49 给出官方来源；用户已指定 DSH 目标为 `0.1.5-rc.1`，但该版本的 API / Bundle schema、实际组件依赖及新 Adapter 的 contract / fresh-session 运行证据仍需取得。其他平台也未锁定全部 schema / 宿主版本。§21 中 Codex / DSH 的成功勾选属于目标示例，不是当前能力事实。官网初查只补充资料可得性，不能替代 probe、安装 smoke 与 Session 身份测试。

### G7 构建、版本与分发输入

PluginBuildInput / ValidationReport / Artifact 的完整字段、共享元数据位置、上游源码锁定、core protocol 与 Adapter SemVer 兼容映射、归档可重复性和构建调用图仍需确定。`pnpm build` 与 `pnpm generate` 的关系要写清，避免重复或循环。许可和随包分发的来源说明未提供，不能自行声称任意内容均可再分发。

### G8 验证资源与可复现实测

缺少新项目 Windows / Linux / WSL 的执行记录，以及新 Codex / DSH 任务模型的真实 smoke。已收到用户提供的本机 DSH `0.1.5-rc.1` 版本输出，但没有检查账户、凭据、其他宿主安装或 CI secret；不能据此推定运行条件齐全。离线 fixture 可先开展，真实运行与发布能力需各自证据。Cursor / OpenCode / Antigravity 的自动 Executor 不作为首版必交实现；未取得能力证据时维持关闭，打包验收独立进行。

## 官方资料初查

以下为 2026-09-17 的只读核对，尚未形成完整平台 schema 基线。

| 来源 | 本次确认 | 仍需取证 |
|---|---|---|
| [Codex 非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode) | 文档给出 codex exec、JSONL thread_id、output-schema | 目标版本的实际 fresh session、取消与授权行为 |
| [Codex Plugins 文档](https://learn.chatgpt.com/docs/plugins) | 官方页面可访问 | 本次检索未定位设计所列 manifest 路径的精确格式，应继续核对官方开发规范 |
| [Cursor Plugins](https://cursor.com/docs/plugins)、[Reference](https://cursor.com/docs/reference/plugins) | 记载根 plugin.json 与 .cursor-plugin/plugin.json 两种入口 | Native schema 锁定与目标宿主安装实测 |
| [OpenCode Plugins](https://opencode.ai/docs/plugins/) | 记载 .opencode/plugins 本地插件和配置 npm 包两种加载方式 | Skills / bundle 相对路径与真实宿主兼容性 |
| [Antigravity Skills](https://codelabs.developers.google.com/getting-started-with-antigravity-skills) | 记载 SKILL.md、frontmatter 与资源目录 | 不能据此证明 Agent Plugin 打包格式 |
| [设计引用的 Antigravity Plugin 教程](https://codelabs.developers.google.com/cloud-dev-plugin-agy) | 本次工具打开返回 Internal Error | 需重试或寻找官方替代来源；不能推断页面永久失效 |

## 开工判断

可以立即执行公共契约澄清与平台资料取证。工程和实现任务先建立有范围、有验收的执行包，待其输入足够明确后逐项转为待执行。验收完整性不要求虚构排期或工时；当前没有团队产能和交付日期输入，因此本计划提供依赖与门禁，不承诺日历进度。
