# Codex / DSH Worker 受控桥接候选方案

本文件是 K5 / K6 的实施方案，不改变 [公共契约](../CONTRACTS.md)中的授权或验收语义。桥接完成真实对抗验证以前，两个 Executor 均保持未注册；合成会话和元数据不能作为 `authorizationEnforced:true` 的依据。

## 为什么需要桥接

[K5 实测](../verification/K5.md)中，Codex `workspace-write` 可写工作区同级 `/tmp`，而 `read-only` 的原生工具拒绝文件写入。本地 MCP 工具可在该 `read-only` 会话中写临时文件，说明它可以作为受控写入通道，也说明原生沙箱不会保护 MCP server 的写入。[K6 实测](../verification/K6.md)中，DSH `workspace-write` 可写工作区外 `/tmp`，`read-only` 工具可访问本机 HTTP 服务。直接启用任一原生模式都不能满足逐 Task scope 和外部动作禁止。

## 目标边界

1. Core 从已冻结的 `TaskExecutionRequest.scope` 构造桥接策略；Worker 的 prompt、工具参数或结果都不能扩大策略。策略绑定 runId、taskId、attempt、requestId、before snapshot hash 和固定的 Adapter 配置摘要。
2. Agent 宿主只提供受控读取与桥接写入。Codex 使用 `read-only` 原生沙箱和显式固定的本地 MCP server；DSH 使用 `read-only` 文件策略，并在工具注册层对 bash、web、subagent、workflow、代码执行及所有非桥接工具施加不可由后续插件放开的拒绝。必须逐一枚举并验证实际宿主工具目录；一个配置开关或 prompt 禁令不算证明。
3. 桥接进程单独运行于无网络、无宿主凭据、无 Git 私有目录的隔离命名空间。仓库内容默认只读；仅当前 Task 明确允许的文件或目录可通过桥接写入。路径检查需防 symlink、hardlink、大小写别名和检查后替换；无法安全映射单文件或新建路径时拒绝，而不是扩大到父目录。
4. 桥接只提供必要的文件读取、目录枚举、搜索和精确文件编辑接口，不提供任意 shell、网络、Git、进程启动或任意路径访问。每次调用记录请求身份、规范化路径、操作、前后字节摘要、执行结果与顺序；日志由可信控制器收集到当前 Run 的私有证据区。
5. 宿主 Agent 和桥接进程均须有可验证的生命周期控制。取消、超时或异常后等待整个 Worker / 桥接进程树静止，再捕获结束快照；无法证明时保留锁并返回 `QUIESCENCE_UNKNOWN`。恢复一律启动新 Session，且不得复用旧桥接授权。
6. Core 继续独立核验实际快照、Planning 生命周期、受控验证命令及可选提交。桥接记录与实际变更集不一致、宿主仍有未受控副作用工具，或宿主版本/配置漂移时，`probe` 必须返回不可用，`dhr run` 必须拒绝。

## 最小验收顺序

- 先完成纯本地桥接的路径与生命周期对抗测试：允许路径、新建/删除/重命名、目录边界、symlink/hardlink、Git 私有目录、初始用户修改、并发替换、取消与后代进程。
- 然后分别在 Codex 0.154.0 与 DSH 0.1.5-rc.1 的隔离空工作区验证工具目录、正向编辑和每项禁止副作用。对 DSH，loopback 请求必须由工具门禁拒绝；对 Codex，原生工具与非白名单 MCP 必须拒绝。
- 最后连接 Core 的证据与结果协议，跑同一三 Task 序列、fresh Session、取消与恢复；通过后才注册生产 Executor 并进行最终全量回归。

这是一条待实现的路径，不是现有能力声明。现阶段保留 [Dashboard](../plan/Dashboard.md)中 K5 / K6 的阻塞和未完成状态。

当前已落地 `createWorkerWritePolicy` 这一纯路径判定，并让 Core 的最终快照所有权检查复用它；专项 17/17 通过。`WorkerProposalCollector` 进一步把请求和执行前快照绑定，按同一判定暂存文件写入/删除提议，复制字节并限制大小，拒绝 symlink/gitlink；专项 2/2 通过。它不写工作树，也不提供持久审计、文件系统竞态防护、进程隔离或宿主工具目录证明，不能单独作为桥接权限证据。

Codex 侧已有只返回哈希的 `dhr_propose_text` MCP 入口和与宿主 JSONL 事件配对的提议解码；一次真实空目录调用通过且未写文件。它还未绑定 Core 的提议暂存或实际文件应用。DSH 侧 Worker guard 仅放行插件自身注册的无写入 `dhr_propose_text` 定义，真实 rc.1 headless Session 已返回提议哈希，另一次 bash 写入调用被拒绝；DSH Session 事件到 Core 提议暂存尚未连接。这些组件保持生产 Executor 关闭。
