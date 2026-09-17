# 本地产物 dry-run

当前只支持本地构建、静态校验、打包与 manifest 核对；不会调用 npm publish、push、tag、GitHub Release、Marketplace 或 deploy。正式对外分发仍须先完成项目许可和随包第三方声明门禁，见 [PACKAGING](PACKAGING.md)。`dhr release --dry-run` 不表示 Codex / DSH 自动 Executor 已通过。

在本仓根目录准备一个与 `protocol-lock.json` 固定提交完全一致、无工作区修改的 dev-harness checkout。以下以相邻目录作为例子，`--protocol-checkout` 可指向其他本地位置；它只参与来源核验，不进入产物路径。

```bash
pnpm build
pnpm dhr release --dry-run --protocol-checkout ../dev-harness
pnpm matrix:check
```

命令依次为 Codex、DSH、Cursor、OpenCode、Antigravity 和 Portable 执行 `generate → validate → pack`。每个阶段重验来源和前一阶段的实际字节。`dist/manifest.json` 记录 release、Core 与 Adapter 版本、目标格式、来源提交以及九个产物路径、大小和 SHA-256；`dist/build-evidence.json` 标记未提交的本地输入。`docs/PLATFORM_MATRIX.md` 由 manifest 和可信注册表生成，`pnpm matrix:check` 核对它与实际文件是否一致。输出仅留在 `.generated/` 和 `dist/`；不会发布到外部。

也可逐阶段运行：

```bash
pnpm generate --protocol-checkout ../dev-harness
pnpm validate:plugins --protocol-checkout ../dev-harness
pnpm run pack --protocol-checkout ../dev-harness
```

`pnpm pack` 是 pnpm 自身的命令，因此本项目脚本须写成 `pnpm run pack`。仓库级单平台入口使用 `pnpm dhr build|validate|pack --platform <id> --protocol-checkout <path>`；已安装的独立 CLI 包没有注入仓库 Packager，保持 `CAPABILITY_MISSING` 门禁。源码提交或版本变更后，已有 manifest 可能不再属于当前输入。先显式执行 `pnpm artifacts:clean` 清除本地生成树，再编译和重跑；清理命令发现锁文件、符号链接或特殊文件时会拒绝。

CI 的 `verify` 和 `package-dry-run` 在 Ubuntu 与 Windows runner 分别运行离线检查；宿主安装和模型会话 smoke 不在该工作流中。当前只在 WSL2 本地执行过本命令，原生 runner 的实际结果以 CI 运行记录为准。[能力矩阵](PLATFORM_MATRIX.md)逐平台列出已验证边界，不能把本地 dry-run 当作完整 MVP 验收。
