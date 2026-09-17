import { createHash, randomUUID } from 'node:crypto';
import { parseContract, parseContractJson, type EvidenceRef, type RunState } from '@dev-harness-runtime/contracts';
import type { LockHandle } from '../lock/index.js';
import { compareAndSwapRun, createAttempt, readCurrentRun, readEvidence, readRunEvidenceCandidate, ensureRunEvidence, writeSummary } from '../state/index.js';
import { recaptureSnapshot } from '../snapshot/capture.js';
import { assertTaskStart, assertUnchanged, compareSnapshots, verifyOwnedTransition } from '../snapshot/guard.js';
import { verifyAuthorizedCommit, type CommitIntent } from '../snapshot/commit.js';
import type { CapturedSnapshot } from '../snapshot/types.js';
import { decideRecovery } from './decision.js';
import { copyRecoveryContext, loadRecoveryCheckpoint, loadRecoverySnapshot, sameRecord } from './evidence.js';
import { RecoveryError, type RecoveryEvidenceContext, type RecoveryFacts, type ResumeOptions, type ResumeResult } from './types.js';

function requireValue(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new RecoveryError(code, message);
}
const now = (state: RunState) => new Date(Math.max(Date.now(), Date.parse(state.updatedAt))).toISOString();
const stop = (state: RunState, code: string, message: string): ResumeResult => ({ state, decision: { action: 'stopped', code, message } });
function failure(error: unknown): { code: string; message: string } {
  return { code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'RECOVERY_VERIFICATION_FAILED', message: error instanceof Error ? error.message : 'Recovery evidence verification failed' };
}
const evidenceName = (prefix: string, operationId: string) => `${prefix}-${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`;
function nextState(state: RunState): RunState { return { ...structuredClone(state), revision: state.revision + 1, updatedAt: now(state) }; }

function validateEnvironment(state: RunState, options: ResumeOptions): void {
  requireValue(options.environment && typeof options.environment === 'object', 'ENVIRONMENT_MISMATCH', 'Recovery needs current Core environment declarations');
  const authorization = parseContract('runAuthorization', options.environment.authorization);
  const protocol = parseContract('protocolSource', options.environment.protocolSource);
  requireValue(sameRecord(authorization, state.authorization), 'AUTHORIZATION_VIOLATION', 'Recovery cannot change the Run authorization');
  requireValue(options.environment.adapter === state.adapter && options.environment.adapterConfigHash === state.adapterConfigHash && sameRecord(protocol, state.protocolSource), 'ENVIRONMENT_MISMATCH', 'Current Adapter or protocol differs from this Run');
}

function checkpointReference(state: RunState, options: ResumeOptions): EvidenceRef | undefined {
  const pending = state.pendingOperation;
  const recorded = pending?.kind === 'commit' ? pending.indexCheckpointRef ?? pending.checkpointRef : pending?.checkpointRef;
  requireValue(!options.checkpointRef || sameRecord(options.checkpointRef, recorded), 'INVALID_RECOVERY_CHECKPOINT', 'Caller checkpoint does not match the frozen pending reference');
  requireValue(!(options.checkpointRef && options.candidateCheckpointRef), 'INVALID_RECOVERY_CHECKPOINT', 'Choose one checkpoint source');
  if (options.candidateCheckpointRef) {
    requireValue(pending?.kind === 'execute' && recorded === undefined, 'INVALID_RECOVERY_CHECKPOINT', 'Orphan candidates require an execution intent with no frozen checkpoint');
    return options.candidateCheckpointRef;
  }
  return recorded;
}

async function verifyStagedBoundary(state: RunState, initial: CapturedSnapshot, evidence: RecoveryEvidenceContext): Promise<void> {
  const pending = state.pendingOperation;
  requireValue(pending?.kind === 'commit', 'INVALID_RECOVERY_CHECKPOINT', 'Staging evidence requires a commit intent');
  assertTaskStart(initial, evidence.before, pending.scope);
  const projection = (captured: CapturedSnapshot) => ({ ...captured.snapshot, capturedAt: '', indexFingerprint: '', indexFlags: [], stagedPaths: [], dirtyPaths: [], paths: captured.snapshot.paths.map((entry) => ({ ...entry, index: [] })) });
  requireValue(sameRecord(projection(evidence.before), projection(evidence.after)), 'DRIFT_DETECTED', 'Staging changed snapshot metadata or a non-index boundary');
  const delta = compareSnapshots(evidence.before.snapshot, evidence.after.snapshot);
  requireValue(!delta.headChanged && !delta.branchChanged && delta.contentPaths.length === 0, 'DRIFT_DETECTED', 'Staging checkpoint changed HEAD, branch or worktree content');
  requireValue(delta.paths.every((path) => pending.paths.includes(path)) && evidence.after.stagedPaths.every((path) => pending.paths.includes(path)), 'AUTHORIZATION_VIOLATION', 'Staging checkpoint includes paths outside the commit intent');
  const old = new Map(evidence.before.snapshot.indexFlags.map((entry) => [entry.path, entry.tag]));
  const next = new Map(evidence.after.snapshot.indexFlags.map((entry) => [entry.path, entry.tag]));
  for (const path of new Set([...old.keys(), ...next.keys()])) {
    const prior = old.get(path); const after = next.get(path);
    requireValue(prior === after || (pending.paths.includes(path) && ((prior === undefined && after === 'H') || (prior === 'H' && after === undefined))), 'AUTHORIZATION_VIOLATION', 'Staging cannot alter hiding index flags');
  }
}

async function finalize(handle: LockHandle, state: RunState, evidence: RecoveryEvidenceContext, after: CapturedSnapshot, afterRef: EvidenceRef, commitSha?: string): Promise<RunState> {
  requireValue(evidence.request && evidence.result?.outcome === 'completed' && state.pendingOperation, 'ACCEPTANCE_REQUIRED', 'Finalization requires the bound completed result');
  const identity = state.pendingOperation.identity;
  requireValue(!state.completedTasks.includes(identity.taskId), 'STATE_CORRUPT', 'Task was already accepted');
  const accepted = parseContract('acceptedTaskExecutionResult', { ...evidence.result, ...(commitSha ? { commitSha } : {}), acceptedAt: evidence.after.snapshot.capturedAt, acceptedSnapshotHash: after.hash, verifiedEvidenceRefs: evidence.checkpoint.evidenceRefs });
  const resultRef = await ensureRunEvidence(handle, state.runId, state.revision, evidenceName('accepted', state.pendingOperation.operationId), accepted);
  const next = nextState(state);
  next.acceptedSnapshotRef = afterRef; next.acceptedSnapshotHash = afterRef.sha256;
  next.completedTasks = [...state.completedTasks, identity.taskId];
  next.resultRefs = [...state.resultRefs.filter((item) => !sameRecord(item.identity, identity)), { identity, ref: resultRef }];
  delete next.pendingOperation; delete next.stopReason; delete next.currentTaskId; delete next.currentAttempt; delete next.currentRequestId;
  next.status = state.selectionMode.mode === 'all-ready' ? 'RUNNING' : 'COMPLETED';
  next.phase = next.status === 'COMPLETED' ? 'FINALIZE' : 'SELECT';
  assertUnchanged(after, await recaptureSnapshot(after));
  return compareAndSwapRun(handle, state.runId, state.revision, next);
}

/**
 * Recover durable Core boundaries only. No host invocation, old Conversation,
 * Git commit, Planning write or automatic stale-lock deletion occurs here.
 * Each storage call owns its guard; the caller retains the same LockHandle.
 */
export async function resumeRun(handle: LockHandle, runId: string, options: ResumeOptions): Promise<ResumeResult> {
  if (process.env.DEV_HARNESS_WORKER === '1') throw new RecoveryError('AUTHORIZATION_VIOLATION', 'Workers cannot resume Runs');
  let state = await readCurrentRun(handle, runId);
  try {
    requireValue(Number.isSafeInteger(options.expectedRevision) && options.expectedRevision >= 0 && state.revision === options.expectedRevision, 'REVISION_CONFLICT', 'Resume must bind the exact current revision');
    validateEnvironment(state, options);
    if (state.status === 'FAILED' || state.status === 'COMPLETED') return stop(state, 'RUN_TERMINAL', 'Terminal Runs cannot resume');
    requireValue(state.reconciliation === undefined, 'PENDING_RECONCILIATION', 'An aligned Run is inherited through its reserved successor, not resumed');
    if (state.status === 'CREATED' || state.status === 'RUNNING') {
      requireValue(typeof options.verifier?.verifyQuiescence === 'function', 'LOCK_OWNER_UNKNOWN', 'Old owner and all descendants require trusted quiescence evidence');
      await options.verifier.verifyQuiescence({ state: structuredClone(state) });
      const interrupted = nextState(state); interrupted.status = 'INTERRUPTED'; interrupted.stopReason = { code: 'PROCESS_INTERRUPTED', message: 'Trusted Core verification proved the prior process tree quiescent' };
      state = await compareAndSwapRun(handle, runId, state.revision, interrupted);
    }
    const initial = await loadRecoverySnapshot(handle, state, state.initialUserChangesRef);
    const accepted = await loadRecoverySnapshot(handle, state, state.acceptedSnapshotRef);
    requireValue(initial.hash === state.initialUserChangesHash && accepted.hash === state.acceptedSnapshotHash, 'STATE_CORRUPT', 'Run snapshot digest fields disagree');
    const pending = state.pendingOperation;
    const before = pending ? await loadRecoverySnapshot(handle, state, pending.beforeSnapshotRef) : accepted;
    if (pending?.kind === 'execute') assertTaskStart(initial, before, pending.scope);
    if (pending) requireValue(before.hash === pending.beforeSnapshotHash, 'STATE_CORRUPT', 'Pending before snapshot digest disagrees');
    const ref = checkpointReference(state, options);
    const evidence = ref ? await loadRecoveryCheckpoint(handle, state, ref) : undefined;
    if (options.candidateCheckpointRef) requireValue(evidence?.checkpoint.stage === 'worker-ended', 'INVALID_RECOVERY_CHECKPOINT', 'Orphan adoption only accepts a completed Worker ending checkpoint');
    const current = await recaptureSnapshot(evidence?.after ?? before);
    const facts: RecoveryFacts = { currentMatchesBefore: current.boundaryHash === before.boundaryHash, currentMatchesAccepted: current.boundaryHash === accepted.boundaryHash,
      ...(evidence ? { checkpoint: evidence.checkpoint } : {}), checkpointVerified: false, acceptanceVerified: false, commitVerified: false,
      commitAbsent: pending?.kind === 'commit' && current.snapshot.repoIdentity.head === pending.parent, resultCompleted: evidence?.result?.outcome === 'completed' };
    if (evidence) {
      requireValue(typeof options.verifier?.verifyCheckpoint === 'function', 'RECOVERY_EVIDENCE_REQUIRED', 'Controlled checkpoint provenance and quiescent ending boundary need verification');
      if (pending?.kind === 'commit') {
        await verifyStagedBoundary(state, initial, evidence);
        await options.verifier.verifyCheckpoint(copyRecoveryContext(evidence));
      } else {
        requireValue(current.boundaryHash === evidence.after.boundaryHash, 'DRIFT_DETECTED', 'Project no longer matches the checkpoint ending boundary');
        requireValue(pending, 'INVALID_RECOVERY_CHECKPOINT', 'Missing pending operation');
        await verifyOwnedTransition(before, evidence.after, { initial, scope: pending.scope, authorization: state.authorization,
          verifyOwnership: async () => { await options.verifier.verifyCheckpoint!(copyRecoveryContext(evidence)); return true; } });
      }
      facts.checkpointVerified = true;
      if (evidence.checkpoint.stage === 'verification-passed' || pending?.kind === 'commit') {
        requireValue(evidence.request && evidence.result?.outcome === 'completed' && typeof options.verifier.verifyAcceptance === 'function', 'ACCEPTANCE_REQUIRED', 'Independent acceptance and permission enforcement require a trusted Core verifier');
        await options.verifier.verifyAcceptance({ ...copyRecoveryContext(evidence), request: structuredClone(evidence.request), result: structuredClone(evidence.result) });
        facts.acceptanceVerified = true;
      }
    }
    if (pending?.kind === 'verify') {
      const plan = parseContractJson('verificationPlan', new TextDecoder('utf-8', { fatal: true }).decode(await readEvidence(handle, state.runId, state.revision, pending.verificationPlanRef)));
      if (evidence?.request) requireValue(sameRecord(plan, evidence.request.verificationPlan), 'INVALID_RECOVERY_CHECKPOINT', 'Pending verification plan differs from the execution request');
    }
    if (pending?.kind === 'commit') {
      requireValue(pending.parent === before.snapshot.repoIdentity.head, 'STATE_CORRUPT', 'Commit parent does not match its before snapshot');
      if (!facts.commitAbsent) {
        const intent: CommitIntent = { parent: pending.parent, expectedTree: pending.expectedTree, paths: pending.paths, messageHash: pending.messageHash };
        await verifyOwnedTransition(before, current, { initial, scope: pending.scope, authorization: state.authorization, commit: intent,
          verifyOwnership: async () => { await verifyAuthorizedCommit(before, current, state.authorization, intent); return true; } });
        facts.commitVerified = true;
        requireValue(evidence && facts.acceptanceVerified, 'ACCEPTANCE_REQUIRED', 'A real commit still requires its bound accepted result before finalizing');
      } else if (evidence) assertUnchanged(evidence.after, current);
    }
    const decision = decideRecovery(state, facts);
    if (decision.action === 'stopped') return { state, decision };
    assertUnchanged(current, await recaptureSnapshot(current));
    if (decision.action === 'execute-new-session') {
      requireValue(pending?.kind === 'execute', 'STATE_CORRUPT', 'Execution recovery requires an execute intent');
      requireValue(pending.identity.attempt < Number.MAX_SAFE_INTEGER, 'ATTEMPT_OVERFLOW', 'Attempt counter exhausted');
      const next = nextState(state); const identity = { ...pending.identity, attempt: pending.identity.attempt + 1, requestId: evidenceName('request', pending.operationId) };
      const restartRef = decision.continuation === 'checkpoint' && evidence ? evidence.checkpoint.afterSnapshotRef : pending.beforeSnapshotRef;
      next.status = 'RUNNING'; next.phase = 'EXECUTE'; delete next.stopReason;
      next.currentTaskId = identity.taskId; next.currentAttempt = identity.attempt; next.currentRequestId = identity.requestId;
      next.pendingOperation = { ...pending, operationId: evidenceName('execute', pending.operationId), identity, beforeSnapshotRef: restartRef, beforeSnapshotHash: restartRef.sha256, createdAt: pending.createdAt };
      delete next.pendingOperation.checkpointRef;
      if (evidence?.request) {
        const request = parseContract('taskExecutionRequest', { ...evidence.request, ...identity, snapshotRef: restartRef.path, snapshotHash: restartRef.sha256 });
        const requestRef = await ensureRunEvidence(handle, runId, state.revision, evidenceName('resume-request', pending.operationId), request);
        const continuation = { schemaVersion: 1, operationId: next.pendingOperation.operationId, kind: 'execute', identity, stage: 'execute-intent', beforeSnapshotRef: restartRef, afterSnapshotRef: restartRef,
          requestRef, evidenceRefs: [evidence.checkpointRef] };
        next.pendingOperation.checkpointRef = await ensureRunEvidence(handle, runId, state.revision, evidenceName('resume-intent', pending.operationId), continuation);
      }
      state = await compareAndSwapRun(handle, runId, state.revision, next);
      await createAttempt(handle, runId, state.revision, identity);
    } else if (decision.action === 'adopt-result') {
      requireValue(pending && evidence?.request && evidence.result?.outcome === 'completed' && evidence.checkpoint.resultRef, 'INVALID_RESULT', 'Candidate result is incomplete');
      const planRef = await ensureRunEvidence(handle, runId, state.revision, evidenceName('verification-plan', pending.operationId), evidence.request.verificationPlan);
      const next = nextState(state); next.status = 'RUNNING'; next.phase = 'REVALIDATE'; delete next.stopReason;
      next.resultRefs = [...state.resultRefs.filter((item) => !sameRecord(item.identity, pending.identity)), { identity: pending.identity, ref: evidence.checkpoint.resultRef }];
      next.pendingOperation = { schemaVersion: 1, operationId: randomUUID(), kind: 'verify', identity: pending.identity, scope: pending.scope, beforeSnapshotRef: evidence.checkpoint.afterSnapshotRef,
        beforeSnapshotHash: evidence.checkpoint.afterSnapshotRef.sha256, verificationPlanRef: planRef, createdAt: next.updatedAt };
      state = await compareAndSwapRun(handle, runId, state.revision, next);
    } else if (decision.action === 'finalize-no-commit' || decision.action === 'adopt-commit') {
      requireValue(evidence, 'ACCEPTANCE_REQUIRED', 'Finalization evidence is missing');
      let afterRef = evidence.checkpoint.afterSnapshotRef;
      if (decision.action === 'adopt-commit') {
        requireValue(pending, 'STATE_CORRUPT', 'Commit adoption needs its frozen intent');
        const name = evidenceName('committed', pending.operationId);
        const candidate = await readRunEvidenceCandidate(handle, runId, state.revision, name);
        if (candidate) {
          const persisted = await loadRecoverySnapshot(handle, state, candidate.ref);
          assertUnchanged(persisted, current);
          afterRef = candidate.ref;
          Object.assign(current, persisted);
        } else afterRef = await ensureRunEvidence(handle, runId, state.revision, name, current.snapshot);
      }
      state = await finalize(handle, state, evidence, decision.action === 'adopt-commit' ? current : evidence.after, afterRef,
        decision.action === 'adopt-commit' ? current.snapshot.repoIdentity.head : undefined);
      await writeSummary(handle, runId, state.revision);
    } else {
      const next = nextState(state); next.status = 'RUNNING'; delete next.stopReason;
      next.phase = decision.action === 'resume-commit' ? 'FINALIZE' : decision.action === 'revalidate' ? 'REVALIDATE' : 'SELECT';
      state = await compareAndSwapRun(handle, runId, state.revision, next);
      if (decision.action === 'rebuild-summary') await writeSummary(handle, runId, state.revision);
    }
    return { state, decision };
  } catch (error) {
    const diagnostic = failure(error);
    return stop(state, diagnostic.code, diagnostic.message);
  }
}
