# K4-V 独立验收、隔离与受控提交验证

日期：2026-09-17。开始基线为 K3-R 提交 `7ef63aae5a42e2542e8973bdeff4ac1a3a8c4478`，本任务开始前工作树干净。本文记录本次相关验证，未把历史全量结果计入本次通过数。

## 交付与证据

实现见 [result](../../packages/core/src/result/acceptance.ts)、[冻结输入](../../packages/core/src/result/frozen.ts)、[Planning delta](../../packages/core/src/result/planning.ts)、[Linux provider](../../packages/core/src/authorization/sandbox.ts)、[Git 桥接](../../packages/core/src/authorization/git.ts) 和 [验收恢复](../../packages/core/src/result/recovery.ts)。使用边界见 [CONTRACTS §14](../CONTRACTS.md#14-k4-v-独立验收与受控提交实现)。

| 检查 | 本次结果 |
|---|---|
| `pnpm harness:quick`、`pnpm build` | 退出 0；类型、lint 和编译通过 |
| Planning 与冻结基线 | 26 + 7 项通过；保护其他任务、原验收与附加表；检查冻结来源、直接入口漏项、完整归档与摘要上限 |
| 独立验收 | 15 项通过；实际命令失败不能由 Worker 的 passed 声明覆盖，跨身份 / 缺失证据 / 未授权提交 / 漂移 / 不完整归档均拒绝 |
| Linux 隔离 | 21 项通过、0 跳过；真实 namespace、pidfd、环境 / Git 私有目录 / 网络隔离、只读镜像、明确产物、timeout / cancel / 后代退出、两道门禁处控制进程 SIGKILL |
| 受控 Git | 14 项通过；10 项前置边界、3 项真实验收→提交、1 项真实 commit 后证据发布 / CAS 前中断恢复 |
| 恢复 | 41 项通过；既有恢复 / 对齐回归及新增 commit-ready、错误阶段边界、验证产物接受与越界拒绝 |
| 相关回归 | 115 项通过；项目契约读取、Snapshot、不可变 Run 授权、state 与私有状态集成 |

本次共 239 项相关测试通过、无失败、无跳过，按功能分批执行上述专项；新增修复只重跑受影响文件或用例。可在仓库根按以下命令复现相同测试集合：

```bash
pnpm harness:quick
pnpm build
# 显式使用当前环境已安装并核验的 bubblewrap；不会自动下载
export DHR_TEST_BWRAP=/absolute/path/to/bwrap
node --test packages/core/tests/result/*.test.mjs packages/core/tests/authorization/*.test.mjs packages/core/tests/recovery/*.test.mjs packages/core/tests/planning/discovery.test.mjs packages/core/tests/snapshot/*.test.mjs packages/core/tests/state/*.test.mjs tests/integration/private-state.test.mjs
```

提交测试核对精确父提交、tree、message、完整路径集合与当前 HEAD，验证原 Git Workflow 被明确授权修改时仍按冻结旧字节判断，活动 hook 未执行且 HEAD / index / Run 不变。commit 后、accepted 证据落盘而 CAS 未完成时注入故障，再用实际 Core 证据链恢复；HEAD 不前进第二次，accepted 字节 / 时间复用，completedTasks 只追加一次。

no-commit 经过真实隔离命令后保持 HEAD 不变，capability 只能消费一次。accepted 证据发布后中断可恢复，Worker result 替换 Core 独立结果时拒绝。验证生成的显式未跟踪产物只进入接受快照；尝试写源码失败。HARNESS 或验证脚本获准改变时，隔离镜像仍使用旧基线；把旧失败脚本改成 exit 0 不会取得独立通过。

## 环境与限制

WSL2 Linux 6.6.87.2、Node 24.15.0、pnpm 11.1.0、Git 2.43.0、Python 3.12，bubblewrap 0.9.0（Ubuntu 0.9.0-1ubuntu0.1 包仅解包到 `/tmp/dhr-k4v-tools/root/usr/bin/bwrap`）。受限环境不能正确执行 Node 子进程捕获；实际专项在允许临时 Git / namespace / 进程管理的环境运行。缺少 `DHR_TEST_BWRAP` 的 skip 不计为隔离通过。

本轮真实验证进程、Git、文件系统与恢复记录；Worker 权限 / 静止和人工确认的服务使用明确标记的接口 fixture。它们只证明 Core 拒绝缺失、不一致或不可信记录，不证明 Codex / DSH 的实际 Worker Session、凭据或权限能力。平台 Adapter 必须另行取证。原生 Windows / Linux、宿主插件、模型 Session、断电事务未实测。

Core 编排器须在派发前声明完整验证依赖；直接入口漏项检查不等同于动态脚本依赖分析。Linux provider 目前要求既有产物目录，并明确拒绝不支持的路径 / 子模块 / 特殊文件。Git hook、filter、signing 等外部 helper 不具备隔离执行能力时拒绝项目，不绕过项目规则。

按用户确认的节奏，本轮不运行 `pnpm verify`；M1 收口再做全量。最近全量仍为 [K3-L](K3-L.md) 的 289 项 Node、21 份 Schema、10 项平台样例及 CLI 离线安装。

临时日志包括 `/tmp/runtime-k4v-quick.log`、`/tmp/runtime-k4v-build.log`、`/tmp/runtime-k4v-acceptance.log`、`/tmp/runtime-k4v-baseline.log`、`/tmp/runtime-k4v-planning-final.log`、`/tmp/runtime-k4v-related.log`、`/tmp/k4v-planning-recovery-elevated.log`、`/tmp/dhr-k4v-sandbox.log`、`/tmp/dhr-k4v-git-preflight.log`、`/tmp/dhr-k4v-git-real.log` 与 `/tmp/dhr-k4v-git-recovery.log`。稳定依据为本记录、源码、测试与上述可复现命令；临时路径不构成持久产品状态根。
