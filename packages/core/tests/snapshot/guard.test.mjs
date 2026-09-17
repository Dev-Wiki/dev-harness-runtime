import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureSnapshot } from '../../dist/snapshot/capture.js';
import { assertUnchanged, assertTaskStart, verifyOwnedTransition, compareSnapshots } from '../../dist/snapshot/guard.js';
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim(); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dhr-snapshot-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['src', 'notes', 'docs/plan/tasks', 'docs/plan/archive/M1']) await mkdir(join(root, dir), { recursive: true });
  for (const [path, text] of Object.entries({ 'AGENTS.md': '# Agents\n', 'HARNESS.md': '# Harness\n', 'docs/GIT_WORKFLOW.md': '# Workflow\n', 'docs/plan/Dashboard.md': '# Dashboard\n', 'docs/plan/tasks/A.md': '# Task A\n', 'src/a.txt': 'initial\n', 'notes/user.txt': 'original\n' })) await writeFile(join(root, path), text);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Runtime Test'); git(root, 'config', 'user.email', 'runtime@example.invalid'); git(root, 'config', 'core.autocrlf', 'false'); git(root, 'add', '.'); git(root, 'commit', '-m', 'initial');
  const options = {
    project: { repoRoot: root, privateGitDir: join(root, '.git'), stateRoot: join(root, '.git/dev-harness-runtime/runs'), docsRoot: join(root, 'docs'), dashboardPath: join(root, 'docs/plan/Dashboard.md'), head: git(root, 'rev-parse', 'HEAD'), agentsPath: join(root, 'AGENTS.md'), harnessPath: join(root, 'HARNESS.md'), gitWorkflowPath: join(root, 'docs/GIT_WORKFLOW.md'), verificationCommands: [], issues: [] },
    runId: 'run-guard', adapterConfigHash: 'a'.repeat(64), currentTaskPath: join(root, 'docs/plan/tasks/A.md'),
    protocolSource: { schemaVersion: 1, repository: 'https://example.invalid/protocol', version: '1.0.0', commit: 'b'.repeat(40), files: [{ path: 'protocol.md', sha256: 'c'.repeat(64) }] },
  };
  const scope = { schemaVersion: 1, files: ['src/a.txt'], directories: [], planning: { taskId: 'A', taskPath: 'docs/plan/tasks/A.md', archivePath: 'docs/plan/archive/M1/A.md', dashboardPath: 'docs/plan/Dashboard.md', archiveIndexPath: 'docs/plan/archive/M1/README.md' } };
  const authorization = { schemaVersion: 1, runId: 'run-guard', commit: 'deny', push: false, pullRequest: false, tag: false, release: false, deploy: false };
  return { root, options, scope, authorization, capture: () => captureSnapshot(options) };
}
function verifiedPolicy(f, initial, before, after) {
  return { scope: f.scope, initial, authorization: f.authorization,
    async verifyOwnership(boundary) {
      return boundary.runId === f.authorization.runId && boundary.taskId === 'A' && boundary.beforeHash === before.hash && boundary.afterHash === after.hash && JSON.stringify(boundary.paths) === JSON.stringify(compareSnapshots(before.snapshot, after.snapshot).paths);
    } };
}
test('same status with different dirty bytes is detected, while repeated unchanged captures agree', async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, 'src/a.txt'), 'one\n');
  const before = await f.capture(); const status = git(f.root, 'status', '--porcelain');
  assertUnchanged(before, await f.capture());
  await writeFile(join(f.root, 'src/a.txt'), 'two\n');
  const after = await f.capture(); assert.equal(git(f.root, 'status', '--porcelain'), status);
  assert.throws(() => assertUnchanged(before, after), { code: 'DRIFT_DETECTED' });
});
test('scope alone cannot authorize a change; trusted evidence must bind the exact before/after boundary', async (t) => {
  const f = await fixture(t); const before = await f.capture();
  await writeFile(join(f.root, 'src/a.txt'), 'owned\n'); const after = await f.capture();
  const policy = verifiedPolicy(f, before, before, after);
  await assert.rejects(verifyOwnedTransition(before, after, { ...policy, verifyOwnership: async () => false }), { code: 'AUTHORIZATION_VIOLATION' });
  await assert.rejects(verifyOwnedTransition(before, after, { ...policy, verifyOwnership: undefined }), { code: 'AUTHORIZATION_VIOLATION' });
  assert.deepEqual((await verifyOwnedTransition(before, after, policy)).contentPaths, ['src/a.txt']);
});
test('initial dirty content is protected, and accepted no-commit changes remain controlled across Tasks', async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, 'notes/user.txt'), 'user change\n');
  const initial = await f.capture();
  assert.ok(initial.dirtyPaths.includes('notes/user.txt'));
  await writeFile(join(f.root, 'src/a.txt'), 'first\n'); const first = await f.capture();
  await verifyOwnedTransition(initial, first, verifiedPolicy(f, initial, initial, first));
  assertTaskStart(initial, first, f.scope);
  await writeFile(join(f.root, 'src/a.txt'), 'second\n'); const second = await f.capture();
  await verifyOwnedTransition(first, second, verifiedPolicy(f, initial, first, second));
  await writeFile(join(f.root, 'notes/user.txt'), 'damaged\n'); const damaged = await f.capture();
  await assert.rejects(verifyOwnedTransition(second, damaged, verifiedPolicy(f, initial, second, damaged)));
});
test('preexisting changes in Task scope and any preexisting staged content block startup', async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, 'src/a.txt'), 'user change\n');
  const initial = await f.capture(); assert.throws(() => assertTaskStart(initial, initial, f.scope), { code: 'USER_CHANGES_PRESENT' });
  git(f.root, 'restore', 'src/a.txt'); await writeFile(join(f.root, 'notes/user.txt'), 'staged\n'); git(f.root, 'add', 'notes/user.txt');
  const staged = await f.capture(); assert.throws(() => assertTaskStart(staged, staged, f.scope), { code: 'USER_CHANGES_PRESENT' });
});
test('Worker index changes and no-commit HEAD advancement are rejected', async (t) => {
  const f = await fixture(t); const before = await f.capture();
  await writeFile(join(f.root, 'src/a.txt'), 'staged\n'); git(f.root, 'add', 'src/a.txt'); const staged = await f.capture();
  await assert.rejects(verifyOwnedTransition(before, staged, verifiedPolicy(f, before, before, staged)), { code: 'DRIFT_DETECTED' });
  git(f.root, 'commit', '-m', 'unauthorized'); const committed = await f.capture();
  await assert.rejects(verifyOwnedTransition(before, committed, verifiedPolicy(f, before, before, committed)), { code: 'AUTHORIZATION_VIOLATION' });
});
test('broad documentation scope cannot authorize another Task or hide an out-of-scope change', async (t) => {
  const f = await fixture(t); f.scope.directories = ['docs']; const before = await f.capture();
  await writeFile(join(f.root, 'docs/plan/tasks/OTHER.md'), '# Other\n'); const after = await f.capture();
  await assert.rejects(verifyOwnedTransition(before, after, verifiedPolicy(f, before, before, after)), { code: 'AUTHORIZATION_VIOLATION' });
});
test('a newly owned symlink cannot point outside the repository', async (t) => {
  const f = await fixture(t); f.scope.files.push('src/link'); const before = await f.capture();
  try { await symlink(tmpdir(), join(f.root, 'src/link'), 'junction'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Symlink privilege unavailable'); return; } throw error; }
  const after = await f.capture();
  await assert.rejects(verifyOwnedTransition(before, after, verifiedPolicy(f, before, before, after)), { code: 'AUTHORIZATION_VIOLATION' });
});
test('tampered snapshot records cannot use an old boundary or file digest', async (t) => {
  const f = await fixture(t); const before = await f.capture(); const forged = structuredClone(before);
  forged.snapshot.repoIdentity.branch = 'forged';
  assert.throws(() => assertUnchanged(before, forged), { code: 'DRIFT_DETECTED' });
});

test('the four authorized Planning closure files can transition together with an archived current Task reference', async (t) => {
  const f = await fixture(t); const before = await f.capture();
  await rename(join(f.root, f.scope.planning.taskPath), join(f.root, f.scope.planning.archivePath));
  await writeFile(join(f.root, f.scope.planning.dashboardPath), '# Updated Dashboard\n');
  await writeFile(join(f.root, f.scope.planning.archiveIndexPath), '# Archive index\n');
  const after = await captureSnapshot({ ...f.options, currentTaskPath: join(f.root, f.scope.planning.archivePath) });
  const delta = await verifyOwnedTransition(before, after, verifiedPolicy(f, before, before, after));
  assert.deepEqual(delta.contentPaths, [f.scope.planning.taskPath, f.scope.planning.archivePath, f.scope.planning.dashboardPath, f.scope.planning.archiveIndexPath].sort());
});

test('dirty and staged sidecars cannot be cleared while retaining valid snapshot hashes', async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, 'src/a.txt'), 'user edit\n');
  const dirty = await f.capture(); const forged = { ...dirty, dirtyPaths: [] };
  assert.throws(() => assertTaskStart(forged, forged, f.scope), { code: 'DRIFT_DETECTED' });
  git(f.root, 'add', 'src/a.txt'); const staged = await f.capture();
  const hidden = { ...staged, stagedPaths: [] };
  assert.throws(() => assertTaskStart(hidden, hidden, f.scope), { code: 'DRIFT_DETECTED' });
});
for (const kind of ['dangling-outside', 'private-git', 'inside-missing']) {
  test(`owned symlink containment handles ${kind}`, async (t) => {
    const f = await fixture(t); f.scope.files.push('src/link');
    if (kind === 'dangling-outside') {
      try { await symlink(join(tmpdir(), `missing-${Date.now()}`), join(f.root, 'bridge')); }
      catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Symlink privilege unavailable'); return; } throw error; }
    }
    const before = await f.capture();
    const target = kind === 'private-git' ? '../.git' : kind === 'dangling-outside' ? '../bridge/file' : '../missing/file';
    try { await symlink(target, join(f.root, 'src/link')); }
    catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Symlink privilege unavailable'); return; } throw error; }
    const after = await f.capture();
    if (kind === 'inside-missing') await verifyOwnedTransition(before, after, verifiedPolicy(f, before, before, after));
    else await assert.rejects(verifyOwnedTransition(before, after, verifiedPolicy(f, before, before, after)), { code: 'AUTHORIZATION_VIOLATION' });
  });
}

for (const operation of ['modify', 'rename']) {
  test(`owned authorized commit accepts exact ${operation} paths and index transitions`, async (t) => {
    const f = await fixture(t); f.authorization.commit = 'task';
    f.scope.files.push('src/b.txt'); const before = await f.capture();
    if (operation === 'rename') await rename(join(f.root, 'src/a.txt'), join(f.root, 'src/b.txt'));
    else await writeFile(join(f.root, 'src/a.txt'), 'owned edit\n');
    const paths = operation === 'rename' ? ['src/a.txt', 'src/b.txt'] : ['src/a.txt'];
    git(f.root, 'add', '--', ...paths);
    const message = 'owned change\n';
    const intent = { parent: before.snapshot.repoIdentity.head, expectedTree: git(f.root, 'write-tree'), paths, messageHash: createHash('sha256').update(message).digest('hex') };
    git(f.root, 'commit', '-m', message); const after = await f.capture();
    await verifyOwnedTransition(before, after, { ...verifiedPolicy(f, before, before, after), commit: intent });
  });
}
