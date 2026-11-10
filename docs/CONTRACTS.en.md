# Runtime public contracts

[English](CONTRACTS.en.md) | [简体中文](CONTRACTS.md)

This document is authoritative for Core, Worker, Executor, and Packager interfaces and behavioral semantics. The initial protocol version is `1`. K1 implements types, JSON Schema, and fixtures; K2 implements project and Planning reading. See the Dashboard for completion of other target semantics. Rationale and sources are in [public contract decisions](decisions/runtime-contracts.md), while cross-task state is in the [Dashboard](plan/Dashboard.md).

## 1. Common data rules

- All persistent records and cross-process structures carry `schemaVersion`. MVP accepts exactly `1`; unknown versions fail closed without guessing compatibility.
- `runId` is randomly generated and unique within the state root, matching `[a-z0-9][a-z0-9-]{0,63}`. Task IDs match `[A-Za-z][A-Za-z0-9._-]{0,63}`. IDs are case-sensitive and filenames must agree.
- attempt starts at 1 and increases monotonically for the same Run / Task; attemptId is `<task-id>-<attempt>`. Every actual launch uses a new requestId. Results must match the `runId/taskId/attempt/requestId` tuple.
- revision is a nonnegative safe integer, incremented by exactly 1 per successful persistent CAS. Times use UTC RFC 3339. SHA-256 is stored as 64 lowercase hexadecimal characters. Git resolves actual object IDs; do not assume SHA-1 only.
- Persistent project paths use repository-relative POSIX form. Reject empty or absolute paths, `..`, NUL, case-alias conflicts, and symlink escapes. In-memory repoRoot/docsRoot use realpath; linked worktrees bind their own private Git directories.
- Private log and result references are relative to the Run directory and carry digests; they are not project-change paths. Unknown fields are rejected by default. Extensions require a schema upgrade or an already-declared namespaced extension field.
- Document summaries, Worker-reported changedFiles, and host exit codes are not independent verification evidence. Only records satisfying the identity, content, and trust-boundary requirements below can advance a Run.

HostEnvironment supplies repoRoot / privateGitDir, os / architecture, Node / Git versions, host executable entries, target host versions, and nonsensitive configuration digests; it excludes credential values and the full process.env. AdapterDoctorResult contains available, targetVersion, observedVersion, checks, missing prerequisites, and evidence references. Registry guarantees unique PlatformAdapter / TaskExecutor / PluginPackager IDs. HostEnvironment does not contain model-selection policy.

## 2. Planning reading protocol

### Document discovery

Follow upstream documentation-root rules: an explicit user value wins, then existing governance or active-plan ownership. Use the sole doc or docs root when only one exists. Reject conflicting roots when unique ownership cannot be proven. Reader does not create documentation trees. Dashboard is the only active index; TaskDetails, if present, may only be a compatibility redirect, never a second index.

Automatic execution requires a valid HEAD, AGENTS.md, HARNESS.md, and parseable authoritative verification entry points. doctor can run read-only in incomplete projects and report `UNBORN_HEAD` / `PROJECT_CONTRACT_MISSING`. Manually completing R0 or V0 is not constrained by Runtime execution gates that have not yet been established.

### Supported Markdown subset

1. Outside code blocks, recognize one level-two `当前工作顺序` (current work order) heading and one `活跃任务` (active tasks) heading. A numeric prefix such as `1.` is allowed. Additional authoritative sections with those names, hidden HTML, and nested tables are rejected.
2. Work order is a top-level ordered list. Each item begins with a Markdown link to `tasks/<Task-ID>.md` whose text includes the same Task ID. Numbers are contiguous and IDs unique. Explanatory paragraphs do not create tasks.
3. Locate active-table fields by six exact headers: `任务`, `优先级`, `状态`, `依赖`, `下一步 / 阻塞`, `详情` (task, priority, status, dependencies, next step / blocker, details). `下一步 / 阻塞` is one cell. Do not infer fields from column numbers or whole-file regular expressions.
4. A `任务` cell has `ID — name` format and may be entirely bold. `详情` contains exactly one repository-local link to that ID's active packet. `状态` accepts only upstream's five complete status values. Completed rows must not remain in the active table.
5. `依赖` is exactly `无` (none), or Task IDs / Task links separated by the Chinese enumeration separator `、`. Links may identify active packets or explicit archives. Natural-language conditions such as "after completing a phase" are not automatically parseable dependencies. Reject self-dependencies, cycles, duplicates, and unresolved IDs.
6. Only exact `无`, or a cell beginning `无；`, means no blocker in `下一步 / 阻塞`; text after that semicolon is an operation note. All other nonempty content is conservatively a blocker; blank content is incomplete input. Runtime does not infer readiness from phrases such as "resolved" or "normal".
7. Links must be relative, without URLs, queries, or fragments. Resolve actual targets and check path containment. Markdown emphasis does not change identity. Parsers must use Markdown structure to handle escaped pipes and code blocks, not split the whole document with simple string operations.

This subset does not require rewriting upstream Planning Skill. Incompatible layouts return `UNSUPPORTED_PLAN_FORMAT` with a precise location, leaving project-specific adjustment to the project. The current development Dashboard contains unresolved G-numbered gates; those implementation tasks are not eligible for automatic pickup.

### Frozen declaration for automatically executed Tasks

Packaged Codex `dhr run` reads one level-two `## Runtime 配置` heading and one `dhr-runtime` JSON block from the selected Task packet. Ordinary Planning reading does not depend on this declaration; automatic dispatch does. In this example, `test` must also be the purpose of a confirmed command in the original `HARNESS.md`, and that exact command text must appear as inline code in this Task's `验证证据` (verification evidence) section:

```json
{
  "schemaVersion": 1,
  "scope": {
    "files": ["src/feature.ts", "tests/feature.test.mjs"],
    "directories": [],
    "archivePath": "docs/plan/archive/M1/A.md"
  },
  "verification": {
    "sources": ["package.json", "pnpm-lock.yaml"],
    "commands": [{ "id": "test", "purpose": "test", "criteria": [1, 2], "writableArtifacts": [] }],
    "manual": []
  }
}
```

`scope.files` and `scope.directories` must exactly match repository-relative code paths in `影响文件` (affected files). Directory list entries end in `/`; JSON directories omit the trailing slash. The configuration cannot silently expand scope. `archivePath` identifies `<Task-ID>.md` within a milestone under the same docs root; the directory's `README.md` must already exist, and the target archive must not. `criteria` uses one-based checkbox positions from `验收标准` (acceptance criteria); every criterion must have at least one verification item. `verification.sources` lists additional verification inputs this Task will not modify. Core automatically includes original `HARNESS.md` and the current Task and freezes their byte digests. Candidate files that Worker will change cannot be frozen sources. `writableArtifacts` allows only explicit controlled-verification outputs, not extra Worker scope. Manual items may be declared, but the current Codex package lacks a trusted manual-confirmation channel and rejects such Tasks before dispatch. Missing or extra fields and inconsistent paths or commands fail; project-provided JS configuration is never executed.

### Dependency completion evidence

- If an ID still appears in the active table, no old archive establishes that dependency's completion, including reopened tasks.
- For dependencies absent from the active table, search `archive/*/README.md` indexes by ID. Read only relevant rows and matching snapshots, not every historical Task body.
- A valid archive row has an exact ID, completion date, nonempty acceptance summary, and an existing archived Task link. The body includes completed acceptance results and verification-evidence references. Reject missing evidence or multiple archives with no identifiable latest closure.
- Repeated closures within a milestone use upstream `ID.md` and `ID.closure-N.md` numbering. Accept only explicit closure numbers and predecessor relationships. Plan maintainers resolve cross-milestone ambiguity; Runtime does not choose by directory lexical order.
- These are archived project completion claims and traceable evidence, not reexecution of all historical acceptance. Relevant index and snapshot hashes enter this selection snapshot to detect dependency-evidence drift around startup.
- New-Run DISCOVERY must also check unresolved pendingOperations in old Runs for this worktree. An archive from a lifecycle delta not yet accepted by Core cannot become historical completion evidence merely because a new Run is created. The entire worktree rejects new execution Runs until explicit reconciliation under §6 completes.

### Task eligibility and selection

`--task`, `--next`, and `--all-ready` are mutually exclusive and share all gates: appearance in work order, exact `🟢 待执行`, a unique packet, completed dependencies, no blocker, and complete execution context. Explicit selection bypasses none of these gates. Priority does not reorder tasks.

next / all-ready select the first eligible task in authoritative order; earlier tasks that are not ready do not start. This filtering does not mean skipping a task that returns blocked during this Run: any non-completed execute result stops the entire Run immediately.

`--task` ends after the selected task; `--next` ends after one accepted task. `--all-ready` rereads the plan after every acceptance and continues selection. No candidate with an empty work order yields `COMPLETED` (the current queue is exhausted, not the distant backlog). Nonempty order with no executable tasks yields `BLOCKED`. A defective plan yields `FAILED`, never apparent queue exhaustion. Run summaries record `queueExhausted`, `singleTaskFinished`, or the specific stop reason.

## 3. Execution requests, results, and capabilities

### TaskExecutionRequest

| Field | Meaning |
|---|---|
| schemaVersion, coreProtocolVersion | Both 1 |
| runId, taskId, attempt, requestId | Unique identity of this execution |
| repoRoot, docsRoot, dashboardPath, taskPath | Validated in-memory absolute paths; converted to repository-relative references when persisted |
| snapshotRef, snapshotHash | Core-written pre-execution snapshot reference and digest |
| scope | Exact allowed files / directory prefixes and current-task Planning delta; Worker cannot expand it |
| authorization | Worker authorization narrowed from Run authorization; commit=deny, other external actions=false |
| verificationPlan | Commands confirmed from Task acceptance and HARNESS, plus manual acceptance requirements and file hashes |
| protocolSource | Pinned upstream version, commit, and hashes of used files |
| env | Explicitly allowed environment variables; Core overrides and injects the four DEV_HARNESS markers |

A request cannot pass the parent Conversation, complete source tree, or full logs as context to later tasks. Adapters supply platform credentials through host security mechanisms, never in requests, run.json, or raw environment snapshots. The four env markers are `DEV_HARNESS_WORKER=1`, RUN_ID, TASK_ID, and ADAPTER, each using the complete `DEV_HARNESS_` prefix.

### TaskExecutionResult

| Field | Meaning |
|---|---|
| schemaVersion, runId, taskId, attempt, requestId, snapshotHash | Bind the current request; reject any mismatch |
| outcome | completed / blocked / failed / partial; Worker completed is a claim awaiting Core acceptance |
| summary, reason | Compact conclusion; reason is mandatory for non-completed results |
| verification | VerificationEvidence claims actually obtained by Worker. A proposal-only host may return an empty list for a completed candidate, with Core independently supplying every required acceptance item. Nonempty lists must cover the full plan; partial claims are rejected |
| changedFiles | Worker-declared changes to compare with actual snapshots, not an authorization allowlist |
| closure | Current Task archive path, index / Dashboard changes, and digests; required for completed |
| commitIntent | Optional commit message and exact file set following project Git Workflow; not authorization |
| needsPlanning | true prevents acceptance of completed |
| rawResultRef | Optional private raw-output reference, inside the current Run and with a digest |
| commitSha | Must be absent from Worker results; only a Core-generated accepted result after commit may include it |

VerificationEvidence contains `id`, `kind` (command/manual), acceptance-item associations, request identity, before / after snapshotHash, time, result, and evidence references. Command evidence includes argv, repository-local cwd, exitCode, private stdout/stderr references, and content digests. Manual evidence includes an explicit acceptor and persistent confirmation. Worker-written logs remain claims, not trusted command records. `TaskExecutionResult` completed is only a completion candidate and may omit Worker verification claims; `AcceptedTaskExecutionResult` still requires Core-generated passing evidence and acceptance references, covering every required check before acceptance.

Core executes mandatory HARNESS / Task commands through controlled verification processes and creates trusted evidence. Manual requirements without user confirmation are blocked. Writable build artifacts must be declared in advance. Verification changes to source, plans, preexisting dirty files, index, or HEAD are rejected; do not simply ignore the entire .gitignore scope.

A controlled verification process and every descendant may not commit, perform external actions, or obtain unnecessary credentials. Core-launched code remains subject to authorization; a fixed argv does not guarantee script behavior. Stop automatic verification when the platform cannot enforce these boundaries, rather than labeling uncontrolled output trusted.

### ExecutorCapabilities

Retain the design's available, freshSession, structuredOutput, nonInteractive, cancellation, resumeRunWithFreshSession, pluginPackaging, and reasons; add evidence references, target host version, and enforceable permission boundaries through `authorizationEnforced`. Automatic runs require all six execution capabilities and authorizationEnforced; packaging is assessed separately.

freshSession requires host-verifiable session/thread/process identity, not merely two invocations. Authorization must be enforced through verifiable host permissions or controlled tool bridges; prompt-only prohibitions do not satisfy authorizationEnforced. When probes cannot prove this, retain manual Skill / packaging capability only; never silently fall back to uncontrolled Executors.

Persist raw logs, returning only runId, taskId, status, summary, verification summary, commitSha, nextTask, and logRef to the parent. Cancellation must terminate and wait for subprocess / handle quiescence before revalidation. Do not release locks before waiting for a Worker that can still write files.

## 4. Ownership, verification, and commits

### Snapshots and writable scope

Pre-execution snapshots contain canonical repoRoot / privateGitDir, branch, HEAD, complete index state, Dashboard / current Task / dependency archives, AGENTS / HARNESS / Git Workflow, protocol sources, Adapter configuration, and all preexisting changed content. Each path records type, mode, raw-content hash or symlink text, deleted status, and index blob/mode, including untracked files. git status alone is insufficient.

A Task Packet's `影响文件` list may suggest scope, but Core must freeze concrete files or explicit directory prefixes before execute. Entire repositories, private state, and Git metadata cannot be generic write scopes. Tasks modifying governance or verification contracts need explicit path authorization and a verification baseline independent of Worker's new versions. Worker cannot rewrite acceptance commands and then prove itself with the replacements.

MVP automatic execution rejects tasks whose write paths already contain user edits and rejects pre-staged content. Both block before dispatch for manual separation. Other preexisting edits may remain, but each path's content, type, and index must remain unchanged. Allowed paths are necessary but not sufficient: actual changes must also agree with Worker claims, controlled operation evidence, and persistent checkpoints.

"Preexisting user changes" are measured at Run creation. Changes from a preceding Task accepted by Core within this Run belong to the controlled accepted boundary, not user edits. In no-commit mode, later Tasks may modify Dashboard / archive indexes inherited from that accepted boundary while preserving pre-Run user content and checking for external drift between Tasks.

### Single-task execution and closure

1. Core holds the lock for precheck, selection, scope / verificationPlan freezing, snapshot capture, and persistent execute intent; only then does it dispatch Worker.
2. Worker changes and verifies only this Task. A successful candidate follows pinned upstream Planning to record evidence, move its packet, and update the archive index and Dashboard. Failure stops with an accurate result, without claiming another task.
3. Once Worker ends and the host is quiescent, Adapter fixes the result and ending boundary. Core independently validates identity, all actual changes, preexisting edits, and Planning deltas, then performs controlled acceptance.
4. Core accepts only the current Task's lifecycle delta: acceptance records, archive, appended index entry, removal from active rows / order, and at most five recent-completion summaries. Other tasks' status, priority, dependencies, and scope remain unchanged. Expanded planning requires needsPlanning and a stop.
5. Passing all gates enters FINALIZE. No-commit records the accepted worktree boundary; commit mode follows the next section. Finally, atomically update run.json accepted boundary / completedTasks, clear the finished pendingOperation, and reread Dashboard.

Core has no second Planning writer. Reader assesses preexisting project completion archives under §2; this Worker's archive also requires the independent verification in this section before counting as completed in this Run.

### Commits and external actions

RunAuthorization uses commit=deny or task, with push / pullRequest / tag / release / deploy all false. Default is `--no-commit`; `--commit-each` requires explicit authorization for this run. Conflicting flags are errors. Authorization binds the Run and never expands through resume, configuration changes, or Worker output.

Worker authorization always prohibits commits. Core's Git bridge reads frozen project Git Workflow, accepted commitIntent, and independent verification, stages exact paths individually with `git add -- <file>`, checks the actual staged set, then commits. Scope includes authorized current-task code, acceptance, and closure files, excluding preexisting user changes. Project policy governs commit format; Runtime supplies no default branch or message policy.

The Codex package's trusted Git policy currently understands only the default Chinese Conventional Commits convention from `dev-harness-git-workflow` in frozen `GIT_WORKFLOW.md`. Core supplies a Run-level commit-candidate marker and original Workflow digest to Worker. Worker remains `commit=deny`, returning only message, file set, and that digest in its completion candidate. Policy reads allowed types from Workflow, then validates a single Chinese commit subject ending in LF. Core's existing bridge still checks exact changes, accepted snapshots, and authorization before committing. Projects outside this closed template are explicitly rejected at commit time; Worker-reported messages are not Git authorization.

The bridge does not execute arbitrary Worker shell strings. A controlled implementation constructs argv, paths, and permitted actions. Stop when repository hooks or commit mechanisms change files, require extra external actions, or cannot be constrained; do not silently disable rules to bypass them.

Git bridging receives only capability needed for the currently authorized commit. Hooks and descendants may not use it to create extra commits, push, tag, release, deploy, or access unnecessary credentials. Block commit-each when isolation and proof are unavailable; originating in Core does not exempt a bridge from RunAuthorization.

After commit, verify the real Git object, unique parent, exact file set, current HEAD, tree, and remaining workspace. Reject Worker commits, mixed-in files, extra HEAD advances, or wrong parents. On failure preserve the scene; do not automatically reset, amend, unstage user content, or delete commits.

## 5. Run state, logs, and locks

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

run.json is the only authoritative state. Locks express exclusive ownership, not Task status. results / snapshots are evidence referenced by run.json, while summary is a rebuildable projection. Never find the "latest result" to override run.json.

RunState contains the design's schemaVersion, revision, runId, adapter, status, phase, currentTaskId, currentAttempt, completedTasks, authorization, createdAt, and updatedAt, plus repo identity, selectionMode, protocolSource, initialUserChangesRef/hash, acceptedSnapshotRef/hash, currentRequestId, resultRefs, stopReason, pendingOperation, and optional reconciliation records.

pendingOperation stores a unique operationId, kind (execute/verify/commit), before-boundary digest, expected identity / scope, and recoverable checkpoint references. Commit intent additionally stores parent, exact paths, expected tree, and message digest. It is a field inside run.json; do not create another journal.json capable of advancing state independently.

### State transitions

| Current state / event | New state | Condition |
|---|---|---|
| New Run created | CREATED | Authorization and repo identity fixed |
| precheck / execution starts | RUNNING | Lock and input validation pass |
| Leftover CREATED / RUNNING owner has terminated | INTERRUPTED | Acquire recovery exclusion, prove old owner and descendants quiescent, then record interruption with CAS; live or unidentified owners cannot be taken over |
| Worker blocked / acceptance needs manual input / no ready candidate | BLOCKED | Record reason and latest trusted checkpoint |
| Worker partial / user cancellation / process exit | INTERRUPTED | Preserve the scene without counting partial work as complete |
| Worker failed / invalid result / violation or corruption | FAILED | Stop automatic progression and retain evidence |
| Selected mode's tasks finish or queue is exhausted | COMPLETED | No unresolved operation; every completion claim accepted |
| BLOCKED / INTERRUPTED receives resume | RUNNING | Same authorization, environment, and trusted boundaries pass revalidation |

FAILED / COMPLETED cannot resume. Unresolved FAILED operations require explicit reconciliation under §6 before a new Run. BLOCKED / INTERRUPTED with external boundary changes cannot automatically absorb a new baseline either: reconcile explicitly, then create a new Run for the current project. resume does not restore a Conversation.

Phases are DISCOVERY → SELECT → SNAPSHOT → EXECUTE → REVALIDATE → FINALIZE. Non-completed results stop in the current phase; another task returns to SELECT only after accepted FINALIZE. precheck belongs to DISCOVERY. Trusted verify sub-operations are recorded within REVALIDATE rather than creating another phase state machine.

### Atomic writes and exclusion

All Runs in one worktree share `.orchestrator.lock/`. Lock metadata includes ownerToken, runId, pid, process-start identity when available, adapter, repoRoot, privateGitDir, and createdAt. Cross-process exclusion uses exclusive create / mkdir. run.json reads and writes verify ownerToken and expectedRevision; successful writes require a same-directory temporary file, flush, and atomic replacement.

PID or mtime alone cannot establish liveness. Stale recovery requires proof that the old owner terminated, descendants are quiescent, and no concurrent takeover exists. A separate exclusive guard serializes recovery, and all acquirers must honor it. Stop for manual disposition when owner identity, stale-guard safety, or an equivalent platform primitive cannot be proven; never blindly delete by timeout.

MVP crash-safe means process termination cannot make partial JSON valid state: an update leaves either a complete old version or a complete new one, stopping on unknown outcomes. Perform directory fsync when supported. Power-loss durability depends on OS and must be separately measured and declared; do not advertise uniform power-loss-safe transactions. Revision CAS prevents lost updates, not atomic transactions across Git and multifile plans.

## 6. Crash recovery protocol

resume first acquires the worktree lock, reads the sole run.json, and validates schema, authorization, repo identity, protocol / configuration, actual HEAD / index / files, and evidence hashes. Stop on out-of-directory references, invalid JSON, orphaned results, or unknown operations. Old DSH state is not an input to this process.

If disk state remains CREATED / RUNNING, prove the old process tree stopped and record INTERRUPTED under §5 before applying the table below. Never start a second Worker while an owner is still running.

| Crash location | Permitted automatic action | Mandatory stop condition |
|---|---|---|
| execute intent persisted, not yet dispatched | Create a new attempt and Session if current boundary still equals before | Current content includes unattributable changes |
| Worker executing, including multifile plan migration | Continue remaining current-Task work in a new Session only with trusted quiescent checkpoint, exact content digests, and pending intent | Only an allowed-path list or self-reported logs exist; incomplete archive ownership is unclear |
| Worker finished and result written, but not yet referenced by run.json | Revalidate and explicitly adopt candidate result if pending execute identity and ending boundary match | Any identity, hash, or actual boundary differs; never select by directory timestamp |
| Planning closed, Core verification unfinished | Keep current Task identity and rerun controlled read-only verification without repeating completed development | Required verification inputs changed externally |
| Verification passed, no-commit FINALIZE not persisted | Record accepted result if current boundary still matches trusted post-verification boundary | Changes occurred after verification |
| Commit intent persisted, staging interrupted | Continue commit bridging from the exact Core-recorded intermediate index state | Staged set or blob disagrees with intent; never clear the index automatically |
| Commit succeeded, state not yet updated | Adopt commitSha if HEAD is exactly one child of intent.parent, tree / paths / message match, and workspace agrees | Multiple candidates, merge, unknown HEAD, or no intent; duplicate commits are prohibited |
| Accepted state persisted, summary missing | Rebuild summary from run.json and referenced evidence, then continue SELECT or end | Referenced evidence is corrupt or missing |

Recovery never starts an old Conversation. Continued execution changes requestId, attempt, and Session identity, referencing accepted project and operation evidence. Normal execution uses one Session per Task; recovery of that Task may use a new attempt / Session.

MVP does not promise exactly-once arbitrary tool side effects. Authorization gates first prohibit external side effects that cannot be observed or proven; unknown local intermediate states preserve the scene and stop. Recovery must not weaken drift checks for availability.

### Unlocking after manual reconciliation

To prevent bypassing unaccepted archives through a new Run, explicit `dhr reconcile <run-id> --resolution <file>` validates and records manual reconciliation only. It does not execute Tasks, write Planning, restore old Conversations, or turn a failed Run into success.

A resolution includes target runId / original revision, the manually confirmed current project snapshot digest, disposition description, related Task IDs, and evidence references. Operators first repair or restore the project, then explicitly invoke the command. Worker environments reject it. Core holds the lock, checks the declaration against actual content, rereads affected plans, and verifies evidence within existing authorization. Retaining a current Task's completed archive additionally requires renewed acceptance; otherwise it must already be restored as an explicit active task. An unexplained archive cannot gain completion status from a note alone.

On success, original run.json records reconciliation (original pending identity, operator, current boundary, evidence digest, time) and marks the operation reconciled. Original status, failure reason, violation history, and completedTasks remain; failed execution is not retroactively accepted. The first new Run inheriting the reconciled baseline can be created only when current boundaries match and records its reconciliation source / digest. Under the lock, CAS first reserves a unique successorRunId in the original record, then creates that ID. Interrupted retries only finish the same ID; reconciliation cannot be consumed twice. Once established, the successor follows its accepted boundary and later normal boundary chain rather than requiring all future Runs to match the old reconciliation snapshot. Mismatching records, cycles, duplicate successors, unresolved operations, or unverifiable evidence continue to block execution. This refines recovery through K3-R / K4 rather than creating another Planning repair mechanism.

Recursion gates cover every `dhr run` mode, resume, and reconcile; all are rejected when `DEV_HARNESS_WORKER=1`.

## 7. Packager and build contracts

PluginPackager retains generate(input), validate(plugin, input), and pack(plugin, input). `PluginBuildInput` contains schemaVersion, platform, releaseVersion, adapterVersion, coreProtocolVersion, protocolSource, skills, runtimeBundle, adapterBundle, metadata, and buildTimestamp. Skills / bundles carry relative paths, SHA-256, and provenance. Metadata contains at least name, displayName, description, author, repository, and license-notice references.

GeneratedPlugin contains platform, adapterVersion, generated root, relative file inventory / hashes, and input digest. ValidationReport contains valid, checks (code, path, message, severity), input digest, and evidence references. Artifact contains platform, variant, version, coreProtocolVersion, relative file, mediaType, size, sha256, and generated-input digest; variant distinguishes multiple artifacts such as OpenCode npm / local.

Unavailable validation inputs, missing fields, path escapes, absolute local paths, duplicate Skills, unfinished markers, version mismatches, or missing artifact references all fail. pack accepts only directories matching the validation report digest; it cannot silently regenerate after validation.

dist/manifest.json summarizes releaseVersion, coreProtocolVersion, source commit, protocol source, Adapter compatibility mappings, and artifacts. It records artifact facts, not runtime capabilities. Capability matrices derive only from sourced test / probe evidence; unknown capabilities use false + reasons. Build success cannot establish freshSession.

PlatformAdapter has id, optional executor, packager, and doctor; duplicate IDs are rejected. Core depends only on shared interfaces, so a new platform does not modify Orchestrator. Platforms without executors can still build / validate / pack; doctor explicitly reports automatic execution unavailable.

## 8. CLI outcomes and acceptance examples

CLI exit codes: 0 means the requested mode ended normally; 2 means invalid arguments or unsupported input; 3 means blocked; 4 means execution, result, or verification failure; 5 means drift / ownership / authorization rejection; 130 means user cancellation. Persistent reason codes are more precise and cover at least PLAN_AMBIGUOUS, DEPENDENCY_UNRESOLVED, NO_READY_TASK, UNBORN_HEAD, CAPABILITY_MISSING, DRIFT_DETECTED, AUTHORIZATION_VIOLATION, INVALID_RESULT, STATE_CORRUPT, LOCK_OWNER_UNKNOWN, and PENDING_RECONCILIATION.

The following are required K1–K4 fixture semantics, not claims that these tests have already run:

| Input / event | Expected result |
|---|---|
| A, B, C are ordered, B depends on A, C on B; A closes and is accepted | B can be selected only after rereading; dependency evidence comes from A's archive; each task has an independent request / Session |
| Explicit selection is still planning or has a non-none blocker | BLOCKED, zero execute calls |
| Work order is empty while distant tasks remain | Normal queue exhaustion for this Run, without claiming the project complete |
| Work order has tasks with unfinished dependencies | BLOCKED without writing completedTasks |
| Status text is unchanged but dirty-file content changes | DRIFT_DETECTED |
| Worker returns completed with partial verification claims, needsPlanning=true, or missing closure | Reject completed; no commit or next task. Empty-claim candidates still require every check independently completed by Core |
| Worker changes another task's priority while archiving the current task | Reject Planning delta |
| HEAD advances in no-commit mode or Worker returns commitSha | AUTHORIZATION_VIOLATION |
| Request identity matches but result attempt / snapshotHash differs | INVALID_RESULT |
| Worker partial / cancellation with partial changes and no trusted checkpoint | INTERRUPTED; resume stops for manual reconciliation |
| Core is forcibly terminated with disk state still RUNNING | Prove original process tree quiescent, then CAS to INTERRUPTED; no parallel old owner |
| Worker archives A but Core acceptance fails, then a new Run attempts B | PENDING_RECONCILIATION; A is not historical completion; explicitly reconcile before rebuilding baseline |
| No-commit A is accepted and B subsequently edits Dashboard | Allow inherited accepted boundary within this Run; preserve all user changes from Run creation |
| Commit exists but run.json has not confirmed it, and intent uniquely matches actual Git | Accept the existing commit without duplication |
| Old DSH schema v5 state is passed to resume | Reject format / namespace, leaving original file bytes unchanged |

## 9. K1 executable protocol

The public implementation entry is [contracts](../packages/contracts/src/index.ts). TypeBox schemas own field definitions and TypeScript types derive through `Static`. The [JSON Schema directory](../packages/contracts/schemas/) contains same-source exports; `pnpm schemas:check` checks byte-for-byte equality. `pnpm schemas:write` updates exports after build. Schemas use draft-07. External validators must register the four formats below and perform relational checks; JSON Schema alone cannot establish the full contract.

| Parser name | Object and field definitions |
|---|---|
| `taskExecutionRequest`, `taskExecutionResult`, `acceptedTaskExecutionResult` | [execution.ts](../packages/contracts/src/execution.ts): requests, Worker results, and Core-accepted records; Worker results prohibit `commitSha`, allowed only in independent acceptance records |
| `verificationPlan`, `verificationEvidence`, `executorCapabilities` | Same file: command / manual checks, execution identity, acceptance IDs, before / after snapshots, and evidence; every true capability requires evidence references |
| `scope`, `runAuthorization`, `workerAuthorization`, `protocolSource` | [common.ts](../packages/contracts/src/common.ts): exact files / directories, four current-task closure paths, Run authorization, and pinned protocol sources |
| `snapshot`, `runState`, `lockMetadata`, `reconciliationResolution` | [state.ts](../packages/contracts/src/state.ts): project content, unique Run state, lock-owner metadata, and manual reconciliation inputs |
| `pluginBuildInput`, `generatedPlugin`, `validationReport`, `artifact`, `releaseManifest`, `hostEnvironment`, `adapterDoctorResult` | [packaging.ts](../packages/contracts/src/packaging.ts): build sources, Skill / bundle digests, license references, versions, doctor, and platform artifacts |

`parseContract(name, unknown)` performs strict structural and single-record relational validation and returns the corresponding type. It does not coerce values, fill defaults, or remove unknown fields. `parseContractJson` additionally handles JSON syntax failures. Errors use `ContractValidationError`, with `code`, message, and structural `issues[{path,message}]`. Unknown versions, missing fields, illegal paths, and single-record relationship errors yield `INVALID_CONTRACT`. Only schemaVersion / coreProtocolVersion 1 is supported; old DSH schemas are not converted.

Actual formats are implemented in [validation.ts](../packages/contracts/src/validation.ts): `repo-path` is a nonempty relative POSIX path, rejecting empty segments, `.` / `..`, backslashes, colons, control characters, Windows device names, and trailing-space / dot aliases. `absolute-path` accepts absolute POSIX and Windows drive / UNC paths, rejecting dot segments and control characters. `utc-timestamp` requires `Z`, a valid Gregorian date, and seconds or 1–3 millisecond digits. `semver` requires full SemVer, supports prerelease / build, and rejects floating versions. Project paths and Run evidence references share `repo-path` lexical rules; callers determine roots. In-memory requests and repo-locating `repoIdentity` fields permit absolute paths; portable artifacts do not permit absolute local paths.

`Snapshot.paths` distinguishes file (rawContentHash, 100644 / 100755), symlink (original target text, 120000), gitlink (commit, 160000), and missing (deleted=true, mode=null). Each `index` records stage / blob / mode; an empty array means no entry. Stage 0 cannot coexist with conflict stages. Snapshots also reference digests of governance files / Planning, protocol sources, and adapterConfigHash. Object IDs allow SHA-1 / SHA-256 shapes; K3 checks actual object existence and snapshot completeness.

`RunState` distinguishes initialUserChanges and acceptedSnapshot references / digests. currentTaskId / currentAttempt / currentRequestId are all present or all absent. `resultRefs` uses `{identity,ref}`. pendingOperation distinguishes execute / verify / commit, with parent, paths, expectedTree, and messageHash for commits. reconciliation retains original execution identity and a unique successor reservation; successor Runs record reconciledFrom. Static checks validate identity, time, and digest consistency within a record. K3-L / K3-R still implement locks, CAS, cross-record uniqueness, historical transitions, and crash recovery. Run layout remains `$(git rev-parse --git-path dev-harness-runtime)/runs/<run-id>/run.json`, with no second state-file type.

[validateResultForRequest](../packages/contracts/src/binding.ts) binds result and request runId / taskId / attempt / requestId / snapshotHash and checks declared paths, acceptance IDs, command argv / cwd, complete evidence coverage, and four-path current-task closure. `completed` requires all passed checks and closure; the other three outcomes require reason and may supply only executed checks. Invalid results yield `INVALID_RESULT`; excessive declared scope or Worker commitSha yields `AUTHORIZATION_VIOLATION`. A mismatching `assertSnapshotHash` boundary digest yields `DRIFT_DETECTED`. Missing `requireExecutionCapabilities` execution capabilities yields `CAPABILITY_MISSING`; pluginPackaging is not an execution gate.

These APIs validate declarations. Core must independently verify evidence-reference SHA-256, actual controlled execution, command boundaries, symlink / realpath, preexisting user edits, real HEAD / index, and Planning deltas. Parsing does not grant commit capability or enable Executors. `AcceptedTaskExecutionResult` is also a data type; parsing it cannot create trusted acceptance authority.

[interfaces.ts](../packages/contracts/src/interfaces.ts) fixes TaskExecutor / PluginPackager / PlatformAdapter / Registry interfaces. Executor cancellation uses AbortSignal and may reject with AbortError only after execution-tree quiescence. Shared [Executor Contract Tests](../tests/contract/executor-contract.mjs) reuse scenarios through an injectable harness; current interface evidence comes only from Fake Executor. Packager validate / pack both explicitly receive original build input to preserve input-digest binding. pack must use a successfully validated, unchanged directory; K10-B validates actual digests and artifacts.

## 10. K2 project and Planning reader implementation

[Core](../packages/core/src/index.ts) provides `discoverProject(cwd, options)`, `readPlan(project)`, and `selectTask(plan, selection)`. Discovery uses actual Git to resolve repoRoot, privateGitDir, HEAD, and `--git-path dev-harness-runtime` for main repositories and linked worktrees. It only reads and creates no state directories. Explicit docsRoot wins; competing roots are resolved first through governance links, then unique Dashboard ownership, otherwise rejected. doctor may return missing-HEAD / project-contract issues without making the project executable.

HARNESS reads confirmed commands from tables under `已确认命令（人工维护）` by column names, requiring at least one test / quick / bugfix / full command. Duplicate columns or purposes, nested tables, and hidden HTML are rejected. Candidate commands gain no execution eligibility. Old single-value lists do not automatically qualify. Errors explain the `用途 / 命令 / 状态` columns and `dev-harness-commands` migration entry. Context refresh preserves the manual confirmation area and cannot confirm commands. Reading returns command text only; K4-V reuses this parser to freeze sources, check literal argv, and verify independently in controlled processes.

Planning uses [markdown-it structural tokens](https://markdown-it.github.io/markdown-it/documents/Architecture.html), pinned to 15.0.2. It reads tables and top-level ordered lists only in the relevant sections and maps fields by headers. Escaped pipes remain cell content; example tasks in code blocks or ordinary paragraphs do not form work order. Raw table rows are also checked for column counts so parser padding / truncation cannot hide bad input. Individual Planning Markdown files are limited to 2 MB; oversized input is explicitly rejected, not truncated before selection.

`readPlan` returns `order`, `tasks`, and current `references[{path,sha256}]`. A Task Packet's title must match its ID. It checks background, four execution-context inputs, scope, affected files, acceptance checkboxes, verification methods, and stop-condition sections. Missing items set contextComplete=false and block selection. Structural checks do not establish correct requirements or satisfaction of all execution prerequisites.

Archive lookup reads only indexes and snapshots / evidence referenced for dependency IDs; it does not preload unrelated historical Task bodies. First closure uses ID.md; later closures require contiguous `关闭次数` counts and nondecreasing dates, with `前次` linking the immediately preceding snapshot and the body linking it too. Multiple milestones claiming the same ID remain ambiguous and require project resolution. Dependencies still in the active table remain incomplete regardless of old archives. Digests of original index, relevant closure records, and evidence bytes enter references.

Selection returns selected / blocked / completed(queueExhausted). Missing explicit Tasks throw `PlanningError` / TASK_NOT_FOUND. Corrupt structure, missing files, blank blockers, unknown status, or missing ready-order items throw errors with code, path, and line when available. A nonempty blocker outside the `无` rule returns blocked. all-ready selects only one Task at a time; callers reread after acceptance rather than caching a whole batch for execution.

Relative Markdown references differ from K1 persistent-path fields: `../` is allowed, but normalization and realpath must remain inside the actual repository. Reject URLs, queries, fragments, backslashes, control characters, and case aliases. Check existing symlinks segment by segment to prevent escape reads. These are read-time checks. K3 owns concurrent startup drift and complete content snapshots; K3-R / K4 jointly gate unaccepted Run archives and pendingOperations.

## 11. K3 content snapshots and drift-gate implementation

`captureSnapshot` receives K2 ProjectContext, the current Task, PlanningReference, protocol sources, and Adapter configuration digest, then rereads actual Git and file bytes. It creates no Run state. `serializeSnapshot` defines stable persistent JSON bytes and a final newline; `hash` takes SHA-256 of the whole record. `snapshotBoundaryHash` excludes only capturedAt for repeated-capture comparison.

Snapshots add mandatory indexFingerprint, indexFlags, dirtyPaths, and stagedPaths. indexFingerprint binds all stage / blob / mode entries, assume-unchanged / skip-worktree flags, and raw staged diff, without relying on mutable index stat caches. Dirty / staged classification is part of the digest-protected Snapshot; outer compatibility arrays must agree. Coverage includes tracked, untracked, ignored, deleted, mode-changed paths, original symlink targets, and gitlinks. Dirty or uninitialized submodules explicitly block capture; one commit cannot represent internal modifications.

File rawContentHash always hashes original bytes. To determine worktree changes, Core passes captured bytes, effective attributes, and original index blobs to an isolated temporary Git repository, allowing Git itself to handle text / eol / autocrlf / ident / working-tree-encoding. It neither rewrites the project nor runs external filters. Configured external content filters yield UNSUPPORTED_PROJECT_FILTER. Conversion follows [Git hash-object](https://git-scm.com/docs/git-hash-object) and [Git v2.43.0 convert.c](https://github.com/git/git/blob/v2.43.0/convert.c), with real Git positive / negative cases for LF/CRLF and UTF-16LE.

Before and after capture, check Git identity, index, path inventory, and conversion settings; check each file's identity and stat before / after opening, and recheck every observation before completion. Changes during reads yield DRIFT_DETECTED. This is not an atomic filesystem snapshot and cannot guarantee detection of transient changes fully restored between observations. Execution locking is in §12, independent verification isolation in §14; host Worker isolation is proven by its Adapter.

`assertUnchanged` compares complete boundaries. `assertTaskStart` blocks pre-staged content, overlap between scope and initial user edits, and drift in initial edits. `verifyOwnedTransition` restricts code scope and the current Task's four Planning closure paths, protects initial user content, and rejects unauthorized HEAD / index / branch changes. Resolve new symlinks segment by segment; they cannot point outside the repository or into Git-private directories. Even allowed paths must pass Core's `verifyOwnership` callback, which validates trusted operation records binding runId / taskId / beforeHash / afterHash / actual paths. Worker changedFiles and self-generated digests are not evidence. K4-V connects persistent operation evidence and independent verification; K3 callback tests establish only these interface gates.

`verifyAuthorizedCommit` read-only validates an existing commit: authorization, full snapshot digest, actual current HEAD / branch / index, unique parent, expected tree, original messageHash, exact file set, and post-commit content must all agree. Git replace refs are ignored. It executes no commit, hook, or publication. no-commit rejects HEAD advancement. K4 integrates these APIs with K3-L / K3-R locking, state, and recovery into shared orchestration.

## 12. K3-L private storage and exclusion implementation

Core `acquireLock` / `withLock` / `releaseLock` / `inspectLock` use `.orchestrator.lock/` in each worktree's private state root. Acquisition, release, and locked reads / writes all honor exclusive `.orchestrator.guard/`. A process-local WeakMap registers handles; serialized or fabricated objects are not valid handles. Operations and release on one handle are queued. Every operation rechecks repoRoot / privateGitDir / stateRoot with Git and validates directories, permissions, and on-disk ownerToken; publication rechecks ownership again.

Linux distinguishes process identity through boot ID and start ticks in `/proc/<pid>/stat`, following [Linux proc documentation](https://www.kernel.org/doc/html/v6.15/filesystems/proc.html). This identifies only the current owner. A disappeared PID, missing identity, corrupt metadata, or leftover guard cannot prove old descendant quiescence. Current implementation returns LOCK_OWNER_UNKNOWN and preserves the scene rather than automatically reclaiming stale locks. Other platforms may use exclusive-directory primitives but likewise report unknown without start identity; PID and age are not substitute evidence.

`createRun` creates only a new Run directory and CREATED / DISCOVERY / revision=0 record. `readRunAtRevision` and `compareAndSwapRun` explicitly identify target runId and expectedRevision. CAS increments by one only, rejecting overflow, backward time, and changes to creation identity / authorization / protocol / initial user boundaries. RunState.repoIdentity records creation identity; later Git HEAD comes from acceptedSnapshot. One worktree lock may access several explicitly identified Runs in that worktree so K3-R can record reconciliation sources and a unique successor under one lock. Lock metadata runId identifies the orchestrator rather than creating second Run state.

The authoritative record remains `<run-id>/run.json`. Writes exclusively create a same-directory temporary file, fully write and sync it, revalidate owner and target / temporary identities, then publish the complete file. Updates use rename; initial publication uses a non-overwriting link, then removes the temporary link. Directory fsync is used when supported. [Node 24.15 FileHandle.sync](https://nodejs.org/download/release/v24.15.0/docs/api/fs.html#filehandlesync) depends on OS and device; process-exit tests do not prove power-loss guarantees. Partial temporary files are not recovery state. An exception after initial linking but before temporary-link removal safely stops on a nonunique inode and requires scene verification.

`createAttempt` creates logs and snapshots under attempts. `writeResult` / `writeSnapshot` publish non-overwritable evidence for the current attempt; SHA-256 references hash exact persistent bytes. `readEvidence` constrains paths to the Run, rechecks digests, and rejects symlink / hard-link aliases and path case aliases. `writeSummary` derives only from run.json at a specified revision and accepts no caller-reported completion state.

Storage does not treat valid schemas or evidence files as proof of Task completion. It neither runs the recovery state machine nor automatically adopts unreferenced result files. K3-R / K4 own cross-record consistency of provenance, transitions, initial boundaries, and pending operations. File and directory checks target local filesystems and Core instances honoring the same lock protocol; real Worker private-state isolation still requires Adapter verification.

## 13. K3-R recovery and explicit reconciliation implementation

`initializeRun` verifies the actual initial snapshot, writes Run-level initial evidence and an initialization intent containing only seedHash / references, then creates the unique run.json. `resumeRunInitialization` finishes only a definite interrupted window for that same intent. Existing Runs return their current revision without overwriting progress. `readCurrentRun` and `listRunIds` provide locked diagnostics; every write still requires explicit expectedRevision. Initialization evidence lives in results/run-evidence, without fabricated Task / attempt identity or a second state store.

`resumeRun` rechecks current authorization, Adapter, configuration, and protocol; validates referenced bytes and actual snapshots; and uses trusted Core verifiers for quiescence, checkpoint provenance, and independent acceptance. Missing verifiers stop recovery. Pure `decideRecovery` classifies only and does not authorize persistent transitions. execute / verify / commit use their own before boundaries, with the original request snapshot independently checked. Recovery creates a new attempt / requestId. Continuation from an execution checkpoint uses a new execute-intent binding the previous record, never an old Session.

Recovery may return reexecution, reacceptance after adoption of a verified Worker result, recording an already-accepted result, return to Core's commit bridge, or stop. Existing commits are adopted only if parent / tree / message / paths and current boundaries match frozen intent and independent acceptance holds; recovery APIs do not commit. Deterministically named recovery evidence can be reused exactly after interruption before CAS, never by guessing the latest file from directory times.

`reconcileRun` verifies explicit resolutions and current Planning / content. Retained archives require independent acceptance again. It records reconciliation only, preserving original failure status, pending history, and completedTasks without writing Planning. `assertNewRunAllowed` blocks unresolved operations, unaccepted archives, unknown initialization windows, and unconsumed reconciliations. `createReconciledSuccessor` first reserves a unique successor through CAS, then creates that ID, validates reciprocal bindings and absence of cycles, and prevents completed history from permanently constraining later normal commits.

K4 connects these interfaces to trusted CLI service entry points; the production Adapter is not yet implemented in this recorded statement. K4-V implements recovery verification for the independent-acceptance evidence chain, while Adapters still prove Worker provenance and quiescence. Fixture callbacks are not host capability evidence. See [RECOVERY](RECOVERY.en.md) for operations.

## 14. K4-V independent acceptance and controlled commit implementation

Before dispatch, `freezeAcceptanceInputs` pins original Task acceptance text, HARNESS confirmed commands, Git Workflow, Planning, and verificationPlan.sources bytes / digests. Acceptance IDs must cover every original criterion; literal argv rejects shell expansion. Direct repository file entries, package-manager package.json, and identifiable direct script entries must be sources. Trusted Core orchestration explicitly includes dynamic imports, complex shell, recursive scripts, and test-configuration dependencies in the full verification baseline. Current implementation does not infer them automatically; Worker declarations cannot supply that baseline.

`verifyTaskAcceptance` revalidates result identity, all file changes, initial user content, current boundaries, and Planning lifecycle. `validatePlanningDelta` permits only current-task closure, equivalent moved links, archive-index additions, and the most recent five summaries. Other tasks' status, priority, dependencies, execution order, and original acceptance text remain unchanged, including supplementary explanation tables. Worker control verifiers must check actual host-control evidence binding current identity and before / after boundaries. Missing proof of permissions or quiescence rejects acceptance.

Linux providers run verification commands in independent user / PID / mount / network / IPC / UTS / cgroup namespaces. The project is copied as a read-only mirror, fully matched against the snapshot, then overlaid with frozen verification sources. Host HOME, Git-private directories, credential environments, and WSL entry points are not exposed. Only explicitly declared existing artifact directories are writable. Initial user edits, source, Planning, verification sources, and tracked files cannot be artifacts. Artifacts enter later accepted snapshots but not this Task's commit set. This capability has only been tested in WSL2; unsupported inputs such as submodules, external links, and special files are explicitly rejected.

Providers use pinned native bubblewrap / Python executable digests, a pidfd bound to namespace init, two execution gates, and monitor waiting to prove ending. Cancellation, timeout, or unproven descendant quiescence rejects success. Control-process exit or pipe EOF does not release project commands. Mounts use fixed directory descriptors, which are closed before executing commands. Implementation follows [Bubblewrap](https://github.com/containers/bubblewrap) and pinned [v0.9.0 source](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c); it is not an isolation promise for arbitrary arguments or other hosts.

Provider trust-check failures report actual path, owner UID, current UID, and permissions. Parent user namespaces may map root ownership to unmapped UID 65534; do not modify host permissions or relax checks merely because of that mapping. Codex's outer namespace already mounts `/usr` read-only. After checking canonical paths, file type, and permissions, bridge sources reuse this mount rather than remounting system tools within `/usr`. Standalone entry points still use explicit private target mounts.

Core records actual command stdout / stderr, exit code, identity, time, before / after snapshots, and isolation evidence. Mandatory manual acceptance comes only from an external user-confirmation service; Worker confirmation text is invalid. Once all checks pass, issue a one-use process-local capability bound to current lock handle / revision. Serialized objects cannot gain commit authority. `finalizeWithoutCommit` rechecks boundaries before advancing the Run; task authorization must instead use the commit bridge.

`commitAcceptedTask` uses a trusted project policy to read frozen Git Workflow and provide exact message / paths; it does not supply default project policy. The bridge checks native Git, effective configuration, hooks, signing, and external helpers. Projects requiring uncontrolled hooks / filters / signing are rejected rather than silently disabling their rules. Temporary index / object directories predict the tree; persist `commit-ready`, stage exact files, check staged set and tree, persist `index-staged`, create one actual commit, then verify parent / tree / message / content / HEAD. Failure preserves the scene. It never performs push / PR / tag / release / deploy.

`createAcceptanceRecoveryVerifier` reconstructs frozen inputs, Worker control, Planning, command output, and snapshot chains from exact pending references and independently accepts recovery. Core private evidence storage and Adapter trusted control verification remain trust boundaries; file existence or hash shape alone grants no authority. Commit and no-commit accepted evidence use the same deterministic names and stable times, allowing exact reuse after interruption before CAS without repeating commits or Task completion. An unstaged `commit-ready` must reference identical before / after boundaries.

This task verifies Linux verification processes, actual local Git, and Core interfaces. Worker control / manual confirmation use explicitly identified interface fixtures. K5 / K6 separately test real Codex / DSH Worker permissions, Session, and credential boundaries; passing this task does not establish those hosts' availability. See [K4-V verification](verification/K4-V.md).

## 15. K4-W shared Worker and parent-context implementation

Shared Skill source consists only of [run](../skills/run/SKILL.md), [status](../skills/status/SKILL.md), and [worker](../skills/worker/SKILL.md). Platform packages transform paths, invocation syntax, and manifest metadata only, without copying selection, authorization, or closure rules. Skills dispatch through the shared CLI. Missing entry points or host capability stop explicitly rather than falling back to manual execution in the parent conversation.

`prepareWorkerInvocation` accepts a validated TaskExecutionRequest and trusted-Bundle Worker Skill bytes / digest, producing a fixed request and four environment markers. Its prompt specifically references AGENTS, HARNESS, Dashboard, and the current Task, with structured scope / verificationPlan. It accepts neither old Conversations nor arbitrary additional environments. JSON backticks and marker characters are escaped so data cannot close the request block. Skill size is limited to 64 KiB and request data to 128 KiB. Oversized input is rejected, never truncated while dropping authorization or acceptance fields.

Before parsing run modes, CLI checks Worker markers. Under `DEV_HARNESS_WORKER=1`, every run, resume, and reconcile is rejected with AUTHORIZATION_VIOLATION / exit 5, including explicit Tasks, missing arguments, and unknown modes. help / version remain readable. K4 connects doctor / status and execution commands to trusted services. Core also rejects Workers creating another Worker invocation. Environment markers gate recursion; they do not replace OS / host permission evidence from Adapters.

`appendAttemptLog` permits only Core, under the lock, at the same revision and current RUNNING / EXECUTE identity, to append raw bytes to existing stdout.log / stderr.log / events.jsonl. Chunks are at most 1 MiB, without truncating total logs. Inputs are immediately copied; appends are serialized and check directories, file identity, unique hard links, and owner, then fsync. Partial output left by interruption remains inspectable but does not prove Task completion. Worker cannot write these paths.

`captureAttemptLogRefs` streams complete log digests for current identity or historical identities in the Run's exact resultRefs. Missing files, symlink / hardlink aliases, path drift, or wrong requestId fail. Read access to historical logs does not grant append authority, and log operations do not update run.json.

`readParentContext` reads run.json at a specified revision and its exact references, returning eight fields: runId, taskId, status, summary, verificationSummary, commitSha, nextTask, and logRef. verificationSummary counts only Core-accepted records. summary uses Core status text without echoing Worker summary / reason, source, commands, logs, or JSONL. logRef contains the three verified private stdout / stderr / events EvidenceRefs, or null when no Task exists. nextTask is currently null; later Orchestrator code may report it only after rereading Planning and selecting a task. summary.json and Worker completed claims cannot change parent-context state.

This task supplies interfaces and shared source without starting a real host. Reproducible results are in [K4-W verification](verification/K4-W.md).

## 16. K4 serial orchestration and CLI

`startRuntimeRun` accepts only explicitly registered trusted `RuntimeServices`. It probes execution capability, validates the project and new-Run gates, then initializes an actual snapshot under the lock. Each loop rereads Dashboard within accepted boundaries. The preparer explicitly provides single-Task scope, original acceptance, and complete verification sources. Core validates the request, freezes inputs, saves dispatch evidence and pending execute, then calls Executor. The initial pending operation itself is execution intent; `execute-intent` checkpoints are reserved for recovery links to a previous attempt. Frozen inputs are not fabricated predecessor execution checkpoints.

After Worker ends, first prove quiescence, then save result, actual ending snapshot, and control evidence. completed still requires K4-V independent acceptance. blocked / failed / partial stop as BLOCKED / FAILED / INTERRUPTED respectively. Only accepted completion permits rereading and continuation. no-commit inherits the accepted boundary within the same Run while protecting initial user edits throughout. Unresolved pending operations and unaccepted archives prevent bypass through another Run.

`resumeRuntimeRun` rechecks original authorization and environment, then follows existing recovery decisions to execute a new Session, reaccept ended results, or continue a frozen commit. verification-passed and commit-ready / index-staged use `resumeAcceptedTaskCommit` to revalidate the original chain and continue original message / paths / tree. Existing real commits use adoption. Cancellation is checked at execution and commit entry; started Git operations preserve recoverable boundaries. Unproven Worker or independent-acceptance namespace quiescence retains locks and the scene. Evidence for one process class cannot prove quiescence of another.

`inspectRun` / `inspectParentContext` perform lock-free consistent reads from the only run.json, validating reference digests, worktree identity, and authoritative bytes before / after reading. Log growth within one revision also reports an explicit retry. Status creates no directories, requires no execution lock, and writes no summary.json. Output remains the compact eight-field projection.

CLI provides doctor, status, run (--task / --next / --all-ready), resume, and reconcile. Conflicting arguments or unknown Adapters exit 2; blocked exits 3; execution / acceptance failure and partial exit 4; drift / authorization / exclusion rejection exits 5; cancellation exits 130. Default is no commit. --commit-each / --no-commit are mutually exclusive with --commit task|deny. Without expected revision, resume reads the current value and passes it to Core CAS without changing Run authorization. reconcile accepts only explicit resolution references already persisted by trusted Core; user JSON is not verified consent or evidence.

The generic standalone CLI runs read-only doctor / status; execution commands return CAPABILITY_MISSING without explicit host-Executor injection. The Codex plugin launcher assembles services from pinned packaged sources, while actual Task dispatch remains subject to independent K5 acceptance. Tests use an explicitly injected Fake Executor with the same Core; real Git, Planning closure, and bubblewrap acceptance establish the shared flow, not Codex / DSH capabilities. CLI bundles Core and dependencies through fixed esbuild into ESM; the standalone tarball is installed offline with an empty store and actually tests project discovery and Markdown reading. See [K4](verification/K4.md).

## 17. K10-B shared packaging pipeline

`PlatformRegistry` is the explicit platform Registry shared by execution and packaging. Default codex, dsh, cursor, opencode, antigravity, and agent-plugin entries contain ID metadata only; capabilities are added only through trusted-caller injection of `RuntimeAdapter` or `PluginPackager`. CLI `dhr build|validate|pack --adapter ID` uses the same instance. Its project path must equal the BuildPipeline root. Unknown IDs yield UNKNOWN_ADAPTER; known IDs without Packagers yield CAPABILITY_MISSING. Environment and project files cannot inject executable code.

`BuildPipeline` stage dependencies are strictly compiled bundle → `generate` → `validate` → `pack`. No stage implicitly runs its predecessor. Inputs first pass strict `PluginBuildInput` schemas and relational checks, and protocol fields exactly match `protocol-lock.json`. Actual upstream checkout HEAD, cleanliness, and each locked file are verified. Repository Skills, bundles, and distribution notices are checked by actual SHA-256. Shared metadata must equal values from `build/manifests/metadata.json` and actual notice files. Explicit build time enters archives rather than the current clock. Uncommitted local inputs are marked `localUnversioned` and cannot be represented as distributable releases.

Generation records bind complete inputs, source commits, protocol-lock digests, specification digests, and directory-file digests. Shared static checks cover all ten items from design §29 using explicit closed JSON schemas, exact file allowlists, Skill frontmatter, version fields, and reference fields. Each Packager validates platform-specific formats. After trusted Packager callbacks, sources are checked again; validate / pack also recheck the generated tree. Reports are persisted only when actual directories agree with generation records. Per-platform stage locks prevent concurrent deletion; a root manifest lock serializes cross-platform merges, and crash-leftover locks are not automatically deleted. `pack` reads only passing validation records, rechecks original trees and every artifact's file, size, and SHA-256 after packaging, then writes `dist/manifest.json` and local build evidence. Platform-build success does not establish host execution, installation smoke, or external distribution permission. See [packaging documentation](PACKAGING.en.md) for deterministic ZIP / USTAR gzip and golden-update rules, and [K10-B](verification/K10-B.md) for focused records.
