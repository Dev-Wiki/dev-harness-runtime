import { basename, dirname, join, relative, sep } from 'node:path';
import {
  isRepoPath, parseContractJson, type EvidenceRef, type ReconciliationResolution, type RunState,
} from '@dev-harness-runtime/contracts';
import type { ProjectContext } from '../discovery/project.js';
import { readProjectText, resolveProjectPath } from '../discovery/paths.js';
import type { LockHandle } from '../lock/index.js';
import { readPlan } from '../planning/reader.js';
import { links, parseMarkdown, section, tables, textOf } from '../planning/markdown.js';
import type { PlanningDocument, PlanningReference } from '../planning/types.js';
import { recaptureSnapshot, serializeSnapshot } from '../snapshot/capture.js';
import type { CapturedSnapshot } from '../snapshot/types.js';
import {
  compareAndSwapRun, initializeRun, listRunIds, readCurrentRun, readEvidence, readRunAtRevision,
  resumeRunInitialization, type RunInitializationSeed,
} from '../state/index.js';
import { loadRecoverySnapshot, sameRecord } from './evidence.js';
import { RecoveryError } from './types.js';

/** Supplied by trusted Core code, never populated from resolution text or Worker reports. */
export interface ReconciliationVerifier {
  project: ProjectContext;
  verifyEvidence?(input: { state: RunState; resolution: ReconciliationResolution; ref: EvidenceRef; bytes: Buffer }): Promise<boolean>;
  /** Independently revalidate the latest canonical archive/closure chain and all required acceptance. */
  verifyArchivedTask?(input: {
    state: RunState; resolution: ReconciliationResolution; taskId: string;
    plan: PlanningDocument; current: CapturedSnapshot;
  }): Promise<PlanningReference | null>;
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RecoveryError('PENDING_RECONCILIATION', message);
}
function denyWorker(): void {
  if (process.env.DEV_HARNESS_WORKER === '1') throw new RecoveryError('AUTHORIZATION_VIOLATION', 'Worker environments cannot reconcile or create a Run');
}
function time(state: RunState): string { return new Date(Math.max(Date.now(), Date.parse(state.updatedAt))).toISOString(); }
function operationIdentity(state: RunState) {
  const pending = state.pendingOperation;
  requireValue(pending, 'Reconciliation requires the original pending operation');
  return { operationId: pending.operationId, kind: pending.kind, identity: pending.identity };
}
function bindProject(state: RunState, verifier: ReconciliationVerifier): void {
  requireValue(verifier.project.repoRoot === state.repoIdentity.repoRoot
    && verifier.project.privateGitDir === state.repoIdentity.privateGitDir, 'Reconciliation project does not bind the locked Run');
}
async function resolutionRecord(handle: LockHandle, state: RunState, ref: EvidenceRef): Promise<ReconciliationResolution> {
  const raw = await readEvidence(handle, state.runId, state.revision, ref);
  return parseContractJson('reconciliationResolution', new TextDecoder('utf-8', { fatal: true }).decode(raw));
}
async function currentMatches(snapshot: CapturedSnapshot): Promise<void> {
  const current = await recaptureSnapshot(snapshot);
  requireValue(current.boundaryHash === snapshot.boundaryHash, 'Actual project boundary differs from the recorded reconciliation snapshot');
}

async function verifyArchive(reference: PlanningReference, taskId: string, current: CapturedSnapshot, project: ProjectContext): Promise<void> {
  const prefix = `${relative(project.repoRoot, join(project.docsRoot, 'plan', 'archive')).split(sep).join('/')}/`;
  const name = basename(reference.path);
  const closure = name.startsWith(`${taskId}.closure-`) ? name.slice(`${taskId}.closure-`.length) : '';
  requireValue(isRepoPath(reference.path) && reference.path.startsWith(prefix)
    && (name === `${taskId}.md` || /^[1-9][0-9]*\.md$/u.test(closure)), 'Verifier did not identify the affected Task archive');
  const recorded = current.snapshot.paths.find((entry) => entry.path === reference.path);
  requireValue(recorded?.type === 'file' && recorded.rawContentHash === reference.sha256, 'Verified archive does not match the declared current snapshot');
  const path = await resolveProjectPath(project.repoRoot, project.repoRoot, reference.path);
  const document = parseMarkdown(await readProjectText(path), path);
  const heading = document.tokens.findIndex((token) => token.type === 'heading_open' && token.tag === 'h1');
  const title = textOf(document.tokens[heading + 1]?.children ?? []);
  requireValue(/^(?:任务\s+)?([A-Za-z][A-Za-z0-9._-]{0,63})(?:：|\s+—\s+)/u.exec(title)?.[1] === taskId, 'Archive heading does not identify the affected Task');
  const checks = section(document, '验收标准').filter((token) => token.type === 'inline' && /^\[[ xX]\]/u.test(token.content));
  requireValue(checks.length > 0 && checks.every((token) => /^\[[xX]\]\s+\S/u.test(token.content)), 'Archive contains incomplete acceptance items');
  requireValue(links(section(document, '验证证据')).length > 0, 'Archive has no acceptance evidence references');
  const indexPath = await resolveProjectPath(project.repoRoot, dirname(path), 'README.md');
  const index = parseMarkdown(await readProjectText(indexPath), indexPath);
  const matches = tables(index, index.tokens).flatMap((table) => table.rows).filter((row) => row.get('任务编号')?.text === taskId);
  let indexed = false;
  for (const row of matches) {
    for (const link of links(row.get('详情')?.tokens ?? [])) {
      if (await resolveProjectPath(project.repoRoot, dirname(indexPath), link.href) === path) indexed = true;
    }
  }
  requireValue(indexed, 'Verified archive is absent from its milestone index');
}

/** Validate explicit human alignment without changing Task files or accepting the failed execution. */
export async function reconcileRun(handle: LockHandle, runId: string, expectedRevision: number, inputRef: EvidenceRef, verifier: ReconciliationVerifier): Promise<RunState> {
  denyWorker();
  const ref = structuredClone(inputRef);
  const state = await readRunAtRevision(handle, runId, expectedRevision);
  bindProject(state, verifier);
  requireValue(state.reconciliation === undefined, 'An existing reconciliation is immutable and cannot be replaced');
  requireValue(['FAILED', 'BLOCKED', 'INTERRUPTED'].includes(state.status), 'Only a stopped Run with a pending operation can be reconciled');
  const originalPendingIdentity = operationIdentity(state);
  const resolution = await resolutionRecord(handle, state, ref);
  requireValue(resolution.runId === runId && resolution.expectedRevision === expectedRevision, 'Resolution does not bind the original Run revision');
  requireValue(resolution.taskIds.includes(originalPendingIdentity.identity.taskId), 'Resolution must include the pending Task');
  requireValue(new Set(resolution.taskIds).size === resolution.taskIds.length, 'Resolution repeats affected Task identities');
  requireValue(Date.parse(resolution.createdAt) >= Date.parse(state.createdAt) && Date.parse(resolution.createdAt) <= Date.now(), 'Resolution date does not belong to this Run');
  requireValue(typeof verifier.verifyEvidence === 'function', 'Core evidence provenance verifier is required');
  const current = await loadRecoverySnapshot(handle, state, resolution.currentSnapshotRef);
  requireValue(current.hash === resolution.currentSnapshotHash, 'Resolution snapshot digest mismatch');
  await currentMatches(current);
  // Original boundaries remain verifiable historical evidence after alignment.
  await loadRecoverySnapshot(handle, state, state.initialUserChangesRef);
  await loadRecoverySnapshot(handle, state, state.acceptedSnapshotRef);
  await loadRecoverySnapshot(handle, state, state.pendingOperation!.beforeSnapshotRef);
  for (const ref of resolution.evidenceRefs) {
    const bytes = await readEvidence(handle, runId, expectedRevision, ref);
    requireValue(await verifier.verifyEvidence({ state: structuredClone(state), resolution: structuredClone(resolution), ref: structuredClone(ref), bytes }) === true,
      'Core could not verify alignment evidence within the original authorization');
  }
  const plan = await readPlan(verifier.project);
  for (const taskId of resolution.taskIds) {
    const active = plan.tasks.find((task) => task.id === taskId);
    if (active) {
      requireValue(active.contextComplete, 'Restored active Task has incomplete execution context');
      continue;
    }
    requireValue(typeof verifier.verifyArchivedTask === 'function', 'Keeping a completed archive requires independent Core acceptance');
    const archive = await verifier.verifyArchivedTask({ state: structuredClone(state), resolution: structuredClone(resolution), taskId,
      plan: structuredClone(plan), current: structuredClone(current) });
    requireValue(archive !== null, 'Core did not revalidate the retained Task archive');
    await verifyArchive(archive, taskId, current, verifier.project);
  }
  await currentMatches(current);
  const resolvedAt = time(state);
  return compareAndSwapRun(handle, runId, expectedRevision, { ...state, revision: expectedRevision + 1, updatedAt: resolvedAt,
    reconciliation: { schemaVersion: 1, originalRevision: expectedRevision, originalPendingIdentity,
      resolutionRef: ref, resolvedBy: resolution.resolvedBy, currentSnapshotRef: resolution.currentSnapshotRef,
      currentSnapshotHash: resolution.currentSnapshotHash, taskIds: resolution.taskIds, evidenceRefs: resolution.evidenceRefs, resolvedAt } });
}

async function alignedSnapshot(handle: LockHandle, state: RunState): Promise<CapturedSnapshot> {
  const record = state.reconciliation;
  requireValue(record, 'Source Run has no explicit reconciliation');
  requireValue(sameRecord(operationIdentity(state), record.originalPendingIdentity), 'Original pending history no longer matches reconciliation');
  requireValue(['FAILED', 'BLOCKED', 'INTERRUPTED'].includes(state.status), 'Reconciliation source history is no longer stopped');
  const resolution = await resolutionRecord(handle, state, record.resolutionRef);
  requireValue(resolution.runId === state.runId && resolution.expectedRevision === record.originalRevision
    && resolution.taskIds.includes(record.originalPendingIdentity.identity.taskId)
    && resolution.resolvedBy === record.resolvedBy && sameRecord(resolution.currentSnapshotRef, record.currentSnapshotRef)
    && resolution.currentSnapshotHash === record.currentSnapshotHash && sameRecord(resolution.taskIds, record.taskIds)
    && sameRecord(resolution.evidenceRefs, record.evidenceRefs), 'Persistent reconciliation does not match its resolution evidence');
  for (const ref of record.evidenceRefs) await readEvidence(handle, state.runId, state.revision, ref);
  await loadRecoverySnapshot(handle, state, state.initialUserChangesRef);
  await loadRecoverySnapshot(handle, state, state.acceptedSnapshotRef);
  await loadRecoverySnapshot(handle, state, state.pendingOperation!.beforeSnapshotRef);
  for (const result of state.resultRefs) await readEvidence(handle, state.runId, state.revision, result.ref);
  const current = await loadRecoverySnapshot(handle, state, record.currentSnapshotRef);
  requireValue(current.hash === record.currentSnapshotHash, 'Reconciliation history snapshot digest mismatch');
  return current;
}

async function records(handle: LockHandle, allowIncompleteRunId?: string): Promise<Map<string, RunState>> {
  try {
    const ids = await listRunIds(handle, allowIncompleteRunId === undefined ? {} : { allowIncompleteRunId });
    const result = new Map<string, RunState>();
    for (const id of ids) {
      try { result.set(id, await readCurrentRun(handle, id)); }
      catch (error) {
        if (id === allowIncompleteRunId && error instanceof Error && 'code' in error && error.code === 'STATE_INCOMPLETE') continue;
        throw error;
      }
    }
    return result;
  } catch (error) {
    throw new RecoveryError('PENDING_RECONCILIATION', `Cannot establish all authoritative Run records: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function successorSeed(source: RunState, snapshot: CapturedSnapshot): RunInitializationSeed {
  const record = source.reconciliation;
  requireValue(record?.successor, 'Source has no persistent successor reservation');
  const { runId, reservedAt } = record.successor;
  return { schemaVersion: 1, revision: 0, runId, adapter: source.adapter, status: 'CREATED', phase: 'DISCOVERY',
    repoIdentity: structuredClone(snapshot.snapshot.repoIdentity), selectionMode: structuredClone(source.selectionMode),
    protocolSource: structuredClone(source.protocolSource), adapterConfigHash: source.adapterConfigHash,
    completedTasks: [], resultRefs: [], authorization: { ...source.authorization, runId }, createdAt: reservedAt, updatedAt: reservedAt,
    reconciledFrom: { runId: source.runId, revision: record.originalRevision + 1,
      resolutionHash: record.resolutionRef.sha256, snapshotHash: record.currentSnapshotHash } };
}

async function validateSuccessor(handle: LockHandle, source: RunState, successor: RunState, snapshot: CapturedSnapshot): Promise<void> {
  const seed = successorSeed(source, snapshot);
  requireValue(sameRecord(successor.reconciledFrom, seed.reconciledFrom), 'Successor reverse binding does not match the explicit source');
  for (const key of ['runId', 'adapter', 'repoIdentity', 'selectionMode', 'protocolSource', 'adapterConfigHash', 'authorization', 'createdAt'] as const) {
    requireValue(sameRecord(successor[key], seed[key]), 'Successor immutable creation identity differs from its reservation');
  }
  const initial = await loadRecoverySnapshot(handle, successor, successor.initialUserChangesRef);
  requireValue(serializeSnapshot(initial.snapshot) === serializeSnapshot({ ...snapshot.snapshot, runId: successor.runId }), 'Successor initial snapshot is not the reconciled boundary');
  await loadRecoverySnapshot(handle, successor, successor.acceptedSnapshotRef);
}

async function checkRecords(handle: LockHandle, all: Map<string, RunState>, verifier: ReconciliationVerifier, permittedSource?: string): Promise<void> {
  const plan = await readPlan(verifier.project);
  const reserved = new Map<string, string>();
  for (const source of all.values()) {
    bindProject(source, verifier);
    const target = source.reconciliation?.successor?.runId;
    if (target !== undefined) {
      requireValue(target !== source.runId && !reserved.has(target), 'Duplicate successor consumption or a self-cycle');
      reserved.set(target, source.runId);
    }
  }
  for (const source of all.values()) {
    const visited = new Set<string>();
    let at: RunState | undefined = source;
    while (at) {
      requireValue(!visited.has(at.runId), 'Reconciliation successor cycle'); visited.add(at.runId);
      at = all.get(at.reconciliation?.successor?.runId ?? '');
    }
    if (source.reconciledFrom) {
      requireValue(reserved.get(source.runId) === source.reconciledFrom.runId, 'Run claims an unreserved or mismatched reconciliation source');
    }
    if (source.reconciliation) {
      const snapshot = await alignedSnapshot(handle, source);
      const reservation = source.reconciliation.successor;
      const successor = reservation ? all.get(reservation.runId) : undefined;
      const consumers = [...all.values()].filter((run) => run.reconciledFrom?.runId === source.runId);
      requireValue(consumers.length <= 1 && (!consumers[0] || consumers[0].runId === reservation?.runId), 'Reconciliation has multiple or unreserved consumers');
      if (source.runId === permittedSource) {
        if (successor) await validateSuccessor(handle, source, successor, snapshot);
        else await currentMatches(snapshot);
        continue;
      }
      requireValue(reservation?.createdAt && successor, 'Explicit reconciliation must be consumed through its reserved successor');
      requireValue(reservation.createdAt === successor.createdAt, 'Successor creation marker does not match the initialized Run');
      await validateSuccessor(handle, source, successor, snapshot);
      continue;
    }
    requireValue(source.pendingOperation === undefined, 'A previous Run still has an unresolved pending operation');
    // Acquiring a fresh filesystem lock is not proof that an old Run's process tree stopped.
    // The specifically reserved successor may still be CREATED while its initialization is retried.
    const initializingSuccessor = permittedSource !== undefined && reserved.get(source.runId) === permittedSource;
    requireValue(initializingSuccessor || !['CREATED', 'RUNNING'].includes(source.status), 'A previous Run is still active; prove quiescence and resume or explicitly stop it before starting another Run');
    if (source.currentTaskId && !source.completedTasks.includes(source.currentTaskId)) {
      requireValue(plan.tasks.some((task) => task.id === source.currentTaskId), 'A previous unaccepted Task has an unknown completed archive');
    }
    const accepted = await loadRecoverySnapshot(handle, source, source.acceptedSnapshotRef);
    await loadRecoverySnapshot(handle, source, source.initialUserChangesRef);
    for (const result of source.resultRefs) await readEvidence(handle, source.runId, source.revision, result.ref);
    // Closed history is not a permanent pin on all future project work.
    if (!['COMPLETED', 'FAILED'].includes(source.status)) await currentMatches(accepted);
  }
}

/** Must precede every ordinary new Run; a pending operation cannot be bypassed with a new ID. */
export async function assertNewRunAllowed(handle: LockHandle, verifier: ReconciliationVerifier): Promise<void> {
  denyWorker();
  try { await checkRecords(handle, await records(handle), verifier); }
  catch (error) {
    if (error instanceof RecoveryError && error.code === 'PENDING_RECONCILIATION') throw error;
    throw new RecoveryError('PENDING_RECONCILIATION', `Existing Run history cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reserve exactly one ID before initialization; repeated calls can only finish that same ID. */
export async function createReconciledSuccessor(handle: LockHandle, sourceRunId: string, expectedRevision: number, successorRunId: string, verifier: ReconciliationVerifier): Promise<RunState> {
  denyWorker();
  let source = await readRunAtRevision(handle, sourceRunId, expectedRevision);
  bindProject(source, verifier);
  requireValue(/^[a-z0-9][a-z0-9-]{0,63}$/u.test(successorRunId) && sourceRunId !== successorRunId, 'Invalid successor Run identity');
  const snapshot = await alignedSnapshot(handle, source);
  const reservation = source.reconciliation!.successor;
  requireValue(reservation === undefined || reservation.runId === successorRunId, 'Reconciliation has already reserved another successor ID');
  const all = await records(handle, reservation?.runId);
  await checkRecords(handle, all, verifier, sourceRunId);
  if (reservation === undefined) {
    requireValue(!all.has(successorRunId), 'Successor identity already exists');
    const reservedAt = time(source);
    source = await compareAndSwapRun(handle, sourceRunId, source.revision, { ...source, revision: source.revision + 1, updatedAt: reservedAt,
      reconciliation: { ...source.reconciliation!, successor: { runId: successorRunId, reservedAt } } });
  }
  const seed = successorSeed(source, snapshot);
  const initial = { ...snapshot.snapshot, runId: successorRunId };
  let successor: RunState;
  try { successor = await resumeRunInitialization(handle, seed, initial); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'STATE_NOT_FOUND') throw error;
    successor = await initializeRun(handle, seed, initial);
  }
  await validateSuccessor(handle, source, successor, snapshot);
  if (source.reconciliation!.successor!.createdAt === undefined) {
    const updatedAt = time(source);
    await compareAndSwapRun(handle, sourceRunId, source.revision, { ...source, revision: source.revision + 1, updatedAt,
      reconciliation: { ...source.reconciliation!, successor: { ...source.reconciliation!.successor!, createdAt: successor.createdAt } } });
  }
  return successor;
}
