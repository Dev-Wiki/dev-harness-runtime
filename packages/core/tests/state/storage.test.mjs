import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { acquireLock, inspectLock, releaseLock } from '../../dist/lock/index.js';
import {
  StateError, compareAndSwapRun, createAttempt, createRun, readEvidence,
  readRunAtRevision, writeResult, writeSnapshot, writeSummary,
} from '../../dist/state/index.js';
import { withStateFaultForTest } from '../../dist/state/testing.js';

const execute = promisify(execFile);
const fixture = (path) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${path}.json`, import.meta.url), 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function git(root, ...args) { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim(); }
async function setup(t, { create = true } = {}) {
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'dhr-state-test-')));
  await git(repoRoot, 'init', '--quiet', '-b', 'main');
  const privateGitDir = await realpath(await git(repoRoot, 'rev-parse', '--absolute-git-dir'));
  const project = { repoRoot, privateGitDir, stateRoot: join(privateGitDir, 'dev-harness-runtime', 'runs') };
  const handle = await acquireLock(project, { runId: 'run-a', adapter: 'codex' });
  const cleanup = [];
  t.after(async () => {
    for (const dispose of cleanup) await dispose();
    await releaseLock(handle).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true });
  });
  const state = fixture('state/run-created');
  state.repoIdentity.repoRoot = repoRoot;
  state.repoIdentity.privateGitDir = privateGitDir;
  if (create) await createRun(handle, state);
  return { project, handle, state, cleanup, runPath: join(project.stateRoot, 'run-a', 'run.json') };
}
const fails = (promise, code) => assert.rejects(promise, (error) => error instanceof StateError && error.code === code);
async function startAttempt(context) {
  const state = { ...context.state, revision: 1, currentTaskId: 'K1', currentAttempt: 1, currentRequestId: 'request-a' };
  await compareAndSwapRun(context.handle, 'run-a', 0, state);
  const identity = { runId: 'run-a', taskId: 'K1', attempt: 1, requestId: 'request-a' };
  return { identity, paths: await createAttempt(context.handle, 'run-a', 1, identity) };
}

test('Run creation writes one authoritative record and reads require an exact revision', async (t) => {
  const { handle, state, runPath } = await setup(t);
  assert.deepEqual(await readRunAtRevision(handle, 'run-a', 0), state);
  assert.deepEqual((await readdir(dirname(runPath))).sort(), ['attempts', 'results', 'run.json']);
  await fails(readRunAtRevision(handle, 'run-a', 1), 'REVISION_CONFLICT');
  for (const expected of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await fails(readRunAtRevision(handle, 'run-a', expected), 'REVISION_CONFLICT');
  await fails(createRun(handle, state), 'STATE_ALREADY_EXISTS');
});

test('the worktree lock can create/read/CAS an explicitly addressed successor Run', async (t) => {
  const { handle, state } = await setup(t);
  const successor = structuredClone(state);
  successor.runId = 'run-b'; successor.authorization.runId = 'run-b';
  await createRun(handle, successor);
  await compareAndSwapRun(handle, 'run-b', 0, { ...successor, revision: 1 });
  assert.equal((await readRunAtRevision(handle, 'run-b', 1)).runId, 'run-b');
  assert.equal((await readRunAtRevision(handle, 'run-a', 0)).revision, 0);
});

test('parallel same-owner CAS calls serialize and only one expected revision succeeds', async (t) => {
  const { handle, state } = await setup(t);
  const candidates = Array.from({ length: 4 }, (_, index) => ({ ...state, revision: 1, phase: index === 0 ? 'SELECT' : 'SNAPSHOT' }));
  const results = await Promise.allSettled(candidates.map((value) => compareAndSwapRun(handle, 'run-a', 0, value)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'REVISION_CONFLICT'));
  assert.equal((await readRunAtRevision(handle, 'run-a', 1)).revision, 1);
});

test('CAS requires exactly one revision and preserves creation identity and authorization', async (t) => {
  const { handle, state } = await setup(t);
  await fails(compareAndSwapRun(handle, 'run-a', 0, { ...state, revision: 2 }), 'REVISION_CONFLICT');
  for (const edit of [
    (value) => { value.authorization.commit = 'task'; },
    (value) => { value.repoIdentity.head = 'c'.repeat(40); },
    (value) => { value.repoIdentity.branch = 'other'; },
    (value) => { value.adapter = 'other'; },
    (value) => { value.selectionMode = { mode: 'next' }; },
    (value) => { value.adapterConfigHash = 'c'.repeat(64); },
    (value) => { value.initialUserChangesHash = 'c'.repeat(64); value.initialUserChangesRef.sha256 = value.initialUserChangesHash; },
    (value) => { value.protocolSource.version = '2.0.0'; },
  ]) {
    const next = structuredClone(state); next.revision = 1; edit(next);
    await fails(compareAndSwapRun(handle, 'run-a', 0, next), 'STATE_IDENTITY_MISMATCH');
  }
});

test('CAS rejects overflow without touching the authoritative bytes', async (t) => {
  const { handle, state, runPath } = await setup(t);
  await writeFile(runPath, `${JSON.stringify({ ...state, revision: Number.MAX_SAFE_INTEGER })}\n`);
  const previous = await readFile(runPath);
  await fails(compareAndSwapRun(handle, 'run-a', Number.MAX_SAFE_INTEGER, { ...state, revision: Number.MAX_SAFE_INTEGER }), 'REVISION_OVERFLOW');
  assert.deepEqual(await readFile(runPath), previous);
});

test('unsupported, malformed and partial Run records fail closed without rewriting bytes', async (t) => {
  const { handle, state, runPath } = await setup(t);
  for (const contents of ['{"schemaVersion":1,', JSON.stringify({ ...state, schemaVersion: 5 }), JSON.stringify({ ...state, unexpected: true }), Buffer.from([0xff, 0xfe])]) {
    await writeFile(runPath, contents);
    const original = await readFile(runPath);
    await fails(readRunAtRevision(handle, 'run-a', 0), 'STATE_CORRUPT');
    assert.deepEqual(await readFile(runPath), original);
  }
});

test('interrupted Run initialization is diagnosed and never overwritten', async (t) => {
  const { handle, state, project } = await setup(t, { create: false });
  await mkdir(join(project.stateRoot, 'run-a'), { mode: 0o700 });
  await fails(readRunAtRevision(handle, 'run-a', 0), 'STATE_INCOMPLETE');
  await fails(createRun(handle, state), 'STATE_ALREADY_EXISTS');
  assert.deepEqual(await readdir(join(project.stateRoot, 'run-a')), []);
});

test('invalid Run paths and records bound to another worktree are rejected', async (t) => {
  const { handle, state } = await setup(t);
  for (const runId of ['../other', '/tmp/other', 'RUN-A', 'a/b']) await fails(readRunAtRevision(handle, runId, 0), 'STATE_PATH_INVALID');
  const other = structuredClone(state); other.runId = 'run-b'; other.authorization.runId = 'run-b'; other.repoIdentity.repoRoot += '-other';
  await fails(createRun(handle, other), 'STATE_IDENTITY_MISMATCH');
  const wrongRun = structuredClone(state); wrongRun.runId = 'run-b'; wrongRun.authorization.runId = 'run-b'; wrongRun.revision = 1;
  await fails(compareAndSwapRun(handle, 'run-a', 0, wrongRun), 'STATE_IDENTITY_MISMATCH');
});

test('attempt/result/snapshot evidence has the fixed layout and immutable destinations', async (t) => {
  const context = await setup(t);
  const { identity, paths } = await startAttempt(context);
  assert.deepEqual((await readdir(paths.path)).sort(), ['events.jsonl', 'snapshots', 'stderr.log', 'stdout.log']);
  const result = fixture('execution/result-partial');
  const resultRef = await writeResult(context.handle, 'run-a', 1, result);
  assert.equal(resultRef.path, 'results/K1-1.json');
  assert.deepEqual(JSON.parse((await readEvidence(context.handle, 'run-a', 1, resultRef)).toString()), result);
  await fails(writeResult(context.handle, 'run-a', 1, result), 'EVIDENCE_EXISTS');
  const snapshot = fixture('state/snapshot'); snapshot.repoIdentity = context.state.repoIdentity;
  const snapshotRef = await writeSnapshot(context.handle, 'run-a', 1, identity, 'before', snapshot);
  assert.equal(snapshotRef.path, 'attempts/K1-1/snapshots/before.json');
  assert.equal(hash(await readEvidence(context.handle, 'run-a', 1, snapshotRef)), snapshotRef.sha256);
  await fails(writeSnapshot(context.handle, 'run-a', 1, identity, 'before', snapshot), 'EVIDENCE_EXISTS');
  assert.deepEqual((await readRunAtRevision(context.handle, 'run-a', 1)).resultRefs, []);
});

test('evidence writes require current attempt identity and never promote orphan result files', async (t) => {
  const context = await setup(t); await startAttempt(context);
  const result = fixture('execution/result-partial'); result.requestId = 'wrong-request';
  await fails(writeResult(context.handle, 'run-a', 1, result), 'STATE_IDENTITY_MISMATCH');
  await writeFile(join(dirname(context.runPath), 'results', 'K1-999.json'), JSON.stringify(fixture('execution/result-completed')));
  const state = await readRunAtRevision(context.handle, 'run-a', 1);
  assert.equal(state.status, 'CREATED'); assert.deepEqual(state.completedTasks, []); assert.deepEqual(state.resultRefs, []);
});

test('evidence hashes detect corruption and reference paths cannot leave the Run layout', async (t) => {
  const context = await setup(t); await startAttempt(context);
  const ref = await writeResult(context.handle, 'run-a', 1, fixture('execution/result-partial'));
  await writeFile(join(dirname(context.runPath), ref.path), 'corrupted bytes');
  await fails(readEvidence(context.handle, 'run-a', 1, ref), 'EVIDENCE_MISMATCH');
  for (const path of ['../run-b/run.json', '/tmp/result.json', 'run.json', 'snapshots/initial.json', 'attempts/K1-1/other.log']) {
    await fails(readEvidence(context.handle, 'run-a', 1, { ...ref, path }), 'STATE_PATH_INVALID');
  }
});

test('summary is regenerated solely from Run authority and cannot change it', async (t) => {
  const { handle, state, runPath } = await setup(t);
  await writeFile(join(dirname(runPath), 'summary.json'), '{"status":"COMPLETED"}');
  const ref = await writeSummary(handle, 'run-a', 0);
  const summary = JSON.parse((await readEvidence(handle, 'run-a', 0, ref)).toString());
  assert.equal(summary.status, 'CREATED'); assert.equal(summary.revision, 0);
  assert.deepEqual(await readRunAtRevision(handle, 'run-a', 0), state);
});

test('state operations reject symlinks in files and intermediate Run directories', async (t) => {
  const context = await setup(t);
  const backup = await readFile(context.runPath);
  const outside = join(context.project.repoRoot, 'outside.json'); await writeFile(outside, backup);
  await rm(context.runPath);
  try { await symlink(outside, context.runPath, 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('File symlinks require Windows privileges'); return; } throw error; }
  await fails(readRunAtRevision(context.handle, 'run-a', 0), 'STATE_PATH_INVALID');
  await rm(context.runPath); await writeFile(context.runPath, backup);
  await startAttempt(context);
  const results = join(dirname(context.runPath), 'results'); await rm(results, { recursive: true });
  const outsideDirectory = join(context.project.repoRoot, 'external-results'); await mkdir(outsideDirectory);
  await symlink(outsideDirectory, results, process.platform === 'win32' ? 'junction' : 'dir');
  await fails(writeResult(context.handle, 'run-a', 1, fixture('execution/result-partial')), 'STATE_PATH_INVALID');
  assert.deepEqual(await readdir(outsideDirectory), []);
});

for (const point of ['half-written', 'file-synced', 'published', 'directory-synced']) {
  test(`atomic CAS fault at ${point} leaves only a complete old or new run.json`, async (t) => {
    const { handle, state, runPath } = await setup(t);
    await assert.rejects(withStateFaultForTest((observed) => { if (observed === point) throw new Error('Injected interruption'); },
      () => compareAndSwapRun(handle, 'run-a', 0, { ...state, revision: 1 })), /Injected interruption/u);
    const actual = JSON.parse(await readFile(runPath, 'utf8'));
    const expected = ['half-written', 'file-synced'].includes(point) ? 0 : 1;
    assert.equal(actual.revision, expected);
    assert.deepEqual(await readRunAtRevision(handle, 'run-a', expected), actual);
  });
}

test('replacing the flushed temporary inode prevents publication', async (t) => {
  const { handle, state, runPath } = await setup(t);
  await assert.rejects(withStateFaultForTest(async (point, path) => {
    if (point !== 'file-synced') return;
    const temp = (await readdir(dirname(path))).find((name) => name.startsWith('.dhr-') && name.endsWith('.tmp'));
    assert.ok(temp);
    await rm(join(dirname(path), temp));
    await writeFile(join(dirname(path), temp), JSON.stringify({ ...state, revision: 999 }));
  }, () => compareAndSwapRun(handle, 'run-a', 0, { ...state, revision: 1 })), (error) => error instanceof StateError);
  assert.equal(JSON.parse(await readFile(runPath, 'utf8')).revision, 0);
});

test('interruption between immutable link and temporary unlink is diagnosed, never silently adopted', async (t) => {
  const { handle, state, runPath } = await setup(t, { create: false });
  await assert.rejects(withStateFaultForTest((point) => { if (point === 'linked') throw new Error('Interrupted link publication'); }, () => createRun(handle, state)), /Interrupted link publication/u);
  assert.equal(JSON.parse(await readFile(runPath, 'utf8')).revision, 0);
  await fails(readRunAtRevision(handle, 'run-a', 0), 'STATE_PATH_INVALID');
});

for (const point of ['half-written', 'published']) {
  test(`killed writer at ${point} preserves valid JSON and does not authorize stale-lock takeover`, { timeout: 30_000 }, async (t) => {
    const { project, handle, runPath, cleanup } = await setup(t);
    await releaseLock(handle);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./kill-writer.mjs', import.meta.url)), project.repoRoot, project.privateGitDir, point], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let reached = false; child.on('message', (message) => { if (message.point === point) reached = true; });
    let stderr = ''; child.stderr.on('data', (data) => { stderr += data; });
    const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await completion.catch(() => {});
    });
    const outcome = await completion;
    assert.equal(reached, true, stderr);
    assert.ok(outcome.signal === 'SIGKILL' || outcome.code !== 0, stderr);
    const state = JSON.parse(await readFile(runPath, 'utf8'));
    assert.equal(state.revision, point === 'half-written' ? 0 : 1);
    assert.equal((await inspectLock(project)).status, 'unknown');
    await assert.rejects(acquireLock(project, { runId: 'run-b', adapter: 'codex' }), { code: 'LOCK_OWNER_UNKNOWN' });
  });
}
