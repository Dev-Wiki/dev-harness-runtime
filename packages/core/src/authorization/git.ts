import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isRepoPath, parseContract, parseContractJson, type EvidenceRef, type RunState, type TaskExecutionRequest, type TaskExecutionResult } from '@dev-harness-runtime/contracts';
import { withLock, type LockHandle } from '../lock/index.js';
import { consumeAcceptedTask, type AcceptedTaskCapability, type AcceptedTaskData, type WorkerControlVerifier } from '../result/acceptance.js';
import { loadVerifiedCommitRecovery } from '../result/recovery.js';
import { recordName } from '../result/frozen.js';
import { loadRecoveryCheckpoint, loadRecoverySnapshot, sameRecord } from '../recovery/evidence.js';
import { compareAndSwapRun, ensureRunEvidence, readCurrentRun, writeRunEvidence, writeSummary } from '../state/index.js';
import { recaptureSnapshot } from '../snapshot/capture.js';
import { readBytes } from '../state/files.js';
import { assertTaskStart, assertUnchanged, compareSnapshots, verifyOwnedTransition } from '../snapshot/guard.js';
import { verifyAuthorizedCommit } from '../snapshot/commit.js';
import { readConversionPlan } from '../snapshot/git.js';
import type { CapturedSnapshot } from '../snapshot/types.js';

export class GitAuthorizationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'GitAuthorizationError'; }
}
export interface GitCommitPolicy {
  /** Trusted Core policy, fixed before Worker execution; it interprets the frozen project workflow. */
  evaluate(input: { workflow: { path: string; sha256: string; bytes: Buffer }; request: TaskExecutionRequest;
    result: Extract<TaskExecutionResult, { outcome: 'completed' }>; before: CapturedSnapshot }): Promise<{ message: string; paths: string[] }>;
}
export interface CommitAcceptedTaskOptions { expectedRevision: number; gitBinary: string; policy: GitCommitPolicy }
export interface ResumeAcceptedTaskCommitOptions extends CommitAcceptedTaskOptions { workerControl: WorkerControlVerifier }
export interface CommittedTask { state: RunState; commitSha: string; after: CapturedSnapshot; afterRef: EvidenceRef }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const now = (state: RunState) => new Date(Math.max(Date.now(), Date.parse(state.updatedAt))).toISOString();
function requireValue(value: unknown, code: string, message: string): asserts value { if (!value) throw new GitAuthorizationError(code, message); }
const samePaths = (left: readonly string[], right: readonly string[]) => sameRecord([...left].sort(), [...right].sort());
const decode = (value: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(value);
const absent = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const pinnedBinaries = new Map<string, string>();
async function checkedBinary(binary: string): Promise<void> {
  requireValue(isAbsolute(binary) && await realpath(binary) === binary, 'GIT_TOOLCHAIN_UNTRUSTED', 'Git must be an explicit canonical executable path');
  const stamp = (info: import('node:fs').BigIntStats) => [info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeNs, info.ctimeNs].join(':');
  const observed = await lstat(binary, { bigint: true });
  requireValue(observed.isFile() && (observed.mode & 0o022n) === 0n && (observed.uid === 0n || observed.uid === BigInt(process.getuid?.() ?? -1)), 'GIT_TOOLCHAIN_UNTRUSTED', 'Git must be a native executable owned by root/Core without group or world writes');
  await access(binary, constants.X_OK);
  const file = await open(binary, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await file.stat({ bigint: true }); bytes = await file.readFile(); const after = await file.stat({ bigint: true });
    requireValue(stamp(observed) === stamp(before) && stamp(before) === stamp(after) && stamp(after) === stamp(await lstat(binary, { bigint: true })), 'GIT_TOOLCHAIN_CHANGED', 'Git executable changed during inspection');
  } finally { await file.close(); }
  requireValue(bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'GIT_TOOLCHAIN_UNTRUSTED', 'This bridge requires the pinned native Linux ELF Git executable');
  const fingerprint = `${stamp(observed)}:${digest(bytes)}`;
  const prior = pinnedBinaries.get(binary);
  requireValue(prior === undefined || prior === fingerprint, 'GIT_TOOLCHAIN_CHANGED', 'Pinned Git executable has changed');
  pinnedBinaries.set(binary, fingerprint);
}

interface GitResult { stdout: Buffer; code: number }
/** Only trusted Git is executed; no inherited environment, shell, executable search or interactive input. */
async function git(binary: string, root: string, args: string[], options: { env?: NodeJS.ProcessEnv; allowedExit?: number[] } = {}): Promise<GitResult> {
  await checkedBinary(binary);
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(binary)}:/usr/bin:/bin`, HOME: homedir(), LANG: 'C', LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', ...options.env };
  try {
    return await new Promise<GitResult>((resolveResult, reject) => {
      const child = spawn(binary, ['--no-pager', '--literal-pathspecs', '-C', root, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let total = 0; let launchError: Error | undefined;
      for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on('data', (chunk: Buffer) => {
        total += chunk.length; if (total > 16 * 1024 * 1024) { launchError = new GitAuthorizationError('GIT_OUTPUT_LIMIT', 'Git exceeded its bounded output'); child.kill('SIGKILL'); }
        else output.push(chunk);
      });
      child.on('error', (error) => { launchError = error; });
      child.on('close', (code, signal) => {
        if (launchError) reject(launchError);
        else if (signal || code === null || (code !== 0 && !options.allowedExit?.includes(code))) reject(new GitAuthorizationError('GIT_OPERATION_FAILED', `Controlled Git ${args[0]} failed (${signal ?? code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 2048)}`));
        else resolveResult({ stdout: Buffer.concat(stdout), code });
      });
    });
  } finally { await checkedBinary(binary); }
}
async function text(binary: string, root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> { return decode((await git(binary, root, args, env ? { env } : {})).stdout).trim(); }
async function config(binary: string, root: string, key: string): Promise<string | undefined> {
  const result = await git(binary, root, ['config', '--includes', '--get', key], { allowedExit: [1] });
  return result.code === 1 ? undefined : decode(result.stdout).trim();
}
async function booleanConfig(binary: string, root: string, key: string): Promise<boolean> {
  const result = await git(binary, root, ['config', '--includes', '--bool', '--get', key], { allowedExit: [1] });
  return result.code === 0 && decode(result.stdout).trim() === 'true';
}
const hookNames = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change'];
async function metadataTree(path: string, immutableObjects = false): Promise<void> {
  let info; try { info = await lstat(path); } catch (error) { if (absent(error)) return; throw error; }
  requireValue(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()), 'UNSUPPORTED_GIT_METADATA', 'Git write metadata contains a symbolic link or special file');
  if (info.isDirectory()) for (const name of await readdir(path)) await metadataTree(join(path, name), immutableObjects);
  else requireValue(immutableObjects || info.nlink === 1, 'UNSUPPORTED_GIT_METADATA', 'Mutable Git metadata has a hard-link alias');
}
interface SupportedProject { fingerprint: string; commonDir: string; conversion: Record<string, string>; author: { name: string; email: string }; hooksPath: string }

/** Read-only supported-subset gate. Project rules requiring external execution are refused, never bypassed. */
export async function assertSupportedCommitProject(repoRoot: string, gitBinary: string): Promise<SupportedProject> {
  await checkedBinary(gitBinary);
  const names = decode((await git(gitBinary, repoRoot, ['config', '--includes', '--null', '--name-only', '--list'])).stdout).split('\0').filter(Boolean).map((name) => name.toLowerCase());
  const dangerous = /^(?:filter\..*\.(?:clean|smudge|process)|diff\.external|diff\..*\.(?:command|textconv)|merge\..*\.driver|core\.alternaterefscommand|gpg\.(?:program|[^.]+\.program|ssh\.defaultkeycommand)|trailer\..*\.(?:command|cmd))$/u;
  requireValue(!names.some((name) => dangerous.test(name)), 'UNSUPPORTED_GIT_HELPER', 'Project or user Git configuration requires an unsupported external helper');
  const fsmonitor = await config(gitBinary, repoRoot, 'core.fsmonitor');
  requireValue(fsmonitor === undefined || /^(?:false|no|off|0)$/iu.test(fsmonitor), 'UNSUPPORTED_GIT_HELPER', 'Configured fsmonitor cannot inherit commit authority');
  requireValue(!await booleanConfig(gitBinary, repoRoot, 'commit.gpgSign'), 'UNSUPPORTED_GIT_SIGNING', 'Required signing cannot be silently disabled');
  requireValue(!names.includes('extensions.partialclone') && !(await Promise.all(names.filter((name) => /^remote\..*\.promisor$/u.test(name)).map((name) => booleanConfig(gitBinary, repoRoot, name)))).some(Boolean), 'UNSUPPORTED_PARTIAL_CLONE', 'Automatic object fetching is outside the commit authority');
  const commonDir = await realpath(resolve(repoRoot, await text(gitBinary, repoRoot, ['rev-parse', '--git-common-dir'])));
  const privateDir = await realpath(await text(gitBinary, repoRoot, ['rev-parse', '--absolute-git-dir']));
  for (const directory of new Set([commonDir, privateDir])) {
    for (const name of ['refs', 'logs', 'HEAD', 'index', 'packed-refs']) await metadataTree(join(directory, name));
  }
  await metadataTree(join(commonDir, 'objects'), true);
  const hooksPath = resolve(repoRoot, await text(gitBinary, repoRoot, ['rev-parse', '--git-path', 'hooks']));
  const hookState: unknown[] = [];
  for (const name of hookNames) {
    try {
      const entry = await lstat(join(hooksPath, name));
      requireValue(entry.isFile() && !entry.isSymbolicLink() && (entry.mode & 0o111) === 0, 'UNSUPPORTED_GIT_HOOK', `Project hook cannot be isolated by this bridge: ${name}`);
      hookState.push([name, entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeMs, entry.ctimeMs]);
    } catch (error) { if (!absent(error)) throw error; }
  }
  for (const name of ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'MERGE_RR', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_LOG']) {
    const path = resolve(repoRoot, await text(gitBinary, repoRoot, ['rev-parse', '--git-path', name]));
    try { await lstat(path); throw new GitAuthorizationError('GIT_OPERATION_IN_PROGRESS', `Cannot commit during another Git operation: ${name}`); }
    catch (error) { if (!absent(error)) throw error; }
  }
  const name = await config(gitBinary, repoRoot, 'user.name'); const email = await config(gitBinary, repoRoot, 'user.email');
  requireValue(name && email && !['\r', '\n', '\0', '<', '>'].some((character) => name.includes(character) || email.includes(character)), 'GIT_IDENTITY_MISSING', 'Project workflow must have a valid configured commit identity');
  const conversion: Record<string, string> = {};
  for (const key of ['core.autocrlf', 'core.eol', 'core.safecrlf', 'core.filemode', 'core.symlinks', 'core.ignorecase']) {
    const value = await config(gitBinary, repoRoot, key); if (value !== undefined) conversion[key] = value;
  }
  // Hash effective values in memory; configuration may contain secrets and is never logged or persisted verbatim.
  const configDigest = digest((await git(gitBinary, repoRoot, ['config', '--includes', '--null', '--list'])).stdout);
  const fingerprint = digest(JSON.stringify([configDigest, names.sort(), fsmonitor, commonDir, hooksPath, hookState, name, email, conversion]));
  return { fingerprint, commonDir, conversion, author: { name, email }, hooksPath };
}

async function predictTree(binary: string, repoRoot: string, before: CapturedSnapshot, paths: string[], project: SupportedProject, temporary: string): Promise<string> {
  const gitDir = join(temporary, 'git'); await mkdir(join(gitDir, 'objects'), { recursive: true }); await mkdir(join(gitDir, 'refs')); await mkdir(join(gitDir, 'info'));
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/prediction\n');
  await writeFile(join(temporary, 'empty'), '');
  const sha256 = before.snapshot.repoIdentity.head.length === 64;
  await writeFile(join(gitDir, 'config'), `[core]\nrepositoryFormatVersion = ${sha256 ? 1 : 0}\nbare = false\n${sha256 ? '[extensions]\nobjectFormat = sha256\n' : ''}`);
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: repoRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: join(temporary, 'empty'), GIT_CONFIG_GLOBAL: join(temporary, 'empty'),
    GIT_ATTR_NOSYSTEM: '1', GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(join(project.commonDir, 'objects')) };
  const conversion = await readConversionPlan(repoRoot, paths);
  const lines = paths.map((path) => {
    const attributes = conversion.attributes.get(path) ?? new Map<string, string>();
    const declarations = ['text', 'eol', 'crlf', 'ident', 'working-tree-encoding'].map((name) => {
      const value = attributes.get(name) ?? 'unspecified';
      if (value === 'unset') return `-${name}`; if (value === 'unspecified') return `!${name}`; if (value === 'set') return name;
      requireValue(/^[A-Za-z0-9_.+-]+$/u.test(value), 'UNSUPPORTED_ATTRIBUTE_VALUE', 'Cannot safely predict a conversion attribute'); return `${name}=${value}`;
    });
    return `${JSON.stringify(path.replace(/([*?[\]])/gu, '\\$1'))} ${declarations.join(' ')} -filter`;
  });
  await writeFile(join(gitDir, 'info', 'attributes'), `${lines.join('\n')}\n`);
  const prefix = ['-c', `core.attributesFile=${join(temporary, 'empty')}`, ...Object.entries(project.conversion).flatMap(([key, value]) => ['-c', `${key}=${value}`])];
  await git(binary, repoRoot, [...prefix, 'read-tree', before.snapshot.repoIdentity.head], { env });
  for (const path of paths) await git(binary, repoRoot, [...prefix, 'add', '--', path], { env });
  return text(binary, repoRoot, [...prefix, 'write-tree'], env);
}

/** Consume one independently accepted Task and publish one exact commit; failures preserve all evidence and Git state. */
export async function commitAcceptedTask(handle: LockHandle, capability: AcceptedTaskCapability, options: CommitAcceptedTaskOptions): Promise<CommittedTask> {
  requireValue(process.env.DEV_HARNESS_WORKER !== '1', 'AUTHORIZATION_VIOLATION', 'Workers cannot invoke the Git bridge');
  const data = consumeAcceptedTask(capability, handle, options.expectedRevision);
  return beginAcceptedTaskCommit(handle, data, options);
}

async function beginAcceptedTaskCommit(handle: LockHandle, data: AcceptedTaskData, options: CommitAcceptedTaskOptions): Promise<CommittedTask> {
  let state = await readCurrentRun(handle, data.state.runId);
  requireValue(sameRecord(state, data.state), 'REVISION_CONFLICT', 'Accepted capability no longer identifies the current Run');
  requireValue(state.authorization.commit === 'task' && state.status === 'RUNNING' && data.result.commitIntent, 'AUTHORIZATION_VIOLATION', 'A completed accepted Task and task commit authority are required');
  requireValue(typeof options.policy?.evaluate === 'function', 'GIT_WORKFLOW_REQUIRED', 'Trusted Core workflow policy is required');
  const workflow = data.workflow;
  requireValue(digest(workflow.bytes) === workflow.sha256 && sameRecord(data.result.commitIntent.workflow, { path: workflow.path, sha256: workflow.sha256 }), 'GIT_WORKFLOW_MISMATCH', 'Commit intent does not bind the frozen workflow bytes');
  const approved = await options.policy.evaluate({ workflow: { ...workflow, bytes: Buffer.from(workflow.bytes) }, request: structuredClone(data.request), result: structuredClone(data.result), before: structuredClone(data.before) });
  requireValue(typeof approved.message === 'string' && approved.message.trim().length > 0 && !approved.message.includes('\0') && approved.message.endsWith('\n'), 'GIT_WORKFLOW_REJECTED', 'Policy must return the exact nonempty LF-terminated commit message');
  requireValue(Array.isArray(approved.paths) && approved.paths.length > 0 && approved.paths.every((path) => isRepoPath(path))
    && new Set(approved.paths.map((path) => path.toLowerCase())).size === approved.paths.length, 'GIT_WORKFLOW_REJECTED', 'Policy must return unique literal repository paths');
  const paths = [...approved.paths].sort();
  requireValue(samePaths(paths, data.taskChangedPaths) && samePaths(paths, data.result.commitIntent.paths), 'AUTHORIZATION_VIOLATION', 'Commit paths must exactly equal the accepted Task change set');
  const initial = data.initial; const before = data.before; const root = before.snapshot.repoIdentity.repoRoot;
  await checkedBinary(options.gitBinary);
  assertTaskStart(initial, before, data.request.scope); assertUnchanged(before, await recaptureSnapshot(before));
  requireValue(before.stagedPaths.length === 0 && before.snapshot.indexFlags.every((entry) => entry.tag === 'H'), 'UNSUPPORTED_GIT_INDEX', 'Bridge requires an unstaged ordinary index without hiding flags');
  const accepted = await loadRecoverySnapshot(handle, state, state.acceptedSnapshotRef);
  const actual = compareSnapshots(accepted.snapshot, before.snapshot);
  const permitted = new Set([...paths, ...data.verificationArtifactPaths]);
  requireValue(!actual.headChanged && !actual.branchChanged && !actual.indexChanged && samePaths(actual.contentPaths, [...permitted]), 'DRIFT_DETECTED', 'Accepted boundary contains changes outside the Task and declared verification artifacts');
  for (const path of data.verificationArtifactPaths) requireValue(!paths.includes(path) && !before.snapshot.paths.find((entry) => entry.path === path)?.index.length, 'AUTHORIZATION_VIOLATION', 'Verification artifacts cannot be tracked or committed');
  const supported = await assertSupportedCommitProject(root, options.gitBinary);
  const temporary = await mkdtemp(join(tmpdir(), 'dhr-commit-'));
  try {
    const expectedTree = await predictTree(options.gitBinary, root, before, paths, supported, temporary);
    assertUnchanged(before, await recaptureSnapshot(before));
    requireValue((await assertSupportedCommitProject(root, options.gitBinary)).fingerprint === supported.fingerprint, 'DRIFT_DETECTED', 'Git policy configuration changed during preparation');
    const operationId = randomUUID(); const stamp = now(state);
    const identity = { runId: data.request.runId, taskId: data.request.taskId, attempt: data.request.attempt, requestId: data.request.requestId };
    const intent = { parent: before.snapshot.repoIdentity.head, expectedTree, paths, messageHash: digest(approved.message) };
    const requestRef = await writeRunEvidence(handle, state.runId, state.revision, `commit-request-${operationId}`, data.request);
    const resultRef = await writeRunEvidence(handle, state.runId, state.revision, `commit-result-${operationId}`, data.result);
    const readyRef = await writeRunEvidence(handle, state.runId, state.revision, `commit-ready-${operationId}`, { schemaVersion: 1, operationId, kind: 'commit', identity, stage: 'commit-ready',
      beforeSnapshotRef: data.beforeRef, afterSnapshotRef: data.beforeRef, requestRef, resultRef, evidenceRefs: data.verifiedEvidenceRefs });
    state = await compareAndSwapRun(handle, state.runId, state.revision, { ...state, revision: state.revision + 1, phase: 'FINALIZE', updatedAt: stamp,
      pendingOperation: { schemaVersion: 1, operationId, kind: 'commit', identity, scope: data.request.scope, beforeSnapshotRef: data.beforeRef, beforeSnapshotHash: before.hash, checkpointRef: readyRef, ...intent, createdAt: stamp } });
    return await publishReservedCommit(handle, data, state, options.gitBinary, approved.message, supported, temporary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Continue resume-commit, or revalidate with a verification-passed checkpoint. Existing commits use adoption. */
export async function resumeAcceptedTaskCommit(handle: LockHandle, runId: string, options: ResumeAcceptedTaskCommitOptions): Promise<CommittedTask> {
  requireValue(process.env.DEV_HARNESS_WORKER !== '1', 'AUTHORIZATION_VIOLATION', 'Workers cannot resume the Git bridge');
  const { data, context } = await loadVerifiedCommitRecovery(handle, runId, options.expectedRevision, options.workerControl);
  const state = data.state; const pending = state.pendingOperation;
  if (pending?.kind === 'verify') return beginAcceptedTaskCommit(handle, data, options);
  requireValue(pending?.kind === 'commit' && data.result.commitIntent && !state.completedTasks.includes(data.request.taskId), 'ACCEPTANCE_REQUIRED', 'No incomplete accepted commit reservation exists');
  const before = data.before; const root = before.snapshot.repoIdentity.repoRoot;
  const current = await recaptureSnapshot(context.after);
  requireValue(current.snapshot.repoIdentity.head === pending.parent, 'COMMIT_ADOPTION_REQUIRED', 'HEAD already advanced; use verified recovery adoption instead of committing again');
  assertUnchanged(context.after, current);
  assertTaskStart(data.initial, before, data.request.scope);
  requireValue(before.stagedPaths.length === 0 && before.snapshot.indexFlags.every(entry => entry.tag === 'H'), 'UNSUPPORTED_GIT_INDEX', 'Original accepted boundary must have an ordinary unstaged index');
  if (context.checkpoint.stage === 'index-staged') assertStagedReservation(before, context.after, pending.paths);
  else assertUnchanged(before, current);
  requireValue(typeof options.policy?.evaluate === 'function', 'GIT_WORKFLOW_REQUIRED', 'Original workflow must be reevaluated by trusted Core policy');
  const workflow = data.workflow;
  requireValue(sameRecord(data.result.commitIntent.workflow, { path: workflow.path, sha256: workflow.sha256 }), 'GIT_WORKFLOW_MISMATCH', 'Original commit intent does not bind its frozen workflow');
  const approved = await options.policy.evaluate({ workflow: { ...workflow, bytes: Buffer.from(workflow.bytes) }, request: structuredClone(data.request), result: structuredClone(data.result), before: structuredClone(before) });
  requireValue(typeof approved.message === 'string' && digest(approved.message) === pending.messageHash
    && approved.message.trim().length > 0 && approved.message.endsWith('\n') && !approved.message.includes('\0'), 'GIT_WORKFLOW_MISMATCH', 'Recovery cannot change the reserved commit message');
  requireValue(Array.isArray(approved.paths) && samePaths(approved.paths, pending.paths)
    && samePaths(pending.paths, data.taskChangedPaths) && samePaths(pending.paths, data.result.commitIntent.paths), 'AUTHORIZATION_VIOLATION', 'Recovery cannot change the reserved commit paths');
  const accepted = await loadRecoverySnapshot(handle, state, state.acceptedSnapshotRef);
  const actual = compareSnapshots(accepted.snapshot, before.snapshot);
  requireValue(!actual.headChanged && !actual.branchChanged && !actual.indexChanged
    && samePaths(actual.contentPaths, [...new Set([...pending.paths, ...data.verificationArtifactPaths])]), 'DRIFT_DETECTED', 'Reserved acceptance contains unrelated changes');
  for (const path of data.verificationArtifactPaths) requireValue(!pending.paths.includes(path) && !before.snapshot.paths.find(entry => entry.path === path)?.index.length, 'AUTHORIZATION_VIOLATION', 'Verification artifacts cannot become committed paths');
  const supported = await assertSupportedCommitProject(root, options.gitBinary);
  const temporary = await mkdtemp(join(tmpdir(), 'dhr-commit-recovery-'));
  try {
    const predicted = await predictTree(options.gitBinary, root, before, pending.paths, supported, temporary);
    requireValue(predicted === pending.expectedTree, 'DRIFT_DETECTED', 'Recovered commit tree differs from the original reservation');
    assertUnchanged(current, await recaptureSnapshot(current));
    requireValue((await assertSupportedCommitProject(root, options.gitBinary)).fingerprint === supported.fingerprint, 'DRIFT_DETECTED', 'Git policy configuration changed during recovery preparation');
    requireValue(sameRecord(await readCurrentRun(handle, runId), state), 'REVISION_CONFLICT', 'Commit reservation changed during recovery');
    return await publishReservedCommit(handle, data, state, options.gitBinary, approved.message, supported, temporary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}


async function reservedGit<T>(handle: LockHandle, state: RunState, operation: () => Promise<T>): Promise<T> {
  return withLock(handle, async (owner) => {
    const current = parseContractJson('runState', decode(await readBytes(join(owner.stateRoot, state.runId, 'run.json'))));
    requireValue(sameRecord(current, state), 'REVISION_CONFLICT', 'Commit reservation changed before a Git mutation');
    await owner.assertOwner();
    return operation();
  });
}

function assertStagedReservation(before: CapturedSnapshot, staged: CapturedSnapshot, paths: string[]): void {
  const projection = (value: CapturedSnapshot) => ({ ...value.snapshot, capturedAt: '', indexFingerprint: '', indexFlags: [], stagedPaths: [], dirtyPaths: [],
    paths: value.snapshot.paths.map(entry => ({ ...entry, index: [] })) });
  requireValue(sameRecord(projection(before), projection(staged)), 'DRIFT_DETECTED', 'Staging changed a non-index accepted boundary');
  requireValue(samePaths(staged.stagedPaths, paths) && staged.snapshot.indexFlags.every(entry => entry.tag === 'H'), 'AUTHORIZATION_VIOLATION', 'Staging differs from the exact ordinary commit path set');
}

async function publishReservedCommit(handle: LockHandle, data: AcceptedTaskData, state: RunState, gitBinary: string,
  message: string, supported: SupportedProject, temporary: string): Promise<CommittedTask> {
  requireValue(state.pendingOperation?.kind === 'commit', 'STATE_CORRUPT', 'Commit reservation disappeared');
  const pending = state.pendingOperation;
  const checkpoint = await loadRecoveryCheckpoint(handle, state, pending.indexCheckpointRef ?? pending.checkpointRef!);
  const { requestRef, resultRef } = checkpoint.checkpoint;
  requireValue(requestRef && resultRef, 'ACCEPTANCE_REQUIRED', 'Commit checkpoint is incomplete');
  const { operationId, identity, paths, expectedTree, parent, messageHash } = pending;
  const intent = { parent, expectedTree, paths, messageHash };
  const before = data.before; const initial = data.initial; const root = before.snapshot.repoIdentity.repoRoot;
  const executionEnv = { GIT_AUTHOR_NAME: supported.author.name, GIT_AUTHOR_EMAIL: supported.author.email, GIT_COMMITTER_NAME: supported.author.name, GIT_COMMITTER_EMAIL: supported.author.email };
  // Performance maintenance is not a project validation rule; no hooks/signing/filter rules are disabled.
  const prefix = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  let staged: CapturedSnapshot;
  if (state.pendingOperation?.kind === 'commit' && state.pendingOperation.indexCheckpointRef) {
    staged = checkpoint.after;
    assertUnchanged(staged, await recaptureSnapshot(staged));
  } else {
    for (const path of paths) {
      requireValue(sameRecord(await readCurrentRun(handle, state.runId), state), 'REVISION_CONFLICT', 'Commit reservation changed');
      requireValue((await assertSupportedCommitProject(root, gitBinary)).fingerprint === supported.fingerprint, 'DRIFT_DETECTED', 'Git policy configuration changed before staging');
      await reservedGit(handle, state, () => git(gitBinary, root, [...prefix, 'add', '--', path], { env: executionEnv }));
    }
    staged = await recaptureSnapshot(before);
  }
  assertStagedReservation(before, staged, paths);
  requireValue(samePaths(staged.stagedPaths, paths), 'AUTHORIZATION_VIOLATION', 'Actual staged paths differ from the accepted commit intent');
  const actualTree = await reservedGit(handle, state, () => text(gitBinary, root, [...prefix, 'write-tree'], executionEnv));
  requireValue(actualTree === expectedTree, 'DRIFT_DETECTED', 'Actual staged tree differs from the predicted accepted tree');
  requireValue(compareSnapshots(before.snapshot, staged.snapshot).contentPaths.length === 0 && staged.snapshot.repoIdentity.head === intent.parent && staged.snapshot.repoIdentity.branch === before.snapshot.repoIdentity.branch, 'DRIFT_DETECTED', 'Staging changed content or Git identity');
  if (!pending.indexCheckpointRef) {
    const stagedRef = await writeRunEvidence(handle, state.runId, state.revision, `commit-staged-${operationId}`, staged.snapshot);
    const checkpointRef = await writeRunEvidence(handle, state.runId, state.revision, `commit-checkpoint-${operationId}`, { schemaVersion: 1, operationId, kind: 'commit', identity, stage: 'index-staged',
      beforeSnapshotRef: data.beforeRef, afterSnapshotRef: stagedRef, requestRef, resultRef, evidenceRefs: data.verifiedEvidenceRefs });
    requireValue(state.pendingOperation?.kind === 'commit', 'STATE_CORRUPT', 'Commit reservation disappeared');
    state = await compareAndSwapRun(handle, state.runId, state.revision, { ...state, revision: state.revision + 1, updatedAt: now(state), pendingOperation: { ...state.pendingOperation, indexCheckpointRef: checkpointRef } });
  }
  assertUnchanged(staged, await recaptureSnapshot(staged));
  requireValue((await assertSupportedCommitProject(root, gitBinary)).fingerprint === supported.fingerprint, 'DRIFT_DETECTED', 'Git policy configuration changed before commit');
  await writeFile(join(temporary, 'message'), message);
  await reservedGit(handle, state, () => git(gitBinary, root, [...prefix, 'commit', '--quiet', '--no-edit', '--no-status', '--cleanup=verbatim', '--file', join(temporary, 'message')], { env: executionEnv }));
  requireValue((await assertSupportedCommitProject(root, gitBinary)).fingerprint === supported.fingerprint, 'DRIFT_DETECTED', 'Git policy configuration changed during commit');
  const after = await recaptureSnapshot(before);
  await verifyOwnedTransition(before, after, { initial, scope: data.request.scope, authorization: state.authorization, commit: intent,
    verifyOwnership: async () => { await verifyAuthorizedCommit(before, after, state.authorization, intent); return true; } });
  const commitSha = after.snapshot.repoIdentity.head;
  const afterRef = await ensureRunEvidence(handle, state.runId, state.revision, recordName('committed', operationId), after.snapshot);
  const acceptedResult = parseContract('acceptedTaskExecutionResult', { ...data.result, commitSha, acceptedAt: staged.snapshot.capturedAt, acceptedSnapshotHash: after.hash, verifiedEvidenceRefs: data.verifiedEvidenceRefs });
  const acceptedRef = await ensureRunEvidence(handle, state.runId, state.revision, recordName('accepted', operationId), acceptedResult);
  requireValue(!state.completedTasks.includes(identity.taskId), 'STATE_CORRUPT', 'Task was already completed');
  const next: RunState = { ...state, revision: state.revision + 1, updatedAt: now(state), acceptedSnapshotRef: afterRef, acceptedSnapshotHash: after.hash,
    completedTasks: [...state.completedTasks, identity.taskId], resultRefs: [...state.resultRefs.filter((entry) => !sameRecord(entry.identity, identity)), { identity, ref: acceptedRef }],
    status: state.selectionMode.mode === 'all-ready' ? 'RUNNING' : 'COMPLETED', phase: state.selectionMode.mode === 'all-ready' ? 'SELECT' : 'FINALIZE' };
  delete next.pendingOperation; delete next.currentTaskId; delete next.currentAttempt; delete next.currentRequestId; delete next.stopReason;
  assertUnchanged(after, await recaptureSnapshot(after));
  state = await compareAndSwapRun(handle, state.runId, state.revision, next); await writeSummary(handle, state.runId, state.revision);
  return { state, commitSha, after, afterRef };
}
