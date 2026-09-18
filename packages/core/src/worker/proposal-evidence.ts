import { parseContract, type EvidenceRef, type TaskExecutionRequest, type TaskExecutionResult } from '@dev-harness-runtime/contracts';
import type { LockHandle } from '../lock/index.js';
import { loadRecoverySnapshot, sameRecord } from '../recovery/evidence.js';
import { identity, recordName } from '../result/frozen.js';
import { assertUnchanged } from '../snapshot/guard.js';
import { recaptureSnapshot } from '../snapshot/capture.js';
import { ensureRunEvidence, readEvidence, readRunAtRevision } from '../state/index.js';
import { WorkerProposalCollector, WorkerProposalError } from './proposals.js';

export interface ProposedFileOperation {
  readonly path: string;
  readonly content: Uint8Array | null;
}

async function boundCollector(handle: LockHandle, expectedRevision: number, input: TaskExecutionRequest): Promise<WorkerProposalCollector> {
  const request = parseContract('taskExecutionRequest', input);
  const state = await readRunAtRevision(handle, request.runId, expectedRevision);
  const pending = state.pendingOperation;
  if (pending?.kind !== 'execute' || !sameRecord(pending.identity, identity(request))
    || !sameRecord(pending.scope, request.scope) || !sameRecord(pending.beforeSnapshotRef,
      { schemaVersion: 1, path: request.snapshotRef, sha256: request.snapshotHash })
    || pending.beforeSnapshotHash !== request.snapshotHash
    || state.currentTaskId !== request.taskId || state.currentAttempt !== request.attempt
    || state.currentRequestId !== request.requestId || state.adapter !== request.env.DEV_HARNESS_ADAPTER
    || state.repoIdentity.repoRoot !== request.repoRoot || !sameRecord(state.protocolSource, request.protocolSource)
    || !sameRecord({ ...state.authorization, commit: 'deny' }, request.authorization)) {
    throw new WorkerProposalError('AUTHORIZATION_VIOLATION', 'Proposal evidence does not bind the pending Core execution');
  }
  const before = await loadRecoverySnapshot(handle, state, pending.beforeSnapshotRef);
  return new WorkerProposalCollector(request, before);
}

/** Durable proposal candidate, published only while the exact attempt is executing. It is not host-control proof. */
export async function persistWorkerProposals(handle: LockHandle, expectedRevision: number, request: TaskExecutionRequest,
  result: TaskExecutionResult, operations: readonly ProposedFileOperation[]): Promise<EvidenceRef> {
  const state = await readRunAtRevision(handle, request.runId, expectedRevision);
  if (state.status !== 'RUNNING' || state.phase !== 'EXECUTE') {
    throw new WorkerProposalError('AUTHORIZATION_VIOLATION', 'Only a running execution may publish proposal evidence');
  }
  const collector = await boundCollector(handle, expectedRevision, request);
  const before = await loadRecoverySnapshot(handle, state, state.pendingOperation!.beforeSnapshotRef);
  assertUnchanged(before, await recaptureSnapshot(before));
  for (const operation of operations) {
    if (operation.content === null) collector.delete(operation.path);
    else collector.write(operation.path, operation.content);
  }
  collector.assertDeclaredChanges(result);
  const ref = await ensureRunEvidence(handle, request.runId, expectedRevision, recordName('worker-proposals', request.requestId), collector.record());
  const restored = await loadWorkerProposals(handle, expectedRevision, request, ref);
  restored.assertDeclaredChanges(result);
  return ref;
}

/** Recheck the immutable bytes and exact pending attempt before recovery or controlled application. */
export async function loadWorkerProposals(handle: LockHandle, expectedRevision: number, request: TaskExecutionRequest,
  ref: EvidenceRef): Promise<WorkerProposalCollector> {
  if (ref.path !== `results/run-evidence/${recordName('worker-proposals', request.requestId)}.json`) {
    throw new WorkerProposalError('INVALID_RESULT', 'Proposal evidence reference is not the current attempt record');
  }
  await boundCollector(handle, expectedRevision, request);
  const state = await readRunAtRevision(handle, request.runId, expectedRevision);
  const before = await loadRecoverySnapshot(handle, state, state.pendingOperation!.beforeSnapshotRef);
  const bytes = await readEvidence(handle, request.runId, expectedRevision, ref);
  let record: unknown;
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new WorkerProposalError('INVALID_RESULT', 'Stored proposal evidence is not UTF-8 JSON'); }
  return WorkerProposalCollector.restore(request, before, record);
}
