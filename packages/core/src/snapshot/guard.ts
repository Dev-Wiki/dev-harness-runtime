import { createHash } from 'node:crypto';
import { lstat, readlink } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep, parse, join } from 'node:path';
import { ContractValidationError, parseContract, type Snapshot, type Scope, type RunAuthorization } from '@dev-harness-runtime/contracts';
import { PlanningError } from '../planning/types.js';
import { serializeSnapshot, snapshotBoundaryHash } from './capture.js';
import type { CapturedSnapshot } from './types.js';
import { verifyAuthorizedCommit, type CommitIntent } from './commit.js';

export interface OwnedOperationBoundary {
  readonly runId: string;
  readonly taskId: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly paths: readonly string[];
}
export interface TransitionPolicy {
  scope: Scope;
  initial: CapturedSnapshot;
  authorization: RunAuthorization;
  /** Core supplies a verifier of a trusted controlled-operation/checkpoint record, never Worker claims. */
  verifyOwnership: (boundary: OwnedOperationBoundary) => Promise<boolean>;
  commit?: CommitIntent;
}
export interface SnapshotDelta { paths: string[]; contentPaths: string[]; headChanged: boolean; branchChanged: boolean; indexChanged: boolean }
function fail(condition: boolean, message: string, code: 'DRIFT_DETECTED' | 'AUTHORIZATION_VIOLATION' = 'DRIFT_DETECTED'): asserts condition {
  if (!condition) throw new ContractValidationError(code, message);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function pathContentHash(entry: Snapshot['paths'][number] | undefined): string | null {
  if (entry === undefined) return null;
  return createHash('sha256').update(stable(Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'index')))).digest('hex');
}
function validateCapture(value: CapturedSnapshot): Snapshot {
  const snapshot = parseContract('snapshot', value.snapshot);
  fail(value.hash === createHash('sha256').update(serializeSnapshot(snapshot)).digest('hex'), 'Snapshot record hash mismatch');
  fail(value.boundaryHash === snapshotBoundaryHash(snapshot), 'Snapshot boundary hash mismatch');
  fail(stable(value.dirtyPaths) === stable(snapshot.dirtyPaths) && stable(value.stagedPaths) === stable(snapshot.stagedPaths), 'Snapshot change classifications do not match the hashed record');
  const records = new Map(snapshot.paths.map((entry) => [entry.path, entry]));
  for (const ref of [snapshot.dashboardRef, snapshot.agentsRef, snapshot.harnessRef, snapshot.gitWorkflowRef, ...snapshot.dependencyArchiveRefs, ...(snapshot.currentTaskRef ? [snapshot.currentTaskRef] : [])]) {
    const entry = records.get(ref.path);
    fail(entry?.type === 'file' && entry.rawContentHash === ref.sha256, 'Snapshot document reference does not match captured content');
  }
  return snapshot;
}
export function compareSnapshots(beforeInput: Snapshot, afterInput: Snapshot): SnapshotDelta {
  const before = parseContract('snapshot', beforeInput); const after = parseContract('snapshot', afterInput);
  const left = new Map(before.paths.map((entry) => [entry.path, entry])); const right = new Map(after.paths.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return {
    paths: paths.filter((path) => stable(left.get(path)) !== stable(right.get(path))),
    contentPaths: paths.filter((path) => pathContentHash(left.get(path)) !== pathContentHash(right.get(path))),
    headChanged: before.repoIdentity.head !== after.repoIdentity.head,
    branchChanged: before.repoIdentity.branch !== after.repoIdentity.branch,
    indexChanged: before.indexFingerprint !== after.indexFingerprint,
  };
}
export function assertUnchanged(before: CapturedSnapshot, after: CapturedSnapshot): void {
  validateCapture(before); validateCapture(after);
  fail(before.boundaryHash === after.boundaryHash, 'Project changed across a guarded boundary');
}
function planningPaths(scope: Scope): string[] {
  return [scope.planning.taskPath, scope.planning.archivePath, scope.planning.dashboardPath, scope.planning.archiveIndexPath];
}
function allowed(path: string, scope: Scope): boolean {
  if (path.split('/').some((component) => component.toLowerCase() === '.git')) return false;
  const root = scope.planning.dashboardPath.slice(0, scope.planning.dashboardPath.lastIndexOf('/'));
  if (path.startsWith(`${root}/`)) return planningPaths(scope).includes(path);
  return scope.files.includes(path) || scope.directories.some((directory) => path.startsWith(`${directory}/`));
}
async function assertContainedSymlink(repoRoot: string, privateGitDir: string, path: string, target: string): Promise<void> {
  const absolute = isAbsolute(target) ? target : `${dirname(resolve(repoRoot, path))}${sep}${target}`;
  let current = parse(absolute).root;
  let pending = absolute.slice(current.length).split(sep);
  let links = 0;
  while (pending.length > 0) {
    const component = pending.shift()!;
    if (component === '' || component === '.') continue;
    if (component === '..') { current = dirname(current); continue; }
    const candidate = join(current, component);
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        fail(++links <= 40, `Cannot resolve modified symlink: ${path}`, 'AUTHORIZATION_VIOLATION');
        const next = await readlink(candidate);
        if (isAbsolute(next)) {
          current = parse(next).root;
          pending = [...next.slice(current.length).split(sep), ...pending];
        } else pending = [...next.split(sep), ...pending];
        continue;
      }
    } catch (error) {
      // Missing components are safe only after every existing ancestor was inspected.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    current = candidate;
  }
  const inside = (root: string): boolean => {
    const rel = relative(root, current);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  fail(inside(repoRoot) && !inside(privateGitDir) && !relative(repoRoot, current).split(sep).some((part) => part.toLowerCase() === '.git'), `Modified symlink escapes the workspace or targets Git metadata: ${path}`, 'AUTHORIZATION_VIOLATION');
}
/** Preexisting user changes and staged content must not enter the Task's write scope. */
export function assertTaskStart(initial: CapturedSnapshot, accepted: CapturedSnapshot, scopeInput: Scope): void {
  const scope = parseContract('scope', scopeInput); validateCapture(initial); validateCapture(accepted);
  fail(initial.snapshot.runId === accepted.snapshot.runId && initial.snapshot.repoIdentity.repoRoot === accepted.snapshot.repoIdentity.repoRoot && initial.snapshot.repoIdentity.privateGitDir === accepted.snapshot.repoIdentity.privateGitDir, 'Initial and accepted snapshots belong to different Runs or worktrees');
  if (initial.stagedPaths.length > 0 || accepted.stagedPaths.length > 0) throw new PlanningError('USER_CHANGES_PRESENT', 'Automatic Tasks cannot start with staged changes');
  for (const path of initial.dirtyPaths) if (allowed(path, scope)) throw new PlanningError('USER_CHANGES_PRESENT', `Task scope overlaps preexisting user change: ${path}`);
  const protectedPaths = new Map(initial.snapshot.paths.map((entry) => [entry.path, entry]));
  const current = new Map(accepted.snapshot.paths.map((entry) => [entry.path, entry]));
  for (const path of initial.dirtyPaths) fail(stable(protectedPaths.get(path)) === stable(current.get(path)), `Preexisting user change drifted: ${path}`);
}
/**
 * Accept only a captured transition bound to independently verified operation evidence.
 * This gate does not execute commands, trust Worker changedFiles, or create evidence.
 */
export async function verifyOwnedTransition(before: CapturedSnapshot, after: CapturedSnapshot, policy: TransitionPolicy): Promise<SnapshotDelta> {
  const left = validateCapture(before); const right = validateCapture(after);
  const scope = parseContract('scope', policy.scope); const authorization = parseContract('runAuthorization', policy.authorization);
  assertTaskStart(policy.initial, before, scope);
  fail(left.runId === right.runId && authorization.runId === left.runId, 'Authorization must bind the captured Run', 'AUTHORIZATION_VIOLATION');
  fail(left.repoIdentity.repoRoot === right.repoIdentity.repoRoot && left.repoIdentity.privateGitDir === right.repoIdentity.privateGitDir, 'Repository/worktree identity changed');
  fail(left.repoIdentity.branch === right.repoIdentity.branch, 'Branch changed');
  fail(stable(left.protocolSource) === stable(right.protocolSource) && left.adapterConfigHash === right.adapterConfigHash, 'Protocol or Adapter configuration changed');
  for (const key of ['dashboardRef', 'agentsRef', 'harnessRef', 'gitWorkflowRef'] as const) fail(left[key].path === right[key].path, `Governance reference identity changed: ${key}`);
  const delta = compareSnapshots(left, right);
  for (const path of delta.paths) fail(allowed(path, scope), `Out-of-scope file or index change: ${path}`, 'AUTHORIZATION_VIOLATION');
  const initialPaths = new Map(policy.initial.snapshot.paths.map((entry) => [entry.path, entry]));
  const afterPaths = new Map(right.paths.map((entry) => [entry.path, entry]));
  for (const path of policy.initial.dirtyPaths) fail(stable(initialPaths.get(path)) === stable(afterPaths.get(path)), `Preexisting user content changed: ${path}`);
  for (const path of delta.contentPaths) {
    const entry = afterPaths.get(path);
    if (entry?.type === 'symlink') await assertContainedSymlink(right.repoIdentity.repoRoot, right.repoIdentity.privateGitDir, path, entry.symlinkTarget);
  }
  if (delta.headChanged) {
    fail(authorization.commit === 'task' && policy.commit !== undefined, 'HEAD advanced without a permitted commit intent', 'AUTHORIZATION_VIOLATION');
    await verifyAuthorizedCommit(before, after, authorization, policy.commit);
  } else {
    fail(policy.commit === undefined, 'Commit intent did not produce its expected commit');
    fail(!delta.indexChanged, 'Worker or external process changed the Git index');
  }
  // A commit can alter indexed blobs, but cannot hide changes through index flags.
  const beforeFlags = new Map(left.indexFlags.map((entry) => [entry.path, entry.tag]));
  const afterFlags = new Map(right.indexFlags.map((entry) => [entry.path, entry.tag]));
  for (const path of new Set([...beforeFlags.keys(), ...afterFlags.keys()])) {
    const old = beforeFlags.get(path); const next = afterFlags.get(path);
    if (old === next) continue;
    fail(delta.headChanged && delta.paths.includes(path) && ((old === undefined && next === 'H') || (old === 'H' && next === undefined)), `Unauthorized index flag change: ${path}`);
  }
  fail(typeof policy.verifyOwnership === 'function', 'Trusted ownership verification is required', 'AUTHORIZATION_VIOLATION');
  const boundary = Object.freeze({ runId: left.runId, taskId: scope.planning.taskId, beforeHash: before.hash, afterHash: after.hash, paths: Object.freeze([...delta.paths]) });
  fail(await policy.verifyOwnership(boundary), 'No trusted operation evidence matches this exact transition', 'AUTHORIZATION_VIOLATION');
  return delta;
}
