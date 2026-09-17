import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import {
  isRepoPath, parseContract, parseContractJson,
  type EvidenceRef, type RunState, type Snapshot, type TaskExecutionRequest, type TaskExecutionResult,
} from '@dev-harness-runtime/contracts';
import { withLock, type LockContext, type LockHandle } from '../lock/index.js';
import { recaptureSnapshot, serializeSnapshot, snapshotBoundaryHash } from '../snapshot/capture.js';
import { atomicWrite, checkedFile, hasCode, makeDirectory, readBytes, requireDirectory, syncDirectory } from './files.js';
import { StateError } from './errors.js';

export { StateError, type StateErrorCode } from './errors.js';
export type AttemptIdentity = Pick<TaskExecutionRequest, 'runId' | 'taskId' | 'attempt' | 'requestId'>;
export type RunInitializationSeed = Omit<RunState, 'initialUserChangesRef' | 'initialUserChangesHash' | 'acceptedSnapshotRef' | 'acceptedSnapshotHash'>;
export interface AttemptPaths { path: string; stdoutPath: string; stderrPath: string; eventsPath: string; snapshotsPath: string }
const bytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new StateError('REVISION_CONFLICT', 'Expected revision must be a nonnegative safe integer');
}
function checkedRunId(runId: string): void {
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(runId)) throw new StateError('STATE_PATH_INVALID', 'Invalid Run directory identity');
}
function bind(context: LockContext, runId: string, state: RunState): void {
  if (state.runId !== runId || state.authorization.runId !== runId
    || state.repoIdentity.repoRoot !== context.repoRoot || state.repoIdentity.privateGitDir !== context.privateGitDir) {
    throw new StateError('STATE_IDENTITY_MISMATCH', 'Run record does not bind its directory and locked worktree');
  }
}
async function root(context: LockContext, runId: string): Promise<string> {
  checkedRunId(runId);
  if (context.stateRoot !== join(context.privateGitDir, 'dev-harness-runtime', 'runs')) throw new StateError('STATE_PATH_INVALID', 'Unexpected private state root');
  await requireDirectory(context.stateRoot);
  return join(context.stateRoot, runId);
}
async function loadCurrent(context: LockContext, runId: string): Promise<RunState> {
  const directory = await root(context, runId);
  try { await requireDirectory(directory); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) throw new StateError('STATE_NOT_FOUND', 'Run directory does not exist', directory);
    throw error;
  }
  const path = join(directory, 'run.json');
  let raw;
  try { raw = await readBytes(path); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) throw new StateError('STATE_INCOMPLETE', 'Run directory exists without an authoritative run.json', directory);
    throw error;
  }
  let state;
  try { state = parseContractJson('runState', new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new StateError('STATE_CORRUPT', 'Authoritative run.json is not a supported, valid Run record', path); }
  bind(context, runId, state);
  return state;
}
async function load(context: LockContext, runId: string, expectedRevision: number): Promise<RunState> {
  revision(expectedRevision);
  const state = await loadCurrent(context, runId);
  if (state.revision !== expectedRevision) throw new StateError('REVISION_CONFLICT', `Expected revision ${expectedRevision}, found ${state.revision}`);
  return state;
}

/** Create once; existing or interrupted Run directories are never silently reused. */
export async function createRun(handle: LockHandle, input: RunState): Promise<RunState> {
  const initial = clone(input);
  return withLock(handle, async (context) => {
    const state = parseContract('runState', initial);
    bind(context, state.runId, state);
    if (state.revision !== 0 || state.status !== 'CREATED' || state.phase !== 'DISCOVERY') throw new StateError('STATE_CORRUPT', 'New Runs must begin at revision zero in CREATED/DISCOVERY');
    const directory = await root(context, state.runId);
    await context.assertOwner();
    await makeDirectory(directory);
    await mkdir(join(directory, 'attempts'), { mode: 0o700 });
    await mkdir(join(directory, 'results'), { mode: 0o700 });
    await atomicWrite(context, join(directory, 'run.json'), bytes(state), false);
    return clone(state);
  });
}

export async function readRunAtRevision(handle: LockHandle, runId: string, expectedRevision: number): Promise<RunState> {
  return withLock(handle, (context) => { revision(expectedRevision); return load(context, runId, expectedRevision); });
}

/** Diagnostic authority read under the worktree lock; never scans result timestamps. */
export async function readCurrentRun(handle: LockHandle, runId: string): Promise<RunState> {
  return withLock(handle, (context) => loadCurrent(context, runId));
}

/** Only a Core-verified successor reservation may authorize the optional incomplete ID. */
export async function listRunIds(handle: LockHandle, options: { allowIncompleteRunId?: string } = {}): Promise<string[]> {
  const permitted = options.allowIncompleteRunId;
  return withLock(handle, async (context) => {
    if (permitted !== undefined) checkedRunId(permitted);
    await requireDirectory(context.stateRoot);
    const result: string[] = [];
    for (const name of (await readdir(context.stateRoot)).sort()) {
      if (name === '.orchestrator.lock' || name === '.orchestrator.guard') continue;
      checkedRunId(name);
      try { await loadCurrent(context, name); }
      catch (error) {
        if (!(error instanceof StateError) || error.code !== 'STATE_INCOMPLETE' || name !== permitted) throw error;
      }
      result.push(name);
    }
    return result;
  });
}

/** repoIdentity is the immutable creation identity; current Git boundaries live in accepted snapshots. */
export async function compareAndSwapRun(handle: LockHandle, runId: string, expectedRevision: number, input: RunState): Promise<RunState> {
  const candidate = clone(input);
  return withLock(handle, async (context) => {
    const previous = await load(context, runId, expectedRevision);
    if (expectedRevision === Number.MAX_SAFE_INTEGER) throw new StateError('REVISION_OVERFLOW', 'Run revision cannot advance beyond the safe integer range');
    const next = parseContract('runState', candidate);
    bind(context, runId, next);
    if (next.revision !== expectedRevision + 1) throw new StateError('REVISION_CONFLICT', 'CAS must advance exactly one revision');
    for (const key of ['runId', 'adapter', 'repoIdentity', 'authorization', 'createdAt', 'selectionMode', 'protocolSource', 'adapterConfigHash', 'initialUserChangesRef', 'initialUserChangesHash', 'reconciledFrom'] as const) {
      if (stable(previous[key]) !== stable(next[key])) throw new StateError('STATE_IDENTITY_MISMATCH', `CAS cannot change immutable Run field ${key}`);
    }
    if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) throw new StateError('STATE_CORRUPT', 'CAS cannot move updatedAt backwards');
    await atomicWrite(context, join(await root(context, runId), 'run.json'), bytes(next), true);
    return clone(next);
  });
}

function attemptName(runId: string, identity: AttemptIdentity): string {
  if (identity.runId !== runId || typeof identity.taskId !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(identity.taskId)
    || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1 || typeof identity.requestId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(identity.requestId)) throw new StateError('STATE_IDENTITY_MISMATCH', 'Attempt identity does not bind this Run');
  return `${identity.taskId}-${identity.attempt}`;
}
function currentIdentity(state: RunState, identity: AttemptIdentity): void {
  if (state.currentTaskId !== identity.taskId || state.currentAttempt !== identity.attempt || state.currentRequestId !== identity.requestId) throw new StateError('STATE_IDENTITY_MISMATCH', 'Evidence does not bind the current Run attempt');
}

export async function createAttempt(handle: LockHandle, runId: string, expectedRevision: number, input: AttemptIdentity): Promise<AttemptPaths> {
  const identity = clone(input);
  return withLock(handle, async (context) => {
    const state = await load(context, runId, expectedRevision);
    const name = attemptName(runId, identity);
    currentIdentity(state, identity);
    const path = join(await root(context, runId), 'attempts', name);
    await context.assertOwner();
    await makeDirectory(path);
    const paths = { path, stdoutPath: join(path, 'stdout.log'), stderrPath: join(path, 'stderr.log'), eventsPath: join(path, 'events.jsonl'), snapshotsPath: join(path, 'snapshots') };
    for (const log of [paths.stdoutPath, paths.stderrPath, paths.eventsPath]) {
      const file = await open(log, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await file.sync(); } finally { await file.close(); }
    }
    await mkdir(paths.snapshotsPath, { mode: 0o700 });
    await syncDirectory(path);
    return paths;
  });
}

function reference(path: string, content: Buffer): EvidenceRef { return { schemaVersion: 1, path, sha256: hash(content) }; }
export async function writeResult(handle: LockHandle, runId: string, expectedRevision: number, input: TaskExecutionResult): Promise<EvidenceRef> {
  const candidate = clone(input);
  return withLock(handle, async (context) => {
    const state = await load(context, runId, expectedRevision);
    const result = parseContract('taskExecutionResult', candidate);
    const name = attemptName(runId, result);
    currentIdentity(state, result);
    await requireDirectory(join(await root(context, runId), 'attempts', name));
    const path = `results/${name}.json`;
    const content = bytes(result);
    await atomicWrite(context, join(await root(context, runId), path), content, false);
    return reference(path, content);
  });
}

export async function writeSnapshot(handle: LockHandle, runId: string, expectedRevision: number, inputIdentity: AttemptIdentity, name: string, input: Snapshot): Promise<EvidenceRef> {
  const identity = clone(inputIdentity); const candidate = clone(input);
  return withLock(handle, async (context) => {
    const state = await load(context, runId, expectedRevision);
    const attempt = attemptName(runId, identity);
    currentIdentity(state, identity);
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(name)) throw new StateError('STATE_PATH_INVALID', 'Invalid snapshot evidence name');
    const snapshot = parseContract('snapshot', candidate);
    if (snapshot.runId !== runId || snapshot.repoIdentity.repoRoot !== context.repoRoot || snapshot.repoIdentity.privateGitDir !== context.privateGitDir) throw new StateError('STATE_IDENTITY_MISMATCH', 'Snapshot evidence does not bind this Run/worktree');
    const path = `attempts/${attempt}/snapshots/${name}.json`;
    const content = Buffer.from(serializeSnapshot(snapshot), 'utf8');
    await atomicWrite(context, join(await root(context, runId), path), content, false);
    return reference(path, content);
  });
}

function evidencePath(path: string): void {
  const attempt = '[A-Za-z][A-Za-z0-9._-]{0,63}-[1-9][0-9]*';
  if (!isRepoPath(path) || !(new RegExp(`^(?:results/${attempt}\\.json|results/run-evidence/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\\.json|attempts/${attempt}/(?:stdout\\.log|stderr\\.log|events\\.jsonl|snapshots/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\\.json)|summary\\.json)$`, 'u')).test(path)) {
    throw new StateError('STATE_PATH_INVALID', 'Evidence reference is outside the declared Run layout', path);
  }
}
export async function readEvidence(handle: LockHandle, runId: string, expectedRevision: number, input: EvidenceRef): Promise<Buffer> {
  const ref = clone(input);
  return withLock(handle, async (context) => {
    await load(context, runId, expectedRevision);
    if (ref.schemaVersion !== 1 || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.sha256) || typeof ref.path !== 'string') throw new StateError('EVIDENCE_MISMATCH', 'Invalid evidence reference');
    evidencePath(ref.path);
    const content = await readBytes(join(await root(context, runId), ref.path));
    if (hash(content) !== ref.sha256) throw new StateError('EVIDENCE_MISMATCH', 'Evidence contents no longer match the recorded digest', ref.path);
    return content;
  });
}

/** Rebuildable projection only; no caller-provided status can become authority. */
export async function writeSummary(handle: LockHandle, runId: string, expectedRevision: number): Promise<EvidenceRef> {
  return withLock(handle, async (context) => {
    const state = await load(context, runId, expectedRevision);
    const content = bytes({ schemaVersion: 1, runId, revision: state.revision, status: state.status, phase: state.phase,
      completedTasks: state.completedTasks, resultRefs: state.resultRefs, updatedAt: state.updatedAt,
      ...(state.currentTaskId === undefined ? {} : { currentTaskId: state.currentTaskId }),
      ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }) });
    const path = join(await root(context, runId), 'summary.json');
    await checkedFile(path, true);
    await atomicWrite(context, path, content, true);
    return reference('summary.json', content);
  });
}

function jsonValue(value: unknown, parents = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || parents.has(value)) throw new StateError('STATE_CORRUPT', 'Evidence must contain finite, acyclic JSON values');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new StateError('STATE_CORRUPT', 'Evidence must contain plain JSON records');
  parents.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) jsonValue(child, parents);
  parents.delete(value);
}

/** Sorted object keys, original array order, finite JSON primitives and one final LF. */
export function serializeRunInitializationSeed(seed: RunInitializationSeed): string {
  jsonValue(seed);
  for (const key of ['initialUserChangesRef', 'initialUserChangesHash', 'acceptedSnapshotRef', 'acceptedSnapshotHash']) {
    if (Object.hasOwn(seed, key)) throw new StateError('STATE_CORRUPT', 'Initialization seed must omit generated snapshot references');
  }
  return `${stable(seed)}\n`;
}

function evidenceName(name: string): void {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(name)) throw new StateError('STATE_PATH_INVALID', 'Invalid Run evidence name');
}

function runEvidenceContent(context: LockContext, runId: string, value: unknown): Buffer {
  jsonValue(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('schemaVersion' in value) || value.schemaVersion !== 1) throw new StateError('STATE_CORRUPT', 'Run evidence requires schemaVersion 1');
  if ('runId' in value && value.runId !== runId) throw new StateError('STATE_IDENTITY_MISMATCH', 'Run evidence belongs to another Run');
  let encoded = `${stable(value)}\n`;
  if ('repoIdentity' in value && 'paths' in value && 'capturedAt' in value) {
    const snapshot = parseContract('snapshot', value);
    if (snapshot.repoIdentity.repoRoot !== context.repoRoot || snapshot.repoIdentity.privateGitDir !== context.privateGitDir) throw new StateError('STATE_IDENTITY_MISMATCH', 'Snapshot evidence belongs to another worktree');
    encoded = serializeSnapshot(snapshot);
  }
  return Buffer.from(encoded, 'utf8');
}

export interface RunEvidenceCandidate { ref: EvidenceRef; bytes: Buffer }
async function candidateAt(context: LockContext, runId: string, name: string): Promise<RunEvidenceCandidate | undefined> {
  evidenceName(name);
  const results = join(await root(context, runId), 'results');
  await requireDirectory(results);
  const directory = join(results, 'run-evidence');
  try { await lstat(directory); }
  catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
  await requireDirectory(directory);
  const path = `results/run-evidence/${name}.json`;
  const absolute = join(directory, `${name}.json`);
  // checkedFile also rejects a case alias even when the exact spelling is absent.
  await checkedFile(absolute, true);
  try { await lstat(absolute); }
  catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
  const content = await readBytes(absolute);
  return { ref: reference(path, content), bytes: content };
}

/** Read exactly one named candidate. The caller must validate its schema, identity and provenance. */
export async function readRunEvidenceCandidate(handle: LockHandle, runId: string, expectedRevision: number, name: string): Promise<RunEvidenceCandidate | undefined> {
  return withLock(handle, async (context) => {
    await load(context, runId, expectedRevision);
    return candidateAt(context, runId, name);
  });
}

async function storeRunEvidence(handle: LockHandle, runId: string, expectedRevision: number, name: string, input: unknown, reuseIdentical: boolean): Promise<EvidenceRef> {
  const value = clone(input);
  return withLock(handle, async (context) => {
    await load(context, runId, expectedRevision);
    evidenceName(name);
    const content = runEvidenceContent(context, runId, value);
    if (reuseIdentical) {
      const existing = await candidateAt(context, runId, name);
      if (existing !== undefined) {
        if (!existing.bytes.equals(content)) throw new StateError('EVIDENCE_EXISTS', 'Immutable named evidence differs from the proposed content', existing.ref.path);
        return existing.ref;
      }
    }
    const directory = join(await root(context, runId), 'results', 'run-evidence');
    try { await requireDirectory(directory); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; await context.assertOwner(); await makeDirectory(directory); }
    const path = `results/run-evidence/${name}.json`;
    await atomicWrite(context, join(await root(context, runId), path), content, false);
    return reference(path, content);
  });
}

export async function writeRunEvidence(handle: LockHandle, runId: string, expectedRevision: number, name: string, input: unknown): Promise<EvidenceRef> {
  return storeRunEvidence(handle, runId, expectedRevision, name, input, false);
}

/** Retry-safe immutable publication: only exact canonical bytes can reuse a fixed name. */
export async function ensureRunEvidence(handle: LockHandle, runId: string, expectedRevision: number, name: string, input: unknown): Promise<EvidenceRef> {
  return storeRunEvidence(handle, runId, expectedRevision, name, input, true);
}

function prepareInitialization(context: LockContext, seed: RunInitializationSeed, input: Snapshot) {
  const seedHash = hash(Buffer.from(serializeRunInitializationSeed(seed), 'utf8'));
  const snapshot = parseContract('snapshot', input);
  const content = Buffer.from(serializeSnapshot(snapshot), 'utf8');
  const ref = reference('results/run-evidence/initial.json', content);
  const state = parseContract('runState', { ...seed, initialUserChangesRef: ref, initialUserChangesHash: ref.sha256,
    acceptedSnapshotRef: ref, acceptedSnapshotHash: ref.sha256 });
  bind(context, state.runId, state);
  if (state.revision !== 0 || state.status !== 'CREATED' || state.phase !== 'DISCOVERY' || state.currentTaskId !== undefined
    || state.pendingOperation !== undefined || state.reconciliation !== undefined || state.completedTasks.length > 0 || state.resultRefs.length > 0) {
    throw new StateError('STATE_CORRUPT', 'Initialization requires an unused CREATED/DISCOVERY seed at revision zero');
  }
  if (snapshot.runId !== state.runId || stable(snapshot.repoIdentity) !== stable(state.repoIdentity)
    || stable(snapshot.protocolSource) !== stable(state.protocolSource) || snapshot.adapterConfigHash !== state.adapterConfigHash) {
    throw new StateError('STATE_IDENTITY_MISMATCH', 'Initial snapshot must match the Run creation identity, protocol and configuration');
  }
  const manifest = Buffer.from(`${stable({ schemaVersion: 1, runId: state.runId, seedHash, initialSnapshotRef: ref })}\n`, 'utf8');
  return { snapshot, content, manifest, state };
}

async function verifyInitialReality(snapshot: Snapshot): Promise<void> {
  const captured = { snapshot, hash: hash(Buffer.from(serializeSnapshot(snapshot), 'utf8')), boundaryHash: snapshotBoundaryHash(snapshot),
    dirtyPaths: [...snapshot.dirtyPaths], stagedPaths: [...snapshot.stagedPaths] };
  const current = await recaptureSnapshot(captured);
  if (current.boundaryHash !== captured.boundaryHash) throw new StateError('EVIDENCE_MISMATCH', 'Initial snapshot does not match the current actual project boundary');
}

/** Persist real Run-level evidence before the sole authority, without a synthetic Task/attempt. */
export async function initializeRun(handle: LockHandle, inputSeed: RunInitializationSeed, inputSnapshot: Snapshot): Promise<RunState> {
  const seed = clone(inputSeed); const input = clone(inputSnapshot);
  return withLock(handle, async (context) => {
    const prepared = prepareInitialization(context, seed, input);
    await verifyInitialReality(prepared.snapshot);
    const directory = await root(context, prepared.state.runId);
    await context.assertOwner(); await makeDirectory(directory);
    await makeDirectory(join(directory, 'attempts'));
    await makeDirectory(join(directory, 'results'));
    const evidence = join(directory, 'results', 'run-evidence');
    await makeDirectory(evidence);
    await atomicWrite(context, join(evidence, 'initial.json'), prepared.content, false);
    await atomicWrite(context, join(evidence, 'initialization.json'), prepared.manifest, false);
    await atomicWrite(context, join(directory, 'run.json'), bytes(prepared.state), false);
    return clone(prepared.state);
  });
}

async function exactDirectory(path: string, expected: string[]): Promise<void> {
  await requireDirectory(path);
  if (stable((await readdir(path)).sort()) !== stable([...expected].sort())) throw new StateError('STATE_INCOMPLETE', 'Initialization has missing evidence or unknown side effects; explicit inspection is required', path);
}

/** Resume only the same immutable initialization intent; never erase leftovers or replace a Run. */
export async function resumeRunInitialization(handle: LockHandle, inputSeed: RunInitializationSeed, inputSnapshot: Snapshot): Promise<RunState> {
  const seed = clone(inputSeed); const input = clone(inputSnapshot);
  return withLock(handle, async (context) => {
    const prepared = prepareInitialization(context, seed, input);
    const runId = prepared.state.runId;
    const directory = await root(context, runId);
    try { await requireDirectory(directory); }
    catch (error) { if (hasCode(error, 'ENOENT')) throw new StateError('STATE_NOT_FOUND', 'Reserved Run has not begun initialization', directory); throw error; }
    const evidence = join(directory, 'results', 'run-evidence');
    let current: RunState | undefined;
    try { await lstat(join(directory, 'run.json')); current = await loadCurrent(context, runId); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    if (current === undefined) {
      await exactDirectory(directory, ['attempts', 'results']);
      await exactDirectory(join(directory, 'attempts'), []);
      await exactDirectory(join(directory, 'results'), ['run-evidence']);
      await exactDirectory(evidence, ['initial.json', 'initialization.json']);
    }
    let original: Buffer; let manifest: Buffer;
    try { original = await readBytes(join(evidence, 'initial.json')); manifest = await readBytes(join(evidence, 'initialization.json')); }
    catch (error) { if (hasCode(error, 'ENOENT')) throw new StateError('STATE_INCOMPLETE', 'Original immutable initialization evidence is missing', evidence); throw error; }
    if (!original.equals(prepared.content) || !manifest.equals(prepared.manifest)) throw new StateError('EVIDENCE_MISMATCH', 'Initialization evidence does not match the supplied original seed and snapshot');
    if (current !== undefined) {
      for (const key of ['runId', 'adapter', 'repoIdentity', 'authorization', 'createdAt', 'selectionMode', 'protocolSource', 'adapterConfigHash', 'initialUserChangesRef', 'initialUserChangesHash', 'reconciledFrom'] as const) {
        if (stable(current[key]) !== stable(prepared.state[key])) throw new StateError('STATE_IDENTITY_MISMATCH', 'Existing Run does not match its immutable initialization intent');
      }
      return current;
    }
    await verifyInitialReality(prepared.snapshot);
    await atomicWrite(context, join(directory, 'run.json'), bytes(prepared.state), false);
    return clone(prepared.state);
  });
}
