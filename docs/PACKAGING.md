# 共享打包流水线

K10-B 提供平台 Packager 共用的输入、阶段门禁和静态验证，已用显式注册的 Fake Packager 验证。K5-P / K6-P / K7 / K8 / K9 / K10-G 已接入 Codex、DSH、Cursor、OpenCode、Antigravity 和 Portable 真实 Packager。默认 `dhr` 列出六个平台 ID，但没有把描述符当作可执行能力；未显式注入可信 BuildPipeline 的命令仍返回 `CAPABILITY_MISSING`，不会加载项目中的可执行配置。

## 来源与依赖图

```text
protocol-lock.json + 已固定的干净上游 checkout
本仓 Skill + 已编译 Runtime / Adapter bundle
build/manifests/metadata.json + 实际分发声明引用
                   ↓
        PluginBuildInput（版本、提交、SHA-256、显式 UTC 时间）
                   ↓
pnpm build → 可信 BuildPipeline.generate → .generated/<platform>/plugin/
                                            + generated.json
                   ↓
           BuildPipeline.validate → validation.json
                   ↓
           BuildPipeline.pack → dist/<platform>/...
                                + dist/manifest.json
                                + dist/build-evidence.json
```

`pnpm build` 只执行 TypeScript workspace 编译和独立 CLI bundle，不调用 `generate`。`generate` 不调用编译；`validate` 不调用生成；`pack` 不调用生成或校验。调用者先编译，再用可信代码组装 `PlatformRegistry`、`PluginBuildInput`、`StaticSpec` 和 `BuildPipeline`，将同一注册表交给 CLI。CLI 的 `run` 和打包命令读取同一个注册表；只有带真实 RuntimeAdapter 的条目可执行，只有带真实 PluginPackager 的条目可打包。项目数据和环境变量不能注入代码。不同注册表对象或项目根目录被拒绝。

`PluginBuildInput` 是唯一版本和来源输入：平台、release/Adapter/Core 版本、Skill 和 bundle 摘要、协议锁、元数据及明确 UTC 时间。来源 checkout 必须与声明的 Git HEAD 一致，上游协议 checkout 必须干净且每个锁定文件的 SHA-256 匹配；本仓 Skill、bundle 和分发声明也按实际字节校验。每阶段在 Packager 回调后重验来源与生成目录，漂移不能得到成功记录。共享元数据只从 [metadata.json](../build/manifests/metadata.json) 读取，平台只注入格式必需字段。有限 Skill 转换仅接受 `{{DHR_PATH}}`、`{{DHR_COMMAND}}`、`{{DHR_INVOKE}}` 三个明确 token，不重写流程。

本项目采用 [MIT 许可](../LICENSE)，随包的[分发声明](../build/manifests/DISTRIBUTION_NOTICE.md)包含完整项目许可和[第三方许可声明](../THIRD_PARTY_NOTICES.md)。`metadata.licenseRefs` 必须指向真实文件且摘要匹配；共享元数据在标记允许对外分发时还会核对许可和第三方文本确实进入随包声明。未提交的本地输入可验证并在 `dist/build-evidence.json` 标记 `localUnversioned`；GitHub Release 发布门禁还要求已提交无漂移来源、九个产物的实际大小与 SHA-256 匹配，并与版本和变更日志一致。

## 静态校验和归档

每个平台提供明确且非空的 `StaticSpec`：必需文件、允许文件、JSON manifest 的封闭 Schema、Skill 文件、版本字段和文件引用字段。公共校验覆盖设计 §29 的十项：manifest 结构、必需文件、规范相对路径、Skill frontmatter、重复 Skill、未支持字段、包内容、版本、未完成标记、本机绝对路径。Manifest 的嵌套对象也必须封闭，未知字段失败；引用必须精确命中包内文件。当前共享 JSON 校验只接受受限的 scalar `name` / `description` Skill frontmatter；平台的非 JSON 格式需由对应 Packager 的 `validate` 补足，不得据此声称已验证宿主格式。

文本扫描覆盖可解码的包内容，包括 JS bundle；`https:` URL 和已识别的 `$(git …)` 表达式可保留，具体本机绝对路径和 TODO/TBD/FIXME 标记被拒绝。此扫描是保守 lint，不解释脚本语义，也不能证明插件可安装或 Agent 可执行。平台验证报告与公共检查合并，错误项使 `valid=false`。`pack` 只接受当前输入、生成清单、实际文件字节、校验记录一致的目录；打包后还会重查源目录和每个 artifact 的大小及摘要。每个平台的 `.stage.lock` 防止阶段互相覆盖，根目录的 `.manifest.lock` 串行化跨平台 manifest 更新；崩溃留下的锁必须核实后人工处理，不自动清除。`dist/manifest.json` 是产物事实表，不是运行能力证明。

`createTarGzip` 和 `createZip` 只接受内存中的规范相对路径及普通文件字节，按 UTF-8 路径排序并拒绝大小写别名、路径越界或格式边界溢出。TAR 使用 USTAR、mode 0644、uid/gid 0；gzip mtime 0。ZIP 使用固定 Unix mode 0100644、无额外字段，UTC 时间按 DOS 两秒粒度向下取整。两种归档的时间都来自输入的显式 `buildTimestamp`，不用当前时钟。ZIP 无 ZIP64；超出经典格式限制直接失败。

golden 快照在 [tests/packaging/golden](../tests/packaging/golden/)；普通比较只读，漂移时失败。只有维护者明确调用 `compareGolden(path, snapshot, { update: true })` 才写入新 golden，随后需复核输入与 SHA-256。后续平台 Packager 应各自增加格式 fixture、golden 和真实安装 smoke 证据；当前 Fake Packager 不代表六平台可用。

Codex 的可信入口为 `createCodexBuildPipeline(root, protocolCheckout)`，由调用者提供固定的、干净的上游协议 checkout；输入从本仓 Git HEAD、真实 Skill / CLI / Adapter bundle、共享元数据和提交时间构造。`generate` 输出 `.generated/codex/plugin/` 下的 Marketplace 源布局；`validate` 检查封闭 manifest、来源版本、三个 Skill、相对引用和 bundle 摘要；`pack` 输出单一 `dist/codex/dev-harness-codex-v<version>.zip`。ZIP 解包后把 `marketplace/` 路径交给 `codex plugin marketplace add`。包内 `runtime/source.json` 锁定协议来源、Worker Skill、CLI 与 Adapter 字节；`scripts/dhr.mjs` 仅对 run / resume / reconcile 由这些字节装配 Codex RuntimeServices，实际 Task 前仍须执行真实宿主能力 probe。Linux 宿主需可用的 Codex 登录、Node、Git 与 bubblewrap；可用 `DHR_BWRAP` 指定可信本机 provider。项目 Task 的声明格式见 [执行契约](CONTRACTS.md#自动执行-task-的冻结声明)；`--commit-each` 当前只支持项目 Workflow 明确采用的默认中文 Conventional Commits 模板。包内真实派发、原始 Worker、自主 Task、Core 独立验收、逐任务提交与跨进程恢复均已通过 WSL2 Codex 专项；原生 Windows 已通过相同 ZIP 的 Marketplace 安装、Skill 发现和只读版本自检，但不能运行要求 Linux 隔离的 Executor。证据见 [K5](verification/K5.md)。

编译后的 CLI bundle 包含校验器源码中的占位词正则和依赖库注释，普通文本 lint 会把它们误报为包内容。Codex StaticSpec 仅对与 `PluginBuildInput` SHA-256 完全相同的两个源码锁定 bundle 跳过词法文本 lint；任一字节漂移直接报 `BUNDLE_DIGEST_MISMATCH`。manifest、Skill、README、脚本和声明仍按公共静态规则扫描。这个例外只用于已锁定的代码字节，不授予任意生成文件豁免。

DSH 对应入口为 `createDshBuildPipeline(root, protocolCheckout)`；生成 `package.json`、`cordis.patch.yml`、已编译 Cordis plugin / CLI、三个 Skill、锁定来源 `source.json` 和本地声明，最终在 `dist/dsh/` 生成版本化 tgz；准确文件名由 [DSH Packager](../build/targets/dsh.ts) 定义，并记录在 `dist/manifest.json`。`package.json.dsh.bundle.patch` 指向相对包根的 YAML，peer 精确标注本机 rc.1 启动器实际解析的 Cordis 4.0.2 与 dsh-commands rc.2。插件提供可读 `/dhr-status` 及 Worker 作用域内的受控工具；包内 CLI 在真实宿主能力 probe 通过后可启用 Executor。安装、CommandRuntime 调用与卸载见 [K6-P](verification/K6-P.md)，原始 Worker 与三任务执行证据见 [K6](verification/K6.md)。DSH 的两个已锁定 JS bundle 同样走 SHA-256 绑定例外，其余文本继续接受公共 lint。

Cursor 对应入口为 `createCursorBuildPipeline(root, protocolCheckout)`，生成 Native `.cursor-plugin/plugin.json`、三个共享 Skill、一个可请求 rule、一个只读状态 command 与包内 CLI，输出 `dist/cursor/dev-harness-cursor-v<version>.zip`。ZIP 顶层为 `dev-harness/`，按 Cursor 官方本地插件目录放置并重新加载。离线内容、包内 CLI 与已认证 Cursor Agent CLI `--plugin-dir` 隔离会话中的 `status` Skill 只读版本自检通过。Editor Customize UI、slash command 原生注册及自动 Executor 未验，见 [K7 验证记录](verification/K7.md)。

OpenCode 对应入口为 `createOpenCodeBuildPipeline(root, protocolCheckout)`，从同一锁定输入生成 npm tgz 和项目本地 ZIP。tgz 含 `package.json`、JS 插件导出、已编译 bundle、固定的 `scripts/dhr.mjs` 与三个 Skill；ZIP 按 `.opencode/plugins/`、`.opencode/skills/` 放置，并含 `.opencode/scripts/dhr.mjs` 和版本 manifest。npm 包内 Skill、脚本、bundle 与 manifest 需另行复制到项目 `.opencode/` 对应目录，OpenCode 不保证从 npm 插件自动发现 Skill。两种插件变体不可同时安装。插件默认导出同时满足 OpenCode 1.18.31 的 `server()` 与 2.0.15 的 `setup()`；两个宿主已在隔离项目加载插件和发现三个 Skill。未发布的 tgz 经 localhost 临时 registry 按包名自动安装，两版宿主均已取到当前生成包，2.0.15 报告插件 active；模型会话通过宿主 `skill(status)` 加载共享 Skill。见 [K8 验证记录](verification/K8.md)。

Antigravity 对应入口为 `createAntigravityBuildPipeline(root, protocolCheckout)`，从同一份 Skill 生成 Agent Plugin、项目 `.agents/skills/` 与独立 global Skills 三种 ZIP；每个变体随安装路径携带相同的许可与第三方声明。Plugin 的 `plugin.json` 使用 Agent Plugins 1.0.0；本机 `agy plugin validate/install/list/uninstall` 已确认三个 Skills 被处理并可全局安装、发现、移除。项目范围可把 Plugin ZIP 解压至 `<project>/.agents/plugins/dev-harness/`；隔离项目的静态 validate 已过，会话激活未验。模型会话内 Skill 调用经用户豁免，未实测；独立 Skill 安装也未验证，不能把安装链称为 Executor 能力。见 [K9 验证记录](verification/K9.md)。

Portable 对应入口为 `createAgentPluginBuildPipeline(root, protocolCheckout)`，只生成根 `plugin.json`、三个共享 Skill、README 和分发声明，输出 `dist/agent-plugin/dev-harness-agent-plugin-v<version>.zip`。该产物无独立 Executor；`dhr run --adapter agent-plugin` 在无可信执行器时返回 `CAPABILITY_MISSING`。构建输入契约仍要求 `adapterBundle` 来源，故此打包专用目标把自身编译后的 Packager 文件绑定为来源摘要；它不作为运行能力使用。见 [K10-G 验证记录](verification/K10-G.md)。

## 验证入口

项目构建和测试命令以 [HARNESS](../HARNESS.md) 为准。六平台可信入口为 `createRepositoryBuildPipeline(root, protocolCheckout)`；仓库脚本 `pnpm generate`、`pnpm validate:plugins`、`pnpm run pack` 与 `pnpm dhr release --dry-run` 都需显式 `--protocol-checkout`，详见 [发布说明](RELEASE.md)。`pnpm pack` 是 pnpm 自身命令，不能代替本项目 pack 脚本。K10-B 的可复现专项见 [验证记录](verification/K10-B.md)。发布工作流在 tag 上重新运行完整 `pnpm verify`。
