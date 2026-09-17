# Runtime 公共契约

本文是 Core、Worker、Executor 和 Packager 的接口与行为语义权威。协议初始版本为 `1`，K1 已落地类型、JSON Schema 与 fixtures，K2 已实现项目与 Planning 读取；其余目标语义的完成状态见看板。选择理由与来源见 [公共契约决策](decisions/runtime-contracts.md)，跨任务状态见 [Dashboard](plan/Dashboard.md)。

## 1. 通用数据规则

- 所有持久记录和跨进程结构都有 `schemaVersion`；MVP 接受精确值 `1`，未知版本 fail closed，不推测兼容性。
- `runId` 为随机生成、在状态根下唯一的 `[a-z0-9][a-z0-9-]{0,63}`；Task ID 为 `[A-Za-z][A-Za-z0-9._-]{0,63}`。ID 大小写敏感，文件名必须匹配。
- attempt 从 1 开始，针对同一 Run / Task 单调递增；attemptId 为 `<task-id>-<attempt>`。每次实际启动使用新的 requestId，结果必须匹配四元组 `runId/taskId/attempt/requestId`。
- revision 为非负安全整数，单次持久 CAS 成功只加 1；时间使用 UTC RFC 3339。SHA-256 保存为小写 64 位 hex，Git object id 由 Git 实际解析，不能假定只支持 SHA-1。
- 持久的项目路径采用仓库相对 POSIX 路径。禁止空路径、绝对路径、`..`、NUL、大小写别名冲突和通过 symlink 逃逸。内存的 repoRoot/docsRoot 使用 realpath；linked worktree 必须绑定各自的 private Git dir。
- 私有日志和结果引用使用 Run 目录相对路径，并附摘要；它们不能当作项目变更路径。未知字段默认拒绝；需要新扩展时升级 schema 或在已声明的 namespaced 扩展字段中定义。
- 文档摘要、Worker 自报 changedFiles 和宿主退出码不是独立验证证据。只有身份、内容与信任边界均满足下述规定的记录才能推进 Run。

HostEnvironment 提供 repoRoot / privateGitDir、os / architecture、Node / Git 版本、宿主可执行入口、目标宿主版本和非敏感配置摘要；不包含 credential 值或整个 process.env。AdapterDoctorResult 包含 available、targetVersion、observedVersion、检查项列表、缺失前置条件与证据引用。PlatformAdapter / TaskExecutor / PluginPackager 的 id 由 Registry 保证唯一，HostEnvironment 不包含模型选择策略。

## 2. Planning 读取协议

### 文档发现

遵循上游 docs root 规则：用户显式值优先，其次看已有治理或活跃计划归属，只有 doc 或 docs 时使用该根，两者冲突且不能证明唯一归属时拒绝。Reader 不自动创建文档树。Dashboard 是唯一活跃索引，TaskDetails 若存在只允许兼容跳转，不作为第二索引。

自动执行要求项目已有有效 HEAD、AGENTS.md、HARNESS.md 和可解析的权威验证入口。doctor 可在缺项项目只读运行并报告 `UNBORN_HEAD` / `PROJECT_CONTRACT_MISSING`；人工完成 R0、V0 不受 Runtime 尚未建立的执行门禁限制。

### 支持的 Markdown 子集

1. 在代码块外识别一个 `当前工作顺序` 和一个 `活跃任务` 二级标题；标题可有 `1.` 形式数字前缀。其他同名权威段落、HTML 隐藏内容或嵌套表格不接受。
2. 工作顺序是顶层有序列表。每项以指向 `tasks/<Task-ID>.md` 的 Markdown 链接开始，链接文字包含同一 Task ID；序号连续且 ID 不重复。段落说明不形成任务。
3. 活跃表按六个表头定位字段：`任务`、`优先级`、`状态`、`依赖`、`下一步 / 阻塞`、`详情`。其中 `下一步 / 阻塞` 是一个单元格。不能靠列号或全文件正则猜测。
4. `任务` 单元格格式为 `ID — 名称`，允许对整项加粗；`详情` 恰有一个指向同 ID 活跃执行包的仓库内链接。`状态` 只接受上游的五个完整状态值。活跃表不得保留已完成行。
5. `依赖` 为 `无`，或以顿号分隔的 Task ID / Task 链接；链接可指向活跃包或明确归档。禁止“完成某阶段后”等自然语言条件作为可自动解析的依赖。ID 自依赖、环、重复或无法解析时拒绝。
6. `下一步 / 阻塞` 只有精确 `无` 或以 `无；` 开头的单元格表示无阻塞；后者分号后的文字是操作说明。其他非空内容全部保守视为阻塞原因，空白视为不完整输入。Runtime 不从“已解除”“正常”等词推断无阻塞。
7. 链接必须是相对路径、无 URL / query / fragment，解析并检查真实目标和路径 containment；Markdown 里的强调不改变身份。解析器应使用 Markdown 结构处理转义管道和代码块，不能用简单 split 解析整篇文档。

这个子集不要求改写上游 Planning Skill。Runtime 不兼容其他布局时返回 `UNSUPPORTED_PLAN_FORMAT` 和具体位置，交由项目按需调整。当前开发看板含有尚未解除的 G 编号，这些实施任务本就不能自动领取。

### 依赖完成证据

- 若同 ID 仍在活跃表，任何旧归档都不算该依赖已完成，包括重开任务。
- 不在活跃表的依赖按 ID 查询 `archive/*/README.md` 索引；只读相关索引行和匹配快照，不加载所有历史任务正文。
- 一个有效归档索引行必须有精确 ID、完成日期、非空验收摘要和存在的归档 Task 链接；正文要有完成验收结果和验证证据引用。证据缺失或多个归档无法确定最新闭合记录时拒绝。
- 同里程碑多次闭合采用上游的 `ID.md`、`ID.closure-N.md` 序号；只接受索引明确的闭合序号和前次关系。跨里程碑歧义由计划维护者明确，Runtime 不自行按目录字典序选取。
- 这表示项目已归档的完成声明及其可追溯依据，并非 Runtime 重新执行所有历史验收。相关索引和快照哈希纳入本次选择快照，防止依赖证据在启动前后漂移。
- 新 Run 的 DISCOVERY 还必须检查本 worktree 旧 Run 的未解决 pendingOperation。某份归档若来自尚未被 Core 接受的 lifecycle delta，不能因新建 Run 就变成历史完成证据；在 §6 的显式对齐完成前，整个 worktree 拒绝新的执行 Run。

### 任务资格和选择

`--task`、`--next`、`--all-ready` 互斥，且共用：存在于工作顺序、精确 `🟢 待执行`、唯一执行包、所有依赖完成、无 blocker、执行上下文完整。explicit 不绕过门禁。不按优先级排序。

next / all-ready 按权威顺序找第一个满足资格的任务；较早但尚未 ready 的任务不被启动。这里的筛选不等于跳过本次执行得到 blocked 的任务：一旦 execute 返回非 completed，整个 Run 立即停止。

`--task` 完成指定任务后结束；`--next` 接受一个任务后结束；`--all-ready` 每次接受后重读计划继续选取。没有候选且工作顺序为空时为 `COMPLETED`（当前队列耗尽，不代表远期 backlog 完成）；工作顺序非空但均不可执行时为 `BLOCKED`。缺陷计划为 `FAILED`，不能伪装为队列耗尽。Run 摘要记录 `queueExhausted`、`singleTaskFinished` 或具体停止原因。

## 3. 执行请求、结果和能力

### TaskExecutionRequest

| 字段 | 语义 |
|---|---|
| schemaVersion、coreProtocolVersion | 均为 1 |
| runId、taskId、attempt、requestId | 本次执行唯一身份 |
| repoRoot、docsRoot、dashboardPath、taskPath | 本次已验证的内存绝对路径；持久化时转换为仓库相对引用 |
| snapshotRef、snapshotHash | Core 写入的执行前快照引用与摘要 |
| scope | 确切允许的文件 / 目录前缀及允许的 Planning 单任务差异；不得由 Worker 自行扩大 |
| authorization | 从 Run 授权缩窄后的 Worker 授权，commit=deny，其他外部动作=false |
| verificationPlan | 从 Task acceptance 与 HARNESS 确认的命令及人工验收需求，含文件哈希 |
| protocolSource | 锁定上游版本、commit、所用文件哈希 |
| env | 显式允许传入的环境变量；四个 DEV_HARNESS 标记由 Core 覆盖注入 |

请求不能把父 Conversation、完整源码或完整日志作为后续任务上下文。平台 credential 由 Adapter 经宿主安全机制提供，不写入 request、run.json 或原始环境快照。env 中四个标记为 `DEV_HARNESS_WORKER=1`、RUN_ID、TASK_ID、ADAPTER，完整名称均带 `DEV_HARNESS_` 前缀。

### TaskExecutionResult

| 字段 | 语义 |
|---|---|
| schemaVersion、runId、taskId、attempt、requestId、snapshotHash | 绑定本次请求，任一不符即拒绝 |
| outcome | completed / blocked / failed / partial；Worker completed 是待 Core 接受的声明 |
| summary、reason | 紧凑结论；非 completed 必须给 reason |
| verification | VerificationEvidence 列表；completed 不允许缺少必需验收项 |
| changedFiles | Worker 声明的变更集，用于与实际快照比较，不能充当授权白名单 |
| closure | 当前任务归档路径、索引与 Dashboard 变更说明及摘要；completed 必须提供 |
| commitIntent | 可选提交信息与精确文件集合，依据项目 Git Workflow 生成；不是授权 |
| needsPlanning | 为 true 时禁止接受 completed |
| rawResultRef | 可选私有原始输出引用，必须位于当前 Run 并有摘要 |
| commitSha | Worker 结果中必须缺省；仅 Core 在提交后生成的已接受结果可包含 |

VerificationEvidence 必须包含 `id`、`kind`（command/manual）、验收条目关联、请求身份、验证前后 snapshotHash、时间、结果与证据引用。command 类型包含 argv、仓库内 cwd、exitCode、stdout/stderr 私有引用和内容摘要；manual 类型包含明确验收者与持久确认记录。Worker 自写日志只能作为声明，不能成为 trusted command 记录。

Core 使用受控验证进程执行 HARNESS / Task 的必需命令并生成可信证据；人工验收项没有用户确认时为 blocked。验证可写哪些构建产物必须预先声明；源码、计划、原有 dirty 文件、index 或 HEAD 在验证阶段被改变均拒绝。不能简单忽略整个 .gitignore 范围。

受控验证进程及其所有后代不得提交、执行外部动作或获取不需要的凭据。Core 启动的代码同样受授权约束；固定 argv 不是脚本内部行为的保证。平台无法强制执行该边界时停止自动验证，不把不受控运行输出标为可信。

### ExecutorCapabilities

保留设计中的 available、freshSession、structuredOutput、nonInteractive、cancellation、resumeRunWithFreshSession、pluginPackaging、reasons，并增加证据引用、目标宿主版本以及可强制执行权限边界的 `authorizationEnforced`。自动运行要求前六个执行能力及 authorizationEnforced 全部成立；packaging 单独判断。

freshSession 必须由宿主可验证的 session/thread/process identity 证明，不能用“调用两次”替代。授权边界必须由宿主可验证权限或受控工具桥接强制执行；仅在 prompt 中写禁止命令不满足 authorizationEnforced。探测无法证明时只保留人工 Skill / 打包能力，禁止静默降级到不受控 Executor。

原始日志落盘，向父上下文只返回 runId、taskId、status、summary、verification summary、commitSha、nextTask、logRef。取消要终止并等待子进程 / 句柄静止后才能重验证，不能先释放锁再等待仍可写文件的 Worker。

## 4. 所有权、验证与提交

### 快照与可修改范围

执行前快照包含 canonical repoRoot / privateGitDir、branch、HEAD、完整 index 状态、Dashboard / 当前 Task / 依赖归档、AGENTS / HARNESS / Git Workflow、协议来源、Adapter 配置与所有原有修改内容。每个路径记录 type、mode、raw-content hash 或 symlink 文本、deleted、index blob/mode；包括 untracked，不能只存 git status。

Task Packet 中的“影响文件”可用于产生 scope 候选，但 Core 在 execute 前必须固定具体文件或明确目录前缀，禁止整个仓库、私有状态和 Git 元数据作为通用写入范围。任务需要修改治理或验证契约时必须明确授权该路径，并使验证基线独立于 Worker 的新版本；不能让 Worker 改验收命令后用新命令证明自己通过。

MVP 自动执行不接受本任务将写入的路径已有用户修改，也不接受预先暂存内容；这两类情况在派发前 blocked，留给人工分离。其他原有修改可以保留，但每一路径的内容、类型和 index 必须保持不变。允许路径只是必要条件；实际变化还要与 Worker 声明、受控操作证据和持久检查点一致。

这里的“原有用户修改”以 Run 创建时为界；本 Run 前一任务已通过 Core 验收、纳入 accepted boundary 的修改属于受控继承，不会被误判成用户改动。no-commit 下后续任务可以继续修改该 accepted boundary 中的 Dashboard / 归档索引，仍须保护创建 Run 前的用户内容，并验证任务之间没有外部漂移。

### 单任务执行和收口

1. Core 持锁做 precheck、选择任务、固定 scope / verificationPlan、捕获快照，并持久化 execute intent，之后才派发 Worker。
2. Worker 只做本任务修改与验收。成功候选按锁定的上游 Planning 流程记录证据、迁移执行包、更新归档索引和 Dashboard。失败时停止并如实返回，不能领取其他任务。
3. Worker 结束且宿主静止后，Adapter 固定结果与结束边界；Core 独立核验身份、全部实际变更、原有修改、计划差异，再运行受控验收。
4. Core 只接受当前任务的 lifecycle delta：任务验收记录、归档、索引添加、活跃行和顺序移除、最多五项近期完成摘要。其他任务的状态、优先级、依赖、scope 不能顺便改变；扩大规划必须 needsPlanning 并停止。
5. 所有门禁通过后进入 FINALIZE；无提交模式记录已接受的工作树边界。有提交模式按下一节提交。最后原子更新 run.json 的 accepted boundary / completedTasks 并清除已完成的 pendingOperation，重读 Dashboard。

Core 没有第二套 Planning 写入器。对预先存在的项目完成归档，Reader 按 §2 判断；对本次 Worker 的归档，必须同时满足本节独立验证才计入本次 Run 完成。

### 提交与外部动作

RunAuthorization 为 commit=deny 或 task，push / pullRequest / tag / release / deploy 均为 false。默认 `--no-commit`；`--commit-each` 必须有本次明确授权。两标志冲突即错误。授权绑定 Run，不因 resume、配置变化或 Worker 输出扩张。

Worker 权限始终缩窄为不能提交。Core 的 Git 桥接读取已冻结的项目 Git Workflow、接受的 commitIntent 和独立验证结论，精确逐个 `git add -- <file>`，比较实际暂存集合，再提交。范围必须包括获准的本任务代码、验收与收口文件，排除原有用户修改。提交格式以项目规范为准，Runtime 不为项目补默认分支或 message 策略。

桥接不执行任意 Worker 提供的 shell 字符串；argv、路径和允许动作由受控实现构造。仓库 hooks 或项目提交机制会改变文件、要求额外外部动作，或权限无法约束时停下，不能静默禁用规则绕过。

Git 桥接只获本次已授权提交所需能力；hooks 及其派生进程不得借用该能力创建额外提交、push、tag、发布或部署，也不得访问不需要的凭据。无法隔离和证明该边界时 commit-each 被阻止，不能以桥接来自 Core 为由绕过 RunAuthorization。

提交后验证真实 Git object、唯一父提交、精确文件集、当前 HEAD、tree 和剩余工作区。Worker 提交、混入文件、额外 HEAD 前进、错误父提交均拒绝。失败时保留现场，不自动 reset、amend、unstage 用户内容或删除提交。

## 5. Run 状态、日志与锁

```text
$(git rev-parse --git-path dev-harness-runtime)/runs/
├── .orchestrator.lock/
└── <run-id>/
    ├── run.json
    ├── attempts/
    │   └── <task-id>-<attempt>/
    │       ├── stdout.log
    │       ├── stderr.log
    │       ├── events.jsonl
    │       └── snapshots/
    ├── results/
    │   └── <task-id>-<attempt>.json
    └── summary.json
```

run.json 是唯一权威状态；锁只表达互斥所有者，不表达 Task 状态；results / snapshots 是按 run.json 引用的证据，summary 是可重建投影。不能寻找“最新 result”来覆盖 run.json。

RunState 包含设计中的 schemaVersion、revision、runId、adapter、status、phase、currentTaskId、currentAttempt、completedTasks、authorization、createdAt、updatedAt，另包含 repo identity、selectionMode、protocolSource、initialUserChangesRef/hash、acceptedSnapshotRef/hash、currentRequestId、resultRefs、stopReason、pendingOperation 和可选 reconciliation 记录。

pendingOperation 保存唯一 operationId、kind（execute/verify/commit）、before 边界摘要、预期身份与范围、可恢复检查点引用；commit intent 还要保存 parent、精确路径、预期 tree 和提交信息摘要。它是 run.json 内的字段，不能再创建可独立推进状态的 journal.json。

### 状态转移

| 当前状态 / 事件 | 新状态 | 条件 |
|---|---|---|
| 新 Run 创建 | CREATED | 授权和 repo identity 已固定 |
| precheck / 执行启动 | RUNNING | 锁和输入验证通过 |
| 遗留 CREATED / RUNNING 的 owner 已终止 | INTERRUPTED | 取得恢复互斥，证明旧 owner 与子进程均静止后，以 CAS 记录中断；活着或身份不明的 owner 不可接管 |
| Worker blocked / 验收需人工 / 无 ready 候选 | BLOCKED | 记录原因和最近可信检查点 |
| Worker partial / 用户取消 / 进程退出 | INTERRUPTED | 保留现场，不把部分成果计为完成 |
| Worker failed / 无效结果 / 违规或数据损坏 | FAILED | 终止自动推进，保留证据 |
| 所选模式的任务完成或队列耗尽 | COMPLETED | 无悬而未决操作，所有完成声明已被接受 |
| BLOCKED / INTERRUPTED 收到 resume | RUNNING | 同一授权、环境和可信边界重验证通过 |

FAILED / COMPLETED 不能 resume；FAILED 的未解决操作须先按 §6 显式对齐，再新建 Run。BLOCKED / INTERRUPTED 若外部修改导致边界变化，也不能自动吸收新基线，需显式对齐后按当前项目新建 Run。resume 不代表恢复 Conversation。

phase 采用 DISCOVERY → SELECT → SNAPSHOT → EXECUTE → REVALIDATE → FINALIZE。非 completed 停在当前 phase，下一任务在已接受 FINALIZE 后回 SELECT。precheck 包含在 DISCOVERY；verify 的可信子操作记录在 REVALIDATE 中，不创造第二套 phase 状态机。

### 原子写与互斥

每个 worktree 的所有 Run 共用一个 `.orchestrator.lock/`。锁元数据含 ownerToken、runId、pid、进程启动身份（可取得时）、adapter、repoRoot、privateGitDir、createdAt。跨进程使用 exclusive create / mkdir；读写 run.json 时核验 ownerToken 与 expectedRevision，写临时同目录文件、flush、原子替换后才返回成功。

进程存活不能只看 PID 或 mtime。只有可证明旧 owner 已终止、其子进程静止且没有并发接管时才允许 stale 回收。回收过程用独立互斥 guard 序列化，所有获取者都须遵守；无法证明 owner、guard 陈旧或平台无法提供等效原语时停止并报告人工处置，不按超时盲删。

MVP 的 crash-safe 含义是进程异常退出不会让半份 JSON 被当成有效状态；更新要么保留旧完整版本，要么出现新完整版本，未知结果停下。支持时执行目录 fsync；不同 OS 对断电持久性的保证必须实测并单独声明，不能宣传统一耐断电事务。revision CAS 防丢更新，不等于跨 Git / 多文件计划的原子事务。

## 6. 崩溃恢复协议

resume 先获取同一 worktree 锁、读取唯一 run.json，校验 schema、授权、repo identity、协议与配置、HEAD / index / 文件实况和证据哈希。对目录外引用、无效 JSON、悬空结果或未知操作一律停止。旧 DSH 状态不进入这个过程。

若磁盘状态仍为 CREATED / RUNNING，先证明旧进程树已停止并按 §5 记录 INTERRUPTED，之后才执行下表；不得对仍在运行的 owner 启动第二个 Worker。

| 崩溃位置 | 可以自动做的事 | 必须停止的情形 |
|---|---|---|
| execute intent 已写，尚未派发 | 当前边界仍等于 before 时新建 attempt 和新 Session | 当前内容已有不能归属的变化 |
| Worker 执行中，包括多文件计划迁移中 | 只有存在可信静止检查点、准确内容摘要和 pending intent 时，才以新 Session 继续当前 Task 的剩余工作 | 只有允许路径清单或自报日志，没有可核实的检查点；不完整归档的内容归属不明 |
| Worker 完成、结果文件写入，run.json 尚未引用 | 在 pending execute 身份和结束边界匹配时，重新校验并显式采纳该候选结果 | 任一身份、hash 或实际边界不符；不从目录时间戳选取结果 |
| 计划收口完成，Core 验证尚未完成 | 保持当前 Task 身份，重跑受控只读验证；不再执行已完成的开发动作 | 验证所需输入已经被外部改变 |
| 验证通过，无提交 FINALIZE 未持久化 | 当前边界仍等于可信验证后边界时补记 accepted 结果 | 验证之后又有变化 |
| commit intent 已写，暂存中断 | 对 Core 已记录的精确 index 中间态继续提交桥接 | 暂存集合或 blob 与 intent 不符，不自行清空 index |
| commit 成功，状态尚未更新 | HEAD 恰为 intent.parent 的一个子提交，tree / 路径 / message 匹配且工作区一致时采纳 commitSha | 多个候选、merge、未知 HEAD 或无 intent；禁止重复提交 |
| accepted 状态已写，摘要未写 | 从 run.json 和被引用证据重建 summary，继续 SELECT 或结束 | 被引用证据损坏或缺失 |

恢复不会启动旧 Conversation。需要继续执行时 requestId 和 attempt 改变、Session 身份改变，并引用已接受的项目与操作证据。一个 Task 正常执行使用一个 Session；恢复同一 Task 可有新的 attempt / Session。

MVP 不承诺任意工具副作用恰好一次。对无法观测或证明的外部副作用，授权门禁先禁止；对本地未知中间态保留现场并停止。失败恢复不能以提高可用性为由放宽漂移检查。

### 人工对齐后的解锁

为避免通过新建 Run 绕过未接受归档，增加显式操作 `dhr reconcile <run-id> --resolution <file>`。它只验证和记录人工对齐，不执行 Task，不写 Planning，不恢复旧 Conversation，也不把失败 Run 改成成功。

resolution 必须含目标 runId / 原 revision、人工确认的当前项目快照摘要、处置说明、相关 Task ID 和证据引用。操作者须先在项目中完成修复或恢复，再明确调用该命令；Worker 环境拒绝调用。Core 持锁核对声明与当前实况、重新检查受影响计划、按现有授权边界核验相关证据。如果保留当前任务的完成归档，还必须重新通过其验收；否则须已恢复为明确的活跃任务。未知归档不能通过一条说明获得完成资格。

通过后在原 run.json 记录 reconciliation（原 pending identity、处置者、当前边界、证据摘要、时间），将该操作标为已对齐；原 status、失败原因和违规历史保留，completedTasks 不追认失败执行。首次承接该对齐基线的新 Run 只能在当前边界匹配时创建，并记录对齐来源及摘要。持锁先在原记录 CAS 预留唯一 successorRunId，再创建该 ID 的 Run；中断后只补建同一 ID，不能重复消费一次对齐。承接 Run 建立后沿其 accepted boundary 和后续正常边界链检查，不再要求未来所有 Run 匹配旧对齐快照。记录不匹配、存在环或重复承接、仍有未解决操作或无法验证时继续阻止执行。此命令是恢复入口的细化，由 K3-R / K4 实现，不是另一套 Planning 修复器。

递归门禁覆盖所有 `dhr run` 模式、resume 和 reconcile；`DEV_HARNESS_WORKER=1` 下全部拒绝。

## 7. Packager 与构建契约

PluginPackager 保持 generate(input)、validate(plugin, input)、pack(plugin, input) 三个接口。输入 `PluginBuildInput` 包含 schemaVersion、platform、releaseVersion、adapterVersion、coreProtocolVersion、protocolSource、skills、runtimeBundle、adapterBundle、metadata、buildTimestamp。skills / bundle 均有相对路径、SHA-256 和来源记录，metadata 至少有 name、displayName、description、author、repository 与许可声明引用。

GeneratedPlugin 包含 platform、adapterVersion、生成根、相对文件清单与 hash、输入摘要。ValidationReport 包含 valid、检查项列表（code、path、message、severity）、输入摘要与证据引用。Artifact 包含 platform、variant、version、coreProtocolVersion、相对 file、mediaType、size、sha256、生成输入摘要；variant 区分 OpenCode npm / local 等多产物。

验证输入不可用、缺字段、路径越界、绝对本机路径、重复 Skill、未完成标记、版本不一致或产物引用缺失时均失败。pack 只接受与验证报告摘要一致的目录，不能在校验后偷偷重新生成。

dist/manifest.json 汇总 releaseVersion、coreProtocolVersion、来源提交、协议来源、Adapter 兼容映射、artifacts；它是产物事实表，不决定运行时能力。能力矩阵仅由带来源的测试 / probe 证据生成，未知能力用 false + reasons，不能用构建成功推断 freshSession。

PlatformAdapter 具有 id、可选 executor、packager、doctor；重复 ID 拒绝。Core 只依赖公共接口，注册新平台不修改 Orchestrator。没有 executor 的平台仍可 build / validate / pack；doctor 必须明确其自动运行不可用。

## 8. CLI 结果与验收实例

CLI 退出码：0 表示请求模式正常结束；2 表示参数或不支持的输入；3 表示 blocked；4 表示执行、结果或验证失败；5 表示漂移 / 所有权 / 授权拒绝；130 表示用户取消。持久原因码比退出码更精确，至少覆盖 PLAN_AMBIGUOUS、DEPENDENCY_UNRESOLVED、NO_READY_TASK、UNBORN_HEAD、CAPABILITY_MISSING、DRIFT_DETECTED、AUTHORIZATION_VIOLATION、INVALID_RESULT、STATE_CORRUPT、LOCK_OWNER_UNKNOWN、PENDING_RECONCILIATION。

以下是 K1–K4 的必需 fixture 语义，不是已经运行的测试：

| 输入 / 事件 | 预期结果 |
|---|---|
| A、B、C 顺序排列，B 依赖 A，C 依赖 B；A 收口并被接受 | 重读后才能选 B；依赖来自 A 的归档证据；三任务各有独立 request / Session |
| explicit 选择仍处于规划中或 blocker 非无的任务 | BLOCKED，零次 execute |
| 工作顺序为空，但远期任务仍存在 | 当前 Run 正常队列耗尽，不宣称整个项目完成 |
| 工作顺序有任务，但依赖未完成 | BLOCKED，不写 completedTasks |
| 状态文本相同但某 dirty 文件内容改变 | DRIFT_DETECTED |
| Worker 返回 completed 但 verification 缺失、needsPlanning=true 或未收口 | 拒绝 completed，不提交、不选下一任务 |
| Worker 在当前任务归档时修改另一个任务优先级 | 拒绝 Planning delta |
| no-commit 时 HEAD 前进或 Worker 返回 commitSha | AUTHORIZATION_VIOLATION |
| 请求身份相同但结果的 attempt / snapshotHash 不同 | INVALID_RESULT |
| Worker partial / cancel，只有部分文件变化而无可信 checkpoint | INTERRUPTED；resume 停止要求人工对齐 |
| Core 被强制结束，磁盘仍为 RUNNING | 先证明原进程树静止，再 CAS 为 INTERRUPTED；不与旧 owner 并行 |
| A 已被 Worker 归档但 Core 验收失败，随后新建 Run 试图执行 B | PENDING_RECONCILIATION，不能把 A 当作历史完成；显式对齐后才重建基线 |
| no-commit 的 A 被接受，B 接着修改 Dashboard | 允许继承本 Run accepted boundary；Run 创建前的用户修改仍须完整保留 |
| 已提交但 run.json 未确认，commit intent 和实际 Git 唯一匹配 | 接受已有提交，不生成重复提交 |
| 旧 DSH schema v5 状态被指定给 resume | 拒绝格式与命名空间，保持原文件字节不变 |

## 9. K1 可执行协议

公共实现入口为 [contracts](../packages/contracts/src/index.ts)。TypeBox 的 Schema 是字段定义来源，TypeScript 类型由 `Static` 推导；[JSON Schema 目录](../packages/contracts/schemas/) 是同源导出，`pnpm schemas:check` 检查逐字节一致。`pnpm schemas:write` 在构建后更新导出。Schema 使用 draft-07；外部校验器须注册下述四种 format，并同时执行关联校验，不能只凭 JSON Schema 宣称完整契约有效。

| 解析名称 | 对应对象与字段定义 |
|---|---|
| `taskExecutionRequest`、`taskExecutionResult`、`acceptedTaskExecutionResult` | [execution.ts](../packages/contracts/src/execution.ts)：请求、Worker 结果、Core 接受记录；Worker 结果禁止 `commitSha`，只有独立接受记录允许该字段 |
| `verificationPlan`、`verificationEvidence`、`executorCapabilities` | 同文件：命令 / 人工检查、执行身份、验收 ID、前后快照和证据；每个 true 能力都需要引用证据 |
| `scope`、`runAuthorization`、`workerAuthorization`、`protocolSource` | [common.ts](../packages/contracts/src/common.ts)：精确文件 / 目录、当前 Task 四个收口路径、Run 授权与固定协议来源 |
| `snapshot`、`runState`、`lockMetadata`、`reconciliationResolution` | [state.ts](../packages/contracts/src/state.ts)：项目内容、Run 唯一状态、锁 owner 元数据、人工对齐输入 |
| `pluginBuildInput`、`generatedPlugin`、`validationReport`、`artifact`、`releaseManifest`、`hostEnvironment`、`adapterDoctorResult` | [packaging.ts](../packages/contracts/src/packaging.ts)：构建来源、Skill / Bundle 摘要、许可引用、版本、doctor 与平台产物 |

`parseContract(name, unknown)` 同时执行严格结构和单记录关联校验，返回对应类型；不做值转换、默认填充或删除未知字段。`parseContractJson` 另负责 JSON 语法失败。错误统一为 `ContractValidationError`，包括 `code`、消息和结构错误的 `issues[{path,message}]`。未知版本、缺字段、非法路径和单记录关系错误为 `INVALID_CONTRACT`；这里只支持 schemaVersion / coreProtocolVersion 1，旧 DSH schema 不转换。

四种 format 的实际实现见 [validation.ts](../packages/contracts/src/validation.ts)：`repo-path` 为非空相对 POSIX 路径，禁止空段、`.` / `..`、反斜线、冒号、控制字符、Windows 设备名和末尾空格 / 点别名；`absolute-path` 接受 POSIX、Windows drive / UNC 的绝对路径并拒绝点段和控制字符；`utc-timestamp` 使用 `Z`、真实公历日期、秒或 1–3 位毫秒；`semver` 使用完整 SemVer，支持 prerelease / build，禁止浮动版本。项目文件路径与 Run 内证据引用都使用 `repo-path` 的词法规则，解析根由使用方决定。内存请求和 `repoIdentity` 的仓库定位字段允许绝对路径，便携产物不允许本机绝对路径。

`Snapshot.paths` 明确区分 file（rawContentHash、100644 / 100755）、symlink（原始目标文本、120000）、gitlink（commit、160000）和 missing（deleted=true、mode=null）。每项 `index` 记录 stage / blob / mode，空数组表示没有索引项；stage 0 不与冲突 stage 共存。快照还包含治理文件与 Planning 的摘要引用、协议来源和 adapterConfigHash。对象 ID 允许 SHA-1 / SHA-256 形状；对象是否存在和快照是否完整由 K3 检查。

`RunState` 区分 initialUserChanges 与 acceptedSnapshot 的引用 / 摘要；currentTaskId / currentAttempt / currentRequestId 同时存在或同时缺省。`resultRefs` 使用 `{identity,ref}`；pendingOperation 分 execute / verify / commit，提交另含 parent、paths、expectedTree、messageHash。reconciliation 保留原执行身份和唯一 successor 预留，承接 Run 记录 reconciledFrom。静态校验验证同一记录的身份、时间及摘要一致性；锁、CAS、跨记录唯一性、历史状态转移和崩溃恢复仍由 K3-L / K3-R 实现。Run 布局保持 `$(git rev-parse --git-path dev-harness-runtime)/runs/<run-id>/run.json`，不增加第二种状态文件。

[validateResultForRequest](../packages/contracts/src/binding.ts) 绑定结果与请求的 runId / taskId / attempt / requestId / snapshotHash，核对声明路径、验收 ID、命令 argv / cwd、完整证据覆盖与当前 Task 的四路径收口。`completed` 必须有全部 passed 检查和 closure；其他三类必须有 reason，可以只提供已执行检查。错误结果为 `INVALID_RESULT`，声明越权路径或 Worker commitSha 为 `AUTHORIZATION_VIOLATION`。`assertSnapshotHash` 的边界摘要不等时为 `DRIFT_DETECTED`；`requireExecutionCapabilities` 缺运行能力时为 `CAPABILITY_MISSING`，pluginPackaging 不作为运行能力门槛。

这些 API 校验的是声明。证据引用的 SHA-256、受控验证是否真实运行、命令前后内容边界、symlink / realpath、用户原有修改、实际 HEAD / index 和 Planning delta 仍须 Core 独立核实；通过解析不会自动授予提交或自动启用 Executor。`AcceptedTaskExecutionResult` 也是数据类型，调用解析器不能产生可信接受资格。

[interfaces.ts](../packages/contracts/src/interfaces.ts) 固定 TaskExecutor / PluginPackager / PlatformAdapter / Registry 接口。Executor 的取消使用 AbortSignal，只有执行树静止后才允许以 AbortError 拒绝；共享 [Executor Contract Tests](../tests/contract/executor-contract.mjs) 通过可注入 harness 复用场景，当前只有 Fake Executor 的接口证据。Packager 的 validate / pack 同时显式接收原构建 input，便于保持输入摘要绑定；pack 必须使用已成功验证且未漂移的目录，实际摘要与产物校验由 K10-B 实现。

## 10. K2 项目与 Planning 读取实现

[Core](../packages/core/src/index.ts) 提供 `discoverProject(cwd, options)`、`readPlan(project)`、`selectTask(plan, selection)`。Discovery 使用真实 Git 解析主仓 / linked worktree 的 repoRoot、privateGitDir、HEAD 和 `--git-path dev-harness-runtime`，只读取、不创建状态目录。显式 docsRoot 优先；双根先按治理链接判定归属，再以唯一 Dashboard 归属判定，不能证明时拒绝。doctor 模式可返回缺少 HEAD / 项目契约的 issues，不将该项目升级为可执行状态。

HARNESS 读取“已确认命令（人工维护）”内按列名识别的表格，收集 confirmed 命令，至少包含 test / quick / bugfix / full 之一。重复列、重复用途、嵌套表格和隐藏 HTML 拒绝；候选命令不获得执行资格。此阶段只返回命令文本，argv 构造、进程权限、冻结来源和实际验证由后续任务完成。

Planning 使用 [markdown-it 的结构 token](https://markdown-it.github.io/markdown-it/documents/Architecture.html)，固定依赖 15.0.2。仅在目标段落中读取表格与顶层有序列表，按表头映射字段；转义管道保留为单元格内容，代码块和普通段落中的任务示例不形成工作顺序。原始表格行另校验列数，避免解析器自动补齐 / 截断掩盖坏输入。单份 Planning Markdown 限 2 MB，超限明确拒绝，不截断后继续选择。

`readPlan` 返回 `order`、`tasks` 和本次读取的 `references[{path,sha256}]`。Task Packet 的标题须与 ID 一致，并检查背景、执行上下文的四类输入、范围、影响文件、验收 checkbox、验证方法和停止条件章节；缺项标为 contextComplete=false，选择时阻止执行。该结构检查不等于证明需求内容正确或所有执行条件已经满足。

归档查询只读索引与被依赖 ID 的快照 / 证据引用；不会预读其他任务的历史正文。首次闭合使用 ID.md，后续要求索引 `关闭次数` 连续且日期不倒退、`前次` 列链接紧邻前次快照，正文也链接前次快照。多个里程碑对同一 ID 的闭合仍属歧义，需要项目消除歧义。依赖仍在活跃表时始终未完成，旧归档不能使其通过。索引、相关闭合记录和证据文件的原始字节摘要进入 references。

选择返回 selected / blocked / completed(queueExhausted)。不存在的 explicit Task 抛 `PlanningError` / TASK_NOT_FOUND；结构损坏、缺文件、空白 blocker、未知状态、缺失 ready 顺序项等抛带 code、path、可用行号的错误。非空且不符合“无”规则的 blocker 返回 blocked。all-ready 每次只选一个 Task，调用方须在接受结果后重新读取，不能缓存整批任务直接执行。

相对 Markdown 引用与 K1 的持久路径字段不同：链接允许 `../`，但规范化及 realpath 后须留在真实仓库内；禁止 URL、query、fragment、反斜杠、控制字符和路径大小写别名。已存在的 symlink 逐段检查，避免越界读取。上述检查是读取时检查；启动前的并发漂移和全内容快照由 K3 负责，未接受的 Run 归档与 pendingOperation 门禁由 K3-R / K4 联合完成。
