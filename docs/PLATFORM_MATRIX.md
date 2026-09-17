# 平台能力证据矩阵

本表只记录已验证的能力。打包、原生安装和自动 Executor 分别判断；未验证的能力保持关闭。`agent-plugin` 是平台中立的 Skill 包，没有独立 Executor。

| 目标 | 生成 / 静态 | 宿主安装 / 发现 | 会话内 Skill 或命令调用 | fresh Session Executor | 自动编排 |
|---|---|---|---|---|---|
| Codex | 通过，[K5-P](verification/K5-P.md) | 隔离安装 / 移除通过 | 未验证 | 未启用，[K5](plan/tasks/K5.md) | 关闭 |
| DSH | 通过，[K6-P](verification/K6-P.md) | 隔离安装 / 卸载通过 | `CommandRuntime` 只读命令通过；模型会话未验证 | 未启用，[K6](plan/tasks/K6.md) | 关闭 |
| Cursor | 通过，[K7](verification/K7.md) | 未验证 | 未验证 | 未实现 | 关闭 |
| OpenCode | 双产物通过，[K8](verification/K8.md) | npm tgz 离线安装通过；OpenCode 宿主未验证 | 未验证 | 未实现 | 关闭 |
| Antigravity | 三产物通过，[K9](verification/K9.md) | `agy` 安装 / 发现 / 卸载通过 | 模型会话未验证 | 未实现 | 关闭 |
| Portable Agent Plugin | 六文件 ZIP 通过，[K10-G](verification/K10-G.md) | 目标客户端未逐一验证 | 未验证 | 无独立 Executor | 关闭；缺 Adapter 返回 `CAPABILITY_MISSING` |

能力来源以各验证记录和其测试命令为准。任何平台要从“未启用”改为可执行，必须通过共享 Executor 契约、宿主真实 Session、取消与静止、结果校验及逐 Task 授权；仅有 manifest 或安装成功不能推导运行能力。
