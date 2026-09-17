# K4-W 共享 Worker、日志与父上下文验证

日期：2026-09-17。开始基线为 K4-V 提交 `75a4f2c968b3960ad4f89c310de306244b7a4318`，工作树干净。本任务继续按类型 / lint、相关验证、提交的顺序执行，没有运行全量 `pnpm verify`。

## 实现与结果

唯一共享源码为 [run](../../skills/run/SKILL.md)、[status](../../skills/status/SKILL.md)、[worker](../../skills/worker/SKILL.md)。Core 的 [请求构造](../../packages/core/src/worker/prompt.ts) 与 [父上下文投影](../../packages/core/src/worker/summary.ts) 配合 state 的受控日志 API，CLI 在模式解析前拒绝 Worker 递归入口。细节见 [CONTRACTS §15](../CONTRACTS.md#15-k4-w-共享-worker-与父上下文实现)。

| 验证 | 结果 |
|---|---|
| `pnpm harness:quick`、`pnpm build` | 退出 0；类型、lint 和编译通过 |
| Worker prompt / 父上下文 | 10 项通过；身份 / scope / 四标记绑定、新请求无旧上下文、JSON 数据边界、错误权限 / 来源 / 超长请求拒绝；只输出八个字段，长日志不进入摘要 |
| 私有日志 | 8 项通过；12 MiB 原始输出无截断，多 chunk 调用顺序、输入复制、精确身份 / revision、历史只读、链接与 Worker 访问拒绝，run.json 不变 |
| CLI 与 workspace | 6 项通过；13 种 Worker 写入口 argv、真实后代环境传播、非 Worker 原行为及只读 help/version；均无伪造运行副作用 |
| 状态回归 | 45 项通过；初始化、CAS、证据、双 worktree 私有状态保持原契约 |
| `pnpm test:cli-package` | 退出 0；独立 tarball 离线安装、bin/help/version 通过，CLI 未增加运行依赖 |
| 三份 Skill 格式 | `quick_validate.py` 三次退出 0；name 与目录一致，无未完成模板 |
| Skill 独立场景走查 | CLI 仅 help/version 时停止而不手工模拟 Core；Worker 收到越权重排 / 自提交 / 继续下 Task 的要求时报告 blocked / needsPlanning，不扩大授权 |

相关 Node 测试共 69 项通过，0 失败、0 跳过；按文件分批执行，可在仓库根复现：

```bash
pnpm harness:quick
pnpm build
node --test packages/core/tests/worker/*.test.mjs packages/cli/tests/entry.test.mjs tests/integration/workspace.test.mjs packages/core/tests/state/*.test.mjs tests/integration/private-state.test.mjs
pnpm test:cli-package
```

Skill 格式验证使用本机 `skill-creator/scripts/quick_validate.py` 对三个目录分别执行。独立只读走查没有启动模型 Session、Run 或 Git 提交；它补充指令语义检查，不能替代实际 Adapter 验收。

## 范围与限制

环境仍为 WSL2、Node 24.15.0、pnpm 11.1.0、Git 2.43.0；真实 Node/Git 子进程测试在允许进程捕获的环境执行。CLI 当前只有 help/version 与递归拒绝，run/status/resume/reconcile 调度由 K4 接通；没有把未实现入口包装成成功。

日志只由持锁 Core / Adapter 捕获；单块上限 1 MiB，完整日志不截断。引用核对实际文件和完整摘要，但不授予 Worker 私有目录访问。父摘要从指定 revision 的 run.json 投影，忽略 Worker 自报 summary 和可重建 summary.json；未被 Core 接受的 completed 候选不能显示为已接受。缺失日志、旧 revision 或接受边界不符均拒绝。nextTask 在尚未执行后续选择时为 null。

环境标记和 Skill 是递归门禁及行为约束，不能替代宿主权限隔离。真实 Codex / DSH Session、安装和凭据边界由后续任务验证。本轮未修改公共 Schema，也未修改各平台 Adapter。

临时日志：`/tmp/runtime-k4w-quick.log`、`/tmp/runtime-k4w-build.log`、`/tmp/runtime-k4w-worker.log`、`/tmp/runtime-k4w-state.log`、`/tmp/dhr-k4w-logs.log`、`/tmp/dhr-k4w-cli-tests.log`、`/tmp/dhr-k4w-cli-package.log`。稳定依据是本记录与仓库源码 / 测试。最近全量基线仍见 [K3-L](K3-L.md)；M1 收口时执行全量。
