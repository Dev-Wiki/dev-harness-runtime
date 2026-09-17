# K3-R Run 恢复与显式对齐验证

日期：2026-09-17。开始基线为 K3-L 提交 `deb8cc989d383e11e861df4811e25027efbdbbca`，工作树干净。本文记录本次受影响验证，不将历史全量记录当作本次结果。

## 交付与验收

[recovery](../../packages/core/src/recovery/index.ts) 根据持久引用、真实快照和可信 Core 验证器决定恢复或停止；[reconcile](../../packages/core/src/recovery/reconcile.ts) 提供显式对齐、新 Run 门禁及唯一 successor。存储补充无 Task 的真实初始边界、诊断读取、半初始化补建及确定名称的精确证据复用。操作边界见 [RECOVERY](../RECOVERY.md) 与 [CONTRACTS §13](../CONTRACTS.md#13-k3-r-恢复与显式对齐实现)。

| 检查 | 本次结果 |
|---|---|
| `pnpm harness:quick` | 退出 0；类型检查和 lint 通过，无警告 |
| `pnpm build` | 退出 0；workspace 编译通过 |
| 下列相关测试 | 144 项通过，0 失败、0 跳过 |
| 恢复 | 4 项决策 / 解析、19 项 resume；新 attempt / request、静止门禁、当前环境核对、checkpoint 前序绑定、孤儿结果精确采纳、独立验收和实际 Git commit 核验 |
| 显式对齐 | 12 项；失败历史保留、归档重新验收、未决门禁、唯一 successor 和三处中断补建、双向绑定 / 重复消费 / 环检测 |
| 初始化与证据 | 22 项；真实初始快照、seed 身份、当前 revision、精确字节复用、指定候选读取、未知窗口和不安全路径拒绝 |
| 受影响回归 | Snapshot 57、state 21、lock 7、跨模块私有状态 2 项通过 |

```bash
# 仓库根；先执行 quick 和 build，再运行受影响测试
pnpm harness:quick
pnpm build
node --test packages/core/tests/recovery/*.test.mjs packages/core/tests/state/*.test.mjs packages/core/tests/lock/lock.test.mjs packages/core/tests/snapshot/*.test.mjs tests/integration/private-state.test.mjs
```

执行中断测试覆盖证据发布后、Run CAS 前重试：verification plan 和 accepted result 必须逐字节相同；真实 commit 后首次快照保留原采集时间与字节，再次校验当前完整边界后复用。不同提交信息、越界修改、初始用户修改、治理内容漂移、旧 revision 和前序 checkpoint 身份 / 边界替换均拒绝，不覆盖原记录。

successor 在预留、初始化证据和 Run 已发布三个边界注入中断后，仅补建预留 ID；已有 Run 的进度不被旧初始化 seed 覆盖。原失败 Run 的状态、原因、pending 和 completedTasks 保持不变。已闭合对齐历史允许后续正常 Git 提交。

## 验证范围与限制

按用户确认的节奏，每个任务运行快速检查和受影响测试，通过后提交；M1 收尾再运行全量。本次没有运行 `pnpm verify`，最近全量基线仍为 [K3-L](K3-L.md) 的 289 项 Node、21 份 Schema、10 项平台样例及 CLI 离线安装。

环境为 WSL2、Node 24.15.0、pnpm 11.1.0、Git 2.43.0。恢复测试使用真实临时 Git / 文件系统与进程内故障注入；受影响回归另含真实进程锁竞争和 SIGKILL。没有验证断电事务、原生 Windows / Linux 或真实宿主 Session。

新 Session 的测试只证明恢复决策要求新的执行身份，并使用 Fake 调用记录；CLI / Executor 调度由后续任务接通。可信来源、静止和独立验收的 fixture 回调只验证接口门禁，不能证明实际 Worker 隔离。恢复接口不执行 Git commit、Planning 修改或宿主调用，遗留锁仍须证明旧执行树静止，不自动删除。

临时日志为 `/tmp/runtime-k3r-quick.log`、`/tmp/runtime-k3r-build.log`、`/tmp/runtime-k3r-related.log`；稳定依据为上述源码、测试和命令。文档收口另检查链接、任务唯一性、依赖、归档和范围外漂移。
