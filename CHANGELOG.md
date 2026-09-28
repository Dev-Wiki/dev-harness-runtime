# 变更日志

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
