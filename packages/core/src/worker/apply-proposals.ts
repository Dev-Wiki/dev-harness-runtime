import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceRef, TaskExecutionRequest, TaskExecutionResult } from '@dev-harness-runtime/contracts';
import type { ProjectContext } from '../discovery/project.js';
import { withLock, type LockContext, type LockHandle } from '../lock/index.js';
import { loadRecoverySnapshot } from '../recovery/evidence.js';
import { identity, recordName } from '../result/frozen.js';
import { captureSnapshot, recaptureSnapshot } from '../snapshot/capture.js';
import { assertUnchanged } from '../snapshot/guard.js';
import type { CapturedSnapshot } from '../snapshot/types.js';
import { ensureRunEvidence, readRunAtRevision } from '../state/index.js';
import { syncDirectory } from '../state/files.js';
import { loadWorkerProposals } from './proposal-evidence.js';
import { WorkerProposalError, type WorkerFileProposal } from './proposals.js';

export interface AppliedWorkerProposals {
  readonly ending: CapturedSnapshot;
  readonly proposalRef: EvidenceRef;
  readonly intentRef: EvidenceRef;
  readonly receiptRef: EvidenceRef;
}

function deny(message: string): never {
  throw new WorkerProposalError('DRIFT_DETECTED', message);
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function stat(path: string): Promise<Stats | null> {
  try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
}
async function noAlias(parent: string, name: string): Promise<void> {
  if ((await readdir(parent)).some((entry) => entry !== name && entry.toLowerCase() === name.toLowerCase())) {
    deny(`Case alias at proposal path: ${join(parent, name)}`);
  }
}
async function parents(root: string, relativePath: string, create: boolean): Promise<string> {
  let current = root;
  for (const component of relativePath.split('/').slice(0, -1)) {
    await noAlias(current, component);
    const next = join(current, component);
    let info = await stat(next);
    if (info === null && create) {
      await mkdir(next, { mode: 0o755 });
      await syncDirectory(current);
      info = await stat(next);
    }
    if (info === null || !info.isDirectory() || info.isSymbolicLink()) deny(`Proposal parent is not a real directory: ${next}`);
    current = next;
  }
  return current;
}
async function preflight(root: string, file: WorkerFileProposal, before: CapturedSnapshot): Promise<void> {
  let current = root;
  for (const component of file.path.split('/').slice(0, -1)) {
    await noAlias(current, component);
    const next = join(current, component);
    const info = await stat(next);
    if (info === null) {
      if (file.content === null) deny(`Deletion parent is absent: ${file.path}`);
      return;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) deny(`Proposal parent is not a real directory: ${next}`);
    current = next;
  }
  await checkedTarget(root, file, before, false);
}
async function checkedTarget(root: string, file: WorkerFileProposal, before: CapturedSnapshot, createParents: boolean): Promise<{
  readonly target: string; readonly parent: string; readonly mode: number;
}> {
  const parent = await parents(root, file.path, createParents);
  const name = file.path.split('/').at(-1)!;
  await noAlias(parent, name);
  const target = join(parent, name);
  const expected = before.snapshot.paths.find((entry) => entry.path === file.path);
  const current = await stat(target);
  if (file.beforeHash === null) {
    if (current !== null || (expected !== undefined && expected.type !== 'missing')) deny(`Proposed new file already exists: ${file.path}`);
    return { target, parent, mode: 0o644 };
  }
  if (expected?.type !== 'file' || expected.rawContentHash !== file.beforeHash
    || current === null || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
    deny(`Proposed file no longer matches its frozen type: ${file.path}`);
  }
  const mode = current.mode & 0o777;
  if (((mode & 0o111) !== 0) !== (expected.mode === '100755')) deny(`Proposed file mode changed: ${file.path}`);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== current.dev || opened.ino !== current.ino || opened.nlink !== 1) deny(`Proposed file changed before reading: ${file.path}`);
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    const named = await stat(target);
    if (!named || named.dev !== opened.dev || named.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || named.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || named.ctimeMs !== opened.ctimeMs
      || hash.digest('hex') !== file.beforeHash) {
      deny(`Proposed file bytes changed before application: ${file.path}`);
    }
  } finally { await handle.close(); }
  return { target, parent, mode };
}
async function applyOne(context: LockContext, file: WorkerFileProposal, before: CapturedSnapshot): Promise<void> {
  await context.assertOwner();
  const { target, parent, mode } = await checkedTarget(context.repoRoot, file, before, file.content !== null);
  if (file.content === null) {
    await unlink(target);
    await syncDirectory(parent);
    return;
  }
  const temporary = join(parent, `.dhr-proposal-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      await handle.writeFile(file.content);
      await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
    await context.assertOwner();
    await checkedTarget(context.repoRoot, file, before, false);
    await rename(temporary, target);
    await syncDirectory(parent);
  } finally { await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; }); }
}

/** Exact Core-owned application after the host tree is quiescent. An interrupted partial write remains a drift, never an accepted result. */
export async function applyWorkerProposals(handle: LockHandle, expectedRevision: number, request: TaskExecutionRequest,
  result: TaskExecutionResult, proposalRef: EvidenceRef, project: ProjectContext): Promise<AppliedWorkerProposals> {
  const state = await readRunAtRevision(handle, request.runId, expectedRevision);
  if (state.status !== 'RUNNING' || state.phase !== 'EXECUTE' || state.pendingOperation?.kind !== 'execute'
    || project.repoRoot !== request.repoRoot || project.privateGitDir !== state.repoIdentity.privateGitDir) {
    throw new WorkerProposalError('AUTHORIZATION_VIOLATION', 'Proposal application requires the exact pending project execution');
  }
  const collector = await loadWorkerProposals(handle, expectedRevision, request, proposalRef);
  collector.assertDeclaredChanges(result);
  const before = await loadRecoverySnapshot(handle, state, state.pendingOperation.beforeSnapshotRef);
  assertUnchanged(before, await recaptureSnapshot(before));
  const files = collector.list();
  for (let index = 1; index < files.length; index++) {
    if (files[index]!.path.startsWith(`${files[index - 1]!.path}/`)) {
      throw new WorkerProposalError('AUTHORIZATION_VIOLATION', 'Proposal paths overlap as files and directories');
    }
  }
  const intentRef = await ensureRunEvidence(handle, request.runId, expectedRevision, recordName('apply-intent', request.requestId),
    { schemaVersion: 1, kind: 'core-proposal-apply-intent', ...identity(request), beforeSnapshotHash: before.hash,
      proposalRef, paths: files.map((file) => file.path) });
  const ending = await withLock(handle, async (context) => {
    assertUnchanged(before, await recaptureSnapshot(before));
    for (const file of files) await preflight(context.repoRoot, file, before);
    for (const file of [...files].sort((a, b) => Number(a.content === null) - Number(b.content === null))) {
      await applyOne(context, file, before);
    }
    const after = await captureSnapshot({ project, runId: request.runId, protocolSource: state.protocolSource,
      adapterConfigHash: state.adapterConfigHash });
    collector.assertAppliedSnapshot(after);
    return after;
  });
  assertUnchanged(ending, await recaptureSnapshot(ending));
  const receiptRef = await ensureRunEvidence(handle, request.runId, expectedRevision, recordName('apply-receipt', request.requestId),
    { schemaVersion: 1, kind: 'core-proposal-apply-receipt', ...identity(request), beforeSnapshotHash: before.hash,
      afterSnapshotHash: ending.hash, proposalRef, intentRef, paths: files.map((file) => file.path) });
  return { ending, proposalRef, intentRef, receiptRef };
}
