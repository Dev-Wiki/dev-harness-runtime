import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  captureSnapshot, discoverProject, snapshotBoundaryHash, verifyAuthorizedCommit,
} from '../../dist/index.js';
import { ContractValidationError } from '../../../contracts/dist/index.js';

const execute = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const authorization = (commit = 'task') => ({
  schemaVersion: 1, runId: 'run-a', commit, push: false,
  pullRequest: false, tag: false, release: false, deploy: false,
});
async function git(root, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return (await execute('git', ['--no-replace-objects', '-C', root, ...args], { env, encoding: 'buffer' })).stdout;
}
async function gitText(root, ...args) {
  return (await git(root, ...args)).toString('utf8').replace(/\r?\n$/u, '');
}
async function commit(root, message = 'Complete task\n\nRecord verified changes.') {
  await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', message);
}
async function repository(t, objectFormat = 'sha1') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-commit-guard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '--quiet', '-b', 'main', `--object-format=${objectFormat}`);
  await git(root, 'config', 'core.autocrlf', 'false');
  await mkdir(join(root, 'docs/plan/tasks'), { recursive: true });
  await mkdir(join(root, 'src'));
  const files = {
    'AGENTS.md': '# Project\n\n[Git workflow](docs/GIT_WORKFLOW.md)\n',
    'HARNESS.md': '# HARNESS\n\n## 已确认命令\n\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| test | `node --test` | confirmed |\n',
    'docs/GIT_WORKFLOW.md': '# Git workflow\n\nCreate one commit for an accepted task.\n',
    'docs/plan/Dashboard.md': '# Dashboard\n',
    'docs/plan/tasks/A.md': '# Task A\n',
    'src/a.ts': 'export const value = 1;\n',
    'src/other.ts': 'export const other = 1;\n',
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  await git(root, 'add', '--', ...Object.keys(files));
  await commit(root, 'Initial fixture');
  const initialHead = await gitText(root, 'rev-parse', 'HEAD');
  const options = {
    project: await discoverProject(root), runId: 'run-a',
    protocolSource: {
      schemaVersion: 1, repository: 'https://example.com/protocol.git', version: '1.0.0',
      commit: initialHead, files: [{ path: 'planning/SKILL.md', sha256: 'a'.repeat(64) }],
    },
    adapterConfigHash: 'b'.repeat(64), currentTaskPath: join(root, 'docs/plan/tasks/A.md'),
  };
  return { root, options };
}
async function intentFor(root, parent) {
  const head = await gitText(root, 'rev-parse', 'HEAD');
  const raw = await git(root, 'cat-file', 'commit', head);
  const changed = await git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', parent, head, '--');
  return {
    parent, expectedTree: await gitText(root, 'rev-parse', `${head}^{tree}`),
    paths: changed.length === 0 ? [] : changed.toString('utf8').slice(0, -1).split('\0'),
    messageHash: hash(raw.subarray(raw.indexOf(Buffer.from('\n\n')) + 2)),
  };
}
async function committed(t, objectFormat = 'sha1', { inheritedDirty = false } = {}) {
  const fixture = await repository(t, objectFormat);
  if (inheritedDirty) await writeFile(join(fixture.root, 'src/other.ts'), 'User change predating the task.\n');
  const before = await captureSnapshot(fixture.options);
  await writeFile(join(fixture.root, 'src/a.ts'), 'export const value = 2;\n');
  await git(fixture.root, 'add', '--', 'src/a.ts');
  await commit(fixture.root);
  const after = await captureSnapshot(fixture.options);
  return { ...fixture, before, after, intent: await intentFor(fixture.root, before.snapshot.repoIdentity.head) };
}
const rejectsCode = (promise, code = 'DRIFT_DETECTED') => assert.rejects(promise,
  (error) => error instanceof ContractValidationError && error.code === code);

for (const format of ['sha1', 'sha256']) {
  test(`authorized ${format} commit matches actual parent, tree, raw message and exact path set`, async (t) => {
    const { before, after, intent } = await committed(t, format);
    await assert.doesNotReject(verifyAuthorizedCommit(before, after, authorization(), intent));
  });
}

test('commit verification refuses no-commit authorization and a different Run authorization', async (t) => {
  const { before, after, intent } = await committed(t);
  await rejectsCode(verifyAuthorizedCommit(before, after, authorization('deny'), intent), 'AUTHORIZATION_VIOLATION');
  await rejectsCode(verifyAuthorizedCommit(before, after, { ...authorization(), runId: 'other-run' }, intent), 'AUTHORIZATION_VIOLATION');
});

test('snapshot and authorization records are parsed at the runtime boundary', async (t) => {
  const { before, after, intent } = await committed(t);
  await rejectsCode(verifyAuthorizedCommit(before, after, { ...authorization(), push: true }, intent), 'INVALID_CONTRACT');
  const invalid = structuredClone(after);
  invalid.snapshot.schemaVersion = 2;
  await rejectsCode(verifyAuthorizedCommit(before, invalid, authorization(), intent), 'INVALID_CONTRACT');
});

test('standalone commit verification rejects tampered before and after record hashes', async (t) => {
  const { before, after, intent } = await committed(t);
  for (const side of ['before', 'after']) {
    const prior = structuredClone(before);
    const accepted = structuredClone(after);
    const altered = side === 'before' ? prior : accepted;
    altered.hash = hash('A different persisted snapshot record');
    assert.equal(altered.boundaryHash, snapshotBoundaryHash(altered.snapshot));
    await assert.rejects(verifyAuthorizedCommit(prior, accepted, authorization(), intent),
      (error) => error instanceof ContractValidationError && error.code === 'DRIFT_DETECTED'
        && error.message === 'Captured record digest does not match its snapshot');
  }
});

for (const [name, mutate] of [
  ['parent', (intent, after) => { intent.parent = after.snapshot.repoIdentity.head; }],
  ['tree', (intent, after) => { intent.expectedTree = after.snapshot.repoIdentity.head; }],
  ['paths', (intent) => { intent.paths = ['src/other.ts']; }],
  ['additional paths', (intent) => { intent.paths.push('src/other.ts'); }],
  ['message', (intent) => { intent.messageHash = hash('Different message\n'); }],
  ['duplicate paths', (intent) => { intent.paths.push(intent.paths[0]); }],
  ['escaping paths', (intent) => { intent.paths = ['../outside']; }],
]) {
  test(`commit rejects an incorrect intent ${name}`, async (t) => {
    const { before, after, intent } = await committed(t);
    mutate(intent, after);
    await rejectsCode(verifyAuthorizedCommit(before, after, authorization(), intent));
  });
}

test('commit snapshots must agree on repository, private worktree Git directory and branch', async (t) => {
  const { before, after, intent } = await committed(t);
  for (const [property, value] of [['repoRoot', `${before.snapshot.repoIdentity.repoRoot}-other`], ['privateGitDir', `${before.snapshot.repoIdentity.privateGitDir}-other`], ['branch', 'other-branch']]) {
    const changed = structuredClone(before);
    changed.snapshot.repoIdentity[property] = value;
    changed.boundaryHash = snapshotBoundaryHash(changed.snapshot);
    await rejectsCode(verifyAuthorizedCommit(changed, after, authorization(), intent));
  }
});

test('two successive commits cannot be accepted as one authorized task commit', async (t) => {
  const fixture = await committed(t);
  await writeFile(join(fixture.root, 'src/a.ts'), 'export const value = 3;\n');
  await git(fixture.root, 'add', '--', 'src/a.ts');
  await commit(fixture.root, 'Unauthorized second advance');
  const after = await captureSnapshot(fixture.options);
  const intent = await intentFor(fixture.root, fixture.before.snapshot.repoIdentity.head);
  await rejectsCode(verifyAuthorizedCommit(fixture.before, after, authorization(), intent));
});

test('a merge commit is rejected even with a matching tree, message and path set', async (t) => {
  const { root, options } = await repository(t);
  await git(root, 'switch', '--quiet', '-c', 'side');
  await writeFile(join(root, 'src/other.ts'), 'export const other = 2;\n');
  await git(root, 'add', '--', 'src/other.ts');
  await commit(root, 'Side change');
  await git(root, 'switch', '--quiet', 'main');
  await writeFile(join(root, 'src/a.ts'), 'export const value = 2;\n');
  await git(root, 'add', '--', 'src/a.ts');
  await commit(root, 'Main change');
  const before = await captureSnapshot(options);
  await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '--quiet', '--no-gpg-sign', '--no-ff', '-m', 'Merge side', 'side');
  const after = await captureSnapshot(options);
  await rejectsCode(verifyAuthorizedCommit(before, after, authorization(), await intentFor(root, before.snapshot.repoIdentity.head)));
});

test('the intent message digest includes its exact UTF-8 bytes and terminal newline', async (t) => {
  const { root, options } = await repository(t);
  const before = await captureSnapshot(options);
  await writeFile(join(root, 'src/a.ts'), 'export const value = 2;\n');
  await git(root, 'add', '--', 'src/a.ts');
  await commit(root, '完成 A\n\nPreserve this body.');
  const after = await captureSnapshot(options);
  const intent = await intentFor(root, before.snapshot.repoIdentity.head);
  assert.equal(intent.messageHash, hash('完成 A\n\nPreserve this body.\n'));
  await assert.doesNotReject(verifyAuthorizedCommit(before, after, authorization(), intent));
  intent.messageHash = hash('完成 A\n\nPreserve this body.');
  await rejectsCode(verifyAuthorizedCommit(before, after, authorization(), intent));
});

test('a rename must account for both deleted and added paths with rename detection disabled', async (t) => {
  const { root, options } = await repository(t);
  const before = await captureSnapshot(options);
  await git(root, 'mv', '--', 'src/a.ts', 'src/renamed.ts');
  await commit(root, 'Rename source');
  const after = await captureSnapshot(options);
  const intent = await intentFor(root, before.snapshot.repoIdentity.head);
  assert.deepEqual(intent.paths.toSorted(), ['src/a.ts', 'src/renamed.ts']);
  await assert.doesNotReject(verifyAuthorizedCommit(before, after, authorization(), intent));
  intent.paths = ['src/renamed.ts'];
  await rejectsCode(verifyAuthorizedCommit(before, after, authorization(), intent));
});

test('remaining unrelated original dirty content is left for the inherited ownership guard', async (t) => {
  const { before, after, intent } = await committed(t, 'sha1', { inheritedDirty: true });
  assert.ok(after.dirtyPaths.includes('src/other.ts'));
  await assert.doesNotReject(verifyAuthorizedCommit(before, after, authorization(), intent));
});

test('a committed path that remains dirty is rejected even when after was captured after that edit', async (t) => {
  const fixture = await committed(t);
  await writeFile(join(fixture.root, 'src/a.ts'), 'Unaccepted change after commit\n');
  const after = await captureSnapshot(fixture.options);
  after.dirtyPaths = [];
  after.stagedPaths = [];
  await rejectsCode(verifyAuthorizedCommit(fixture.before, after, authorization(), fixture.intent));
});

for (const action of ['worktree', 'index', 'head', 'branch', 'index-flag']) {
  test(`stale after snapshots cannot hide a subsequent ${action} change`, async (t) => {
    const fixture = await committed(t);
    if (action === 'worktree' || action === 'index' || action === 'head') {
      await writeFile(join(fixture.root, 'src/a.ts'), 'export const value = 99;\n');
      if (action !== 'worktree') await git(fixture.root, 'add', '--', 'src/a.ts');
      if (action === 'head') await commit(fixture.root, 'Unexpected HEAD');
    } else if (action === 'branch') await git(fixture.root, 'branch', '-m', 'renamed-branch');
    else await git(fixture.root, 'update-index', '--assume-unchanged', '--', 'src/a.ts');
    await rejectsCode(verifyAuthorizedCommit(fixture.before, fixture.after, authorization(), fixture.intent));
  });
}

test('raw worktree verification detects edits hidden behind assume-unchanged', async (t) => {
  const fixture = await committed(t);
  await git(fixture.root, 'update-index', '--assume-unchanged', '--', 'src/a.ts');
  const after = await captureSnapshot(fixture.options);
  await writeFile(join(fixture.root, 'src/a.ts'), 'Hidden unaccepted bytes\n');
  assert.equal(await gitText(fixture.root, 'status', '--porcelain'), '');
  await rejectsCode(verifyAuthorizedCommit(fixture.before, after, authorization(), fixture.intent));
});

test('replacement refs cannot substitute different parent/tree/message data for a real commit', async (t) => {
  const fixture = await committed(t);
  const replacement = await gitText(fixture.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', fixture.intent.expectedTree, '-p', fixture.intent.parent, '-m', 'Replacement-only message');
  await git(fixture.root, 'replace', fixture.after.snapshot.repoIdentity.head, replacement);
  await assert.doesNotReject(verifyAuthorizedCommit(fixture.before, fixture.after, authorization(), fixture.intent));
});
