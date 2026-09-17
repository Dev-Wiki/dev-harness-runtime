import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseContract, parseContractJson, requireExecutionCapabilities, validateResultForRequest, type EvidenceRef, type RunState, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { discoverProject, type ProjectContext } from '../discovery/project.js';
import { acquireLock, releaseLock, type LockHandle } from '../lock/index.js';
import { readPlan } from '../planning/reader.js';
import { selectTask } from '../planning/selector.js';
import { captureSnapshot, recaptureSnapshot } from '../snapshot/capture.js';
import { assertTaskStart, assertUnchanged } from '../snapshot/guard.js';
import { loadRecoverySnapshot, sameRecord } from '../recovery/evidence.js';
import { assertNewRunAllowed } from '../recovery/reconcile.js';
import { appendAttemptLog, compareAndSwapRun, createAttempt, ensureRunEvidence, initializeRun, readCurrentRun, readEvidence, writeResult, writeSummary } from '../state/index.js';
import { freezeAcceptanceInputs, identity, recordName } from '../result/frozen.js';
import { finalizeWithoutCommit, verifyTaskAcceptance, type VerifyTaskAcceptanceOptions } from '../result/acceptance.js';
import { commitAcceptedTask } from '../authorization/git.js';
import { prepareWorkerInvocation } from '../worker/prompt.js';
import { RuntimeError, type RuntimeAdapter, type RuntimeResult, type RuntimeServices, type StartRunOptions } from './types.js';

export function requireParent(): void {
  if (process.env.DEV_HARNESS_WORKER === '1') throw new RuntimeError('AUTHORIZATION_VIOLATION', 'Workers cannot invoke run, resume or reconcile');
}
export function runtimeExitCode(error: unknown): number {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (error instanceof Error && error.name === 'AbortError') return 130;
  if (/^(?:INVALID_ARGUMENT|UNKNOWN_ADAPTER|CAPABILITY_MISSING|INVALID_SELECTION|TASK_NOT_FOUND)$/u.test(code)) return 2;
  if (/BLOCKED|MANUAL_ACCEPTANCE_REQUIRED/u.test(code)) return 3;
  if (/DRIFT|AUTHORIZATION|OWNERSHIP|LOCK|REVISION|RECONCILIATION|ENVIRONMENT_MISMATCH|USER_CHANGES/u.test(code)) return 5;
  return 4;
}
export const nextState = (state: RunState): RunState => ({ ...structuredClone(state), revision: state.revision + 1,
  updatedAt: new Date(Math.max(Date.now(), Date.parse(state.updatedAt))).toISOString() });
export async function publish(handle: LockHandle, state: RunState, next: RunState): Promise<RunState> {
  return compareAndSwapRun(handle, state.runId, state.revision, next);
}
export async function stopRun(handle: LockHandle, state: RunState, code: string, message: string,
  status: 'BLOCKED' | 'FAILED' | 'INTERRUPTED'): Promise<RunState> {
  const next = nextState(state); next.status = status; next.stopReason = { code, message: message.slice(0, 4096) || code };
  state = await publish(handle, state, next); await writeSummary(handle, state.runId, state.revision); return state;
}
export async function runtimeAdapter(services: RuntimeServices, project: ProjectContext, id: string): Promise<Readonly<RuntimeAdapter>> {
  let adapter: Readonly<RuntimeAdapter>;
  try { adapter = services.adapters.get(id); } catch { throw new RuntimeError('UNKNOWN_ADAPTER', `Unknown Adapter: ${id}`); }
  if (adapter.executor.id !== id) throw new RuntimeError('CAPABILITY_MISSING', 'Adapter and Executor identities differ');
  const environment = parseContract('hostEnvironment', await adapter.environment(project));
  if (environment.repoRoot !== project.repoRoot || environment.privateGitDir !== project.privateGitDir || environment.configHash !== services.adapterConfigHash) {
    throw new RuntimeError('ENVIRONMENT_MISMATCH', 'Host environment does not bind the discovered project and configuration');
  }
  const capabilities = parseContract('executorCapabilities', await adapter.executor.probe(environment));
  if (capabilities.adapterId !== id) throw new RuntimeError('CAPABILITY_MISSING', 'Probe belongs to another Adapter');
  requireExecutionCapabilities(capabilities);
  return adapter;
}
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
const refOf = (request: TaskExecutionRequest): EvidenceRef => ({ schemaVersion: 1, path: request.snapshotRef, sha256: request.snapshotHash });

/** Persist the Core-owned dispatch record before the host receives any instruction. */
export async function dispatchTask(handle: LockHandle, project: ProjectContext, state: RunState, request: TaskExecutionRequest,
  requestRef: EvidenceRef, frozenInputsRef: EvidenceRef, services: RuntimeServices, adapter: Readonly<RuntimeAdapter>, signal?: AbortSignal): Promise<RunState> {
  const before = await loadRecoverySnapshot(handle, state, refOf(request));
  const invocation = prepareWorkerInvocation(request, services.workerSkill);
  await ensureRunEvidence(handle, state.runId, state.revision, recordName('dispatch', request.requestId),
    { schemaVersion: 1, ...identity(request), requestRef, frozenInputsRef });
  const intent = { schemaVersion: 1, operationId: state.pendingOperation!.operationId, kind: 'execute', stage: 'execute-intent',
    identity: identity(request), beforeSnapshotRef: refOf(request), afterSnapshotRef: refOf(request), requestRef, evidenceRefs: [frozenInputsRef] };
  // The pending execute operation is the initial intent. An execute-intent
  // checkpoint is reserved for a verified predecessor chain created by recovery.
  // Capture this revision for the entire stream; never permit late chunks to enter the next attempt.
  const executionRevision = state.revision;
  await adapter.prepareInvocation({ request: structuredClone(request), invocation,
    log: (stream, bytes) => appendAttemptLog(handle, state.runId, executionRevision, identity(request), stream, bytes) });
  assertUnchanged(before, await recaptureSnapshot(before)); aborted(signal);
  const result = validateResultForRequest(request, await adapter.executor.execute(structuredClone(request), signal ?? new AbortController().signal));
  await adapter.verifyQuiescence({ state: structuredClone(state) });
  const ending = await captureSnapshot({ project, runId: state.runId, protocolSource: state.protocolSource, adapterConfigHash: state.adapterConfigHash });
  const endingSnapshotRef = await ensureRunEvidence(handle, state.runId, state.revision, recordName('ending', request.requestId), ending.snapshot);
  const resultRef = await writeResult(handle, state.runId, state.revision, result);
  const records = await adapter.collectEvidence({ request: structuredClone(request), before, after: ending });
  if (records.length === 0) throw new RuntimeError('CAPABILITY_MISSING', 'Host supplied no controlled ending evidence');
  const workerEvidenceRefs: EvidenceRef[] = [];
  for (const [index, record] of records.entries()) workerEvidenceRefs.push(await ensureRunEvidence(handle, state.runId, state.revision,
    recordName(`host-${index}`, request.requestId), record));
  // Resolve provenance before making even a failed attempt's ending checkpoint recoverable.
  const evidence = await Promise.all(workerEvidenceRefs.map(async (ref) => ({ ref, bytes: await readEvidence(handle, state.runId, state.revision, ref) })));
  const receipt = await adapter.workerControl.verify({ state, request, before, after: ending, evidence });
  if (receipt.authorizationEnforced !== true || receipt.quiescent !== true || !receipt.sessionId || !receipt.providerId) {
    throw new RuntimeError('AUTHORIZATION_VIOLATION', 'Host controller did not establish permission enforcement and quiescence');
  }
  const manifest = { schemaVersion: 1, ...identity(request), requestRef, resultRef, endingSnapshotRef, frozenInputsRef, workerEvidenceRefs };
  await ensureRunEvidence(handle, state.runId, state.revision, recordName('accept-input', request.requestId), manifest);
  const endedRef = await ensureRunEvidence(handle, state.runId, state.revision, recordName('worker-ended', request.requestId),
    { ...intent, stage: 'worker-ended', afterSnapshotRef: endingSnapshotRef, resultRef, evidenceRefs: workerEvidenceRefs });
  state = await publish(handle, state, { ...nextState(state), pendingOperation: { ...state.pendingOperation!, checkpointRef: endedRef },
    resultRefs: [...state.resultRefs, { identity: identity(request), ref: resultRef }] });
  if (result.outcome !== 'completed') return stopRun(handle, state, `WORKER_${result.outcome.toUpperCase()}`, `Worker returned ${result.outcome}; independent completion was not accepted`,
    result.outcome === 'blocked' ? 'BLOCKED' : result.outcome === 'partial' ? 'INTERRUPTED' : 'FAILED');
  aborted(signal);
  return acceptAndFinalize(handle, state, manifest, services, adapter, signal);
}

export async function acceptAndFinalize(handle: LockHandle, state: RunState,
  input: Omit<VerifyTaskAcceptanceOptions, 'runId' | 'expectedRevision'>, services: RuntimeServices,
  adapter: Readonly<RuntimeAdapter>, signal?: AbortSignal): Promise<RunState> {
  const capability = await verifyTaskAcceptance(handle, { ...input, runId: state.runId, expectedRevision: state.revision },
    { ...services.acceptance, workerControl: adapter.workerControl, ...(signal ? { signal } : {}) });
  state = await readCurrentRun(handle, state.runId);
  aborted(signal);
  if (state.authorization.commit === 'deny') return finalizeWithoutCommit(handle, capability, state.revision);
  if (!services.git) throw new RuntimeError('CAPABILITY_MISSING', 'No trusted Git commit policy is configured');
  return (await commitAcceptedTask(handle, capability, { ...services.git, expectedRevision: state.revision })).state;
}

/** Every iteration rereads the authoritative Dashboard inside the accepted content boundary. */
export async function runLoop(handle: LockHandle, project: ProjectContext, state: RunState, services: RuntimeServices,
  adapter: Readonly<RuntimeAdapter>, signal?: AbortSignal): Promise<RunState> {
  while (!['COMPLETED', 'FAILED', 'BLOCKED', 'INTERRUPTED'].includes(state.status)) {
    aborted(signal);
    const accepted = await loadRecoverySnapshot(handle, state, state.acceptedSnapshotRef);
    assertUnchanged(accepted, await recaptureSnapshot(accepted));
    const plan = await readPlan(project);
    assertUnchanged(accepted, await recaptureSnapshot(accepted));
    const selected = selectTask(plan, state.selectionMode);
    if (selected.status === 'blocked') return stopRun(handle, state, 'TASK_BLOCKED', selected.reasons.map((reason) => `${reason.taskId}: ${reason.code}`).join('; '), 'BLOCKED');
    if (selected.status === 'completed') {
      state = await publish(handle, state, { ...nextState(state), status: 'COMPLETED', phase: 'FINALIZE' });
      await writeSummary(handle, state.runId, state.revision); return state;
    }
    const before = await captureSnapshot({ project, runId: state.runId, protocolSource: state.protocolSource,
      adapterConfigHash: state.adapterConfigHash, currentTaskPath: selected.task.taskPath, planningReferences: plan.references });
    assertUnchanged(accepted, await recaptureSnapshot(accepted));
    const prepared = await services.prepareTask({ project, plan, task: selected.task, before });
    const initial = await loadRecoverySnapshot(handle, state, state.initialUserChangesRef);
    assertTaskStart(initial, before, prepared.scope);
    if (join(project.repoRoot, prepared.scope.planning.taskPath) !== selected.task.taskPath || prepared.scope.planning.taskId !== selected.task.id
      || join(project.repoRoot, prepared.scope.planning.dashboardPath) !== project.dashboardPath) throw new RuntimeError('AUTHORIZATION_VIOLATION', 'Prepared scope does not bind the selected Task');
    assertUnchanged(before, await recaptureSnapshot(before));
    const requestId = randomUUID();
    const snapshotRef = await ensureRunEvidence(handle, state.runId, state.revision, recordName('before', requestId), before.snapshot);
    const attemptIdentity = { runId: state.runId, taskId: selected.task.id, attempt: 1, requestId };
    const next = nextState(state);
    Object.assign(next, { status: 'RUNNING', phase: 'EXECUTE', currentTaskId: selected.task.id, currentAttempt: 1, currentRequestId: requestId,
      pendingOperation: { schemaVersion: 1, operationId: randomUUID(), kind: 'execute', identity: attemptIdentity, scope: prepared.scope,
        beforeSnapshotRef: snapshotRef, beforeSnapshotHash: snapshotRef.sha256, createdAt: next.updatedAt } });
    state = await publish(handle, state, next);
    await createAttempt(handle, state.runId, state.revision, attemptIdentity);
    const request = parseContract('taskExecutionRequest', { schemaVersion: 1, coreProtocolVersion: 1, ...attemptIdentity,
      repoRoot: project.repoRoot, docsRoot: project.docsRoot, dashboardPath: project.dashboardPath, taskPath: selected.task.taskPath,
      snapshotRef: snapshotRef.path, snapshotHash: snapshotRef.sha256, scope: prepared.scope, authorization: { ...state.authorization, commit: 'deny' },
      verificationPlan: prepared.verificationPlan, protocolSource: state.protocolSource,
      env: { DEV_HARNESS_WORKER: '1', DEV_HARNESS_RUN_ID: state.runId, DEV_HARNESS_TASK_ID: selected.task.id, DEV_HARNESS_ADAPTER: state.adapter } });
    const frozenInputsRef = await freezeAcceptanceInputs(handle, { expectedRevision: state.revision, request, acceptance: prepared.acceptance });
    const requestRef = await ensureRunEvidence(handle, state.runId, state.revision, recordName('request', requestId), request);
    state = await dispatchTask(handle, project, state, request, requestRef, frozenInputsRef, services, adapter, signal);
  }
  return state;
}

export function resultOf(state: RunState): RuntimeResult {
  return { state, exitCode: state.status === 'COMPLETED' ? 0 : state.status === 'BLOCKED' ? 3 : state.stopReason?.code === 'CANCELLED' ? 130 : 4 };
}
export async function handleRunFailure(handle: LockHandle, runId: string, error: unknown, adapter: Readonly<RuntimeAdapter>): Promise<RuntimeResult> {
  let state = await readCurrentRun(handle, runId);
  if (error instanceof Error && 'code' in error && error.code === 'QUIESCENCE_UNKNOWN') {
    await stopRun(handle, state, 'QUIESCENCE_UNKNOWN', error.message, 'INTERRUPTED');
    // Worker quiescence cannot prove that an independent verifier namespace stopped.
    // Propagate so the owner retains the lock and the provider's preserved evidence.
    throw error;
  }
  // A lock release is never used as proof that an execution process has stopped.
  await adapter.verifyQuiescence({ state });
  const exitCode = runtimeExitCode(error);
  const code = error instanceof Error && 'code' in error && /^[A-Z][A-Z0-9_]*$/u.test(String(error.code)) ? String(error.code)
    : exitCode === 130 ? 'CANCELLED' : 'EXECUTION_FAILED';
  state = await stopRun(handle, state, code, error instanceof Error ? error.message : 'Runtime execution failed',
    exitCode === 130 ? 'INTERRUPTED' : exitCode === 3 ? 'BLOCKED' : 'FAILED');
  return { state, exitCode };
}

export async function startRuntimeRun(options: StartRunOptions, services: RuntimeServices): Promise<RuntimeResult> {
  requireParent(); aborted(options.signal);
  const project = await discoverProject(options.cwd, options.docsRoot === undefined ? {} : { docsRoot: options.docsRoot });
  const adapter = await runtimeAdapter(services, project, options.adapter);
  const runId = options.runId ?? randomUUID();
  const authorization = parseContract('runAuthorization', { schemaVersion: 1, runId, commit: options.commit ?? 'deny', push: false, pullRequest: false, tag: false, release: false, deploy: false });
  if (authorization.commit === 'task' && !services.git) throw new RuntimeError('CAPABILITY_MISSING', 'Task commits require a trusted Core Git policy');
  // Validate selector before publishing a new Run; the loop still rereads and reselects under lock.
  selectTask(await readPlan(project), options.selection);
  const handle = await acquireLock(project, { runId, adapter: adapter.id });
  let initialized = false;
  let safeToRelease = true;
  try {
    await assertNewRunAllowed(handle, { project, ...services.reconciliation });
    const initial = await captureSnapshot({ project, runId, protocolSource: services.protocolSource, adapterConfigHash: services.adapterConfigHash });
    const now = new Date().toISOString();
    const state = await initializeRun(handle, { schemaVersion: 1, revision: 0, runId, adapter: adapter.id, status: 'CREATED', phase: 'DISCOVERY',
      repoIdentity: initial.snapshot.repoIdentity, selectionMode: options.selection, protocolSource: services.protocolSource,
      adapterConfigHash: services.adapterConfigHash, completedTasks: [], resultRefs: [], authorization, createdAt: now, updatedAt: now }, initial.snapshot);
    initialized = true; safeToRelease = false;
    const result = resultOf(await runLoop(handle, project, state, services, adapter, options.signal));
    await adapter.verifyQuiescence({ state: result.state }); safeToRelease = true; return result;
  } catch (error) {
    if (!initialized) throw error;
    const result = await handleRunFailure(handle, runId, error, adapter); safeToRelease = true; return result;
  } finally { if (safeToRelease) await releaseLock(handle); }
}

export async function readRequest(handle: LockHandle, state: RunState, ref: EvidenceRef): Promise<TaskExecutionRequest> {
  const request = parseContractJson('taskExecutionRequest', (await readEvidence(handle, state.runId, state.revision, ref)).toString('utf8'));
  if (!state.pendingOperation || !sameRecord(identity(request), state.pendingOperation.identity)) throw new RuntimeError('STATE_IDENTITY_MISMATCH', 'Request does not bind the current attempt');
  return request;
}
