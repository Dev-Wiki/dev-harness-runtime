# Codex / DSH Worker 受控桥接实施记录

本文件保留 K5 / K6 从候选方案到宿主验收的实施顺序，不改变 [公共契约](../CONTRACTS.md)中的授权或验收语义。当前结果以 [K5](../verification/K5.md) 和 [K6](../verification/K6.md) 的真实宿主记录为准；下文早期阶段的“仍未注册”仅描述当时的状态。

## 为什么需要桥接

[K5 实测](../verification/K5.md)中，Codex `workspace-write` 可写工作区同级 `/tmp`，而 `read-only` 的原生工具拒绝文件写入。本地 MCP 工具可在该 `read-only` 会话中写临时文件，说明它可以作为受控写入通道，也说明原生沙箱不会保护 MCP server 的写入。[K6 实测](../verification/K6.md)中，DSH `workspace-write` 可写工作区外 `/tmp`，`read-only` 工具可访问本机 HTTP 服务。直接启用任一原生模式都不能满足逐 Task scope 和外部动作禁止。

## 目标边界

1. Core 从已冻结的 `TaskExecutionRequest.scope` 构造桥接策略；Worker 的 prompt、工具参数或结果都不能扩大策略。策略绑定 runId、taskId、attempt、requestId、before snapshot hash 和固定的 Adapter 配置摘要。
2. Agent 宿主只提供受控读取与桥接写入。Codex 使用 `read-only` 原生沙箱和显式固定的本地 MCP server；DSH 使用 `read-only` 文件策略，并在工具注册层对 bash、web、subagent、workflow、代码执行及所有非桥接工具施加不可由后续插件放开的拒绝。必须逐一枚举并验证实际宿主工具目录；一个配置开关或 prompt 禁令不算证明。

DSH rc.2 的 `tools.guard` 在 `tools/pre-execute` waterfall **之后**运行；本机安装的 `dsh-hooks-codex` 已有可执行 `PreToolUse` 的前置监听器。DHR 插件因此增加 `{prepend:true}` 的前置短路门禁，实际组件测试证明它会跳过**随后注册**的监听器；原 guard 仍在工具体前二次核验。生产 Worker 还需冻结隔离 profile 的完整插件/监听器集合并证明没有更早执行的监听器，或使用覆盖整个宿主进程的可信隔离。
3. 桥接进程单独运行于无网络、无宿主凭据、无 Git 私有目录的隔离命名空间。仓库内容默认只读；仅当前 Task 明确允许的文件或目录可通过桥接写入。路径检查需防 symlink、hardlink、大小写别名和检查后替换；无法安全映射单文件或新建路径时拒绝，而不是扩大到父目录。
4. 桥接只提供必要的文件读取、目录枚举、搜索和精确文件编辑接口，不提供任意 shell、网络、Git、进程启动或任意路径访问。每次调用记录请求身份、规范化路径、操作、前后字节摘要、执行结果与顺序；日志由可信控制器收集到当前 Run 的私有证据区。
5. 宿主 Agent 和桥接进程均须有可验证的生命周期控制。取消、超时或异常后等待整个 Worker / 桥接进程树静止，再捕获结束快照；无法证明时保留锁并返回 `QUIESCENCE_UNKNOWN`。恢复一律启动新 Session，且不得复用旧桥接授权。
6. Core 继续独立核验实际快照、Planning 生命周期、受控验证命令及可选提交。桥接记录与实际变更集不一致、宿主仍有未受控副作用工具，或宿主版本/配置漂移时，`probe` 必须返回不可用，`dhr run` 必须拒绝。

## 最小验收顺序

- 先完成纯本地桥接的路径与生命周期对抗测试：允许路径、新建/删除/重命名、目录边界、symlink/hardlink、Git 私有目录、初始用户修改、并发替换、取消与后代进程。
- 然后分别在 Codex 0.154.0 与 DSH 0.1.5-rc.1 的隔离空工作区验证工具目录、正向编辑和每项禁止副作用。对 DSH，loopback 请求必须由工具门禁拒绝；对 Codex，原生工具与非白名单 MCP 必须拒绝。
- 最后连接 Core 的证据与结果协议，跑同一三 Task 序列、fresh Session、取消与恢复；通过后才注册生产 Executor 并进行最终全量回归。

以上为最初的实施顺序；K5 / K6 后续宿主验收已完成，现行能力状态见 [Dashboard](../plan/Dashboard.md)。

当前已落地 `createWorkerWritePolicy` 这一纯路径判定，并让 Core 的最终快照所有权检查复用它；专项 17/17 通过。`WorkerProposalCollector` 进一步把请求和完整执行前快照绑定，按同一判定暂存文件写入/删除提议，复制字节并限制大小，拒绝 symlink/gitlink；恢复原始内容会消去无效提议，最终提议路径必须与结构化结果的 `changedFiles` 完全一致。它可导出带请求身份、原始哈希和内容的独立记录，并在读取时重新验证身份、顺序、字节及摘要；单组最多 1024 个文件。结束快照还须与提议的文件集合、内容、模式和未变 Git index 一致。Core 的 `persistWorkerProposals` 现在从权威 Run 读取 pending operation 和冻结前快照，检查真实工作区仍处于该边界，只在当前 RUNNING/EXECUTE revision 将提议以不可变记录写入 `results/run-evidence/`，然后回读并重验身份、字节、范围和结果声明；同字节重试复用记录，异字节重试拒绝。该记录不修改工作树，也不提供生产进程控制、文件系统竞态防护或宿主工具目录证明，不能单独作为桥接权限证据。

Codex 侧已有只返回哈希的 `dhr_propose_text` / `dhr_propose_delete` MCP 入口和与宿主 JSONL 事件配对的提议解码；真实空目录仅验证过文本提议，未验证删除宿主调用。JSONL 流入口在交付结果前保留原始字节并处理任意分块，另一次真实 Codex 会话已通过该入口返回文本提议及合成 `blocked` 结构化结果。进程传输、固定只读参数和模型面向的结构化结果 Schema 已有本地测试，仍缺宿主工具目录、整个进程树静止和受控应用证据。DSH 侧 Worker guard 放行插件自身注册的无写入 `dhr_propose_text` / `dhr_propose_delete` 定义；真实 rc.1 headless Session 已分别返回文本与删除提议哈希，另一次 bash 写入调用被拒绝。删除提议的真实模型会话只有一次合成调用，仍不证明完整工具封闭。DSH v3 Session 事件解码器已从真实会话还原文本提议；只读 reader 及解码入口能拒绝非新会话或多会话 store，并在交付结果前要求日志回调成功；另一真实 DSH 会话已返回文本提议及合成 `blocked` 结构化结果。DSH 的 `persistDshSessionProposals` 现在能在当前 Run revision 下调用 Core 保存文本或删除候选，本地临时 Git 仓测试验证工作树不变及声明不一致拒绝；生产 DSH Executor 仍未连接该入口或 Core 受控应用，保持关闭。

Codex 本地只读桥接现能从冻结路径 / SHA-256 policy 列目录、分页读取文件并进行有界字面搜索，实际 stdio 子进程测试通过；读取和搜索会复核工作树字节与打开前后身份，拒绝 symlink、hardlink 与 Git 私有路径。Core 已从本次 Run 的权威前快照生成宿主无关的 `WorkerReadCatalog` 并传入 `prepareInvocation`，跨包测试确认 Codex 只读视图接受目录且拒绝变化的字节。Adapter 现可把这个目录与 Core 请求中的 Task scope 绑定成一次性私有桥接策略；带策略的 MCP 子进程在工具调用时按 Core 的精确路径判定拒绝越界文本 / 删除提议，不修改工作树。`runCodexSession` 已组合策略、一次性 Schema、固定宿主参数、进程传输和日志回调；真实合成 Codex 会话已通过该入口调用 list / search / read / propose。生产 Core `TaskExecutor` 尚未注册，宿主完整工具目录也未验，不能将合成测试推广为授权证明。

Adapter 的 `persistCodexSessionProposals` 已将传输结果中的文本 / 删除提议交由 Core 在当前 Run revision 下存为不可变候选证据；跨包测试覆盖文件未改动与不一致声明拒绝。仍需 Core 的受控应用、结束快照和宿主控制回执，候选证据本身不能开启自动 Executor。

Codex 的可选 Linux 隔离启动器现把 Core 只读目录中的普通文件逐个校验 SHA-256、大小和单链接身份，复制到单次私有镜像，再将镜像、桥接 policy 和独立 bundle 以只读挂载交给 bubblewrap 子进程。该子进程清空环境、隔离网络与 PID，不挂载工作树其他文件或宿主凭据；单次镜像限 64 MiB、单文件限 16 MiB，超限拒绝。合成 `HELLO` 本地子进程测试证明未入目录的同级文件和宿主 Codex 凭据不可见，快照漂移、symlink / hardlink 均被拒绝；真实 Codex thread `01a0b406-2736-7e00-8cf5-4e7a57e6c5da` 通过该子进程完成 list / search / read / propose 并保持工作树不变。这只证明本次 MCP 子进程的隔离路径可用；没有 Codex 宿主整个进程树静止、原生工具目录封闭、Core 精确应用与生产能力 probe，不能注册自动 Executor。

宿主侧先加入受信的 Linux PID 1 控制器：bubblewrap 在 `info-fd` / `block-fd` 闸门下建立 user、mount、PID、IPC、UTS 和 cgroup 命名空间，宿主控制器核对 init PID、父进程和命名空间身份后才放行固定 bootstrap；bootstrap 确认自身为 PID 1 后执行 Codex。宿主只挂载合成仓库镜像、Codex 主程序及单个辅助程序、只读认证文件、必要系统证书和内层 bridge 的精确来源；当时 Codex 宿主暂时共享网络以调用模型，内层 bridge 仍无网络；后续阶段已改为下文的白名单模型代理。宿主退出后控制器等待命名空间 init 消失，取消、控制器被杀和独立后代进程专项通过。嵌套模式不再把内层 bridge 绑定到 Codex 临时辅助进程的生死，而由外层 PID 命名空间收束整棵树；合成真实 Codex 会话连续两次完成四个桥接调用并取得静止回执。此前一次内层传输中断不计为通过。该证据覆盖本机 0.154.0 的合成会话，不等于实际 Planning Task、工具目录完整拒绝、受控应用或生产 Adapter 回执；自动执行继续关闭。

Core 派发现在有可选提案入口：宿主静止后，Core 在原 Run revision 下保存候选和应用意图，逐项核对冻结路径、原始字节、普通文件及父目录，再由持锁的 Core 写入精确字节或删除，重拍完整快照，并保存绑定前后哈希的应用回执。临时 Git 仓专项覆盖现有文件、嵌套新文件、删除、用户插入修改拒绝和派发时序；中途失败留下的变更只会作为漂移等待显式处置，不能作为成功结果。Codex Adapter 尚未接入这个入口或验证对应宿主回执，因此上述 Core 能力不能单独开启 Codex 自动执行。

宿主网络边界随后改为独立 network namespace。受信启动器先在该命名空间内启动只监听 loopback 的 Relay，再执行 Codex；Relay 通过精确只读挂载的私有 Unix socket 与宿主侧模型代理通信。宿主侧代理只允许固定的 HTTPS CONNECT 目的地主机，并可向可信环境配置的上游 HTTP(S) 代理转发；不开放项目提供的网络目的地。合成目标进程专项证明它无法连接宿主 loopback，却能通过 Unix socket 连接许可模型主机；真实 Codex 0.154.0 合成 `HELLO` thread `01a0b44a-67bc-7410-b259-b37105fe7b13` 完成四个桥接工具调用，模型代理记录 `chatgpt.com` 10 次连接和 1 次拒绝，宿主静止与工作树不变。此证据仍限合成会话，生产 Adapter 的回执、真实 Planning Task 和取消恢复需要单独验证。

Codex RuntimeAdapter 已在合成临时 Git 项目中消费上述边界：先做两次真实 Codex 会话和独立取消的能力探测，Core 随后派发合成 Worker Skill，Codex 通过受限 MCP 提议单文件更新；外层宿主静止后，Core 精确应用提案并保存回执，Adapter 对持久化宿主证据、模型代理审计和命名空间 init 静止进行复核。`pnpm smoke:codex-runtime` 输出 `hostProbe:true`、`coreAppliedProposal:true`、`outcome:BLOCKED`。这仍是显式合成用例；分发 CLI 装配、实际 Planning Task 和多任务 / 中断恢复验收未完成。

DSH 侧现复用 Core 的命名空间控制器、模型代理、冻结读取目录与 Task 桥接策略。安装包的插件入口为自包含 bundle，隔离会话逐次复制并核对私有 headless profile 和插件 SHA-256，只读挂载冻结仓库镜像，不挂载宿主项目工作区、Git 私有目录或其他凭据；模型网络限定 `api.deepseek.com`。真实合成会话通过 `dhr_identity`、`dhr_list_paths`、`dhr_read_text`、`dhr_search_text` 与 `dhr_propose_delete`，Session 事件解码获得绑定请求的 `blocked` 结果，宿主控制器等待进程树静止且原文件未变。这个阶段先交付受限传输；Core 提案应用和持久宿主回执留给下一步 Adapter 验收。

随后注册仓库内可信 DSH RuntimeAdapter。两次真实新 Session 加独立命名空间取消的合成 probe 通过；另一次真实 DSH Worker Session 在临时 Git 项目中交付文本提议，由 Core 精确应用后，Adapter 复核宿主持久回执，Run 结束为 `BLOCKED`。这个阶段尚未验证包内生产入口、真实 Run 的取消恢复、原始 Worker Skill 或三任务依赖链。

DSH 安装包现含锁定协议 / Worker / CLI / 插件字节的 `source.json` 和可信服务工厂；包内 `scripts/dhr.mjs` 能按授权门禁装配该 Adapter。新 profile 离线安装后的来源检查、服务工厂和版本入口通过，复制包并替换成重新锁定的合成 Worker 后，包内 CLI 的真实模型会话完成单个临时 Planning Task 提议，Core 应用后 Run 为 `BLOCKED`，HEAD / index 不变。未替换 Worker、真实 Run 的取消恢复和三任务链仍待验。

合成 Core Run 的取消恢复现已验证：持久宿主启动记录出现后取消 DSH，Core 标记 `INTERRUPTED`，原文件不变；新 Adapter 实例从当前 revision 恢复到 attempt 2，经能力 probe 重新启动宿主，Core 应用新提议后 Run 为 `BLOCKED`。被取消 Session 的持久身份、未替换 Worker 和三任务链仍待验。

K6 后续在每个 DSH Agent 作用域遮蔽继承的原生工具目录，仅注册 DHR 读取、提议和结果提交工具；原有前置门禁及 guard 继续拒绝非桥接调用。实际安装包的未替换 Worker Skill 在合成临时 Git 项目中自主完成一个 Task 的 `--no-commit` 和 `--commit-each`，Core 独立验收与单次提交均通过。再以 A→B→C 三任务 `--all-ready --commit-each` 验证三次全新 Session、逐任务 Core 验收、三次受控提交及最终干净工作区。完整失败与通过记录见 [K6 验证](../verification/K6.md)。
