# dev-harness-runtime 文档入口

- [实现架构](../ARCHITECTURE.md)：当前 workspace、Registry 与 CLI 边界。
- [构建验证契约](../HARNESS.md)：工具链、已确认命令与验证范围。
- [公共契约](CONTRACTS.md)：Planning 读取、执行结果、授权、状态恢复与打包接口。
- [契约决策](decisions/runtime-contracts.md)：设计选择、来源锁定与工程基线。
- [DSH 迁移边界](DSH_MIGRATION.md)：通用行为、旧产品流程和旧 Run 的处理。
- [R0 验证记录](verification/R0.md)：契约走查、源码映射与文档验证。
- [平台基线](integration/PLATFORM_BASELINE.md)：六类格式、DSH 实际组件、离线样例与宿主门禁。
- [R1 验证记录](verification/R1.md)：格式校验、版本盘点与归档检查。
- [V0 验证记录](verification/V0.md)：工程骨架、协议锁与 CLI 安装包验收。
- [K1 验证记录](verification/K1.md)：公共 Schema、正反例、共享 Executor 工厂与完整回归。
- [K2 验证记录](verification/K2.md)：Git/worktree、Planning 结构读取、归档与选择门禁。
- [K3 验证记录](verification/K3.md)：内容快照、漂移保护与真实 Git 提交校验。
- [K3-L 验证记录](verification/K3-L.md)：私有状态、CAS、多进程锁与崩溃验证。
- [K3-R 验证记录](verification/K3-R.md)：恢复、中断重入、显式对齐及受影响回归。
- [K4-V 验证记录](verification/K4-V.md)：独立验收、实际隔离、精确提交及证据恢复。
- [K4-W 验证记录](verification/K4-W.md)：共享 Skill、Worker 请求、递归门禁和父上下文 / 日志边界。
- [K4 验证记录](verification/K4.md)：串行三任务、运行 CLI、只读状态、取消及提交恢复。
- [恢复与人工对齐](RECOVERY.md)：Core 恢复接口、可信证据与唯一 successor。
- [开发看板](plan/Dashboard.md)：唯一活跃计划、任务顺序与跨任务状态。
- [资料完整性评估](plan/Readiness.md)：设计输入、缺项与官网初查证据。
- [Git 工作流](GIT_WORKFLOW.md)：分支、提交身份、Conventional Commits、tag 与发布说明规范。
- [设计文档](design/runtime-design.md)：仓库内唯一设计正文。

任务正文按需从看板进入；已完成任务在生命周期收口时进入里程碑归档。原工作区设计路径仅保留短导航。
