import { parseContract, parseContractJson, type EvidenceRef, type RunState } from '@dev-harness-runtime/contracts';
import { discoverProject } from '../discovery/project.js';
import { acquireLock, releaseLock } from '../lock/index.js';
import { inspectRun } from '../state/inspect.js';
import { ensureRunEvidence, readCurrentRun, readEvidence, readRunEvidenceCandidate } from '../state/index.js';
import { loadRecoveryCheckpoint, sameRecord } from '../recovery/evidence.js';
import { resumeRun } from '../recovery/resume.js';
import { reconcileRun } from '../recovery/reconcile.js';
import { createAcceptanceRecoveryVerifier } from '../result/recovery.js';
import { freezeAcceptanceInputs, identity, recordName, type AcceptanceCriterion } from '../result/frozen.js';
import { resumeAcceptedTaskCommit } from '../authorization/git.js';
import { acceptAndFinalize, dispatchTask, handleRunFailure, readRequest, requireParent, resultOf, runLoop, runtimeAdapter, runtimeExitCode } from './runtime.js';
import { RuntimeError, type ContinueRunOptions, type RuntimeResult, type RuntimeServices } from './types.js';

function reference(value: unknown): EvidenceRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('STATE_CORRUPT', 'Missing evidence reference');
  const ref = value as Record<string, unknown>;
  if (ref.schemaVersion !== 1 || typeof ref.path !== 'string' || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.sha256)
    || Object.keys(ref).length !== 3) throw new RuntimeError('STATE_CORRUPT', 'Invalid evidence reference');
  return { schemaVersion: 1, path: ref.path, sha256: ref.sha256 };
}

export async function resumeRuntimeRun(options: ContinueRunOptions, services: RuntimeServices): Promise<RuntimeResult> {
  requireParent(); options.signal?.throwIfAborted();
  const project = await discoverProject(options.cwd, options.docsRoot === undefined ? {} : { docsRoot: options.docsRoot });
  const observed = await inspectRun(project, options.runId);
  const adapter = await runtimeAdapter(services, project, observed.adapter);
  const handle = await acquireLock(project, { runId: options.runId, adapter: adapter.id });
  let safeToRelease = true;
  let continuing = false;
  try {
    const original = await readCurrentRun(handle, options.runId);
    if (original.revision !== options.expectedRevision) throw new RuntimeError('REVISION_CONFLICT', 'Resume expected revision is stale');
    const verifyQuiescence = async (input: { state: RunState }): Promise<void> => {
      safeToRelease = false; await adapter.verifyQuiescence(input); safeToRelease = true;
    };
    await verifyQuiescence({ state: original });
    const originalCheckpoint = original.pendingOperation?.checkpointRef
      ? await loadRecoveryCheckpoint(handle, original, original.pendingOperation.checkpointRef) : undefined;
    let originalRequest = originalCheckpoint?.request;
    if (!originalRequest && original.pendingOperation?.kind === 'execute' && original.currentRequestId) {
      const dispatch = await readRunEvidenceCandidate(handle, original.runId, original.revision, recordName('dispatch', original.currentRequestId));
      if (dispatch) {
        const record = JSON.parse(dispatch.bytes.toString('utf8')) as Record<string, unknown>;
        originalRequest = await readRequest(handle, original, reference(record.requestRef));
        if (record.schemaVersion !== 1 || !sameRecord({ runId: record.runId, taskId: record.taskId, attempt: record.attempt, requestId: record.requestId }, identity(originalRequest))) {
          throw new RuntimeError('STATE_IDENTITY_MISMATCH', 'Dispatch manifest does not bind the interrupted attempt');
        }
      }
    }
    const verifier = createAcceptanceRecoveryVerifier(handle, { workerControl: adapter.workerControl,
      verifyQuiescence, verifyWorkerCheckpoint: (input) => adapter.verifyCheckpoint(input) });
    const resumed = await resumeRun(handle, options.runId, { expectedRevision: options.expectedRevision, verifier,
      environment: { adapter: adapter.id, authorization: original.authorization, protocolSource: services.protocolSource, adapterConfigHash: services.adapterConfigHash } });
    let state = resumed.state;
    if (resumed.decision.action === 'stopped') return { state, exitCode: runtimeExitCode(new RuntimeError(resumed.decision.code, resumed.decision.message)) };
    safeToRelease = false; continuing = true;
    options.signal?.throwIfAborted();
    if (resumed.decision.action === 'execute-new-session') {
      if (!originalRequest || state.pendingOperation?.kind !== 'execute') throw new RuntimeError('RECOVERY_EVIDENCE_REQUIRED', 'Restart requires the original frozen dispatch request');
      const request = parseContract('taskExecutionRequest', { ...originalRequest, ...state.pendingOperation.identity,
        snapshotRef: state.pendingOperation.beforeSnapshotRef.path, snapshotHash: state.pendingOperation.beforeSnapshotHash });
      const requestRef = await ensureRunEvidence(handle, state.runId, state.revision, recordName('request', request.requestId), request);
      const originalInputs = await readRunEvidenceCandidate(handle, state.runId, state.revision, recordName('inputs', originalRequest.requestId));
      if (!originalInputs) throw new RuntimeError('RECOVERY_EVIDENCE_REQUIRED', 'Original frozen acceptance inputs are missing');
      const inputs = JSON.parse(originalInputs.bytes.toString('utf8')) as { acceptance: AcceptanceCriterion[]; requestId: string; snapshotHash: string };
      if (inputs.requestId !== originalRequest.requestId || inputs.snapshotHash !== originalRequest.snapshotHash) throw new RuntimeError('STATE_IDENTITY_MISMATCH', 'Frozen criteria do not bind the interrupted request');
      // Re-freezing validates the same criteria and exact original plan against the proven current boundary.
      const frozenInputsRef = await freezeAcceptanceInputs(handle, { expectedRevision: state.revision, request, acceptance: inputs.acceptance });
      state = await dispatchTask(handle, project, state, request, requestRef, frozenInputsRef, services, adapter, options.signal);
    } else if (resumed.decision.action === 'adopt-result' || resumed.decision.action === 'revalidate') {
      if (state.authorization.commit === 'task' && state.pendingOperation?.kind === 'verify' && state.pendingOperation.checkpointRef) {
        if (!services.git) throw new RuntimeError('CAPABILITY_MISSING', 'Commit recovery requires a trusted Git policy');
        options.signal?.throwIfAborted();
        state = (await resumeAcceptedTaskCommit(handle, state.runId, { ...services.git, expectedRevision: state.revision, workerControl: adapter.workerControl })).state;
      } else {
      if (!state.currentRequestId) throw new RuntimeError('STATE_IDENTITY_MISMATCH', 'Revalidation requires its original request identity');
      const candidate = await readRunEvidenceCandidate(handle, state.runId, state.revision, recordName('accept-input', state.currentRequestId));
      if (!candidate) throw new RuntimeError('RECOVERY_EVIDENCE_REQUIRED', 'Original acceptance dispatch record is missing');
      const record = JSON.parse(candidate.bytes.toString('utf8')) as Record<string, unknown>;
      const requestRef = reference(record.requestRef);
      const request = await readRequest(handle, state, requestRef);
      if (record.schemaVersion !== 1 || !sameRecord({ runId: record.runId, taskId: record.taskId, attempt: record.attempt, requestId: record.requestId }, identity(request))
        || !Array.isArray(record.workerEvidenceRefs)) throw new RuntimeError('STATE_CORRUPT', 'Acceptance manifest identity mismatch');
      state = await acceptAndFinalize(handle, state, { requestRef, resultRef: reference(record.resultRef), endingSnapshotRef: reference(record.endingSnapshotRef),
        frozenInputsRef: reference(record.frozenInputsRef), workerEvidenceRefs: record.workerEvidenceRefs.map(reference) }, services, adapter, options.signal);
      }
    } else if (resumed.decision.action === 'resume-commit') {
      if (!services.git) throw new RuntimeError('CAPABILITY_MISSING', 'Commit recovery requires a trusted Git policy');
      options.signal?.throwIfAborted();
      state = (await resumeAcceptedTaskCommit(handle, state.runId, { ...services.git, expectedRevision: state.revision, workerControl: adapter.workerControl })).state;
    }
    state = await runLoop(handle, project, state, services, adapter, options.signal);
    await adapter.verifyQuiescence({ state }); safeToRelease = true;
    return resultOf(state);
  } catch (error) {
    if (!continuing) throw error;
    const result = await handleRunFailure(handle, options.runId, error, adapter); safeToRelease = true; return result;
  } finally { if (safeToRelease) await releaseLock(handle); }
}

export interface ReconcileRuntimeOptions extends Omit<ContinueRunOptions, 'signal'> { resolutionRef: EvidenceRef }
export async function reconcileRuntimeRun(options: ReconcileRuntimeOptions, services: RuntimeServices): Promise<RuntimeResult> {
  requireParent();
  const project = await discoverProject(options.cwd, options.docsRoot === undefined ? {} : { docsRoot: options.docsRoot });
  const observed = await inspectRun(project, options.runId);
  const adapter = await runtimeAdapter(services, project, observed.adapter);
  if (!sameRecord(services.protocolSource, observed.protocolSource) || services.adapterConfigHash !== observed.adapterConfigHash) throw new RuntimeError('ENVIRONMENT_MISMATCH', 'Reconciliation cannot change protocol or Adapter configuration');
  const handle = await acquireLock(project, { runId: options.runId, adapter: adapter.id });
  let safeToRelease = true;
  try {
    const state: RunState = await readCurrentRun(handle, options.runId);
    safeToRelease = false; await adapter.verifyQuiescence({ state }); safeToRelease = true;
    // Read and validate the explicit, already persisted resolution; no directory discovery or inferred approval.
    parseContractJson('reconciliationResolution', (await readEvidence(handle, state.runId, options.expectedRevision, options.resolutionRef)).toString('utf8'));
    return { state: await reconcileRun(handle, state.runId, options.expectedRevision, options.resolutionRef, { project, ...services.reconciliation }), exitCode: 0 };
  } finally { if (safeToRelease) await releaseLock(handle); }
}
