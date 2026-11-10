# Run recovery and manual reconciliation

[English](RECOVERY.en.md) | [简体中文](RECOVERY.md)

Authoritative recovery semantics are in [CONTRACTS §6](CONTRACTS.en.md#6-crash-recovery-protocol). This page describes Core interfaces and evidence boundaries. K4 connects trusted service entry points for `dhr resume` / `dhr reconcile`; execution is explicitly rejected when the current distribution lacks a host Executor.

## User operation sequence

1. In a new host thread opened on the original target project, query the original `runId` first. Read the actual status, revision, verification summary, and log references. A status query does not start execution.
2. Explicitly resume the same Run when it is recoverable and its dependencies, authorization, and actual workspace still match. Use the trusted entry point bundled with the installed plugin. A standalone CLI without an Executor returns `CAPABILITY_MISSING`; do not switch entry points to bypass the capability probe.

```text
$dev-harness:status Show the status of Run <run-id>.
$dev-harness:run Resume Run <run-id>.
```

3. If diagnostics require manual reconciliation, inspect actual boundaries and controlled-operation evidence as described below. `reconcile` requires the current expected revision and an EvidenceRef JSON file referencing a resolution record already persisted by Core. A text confirmation or handwritten JSON claiming approval cannot replace that evidence. Replace every path, Run ID, and revision in this example with the actual values:

```bash
node /absolute/path/to/plugin/scripts/dhr.mjs reconcile --run <run-id> --expected-revision <N> --resolution /absolute/path/to/ref.json --project /absolute/path/to/project
```

4. Retain locks and stopped state when host quiescence cannot be proven. Do not edit `run.json`, delete locks, or copy old results to manufacture recoverability. A subsequent Run after successful reconciliation must still pass the successor gates below; an ordinary new Run does not automatically inherit the new baseline.

## Reading and initialization

The only state comes from `<run-id>/run.json` in Git's private directory. `inspectRun` can obtain a consistent current revision without locking; Core recovery and writes explicitly bind that revision. When CLI resume omits `--expected-revision`, it reads the current revision before CAS. Never read the "latest result" and treat it as completion state.

Initial snapshots and initialization-intent digests are stored in `results/run-evidence/`. They do not invent a Task or attempt; even an empty queue has a real initial boundary. Initialization intent contains only seedHash and references to determine whether a retry still represents the same intent; it cannot independently advance state. The Run state root remains `$(git rev-parse --git-path dev-harness-runtime)/runs/`.

## Recovery evidence

Recovery checks the persistent Run against the current Core's Adapter, authorization, protocol source, and configuration digest. RunState.repoIdentity records identity at creation; current Git content is checked against acceptedSnapshot or the boundary for the pending operation, rather than always requiring HEAD to equal the creation commit.

A checkpoint is a controlled Core operation record binding operationId, execution identity, phase, before / after Snapshots, and exact references to the request, result, and verification evidence. `commit-ready` declares an unstaged commit intent and must use the same before / after Snapshot reference. `indexCheckpointRef` likewise refers to a checkpoint with an `index-staged` phase; an index digest without identity is insufficient. Private-file existence, a valid schema, or matching digests do not individually prove provenance. Core's trusted verifier still checks controlled operations, execution quiescence, and independent acceptance.

When continuing from an execution checkpoint, the new attempt uses a new requestId and writes a separate `execute-intent` that exactly references the preceding attempt's checkpoint. This record declares only a new execution intent, with identical before / after boundaries. Recovery still checks preceding identity, boundaries, and trusted provenance; a new intent cannot be treated as an executed result.

Recovery interfaces return an explicit next action: a new attempt / Session, continuation of remaining work from a trusted checkpoint, adoption of a verified result, renewed acceptance, recording an accepted boundary, return to Core's commit bridge, or stopping for reconciliation. The interfaces themselves do not start a host or execute Git commit. Existing commits must be checked against the real parent, tree, message, paths, and current content. Preserve the scene when these cannot be proven; do not blindly replay side effects.

The snapshot in an execution request is the boundary before Worker execution. Once verify / commit begins, the pending operation's before boundary precedes that sub-operation. Check their references separately; snapshots from different phases need not have equal digests.

If execution stops after evidence publication but before Run CAS, candidate evidence for the same operation can be read by its deterministic name. Ordinary evidence is reused only when serialized bytes match exactly. A post-commit snapshot must revalidate actual content boundaries and retain its first capture time and original bytes. Do not select results by mtime or treat file existence as operation success.

## Leftover locks and stop conditions

Acquiring a new lock does not prove that the old process and its descendants are quiescent. A leftover CREATED / RUNNING record requires trusted quiescence evidence before it can be recorded as INTERRUPTED and recovered according to its current phase. Report manual intervention when the lock owner, descendants, or guard cannot be proven safe; do not automatically delete locks because a PID is missing or a timeout has elapsed.

External drift in HEAD / index / Planning / initial user content, a wrong Run revision, missing or inconsistent references, checkpoints without trusted provenance, and terminal Runs all prevent automatic recovery. Failure preserves original records and evidence.

## Explicit reconciliation and subsequent Runs

First repair or restore the project manually, then provide a resolution binding runId, the target revision, current snapshot, related Tasks, and evidence. Retaining a completed archive requires fresh independent acceptance; restoring an active task requires Planning revalidation. Workers cannot invoke this entry point.

Reconciliation records only the verified disposition in the original run.json. It preserves failure status, reason, pending history, and original completedTasks. It does not write Planning or retroactively accept failed execution. A successor Run is first reserved through CAS of a unique successorRunId in the original record, then created with that same ID. An interrupted retry must not create a second successor or overwrite a Run revision that has already advanced.

An unconsumed reconciliation record still prevents an ordinary new Run from bypassing the dedicated successor flow. After consumption, verify the source and successor relationship. Closed historical reconciliation should not permanently require subsequent normal development to match an old snapshot.

## Recovery after independent acceptance

K4-V's `createAcceptanceRecoveryVerifier` traverses the original frozen inputs, Worker control records, Planning delta, command output, and snapshot chain from the pending operation's unique acceptance reference. The Adapter still supplies actual Worker-control and old execution-tree quiescence evidence; interface fixtures do not replace host evidence.

Verification permits only untracked artifact changes explicitly declared by the frozen plan; recovery uses the same narrow write policy as normal acceptance. commit-ready / index-staged distinguish unstaged intent from completed staging; stop if phase boundaries do not match. The commit bridge and recovery share deterministic committed / accepted names and stable acceptance times, so original bytes can be reused after interruption between evidence publication and CAS without duplicate commits. See the actual failure tests in [K4-V](verification/K4-V.md).

## K4 command integration

`dhr status --run <run-id>` can read compact state while the Orchestrator holds the lock. If the revision or logs change during the read, it reports a retry rather than returning mixed versions.

`dhr resume --run <run-id> [--expected-revision N]` continues the original Run through trusted services. The initial execution pins request and acceptance inputs in the dispatch manifest. Cancellation with an unchanged boundary retries in a new attempt / requestId and a new Session. Once a Worker has finished and an ended checkpoint is saved, recovery only repeats independent acceptance, not development.

`dhr reconcile --run <run-id> --expected-revision N --resolution <ref.json>` reads an EvidenceRef whose target must be an already-persisted resolution inside the original Run's private directory. Trusted Core services verify actual proof; directly submitting claimed approval cannot bypass checks. To inherit the reconciled baseline, call `createReconciledSuccessor`; an ordinary new Run will not automatically consume or overwrite that record.

Commit recovery uses `resumeAcceptedTaskCommit` to continue original acceptance and Git intent. Valid verification artifacts produced after verification-passed are retained without rerunning verification. commit-ready / index-staged retain the original paths, message hash, and tree. Keep the lock and wait for explicit disposition when Worker or acceptance-process quiescence cannot be proven. K4 covers a Fake Executor and local controlled verification; real host capability is still established by platform tasks.
