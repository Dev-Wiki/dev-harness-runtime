# 项目架构分析

## 模块依赖关系图

CLI 开发依赖 Core / contracts / build，esbuild 将运行依赖合入独立 bundle；Core 与五个 Adapter 引用 contracts；build 通过 workspace 包引用 Core / Adapter。统一 PlatformRegistry 为 Core RuntimeAdapter 与平台 PluginPackager 提供显式注册；Core 未导入宿主 SDK。

## 核心业务流程

CLI 解析 doctor / status / run / resume / reconcile；doctor 只读诊断，status 从 run.json 及证据投影紧凑结果。可信 RuntimeServices 注入后，startRuntimeRun 经能力 probe、锁与旧 Run 门禁初始化状态；runLoop 重读 Planning、选择一个任务、冻结请求和验收输入、派发独立 Worker、验证结束证据、独立验收并按 Run 授权收尾。all-ready 每次接受后重读计划；恢复复用持久证据或以新 attempt / request / Session 继续。分发 CLI 未配置宿主服务时明确 CAPABILITY_MISSING。partial 保存 Worker-ended 后停止为 INTERRUPTED；noncompleted ending 不能通过 resume 自动继续，只有可信 worker-checkpoint 支持继续剩余工作，未改变的取消边界可新建 attempt 重试。

CLI 的 build / validate / pack 共用该 PlatformRegistry 和受信 BuildPipeline。流水线核验协议锁、Skill / bundle 摘要、共享元数据；依次生成固定文件清单、静态校验并对未改变的目录打包。每阶段凭实际字节和来源记录约束下一阶段；默认分发包无平台 Packager，命令返回 CAPABILITY_MISSING。

## 架构模式

公共 Core / Adapter / Build 分层；contracts 定义版本化 Schema，Core 组合 discovery、planning、snapshot、state / lock、recovery、result、authorization、worker 与 orchestrator；RuntimeAdapter 由可信调用者显式注册，分发平台描述符尚无真实 Executor 或 Packager 实例。

## 模块接口与通信方式

- RuntimeServices 注入明确的 Registry、prepareTask、验收 provider 与可选 Git / reconciliation 服务；RuntimeAdapter 绑定 Executor、环境、日志回调、结束证据及可信静止 / 检查点验证。
- TaskExecutionRequest / Result / EvidenceRef 承接执行身份、scope、授权与原始内容摘要；state 持锁写入，inspectRun / inspectParentContext 无锁只读状态，按原字节复核一致读取。
- CLI 通过 CliOutput 输出，通过 CliOptions 显式注入可信 RuntimeServices；参数、项目文件和环境变量没有动态装载执行服务的入口。
- BuildPipeline 通过 CliOptions 显式注入；编译、生成、校验、打包互不递归调用，生成树与包清单不是能力证明。具体行为见 [打包契约](docs/PACKAGING.md)。

## 关键模块标记

- docs/design/runtime-design.md 保留原始设计；当前公共行为以 docs/CONTRACTS.md 为准，ARCHITECTURE 描述已有实现。
- protocol-lock.json 与 scripts/check-protocol.mjs 固定来源；CLI bundle 在构建时生成，平台插件由后续 Packager 生成。
