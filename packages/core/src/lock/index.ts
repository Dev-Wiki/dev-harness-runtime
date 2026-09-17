import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseContract, type LockMetadata } from '@dev-harness-runtime/contracts';
import { checkedDirectory, checkProject, hasCode, LockError, type LockProject } from './paths.js';
import { processStartIdentity } from './process.js';

export { LockError } from './paths.js';
export type { LockProject } from './paths.js';

declare const handleBrand: unique symbol;
export interface LockHandle { readonly [handleBrand]: true }
export interface LockContext extends LockProject {
  readonly runId: string;
  /** Recheck ownership immediately before publishing a persistent update. */
  assertOwner(): Promise<void>;
}
export type LockInspection = { status: 'available' }
  | { status: 'held'; owner: LockMetadata }
  | { status: 'unknown'; reason: string; owner?: LockMetadata };

interface OwnerState {
  project: LockProject;
  metadata: LockMetadata;
  queue: Promise<unknown>;
  released: boolean;
}
const handles = new WeakMap<LockHandle, OwnerState>();
const LOCK = '.orchestrator.lock';
const GUARD = '.orchestrator.guard';
const OWNER = 'owner.json';

async function readOwner(directory: string): Promise<LockMetadata> {
  await checkedDirectory(directory, true);
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] !== OWNER) {
    throw new LockError('LOCK_OWNER_UNKNOWN', 'Lock directory has incomplete or unexpected contents', directory);
  }
  const path = join(directory, OWNER);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536
      || (process.platform !== 'win32' && ((before.mode & 0o077) !== 0
        || (process.getuid !== undefined && before.uid !== process.getuid())))) {
    throw new LockError('LOCK_OWNER_UNKNOWN', 'Owner metadata is not a private regular file', path);
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await file.stat();
    if (actual.dev !== before.dev || actual.ino !== before.ino) throw new LockError('LOCK_OWNER_UNKNOWN', 'Owner metadata changed while opening', path);
    const owner = parseContract('lockMetadata', JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.readFile())));
    const after = await lstat(path);
    if (after.isSymbolicLink() || after.dev !== actual.dev || after.ino !== actual.ino) {
      throw new LockError('LOCK_OWNER_UNKNOWN', 'Owner metadata changed while reading', path);
    }
    return owner;
  } finally { await file.close(); }
}

async function writeOwner(directory: string, owner: LockMetadata): Promise<void> {
  await checkedDirectory(directory, true);
  const file = await open(join(directory, OWNER), 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(owner)}\n`); await file.sync(); }
  finally { await file.close(); }
}

function sameOwner(actual: LockMetadata, expected: LockMetadata): boolean {
  return actual.ownerToken === expected.ownerToken && actual.pid === expected.pid
    && actual.processStartIdentity === expected.processStartIdentity && actual.runId === expected.runId
    && actual.adapter === expected.adapter && actual.repoRoot === expected.repoRoot
    && actual.privateGitDir === expected.privateGitDir && actual.createdAt === expected.createdAt;
}

async function inspectDirectory(directory: string, project: LockProject): Promise<LockInspection> {
  try { await lstat(directory); }
  catch (error) { if (hasCode(error, 'ENOENT')) return { status: 'available' }; throw error; }
  try {
    const owner = await readOwner(directory);
    if (owner.repoRoot !== project.repoRoot || owner.privateGitDir !== project.privateGitDir) {
      return { status: 'unknown', owner, reason: 'Owner metadata belongs to another worktree' };
    }
    const identity = await processStartIdentity(owner.pid);
    if (identity !== undefined && owner.processStartIdentity === identity) return { status: 'held', owner };
    return { status: 'unknown', owner, reason: 'Cannot prove owner identity and all descendants quiescent; manual intervention required' };
  } catch {
    return { status: 'unknown', reason: 'Owner metadata is missing, unsafe or invalid; manual intervention required' };
  }
}

function contention(inspection: LockInspection, path: string): never {
  if (inspection.status === 'held') throw new LockError('LOCK_BUSY', 'Another owner holds the lock or guard', path);
  throw new LockError('LOCK_OWNER_UNKNOWN', inspection.status === 'unknown' ? inspection.reason : 'Lock changed during acquisition; manual intervention required', path);
}

async function releaseGuard(project: LockProject, directory: string, guard: LockMetadata): Promise<void> {
  await checkProject(project, false);
  const current = await readOwner(directory);
  if (!sameOwner(current, guard)) throw new LockError('LOCK_OWNER_UNKNOWN', 'Guard ownership changed; preserving the directory', directory);
  await unlink(join(directory, OWNER));
  await rmdir(directory);
}

/** No automatic stale deletion: the current metadata cannot prove descendant termination. */
async function guarded<T>(project: LockProject, owner: LockMetadata, fn: () => Promise<T>): Promise<T> {
  await checkProject(project, true);
  const directory = join(project.stateRoot, GUARD);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    contention(await inspectDirectory(directory, project), directory);
  }
  const guard = { ...owner, ownerToken: randomUUID() };
  // If initialization fails, preserve the incomplete guard rather than guess ownership.
  await writeOwner(directory, guard);
  try { return await fn(); }
  finally { await releaseGuard(project, directory, guard); }
}

function stateOf(handle: LockHandle): OwnerState {
  const state = handles.get(handle);
  if (!state || state.released) throw new LockError('LOCK_NOT_OWNER', 'Lock handle is not an active handle created by this process');
  return state;
}

function enqueue<T>(state: OwnerState, operation: () => Promise<T>): Promise<T> {
  const result = state.queue.then(operation);
  state.queue = result.then(() => undefined, () => undefined);
  return result;
}

async function assertOwner(state: OwnerState): Promise<void> {
  if (state.released) throw new LockError('LOCK_NOT_OWNER', 'Lock has already been released');
  await checkProject(state.project, false);
  let actual: LockMetadata;
  try { actual = await readOwner(join(state.project.stateRoot, LOCK)); }
  catch { throw new LockError('LOCK_OWNER_UNKNOWN', 'Owner metadata is missing, unsafe or invalid; preserving state'); }
  if (!sameOwner(actual, state.metadata)) throw new LockError('LOCK_NOT_OWNER', 'Disk lock no longer belongs to this process');
}

export async function acquireLock(project: LockProject, options: { runId: string; adapter: string }): Promise<LockHandle> {
  const captured = Object.freeze({ repoRoot: project.repoRoot, privateGitDir: project.privateGitDir, stateRoot: project.stateRoot });
  const identity = await processStartIdentity(process.pid);
  const metadata = parseContract('lockMetadata', {
    schemaVersion: 1, ownerToken: randomUUID(), runId: options.runId, adapter: options.adapter,
    repoRoot: captured.repoRoot, privateGitDir: captured.privateGitDir, pid: process.pid,
    ...(identity === undefined ? {} : { processStartIdentity: identity }), createdAt: new Date().toISOString(),
  });
  return guarded(captured, metadata, async () => {
    const directory = join(captured.stateRoot, LOCK);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      contention(await inspectDirectory(directory, captured), directory);
    }
    await writeOwner(directory, metadata);
    const handle = Object.freeze({}) as LockHandle;
    handles.set(handle, { project: captured, metadata, queue: Promise.resolve(), released: false });
    return handle;
  });
}

export async function withLock<T>(handle: LockHandle, fn: (context: LockContext) => Promise<T>): Promise<T> {
  const state = stateOf(handle);
  return enqueue(state, async () => {
    await assertOwner(state);
    return guarded(state.project, state.metadata, async () => {
      await assertOwner(state);
      const context: LockContext = Object.freeze({ ...state.project, runId: state.metadata.runId, assertOwner: () => assertOwner(state) });
      const result = await fn(context);
      await assertOwner(state);
      return result;
    });
  });
}

export async function releaseLock(handle: LockHandle): Promise<void> {
  const state = stateOf(handle);
  return enqueue(state, async () => {
    await assertOwner(state);
    await guarded(state.project, state.metadata, async () => {
      await assertOwner(state);
      const directory = join(state.project.stateRoot, LOCK);
      await unlink(join(directory, OWNER));
      await rmdir(directory);
      state.released = true;
    });
  });
}

export async function inspectLock(project: LockProject): Promise<LockInspection> {
  await checkProject(project, false);
  const guard = await inspectDirectory(join(project.stateRoot, GUARD), project);
  if (guard.status !== 'available') return guard;
  return inspectDirectory(join(project.stateRoot, LOCK), project);
}
