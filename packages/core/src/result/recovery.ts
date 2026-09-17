import { isRepoPath, parseContract, validateResultForRequest, type EvidenceRef, type TaskExecutionRequest, type TaskExecutionResult, type VerificationEvidence } from '@dev-harness-runtime/contracts';
import { SANDBOX_CONTROL } from '../authorization/sandbox-control.js';
import type { LockHandle } from '../lock/index.js';
import { loadRecoveryCheckpoint, loadRecoverySnapshot, sameRecord } from '../recovery/evidence.js';
import type { RecoveryEvidenceContext, RecoveryVerifier } from '../recovery/types.js';
import { compareSnapshots, verifyOwnedTransition } from '../snapshot/guard.js';
import { assertVerificationTransition } from '../snapshot/verification.js';
import { readEvidence, readRunAtRevision } from '../state/index.js';
import type { AcceptedTaskData, WorkerControlVerifier } from './acceptance.js';
import { bindAcceptanceRequest, digest, identity, loadFrozenInputs, readSnapshotFiles, requireAcceptance } from './frozen.js';
import { validatePlanningDelta } from './planning.js';

function object(value: unknown): Record<string, unknown> {
  requireAcceptance(value !== null && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_REQUIRED', 'Expected a controlled evidence object');
  return value as Record<string, unknown>;
}
function ref(value: unknown): EvidenceRef {
  const record = object(value);
  requireAcceptance(record.schemaVersion === 1 && typeof record.path === 'string' && isRepoPath(record.path)
    && typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.sha256)
    && Object.keys(record).length === 3, 'ACCEPTANCE_REQUIRED', 'Invalid evidence reference');
  return { schemaVersion: 1, path: record.path, sha256: record.sha256 };
}
function refs(value: unknown): EvidenceRef[] {
  requireAcceptance(Array.isArray(value), 'ACCEPTANCE_REQUIRED', 'Expected controlled evidence references');
  const result = value.map(ref);
  requireAcceptance(new Set(result.map((entry) => entry.path)).size === result.length, 'ACCEPTANCE_REQUIRED', 'Duplicate controlled evidence');
  return result;
}
function equal(actual: unknown, expected: unknown, label: string): void {
  requireAcceptance(sameRecord(actual, expected), 'ACCEPTANCE_REQUIRED', `Persisted ${label} does not match the accepted operation`);
}
function bound(record: Record<string, unknown>, kind: string): void {
  requireAcceptance(record.schemaVersion === 1 && record.kind === kind, 'ACCEPTANCE_REQUIRED', `Expected ${kind}`);
}

/**
 * Reconstruct Core acceptance from the exact pending reference, never a scan or a
 * Worker's completed claim. Private Core storage and the Adapter's persisted
 * control verifier are required trust boundaries; hashes alone grant no authority.
 */
async function verifyAndReadPersistedAcceptance(handle: LockHandle, context: RecoveryEvidenceContext & { request: TaskExecutionRequest; result: TaskExecutionResult }, workerControl: WorkerControlVerifier): Promise<AcceptedTaskData> {
  requireAcceptance(process.env.DEV_HARNESS_WORKER !== '1', 'AUTHORIZATION_VIOLATION', 'Workers cannot recover Core acceptance');
  const { state, request, checkpoint } = context;
  bindAcceptanceRequest(state, request);
  const read = async (reference: EvidenceRef) => object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readEvidence(handle, state.runId, state.revision, reference))));
  requireAcceptance(checkpoint.evidenceRefs.length === 1 && ['verification-passed', 'commit-ready', 'index-staged'].includes(checkpoint.stage), 'ACCEPTANCE_REQUIRED', 'Checkpoint has no unique independent acceptance');
  const acceptance = await read(checkpoint.evidenceRefs[0]!); bound(acceptance, 'independent-acceptance');
  equal({ runId: acceptance.runId, taskId: acceptance.taskId, attempt: acceptance.attempt, requestId: acceptance.requestId }, identity(request), 'acceptance identity');
  if (checkpoint.kind === 'verify') equal(acceptance.operationId, checkpoint.operationId, 'verification operation');
  equal(parseContract('taskExecutionRequest', await read(ref(acceptance.requestRef))), request, 'request');
  const verified = validateResultForRequest(request, await read(ref(acceptance.verifiedResultRef)));
  equal(verified, context.result, 'verified result');
  requireAcceptance(verified.outcome === 'completed', 'ACCEPTANCE_REQUIRED', 'Recovered result is not completed');
  const before = await loadRecoverySnapshot(handle, state, { schemaVersion: 1, path: request.snapshotRef, sha256: request.snapshotHash });
  const initial = await loadRecoverySnapshot(handle, state, state.initialUserChangesRef);
  const frozen = await loadFrozenInputs(handle, state, request, before, ref(acceptance.frozenInputsRef));
  const worker = await read(ref(acceptance.workerRecordRef)); bound(worker, 'controlled-worker-ending');
  equal({ runId: worker.runId, taskId: worker.taskId, attempt: worker.attempt, requestId: worker.requestId }, identity(request), 'Worker identity');
  equal(worker.requestRef, acceptance.requestRef, 'Worker request'); equal(worker.resultRef, acceptance.workerResultRef, 'Worker result reference');
  equal(worker.beforeSnapshotRef, { schemaVersion: 1, path: request.snapshotRef, sha256: request.snapshotHash }, 'Worker starting boundary');
  const ending = await loadRecoverySnapshot(handle, state, ref(worker.endingSnapshotRef));
  const workerResult = validateResultForRequest(request, await read(ref(worker.resultRef)));
  requireAcceptance(workerResult.outcome === 'completed', 'ACCEPTANCE_REQUIRED', 'Original Worker result is incomplete');
  equal({ ...workerResult, verification: verified.verification }, verified, 'independent result projection');
  const workerEvidence: { ref: EvidenceRef; bytes: Buffer }[] = [];
  for (const reference of refs(worker.evidenceRefs)) workerEvidence.push({ ref: reference, bytes: await readEvidence(handle, state.runId, state.revision, reference) });
  requireAcceptance(workerEvidence.length > 0 && typeof workerControl?.verify === 'function', 'CAPABILITY_MISSING', 'Persisted Adapter control evidence must be independently verified');
  await verifyOwnedTransition(before, ending, { initial, scope: request.scope, authorization: state.authorization, verifyOwnership: async () => {
    const receipt = await workerControl.verify({ state: structuredClone(state), request: structuredClone(request), before, after: ending, evidence: workerEvidence });
    equal(receipt, worker.receipt, 'Worker control receipt');
    return receipt.authorizationEnforced === true && receipt.quiescent === true && !!receipt.providerId && !!receipt.sessionId;
  } });
  const changed = compareSnapshots(before.snapshot, ending.snapshot).contentPaths;
  equal([...workerResult.changedFiles].sort(), changed, 'Worker changes'); equal(acceptance.taskChangedPaths, changed, 'accepted changes');
  const afterFiles = await readSnapshotFiles(ending, [...frozen.files.keys(), request.scope.planning.archivePath]);
  equal(validatePlanningDelta({ before, after: ending, scope: request.scope, closure: verified.closure, beforeFiles: frozen.files, afterFiles }), acceptance.planning, 'Planning closure');
  let current = ending;
  const records = refs(acceptance.commandRecordRefs);
  const checks = [...request.verificationPlan.commands, ...request.verificationPlan.manual];
  requireAcceptance(records.length === checks.length && verified.verification.length === checks.length, 'ACCEPTANCE_REQUIRED', 'Incomplete controlled verification chain');
  for (const [index, reference] of records.entries()) {
    const record = await read(reference); const expected = checks[index]!;
    equal(record.operationId, acceptance.operationId, 'command operation');
    const evidence: VerificationEvidence = parseContract('verificationEvidence', record.evidence);
    equal(evidence, verified.verification[index], 'command evidence');
    equal(evidence.id, expected.id, 'criterion'); equal(evidence.acceptanceIds, expected.acceptanceIds, 'criterion coverage');
    equal(evidence.beforeSnapshotHash, current.hash, 'verification starting boundary');
    requireAcceptance(evidence.result === 'passed', 'ACCEPTANCE_REQUIRED', 'Recovered verification did not pass');
    if (evidence.kind === 'command') {
      bound(record, 'controlled-verification');
      requireAcceptance('argv' in expected && index < request.verificationPlan.commands.length, 'ACCEPTANCE_REQUIRED', 'Verification kind changed');
      equal(evidence.argv, expected.argv, 'command argv'); equal(evidence.cwd, expected.cwd, 'command cwd');
      equal(ref(record.beforeSnapshotRef).sha256, current.hash, 'command snapshot');
      const after = await loadRecoverySnapshot(handle, state, ref(record.afterSnapshotRef));
      equal(evidence.afterSnapshotHash, after.hash, 'command ending boundary');
      assertVerificationTransition(initial, current, after, request, expected.writableArtifacts);
      const ns = object(record.namespaceEvidence);
      requireAcceptance(ns.controllerSha256 === digest(SANDBOX_CONTROL) && ns.pidfdBound === true && ns.asPid1 === true && ns.monitorWaited === true
        && typeof ns.providerSha256 === 'string' && /^[a-f0-9]{64}$/u.test(ns.providerSha256)
        && typeof ns.pythonSha256 === 'string' && /^[a-f0-9]{64}$/u.test(ns.pythonSha256)
        && Number.isSafeInteger(ns.monitorPid) && Number.isSafeInteger(ns.initPid) && typeof ns.initStartTime === 'string', 'ACCEPTANCE_REQUIRED', 'Unsupported process-control receipt');
      const namespaces = object(ns.namespaceIds);
      requireAcceptance(['user', 'pid', 'mnt', 'net', 'ipc', 'uts', 'cgroup'].every((name) => Number.isSafeInteger(namespaces[name]) && Number(namespaces[name]) > 0), 'ACCEPTANCE_REQUIRED', 'Missing namespace receipt');
      for (const output of [evidence.stdout, evidence.stderr]) {
        const log = await read(output); bound(log, 'command-output');
        requireAcceptance(log.encoding === 'base64' && typeof log.bytes === 'string' && Buffer.from(log.bytes, 'base64').toString('base64') === log.bytes, 'ACCEPTANCE_REQUIRED', 'Invalid controlled output');
      }
      current = after;
    } else {
      bound(record, 'controlled-manual-acceptance');
      requireAcceptance(!('argv' in expected) && index >= request.verificationPlan.commands.length, 'ACCEPTANCE_REQUIRED', 'Verification kind changed');
      equal(evidence.afterSnapshotHash, current.hash, 'manual ending boundary');
      const confirmation = await read(evidence.confirmation); bound(confirmation, 'user-acceptance-confirmation');
      equal(confirmation.identity, identity(request), 'manual identity'); equal(confirmation.checkId, expected.id, 'manual criterion');
      equal(confirmation.acceptanceIds, expected.acceptanceIds, 'manual coverage'); equal(confirmation.snapshotHash, current.hash, 'manual boundary');
      requireAcceptance(confirmation.approved === true && confirmation.reviewer === evidence.reviewer, 'ACCEPTANCE_REQUIRED', 'Manual confirmation is missing');
    }
  }
  equal(ref(acceptance.afterSnapshotRef).sha256, current.hash, 'acceptance ending boundary');
  const verificationArtifactPaths = assertVerificationTransition(initial, ending, current, request);
  equal(acceptance.verificationArtifactPaths, verificationArtifactPaths, 'verification artifacts');
  equal(current.hash, checkpoint.kind === 'verify' ? context.after.hash : context.before.hash, 'recovery boundary');
  if (checkpoint.kind === 'verify') equal(context.before.hash, ending.hash, 'verification pending boundary');
  const workflow = before.snapshot.gitWorkflowRef; const workflowBytes = frozen.files.get(workflow.path);
  requireAcceptance(workflowBytes && digest(workflowBytes) === workflow.sha256, 'ACCEPTANCE_REQUIRED', 'Original workflow bytes are missing');
  return { state: structuredClone(state), request: structuredClone(request), result: verified, initial, before: current,
    beforeRef: ref(acceptance.afterSnapshotRef), taskChangedPaths: changed, verificationArtifactPaths,
    verifiedEvidenceRefs: [checkpoint.evidenceRefs[0]!], workflow: { path: workflow.path, sha256: workflow.sha256, bytes: Buffer.from(workflowBytes) } };
}

export async function verifyPersistedAcceptance(handle: LockHandle, context: RecoveryEvidenceContext & { request: TaskExecutionRequest; result: TaskExecutionResult }, workerControl: WorkerControlVerifier): Promise<void> {
  await verifyAndReadPersistedAcceptance(handle, context, workerControl);
}

/** Internal bridge input, rederived from current private authority; it is not an accepted capability. */
export async function loadVerifiedCommitRecovery(handle: LockHandle, runId: string, expectedRevision: number, workerControl: WorkerControlVerifier): Promise<{ data: AcceptedTaskData; context: RecoveryEvidenceContext }> {
  requireAcceptance(process.env.DEV_HARNESS_WORKER !== '1', 'AUTHORIZATION_VIOLATION', 'Workers cannot recover Core commit authority');
  const state = await readRunAtRevision(handle, runId, expectedRevision);
  requireAcceptance(state.status === 'RUNNING' && state.authorization.commit === 'task'
    && ((state.phase === 'FINALIZE' && state.pendingOperation?.kind === 'commit')
      || (state.phase === 'REVALIDATE' && state.pendingOperation?.kind === 'verify')), 'ACCEPTANCE_REQUIRED', 'Commit continuation requires a resumed verification or commit reservation');
  const pending = state.pendingOperation;
  const reference = pending.kind === 'commit' ? pending.indexCheckpointRef ?? pending.checkpointRef : pending.checkpointRef;
  requireAcceptance(reference, 'ACCEPTANCE_REQUIRED', 'Commit reservation has no persisted acceptance checkpoint');
  const context = await loadRecoveryCheckpoint(handle, state, reference);
  requireAcceptance(context.request && context.result && (pending.kind === 'commit'
    ? ['commit-ready', 'index-staged'].includes(context.checkpoint.stage) : context.checkpoint.stage === 'verification-passed'), 'ACCEPTANCE_REQUIRED', 'Commit continuation has no exact independently verified boundary');
  const data = await verifyAndReadPersistedAcceptance(handle, { ...context, request: context.request, result: context.result }, workerControl);
  return { data, context };
}

/** Adapter callbacks cover only host quiescence and pre-acceptance Worker checkpoints. */
export function createAcceptanceRecoveryVerifier(handle: LockHandle, services: {
  workerControl: WorkerControlVerifier;
  verifyQuiescence: NonNullable<RecoveryVerifier['verifyQuiescence']>;
  verifyWorkerCheckpoint: NonNullable<RecoveryVerifier['verifyCheckpoint']>;
}): RecoveryVerifier {
  const verify = async (context: RecoveryEvidenceContext) => {
    requireAcceptance(context.request && context.result, 'ACCEPTANCE_REQUIRED', 'Completed checkpoint lacks request/result');
    await verifyPersistedAcceptance(handle, { ...context, request: context.request, result: context.result }, services.workerControl);
  };
  return {
    verifyQuiescence: services.verifyQuiescence,
    verifyCheckpoint: async (context) => context.checkpoint.kind === 'execute' ? services.verifyWorkerCheckpoint(context) : verify(context),
    verifyAcceptance: verify,
  };
}
