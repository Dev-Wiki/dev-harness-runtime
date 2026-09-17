import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ContractValidationError, isRepoPath, parseContract, type EvidenceRef, type Snapshot } from '@dev-harness-runtime/contracts';
import { PlanningError } from '../planning/types.js';
import { createBlobNormalizer, decodeGit, readConversionPlan, readGitBoundary, type GitBoundary } from './git.js';
import type { CaptureSnapshotOptions, CapturedSnapshot } from './types.js';

type SnapshotPath = Snapshot['paths'][number];
interface Observation { entry: SnapshotPath; stamp: string; blob: string | null }
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function drift(message: string): never { throw new ContractValidationError('DRIFT_DETECTED', message); }

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, child]) => [key, stable(child)]));
  return value;
}

function canonical(snapshot: Snapshot): Snapshot {
  const value = parseContract('snapshot', snapshot);
  return {
    ...value,
    paths: value.paths.map((entry) => ({ ...entry, index: [...entry.index].sort((a, b) => a.stage - b.stage) })).sort((a, b) => compare(a.path, b.path)),
    indexFlags: [...value.indexFlags].sort((a, b) => compare(a.path, b.path)),
    dirtyPaths: [...value.dirtyPaths].sort(), stagedPaths: [...value.stagedPaths].sort(),
    dependencyArchiveRefs: [...value.dependencyArchiveRefs].sort((a, b) => compare(a.path, b.path)),
    protocolSource: { ...value.protocolSource, files: [...value.protocolSource.files].sort((a, b) => compare(a.path, b.path)) },
  };
}

/** Exact persisted UTF-8 JSON representation, including a final newline. */
export function serializeSnapshot(snapshot: Snapshot): string {
  return `${JSON.stringify(stable(canonical(snapshot)))}\n`;
}

/** Compare observations independently of when their records were created. */
export function snapshotBoundaryHash(snapshot: Snapshot): string {
  const { capturedAt: _capturedAt, ...boundary } = canonical(snapshot);
  return digest(`${JSON.stringify(stable(boundary))}\n`);
}

function stamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

async function info(path: string): Promise<BigIntStats | null> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

/** Never traverse a project symlink as an ancestor, including a replaced tracked directory. */
async function safeParents(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (!isRepoPath(rel.split(sep).join('/'))) throw new PlanningError('PATH_ESCAPE', 'Snapshot path escapes repository', path);
  let parent = root;
  for (const component of rel.split(sep).slice(0, -1)) {
    parent = join(parent, component);
    const current = await info(parent);
    if (current === null) return;
    if (!current.isDirectory() || current.isSymbolicLink()) throw new PlanningError('PATH_ESCAPE', 'Snapshot cannot traverse a symlink or non-directory ancestor', path);
  }
}

function boundaryKey(boundary: GitBoundary): string {
  return JSON.stringify([boundary.repoRoot, boundary.privateGitDir, boundary.head, boundary.branch, boundary.objectFormat, boundary.indexFingerprint, boundary.paths]);
}

function isDirty(observation: Observation, git: GitBoundary): boolean {
  const entry = observation.entry;
  const index = entry.index;
  const base = git.headEntries.get(entry.path);
  if (index.length !== 1 || index[0]?.stage !== 0) return index.length !== 0 || entry.type !== 'missing' || base !== undefined;
  const staged = index[0];
  if (!base || base.blob !== staged.blob || base.mode !== staged.mode) return true;
  if (entry.type === 'missing' || entry.mode !== staged.mode) return true;
  return observation.blob !== staged.blob;
}

async function inspectSubmodule(path: string, depth: number): Promise<string> {
  if (depth > 8) throw new PlanningError('UNSUPPORTED_SUBMODULE', 'Nested submodules exceed supported capture depth', path);
  const boundary = await readGitBoundary(path);
  if (boundary.repoRoot !== await realpath(path)) throw new PlanningError('UNSUPPORTED_SUBMODULE', 'Submodule is not initialized', path);
  const observations = await observeTree(boundary, depth);
  if (observations.some((entry) => isDirty(entry, boundary)) || boundary.stagedPaths.length > 0) {
    throw new PlanningError('DIRTY_SUBMODULE', 'Dirty submodule cannot be represented by a single Git link', path);
  }
  await verifyTree(boundary, observations, depth);
  return boundary.head;
}

async function observePath(git: GitBoundary, path: string, depth: number, normalizer: ReturnType<typeof createBlobNormalizer>): Promise<Observation> {
  const absolute = join(git.repoRoot, ...path.split('/'));
  await safeParents(git.repoRoot, absolute);
  const before = await info(absolute);
  const index = git.index.get(path) ?? [];
  if (before === null) return { entry: { path, index, type: 'missing', deleted: true, mode: null }, stamp: 'missing', blob: null };
  const initialStamp = stamp(before);
  if (before.isSymbolicLink()) {
    const target = await readlink(absolute, { encoding: 'buffer' });
    const after = await info(absolute);
    if (!after || stamp(after) !== initialStamp) drift(`Symlink changed during capture: ${path}`);
    return { entry: { path, index, type: 'symlink', mode: '120000', deleted: false, symlinkTarget: decodeGit(target) }, stamp: initialStamp,
      blob: createHash(git.objectFormat).update(`blob ${target.length}\0`).update(target).digest('hex') };
  }
  if (before.isDirectory() && (index.some((entry) => entry.mode === '160000') || git.headEntries.get(path)?.mode === '160000')) {
    const commit = await inspectSubmodule(absolute, depth + 1);
    return { entry: { path, index, type: 'gitlink', mode: '160000', deleted: false, commit }, stamp: initialStamp, blob: commit };
  }
  if (!before.isFile()) throw new PlanningError('UNSUPPORTED_FILE_TYPE', 'Snapshot requires a file, symlink, or initialized Git link', path);
  const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || stamp(opened) !== initialStamp) drift(`File changed before opening: ${path}`);
    const hash = createHash('sha256'); const blob = createHash(git.objectFormat).update(`blob ${before.size}\0`);
    const original = git.headEntries.get(path); const staged = index[0];
    const compareToIndex = index.length === 1 && staged?.stage === 0 && original !== undefined && staged.blob === original.blob && staged.mode === original.mode;
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024); let count = 0n;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      count += BigInt(bytesRead); hash.update(buffer.subarray(0, bytesRead)); blob.update(buffer.subarray(0, bytesRead));
      if (compareToIndex) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    let blobHash = blob.digest('hex');
    if (compareToIndex && staged && blobHash !== staged.blob) blobHash = await normalizer.normalize(path, Buffer.concat(chunks), staged);
    const after = await info(absolute);
    if (count !== before.size || stamp(await file.stat({ bigint: true })) !== initialStamp || !after || stamp(after) !== initialStamp) drift(`File changed while reading: ${path}`);
    await safeParents(git.repoRoot, absolute);
    return { entry: { path, index, type: 'file', mode: (before.mode & 0o111n) !== 0n ? '100755' : '100644', deleted: false, rawContentHash: hash.digest('hex') }, stamp: initialStamp, blob: blobHash };
  } finally { await file.close(); }
}

async function observeTree(git: GitBoundary, depth = 0): Promise<Observation[]> {
  const plan = await readConversionPlan(git.repoRoot, git.paths);
  git.conversionFingerprint = plan.fingerprint;
  const normalizer = createBlobNormalizer(git, plan);
  const observations: Observation[] = [];
  try {
  for (const path of git.paths) {
    const absolute = join(git.repoRoot, ...path.split('/'));
    const privateRelative = relative(git.privateGitDir, absolute);
    if (privateRelative === '' || (!privateRelative.startsWith(`..${sep}`) && privateRelative !== '..' && !isAbsolute(privateRelative))) {
      throw new PlanningError('PATH_ESCAPE', 'Git private metadata was enumerated as project content', path);
    }
    observations.push(await observePath(git, path, depth, normalizer));
  }
  return observations;
  } finally { await normalizer.dispose(); }
}

async function verifyTree(git: GitBoundary, observations: readonly Observation[], depth = 0): Promise<void> {
  for (const observed of observations) {
    const absolute = join(git.repoRoot, ...observed.entry.path.split('/'));
    await safeParents(git.repoRoot, absolute);
    const current = await info(absolute);
    if ((current === null ? 'missing' : stamp(current)) !== observed.stamp) drift(`Path changed before capture completed: ${observed.entry.path}`);
    if (observed.entry.type === 'gitlink' && await inspectSubmodule(absolute, depth + 1) !== observed.entry.commit) drift(`Submodule HEAD changed: ${observed.entry.path}`);
  }
  if ((await readConversionPlan(git.repoRoot, git.paths)).fingerprint !== git.conversionFingerprint) drift('Git conversion configuration changed during capture');
  if (boundaryKey(await readGitBoundary(git.repoRoot)) !== boundaryKey(git)) drift('Git identity, index or project path list changed during capture');
}

export async function captureSnapshot(options: CaptureSnapshotOptions): Promise<CapturedSnapshot> {
  const { project } = options;
  if (!project.gitWorkflowPath) throw new PlanningError('PROJECT_CONTRACT_MISSING', 'Snapshot requires a frozen Git workflow reference');
  const git = await readGitBoundary(project.repoRoot);
  if (git.repoRoot !== project.repoRoot || git.privateGitDir !== project.privateGitDir) drift('Project repository identity changed before snapshot');
  const observations = await observeTree(git);
  const byPath = new Map(observations.map((value) => [value.entry.path, value.entry]));
  const reference = (path: string): EvidenceRef => {
    const absolute = isAbsolute(path) ? path : resolve(git.repoRoot, path);
    const repoPath = relative(git.repoRoot, absolute).split(sep).join('/');
    const entry = byPath.get(repoPath);
    if (!isRepoPath(repoPath) || !entry || entry.type !== 'file') throw new PlanningError('PROJECT_CONTRACT_MISSING', 'Snapshot reference must identify an existing regular project file', path);
    return { schemaVersion: 1, path: repoPath, sha256: entry.rawContentHash };
  };
  const dashboardRef = reference(project.dashboardPath);
  const agentsRef = reference(project.agentsPath); const harnessRef = reference(project.harnessPath); const gitWorkflowRef = reference(project.gitWorkflowPath);
  const currentTaskRef = options.currentTaskPath ? reference(options.currentTaskPath) : undefined;
  const dependencies = new Map<string, EvidenceRef>();
  const direct = new Set([dashboardRef.path, agentsRef.path, harnessRef.path, gitWorkflowRef.path, currentTaskRef?.path]);
  for (const locked of options.planningReferences ?? []) {
    const observed = reference(locked.path);
    if (observed.sha256 !== locked.sha256) drift(`Planning reference changed since selection: ${locked.path}`);
    if (!direct.has(observed.path)) dependencies.set(observed.path, observed);
  }
  await verifyTree(git, observations);
  const dirtyPaths = observations.filter((value) => isDirty(value, git)).map((value) => value.entry.path).sort();
  const snapshot = parseContract('snapshot', {
    schemaVersion: 1, runId: options.runId, capturedAt: new Date().toISOString(),
    repoIdentity: { repoRoot: git.repoRoot, privateGitDir: git.privateGitDir, head: git.head, branch: git.branch },
    indexFingerprint: git.indexFingerprint, indexFlags: git.indexFlags,
    dirtyPaths, stagedPaths: git.stagedPaths,
    paths: observations.map((value) => value.entry), dashboardRef, agentsRef, harnessRef, gitWorkflowRef,
    ...(currentTaskRef ? { currentTaskRef } : {}), dependencyArchiveRefs: [...dependencies.values()],
    protocolSource: options.protocolSource, adapterConfigHash: options.adapterConfigHash,
  });
  return { snapshot, hash: digest(serializeSnapshot(snapshot)), boundaryHash: snapshotBoundaryHash(snapshot),
    dirtyPaths: [...snapshot.dirtyPaths], stagedPaths: [...snapshot.stagedPaths] };
}

/** Recapture precisely the same declared inputs; reference changes fail before freshness comparison. */
export async function recaptureSnapshot(captured: CapturedSnapshot): Promise<CapturedSnapshot> {
  const snapshot = parseContract('snapshot', captured.snapshot); const root = snapshot.repoIdentity.repoRoot;
  const absolute = (path: string) => join(root, ...path.split('/'));
  const dashboardPath = absolute(snapshot.dashboardRef.path);
  return captureSnapshot({
    project: { repoRoot: root, privateGitDir: snapshot.repoIdentity.privateGitDir, stateRoot: join(snapshot.repoIdentity.privateGitDir, 'dev-harness-runtime', 'runs'),
      docsRoot: dirname(dirname(dashboardPath)), dashboardPath, head: snapshot.repoIdentity.head,
      agentsPath: absolute(snapshot.agentsRef.path), harnessPath: absolute(snapshot.harnessRef.path), gitWorkflowPath: absolute(snapshot.gitWorkflowRef.path), verificationCommands: [], issues: [] },
    runId: snapshot.runId, protocolSource: snapshot.protocolSource, adapterConfigHash: snapshot.adapterConfigHash,
    ...(snapshot.currentTaskRef ? { currentTaskPath: absolute(snapshot.currentTaskRef.path) } : {}),
    planningReferences: [snapshot.dashboardRef, snapshot.agentsRef, snapshot.harnessRef, snapshot.gitWorkflowRef, ...snapshot.dependencyArchiveRefs, ...(snapshot.currentTaskRef ? [snapshot.currentTaskRef] : [])],
  });
}
