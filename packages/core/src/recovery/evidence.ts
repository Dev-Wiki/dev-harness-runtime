import { createHash } from 'node:crypto';
import { isRepoPath, parseContractJson, validateResultForRequest, type EvidenceRef, type RunState } from '@dev-harness-runtime/contracts';
import type { LockHandle } from '../lock/index.js';
import { readEvidence } from '../state/index.js';
import { serializeSnapshot, snapshotBoundaryHash } from '../snapshot/capture.js';
import { assertUnchanged } from '../snapshot/guard.js';
import type { CapturedSnapshot } from '../snapshot/types.js';
import { RecoveryError, type RecoveryCheckpoint, type RecoveryEvidenceContext } from './types.js';

export function sameRecord(left: unknown, right: unknown): boolean {
  const normalized = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, child]) => [name, normalized(child)]));
    return value;
  };
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RecoveryError('INVALID_RECOVERY_CHECKPOINT', message);
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): object {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a checkpoint object');
  requireValue(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)), 'Checkpoint has missing or unknown fields');
  return value;
}
function field(value: object, key: string): unknown { return Reflect.get(value, key); }
function text(value: unknown, pattern: RegExp): string {
  requireValue(typeof value === 'string' && pattern.test(value), 'Invalid checkpoint identifier'); return value;
}
function evidenceRef(value: unknown): EvidenceRef {
  const ref = record(value, ['schemaVersion', 'path', 'sha256']);
  requireValue(field(ref, 'schemaVersion') === 1, 'Unsupported evidence version');
  const path = field(ref, 'path'); requireValue(typeof path === 'string' && isRepoPath(path), 'Invalid evidence path');
  return { schemaVersion: 1, path, sha256: text(field(ref, 'sha256'), /^[a-f0-9]{64}$/u) };
}

/** Strict Core record format. Parsing establishes structure only, never provenance. */
export function parseRecoveryCheckpoint(input: unknown): RecoveryCheckpoint {
  const value = record(input, ['schemaVersion', 'operationId', 'kind', 'identity', 'stage', 'beforeSnapshotRef', 'afterSnapshotRef', 'evidenceRefs'], ['requestRef', 'resultRef']);
  requireValue(field(value, 'schemaVersion') === 1, 'Unsupported recovery checkpoint version');
  const identity = record(field(value, 'identity'), ['runId', 'taskId', 'attempt', 'requestId']);
  const attempt = field(identity, 'attempt'); requireValue(typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 1, 'Invalid attempt');
  const kind = field(value, 'kind'); requireValue(kind === 'execute' || kind === 'verify' || kind === 'commit', 'Unknown operation kind');
  const stage = field(value, 'stage'); requireValue(stage === 'execute-intent' || stage === 'worker-checkpoint' || stage === 'worker-ended' || stage === 'verification-passed' || stage === 'index-staged', 'Unknown checkpoint stage');
  requireValue((kind === 'execute' && ['execute-intent', 'worker-checkpoint', 'worker-ended'].includes(stage)) || (kind === 'verify' && stage === 'verification-passed') || (kind === 'commit' && stage === 'index-staged'), 'Checkpoint kind/stage mismatch');
  const refs = field(value, 'evidenceRefs'); requireValue(Array.isArray(refs) && refs.length > 0, 'Checkpoint needs persistent controlled evidence');
  const result: RecoveryCheckpoint = {
    schemaVersion: 1, operationId: text(field(value, 'operationId'), /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u), kind, stage,
    identity: { runId: text(field(identity, 'runId'), /^[a-z0-9][a-z0-9-]{0,63}$/u), taskId: text(field(identity, 'taskId'), /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u), attempt,
      requestId: text(field(identity, 'requestId'), /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u) },
    beforeSnapshotRef: evidenceRef(field(value, 'beforeSnapshotRef')), afterSnapshotRef: evidenceRef(field(value, 'afterSnapshotRef')), evidenceRefs: refs.map(evidenceRef),
  };
  if (Object.hasOwn(value, 'requestRef')) result.requestRef = evidenceRef(field(value, 'requestRef'));
  if (Object.hasOwn(value, 'resultRef')) result.resultRef = evidenceRef(field(value, 'resultRef'));
  requireValue(stage === 'index-staged' || result.requestRef !== undefined, 'Worker/verification checkpoints require the exact execution request');
  requireValue(!['worker-ended', 'verification-passed'].includes(stage) || result.resultRef !== undefined, 'Completed checkpoints require the exact result');
  requireValue(new Set(result.evidenceRefs.map((ref) => ref.path.toLowerCase())).size === result.evidenceRefs.length, 'Checkpoint evidence references must be unique');
  requireValue(stage !== 'execute-intent' || sameRecord(result.beforeSnapshotRef, result.afterSnapshotRef), 'New execution intent cannot claim a performed transition');
  return result;
}

function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RecoveryError('STATE_CORRUPT', 'Recovery evidence is not valid UTF-8 JSON'); }
}

export async function loadRecoverySnapshot(handle: LockHandle, state: RunState, ref: EvidenceRef): Promise<CapturedSnapshot> {
  const raw = await readEvidence(handle, state.runId, state.revision, ref);
  const snapshot = parseContractJson('snapshot', new TextDecoder('utf-8', { fatal: true }).decode(raw));
  const serialized = Buffer.from(serializeSnapshot(snapshot));
  if (!raw.equals(serialized)) throw new RecoveryError('STATE_CORRUPT', 'Snapshot evidence is not its canonical serialized representation');
  if (snapshot.runId !== state.runId || snapshot.repoIdentity.repoRoot !== state.repoIdentity.repoRoot || snapshot.repoIdentity.privateGitDir !== state.repoIdentity.privateGitDir
    || !sameRecord(snapshot.protocolSource, state.protocolSource) || snapshot.adapterConfigHash !== state.adapterConfigHash) {
    throw new RecoveryError('STATE_IDENTITY_MISMATCH', 'Snapshot does not bind this Run, worktree, protocol and Adapter configuration');
  }
  const capture = { snapshot, hash: createHash('sha256').update(serialized).digest('hex'), boundaryHash: snapshotBoundaryHash(snapshot), dirtyPaths: [...snapshot.dirtyPaths], stagedPaths: [...snapshot.stagedPaths] };
  assertUnchanged(capture, capture);
  return capture;
}

export async function loadRecoveryCheckpoint(handle: LockHandle, state: RunState, ref: EvidenceRef): Promise<RecoveryEvidenceContext> {
  const pending = state.pendingOperation;
  if (!pending) throw new RecoveryError('INVALID_RECOVERY_CHECKPOINT', 'No pending operation can bind this checkpoint');
  const checkpoint = parseRecoveryCheckpoint(json(await readEvidence(handle, state.runId, state.revision, ref)));
  if (checkpoint.operationId !== pending.operationId || checkpoint.kind !== pending.kind || !sameRecord(checkpoint.identity, pending.identity)
    || !sameRecord(checkpoint.beforeSnapshotRef, pending.beforeSnapshotRef) || checkpoint.beforeSnapshotRef.sha256 !== pending.beforeSnapshotHash) {
    throw new RecoveryError('INVALID_RECOVERY_CHECKPOINT', 'Checkpoint does not identify the pending operation and before boundary');
  }
  const before = await loadRecoverySnapshot(handle, state, checkpoint.beforeSnapshotRef);
  const after = await loadRecoverySnapshot(handle, state, checkpoint.afterSnapshotRef);
  const evidence = [];
  for (const evidenceRef of checkpoint.evidenceRefs) evidence.push({ ref: evidenceRef, bytes: await readEvidence(handle, state.runId, state.revision, evidenceRef) });
  if (checkpoint.stage === 'execute-intent') {
    requireValue(evidence.length === 1, 'Execution continuation requires one precise predecessor checkpoint');
    const prior = parseRecoveryCheckpoint(json(evidence[0]!.bytes));
    requireValue(prior.kind === 'execute' && (prior.stage === 'worker-checkpoint' || prior.stage === 'execute-intent')
      && prior.identity.runId === checkpoint.identity.runId && prior.identity.taskId === checkpoint.identity.taskId
      && prior.identity.attempt + 1 === checkpoint.identity.attempt && prior.identity.requestId !== checkpoint.identity.requestId
      && sameRecord(prior.afterSnapshotRef, checkpoint.beforeSnapshotRef), 'Continuation does not bind the preceding attempt and ending boundary');
  }
  const context: RecoveryEvidenceContext = { state, checkpoint, checkpointRef: ref, before, after, evidence };
  if (checkpoint.requestRef) {
    const bytes = await readEvidence(handle, state.runId, state.revision, checkpoint.requestRef);
    const request = parseContractJson('taskExecutionRequest', new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!sameRecord({ runId: request.runId, taskId: request.taskId, attempt: request.attempt, requestId: request.requestId }, pending.identity)
      || !sameRecord(request.scope, pending.scope) || request.repoRoot !== state.repoIdentity.repoRoot
      || !sameRecord(request.protocolSource, state.protocolSource) || request.env.DEV_HARNESS_ADAPTER !== state.adapter) {
      throw new RecoveryError('INVALID_RECOVERY_CHECKPOINT', 'Checkpoint request does not bind the pending execution');
    }
    const requestSnapshot = await loadRecoverySnapshot(handle, state, { schemaVersion: 1, path: request.snapshotRef, sha256: request.snapshotHash });
    if (pending.kind === 'execute' && requestSnapshot.hash !== pending.beforeSnapshotHash) throw new RecoveryError('INVALID_RECOVERY_CHECKPOINT', 'Execution request and pending before snapshot disagree');
    context.request = request;
  }
  if (checkpoint.resultRef) {
    if (!context.request) throw new RecoveryError('INVALID_RECOVERY_CHECKPOINT', 'Result evidence requires a bound request');
    context.result = validateResultForRequest(context.request, json(await readEvidence(handle, state.runId, state.revision, checkpoint.resultRef)));
  }
  return context;
}

export function copyRecoveryContext(context: RecoveryEvidenceContext): RecoveryEvidenceContext {
  return { ...structuredClone(context), evidence: context.evidence.map(({ ref, bytes }) => ({ ref: structuredClone(ref), bytes: Buffer.from(bytes) })) };
}
