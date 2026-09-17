# dev-harness-runtime 设计与实施规划

> 本文为项目内唯一设计正文。当前实现以 [ARCHITECTURE](../../ARCHITECTURE.md) 为事实入口；公共接口与设计细化见 [CONTRACTS](../CONTRACTS.md) 和 [R0 决策](../decisions/runtime-contracts.md)。推荐目录及示例不代表已经实现；构建阶段按 R0 的 build → generate → validate → pack 划分。

> 仓库建议：`Dev-Wiki/dev-harness-runtime`  
> 定位：dev-harness 的统一 Runtime、跨平台执行引擎与插件打包仓库。  
> 命名说明：仓库名使用 `dev-harness-runtime`，因为核心职责不仅是插件打包，还包括通用编排、状态、恢复、授权、Executor 与多平台运行时适配。  
> 命令说明：CLI 统一使用 `dhr`，即 `dev-harness-runtime` 的缩写。  
> 核心原则：**流程只维护一份，平台差异收敛到 Adapter / Packager。**

---

## 1. 背景

`dev-harness` 已经定义了跨 Agent、跨会话都应保持稳定的工程约束：

- Project Context
- Planning / Dashboard / Task Packet
- Verification / HARNESS
- Documentation SSOT
- Git Workflow
- Auto Fix
- Codebase Audit
- Retrospective

这些内容属于**平台无关协议**。

真正存在平台差异的是：

- 如何在宿主中发现 Skill / Plugin；
- 如何启动一个新的 Agent / Session；
- 如何把任务参数传入宿主；
- 如何得到结构化执行结果；
- 如何注册 Command / Agent / Hook；
- 插件如何安装、升级、卸载；
- 插件最终应该打包成什么格式。

因此不应为 Codex、DSH、Cursor、OpenCode、Antigravity 分别维护一套：

- Task Selector
- Snapshot
- Run State
- Authorization
- Recovery
- Orchestrator
- Result Validation

否则长期必然出现行为漂移。

`dev-harness-runtime` 的目标就是把这些通用执行逻辑收敛成一套 Runtime Core，只把宿主差异放在 Adapter 中。

---

# 2. 总体仓库关系

推荐只保留两个长期主仓库：

```text
Dev-Wiki/
├── dev-harness
└── dev-harness-runtime
```

职责关系：

```text
                       dev-harness
              ┌─────────────────────────┐
              │ Protocol / Skills       │
              │ Project Contract        │
              │ Planning Contract       │
              │ Verification Contract   │
              │ Git / Docs / Audit      │
              └────────────┬────────────┘
                           │
                           │ contract
                           ▼
                 dev-harness-runtime
        ┌─────────────────────────────────────┐
        │ Runtime Core                        │
        │                                     │
        │ Discovery / Planning Reader         │
        │ Task Selector                       │
        │ Snapshot / Drift Gate               │
        │ Authorization                       │
        │ State / Lock / Recovery             │
        │ Orchestrator                        │
        │ Result Validation                   │
        │ Build / Pack / Release              │
        └─────────────────┬───────────────────┘
                          │
          ┌───────────────┼───────────────────────┐
          │               │                       │
          ▼               ▼                       ▼
     Codex Adapter     DSH Adapter          Other Adapters
          │               │                Cursor/OpenCode/
          ▼               ▼                 Antigravity/...
        Codex             DSH
```

一句话边界：

| 层 | 职责 |
|---|---|
| `dev-harness` | 定义“任务应该怎样被规划、执行、验证和收口” |
| `runtime/core` | 统一控制一次任务运行的生命周期 |
| `adapter/*` | 把统一 Task Execution Contract 映射到具体宿主 |
| `packager/*` | 把共享能力转换成具体平台可安装的插件产物 |

---

# 3. 设计目标

## 3.1 必须达成

1. **通用流程只维护一份。**
2. 每个平台 Adapter 足够薄。
3. Platform Plugin 可以独立打包和安装。
4. 同一 Task Contract 能由不同 Executor 执行。
5. 默认支持“一 Task 一 Session”的隔离执行模式。
6. Conversation 不作为持久状态。
7. Run 可恢复。
8. Planning / Git / Worktree 漂移时 fail closed。
9. 外部动作具有统一授权模型。
10. 打包产物全部由源码生成，不手工维护重复 Skill。
11. 平台 Plugin API 变化不能污染 Runtime Core。
12. 可以逐步增加新平台，而不复制 Orchestrator。

---

## 3.2 非目标

MVP 不负责：

- 取代 `dev-harness` 的 Skills；
- 重新定义 Planning 状态机；
- 复制一份 Git Workflow；
- 复制一份 Docs Workflow；
- 自动 push；
- 自动创建 PR；
- 自动 tag；
- 自动 release；
- 自动 deploy；
- 多平台同时执行一个 Task；
- 默认并行执行多个 Task；
- 用聊天摘要代替 Project State；
- 为不具备可靠独立 Session API 的宿主伪造“一 Task 一 Session”。

---

# 4. 核心原则

## 4.1 Task Boundary = Context Boundary

默认执行策略：

```text
Planning Task
    =
Execution Unit
    =
Verification Unit
    =
Optional Commit Unit
    =
Agent Session Unit
```

例如：

```text
K1 -> Session A -> complete -> exit
K2 -> Session B -> complete -> exit
K3 -> Session C -> complete -> exit
```

K2 不需要 K1 的 Conversation。

K2 通过以下状态继续：

- 当前源码；
- Git history；
- Dashboard；
- 当前 Task Packet；
- AGENTS.md；
- HARNESS.md；
- 已验证文档；
- Runtime Private State。

---

## 4.2 不传 Conversation，传 Project State

跨任务连续性：

```text
Task K1
  │
  ├─ code changes
  ├─ verification evidence
  ├─ Dashboard transition
  ├─ archived Task
  └─ optional commit
       │
       ▼
Task K2 Fresh Session
```

禁止设计：

```text
K1 Conversation
      ↓
大段 summary
      ↓
K2 Conversation
```

---

## 4.3 Core 不感知具体模型

Core 不关心执行者是：

- GPT
- DeepSeek
- Gemini
- Claude
- 其他模型

Core 只认：

```text
TaskExecutionRequest
        ↓
TaskExecutor
        ↓
TaskExecutionResult
```

---

# 5. 推荐 Monorepo 结构

```text
dev-harness-runtime/
│
├── packages/
│   │
│   ├── core/
│   │   ├── src/
│   │   │   ├── discovery/
│   │   │   ├── planning/
│   │   │   ├── snapshot/
│   │   │   ├── authorization/
│   │   │   ├── state/
│   │   │   ├── lock/
│   │   │   ├── recovery/
│   │   │   ├── result/
│   │   │   └── orchestrator/
│   │   └── tests/
│   │
│   ├── contracts/
│   │   ├── schemas/
│   │   ├── fixtures/
│   │   └── src/
│   │
│   ├── cli/
│   │   └── src/
│   │
│   ├── adapter-codex/
│   │   ├── src/
│   │   ├── plugin/
│   │   └── tests/
│   │
│   ├── adapter-dsh/
│   │   ├── src/
│   │   ├── plugin/
│   │   └── tests/
│   │
│   ├── adapter-cursor/
│   │   ├── src/
│   │   ├── plugin/
│   │   └── tests/
│   │
│   ├── adapter-opencode/
│   │   ├── src/
│   │   ├── plugin/
│   │   └── tests/
│   │
│   └── adapter-antigravity/
│       ├── src/
│       ├── plugin/
│       └── tests/
│
├── skills/
│   ├── run/
│   ├── status/
│   └── worker/
│
├── build/
│   ├── targets/
│   ├── transforms/
│   ├── validators/
│   └── manifests/
│
├── tests/
│   ├── integration/
│   ├── packaging/
│   └── fixtures/
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CONTRACTS.md
│   ├── PACKAGING.md
│   ├── PLATFORM_MATRIX.md
│   ├── RECOVERY.md
│   └── RELEASE.md
│
├── dist/
│   └── .gitkeep
│
├── AGENTS.md
├── ARCHITECTURE.md
├── HARNESS.md
├── README.md
├── CHANGELOG.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── LICENSE
```

建议 Runtime 统一使用 TypeScript / Node.js。

理由：

- DSH 当前已经是 TypeScript；
- Cursor / OpenCode 等插件生态天然偏 JS/TS；
- 跨平台 child process、JSON、filesystem、lock、hash 足够成熟；
- 一个 Runtime 可以直接被多个 Adapter 引用；
- Codex Plugin 中可以打包编译后的独立 JS Runtime；
- 避免 Core 同时维护 Python 与 TypeScript 两份实现。

如果后续确实需要 Python 辅助脚本，可以作为 Skill Script 存在，但不要让 Runtime Core 双语言实现。

---

# 6. Source of Truth 与生成目录

必须严格区分：

```text
Source
  ↓
Generator
  ↓
Platform Artifacts
```

只有以下内容允许手工维护：

```text
packages/
skills/
build/
docs/
```

以下内容全部由构建生成：

```text
.generated/
dist/
```

禁止直接修改：

```text
dist/codex/...
dist/cursor/...
dist/opencode/...
```

CI 必须能够：

```text
clean
→ generate
→ validate
→ pack
→ compare
```

发现生成漂移时失败。

---

# 7. Runtime Core

## 7.1 Discovery

负责：

- repository root；
- `.git` / worktree；
- `doc/` / `docs/`；
- Plan Root；
- Dashboard；
- Task 文件；
- AGENTS.md；
- HARNESS.md；
- Project Contract 可用性。

Docs Root 规则应与 `dev-harness` 保持一致：

1. 用户显式指定优先；
2. 优先选择已有 active plan 的文档根；
3. 只有 `doc/` 时使用 `doc/`；
4. 只有 `docs/` 时使用 `docs/`；
5. 两者都存在且 ownership 不明确时 fail closed；
6. Runtime 不自行创建第二套文档树。

---

## 7.2 Planning Reader

Runtime 不重新实现 Planning。

它只读取 `dev-harness` 已定义的权威状态：

```text
<docs-root>/plan/Dashboard.md
<docs-root>/plan/tasks/<Task-ID>.md
<docs-root>/plan/archive/
```

Dashboard 是唯一 active planning authority。

Runtime 读取：

- work order；
- Task ID；
- 状态；
- dependency；
- blocker；
- Task path。

Runtime 不重新计算 priority-based order。

---

## 7.3 Task Selector

支持：

```text
explicit task
next ready task
all ready sequential
```

默认自动选择必须满足：

```text
在当前工作顺序中
AND 状态 = 🟢 待执行
AND Task 文件存在
AND dependency 已满足
AND blocker 已解除
```

存在歧义：

```text
FAIL CLOSED
```

---

# 8. Planning Snapshot / Drift Gate

Task 启动前记录：

```text
repoRoot
branch
HEAD
dashboardPath
dashboardHash
taskId
taskPath
taskHash
preExistingDirtyPaths
indexState
untrackedPaths
```

对每个 dirty path 记录：

```text
path
fileType
worktreeHash
indexBlob
indexMode
deleted
symlinkTarget
```

禁止仅依赖：

```bash
git status --short
```

因为它不是内容指纹。

执行后重新验证：

```text
Expected task-owned change
         ↓
       allow

External / undeclared drift
         ↓
    fail closed
```

---

# 9. Authorization

统一 Authorization Contract。

示例：

```ts
interface RunAuthorization {
  commit: "deny" | "task";
  push: false;
  pullRequest: false;
  tag: false;
  release: false;
  deploy: false;
}
```

MVP 中：

```text
push
pullRequest
tag
release
deploy
```

全部必须是 `false`。

支持执行模式：

```text
commit-each
no-commit
```

不要在不同 Adapter 中定义不同授权语义。

---

# 10. Runtime State

运行状态不得进入项目正文。

默认保存在 Git Private State，状态根目录统一为 `$(git rev-parse --git-path dev-harness-runtime)/runs/`：

```text
$(git rev-parse --git-path dev-harness-runtime)/runs/
└── <run-id>/
    ├── run.json
    ├── attempts/
    │   └── <task-id>-<attempt>/
    │       ├── stdout.log
    │       ├── stderr.log
    │       └── events.jsonl
    ├── results/
    │   └── <task-id>-<attempt>.json
    └── summary.json
```

每个 Run 的 `<run-id>/run.json` 是该 Run 唯一权威状态文件。`attempts/` 保存执行日志，`results/` 保存执行结果，`summary.json` 是派生摘要；这些文件都不构成第二份 Run 状态。

Run State：

```ts
interface RunState {
  schemaVersion: number;
  revision: number;

  runId: string;
  adapter: string;

  status:
    | "CREATED"
    | "RUNNING"
    | "INTERRUPTED"
    | "BLOCKED"
    | "FAILED"
    | "COMPLETED";

  phase:
    | "DISCOVERY"
    | "SELECT"
    | "SNAPSHOT"
    | "EXECUTE"
    | "REVALIDATE"
    | "FINALIZE";

  currentTaskId?: string;
  currentAttempt?: number;

  completedTasks: string[];

  authorization: RunAuthorization;

  createdAt: string;
  updatedAt: string;
}
```

要求：

- atomic write；
- schema version；
- revision CAS；
- crash safe；
- 不进入 worktree；
- 不提交 Git。

---

# 11. Lock

一个 worktree 默认只允许一个 active orchestrator。

Lock 包含：

```text
runId
pid
adapter
repoRoot
createdAt
```

要求跨 Windows / Linux / WSL 工作。

不要将 Unix-only `fcntl` 作为唯一实现。

推荐：

```text
exclusive create + owner metadata + stale lock recovery
```

---

# 12. Recovery

恢复的是：

```text
Run
```

不是：

```text
Conversation
```

流程：

```text
load run state
    ↓
validate repository
    ↓
validate HEAD / Dashboard / Task / dirty paths
    ↓
no external drift
    ↓
start fresh executor session
```

即：

```text
Resume Run != Resume Agent Conversation
```

这是所有 Adapter 的统一规则。

---

# 13. Executor Contract

核心接口：

```ts
export interface TaskExecutor {
  id: string;

  probe(
    environment: HostEnvironment
  ): Promise<ExecutorCapabilities>;

  execute(
    request: TaskExecutionRequest,
    signal: AbortSignal
  ): Promise<TaskExecutionResult>;
}
```

输入：

```ts
export interface TaskExecutionRequest {
  runId: string;
  attempt: number;

  repoRoot: string;

  docsRoot: string;
  dashboardPath: string;

  taskId: string;
  taskPath: string;

  authorization: RunAuthorization;

  env: Record<string, string>;
}
```

输出：

```ts
export interface TaskExecutionResult {
  schemaVersion: 1;

  taskId: string;

  outcome:
    | "completed"
    | "blocked"
    | "failed"
    | "partial";

  summary: string;

  verification: VerificationEvidence[];

  changedFiles: string[];

  commitSha?: string;

  needsPlanning: boolean;

  reason?: string;

  rawResultRef?: string;
}
```

Core 不知道 Adapter 如何执行。

---

# 14. Executor Capability Probe

不要通过版本号猜宿主能力。

每个 Adapter 必须实现：

```text
probe()
```

返回：

```ts
interface ExecutorCapabilities {
  available: boolean;

  freshSession: boolean;
  structuredOutput: boolean;
  nonInteractive: boolean;

  cancellation: boolean;
  resumeRunWithFreshSession: boolean;

  pluginPackaging: boolean;

  reasons: string[];
}
```

例如：

```text
pluginPackaging=true
freshSession=false
```

表示：

> 这个平台可以安装插件和使用 Skill，但目前没有经过验证的独立任务 Session API。

这种情况下：

- Plugin 仍然可以打包；
- `run --all-ready` 不启用自动 Session Orchestration；
- 用户仍然可以人工使用 Skill；
- 不通过猜测模拟。

---

# 15. 通用 Orchestrator

完整流程只有一套：

```text
PRECHECK
   ↓
DISCOVERY
   ↓
SELECT TASK
   ↓
SNAPSHOT
   ↓
EXECUTOR.execute()
   ↓
RESULT VALIDATION
   ↓
PROJECT REVALIDATION
   ↓
PERSIST STATE
   ↓
RELOAD DASHBOARD
   ↓
NEXT TASK / COMPLETE
```

伪代码：

```ts
while (true) {
  const plan = await planning.reload();

  const task = selector.select(plan, mode);

  if (!task) {
    return completeRun();
  }

  const snapshot = await snapshots.capture(task);

  const result = await executor.execute(
    buildExecutionRequest(task),
    signal
  );

  validateResult(result);

  await snapshots.revalidate(snapshot, result);

  await persistResult(result);

  if (result.outcome !== "completed") {
    return stopRun(result);
  }
}
```

任何 Adapter 都不维护第二套 Orchestrator。

---

# 16. Worker Prompt Contract

需要 Agent Worker 的平台共用同一模板语义：

```text
你是 dev-harness 的单任务 Worker。

只执行 Task <Task-ID>。

读取：
- AGENTS.md
- HARNESS.md
- Dashboard.md
- 当前 Task Packet
- Task Packet 指向的必要代码与文档

要求：
1. 只执行当前 Task。
2. 不自动领取其他 Task。
3. 不重新规划整个 backlog。
4. 不递归启动 dev-harness orchestrator。
5. scope expansion 时停止。
6. planning drift 时停止。
7. 按 acceptance / verification 完成任务。
8. commit 仅在本次 Run 明确授权时允许。
9. 禁止 push / PR / tag / release / deploy。
10. 返回符合 TaskExecutionResult Contract 的结果。
```

各 Adapter 只负责转换成平台可消费格式。

---

# 17. 递归保护

所有 Worker 统一设置：

```text
DEV_HARNESS_WORKER=1
DEV_HARNESS_RUN_ID=<run-id>
DEV_HARNESS_TASK_ID=<task-id>
DEV_HARNESS_ADAPTER=<adapter>
```

Orchestrator 发现：

```text
DEV_HARNESS_WORKER=1
```

时拒绝：

```text
run --next
run --all-ready
resume
```

防止：

```text
Orchestrator
   → Worker
      → Orchestrator
         → Worker
```

---

# 18. Packager Contract

平台打包同样抽象。

```ts
export interface PluginPackager {
  id: string;

  generate(
    input: PluginBuildInput
  ): Promise<GeneratedPlugin>;

  validate(
    plugin: GeneratedPlugin
  ): Promise<ValidationReport>;

  pack(
    plugin: GeneratedPlugin
  ): Promise<Artifact[]>;
}
```

其中：

```ts
interface PluginBuildInput {
  version: string;
  coreVersion: string;

  skills: SkillSource[];

  runtimeBundle: string;

  adapterBundle: string;

  metadata: PluginMetadata;
}
```

构建流程：

```text
Shared Skills
Shared Runtime
Adapter
Metadata
   │
   ▼
Platform Generator
   │
   ▼
Generated Plugin Tree
   │
   ▼
Platform Validator
   │
   ▼
Artifact
```

---

# 19. Platform Adapter 与打包输出

平台能力分成两部分：

1. **Plugin Packaging**
2. **Execution Adapter**

不要把两者绑定。

---

## 19.1 Codex

### 插件格式

当前 Codex 官方 Plugin 使用：

```text
.codex-plugin/plugin.json
skills/
```

Marketplace 使用：

```text
.agents/plugins/marketplace.json
```

建议生成：

```text
dist/codex/
├── marketplace/
│   ├── .agents/
│   │   └── plugins/
│   │       └── marketplace.json
│   │
│   └── plugins/
│       └── dev-harness/
│           ├── .codex-plugin/
│           │   └── plugin.json
│           ├── skills/
│           ├── scripts/
│           ├── runtime/
│           └── README.md
│
└── dev-harness-codex-vX.Y.Z.zip
```

### Executor

Codex Adapter 可使用经过 capability probe 验证的非交互执行入口启动：

```text
Fresh Codex Session
```

默认语义：

```text
Task K1 -> fresh session
exit
Task K2 -> fresh session
```

禁止通过 `/new` 作为 Runtime API。

### Codex Adapter 只负责

```text
TaskExecutionRequest
      ↓
Codex Worker Prompt
      ↓
Codex process
      ↓
Structured Result
      ↓
TaskExecutionResult
```

---

## 19.2 DSH

本次迁移与适配的目标宿主固定为 **DSH `0.1.5-rc.1`**。依据是用户于 2026-09-17 提供的本机 `dsh --version` 输出；该信息确认目标版本，不代表新 Adapter 已通过兼容性验收。

旧 `dev-harness-dsh` 的 `0.1.0-rc.8` 集成基线仅作历史行为参考。需要针对 `0.1.5-rc.1` 重新核对公开 API、Bundle 格式与实际解析的组件依赖，并重跑契约、安装和 Session 测试；不得直接沿用旧版本的兼容结论，也不得假定所有 `@deepseek-ai/*` 包与宿主版本相同。

现有 `dev-harness-dsh` 中已经存在大量：

- State
- Authorization
- Orchestrator
- Recovery
- Verification
- Reconciliation

新架构中应逐步把真正平台无关部分迁移到 Core。

DSH Adapter 只保留：

- Cordis Integration；
- DSH Command；
- DSH Agent / Session；
- DSH Workflow API；
- DSH 特定 lifecycle；
- DSH package manifest；
- DSH rc compatibility。

建议输出：

```text
dist/dsh/
├── package/
│   ├── lib/
│   ├── cordis.patch.yml
│   ├── package.json
│   └── README.md
│
└── dev-harness-dsh-vX.Y.Z.tgz
```

MVP 迁移期间允许旧 `dev-harness-dsh` 仓库继续存在。

在新实现达到测试等价后：

```text
dev-harness-dsh
    ↓
deprecated / archived / redirect
```

不要直接删除旧仓库。

---

## 19.3 Cursor

Cursor 当前支持两类插件：

```text
Agent Plugins
Cursor Plugins
```

其中：

- Agent Plugins：根目录 `plugin.json`
- Cursor Native Plugin：`.cursor-plugin/plugin.json`

为了使用 Cursor 独有能力，默认生成 Native Plugin。

输出：

```text
dist/cursor/
├── plugin/
│   ├── .cursor-plugin/
│   │   └── plugin.json
│   ├── skills/
│   ├── commands/
│   ├── rules/
│   └── README.md
│
└── dev-harness-cursor-vX.Y.Z.zip
```

同时可以生成一个 Portable Agent Plugin 子集：

```text
dist/agent-plugin/
```

仅包含可跨平台的：

```text
plugin.json
skills/
mcp.json (如未来需要)
```

### Cursor Executor

第一阶段不要假设 Cursor 自动 Session API。

必须先通过官方接口和 capability probe 验证：

```text
freshSession
nonInteractive
structuredOutput
```

在未验证之前：

```text
pluginPackaging = true
freshSession = false
```

即：

- Cursor Plugin 可安装；
- Skill 可工作；
- Runtime 自动多 Session 编排暂不开放。

---

## 19.4 OpenCode

OpenCode 当前支持：

```text
.opencode/plugins/
```

中的本地 JS/TS Plugin，也支持通过配置加载 npm Plugin。

建议生成两种产物。

### NPM Plugin

```text
dist/opencode/npm/
└── dev-harness-opencode-vX.Y.Z.tgz
```

包中：

```text
package.json
dist/
README.md
```

### Local Plugin

```text
dist/opencode/local/
└── .opencode/
    ├── plugins/
    │   └── dev-harness.js
    └── skills/
        └── ...
```

### OpenCode Executor

同样必须能力探测。

若官方 CLI / Plugin Runtime 已确认支持：

```text
fresh isolated run
structured output
cancellation
```

再启用：

```text
run --adapter opencode
```

否则只发布 Plugin / Skill。

---

## 19.5 Antigravity

Antigravity 已支持 Agent Plugin / Agent Skills 体系。

Portable Plugin 建议生成：

```text
dist/antigravity/
├── plugin/
│   ├── plugin.json
│   ├── skills/
│   └── README.md
│
└── dev-harness-antigravity-vX.Y.Z.zip
```

项目级 Skill 兼容输出：

```text
dist/antigravity/project-skills/
└── .agents/
    └── skills/
```

如果需要 Global Skill：

```text
dist/antigravity/global-skills/
└── skills/
```

具体安装路径应由安装器适配，而不是把绝对用户目录写入 artifact。

### Antigravity Executor

与 Cursor 相同：

- 插件打包先支持；
- 自动 Session Orchestration 只有 capability probe 验证通过后才启用。

---

# 20. Portable Agent Plugin

由于多个平台开始支持 Agent Plugin / Agent Skills 标准，建议额外生成一个平台中立产物：

```text
dist/agent-plugin/
└── dev-harness/
    ├── plugin.json
    ├── skills/
    └── README.md
```

定位：

> 最大化 Skills portability，不承诺平台专属 Runtime 编排能力。

包含：

```text
run skill
status skill
worker skill
```

其中涉及自动 Session 的命令必须先检测 Runtime Adapter。

---

# 21. 平台能力矩阵

设计文档中的能力矩阵不要写死成产品宣传，应由 Adapter 测试结果生成。

建议 schema：

| Platform | Plugin Package | Skills | Commands | Fresh Session Executor | Structured Result | Auto Orchestration |
|---|---:|---:|---:|---:|---:|---:|
| Codex | ✅ | ✅ | Adapter-defined | ✅ | ✅ | ✅ |
| DSH | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cursor | ✅ | ✅ | ✅ | Probe | Probe | Probe |
| OpenCode | ✅ | ✅ | Plugin API | Probe | Probe | Probe |
| Antigravity | ✅ | ✅ | Platform-defined | Probe | Probe | Probe |
| Agent Plugin | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

其中 `Probe` 必须由 CI / integration test 更新。

---

# 22. CLI

项目名为 `dev-harness-runtime`，CLI 统一使用其缩写：

```text
dhr
```

建议提供：

```bash
dhr doctor

dhr status

dhr run --adapter codex --task K1
dhr run --adapter codex --next
dhr run --adapter codex --all-ready

dhr resume <run-id>

dhr build
dhr build --platform codex
dhr build --platform dsh
dhr build --platform cursor
dhr build --platform opencode
dhr build --platform antigravity

dhr validate
dhr validate --platform codex

dhr pack
dhr pack --platform codex

dhr release --dry-run
```

`run` 与 `build/pack` 使用同一 Adapter Registry。

---

# 23. Adapter Registry

```ts
interface PlatformAdapter {
  id: string;

  executor?: TaskExecutor;

  packager: PluginPackager;

  doctor(): Promise<AdapterDoctorResult>;
}
```

Registry：

```ts
const adapters = {
  codex,
  dsh,
  cursor,
  opencode,
  antigravity
};
```

增加平台时：

```text
实现 Adapter
→ 注册 Adapter
→ 添加 contract tests
→ 添加 packager fixture
```

不得修改 Core Orchestrator。

---

# 24. Build Pipeline

统一构建：

```text
Source
  │
  ├─ Shared Skills
  ├─ Core Runtime
  ├─ Platform Adapter
  └─ Metadata
       │
       ▼
    Compiler
       │
       ▼
 Platform Generator
       │
       ▼
 Platform Validator
       │
       ▼
 Artifact
```

例如：

```bash
pnpm build
```

生成：

```text
.generated/
├── codex/
├── dsh/
├── cursor/
├── opencode/
└── antigravity/
```

然后：

```bash
pnpm pack
```

输出：

```text
dist/
├── codex/
├── dsh/
├── cursor/
├── opencode/
├── antigravity/
└── agent-plugin/
```

---

# 25. 发布产物

推荐：

```text
dist/
├── manifest.json
│
├── codex/
│   └── dev-harness-codex-vX.Y.Z.zip
│
├── dsh/
│   └── dev-harness-dsh-vX.Y.Z.tgz
│
├── cursor/
│   └── dev-harness-cursor-vX.Y.Z.zip
│
├── opencode/
│   ├── dev-harness-opencode-vX.Y.Z.tgz
│   └── dev-harness-opencode-local-vX.Y.Z.zip
│
├── antigravity/
│   └── dev-harness-antigravity-vX.Y.Z.zip
│
└── agent-plugin/
    └── dev-harness-agent-plugin-vX.Y.Z.zip
```

`manifest.json`：

```json
{
  "releaseVersion": "0.1.0",
  "coreProtocolVersion": 1,
  "artifacts": [
    {
      "platform": "codex",
      "version": "0.1.0",
      "file": "codex/dev-harness-codex-v0.1.0.zip",
      "sha256": "..."
    }
  ]
}
```

---

# 26. 版本策略

Monorepo 不等于所有平台必须永远同版本。

推荐两个版本层：

## Core Protocol Version

例如：

```text
coreProtocolVersion = 1
```

只在以下 Contract 不兼容变化时升级：

- TaskExecutionRequest
- TaskExecutionResult
- Run State
- Authorization
- Snapshot
- Adapter Contract

---

## Adapter SemVer

平台 Adapter 可以独立版本：

```text
core              protocol 1
codex             0.3.1
dsh               0.2.4
cursor            0.1.2
opencode          0.1.0
antigravity       0.1.0
```

Release Manifest 记录兼容性。

这样：

```text
Codex Plugin API changed
```

只需要升级 Codex Adapter，不需要人为修改 DSH 逻辑。

---

# 27. Shared Skills 生成策略

不要每个平台维护：

```text
codex/skills/run/SKILL.md
cursor/skills/run/SKILL.md
antigravity/skills/run/SKILL.md
```

唯一源码：

```text
skills/run/SKILL.md
skills/status/SKILL.md
skills/worker/SKILL.md
```

如果平台需要差异：

```text
skills/run/SKILL.md
        +
build/transforms/codex.ts
```

只允许 Adapter 做有限转换，例如：

- 路径变量；
- 平台命令名；
- invocation syntax；
- manifest metadata。

禁止在转换阶段重写业务流程。

---

# 28. Platform Manifest 生成

Manifest 也不建议手工维护多份。

统一元数据：

```yaml
name: dev-harness
displayName: Dev Harness
description: Cross-session engineering workflow runtime for dev-harness
author: Dev-Wiki
repository: https://github.com/Dev-Wiki/dev-harness-runtime
```

然后生成：

```text
.codex-plugin/plugin.json
.cursor-plugin/plugin.json
plugin.json
package.json
cordis.patch.yml references
```

平台必需字段由 Packager 注入。

---

# 29. Validation

每个平台必须有两级验证：

## Static Validation

验证：

- Manifest；
- required file；
- relative path；
- Skill Frontmatter；
- duplicate Skill；
- unsupported field；
- package contents；
- version；
- no TODO placeholder；
- no absolute local path。

---

## Runtime Validation

如果宿主可用：

```text
install
→ discover plugin
→ discover skills
→ invoke smoke task
→ uninstall
```

CI 没有宿主时至少执行 fixture validator。

---

# 30. Contract Tests

每个 Executor 必须通过完全相同的 Adapter Contract Test。

例如：

```text
execute success
execute blocked
execute failed
execute partial
cancel
invalid result
missing structured result
working tree drift
authorization violation
```

测试接口：

```ts
runExecutorContractTests(createExecutorFixture);
```

这样可以防止：

```text
Codex 对 blocked 的解释
!=
DSH 对 blocked 的解释
```

---

# 31. Packaging Golden Tests

每个平台维护 Golden Tree：

```text
tests/fixtures/expected/
├── codex/
├── dsh/
├── cursor/
├── opencode/
└── antigravity/
```

构建后比较：

```text
file tree
manifest fields
skill count
hash-sensitive generated content
```

源文件变化造成产物变化时必须显式更新 fixture。

---

# 32. E2E 测试

最重要的公共 E2E：

```text
Dashboard

K1 🟢
K2 🟢 depends K1
K3 🟢 depends K2
```

使用 Fake Executor：

```text
K1 → completed
K2 → completed
K3 → completed
```

验证：

```text
3 executor invocations
3 snapshots
3 result validations
Dashboard reloaded 3 times
run state persisted
```

再替换成平台 Executor 做 smoke test。

---

# 33. Session Isolation 测试

支持 Fresh Session 的 Adapter 必须证明：

```text
session(K1) != session(K2)
```

不能只因为调用了两次 API 就声称独立 Session。

测试应获取宿主可验证的：

```text
session id
thread id
run id
process identity
```

至少一种。

没有证据则 capability：

```text
freshSession = false
```

---

# 34. Parent Context 控制

如果 Runtime 是由 Agent Skill 触发：

父 Agent 只获得：

```text
runId
taskId
status
summary
verification summary
commitSha
nextTask
logRef
```

禁止把：

```text
full transcript
full build log
full diff
source file contents
JSONL event stream
```

回灌父上下文。

完整日志写 Private State。

---

# 35. 日志

日志与结果保存在第 10 节定义的同一状态根目录中，不另设状态树：

```text
$(git rev-parse --git-path dev-harness-runtime)/runs/<run-id>/
├── run.json
├── attempts/
│   ├── K1-1/
│   │   ├── stdout.log
│   │   ├── stderr.log
│   │   └── events.jsonl
│   └── K2-1/
├── results/
│   ├── K1-1.json
│   └── K2-1.json
└── summary.json
```

`run.json` 是该 Run 唯一权威状态文件；结果、日志与摘要的职责和目录布局均遵循第 10 节。

终端默认只显示：

```text
[K1] selected
[K1] worker started
[K1] completed
[K1] verification accepted
[next] K2
```

提供：

```bash
dhr status --verbose
```

查看日志引用，而不是默认展开。

---

# 36. Fail-fast

Sequential Run 默认：

```text
completed -> next
blocked   -> stop
failed    -> stop
partial   -> stop
```

MVP 不做：

```text
skip blocked
continue independent
parallel DAG
```

避免 Runtime 自己建立第二套 Planning Scheduler。

---

# 37. Commit Policy

支持：

```text
--commit-each
--no-commit
```

`commit-each`：

```text
Task
→ verify
→ task closure
→ Git Workflow
→ commit
→ next
```

Runtime 自身不要绕过 `dev-harness-git-workflow` 另写 Commit Policy。

永不隐式执行：

```text
push
PR
tag
release
deploy
```

---

# 38. `dev-harness-dsh` 迁移方案

不要直接推翻现有项目。

分阶段：

## Phase A

`dev-harness-runtime` 建立 Core。

用当前 DSH 实现作为行为参考。

---

## Phase B

识别 `dev-harness-dsh` 中真正通用模块：

- authorization
- state
- lock
- snapshot
- recovery
- orchestrator
- generic verification result
- final result contract

迁入 / 重构进 Core。

注意：

> 迁移行为，不复制两份源码。

---

## Phase C

实现新的 `adapter-dsh`。

只保留：

- Cordis；
- DSH Commands；
- DSH Session；
- DSH Workflow；
- DSH-specific API；
- package manifest。

---

## Phase D

跑旧项目与新 Adapter 的行为等价测试。

达到 parity 后：

```text
dev-harness-dsh
```

进入：

```text
maintenance / deprecated
```

README 指向：

```text
Dev-Wiki/dev-harness-runtime
```

Git 历史保留。

---

# 39. CI

建议矩阵：

```text
Core
├── typecheck
├── lint
├── unit
├── contract
└── fixture

Packaging
├── codex
├── dsh
├── cursor
├── opencode
├── antigravity
└── agent-plugin

Integration
├── core-e2e
├── codex-smoke
└── dsh-smoke
```

Cursor / OpenCode / Antigravity 在宿主自动化测试条件不足时：

```text
static package validation
```

仍为必需。

---

# 40. Release Pipeline

```text
pnpm verify
    ↓
pnpm build
    ↓
pnpm generate
    ↓
pnpm validate:plugins
    ↓
pnpm pack
    ↓
sha256
    ↓
dist/manifest.json
```

Release Script 默认：

```text
只生成本地 artifact
```

不能自动：

```text
npm publish
Git push
Git tag
GitHub Release
Marketplace submit
```

以上动作分别授权。

---

# 41. 平台安装策略

## Codex

优先 Marketplace repository 安装。

仓库应能作为 Codex Marketplace Source 使用。

---

## DSH

输出 `.tgz`，沿用 DSH Package / Bundle 安装模型。

---

## Cursor

输出 Native Cursor Plugin 目录 / ZIP。

如需要 Marketplace 发布，单独作为发布动作。

---

## OpenCode

同时输出：

```text
npm .tgz
local plugin zip
```

---

## Antigravity

输出 Agent Plugin bundle / Skills bundle。

---

## Generic

输出 Portable Agent Plugin。

---

# 42. 安装器

后续可以提供统一安装器：

```bash
dhr install codex
dhr install cursor
dhr install opencode
dhr install antigravity
```

但 MVP 不要让安装器绕过平台原生机制。

优先：

```text
生成 artifact
→ 调用/提示平台原生 install
```

而不是直接往用户目录乱复制。

---

# 43. 平台专属代码的限制

一个 Adapter 如果开始出现：

```text
task selection
planning state
snapshot implementation
authorization semantics
recovery algorithm
```

说明边界错了。

这些必须回到 Core。

Adapter 只允许拥有：

```text
Host Detection
Host Capability Probe
Host Invocation
Prompt / Request Translation
Host Event Translation
Result Translation
Platform Manifest
Platform Packaging
Host-specific Tests
```

---

# 44. 新增平台流程

未来增加：

```text
Claude Code
Gemini CLI
Copilot CLI
Pi
...
```

标准步骤：

1. 创建 `adapter-<platform>`；
2. 实现 `PluginPackager`；
3. 实现 `doctor/probe`；
4. 如果平台有可靠执行 API，再实现 `TaskExecutor`；
5. 跑 Executor Contract Test；
6. 添加 Packaging Golden Test；
7. 注册到 Adapter Registry；
8. 添加 Build Target；
9. 不修改 Orchestrator。

---

# 45. MVP 阶段规划

## V0 — Monorepo Scaffold

完成：

- workspace；
- Core package；
- Contracts；
- Adapter Registry；
- Build Registry；
- CLI scaffold；
- CI。

---

## K1 — Core Contracts

完成：

- TaskExecutionRequest；
- TaskExecutionResult；
- Authorization；
- RunState；
- Snapshot；
- Executor；
- Packager。

---

## K2 — Discovery / Planning Reader

完成：

- repo；
- docs root；
- Dashboard；
- Task；
- selector。

---

## K3 — State / Snapshot / Recovery

完成：

- private state；
- lock；
- atomic write；
- revision；
- drift gate；
- resume。

---

## K4 — Orchestrator

完成：

```text
run --task
run --next
run --all-ready
status
resume
```

使用 Fake Executor 完成完整 E2E。

---

## K5 — Codex Adapter

完成：

- plugin packager；
- marketplace output；
- capability probe；
- fresh-session executor；
- structured result；
- isolated session test。

---

## K6 — DSH Adapter Migration

完成：

- DSH plugin packager；
- DSH executor；
- 当前 dev-harness-dsh 通用流程迁入 Core；
- parity tests。

---

## K7 — Cursor Packager

完成：

- Cursor Native Plugin；
- shared skills；
- commands；
- static validation。

Executor 是否启用由 capability probe 结果决定。

---

## K8 — OpenCode Packager

完成：

- NPM plugin；
- local plugin；
- skills；
- validator。

Executor 独立评估。

---

## K9 — Antigravity Packager

完成：

- Agent Plugin；
- Skill bundle；
- validator。

Executor 独立评估。

---

## K10 — Unified Release

完成：

```text
pnpm verify
pnpm build
pnpm pack
dist/manifest.json
hash
release dry-run
```

---

# 46. MVP 最终验收

给定同一份：

```text
Dashboard
├── K1 🟢
├── K2 🟢 depends K1
└── K3 🟢 depends K2
```

使用 Codex：

```bash
dhr run --adapter codex --all-ready --commit-each
```

应表现为：

```text
Core Orchestrator
   │
   ├─ K1 → Codex Session A
   ├─ K2 → Codex Session B
   └─ K3 → Codex Session C
```

切换 DSH：

```bash
dhr run --adapter dsh --all-ready --commit-each
```

核心生命周期不发生变化：

```text
Core Orchestrator
   │
   ├─ K1 → DSH Session A
   ├─ K2 → DSH Session B
   └─ K3 → DSH Session C
```

差异只存在 Executor 内部。

---

# 47. 核心成功标准

项目达到以下状态时，架构目标成立：

1. Codex 与 DSH 共用同一 Orchestrator。
2. Codex 与 DSH 共用同一 Run State。
3. Codex 与 DSH 共用同一 Authorization Contract。
4. Codex 与 DSH 共用同一 Snapshot / Drift Gate。
5. Codex 与 DSH 共用同一 Recovery。
6. Platform Adapter 不再维护自己的 Planning Flow。
7. Shared Skill 只有一份源码。
8. 五个平台的安装产物由统一构建生成。
9. 新增平台无需复制 Core。
10. 平台 API 变化只影响对应 Adapter。

---

# 48. 推荐 README 定位

英文：

> **dev-harness-runtime is the shared runtime and multi-platform plugin distribution layer for dev-harness. It keeps orchestration, recovery, authorization, task selection, and execution contracts in one core, while thin platform adapters integrate Codex, DSH, Cursor, OpenCode, Antigravity, and future coding agents.**

中文：

> **dev-harness-runtime 是 dev-harness 的统一执行 Runtime 与多平台插件分发层。任务选择、状态、授权、恢复和编排只维护一套 Core；Codex、DSH、Cursor、OpenCode、Antigravity 等宿主只实现薄 Adapter 与各自的插件打包格式。**

---

# 49. 外部平台格式依据

设计实现时应以平台当前官方规范为准，禁止把本设计文档中的格式视为永久 API。

当前设计参考：

- Codex Plugin examples / marketplace：
  - https://github.com/openai/plugins
  - https://github.com/openai/codex
- Cursor Plugins：
  - https://cursor.com/docs/plugins
  - https://cursor.com/docs/reference/plugins
- OpenCode Plugins：
  - https://opencode.ai/docs/plugins/
- Google Antigravity Agent Plugin / Skills：
  - https://codelabs.developers.google.com/cloud-dev-plugin-agy
  - https://codelabs.developers.google.com/getting-started-with-antigravity-skills
- DSH：
  - 目标版本为第 19.2 节固定的 `0.1.5-rc.1`，以该版本的公开 API 和重新取得的运行证据为准；`Dev-Wiki/dev-harness-dsh` 的 rc.8 基线只作历史迁移参考。

任何平台打包器在构建前都应通过：

```text
platform capability / format validation
```

发现官方规范变化时：

```text
只调整对应 Adapter / Packager
```

不要修改 Runtime Core 的业务语义。

---

# 50. 最终架构结论

目标不是维护：

```text
dev-harness-codex
dev-harness-dsh
dev-harness-cursor
dev-harness-opencode
dev-harness-antigravity
```

五套工作流。

目标是维护：

```text
                    dev-harness
                         │
                         ▼
                dev-harness-runtime
                         │
                  Shared Runtime Core
                         │
          ┌──────────────┼───────────────┐
          │              │               │
       Executor       Executor        Executor
        Codex           DSH            Future
          │              │               │
      Packager       Packager         Packager
          │              │               │
        Codex            DSH          Other Hosts
```

最终原则：

> **协议在 dev-harness。**
>
> **流程在 dev-harness-runtime/core。**
>
> **平台差异在 Adapter。**
>
> **安装差异在 Packager。**
>
> **同一个流程，只生成不同平台的插件。**
