# DSH shared-behavior migration boundaries

[English](DSH_MIGRATION.en.md) | [简体中文](DSH_MIGRATION.md)

This document defines `dev-harness-runtime`'s DSH adapter scope, shared Core behavior, and compatibility boundaries; it does not track development progress. See [CONTRACTS](CONTRACTS.en.md) for the public protocol, [public contract decisions](decisions/runtime-contracts.md) for rationale, and the [Dashboard](plan/Dashboard.md) for task entry points.

## 1. Confirmed scope

Runtime executes work through the Planning Task model; shared Core owns common execution mechanisms. Audit → Router → Auto Fix → Full Verification → QA → Final Reconciliation → Report is not a built-in automatic pipeline.

Runtime does not read or automatically convert historical Runs. Old Run schema v5 is not an early version of new protocol v1. There is no in-place overwrite, continuation after copying a directory, or automatic import.

The new DSH Adapter targets host `0.2.0-rc.2`, based on the local desktop runtime's reported bundle version and dependency declarations of `@deepseek-ai/dsh@0.2.0-rc.2` in the official registry. Old `0.1.5-rc.1` and `0.1.0-rc.8` are used only for historical behavior comparison. Public APIs, component dependencies, installation, and execution capabilities must obtain fresh evidence on the new target version.

The historical source baseline is commit `cb53f228246a39ef8fd2ebcf372b60e0f1cffbf6`. Old entry points and test names below are historical records from that baseline, not a requirement to retain an external source checkout. Current implementation and tests are owned by this repository. The selected old tests passed 36/36 and corresponding new Core checks passed 216/216 with real bubblewrap, with no skips. These still do not substitute for DSH rc.1 Executor equivalence evidence. See [current K6 verification](verification/K6.md).

## 2. Shared behavior mapping

| Shared behavior | Historical implementation entry (record) | Current implementation owner | Property to preserve and prove |
|---|---|---|---|
| State schema and revision CAS | `state.ts`: parseRunState, readStateFile, writeStateFile, updateRun | Core state; K1 / K3-L | Reject unknown schemas; revision conflicts cannot overwrite newer state; reads reject partial JSON |
| Worktree identity and exclusion | state.ts: captureRepositoryIdentity, resolveStateRoot, createRun | Core discovery / lock; K2 / K3-L | Isolate main-repository and linked-worktree state; at most one owner per worktree |
| Content snapshots and drift checks | state.ts: fingerprintWorktree, captureWorktreeBoundary, captureContextFingerprint, captureDependencies, validateResume | Core snapshot / recovery; K3 / K3-R | Never silently adopt changes to HEAD, index, existing edits, governance documents, or dependencies; add Planning and Executor input snapshots |
| Exact change boundaries | state.ts: diffWorktreeBoundaries, adoptWorktreeBoundary | Core snapshot / result; K3 / K4-V | Actual changes, allowed scope, and trusted operation evidence agree; changedFiles alone is insufficient |
| Immutable Run authorization | `authorization.ts`: createRunAuthorization, assertExternalActionAuthorized; state.ts: assertImmutable | Core authorization; K4-V | Default no-commit, independent denial of external actions, and no permission expansion on resume |
| Independent commit verification | state.ts: adoptCommitBoundary; `orchestrator.ts`: assertCommittedAutoFixWorkspace | Core Git bridge and result; K4-V | Exact parent, tree, paths, HEAD, and workspace boundaries; new protocol commits through Core after independent verification |
| Persisted intent before dispatch | orchestrator.ts: advanceAuditRun, advanceRemediationRun, advanceFullVerification | Core orchestrator / recovery; K3-R / K4 | Persist identity and scope before side effects; recovery never guesses unknown intermediate state |
| Verification identity and quiescence boundaries | `verification.ts`: validateFullVerificationObservation; orchestrator.ts: assertMonotonicVerification, assertReadOnlyVerificationWorkspace | Core result / verification; K4-V | Trusted commands come from project HARNESS; results bind exact snapshots; verification cannot change unauthorized project content |
| Summaries derived from authoritative evidence | `report.ts`: createRunSummary, validateRunSummary, assertRunSummaryMatchesState | Core result / summary; K4-W / K4 | Do not return entire conversations; do not allow success without evidence; summaries reference real persistent records |

These mappings reuse behavioral properties and test ideas, not the old files directly. New Core does not import `@deepseek-ai/dsh-*`. Useful old primitives must be extracted behind host-independent interfaces or replaced with cross-platform implementations that prove the same properties.

## 3. Test comparison checklist

| Comparison target | Historical test record | Current verification entry and additional differences |
|---|---|---|
| CAS and state transitions | `state.test.mjs`: `serializes revision updates and enforces phase and terminal transitions` | packages/core/tests/state; use new Task phase/status rather than copying old enums |
| Invalid state and conflicts | state.test.mjs: `rejects duplicate active runs, invalid ids, corrupt state, and symlink state files` | packages/core/tests/state, lock; add owner identity and controlled stale recovery |
| Linked-worktree isolation | state.test.mjs: `isolates primary and linked worktree run namespaces` | packages/core/tests/state; new state root and run.json layout |
| HEAD / workspace / dependency drift | state.test.mjs: `fails closed on worktree, HEAD, lockfile, and runtime dependency drift` | packages/core/tests/snapshot, recovery; add Dashboard, Task, archive dependencies, and protocol sources |
| Explicit document-change boundary | state.test.mjs: `accepts one explicit docs mutation boundary without weakening later drift checks` | packages/core/tests/snapshot; allow only current-task closure, leaving other task rows unchanged |
| Default authorization and denied expansion | `authorization.test.mjs`: `defaults to fix-only and maps only explicit commit-each to commit mode`; `rejects implicit expansion and every independently authorized external action` | packages/core/tests/authorization; align new no-commit / commit-each semantics and narrower Worker authorization |
| Out-of-scope change rejection | `remediation.test.mjs`: `rejects undeclared changes and retains the open mutation lease` | packages/core/tests/result; preserve the failure scene and pending intent |
| Commit exactness | remediation.test.mjs: `rejects a downstream commit containing undeclared files and retains its lease` | packages/core/tests/authorization; Core bridge scope validation and rejection of illegal Worker commits |
| Reentry after downstream crash | `orchestrator.test.mjs`: `an OPEN Audit lease recovers after the Adapter wrote outputs and crashed`; remediation.test.mjs: `recovers an idempotent start after the Adapter wrote a fix and crashed` | packages/core/tests/recovery; new Tasks use new attempts / Sessions, without inheriting old Conversations |
| Verification evidence validity | `verification-contract.test.mjs`: `requires the canonical full command, exact snapshot identity, and fresh terminal evidence` | tests/contract; commands come from target HARNESS rather than a hard-coded npm run harness:full |
| Verification workspace boundary | `verification.test.mjs`: `rejects verification worktree mutations and retains the OPEN lease` | packages/core/tests/result; explicitly allow artifacts while rejecting source, plan, and index changes |
| Inconsistent success claims | `report.test.mjs`: `refuses incomplete QA, verification, reconciliation, and inconsistent overall claims` | packages/core/tests/result; use Task acceptance + Planning closure instead of old QA / Finding fields |

This table records each preserved property, old entry, new location, and model difference. Old / new test counts and subsequent rc.1 host Task Executor parity are recorded separately in [K6 verification](verification/K6.md). Old test counts do not transfer to the new Adapter. The new host separately executed a synthetic A→B→C dependency chain with an unmodified Worker Skill, three independent Sessions, and three Core-controlled commits.

## 4. Host logic retained in the Adapter

- Cordis plugin injection, registration, and lifecycle / disposer.
- DSH Human Commands, Agent / Session creation, cancellation, quiescence waiting, and event conversion.
- Host differences in Workflow APIs are assessed by the Adapter. Current Worker scope does not expose native Workflow tools; Core owns Task order and recovery without a second product state machine.
- DSH host detection, `0.2.0-rc.2` capability probes, structured-result translation, and Session-identity evidence.
- Bundle / manifest, actual component dependencies, and installation / removal mechanisms.

The Adapter does not own its own Task selection, Planning state, Snapshot algorithm, Run Authorization, Recovery, or full Orchestrator. Do not enable an automatic Executor if the probe cannot establish enforcement of Core's permission boundaries. Prompt restrictions do not replace host proof.

## 5. Old product semantics not migrated

| Old content | Initial treatment |
|---|---|
| Audit / Finding Router / repair queue / QA / Reconciliation / Report product flow | Not built into Runtime. It can execute explicitly planned project Tasks but does not automatically schedule these phases |
| Finding ID, AutoFixRunRef, QaFinding, retry counts, and old completion conditions | Not included in shared RunState; there is no one-to-one field-renaming migration |
| ctx.agents.resume and old JSONL conversation recovery | No old-conversation recovery. Runtime recovers from trusted checkpoints and creates a fresh session when Worker work must continue |
| Old fix-only / commit-each authorization objects | Do not directly reuse schemas; new RunAuthorization and narrower Worker authorization follow CONTRACTS |
| Old hard-coded canonical full command | Not part of Core; consume each project's HARNESS |
| Old state.json and schema v5 | Import, overwrite, and conversion are unsupported |

## 6. Old Runs and capability boundaries

Historical state is not an input to the current Runtime. The new Runtime's only state root remains `$(git rev-parse --git-path dev-harness-runtime)/runs/`, and its only Run state remains `<run-id>/run.json`. Migration documentation describes old file types without introducing a second new state root.

Old `state.ts` fixes `RUN_STATE_SCHEMA_VERSION = 5`, and parseRunState accepts only that value. There is no generic schema upgrade/import chain. Old JSON cannot automatically register as a Runtime Run. Incorrectly supplied new or old formats leave original bytes unchanged and return an explicit error.

The historical rc.8 baseline recorded multiprocess locking and complete JSON reads, while explicitly noting that atomic-write did not promise fsync crash durability and orphan locks required operator intervention. New Core must independently prove cross-platform process-interruption recovery and locking policy; these unguaranteed properties cannot be claimed as inherited capabilities.

The old system's stable downstream identity and idempotent start / resume do not imply exactly-once side effects for any TaskExecutor. The new system recovers through CONTRACTS' persistent intent and trusted checkpoints and stops at unprovable intermediate state.

## 7. Adapter acceptance and maintenance boundaries

1. Pass the shared Fake Executor contract first, then verify DSH `0.2.0-rc.2` host integration.
2. Execute the same three-task project through Codex / DSH with identical Core state, authorization, snapshot, recovery, and closure gates; each Task must have a distinct host Session identity.
3. Cover completed / blocked / failed / partial, cancellation, invalid results, out-of-scope changes, authorization violations, and a fresh session after recovery.
4. Prove preserved properties from the checklist with this repository's Core and Adapter tests; Runtime need not reproduce the full Audit / QA product path.
5. Maintain DSH implementation, platform baseline, and subsequent verification in this repository. Historical behavior records do not require preserving or maintaining an external repository and do not imply full product-feature replacement.
