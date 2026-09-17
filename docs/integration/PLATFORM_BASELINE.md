# 平台格式与验证环境基线

取证日期：2026-09-17。目标项目 `dev-harness-runtime`，CLI `dhr`；Run 唯一权威状态为 `$(git rev-parse --git-path dev-harness-runtime)/runs/<run-id>/run.json`。本页固化 R1 的格式输入与验证边界，跨任务门禁以 [Dashboard](../plan/Dashboard.md) 为准。

## 1. 证据分级

| 级别 | 本轮证据 | 能支持的判断 |
|---|---|---|
| 文档 / 公开声明 | 官方规范、安装包公开类型、CLI help/version | 接口可表达、声明字段、观察到的版本 |
| 离线 fixture | [八个 profile](../../tests/fixtures/platform-specs/README.md)，六类产物；10 项测试 | 本仓最小子集、自有无操作模块、路径与摘要一致 |
| 真实宿主 | 未安装测试插件、未调用模型或 Session API | 没有插件 smoke 或 Executor 能力通过结论 |

插件格式版本、插件自身 version、宿主版本、依赖解析版本分开记录。网页为 live 来源，记录访问日期，未声称冻结官网全文；本地公开文件和 fixture 摘要见 [sources.json](../../tests/fixtures/platform-specs/sources.json) 与 [fixture-hashes.json](../../tests/fixtures/platform-specs/fixture-hashes.json)。样例没有实现生产 validator；完整校验、golden、真实安装与能力探测由各平台任务承担。

## 2. 六类产物

| 平台 | 格式与必需字段 | 入口 / fixture | 版本边界 |
|---|---|---|---|
| Codex | 官网当前推荐 Agent Plugins 根 manifest；兼容格式仍受支持；市场目录另有 name、interface.displayName、plugins | `codex-portable/plugin.json`；`codex-compat/plugins/dev-harness-runtime-spec/.codex-plugin/plugin.json`；repo catalog | Portable 1.0.0；兼容格式没有独立数字 schema 版本，本机 validator 以摘要固定 |
| DSH | npm `package.json` 的 `dsh.bundle.patch` 为必需字符串，相对包根 | `dsh/cordis.patch.yml`、`lib/index.js` | 本机 rc.1 启动器 + rc.2 组件；不是纯 rc.1 依赖图 |
| Cursor Native | `.cursor-plugin/plugin.json` 必需 `name`；version 可选 | `cursor/`；`skills/<name>/SKILL.md` | Native 数字格式版本未声明；不能套用 Portable 1.0.0 |
| OpenCode | JS/TS 导出插件函数，返回 hooks；npm 包另需自身 metadata 与入口 | `opencode-local/`；`opencode-npm/package/` + `consumer/opencode.json` | 官方页未声明数字 API schema 版本；本机宿主未找到 |
| Antigravity | Google 教程采用 Portable 根 manifest | `antigravity/plugin.json`、`skills/` | 格式 1.0.0；本机 agy 输出 1.0.0，两个版本数字并不表示同一对象 |
| Portable Agent Plugin | 根 `plugin.json` 必需 `$schema`、`name`；version 可选 | `portable/`；可选 `skills/`、`mcp.json` | Agent Plugins 1.0.0，schema dialect 2020-12；Agent Skills 页面未声明数字版本 |

### Codex

新包可使用根 `plugin.json`；OpenAI 配置放 `extensions.com.openai`。它存在时替代兼容 overlay，不合并。兼容样例保留设计中的 `.codex-plugin/plugin.json`，独立放在另一 fixture，避免同包双重身份。repo marketplace 位于 `.agents/plugins/marketplace.json`，`source.path` 从 marketplace 根解析，必须留在根内。来源：[官方打包规范](https://developers.openai.com/plugins/build/plugins)。

本机随附 `plugin-creator/scripts/validate_plugin.py` 是兼容 profile 的额外离线检查器：要求 name、version、description、author.name，以及 interface 的 displayName、shortDescription、longDescription、developerName、category、defaultPrompt/default_prompt、capabilities。样例包含这些字段及 `skills: ./skills`。这些是该工具快照的检查要求，不代表所有官方格式的最小必需集合。工具拒绝 hooks，但当前官网允许；因此它不能代替未来生产校验器，也不能验证根 portable manifest。

K5-P 已在 Codex 0.154.0 的隔离配置中测试兼容包和根 Portable fixture，两者均可原生安装、发现并移除；最终输出遵循设计 §19.1 的兼容 `.codex-plugin` 格式，未在一个包内混用两种 manifest。包内 CLI 0.1.0 可执行，但未进行模型会话内 Skill 调用，见 [K5-P 验证记录](../verification/K5-P.md)。`codex exec` 的 JSONL、output-schema、输出文件为 K5 候选入口；help 和插件安装成功都不证明结果可靠、历史隔离、取消或权限约束。[官方非交互入口](https://learn.chatgpt.com/docs/non-interactive-mode)。

### DSH

唯一适配目标仍为用户指定的 `dsh --version = 0.1.5-rc.1`。本机 launcher 为 `@deepseek-ai/dsh@0.1.5-rc.1`，依赖范围包含 `^0.1.5-rc.1`。实际读取的 base、agent、session、commands、workflow、workflow-worker-thread、user-approval、sandbox、sandbox-policy、sandbox-local、permission-presets、app-boot、package-manifest、sdk-minimal、sdk-app、atomic-write、skill、session-persistence-jsonl 均为 `0.1.5-rc.2`；Cordis 4.0.2、Schemastery 3.18.2、cordis-plugin-loader 1.0.3。

公开安装包来源根为当前 Node 全局目录下 `@deepseek-ai/dsh`；子包在其 `node_modules/@deepseek-ai/`。入口实际为 `lib/bin.js`。摘要固定关键声明文件，不声称完整依赖图已锁定；K6-P 必须建立可复现依赖锁。

| 公开文件 / 接口 | 当前观察 | 相对旧 rc.8 的处理 |
|---|---|---|
| `dsh-package-manifest/lib/types/types.d.ts` | `DshBundleManifest.patch`；profile bundles 有序列表 | Bundle fixture 只证明声明与路径 |
| `dsh-app-boot/lib/index.js`、SDK patch | 读取 `package.json.dsh.bundle.patch`；`insert` 添加插件 | 空白 patch 失败，停用层用 `[]`；需宿主加载测试 |
| `dsh-commands/lib/types/index.d.ts` | register 返回 disposer；execute 四参数 | images → attachments，加入文件附件；不能照搬旧 handler |
| `dsh-agent/lib/types/index.d.ts` | create/resume 返回 agent/dispose handle，显式 sessionId、可选 seed | setup 增加 agent 参数；seedLength 改 isSeeded/inheritedEventCount；旧 Context.agent 扩展移除 |
| `dsh-agent/lib/types/runtime-types.d.ts`；`index.d.ts:84–85` | 前者定义 cancel / whenIdle；后者限定创建 signal 只管创建阶段 | 返回 handle 后须独立取消并等静止；实际行为未验证 |
| `dsh-session/lib/types/types.d.ts` | SESSION_FORMAT_VERSION 3 | rc.8 为 0；宿主 Session 与旧项目 Run schema 是不同协议 |
| `dsh-workflow` 公开声明 | start 的 parent 必需；result/cancel/dispose | 与历史记录形态一致，未取得逐行 rc.8 比较或运行证明 |
| `dsh-user-approval` | ask/never、单次 action approval | 不等于 dhr RunAuthorization |
| `dsh-sandbox`、policy、local | 文件效果策略；full/partial 只涉及该策略承诺 | 未表达逐 Task 文件白名单、禁止 Git 提交或外部动作；不能据此启用 authorizationEnforced |

本机 SDK minimal patch 显式使用 `danger-full-access`，不得复用为安全默认。Windows ACL / 老 Landlock 可能只有 partial 是随包文档声明，本轮没有运行 confinement probe。K6 的新 Session 必须 create 新身份且不继承 seed，不能用 resume 旧历史替代。旧 Audit / 修复 / QA 与旧 Run 仍由旧实现处理，见 [迁移边界](../DSH_MIGRATION.md)。

K6-P 已从统一源码生成十文件 tgz，并在隔离 DSH `0.1.5-rc.1` headless profile 中安装、组合和卸载；从实际安装包调用启动器所解析 rc.2 的 `CommandRuntime.execute`，只读 `/dhr-status` 返回 success，dispose 后命令消失。profile pnpm 报 peer warning，已记录，不等于 K6 Agent / Session 权限已通过。证据见 [K6-P 验证记录](../verification/K6-P.md)。

### Cursor 与 OpenCode

Cursor Native 使用 `skills/` 默认目录，显式 skills 字段替代默认发现；本地插件测试位置为 `~/.cursor/plugins/local/<name>/`。技能 frontmatter 使用 name/description，名称与目录匹配。见 [Native reference](https://cursor.com/docs/reference/plugins)、[Skills](https://cursor.com/docs/skills)、[本地测试](https://cursor.com/docs/plugins)。

K7 已生成含 Native manifest、三个 Skill、一个非全局 rule、一个 command 和包内 `dhr` 的 ZIP；离线静态、golden 与 CLI 调用通过。Cursor 编辑器在本机 WSL 因 Vsock 错误不可用；本地 Agent CLI 虽提供 `--plugin-dir`，但用户授权后的 headless 临时调用在插件加载前报 `Authentication required`，故原生发现和调用仍无通过证据。见 [K7 验证记录](../verification/K7.md)。

OpenCode local 从 `.opencode/plugins/` 发现；npm 由 `opencode.json.plugin` 指定，宿主负责依赖安装。样例包名仅示意，未发布；Node 导入成功不等于 OpenCode 加载成功。官方没有保证 npm 包内 skills 自动发现，因此技能单独放 `.opencode/skills/<name>/SKILL.md`。来源：[Plugins](https://opencode.ai/docs/plugins/)、[Skills](https://opencode.ai/docs/skills/)。[SDK](https://opencode.ai/docs/sdk/) 有 session.create/prompt/abort 候选入口，尚无本项目 Session 生命周期证明。

K8 已生成 npm tgz 与项目本地 ZIP；离线静态、golden、临时 npm 安装、双入口 Node 导入及包内 CLI 通过。虽当前 PATH 无 OpenCode，通过 `/tmp` 隔离安装的官方 1.18.31 宿主已在临时项目发现本地 ZIP 插件入口与三个 Skill，移除后均消失；npm tgz 已安装包内入口经 `file://` 配置也能被宿主发现。按 npm 包名自动安装、hook 与模型会话调用未验，见 [K8 验证记录](../verification/K8.md)。

### Antigravity 与 Portable

Google Plugin 教程加 `?hl=en` 后可读，补上初查缺口；文档给出 `agy plugin install` 和全局 `~/.gemini/config/plugins/<name>/`。独立 Skills 项目路径为 `.agents/skills/`，全局为 `~/.gemini/config/skills/`，插件内仍为 `skills/`。未证明项目级 plugin 安装路径或最低客户端版本。[Plugin 教程](https://codelabs.developers.google.com/cloud-dev-plugin-agy?hl=en)、[Skills 教程](https://codelabs.developers.google.com/getting-started-with-antigravity-skills)。

K9 已生成 Plugin、项目和 global Skills 三 ZIP；离线静态、golden 与本机 `agy plugin validate/install/list/uninstall` 通过。CLI 验证输出三个 Skill 已处理；没有模型会话内调用、独立 Skill 写入或 Executor 能力证明，见 [K9 验证记录](../verification/K9.md)。

Portable manifest 名称 1–64 字符，小写字母/数字/连字符/点，首尾字母数字，禁止连续连字符或点。样例只使用两个必需字段；其他合法可选字段不在此子集检查器范围。Skills 只发现直接子目录的 SKILL.md。严格 Agent Skills 要求 name/description，而 Google 教程允许省略 name；fixture 采用共同严格子集。[manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)、[Skills 规范](https://agentskills.io/specification)。

可选 MCP 配置必需 `$schema`、`mcpServers`，stdio 需 type/command，远程需 type/url。本轮只校验空 map。生产实现须验证根内路径、symlink 与 `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` 边界，不引入未经证明的别名。[Portable MCP](https://agent-plugins.org/plugin-authors/mcp-servers)。

严格 schema 校验与 tolerant loader 分开：未知 manifest 字段应报告、忽略并继续；无效单个 Skill / server 不应使其他组件全部失效；加载阶段不联网取 schema。本轮负例测试针对严格最小 profile，不是 loader 拒绝策略。[Loading and discovery](https://agent-plugins.org/client-implementers/loading-and-discovery)。

## 3. 本机环境与实际执行记录

| 项目 | 观察结果 | 可测试范围 / 缺口 |
|---|---|---|
| OS | Linux 6.6.87.2-microsoft-standard-WSL2，x86_64 | 本轮只证明 WSL2；无原生 Linux / Windows 测试 |
| 工具链 | Node 24.15.0、pnpm 11.1.0、Python 3.12.3、Git 2.43.0 | fixture 使用 Python 标准库 + Node；工程入口尚待 V0 |
| Codex | codex-cli 0.154.0；exec help 成功 | 有 json/output-schema/output-last-message/sandbox/ignore-user-config；只读 FS 导致 PATH alias 警告，退出 0 |
| DSH | 0.1.5-rc.1；顶层 help 成功 | 可查声明；未启动 profile（profile help 可能初始化宿主） |
| Cursor | `agent --version` 为 2026.06.26-7079533 | `cursor --version` 报 WSL Vsock socket failed；不能确定编辑器版本或运行能力 |
| Antigravity CLI | `agy --version` 为 1.0.0；help 有 plugin 子命令 | 只证明入口与输出；没有安装来源认证、最低版本或加载 smoke |
| OpenCode / PowerShell | 当前 PATH 没找到 opencode / pwsh | 不等于 Windows 或其他环境没有安装 |

本轮不读取凭据、账户、用户会话或真实配置；不启动模型、安装插件、更新全局 marketplace。原生 OS、宿主安装后发现/调用/卸载、权限隔离仍需分别记录。

## 4. 后续 smoke 与自动执行门禁

| 对象 | 后续可复核步骤 | 当前证据 |
|---|---|---|
| Codex Plugin | 隔离 marketplace → 安装 → 新会话发现 Skill → 显式调用 → 移除并确认消失 | 未运行 |
| DSH Bundle | 固定完整依赖 → tgz 安装 → Cordis/Command 发现 → disposer/卸载 → 无残留 | 未运行 |
| Cursor | 隔离本地 plugin → reload → Customize 发现与调用 → 删除测试包再 reload | 未运行 |
| OpenCode | 独立测试 local 和可解析 npm 包；加载 hook 证据；Skill 单独发现；移除后新会话确认 | 未运行 |
| Antigravity | 原生 plugin 安装/发现/调用/卸载；独立 Skills 另测 | 未运行 |
| Portable | 本地 schema/路径/golden；对每个宣称兼容的客户端再做 smoke | 仅最小 fixture |

所有真实 smoke 应使用专门测试环境和明确授权，记录精确宿主/组件版本；格式通过不能替代运行证据。Codex / DSH 的 freshSession、结构化结果、cancel 后子进程静止、恢复和 authorizationEnforced 均未验证。Core 验证命令与 Git hook 也必须经过同一权限边界；不得只限制 Worker prompt。没有相应证据时，能力不可宣称为 true，自动任务执行保持门禁。

R1 的授权验收是登记“自动执行前必须证明”的条件，本轮没有自动执行，因此没有声称该未来条件已实测满足。缺口转入 K4-V / K5 / K6；这不妨碍完成本任务规定的资料、fixture 与环境基线。
