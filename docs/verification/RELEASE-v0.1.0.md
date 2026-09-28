# v0.1.0 GitHub Release 验证

2026-09-28 发布源码为 `7892d742cf1314c0d2ac7fe5112877ba51c97904`；annotated tag `v0.1.0` 指向同一提交，注释与发布说明来自 `CHANGELOG.md` 对应版本。项目使用 MIT 许可，第三方声明覆盖 CLI bundle source map 中的 11 个锁定依赖。

在 WSL2 本机运行 `DHR_TEST_BWRAP=/tmp/dhr-bwrap-test pnpm verify`：662 项 Node 测试中 656 通过、0 失败、6 项按默认配置跳过；22 份 Contract Schema、10 项 fixture 和离线 CLI 包检查通过。`pnpm verify:protocol --source /tmp/dhr-protocol-K7` 核对协议 1.11.8 的 20 个固定文件通过。最终已提交来源上，两次从 `pnpm artifacts:clean` 开始运行 `pnpm build` 与 `pnpm dhr release --dry-run --protocol-checkout /tmp/dhr-protocol-K7`，两次 `dist/manifest.json` 的 SHA-256 均为 `35c3953971db9b139e6bd777c73fe7e1c5b2f9659d84c69962dbf5c78034eb33`。`pnpm matrix:check` 与 `node scripts/check-release.mjs v0.1.0` 通过；九个归档各含一份与源码字节相同的项目许可和第三方声明。

[最终 main CI run 36405581890](https://github.com/Dev-Wiki/dev-harness-runtime/actions/runs/36405581890) 的 Ubuntu / Windows `verify` 和 `package-dry-run` 四项 job 全部通过。[发布工作流 run 36407769277](https://github.com/Dev-Wiki/dev-harness-runtime/actions/runs/36407769277) 完成协议、全量验证、本地 dry-run、矩阵和发布门禁后，创建了 [GitHub Release v0.1.0](https://github.com/Dev-Wiki/dev-harness-runtime/releases/tag/v0.1.0)。远端九个附件的名称、大小及 GitHub 返回的 SHA-256 digest 与最终本地 manifest 逐项一致，无缺项或多项。未执行 npm publish 或平台 Marketplace 发布。

Antigravity 模型会话内 Skill 调用按用户决定豁免，仍未实测；发布成功不构成该宿主自动 Executor 的能力证据。
