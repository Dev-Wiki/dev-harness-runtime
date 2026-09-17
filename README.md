# dev-harness-runtime

dev-harness 的统一执行 Runtime 与多平台插件分发层。任务选择、状态、授权、恢复和编排由公共 Core 承担，宿主接入由 Adapter 负责，安装产物由 Packager 生成。

## 当前阶段

项目已建立 TypeScript / Node.js workspace、Adapter / Build Registry 和 CLI 骨架。`dhr` 当前提供 help / version；任务编排、Run 状态与平台打包尚未实现。

- 项目与仓库名：`dev-harness-runtime`
- CLI：`dhr`
- DSH 适配目标：`0.1.5-rc.1`
- Run 状态根：`$(git rev-parse --git-path dev-harness-runtime)/runs/`
- 每个 Run 的唯一权威状态文件：`<run-id>/run.json`

## 项目入口

- [文档导航](docs/README.md)
- [开发看板](docs/plan/Dashboard.md)
- [资料完整性评估](docs/plan/Readiness.md)
- [Git 提交与发布规范](docs/GIT_WORKFLOW.md)

## 本地开发

使用 Node `24.15.0`、pnpm `11.1.0`，fixture 校验另需 Python 3.12。依赖版本由锁文件固定。

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
pnpm dhr --help
```

已验证环境为 WSL2；Windows / 原生 Linux 的 CI 已配置，尚无远端运行结果。构建、测试及命令语义以 [HARNESS](HARNESS.md) 为准；模块边界见 [ARCHITECTURE](ARCHITECTURE.md)。

`protocol-lock.json` 固定上游提交和文件摘要。需要验证上游 checkout 时运行 `pnpm verify:protocol --source <checkout>`，不会自动下载或更新协议。
