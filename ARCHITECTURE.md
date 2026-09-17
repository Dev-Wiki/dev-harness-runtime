# 项目架构分析

## 模块依赖关系图
Core 与五个 Adapter → contracts；build → core 与 Adapter 包；CLI 当前无 workspace 运行依赖，独立 tarball 提供 help/version。

## 核心业务流程
CLI 输出帮助/版本；其他命令退出 2。Registry 显式 register/get/list；discoverProject 读取 Git/worktree 与项目契约，readPlan 校验看板和归档，selectTask 按权威顺序选出一个合格任务。captureSnapshot 捕获原始内容和 Git 边界，verifyOwnedTransition 核验可信操作的变更与授权提交。state / lock 提供持锁读写和 revision CAS；recovery 根据精确证据和真实边界恢复或显式对齐，尚未接入 Executor 调度。

## 架构模式
公共 Core / Adapter / Build 分层；contracts 提供版本化 Schema 与声明校验，Core 提供 Registry、项目发现、Planning 读取、内容快照 / 漂移门禁、私有状态 / 互斥锁与恢复 / 对齐接口。Adapter 仍为元数据，没有 Executor 或 Packager 实例。

## 模块接口与通信方式
- Adapter 通过 workspace:* 引用 contracts；build 通过 workspace 包引用 core。
- Registry 使用 register/get/list；CLI 通过 CliOutput 注入输出。
- Core 的 discoverProject / readPlan / selectTask 通过只读 ProjectContext / PlanningDocument 通信，PlanningReference 记录本次读取内容的 SHA-256。Markdown 使用结构 token。

## 关键模块标记
- docs/design/runtime-design.md 是唯一设计正文，ARCHITECTURE 描述当前实现。
- protocol-lock.json 与校验脚本固定来源，不自动 clone 或升级。
