# 共享打包流水线

K10-B 提供平台 Packager 共用的输入、阶段门禁和静态验证，已用显式注册的 Fake Packager 验证。K5-P / K6-P / K7 / K8 / K9 已接入 Codex、DSH、Cursor、OpenCode 和 Antigravity 真实 Packager；Portable 仍待接入。默认 `dhr` 列出六个平台 ID，但没有把描述符当作可执行能力；未显式注入可信 BuildPipeline 的命令仍返回 `CAPABILITY_MISSING`，不会加载项目中的可执行配置。

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

本项目尚未发布项目许可。[分发声明](../build/manifests/DISTRIBUTION_NOTICE.md) 仅记录本地构建门禁，不授予对外分发权。`metadata.licenseRefs` 必须指向真实文件且摘要匹配；缺失时不能伪造许可。未提交的本地输入可验证并在 `dist/build-evidence.json` 标记 `localUnversioned`；正式对外分发还需项目许可和第三方声明、已提交无漂移来源及后续发布门禁。

## 静态校验和归档

每个平台提供明确且非空的 `StaticSpec`：必需文件、允许文件、JSON manifest 的封闭 Schema、Skill 文件、版本字段和文件引用字段。公共校验覆盖设计 §29 的十项：manifest 结构、必需文件、规范相对路径、Skill frontmatter、重复 Skill、未支持字段、包内容、版本、未完成标记、本机绝对路径。Manifest 的嵌套对象也必须封闭，未知字段失败；引用必须精确命中包内文件。当前共享 JSON 校验只接受受限的 scalar `name` / `description` Skill frontmatter；平台的非 JSON 格式需由对应 Packager 的 `validate` 补足，不得据此声称已验证宿主格式。

文本扫描覆盖可解码的包内容，包括 JS bundle；`https:` URL 和已识别的 `$(git …)` 表达式可保留，具体本机绝对路径和 TODO/TBD/FIXME 标记被拒绝。此扫描是保守 lint，不解释脚本语义，也不能证明插件可安装或 Agent 可执行。平台验证报告与公共检查合并，错误项使 `valid=false`。`pack` 只接受当前输入、生成清单、实际文件字节、校验记录一致的目录；打包后还会重查源目录和每个 artifact 的大小及摘要。每个平台的 `.stage.lock` 防止阶段互相覆盖，根目录的 `.manifest.lock` 串行化跨平台 manifest 更新；崩溃留下的锁必须核实后人工处理，不自动清除。`dist/manifest.json` 是产物事实表，不是运行能力证明。

`createTarGzip` 和 `createZip` 只接受内存中的规范相对路径及普通文件字节，按 UTF-8 路径排序并拒绝大小写别名、路径越界或格式边界溢出。TAR 使用 USTAR、mode 0644、uid/gid 0；gzip mtime 0。ZIP 使用固定 Unix mode 0100644、无额外字段，UTC 时间按 DOS 两秒粒度向下取整。两种归档的时间都来自输入的显式 `buildTimestamp`，不用当前时钟。ZIP 无 ZIP64；超出经典格式限制直接失败。

golden 快照在 [tests/packaging/golden](../tests/packaging/golden/)；普通比较只读，漂移时失败。只有维护者明确调用 `compareGolden(path, snapshot, { update: true })` 才写入新 golden，随后需复核输入与 SHA-256。后续平台 Packager 应各自增加格式 fixture、golden 和真实安装 smoke 证据；当前 Fake Packager 不代表六平台可用。

Codex 的可信入口为 `createCodexBuildPipeline(root, protocolCheckout)`，由调用者提供固定的、干净的上游协议 checkout；输入从本仓 Git HEAD、真实 Skill / CLI / Adapter bundle、共享元数据和提交时间构造。`generate` 输出 `.generated/codex/plugin/` 下的 Marketplace 源布局；`validate` 检查封闭 manifest、来源版本、三个 Skill、相对引用和 bundle 摘要；`pack` 输出单一 `dist/codex/dev-harness-codex-v<version>.zip`。ZIP 解包后把 `marketplace/` 路径交给 `codex plugin marketplace add`。包内 `scripts/dhr.mjs` 可运行已编译 CLI；Host Executor 能力仍需 K5 probe。

编译后的 CLI bundle 包含校验器源码中的占位词正则和依赖库注释，普通文本 lint 会把它们误报为包内容。Codex StaticSpec 仅对与 `PluginBuildInput` SHA-256 完全相同的两个源码锁定 bundle 跳过词法文本 lint；任一字节漂移直接报 `BUNDLE_DIGEST_MISMATCH`。manifest、Skill、README、脚本和声明仍按公共静态规则扫描。这个例外只用于已锁定的代码字节，不授予任意生成文件豁免。

DSH 对应入口为 `createDshBuildPipeline(root, protocolCheckout)`；生成 `package.json`、`cordis.patch.yml`、已编译 Cordis plugin / CLI、三个 Skill 和本地声明，最终打为 `dist/dsh/dev-harness-dsh-v<version>.tgz`。`package.json.dsh.bundle.patch` 指向相对包根的 YAML，peer 精确标注本机 rc.1 启动器实际解析的 Cordis 4.0.2 与 dsh-commands rc.2。插件只注册可读 `/dhr-status`，Executor 继续关闭；安装、公开 CommandRuntime 调用与卸载见 [K6-P 验证记录](verification/K6-P.md)。DSH 的两个已锁定 JS bundle 同样走 SHA-256 绑定例外，其余文本继续接受公共 lint。

Cursor 对应入口为 `createCursorBuildPipeline(root, protocolCheckout)`，生成 Native `.cursor-plugin/plugin.json`、三个共享 Skill、一个可请求 rule、一个只读状态 command 与包内 CLI，输出 `dist/cursor/dev-harness-cursor-v<version>.zip`。ZIP 顶层为 `dev-harness/`，按 Cursor 官方本地插件目录放置并重新加载。当前只完成离线内容和包内 CLI 验证；宿主 `--plugin-dir` 调用被自动审批拒绝，不能记为安装 smoke 或 Executor 能力。见 [K7 验证记录](verification/K7.md)。

OpenCode 对应入口为 `createOpenCodeBuildPipeline(root, protocolCheckout)`，从同一锁定输入生成 npm tgz 和项目本地 ZIP。tgz 含 `package.json`、JS 插件导出、已编译 bundle 与三个 Skill；ZIP 按 `.opencode/plugins/` 和 `.opencode/skills/` 放置。npm 包内 Skill 需另行复制到原生 Skill 目录，OpenCode 不保证从 npm 插件自动发现。两种插件变体不可同时安装。离线 npm 安装、入口导入和包内 CLI 已通过；本机无 OpenCode 宿主，真实加载未验。见 [K8 验证记录](verification/K8.md)。

Antigravity 对应入口为 `createAntigravityBuildPipeline(root, protocolCheckout)`，从同一份 Skill 生成 Agent Plugin、项目 `.agents/skills/` 与独立 global Skills 三种 ZIP。Plugin 的 `plugin.json` 使用 Agent Plugins 1.0.0；本机 `agy plugin validate/install/list/uninstall` 已确认三个 Skills 被处理并可安装、发现、移除。尚未调用模型会话内 Skill 或验证独立 Skill 安装，不能把安装链称为 Executor 能力。见 [K9 验证记录](verification/K9.md)。

## 验证入口

项目构建和测试命令以 [HARNESS](../HARNESS.md) 为准。K10-B 的可复现专项见 [验证记录](verification/K10-B.md)：`pnpm build`、`pnpm harness:quick`、`node --test tests/packaging/*.test.mjs packages/cli/tests/build.test.mjs`、`pnpm schemas:check` 和 `pnpm test:cli-package`。只在里程碑收口时运行全量 `pnpm verify`，除非后续变更扩大影响范围。
