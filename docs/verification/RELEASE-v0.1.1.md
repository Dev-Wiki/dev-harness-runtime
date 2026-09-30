# v0.1.1 GitHub Release 验证

2026-09-30 发布源码为 `2416adb0eaffa87cafb5b8378890f6c6ffc62aaf`；annotated tag `v0.1.1` 指向同一提交，注释与发布说明来自 `CHANGELOG.md` 对应版本。项目使用 MIT 许可，第三方声明随九个产物分发。

本地在 WSL2 运行 `pnpm verify`：Node 测试、22 份 Contract Schema、10 项平台 fixture 与离线 CLI 包检查全部通过；`pnpm verify:protocol --source /tmp/dhr-protocol-locked` 核对协议 1.11.8 的 20 个固定文件通过。在已提交来源上从 `pnpm artifacts:clean` 开始重跑 `pnpm build` 与 `pnpm dhr release --dry-run --protocol-checkout /tmp/dhr-protocol-locked`，`dist/build-evidence.json` 标记 `localUnversioned: false`；`pnpm matrix:check` 与 `node scripts/check-release.mjs v0.1.1` 通过。

[发布工作流 run 36663733000](https://github.com/Dev-Wiki/dev-harness-runtime/actions/runs/36663733000) 在 tag 推送后完成协议校验、完整验证、九产物 dry-run、矩阵与发布门禁，并创建 [GitHub Release v0.1.1](https://github.com/Dev-Wiki/dev-harness-runtime/releases/tag/v0.1.1)。从 Release 下载的九个附件逐一核对：名称、字节数与 SHA-256 全部与本地 `dist/manifest.json` 一致。未执行 npm publish 或平台 Marketplace 发布。

## DSH 0.2.0-rc.2 宿主证据

本版本修复 DSH 0.2.0-rc.2 的安装不兼容（peer 门禁）与 Session v4 格式，见 [CHANGELOG](../../CHANGELOG.md) 与 [平台基线](../integration/PLATFORM_BASELINE.md)。

- 安装与宿主 API：本地 tgz 经 `dsh plugin --profile headless add` 在真实 `@deepseek-ai/dsh@0.2.0-rc.2`（cordis 4.0.4、dsh-tools/dsh-commands 0.2.0-rc.2）上安装成功、进入组合配置且未被判为不兼容；`tests/integration/dsh-smoke/` 10 项与 `packages/adapter-dsh/tests/events.test.mjs` 5 项在真实 0.2.0-rc.2 上全部通过。
- 真实隔离 Executor：使用真实模型凭据与 Linux bubblewrap 0.9.0 运行 `pnpm smoke:dsh-autonomous --three-task --commit-each`。Task A 与 Task B 完整通过——隔离 headless Session、包内 CLI 派发、Core 独立运行冻结验收命令并创建精确提交（`feat(a): 完成任务 A`、`feat(b): 实现 farewell 并归档任务 B`），Run 记录 `completedTasks: ["A", "B"]`。
- Task C 未能通过：Core 以 `INVALID_PLANNING_DELTA`（`Work-order explanatory content changed (docs/plan/Dashboard.md)`）拒绝模型提案，因为模型在收口时改写了 Dashboard 工作顺序的说明性文本。这属于提案合规问题，不是 DSH 适配缺陷。三次运行中的另一次因适配器过严的“成功提交后不得再调用工具”门禁失败；该门禁已在本版本放宽为“允许载荷完全相同的重复提交”，其余工具仍禁止。

因此 DSH Executor 尚无完整三任务链证据：单任务隔离执行、独立验收与受控提交已在 0.2.0-rc.2 上取得，取消恢复与 A→B→C 全链仍待重新取证。Antigravity 模型会话内 Skill 调用按用户决定豁免，仍未实测。
