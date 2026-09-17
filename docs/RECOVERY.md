# Run 恢复与人工对齐

权威恢复语义见 [CONTRACTS §6](CONTRACTS.md#6-崩溃恢复协议)。本页说明 Core 接口及证据边界；`dhr resume` / `dhr reconcile` 的命令接入由 K4 完成。

## 读取与初始化

唯一状态来自 Git 私有目录中的 `<run-id>/run.json`。持锁诊断读取可以取得当前 revision，后续恢复和写入必须显式提供该 revision；不能读取“最新 result”并把它当作完成状态。

初始快照和初始化意图摘要保存在 `results/run-evidence/`，不假造 Task 或 attempt，空队列也有真实初始边界。初始化意图只保存 seedHash 与引用，用来确认重试是否仍是同一意图；它不能独立推进状态。Run 状态根仍为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`。

## 恢复依据

恢复使用当前 Core 的 Adapter、授权、协议来源与配置摘要，逐项核对持久 Run。RunState.repoIdentity 保存创建时身份；当前 Git 内容以 acceptedSnapshot 或 pending operation 对应的边界校验，不能一直要求 HEAD 等于创建提交。

checkpoint 是 Core 的受控操作记录，绑定 operationId、执行身份、阶段、前后 Snapshot、请求、结果及验证证据的精确引用。`indexCheckpointRef` 同样引用带 `index-staged` 阶段的 checkpoint，不能以一份没有身份的 index 摘要替代。私有文件存在、Schema 合法、摘要匹配都不单独证明来源；Core 的可信验证器仍需核验受控操作、执行静止和独立验收。

从执行 checkpoint 继续时，新 attempt 使用新的 requestId，另写 `execute-intent`，精确引用上一 attempt 的 checkpoint。该记录只声明新的执行意图，前后边界相同；恢复时仍校验前序身份、边界和可信来源，不能将新意图当作已执行结果。

恢复接口返回明确的下一步：新 attempt / 新 Session、继续可信 checkpoint 的剩余工作、采纳已核实结果、重新验收、补记已验收边界、交回 Core 提交桥接，或停止待对齐。接口本身不启动宿主或执行 Git commit。已有提交必须核对真实父提交、tree、message、路径和当前内容；无法证明时保留现场，不能盲目重放副作用。

执行请求中的快照是 Worker 执行前边界。进入 verify / commit 后，pending operation 的 before 是该子操作前边界；二者分别校验引用，不要求不同阶段的快照摘要相等。

证据发布后、Run CAS 前中断，可以按确定名称读取同一操作的候选证据。普通证据仅在序列化字节完全相同时复用；提交后的快照须重新验证真实内容边界，保留首次采集的时间与原始字节。不得按 mtime 挑选结果，也不得把“文件已存在”直接视为操作成功。

## 遗留锁与停止条件

取得新锁不等于证明旧进程及其子进程均静止。遗留 CREATED / RUNNING 需要可信静止证据后才能记录 INTERRUPTED，再按当前阶段恢复。锁 owner、子进程或 guard 无法证明安全时报告人工处置；不按 PID 不存在或超时自动删除锁。

外部 HEAD / index / Planning / 初始用户内容漂移、错误 Run revision、缺失或不一致的引用、无可信来源的 checkpoint、终态 Run，都会阻止自动恢复。失败保留原始记录和证据。

## 显式对齐与后续 Run

人工先在项目中完成修复或恢复，再提供绑定 runId、目标 revision、当前快照、相关 Task 和证据的 resolution。保留已完成归档时须重新独立验收；恢复为活跃任务时须重新校验 Planning。Worker 不能调用此入口。

对齐仅在原 run.json 记录验证过的处置，保留失败状态、原因、pending 历史及原 completedTasks；不会代写 Planning 或追认失败执行。承接 Run 先由原记录 CAS 预留唯一 successorRunId，再建立同一个 ID。中断重试不得另建第二个 successor，也不得覆盖已经前进的 Run revision。

未消费的对齐记录仍阻止普通新 Run 绕过专用承接流程。消费后验证来源和承接关系；已闭合的历史对齐不应永久要求后续正常开发匹配旧快照。
