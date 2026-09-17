import { createHash } from 'node:crypto';
import {
  ContractValidationError, isRepoPath, parseContract, type RunAuthorization,
} from '@dev-harness-runtime/contracts';
import { recaptureSnapshot, serializeSnapshot, snapshotBoundaryHash } from './capture.js';
import { decodeGit, readGit, readGitBoundary } from './git.js';
import type { CapturedSnapshot } from './types.js';

export interface CommitIntent {
  parent: string;
  expectedTree: string;
  paths: string[];
  /** SHA-256 of the raw commit message bytes, including its trailing newline. */
  messageHash: string;
}

function requireMatch(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractValidationError('DRIFT_DETECTED', message);
}

function requireAuthorization(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractValidationError('AUTHORIZATION_VIOLATION', message);
}

function validateIntent(intent: CommitIntent): void {
  const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
  requireMatch(typeof intent === 'object' && intent !== null, 'Commit intent must be a record');
  requireMatch(typeof intent.parent === 'string' && oid.test(intent.parent), 'Invalid intent parent object ID');
  requireMatch(typeof intent.expectedTree === 'string' && oid.test(intent.expectedTree), 'Invalid intent tree object ID');
  requireMatch(typeof intent.messageHash === 'string' && /^[a-f0-9]{64}$/u.test(intent.messageHash), 'Invalid raw commit message digest');
  requireMatch(Array.isArray(intent.paths) && intent.paths.length > 0
    && intent.paths.every((path) => typeof path === 'string' && isRepoPath(path)
      && !path.split('/').some((part) => part.toLowerCase() === '.git')), 'Invalid intent paths');
  requireMatch(new Set(intent.paths.map((path) => path.toLowerCase())).size === intent.paths.length, 'Commit intent paths must be unique without aliases');
}

/**
 * Verifies an already-created commit and the current captured boundary. This
 * does not authorize a Git process to create commits, run hooks, or publish.
 * The caller separately protects inherited user changes and owns the Run lock.
 */
export async function verifyAuthorizedCommit(
  before: CapturedSnapshot,
  after: CapturedSnapshot,
  authorization: RunAuthorization,
  intent: CommitIntent,
): Promise<void> {
  const prior = parseContract('snapshot', before.snapshot);
  const accepted = parseContract('snapshot', after.snapshot);
  const allowed = parseContract('runAuthorization', authorization);
  requireAuthorization(allowed.commit === 'task', 'This Run does not authorize a Task commit');
  requireAuthorization(allowed.runId === prior.runId && allowed.runId === accepted.runId, 'Commit authorization must bind both snapshot Runs');
  validateIntent(intent);
  const baseline = prior.repoIdentity;
  const target = accepted.repoIdentity;
  requireMatch(baseline.repoRoot === target.repoRoot && baseline.privateGitDir === target.privateGitDir
    && baseline.branch === target.branch, 'Commit snapshots must identify the same repository, worktree and branch');
  requireMatch(createHash('sha256').update(serializeSnapshot(prior)).digest('hex') === before.hash
    && createHash('sha256').update(serializeSnapshot(accepted)).digest('hex') === after.hash, 'Captured record digest does not match its snapshot');
  requireMatch(snapshotBoundaryHash(prior) === before.boundaryHash && snapshotBoundaryHash(accepted) === after.boundaryHash, 'Captured boundary digest does not match its snapshot');
  requireMatch(intent.parent === baseline.head, 'Intent parent does not match the before HEAD');
  requireMatch(target.head !== baseline.head, 'Commit verification requires one new commit');

  try {
    const current = await readGitBoundary(target.repoRoot);
    requireMatch(current.repoRoot === target.repoRoot && current.privateGitDir === target.privateGitDir
      && current.branch === target.branch && current.head === target.head
      && current.indexFingerprint === accepted.indexFingerprint, 'The after snapshot no longer matches the current Git boundary');

    const commit = await readGit(target.repoRoot, ['cat-file', 'commit', target.head]);
    const separator = commit.indexOf(Buffer.from('\n\n'));
    requireMatch(separator >= 0, 'Commit object has no raw message boundary');
    const headers = decodeGit(commit.subarray(0, separator)).split('\n');
    const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
    const trees = headers.filter((line) => line.startsWith('tree ')).map((line) => line.slice(5));
    requireMatch(parents.length === 1 && parents[0] === intent.parent, 'Commit must have exactly the authorized parent');
    requireMatch(trees.length === 1 && trees[0] === intent.expectedTree, 'Commit tree does not match the intent');
    const message = commit.subarray(separator + 2);
    decodeGit(message);
    requireMatch(createHash('sha256').update(message).digest('hex') === intent.messageHash, 'Raw commit message does not match the intent');

    const changedBytes = await readGit(target.repoRoot, [
      'diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames',
      '--no-ext-diff', '--no-textconv', '-z', intent.parent, target.head, '--',
    ]);
    const changedText = decodeGit(changedBytes);
    requireMatch(changedText === '' || changedText.endsWith('\0'), 'Git path changes were not NUL terminated');
    const changed = changedText === '' ? [] : changedText.slice(0, -1).split('\0');
    requireMatch(JSON.stringify(changed.toSorted()) === JSON.stringify(intent.paths.toSorted()), 'Actual committed paths do not exactly match the intent');

    // Re-read raw contents, symlinks, modes and the complete index. Git status
    // alone can hide changes under assume-unchanged or conversion attributes.
    const fresh = await recaptureSnapshot(after);
    requireMatch(fresh.boundaryHash === after.boundaryHash, 'Working tree or index changed after the recorded snapshot');
    const remaining = new Set([...fresh.dirtyPaths, ...fresh.stagedPaths]);
    requireMatch(intent.paths.every((path) => !remaining.has(path)), 'Committed paths still contain unaccepted worktree or index changes');

    const final = await readGitBoundary(target.repoRoot);
    requireMatch(final.repoRoot === current.repoRoot && final.privateGitDir === current.privateGitDir
      && final.branch === current.branch && final.head === current.head
      && final.indexFingerprint === current.indexFingerprint, 'Git boundary changed while verifying the commit');
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    throw new ContractValidationError('DRIFT_DETECTED', error instanceof Error ? error.message : 'Unable to verify the actual commit boundary');
  }
}
