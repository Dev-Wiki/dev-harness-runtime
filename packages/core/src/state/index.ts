import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import {
  isRepoPath, parseContract, parseContractJson,
  type EvidenceRef, type RunState, type Snapshot, type TaskExecutionRequest, type TaskExecutionResult,
} from '@dev-harness-runtime/contracts';
import { withLock, type LockContext, type LockHandle } from '../lock/index.js';
import { serializeSnapshot } from '../snapshot/capture.js';
import { atomicWrite, checkedFile, hasCode, makeDirectory, readBytes, requireDirectory, syncDirectory } from './files.js';
import { StateError } from './errors.js';

export { StateError, type StateErrorCode } from './errors.js';
export type AttemptIdentity = Pick<TaskExecutionRequest, 'runId' | 'taskId' | 'attempt' | 'requestId'>;
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
async function load(context: LockContext, runId: string, expectedRevision: number): Promise<RunState> {
  revision(expectedRevision);
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
  if (state.revision !== expectedRevision) throw new StateError('REVISION_CONFLICT', `Expected revision ${expectedRevision}, found ${state.revision}`, path);
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
  return withLock(handle, (context) => load(context, runId, expectedRevision));
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
    for (const key of ['runId', 'adapter', 'repoIdentity', 'authorization', 'createdAt', 'selectionMode', 'protocolSource', 'adapterConfigHash', 'initialUserChangesRef', 'initialUserChangesHash'] as const) {
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
  if (!isRepoPath(path) || !(new RegExp(`^(?:results/${attempt}\\.json|attempts/${attempt}/(?:stdout\\.log|stderr\\.log|events\\.jsonl|snapshots/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\\.json)|summary\\.json)$`, 'u')).test(path)) {
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
