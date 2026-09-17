# dev-harness-runtime

dev-harness 的统一执行 Runtime 与多平台插件分发层。任务选择、状态、授权、恢复和编排由公共 Core 承担，宿主接入由 Adapter 负责，安装产物由 Packager 生成。

## 当前阶段

项目处于开发规划阶段，已初始化本地 Git 仓库；Runtime、CLI 和构建工具链尚未实现。

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

构建和测试入口由后续工程初始化任务建立，并在 `HARNESS.md` 中记录实际验证结果。
