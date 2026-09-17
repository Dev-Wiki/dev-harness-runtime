# K5-P Codex Plugin 与 Marketplace 打包验证

## 结果与边界

在 WSL2、Node 24.15.0、pnpm 11.1.0、Codex CLI 0.154.0 上，从本仓 Skill、已编译 CLI / Adapter、固定协议 checkout 和共享元数据生成兼容 `.codex-plugin/plugin.json` 包与本地 Marketplace。生成树有 11 个文件，包含三个 Skill、包内 ESM `package.json`、`scripts/dhr.mjs`、Runtime / Adapter bundle 和实际分发声明；ZIP 解包后路径位于 `marketplace/` 下。构建证据标记本次未提交源码为 `localUnversioned`，提交后由最终 K10 dry-run 重建，不将临时 ZIP 当作可发布成品。

`codex plugin marketplace add`、`plugin add`、`plugin list`、包内 `node scripts/dhr.mjs --version`（0.1.0）和 `plugin remove` 均在临时隔离的 Codex 配置下成功，卸载后列表为空。原生安装来自实际 ZIP 解包目录，不读写既有个人插件目录。本轮未发起模型会话内 Skill 调用；插件可发现与 CLI 可调用不能推定 Executor、独立 Session、结构化结果或授权能力。根 Portable fixture 在另一隔离目录也可安装；本产物按设计 §19.1 与当前兼容样例选择 `.codex-plugin`，没有在同一包并放两种 manifest。

## 可复核检查

| 检查 | 本轮结果 |
|---|---|
| `pnpm build`、`pnpm harness:quick` | 通过，TypeScript 与 oxlint 无警告 |
| `node --test tests/packaging/codex.test.mjs` | 3/3 通过；确定性 ZIP golden、Marketplace 引用、Skill 数、缺文件、非法字段、绝对本机路径、重复 Skill、版本与 bundle 摘要负例 |
| `node --test tests/packaging/*.test.mjs` | 34/34 通过，0 跳过 |
| `createCodexBuildPipeline(root, protocolCheckout)` 依次 `generate`、`validate`、`pack` | 真实来源锁与公共流水线通过，生成 `dist/codex/dev-harness-codex-v0.1.0.zip`；静态和平台检查均 valid |
| `python3 .../plugin-creator/scripts/validate_plugin.py .generated/codex/plugin/plugins/dev-harness` | Codex 随附兼容格式校验通过 |
| `codex plugin marketplace add` → `plugin add` → `plugin list` → 包内 `dhr --version` → `plugin remove` → `plugin list` | 临时配置成功，安装标识 `dev-harness@dev-harness-local`，最终无安装项 |

源码见 [Codex Packager](../../build/targets/codex.ts)、[共享输入](../../build/targets/source.ts)、[负例和 golden](../../tests/packaging/codex.test.mjs)。本任务仅验收本地包格式和安装链；真正的模型会话、宿主隔离与跨任务行为由 K5 / K10 验证。最终全量 `pnpm verify` 按用户要求在全部剩余开发完成后执行。
