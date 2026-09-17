import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { acquireLock, releaseLock } from '../../dist/lock/index.js';
import { appendAttemptLog, captureAttemptLogRefs, compareAndSwapRun, createAttempt, createRun, readEvidence, writeResult } from '../../dist/state/index.js';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fails = (promise, code) => assert.rejects(promise, error => error.code === code);
const fixture = async path => JSON.parse(await readFile(new URL(`../../../contracts/fixtures/${path}.json`, import.meta.url), 'utf8'));

async function setup(t) {
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'dhr-worker-logs-')));
  await execute('git', ['-C', repoRoot, 'init', '--quiet', '-b', 'main']);
  const privateGitDir = await realpath(join(repoRoot, '.git'));
  const project = { repoRoot, privateGitDir, stateRoot: join(privateGitDir, 'dev-harness-runtime', 'runs') };
  const handle = await acquireLock(project, { runId: 'run-a', adapter: 'codex' });
  t.after(async () => { await releaseLock(handle).catch(() => {}); await rm(repoRoot, { recursive: true, force: true }); });
  const initial = await fixture('state/run-created');
  initial.repoIdentity = { ...initial.repoIdentity, repoRoot, privateGitDir };
  await createRun(handle, initial);
  const identity = { runId: 'run-a', taskId: 'K1', attempt: 1, requestId: 'request-a' };
  const state = await compareAndSwapRun(handle, 'run-a', 0, { ...initial, revision: 1, status: 'RUNNING', phase: 'EXECUTE',
    currentTaskId: identity.taskId, currentAttempt: identity.attempt, currentRequestId: identity.requestId });
  const paths = await createAttempt(handle, 'run-a', 1, identity);
  const runPath = join(project.stateRoot, 'run-a', 'run.json');
  const append = (stream, bytes) => appendAttemptLog(handle, 'run-a', 1, identity, stream, bytes);
  const capture = () => captureAttemptLogRefs(handle, 'run-a', 1, identity);
  return { repoRoot, project, handle, state, identity, paths, runPath, append, capture };
}

test('Core log chunks preserve invocation order and bytes without changing Run authority', async t => {
  const f = await setup(t); const before = await readFile(f.runPath);
  const chunks = [Buffer.from('first\n'), Buffer.from([0, 255, 254]), Buffer.from('last\n')];
  await Promise.all(chunks.map(bytes => f.append('stdout', bytes)));
  const mutable = Buffer.from('original'); const writing = f.append('stderr', mutable); mutable.fill(120); await writing;
  await f.append('events', Buffer.from('{"event":"started"}\n'));
  await f.append('events', Buffer.alloc(0));
  const refs = await f.capture();
  assert.deepEqual(Object.keys(refs).sort(), ['events', 'stderr', 'stdout']);
  const expected = { stdout: Buffer.concat(chunks), stderr: Buffer.from('original'), events: Buffer.from('{"event":"started"}\n') };
  for (const stream of ['stdout', 'stderr', 'events']) {
    assert.equal(refs[stream].sha256, hash(expected[stream]));
    assert.equal(refs[stream].path, `attempts/K1-1/${stream === 'events' ? 'events.jsonl' : `${stream}.log`}`);
    assert.deepEqual(await readEvidence(f.handle, 'run-a', 1, refs[stream]), expected[stream]);
    assert.deepEqual(Object.keys(refs[stream]).sort(), ['path', 'schemaVersion', 'sha256']);
  }
  assert.deepEqual(await readFile(f.runPath), before);
});

test('long logs retain every chunk while only individual chunks have a 1 MiB limit', async t => {
  const f = await setup(t); const digest = createHash('sha256');
  for (let index = 0; index < 12; index++) {
    const chunk = Buffer.alloc(1024 * 1024, index); digest.update(chunk); await f.append('stdout', chunk);
  }
  const refs = await f.capture();
  assert.equal(refs.stdout.sha256, digest.digest('hex'));
  assert.equal((await readFile(f.paths.stdoutPath)).length, 12 * 1024 * 1024);
  await fails(f.append('stdout', Buffer.alloc(1024 * 1024 + 1)), 'AUTHORIZATION_VIOLATION');
  await fails(f.append('unknown', Buffer.from('bad')), 'AUTHORIZATION_VIOLATION');
  await fails(f.append('stdout', 'not bytes'), 'AUTHORIZATION_VIOLATION');
  assert.deepEqual(await f.capture(), refs);
});

test('stale revisions and cross-attempt or request identities cannot read or append logs', async t => {
  const f = await setup(t);
  for (const identity of [{ ...f.identity, attempt: 2 }, { ...f.identity, requestId: 'different' }, { ...f.identity, taskId: 'K2' }, { ...f.identity, runId: 'run-b' }]) {
    await fails(appendAttemptLog(f.handle, 'run-a', 1, identity, 'stdout', Buffer.from('wrong')), 'STATE_IDENTITY_MISMATCH');
    await fails(captureAttemptLogRefs(f.handle, 'run-a', 1, identity), 'STATE_IDENTITY_MISMATCH');
  }
  await fails(appendAttemptLog(f.handle, 'run-a', 0, f.identity, 'stdout', Buffer.from('old')), 'REVISION_CONFLICT');
  await fails(captureAttemptLogRefs(f.handle, 'run-a', 0, f.identity), 'REVISION_CONFLICT');
  assert.equal((await readFile(f.paths.stdoutPath)).length, 0);
});

test('recorded historical result identity permits only log capture, not appending', async t => {
  const f = await setup(t); await f.append('stdout', Buffer.from('complete raw output'));
  const result = await fixture('execution/result-partial');
  const ref = await writeResult(f.handle, 'run-a', 1, result);
  const next = { ...f.state, revision: 2, phase: 'SELECT', resultRefs: [{ identity: f.identity, ref }] };
  delete next.currentTaskId; delete next.currentAttempt; delete next.currentRequestId;
  await compareAndSwapRun(f.handle, 'run-a', 1, next);
  const refs = await captureAttemptLogRefs(f.handle, 'run-a', 2, f.identity);
  assert.equal(refs.stdout.sha256, hash(Buffer.from('complete raw output')));
  await fails(appendAttemptLog(f.handle, 'run-a', 2, f.identity, 'stdout', Buffer.from('late')), 'STATE_IDENTITY_MISMATCH');
  await fails(captureAttemptLogRefs(f.handle, 'run-a', 2, { ...f.identity, requestId: 'different' }), 'STATE_IDENTITY_MISMATCH');
});

test('a current identity outside RUNNING EXECUTE does not authorize log writes', async t => {
  const f = await setup(t);
  const next = { ...f.state, revision: 2, phase: 'REVALIDATE' };
  await compareAndSwapRun(f.handle, 'run-a', 1, next);
  await fails(appendAttemptLog(f.handle, 'run-a', 2, f.identity, 'stdout', Buffer.from('late')), 'AUTHORIZATION_VIOLATION');
  assert.equal((await captureAttemptLogRefs(f.handle, 'run-a', 2, f.identity)).stdout.sha256, hash(Buffer.alloc(0)));
  await compareAndSwapRun(f.handle, 'run-a', 2, { ...next, revision: 3, phase: 'EXECUTE', status: 'INTERRUPTED',
    stopReason: { code: 'PROCESS_INTERRUPTED', message: 'Fixture interrupted attempt' } });
  await fails(appendAttemptLog(f.handle, 'run-a', 3, f.identity, 'stdout', Buffer.from('late')), 'AUTHORIZATION_VIOLATION');
});

test('symlink and hardlink log substitutions fail without modifying their target', async t => {
  const f = await setup(t); const target = join(f.repoRoot, 'user-file'); await writeFile(target, 'preserve');
  for (const substitute of [symlink, link]) {
    await rm(f.paths.stdoutPath); await substitute(target, f.paths.stdoutPath);
    await fails(f.append('stdout', Buffer.from('injected')), 'STATE_PATH_INVALID');
    await fails(f.capture(), 'STATE_PATH_INVALID');
    assert.equal(await readFile(target, 'utf8'), 'preserve');
  }
});

test('missing logs are not recreated by append or capture', async t => {
  const f = await setup(t); await rm(f.paths.eventsPath);
  await fails(f.append('events', Buffer.from('new')), 'ENOENT');
  await fails(f.capture(), 'ENOENT');
});

test('Worker environment cannot access private log append or capture APIs', async t => {
  const f = await setup(t); const previous = process.env.DEV_HARNESS_WORKER;
  try {
    process.env.DEV_HARNESS_WORKER = '1';
    await fails(f.append('stdout', Buffer.from('forged')), 'AUTHORIZATION_VIOLATION');
    await fails(f.capture(), 'AUTHORIZATION_VIOLATION');
  } finally {
    if (previous === undefined) delete process.env.DEV_HARNESS_WORKER; else process.env.DEV_HARNESS_WORKER = previous;
  }
  assert.equal((await readFile(f.paths.stdoutPath)).length, 0);
});
