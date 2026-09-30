# 变更日志

## v0.1.1 — 2026-09-30

### 修复（Fixed）

- 修复 DSH 0.2.0-rc.2 上的插件安装不兼容：`@deepseek-ai/dsh-commands` 与 `@deepseek-ai/dsh-tools` 的 peer 声明由精确 `0.1.5-rc.2` 改为 `^0.2.0-rc.2`，Cordis 按实际解析记为 `~4.0.4`。DSH 只把 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围与运行时版本比较，原精确声明在 0.2.0-rc.2 上被判定为不兼容并拒绝安装。
- 适配 DSH 0.2.0-rc.2 的 Session v4 格式：Session reader 接受 `version: 4`，事件解码器按 v4 表示解析 `tool/result`（`role: "tool"` 直连消息与 `message.toolCallId`），不再依赖已退役的 `tool-result` 包装块。

### 变更（Changed）

- DSH 适配目标基线由 `0.1.5-rc.1` 迁移为 `0.2.0-rc.2`；构建目标、运行时门禁、宿主测试、fixture 与平台基线文档同步更新，并在真实 0.2.0-rc.2 上重新取得验证证据。

## v0.1.0 — 2026-09-28

### 新增（Added）

- 公共 Core 提供 Planning 任务选择、授权、快照与漂移检查、持久状态、恢复、独立验收和串行编排。
- Codex 与 DSH Executor 使用共享契约和独立 Session，支持明确授权后的逐任务提交。
- 从同一份 `run`、`status`、`worker` Skill 源码生成 Codex、DSH、Cursor、OpenCode、Antigravity 和 Portable 共九个本地产物；Portable 包只包含 Skill，没有独立 Executor。
- `dhr` 提供只读状态和诊断、任务执行入口，以及生成、校验、打包和本地 release dry-run。
- Ubuntu 与 Windows CI 分别运行完整离线验证和九产物 dry-run；产物 manifest 记录版本、来源和 SHA-256。
- 采用 MIT 项目许可，九个产物附带项目许可与所打包第三方依赖的许可声明。

### 变更（Changed）

- 平台能力按验证证据区分。Antigravity 的安装、发现与卸载已验证；模型会话内 Skill 调用经用户明确豁免，尚未实测。
