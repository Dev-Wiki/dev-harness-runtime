# K3-L 私有状态与互斥锁验证

日期：2026-09-17。开始基线为 K3 提交 `1e1ea5525cfb733ae94a591ff070fdb76cbb49cb`，工作树干净。本记录描述提交前实际验证。

## 交付

[lock](../../packages/core/src/lock/index.ts) 使用独占目录与独立 guard、私有 owner metadata、不可伪造 handle 和串行队列。每次读写重验 Git 私有路径与 owner；不按 PID 或超时删除遗留锁。

[state](../../packages/core/src/state/index.ts) 仅以 `<run-id>/run.json` 为权威记录，支持固定创建身份、精确 revision 读取、CAS、attempt 日志目录、不可覆盖的 result / snapshot 证据及派生 summary。完整语义见 [CONTRACTS §12](../CONTRACTS.md#12-k3-l-私有存储与互斥实现)。

## 验收证据

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 退出 0；类型、lint、编译通过 |
| Node 测试 | 289 项通过、0 失败、0 跳过；既有 259 项，加 lock 7、state 21、跨模块集成 2 |
| Schema / 平台样例 | 21 份 Schema 一致性和 10 项 R1 样例通过 |
| CLI 安装 | 独立 tarball 离线安装，dhr bin / help / version 通过 |
| 锁竞争 | 4 个真实子进程同时争抢，恰好一个 owner；错误 token / handle、损坏 metadata、残留 guard、symlink 状态替换均拒绝 |
| CAS | 同一 owner 的 4 次并发旧 revision 写入仅一次成功；错误 revision、溢出、身份或授权变化均不覆盖记录 |
| 崩溃 | 半写、file sync、发布后和目录 sync 注入中断；真实子进程经 IPC 确认到达半写 / 发布边界后 SIGKILL；run.json 均为完整旧版或新版 |
| worktree 隔离 | 主仓和 linked worktree 同时持锁，同名 Run 分别更新；Git status 保持干净，K3 内容边界不因私有状态改变 |

完整回归后补充了故障测试超时子进程清理，单独重跑 state 的 21 项测试通过。实际环境为 WSL2、Node 24.15.0、pnpm 11.1.0、Git 2.43.0；所有 symlink 测试均执行。Windows / 原生 Linux / 远端 CI 未实跑，断电持久性未验证。

## 保证与限制

临时文件发布前重验 inode / 完整 stamp / SHA-256，替换已 flush 的临时文件会被拒绝。首次不可覆盖发布采用 link；如果在移除临时链接前中断，完整文件会因存在第二个硬链接而安全停止，等待检查，不自动删除推测出的别名。缺少 run.json 的半初始化目录也不被静默复用。

Linux 的进程启动身份可识别当前 owner，但不能独自证明旧子进程全部静止。遗留 owner、损坏 metadata 和残留 guard 保持 LOCK_OWNER_UNKNOWN；当前无自动 stale 回收。文件同步不等同于跨平台断电事务。

存储测试中的 Run / Snapshot fixtures 仅验证存储和 Schema，不证明所引用的执行证据真实。初始 Run 证据的完整初始化、持锁枚举和诊断读取、恢复 / reconcile 状态机由 K3-R / K4 接通；结果落盘不会自动改变完成状态。CLI 仍只有 help / version。

临时日志 `/tmp/runtime-k3l-verify.log`、`/tmp/runtime-k3l-state-final.log` 用于本轮复核；稳定依据是上述源码、测试与 HARNESS 的可重跑命令。文档收口另检查链接、任务唯一性、依赖、归档和范围外漂移。
