---
name: run
description: 通过 dev-harness-runtime 的 dhr 入口启动或恢复用户指定的任务执行模式；不在父对话中自行领取、实施或恢复任务。
---

# Run

将用户的执行意图交给统一 Runtime。任务选择、资格检查、快照、锁、授权、Worker 派发、独立验收和恢复均由 Core 负责。

## 入口与授权

- 先检查 `DEV_HARNESS_WORKER`。值为 `1` 时拒绝所有 `dhr run` 模式、`resume` 和 `reconcile`，包括显式指定 Task；不通过子进程、其他入口或修改环境标记绕过。
- 使用已安装的 `dhr --help` 核对可用入口和参数。将用户选择原样映射为一个模式：指定 Task、next 或 all-ready；不能自行增加模式、Task 或循环调用。
- 默认 no-commit。只有用户已明确授权本次 Run 按 Task 提交时，才传递 commit-each；两种提交标志冲突时停止。恢复保持原 Run 授权，不能借恢复扩大权限。
- resume 只交给 Core 重验持久边界并按需启动新 Session。不要恢复旧 Conversation、按日志时间猜测结果、手改状态或自动进行 reconcile。显式 reconcile 请求只交给已实现的 CLI，由 Core 校验用户提供的对齐记录。
- Worker 始终没有提交权限。即使 Run 获准提交，也只由 Core 验收后处理 commitIntent。push、PR、tag、release、deploy 均不在此流程授权内。

## 执行与停止

只调用已实现且受控的 `dhr` 入口。K4 已接通统一编排入口；若入口、执行器、fresh Session、结构化结果或权限隔离能力缺失，报告不可执行并停止。不能从 Skill、构建产物或 fixture 推定宿主能力，也不能改用当前父对话手工模拟 Runtime。

不要自行解析 Dashboard 选择任务、展开整个 backlog、启动 Worker 或实现第二套调度循环。Core 返回 blocked、failed、partial、漂移、授权拒绝或取消时，保留其停止原因；不自动换任务、重试副作用或绕过门禁。

## 父上下文输出

仅转述 Core 的紧凑投影字段：runId、taskId、status、summary、verification summary、commitSha、nextTask、logRef。缺失字段省略，不虚构 Run、提交或下一任务。Worker completed 只表示待验收声明；仅 Core 接受后才可报告已接受完成。

完整 transcript、构建日志、diff、源码和 JSONL 不回灌父上下文。由 Core / 受控 Adapter 保存到 worktree 私有 Git 路径下唯一的 dev-harness-runtime Run 状态根；不创建第二状态树。logRef 必须来自 Core 验证过的实际私有文件引用，不能将任意路径或 Worker 自报路径当作证据。
