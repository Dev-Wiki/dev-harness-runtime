---
name: status
description: 查询 dev-harness-runtime Run 的紧凑状态、验证摘要和私有日志引用；不启动任务、恢复执行或展开完整日志。
---

# Status

通过已安装 `dhr --help` 确认受支持的只读状态入口，再按用户指定的 Run 查询。当前 K4 状态 CLI 尚未接入；入口缺失时说明不可用并停止，不自行从结果目录推断执行状态。

只展示 Core 返回的 runId、taskId、status、summary、verification summary、commitSha、nextTask、logRef。缺失字段省略；错误或能力限制写入简短 summary，不捏造完成记录。nextTask 只是 Core 提供的信息，不授予执行权限；commitSha 只采用 Core 接受记录。

唯一权威状态是该 worktree 私有 Git 路径下 dev-harness-runtime Run 目录内的 run.json。summary 是可重建投影，结果和日志是被引用证据；不能用“最新 result”、日志内容或归档存在替代 run.json，也不能写回、修复或创建状态。

verbose 也只增加已核验的日志引用，不默认展开 transcript、完整构建日志、diff、源码或 JSONL。只接受 Core 已确认存在且位于对应 Run 私有目录的 logRef；不能为缺失日志编造链接或复制日志到第二状态树。

此 Skill 不调用 run、resume、reconcile，不领取任务，不提交或发布。在 Worker 环境中也保持只读，并遵守 Core 的私有状态访问限制；没有受控状态接口时停止，不直接读取受限 Git 私有目录。
