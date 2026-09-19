# K5-P Codex Plugin 与 Marketplace 打包验证

## 结果与边界

在 WSL2、Node 24.15.0、pnpm 11.1.0、Codex CLI 0.154.0 上，从本仓 Skill、已编译 CLI / Adapter、固定协议 checkout 和共享元数据生成兼容 `.codex-plugin/plugin.json` 包与本地 Marketplace。生成树有 11 个文件，包含三个 Skill、包内 ESM `package.json`、`scripts/dhr.mjs`、Runtime / Adapter bundle 和实际分发声明；ZIP 解包后路径位于 `marketplace/` 下。构建证据标记本次未提交源码为 `localUnversioned`，提交后由最终 K10 dry-run 重建，不将临时 ZIP 当作可发布成品。

后续 K5 验证发现当时包内 `runtime/adapter.js` 仍有 workspace import；K5 已将它改为自包含 bundle，并在临时目录证明可导入且能独立响应 MCP。原 K5-P 的安装、发现及包内 CLI 调用记录不等于 Executor 可运行；更新后的具体构建与校验见 [K5 验证记录](K5.md)。

`codex plugin marketplace add`、`plugin add`、`plugin list`、包内 `node scripts/dhr.mjs --version`（0.1.0）和 `plugin remove` 均在临时隔离的 Codex 配置下成功，卸载后列表为空。原生安装来自实际 ZIP 解包目录，不读写既有个人插件目录。后续 K5 又以自动 smoke 在隔离配置中安装当前生成包，并由全新 Codex 0.155.1 会话显式调用 `$dev-harness:status`；这证明插件 Skill 会话入口，Executor、独立 Session 与授权证据仍以 K5 的分层测试为准。根 Portable fixture 在另一隔离目录也可安装；本产物按设计 §19.1 与当前兼容样例选择 `.codex-plugin`，没有在同一包并放两种 manifest。

## 可复核检查

| 检查 | 本轮结果 |
|---|---|
| `pnpm build`、`pnpm harness:quick` | 通过，TypeScript 与 oxlint 无警告 |
| `node --test tests/packaging/codex.test.mjs` | 3/3 通过；确定性 ZIP golden、Marketplace 引用、Skill 数、缺文件、非法字段、绝对本机路径、重复 Skill、版本与 bundle 摘要负例 |
| `node --test tests/packaging/*.test.mjs` | 34/34 通过，0 跳过 |
| `createCodexBuildPipeline(root, protocolCheckout)` 依次 `generate`、`validate`、`pack` | 真实来源锁与公共流水线通过，生成 `dist/codex/dev-harness-codex-v0.1.0.zip`；静态和平台检查均 valid |
| `python3 .../plugin-creator/scripts/validate_plugin.py .generated/codex/plugin/plugins/dev-harness` | Codex 随附兼容格式校验通过 |
| `codex plugin marketplace add` → `plugin add` → `plugin list` → 包内 `dhr --version` → `plugin remove` → `plugin list` | 临时配置成功，安装标识 `dev-harness@dev-harness-local`，最终无安装项 |
| `pnpm smoke:codex-plugin` | 隔离安装与全新模型会话通过；显式 `$dev-harness:status` 返回唯一权威状态和三个禁止入口，未调用 shell 或 MCP 资源工具 |

源码见 [Codex Packager](../../build/targets/codex.ts)、[共享输入](../../build/targets/source.ts)、[负例和 golden](../../tests/packaging/codex.test.mjs)。本任务仅验收本地包格式和安装链；真正的模型会话、宿主隔离与跨任务行为由 K5 / K10 验证。最终全量 `pnpm verify` 按用户要求在全部剩余开发完成后执行。
