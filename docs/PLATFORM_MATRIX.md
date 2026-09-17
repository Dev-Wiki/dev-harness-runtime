# 平台能力证据矩阵

本表由本地 release manifest 的九个实际产物摘要与可信 PlatformRegistry 生成；只表示打包产物和当前注册能力。宿主安装、会话内 Skill 调用及授权隔离见逐任务验证记录，不能从静态包推断。

| 目标 | 产物数 | 静态产物 | RuntimeAdapter | 自动编排 | 证据 |
|---|---:|---|---|---|---|
| Codex | 1 | SHA-256 已核对 | 未注册 | 关闭 | [K5-P](plan/archive/M3/K5-P.md) / [验证](verification/K5-P.md) |
| DSH | 1 | SHA-256 已核对 | 未注册 | 关闭 | [K6-P](plan/archive/M3/K6-P.md) / [验证](verification/K6-P.md) |
| Cursor | 1 | SHA-256 已核对 | 未注册 | 关闭 | [K7](plan/tasks/K7.md) / [验证](verification/K7.md) |
| OpenCode | 2 | SHA-256 已核对 | 未注册 | 关闭 | [K8](plan/tasks/K8.md) / [验证](verification/K8.md) |
| Antigravity | 3 | SHA-256 已核对 | 未注册 | 关闭 | [K9](plan/tasks/K9.md) / [验证](verification/K9.md) |
| Portable Agent Plugin | 1 | SHA-256 已核对 | 无独立 Executor | 关闭 | [K10-G](plan/archive/M3/K10-G.md) / [验证](verification/K10-G.md) |

Codex / DSH 的 Task Executor 仍须通过真实 fresh Session、结构化结果、取消后静止和逐 Task 授权门禁；其余宿主的安装与调用亦分别报告。Portable 只携带共享 Skill，没有独立 Executor；无可信 Adapter 的运行请求返回 `CAPABILITY_MISSING`。对外分发仍受项目许可门禁约束。
