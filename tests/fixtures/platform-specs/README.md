# R1 平台格式样例

这些文件是人工编写的最小格式输入，不是生成产物或可用 Runtime。平台规范、环境与宿主门禁见 [平台基线](../../../docs/integration/PLATFORM_BASELINE.md)。

| 目录 | 用途 |
|---|---|
| `codex-compat/` | 兼容 manifest、Skills 与 repo marketplace；catalog 路径相对于此目录 |
| `codex-portable/` | 当前官网建议的根 manifest，无 OpenAI 专用扩展 |
| `dsh/` | npm 包、Bundle patch 和无操作 Cordis 入口 |
| `cursor/` | Native manifest 与 Skill |
| `opencode-local/` | 本地模块；独立 Skills 单独发现 |
| `opencode-npm/` | npm 模块和消费配置；示意包未发布，禁止把此名字当作可安装包 |
| `antigravity/` | Google 教程对应根 manifest 与 Skill |
| `portable/` | Agent Plugins 1.0.0 根 manifest、Skill 与空 MCP 配置 |

仓库根执行 `python3 tests/fixtures/platform-specs/check.py`。仅需 Python 标准库和 Node，检查 fixture 子集、相对路径、无操作模块出口及负例。它不实现完整 JSON Schema、YAML 或宿主 loader，不能用于判断任意插件合法。未知字段在严格样例中失败，并不表示 portable loader 应拒绝整个包。

`sources.json` 记录官方 URL、访问日期、profile 与本机公开声明文件摘要。网页没有冻结全文或 commit；`fixture-hashes.json` 只固定本仓样例和来源登记文件的字节，不能冒充官网内容哈希。规范漂移时重新取证、审查后更新样例与摘要；禁止在校验时自动刷新摘要。

不运行安装、插件发现、模型请求或网络访问。Node 仅加载这里自行编写的无依赖函数。带 `private: true` 的包禁止误发布，实际打包规则留给对应 Packager。
