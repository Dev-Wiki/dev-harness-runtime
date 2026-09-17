import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseContract, parseContractJson, validateResultForRequest, type EvidenceRef, type RunState, type TaskExecutionRequest, type TaskExecutionResult, type VerificationEvidence } from '@dev-harness-runtime/contracts';
import { runSandbox, type SandboxHandle } from '../authorization/sandbox.js';
import type { LockHandle } from '../lock/index.js';
import { loadRecoverySnapshot, sameRecord } from '../recovery/evidence.js';
import { recaptureSnapshot } from '../snapshot/capture.js';
import { assertTaskStart, assertUnchanged, compareSnapshots, verifyOwnedTransition } from '../snapshot/guard.js';
import { assertVerificationArtifacts, assertVerificationTransition } from '../snapshot/verification.js';
import type { CapturedSnapshot } from '../snapshot/types.js';
import { compareAndSwapRun, ensureRunEvidence, readEvidence, readRunAtRevision, writeRunEvidence, writeSummary } from '../state/index.js';
import { AcceptanceError, bindAcceptanceRequest, digest, identity, loadFrozenInputs, readSnapshotFiles, recordName, requireAcceptance } from './frozen.js';
import { validatePlanningDelta } from './planning.js';

export interface WorkerControlReceipt { providerId: string; sessionId: string; authorizationEnforced: true; quiescent: true }
/** Implemented by trusted Adapter/Core code, never deserialized from a Worker result. */
export interface WorkerControlVerifier {
  verify(input: { state: RunState; request: TaskExecutionRequest; before: CapturedSnapshot; after: CapturedSnapshot; evidence: readonly { ref: EvidenceRef; bytes: Buffer }[] }): Promise<WorkerControlReceipt>;
}
export interface AcceptanceServices {
  sandbox: SandboxHandle;
  workerControl: WorkerControlVerifier;
  commandTimeoutMs?: number;
  signal?: AbortSignal;
  /** Must resolve an actual external user confirmation, not Worker-generated approval text. */
  manualControl?: { verify(input: { state: RunState; request: TaskExecutionRequest; check: TaskExecutionRequest['verificationPlan']['manual'][number]; after: CapturedSnapshot }): Promise<{ reviewer: string; confirmation: EvidenceRef }> };
}
export interface VerifyTaskAcceptanceOptions {
  runId: string;
  expectedRevision: number;
  requestRef: EvidenceRef;
  resultRef: EvidenceRef;
  endingSnapshotRef: EvidenceRef;
  frozenInputsRef: EvidenceRef;
  workerEvidenceRefs: EvidenceRef[];
}
declare const acceptanceBrand: unique symbol;
export interface AcceptedTaskCapability { readonly [acceptanceBrand]: true }
export interface AcceptedTaskData {
  state: RunState;
  request: TaskExecutionRequest;
  result: Extract<TaskExecutionResult, { outcome: 'completed' }>;
  initial: CapturedSnapshot;
  before: CapturedSnapshot;
  beforeRef: EvidenceRef;
  taskChangedPaths: string[];
  verificationArtifactPaths: string[];
  verifiedEvidenceRefs: EvidenceRef[];
  workflow: { path: string; sha256: string; bytes: Buffer };
}
const accepted = new WeakMap<object, { handle: LockHandle; data: AcceptedTaskData }>();
function denyWorker(): void { requireAcceptance(process.env.DEV_HARNESS_WORKER !== '1', 'AUTHORIZATION_VIOLATION', 'Workers cannot perform Core acceptance or consume commit authority'); }
function at(state: RunState): string { return new Date(Math.max(Date.now(), Date.parse(state.updatedAt))).toISOString(); }
function next(state: RunState): RunState { return { ...structuredClone(state), revision: state.revision + 1, updatedAt: at(state) }; }

/** The capability is process-local, binds the original lock/revision, and can be consumed once. */
export function consumeAcceptedTask(capability: AcceptedTaskCapability, handle: LockHandle, expectedRevision: number): AcceptedTaskData {
  denyWorker();
  const record = accepted.get(capability);
  requireAcceptance(record && record.handle === handle && record.data.state.revision === expectedRevision, 'ACCEPTANCE_REQUIRED', 'No unused independent acceptance capability binds this lock and revision');
  accepted.delete(capability);
  return { ...structuredClone(record.data), workflow: { ...record.data.workflow, bytes: Buffer.from(record.data.workflow.bytes) } };
}

async function checkedWorkerClaims(handle: LockHandle, state: RunState, result: TaskExecutionResult): Promise<void> {
  if (result.rawResultRef) await readEvidence(handle, state.runId, state.revision, result.rawResultRef);
  for (const check of result.verification) {
    const refs = check.kind === 'command' ? [check.stdout, check.stderr] : [check.confirmation];
    for (const ref of refs) await readEvidence(handle, state.runId, state.revision, ref);
  }
}

/** Independently validates a candidate and reruns commands inside the controlled OS provider. */
export async function verifyTaskAcceptance(handle: LockHandle, input: VerifyTaskAcceptanceOptions, services: AcceptanceServices): Promise<AcceptedTaskCapability> {
  denyWorker();
  const options = structuredClone(input);
  requireAcceptance(options.workerEvidenceRefs.length > 0, 'RECOVERY_EVIDENCE_REQUIRED', 'Worker control evidence is mandatory');
  let state = await readRunAtRevision(handle, options.runId, options.expectedRevision);
  const request = parseContractJson('taskExecutionRequest', new TextDecoder('utf-8', { fatal: true }).decode(await readEvidence(handle, state.runId, state.revision, options.requestRef)));
  bindAcceptanceRequest(state, request);
  const result = validateResultForRequest(request, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readEvidence(handle, state.runId, state.revision, options.resultRef))));
  requireAcceptance(result.outcome === 'completed', 'RESULT_NOT_COMPLETED', 'Only completed candidates enter independent acceptance');
  requireAcceptance(!state.completedTasks.includes(request.taskId), 'INVALID_RESULT', 'This Task was already accepted');
  requireAcceptance(state.pendingOperation?.kind === 'execute' || state.pendingOperation?.kind === 'verify', 'INVALID_RESULT', 'Acceptance requires execution or verification intent');
  const initial = await loadRecoverySnapshot(handle, state, state.initialUserChangesRef);
  const before = await loadRecoverySnapshot(handle, state, { schemaVersion: 1, path: request.snapshotRef, sha256: request.snapshotHash });
  const ending = await loadRecoverySnapshot(handle, state, options.endingSnapshotRef);
  requireAcceptance(state.pendingOperation.beforeSnapshotHash === (state.pendingOperation.kind === 'execute' ? before.hash : ending.hash), 'INVALID_RESULT', 'Pending boundary does not bind this operation');
  assertTaskStart(initial, before, request.scope);
  assertUnchanged(ending, await recaptureSnapshot(ending));
  const frozen = await loadFrozenInputs(handle, state, request, before, options.frozenInputsRef);
  await checkedWorkerClaims(handle, state, result);
  const workerEvidence: { ref: EvidenceRef; bytes: Buffer }[] = [];
  for (const ref of options.workerEvidenceRefs) workerEvidence.push({ ref, bytes: await readEvidence(handle, state.runId, state.revision, ref) });
  let receipt: WorkerControlReceipt | undefined;
  const taskChangedPaths = compareSnapshots(before.snapshot, ending.snapshot).contentPaths;
  requireAcceptance(sameRecord([...result.changedFiles].sort(), taskChangedPaths), 'INVALID_RESULT', 'Worker changedFiles differs from the complete observed transition');
  await verifyOwnedTransition(before, ending, { initial, scope: request.scope, authorization: state.authorization,
    verifyOwnership: async () => {
      requireAcceptance(typeof services.workerControl?.verify === 'function', 'CAPABILITY_MISSING', 'A trusted Adapter control verifier is required');
      receipt = await services.workerControl.verify({ state: structuredClone(state), request: structuredClone(request), before: structuredClone(before), after: structuredClone(ending),
        evidence: workerEvidence.map(({ ref, bytes }) => ({ ref: structuredClone(ref), bytes: Buffer.from(bytes) })) });
      return !!receipt && typeof receipt.providerId === 'string' && receipt.providerId.length > 0 && typeof receipt.sessionId === 'string' && receipt.sessionId.length > 0
        && receipt.authorizationEnforced === true && receipt.quiescent === true;
    } });
  const afterFiles = await readSnapshotFiles(ending, [...frozen.files.keys(), request.scope.planning.archivePath]);
  const planning = validatePlanningDelta({ before, after: ending, scope: request.scope, closure: result.closure, beforeFiles: frozen.files, afterFiles });
  assertUnchanged(ending, await recaptureSnapshot(ending));
  requireAcceptance(request.verificationPlan.manual.length === 0 || typeof services.manualControl?.verify === 'function', 'MANUAL_ACCEPTANCE_REQUIRED', 'Required manual criteria have no trusted user confirmation channel');
  const operationId = randomUUID();
  const put = (name: string, value: unknown) => writeRunEvidence(handle, state.runId, state.revision, recordName(name, operationId), value);
  const workerRecordRef = await put('worker-control', { schemaVersion: 1, kind: 'controlled-worker-ending', ...identity(request), receipt,
    requestRef: options.requestRef, resultRef: options.resultRef, beforeSnapshotRef: { schemaVersion: 1, path: request.snapshotRef, sha256: request.snapshotHash },
    endingSnapshotRef: options.endingSnapshotRef, evidenceRefs: options.workerEvidenceRefs });
  const verificationPlanRef = await put('verification-plan', request.verificationPlan);
  const pending = next(state); pending.status = 'RUNNING'; pending.phase = 'REVALIDATE'; delete pending.stopReason;
  pending.pendingOperation = { schemaVersion: 1, operationId, kind: 'verify', identity: identity(request), scope: request.scope,
    beforeSnapshotRef: options.endingSnapshotRef, beforeSnapshotHash: ending.hash, verificationPlanRef, createdAt: pending.updatedAt };
  state = await compareAndSwapRun(handle, state.runId, state.revision, pending);
  let current = ending; let currentRef = options.endingSnapshotRef;
  const verification: VerificationEvidence[] = []; const commandRecordRefs: EvidenceRef[] = [];
  for (const command of request.verificationPlan.commands) {
    assertVerificationArtifacts(request, initial, current, command.writableArtifacts);
    assertUnchanged(current, await recaptureSnapshot(current));
    const prior = current; const priorRef = currentRef;
    const executed = await runSandbox(services.sandbox, { argv: command.argv, cwd: join(request.repoRoot, command.cwd), repoRoot: request.repoRoot, privateGitDir: state.repoIdentity.privateGitDir,
      writableArtifacts: command.writableArtifacts, timeoutMs: services.commandTimeoutMs ?? 120_000, ...(services.signal ? { signal: services.signal } : {}),
      environment: request.env, expectedFiles: current.snapshot.paths,
      frozenInputs: request.verificationPlan.sources.map((source) => ({ path: source.path, bytes: frozen.files.get(source.path)! })) });
    current = await recaptureSnapshot(prior);
    assertVerificationTransition(initial, prior, current, request, command.writableArtifacts);
    currentRef = await put(`after-${digest(command.id).slice(0, 12)}`, current.snapshot);
    const stdout = await put(`stdout-${digest(command.id).slice(0, 12)}`, { schemaVersion: 1, kind: 'command-output', encoding: 'base64', bytes: executed.stdout.toString('base64') });
    const stderr = await put(`stderr-${digest(command.id).slice(0, 12)}`, { schemaVersion: 1, kind: 'command-output', encoding: 'base64', bytes: executed.stderr.toString('base64') });
    const passed = executed.exitCode === 0 && executed.termination === 'exited' && executed.quiescence === 'confirmed';
    const evidence = parseContract('verificationEvidence', { schemaVersion: 1, ...identity(request), id: command.id, acceptanceIds: command.acceptanceIds, kind: 'command',
      beforeSnapshotHash: prior.hash, afterSnapshotHash: current.hash, startedAt: executed.startedAt, finishedAt: executed.finishedAt,
      result: passed ? 'passed' : executed.exitCode === null ? 'blocked' : 'failed', argv: command.argv, cwd: command.cwd, exitCode: executed.exitCode, stdout, stderr });
    const record = await put(`command-${digest(command.id).slice(0, 12)}`, { schemaVersion: 1, kind: 'controlled-verification', operationId,
      beforeSnapshotRef: priorRef, afterSnapshotRef: currentRef, evidence, namespaceEvidence: executed.namespaceEvidence });
    commandRecordRefs.push(record); verification.push(evidence);
    if (executed.termination === 'aborted') throw new DOMException('Controlled verification was cancelled after confirmed quiescence', 'AbortError');
    requireAcceptance(passed, 'VERIFICATION_FAILED', 'A required controlled command did not pass with confirmed process-tree quiescence');
  }
  for (const check of request.verificationPlan.manual) {
    assertUnchanged(current, await recaptureSnapshot(current));
    const startedAt = at(state);
    const approval = await services.manualControl!.verify({ state: structuredClone(state), request: structuredClone(request), check: structuredClone(check), after: structuredClone(current) });
    const confirmation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readEvidence(handle, state.runId, state.revision, approval.confirmation)));
    requireAcceptance(confirmation?.schemaVersion === 1 && confirmation.kind === 'user-acceptance-confirmation' && confirmation.approved === true
      && sameRecord(confirmation.identity, identity(request)) && confirmation.checkId === check.id && confirmation.snapshotHash === current.hash
      && sameRecord(confirmation.acceptanceIds, check.acceptanceIds) && confirmation.reviewer === approval.reviewer, 'MANUAL_ACCEPTANCE_REQUIRED', 'User confirmation does not bind this exact criterion and boundary');
    const evidence = parseContract('verificationEvidence', { schemaVersion: 1, ...identity(request), id: check.id, acceptanceIds: check.acceptanceIds, kind: 'manual',
      beforeSnapshotHash: current.hash, afterSnapshotHash: current.hash, startedAt, finishedAt: at(state), result: 'passed', reviewer: approval.reviewer, confirmation: approval.confirmation });
    verification.push(evidence); commandRecordRefs.push(await put(`manual-${digest(check.id).slice(0, 12)}`, { schemaVersion: 1, kind: 'controlled-manual-acceptance', operationId, evidence }));
    assertUnchanged(current, await recaptureSnapshot(current));
  }
  const verifiedResult = parseContract('taskExecutionResult', { ...result, verification });
  requireAcceptance(verifiedResult.outcome === 'completed', 'INVALID_RESULT', 'Independent result is not completed');
  const verifiedResultRef = await put('verified-result', verifiedResult);
  const verificationArtifactPaths = assertVerificationTransition(initial, ending, current, request);
  const acceptanceRef = await put('acceptance', { schemaVersion: 1, kind: 'independent-acceptance', operationId, ...identity(request),
    requestRef: options.requestRef, workerResultRef: options.resultRef, verifiedResultRef, frozenInputsRef: options.frozenInputsRef,
    workerRecordRef, commandRecordRefs, planning, taskChangedPaths, verificationArtifactPaths, afterSnapshotRef: currentRef });
  const checkpointRef = await put('verification-checkpoint', { schemaVersion: 1, operationId, kind: 'verify', identity: identity(request), stage: 'verification-passed',
    beforeSnapshotRef: options.endingSnapshotRef, afterSnapshotRef: currentRef, requestRef: options.requestRef, resultRef: verifiedResultRef, evidenceRefs: [acceptanceRef] });
  assertUnchanged(current, await recaptureSnapshot(current));
  const verified = next(state); verified.phase = 'FINALIZE'; verified.pendingOperation = { ...state.pendingOperation!, checkpointRef };
  verified.resultRefs = [...state.resultRefs.filter((entry) => !sameRecord(entry.identity, identity(request))), { identity: identity(request), ref: verifiedResultRef }];
  state = await compareAndSwapRun(handle, state.runId, state.revision, verified);
  const workflow = before.snapshot.gitWorkflowRef;
  const workflowBytes = frozen.files.get(workflow.path);
  requireAcceptance(workflowBytes && digest(workflowBytes) === workflow.sha256, 'INVALID_RESULT', 'Original workflow bytes are missing');
  const capability = Object.freeze({}) as AcceptedTaskCapability;
  accepted.set(capability, { handle, data: { state, request, result: verifiedResult, initial, before: current, beforeRef: currentRef, taskChangedPaths,
    verificationArtifactPaths, verifiedEvidenceRefs: [acceptanceRef], workflow: { path: workflow.path, sha256: workflow.sha256, bytes: Buffer.from(workflowBytes) } } });
  return capability;
}

export async function finalizeWithoutCommit(handle: LockHandle, capability: AcceptedTaskCapability, expectedRevision: number): Promise<RunState> {
  const data = consumeAcceptedTask(capability, handle, expectedRevision);
  requireAcceptance(data.state.authorization.commit === 'deny', 'AUTHORIZATION_VIOLATION', 'This entry point requires no-commit authorization');
  const state = await readRunAtRevision(handle, data.state.runId, expectedRevision);
  requireAcceptance(sameRecord(state, data.state), 'REVISION_CONFLICT', 'Acceptance state no longer matches the current Run');
  assertUnchanged(data.before, await recaptureSnapshot(data.before));
  const result = parseContract('acceptedTaskExecutionResult', { ...data.result, acceptedAt: data.before.snapshot.capturedAt, acceptedSnapshotHash: data.before.hash, verifiedEvidenceRefs: data.verifiedEvidenceRefs });
  const ref = await ensureRunEvidence(handle, state.runId, state.revision, recordName('accepted', state.pendingOperation!.operationId), result);
  const finished = next(state); finished.acceptedSnapshotRef = data.beforeRef; finished.acceptedSnapshotHash = data.before.hash;
  finished.completedTasks = [...state.completedTasks, data.request.taskId];
  finished.resultRefs = [...state.resultRefs.filter((entry) => !sameRecord(entry.identity, identity(data.request))), { identity: identity(data.request), ref }];
  delete finished.pendingOperation; delete finished.stopReason; delete finished.currentTaskId; delete finished.currentAttempt; delete finished.currentRequestId;
  finished.status = state.selectionMode.mode === 'all-ready' ? 'RUNNING' : 'COMPLETED'; finished.phase = finished.status === 'COMPLETED' ? 'FINALIZE' : 'SELECT';
  assertUnchanged(data.before, await recaptureSnapshot(data.before));
  const published = await compareAndSwapRun(handle, state.runId, state.revision, finished);
  await writeSummary(handle, state.runId, published.revision);
  return published;
}

export { AcceptanceError };
