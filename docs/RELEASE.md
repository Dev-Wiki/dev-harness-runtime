# 构建与 GitHub Release

`dhr release --dry-run` 只在本地构建、静态校验、打包与核对 manifest，不执行 npm publish、push、tag、GitHub Release、Marketplace 或 deploy。GitHub Release 由已提交的 annotated `vMAJOR.MINOR.PATCH` tag 触发独立工作流；它在上传前重新验证许可、第三方声明、版本、来源和九个产物的大小与 SHA-256。Codex / DSH 自动 Executor 已由独立宿主验收；本地 dry-run 不代替宿主会话调用。

在本仓根目录准备一个与 `protocol-lock.json` 固定提交完全一致、无工作区修改的 dev-harness checkout，并把路径设为 `DHR_PROTOCOL_CHECKOUT`。当前相邻 `../dev-harness` 已漂移，不能用于锁定构建；协议路径只参与来源核验，不进入产物。

```bash
pnpm build
pnpm verify:protocol --source "$DHR_PROTOCOL_CHECKOUT"
pnpm dhr release --dry-run --protocol-checkout "$DHR_PROTOCOL_CHECKOUT"
pnpm matrix:check
```

命令依次为 Codex、DSH、Cursor、OpenCode、Antigravity 和 Portable 执行 `generate → validate → pack`。每个阶段重验来源和前一阶段的实际字节。`dist/manifest.json` 记录 release、Core 与 Adapter 版本、目标格式、来源提交以及九个产物路径、大小和 SHA-256；`dist/build-evidence.json` 标记未提交的本地输入。`docs/PLATFORM_MATRIX.md` 由 manifest 和可信注册表生成，`pnpm matrix:check` 核对它与实际文件是否一致。输出仅留在 `.generated/` 和 `dist/`；不会发布到外部。

也可逐阶段运行：

```bash
pnpm generate --protocol-checkout "$DHR_PROTOCOL_CHECKOUT"
pnpm validate:plugins --protocol-checkout "$DHR_PROTOCOL_CHECKOUT"
pnpm run pack --protocol-checkout "$DHR_PROTOCOL_CHECKOUT"
```

`pnpm pack` 是 pnpm 自身的命令，因此本项目脚本须写成 `pnpm run pack`。仓库级单平台入口使用 `pnpm dhr build|validate|pack --platform <id> --protocol-checkout <path>`；已安装的独立 CLI 包没有注入仓库 Packager，保持 `CAPABILITY_MISSING` 门禁。源码提交或版本变更后，已有 manifest 可能不再属于当前输入。先显式执行 `pnpm artifacts:clean` 清除本地生成树，再编译和重跑；清理命令发现锁文件、符号链接或特殊文件时会拒绝。

CI 的 `verify` 和 `package-dry-run` 已在 Ubuntu 与 Windows runner 分别通过离线检查，见 [run 36394754252](https://github.com/Dev-Wiki/dev-harness-runtime/actions/runs/36394754252)；宿主安装和模型会话 smoke 不在该工作流中。[能力矩阵](PLATFORM_MATRIX.md)逐平台列出已验证边界。Antigravity 会话调用经用户明确豁免，仍未实测。

## GitHub Release 发布门禁

项目采用 [MIT 许可](../LICENSE)。[第三方声明](../THIRD_PARTY_NOTICES.md)逐项保留进入 JavaScript bundle 的依赖许可文本；九个产物均内嵌两类文本合成的 `DISTRIBUTION_NOTICE.md`。源码、上游协议、版本与变更日志须已提交并无漂移。本地 dry-run 后运行 `node scripts/check-release.mjs v0.1.0`，它检查九个实际产物、许可文本和 manifest；`node scripts/release-notes.mjs v0.1.0` 从 [CHANGELOG](../CHANGELOG.md) 对应版本生成 tag 注释与发布说明。

[发布工作流](../.github/workflows/release.yml)在 tag 推送后于 Ubuntu runner 重新安装锁定依赖，运行协议校验、完整验证、六平台九产物 dry-run、矩阵检查及发布门禁，再用 GitHub CLI 创建 Release 并上传 manifest 中的九个文件。工作流不发布 npm 包或平台 Marketplace，也不把 Antigravity 未实测的会话调用写成通过。失败时不应把本地历史摘要当作已发布产物；以最终 Release 附件和工作流结果为准。

## 已发布版本

- [v0.1.0 GitHub Release](https://github.com/Dev-Wiki/dev-harness-runtime/releases/tag/v0.1.0)：2026-09-28 发布，九个附件；大小和 SHA-256 与最终构建 manifest 逐项一致。完整取证见[发布验证记录](verification/RELEASE-v0.1.0.md)。
