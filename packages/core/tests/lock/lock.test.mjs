import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, inspectLock, releaseLock, withLock } from '../../dist/lock/index.js';

async function projectFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dhr-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', directory]);
  const repoRoot = await realpath(directory);
  const privateGitDir = await realpath(join(repoRoot, '.git'));
  return { repoRoot, privateGitDir, stateRoot: join(privateGitDir, 'dev-harness-runtime', 'runs') };
}

const options = { runId: 'run-a', adapter: 'codex' };
const ownerPath = (project) => join(project.stateRoot, '.orchestrator.lock', 'owner.json');
const code = (expected) => (error) => error.code === expected;

test('exclusive lock has private metadata, rejects forged handles, and releases cleanly', async (t) => {
  const project = await projectFixture(t);
  assert.deepEqual(await inspectLock(project), { status: 'available' });
  const handle = await acquireLock(project, options);
  const owner = JSON.parse(await readFile(ownerPath(project), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.runId, options.runId);
  assert.equal(owner.repoRoot, project.repoRoot);
  assert.equal(owner.privateGitDir, project.privateGitDir);
  if (process.platform === 'linux') assert.match(owner.processStartIdentity, /^linux:/);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(ownerPath(project))).mode & 0o777, 0o600);
    assert.equal((await lstat(project.stateRoot)).mode & 0o777, 0o700);
  }
  await assert.rejects(acquireLock(project, options), (error) => ['LOCK_BUSY', 'LOCK_OWNER_UNKNOWN'].includes(error.code));
  await assert.rejects(withLock({}, async () => {}), code('LOCK_NOT_OWNER'));
  await assert.rejects(releaseLock({ ownerToken: owner.ownerToken }), code('LOCK_NOT_OWNER'));
  await withLock(handle, async (context) => {
    assert.equal(context.stateRoot, project.stateRoot);
    assert.equal(context.runId, 'run-a');
    await context.assertOwner();
  });
  await releaseLock(handle);
  assert.deepEqual(await inspectLock(project), { status: 'available' });
  await assert.rejects(withLock(handle, async () => {}), code('LOCK_NOT_OWNER'));
});

test('withLock serializes callbacks and release in the same queue', async (t) => {
  const project = await projectFixture(t);
  const handle = await acquireLock(project, options);
  const order = [];
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const first = withLock(handle, async () => { order.push('first'); entered(); await gate; order.push('first-done'); });
  await started;
  const second = withLock(handle, async () => { order.push('second'); });
  const released = releaseLock(handle);
  const afterRelease = assert.rejects(withLock(handle, async () => { order.push('invalid'); }), code('LOCK_NOT_OWNER'));
  unblock();
  await Promise.all([first, second, released, afterRelease]);
  assert.deepEqual(order, ['first', 'first-done', 'second']);
});

test('changed owner token prevents state callbacks and release, preserving metadata', async (t) => {
  const project = await projectFixture(t);
  const handle = await acquireLock(project, options);
  const original = JSON.parse(await readFile(ownerPath(project), 'utf8'));
  const changed = { ...original, ownerToken: 'other-owner' };
  await writeFile(ownerPath(project), JSON.stringify(changed));
  await assert.rejects(withLock(handle, async () => assert.fail('must not run')), code('LOCK_NOT_OWNER'));
  await assert.rejects(releaseLock(handle), code('LOCK_NOT_OWNER'));
  assert.deepEqual(JSON.parse(await readFile(ownerPath(project), 'utf8')), changed);
});

test('corrupt owner metadata and stale-looking owner are never automatically deleted', async (t) => {
  const project = await projectFixture(t);
  const handle = await acquireLock(project, options);
  const original = JSON.parse(await readFile(ownerPath(project), 'utf8'));
  for (const contents of ['{"schemaVersion":', JSON.stringify({ ...original, pid: 2147483647, processStartIdentity: 'old-identity', createdAt: '2000-01-01T00:00:00Z' })]) {
    await writeFile(ownerPath(project), contents);
    assert.equal((await inspectLock(project)).status, 'unknown');
    await assert.rejects(acquireLock(project, options), code('LOCK_OWNER_UNKNOWN'));
    assert.equal(await readFile(ownerPath(project), 'utf8'), contents);
  }
  await assert.rejects(releaseLock(handle), code('LOCK_NOT_OWNER'));
});

test('a residual guard blocks acquisition without deleting or rewriting it', async (t) => {
  const project = await projectFixture(t);
  const handle = await acquireLock(project, options);
  await releaseLock(handle);
  const guard = join(project.stateRoot, '.orchestrator.guard');
  await mkdir(guard, { mode: 0o700 });
  assert.equal((await inspectLock(project)).status, 'unknown');
  await assert.rejects(acquireLock(project, options), code('LOCK_OWNER_UNKNOWN'));
  assert.ok((await lstat(guard)).isDirectory());
  await assert.rejects(lstat(ownerPath(project)), { code: 'ENOENT' });
});

test('symlink state substitution and caller-supplied private paths are rejected', async (t) => {
  const project = await projectFixture(t);
  const handle = await acquireLock(project, options);
  await assert.rejects(acquireLock({ ...project, privateGitDir: project.repoRoot }, options), code('LOCK_PATH_INVALID'));
  const saved = `${project.stateRoot}-saved`;
  await rename(project.stateRoot, saved);
  await symlink(saved, project.stateRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(withLock(handle, async () => assert.fail('must not run')), code('LOCK_PATH_INVALID'));
  await assert.rejects(releaseLock(handle), code('LOCK_PATH_INVALID'));
  assert.equal(JSON.parse(await readFile(join(saved, '.orchestrator.lock', 'owner.json'), 'utf8')).runId, 'run-a');
});

test('real child processes compete for a single worktree owner', { timeout: 30000 }, async (t) => {
  const project = await projectFixture(t);
  const children = Array.from({ length: 4 }, () => fork(fileURLToPath(new URL('./contender.mjs', import.meta.url)), [JSON.stringify(project)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const messages = children.map((child) => {
    let errorText = '';
    child.stderr.on('data', (data) => { errorText += data; });
    return once(child, 'message').then(([message]) => { assert.equal(message.status, 'ready', errorText); });
  });
  await Promise.all(messages);
  const results = children.map((child) => once(child, 'message').then(([message]) => message));
  for (const child of children) child.send('acquire');
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter((result) => result.status === 'acquired').length, 1);
  for (const result of outcomes.filter((result) => result.status !== 'acquired')) {
    assert.equal(result.status, 'rejected');
    assert.ok(['LOCK_BUSY', 'LOCK_OWNER_UNKNOWN'].includes(result.code));
  }
  const finished = children.map((child) => once(child, 'message').then(([message]) => { assert.equal(message.status, 'released'); }));
  for (const child of children) child.send('release');
  await Promise.all(finished);
  assert.deepEqual(await inspectLock(project), { status: 'available' });
});
