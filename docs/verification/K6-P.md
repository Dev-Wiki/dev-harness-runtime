# K6-P DSH Bundle 打包验证

## 结果与边界

本机 `dsh --version` 为 `0.1.5-rc.1`。其全局启动器实际解析的公开组件包括 `@deepseek-ai/cordis@4.0.2`、`@deepseek-ai/dsh-commands@0.1.5-rc.2` 和 `@deepseek-ai/dsh-session@0.1.5-rc.2`；包将前两个直接 peer 精确声明，未把启动器版本误写成所有组件版本。十文件 tgz 含 `package.json`、`cordis.patch.yml`、三个共享 Skill、已编译 CLI / Cordis plugin、命令包装器和分发声明。包只提供可读 `/dhr-status` Human Command，明确报告 Task Executor 尚未启用。

真实来源经 `createDshBuildPipeline(root, protocolCheckout)` 的公共生成、静态校验和打包阶段通过；本次源码未提交，`dist/build-evidence.json` 标记 `localUnversioned`。提交后由最终 K10 dry-run 在一致的 HEAD 上重建所有产物。固定输入 tgz 的路径与 SHA-256 存入显式更新的 [golden](../../tests/packaging/golden/dsh.json)。

本机隔离 `DSH_HOME` 内的 `headless` profile 使用 `dsh plugin --profile headless add <tgz> --offline --ignore-scripts --strict-peer-dependencies=false` 成功安装，`--dump-config` 出现 `id/name: dev-harness-runtime`。profile 的 pnpm 输出 peer dependency 警告，未将其隐去；实际宿主模块及 API 调用仍按下述步骤验证。从该 profile 的已安装 `node_modules/dev-harness-runtime/lib/index.js` 导入插件，使用启动器解析的 rc.2 `Context`、`CommandRuntime`、`SessionStore` 注册并通过 `ctx.commands.execute(agent, '/dhr-status', [], signal)` 调用，获得 `kind: success`；dispose 后 `find` 不再返回命令。随后 `dsh plugin --profile headless remove dev-harness-runtime` 成功，组合配置中不再出现该行。直接把 `/dhr-status` 作为 headless 模型文本参数会进入模型回合，不能算作 Human Command 调用，故只采用公开 CommandRuntime API 作为调用证据。

这些结果证明本地包格式、宿主插件生命周期和只读命令，不证明 Agent 创建、Run 执行、Worker 授权隔离或旧 DSH 流程迁移。旧 Audit / 修复 / QA 与旧 Run 仍留旧仓；K6 另做通用行为等价和 Executor 验证。

## 可复核检查

| 检查 | 本轮结果 |
|---|---|
| `pnpm build`、`pnpm harness:quick` | 通过，类型和 lint 无警告 |
| `node --test tests/packaging/dsh.test.mjs` | 3/3 通过，含生成内容、golden、负例与模拟 disposer |
| `node --test tests/packaging/*.test.mjs` | 37/37 通过，0 跳过 |
| 真实来源 `generate` → `validate` → `pack` | valid；本地 `dist/dsh/dev-harness-dsh-v0.1.0.tgz` 解包 10 文件，包内 `dhr --version` 返回 0.1.0 |
| DSH 0.1.5-rc.1 隔离 profile 安装 / dump-config / 已安装包 CommandRuntime 调用 / disposer / 卸载 | 通过；调用使用 rc.2 公开组件，未调用模型 |

源码见 [DSH Packager](../../build/targets/dsh.ts)、[Cordis 插件](../../packages/adapter-dsh/src/plugin.ts) 和 [专项测试](../../tests/packaging/dsh.test.mjs)。最终全量 `pnpm verify` 按用户要求在全部剩余开发完成后运行。
