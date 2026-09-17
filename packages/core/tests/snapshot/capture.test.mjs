import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { discoverProject } from '../../dist/discovery/index.js';
import { captureSnapshot, recaptureSnapshot, serializeSnapshot, snapshotBoundaryHash } from '../../dist/snapshot/capture.js';

const execute = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const protocolSource = { schemaVersion: 1, repository: 'https://example.com/protocol.git', version: '1.0.0', commit: 'a'.repeat(40), files: [{ path: 'planning/SKILL.md', sha256: 'b'.repeat(64) }] };
async function git(root, ...args) { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim(); }
async function write(root, path, content) {
  const target = join(root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content);
}
async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dhr-capture-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'project'); await mkdir(root);
  await git(root, 'init', '--quiet');
  await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  await write(root, 'AGENTS.md', '# Rules\n[Git](docs/GIT_WORKFLOW.md)\n');
  await write(root, 'HARNESS.md', '# HARNESS\n## 已确认命令\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| full | `node --test` | confirmed |\n');
  await write(root, 'docs/GIT_WORKFLOW.md', '# Git\n');
  await write(root, 'docs/plan/Dashboard.md', '# Dashboard\n');
  await write(root, 'docs/plan/tasks/K3.md', '# Task K3\n');
  await write(root, 'src/a.txt', 'initial\n');
  await git(root, 'add', '.'); await git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'initial');
  const project = await discoverProject(root);
  const options = { project, runId: 'run-capture', protocolSource, adapterConfigHash: 'c'.repeat(64), currentTaskPath: join(root, 'docs/plan/tasks/K3.md') };
  return { root, temporary, options };
}
const pathEntry = (captured, path) => captured.snapshot.paths.find((entry) => entry.path === path);

test('snapshot serialization hashes exact bytes and keeps time separate from the boundary', async (t) => {
  const { options } = await fixture(t);
  const first = await captureSnapshot(options); const second = await recaptureSnapshot(first);
  assert.equal(first.boundaryHash, second.boundaryHash);
  assert.equal(first.hash, hash(serializeSnapshot(first.snapshot)));
  assert.deepEqual(first.dirtyPaths, []); assert.deepEqual(first.stagedPaths, []);
  const later = structuredClone(first.snapshot); later.capturedAt = '2099-01-01T00:00:00Z'; later.paths.reverse(); later.indexFlags.reverse();
  assert.equal(snapshotBoundaryHash(later), first.boundaryHash);
  assert.notEqual(hash(serializeSnapshot(later)), first.hash);
});

test('same Git status and same-size second rewrite still change raw content hashes', async (t) => {
  const { root, options } = await fixture(t);
  await write(root, 'src/a.txt', 'first!!\n'); const first = await captureSnapshot(options); const status = await git(root, 'status', '--porcelain');
  await write(root, 'src/a.txt', 'second!\n'); const second = await captureSnapshot(options);
  assert.equal(await git(root, 'status', '--porcelain'), status);
  assert.notEqual(pathEntry(first, 'src/a.txt').rawContentHash, pathEntry(second, 'src/a.txt').rawContentHash);
  assert.notEqual(first.boundaryHash, second.boundaryHash);
  assert.deepEqual(second.dirtyPaths, ['src/a.txt']);
});

test('untracked, ignored and deleted files are all recorded', async (t) => {
  const { root, options } = await fixture(t);
  await write(root, '.gitignore', 'ignored/\n'); await write(root, 'ignored/raw.bin', Buffer.from([0xff, 0x00, 0xc3]));
  await write(root, 'new.txt', 'untracked'); await rm(join(root, 'src/a.txt'));
  const captured = await captureSnapshot(options);
  assert.equal(pathEntry(captured, 'ignored/raw.bin').rawContentHash, hash(Buffer.from([0xff, 0x00, 0xc3])));
  assert.equal(pathEntry(captured, 'new.txt').index.length, 0);
  assert.equal(pathEntry(captured, 'src/a.txt').deleted, true);
  assert.equal(pathEntry(captured, 'src/a.txt').index.length, 1);
  await git(root, 'add', '-u');
  const staged = await captureSnapshot(options);
  assert.equal(pathEntry(staged, 'src/a.txt').type, 'missing');
  assert.equal(pathEntry(staged, 'src/a.txt').index.length, 0);
  assert.ok(staged.stagedPaths.includes('src/a.txt'));
});

test('file executable bits and raw symlink targets are captured without following links', async (t) => {
  const { root, temporary, options } = await fixture(t);
  if (process.platform !== 'win32') await chmod(join(root, 'src/a.txt'), 0o755);
  const outside = join(temporary, 'outside.txt'); await writeFile(outside, 'outside first');
  try { await symlink(outside, join(root, 'external-link')); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symlink permission required'); return; } throw error; }
  const first = await captureSnapshot(options);
  if (process.platform !== 'win32') assert.equal(pathEntry(first, 'src/a.txt').mode, '100755');
  assert.equal(pathEntry(first, 'external-link').type, 'symlink');
  assert.equal(pathEntry(first, 'external-link').symlinkTarget, outside);
  await writeFile(outside, 'outside second');
  assert.equal((await captureSnapshot(options)).boundaryHash, first.boundaryHash);
});

test('staged changes and complete conflict stages are retained', async (t) => {
  const { root, options } = await fixture(t);
  const main = await git(root, 'symbolic-ref', '--short', 'HEAD');
  await git(root, 'checkout', '--quiet', '-b', 'other'); await write(root, 'src/a.txt', 'other\n');
  await git(root, 'add', '.'); await git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'other');
  await git(root, 'checkout', '--quiet', main); await write(root, 'src/a.txt', 'main\n');
  await git(root, 'add', '.'); await git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'main');
  await assert.rejects(git(root, '-c', 'commit.gpgsign=false', 'merge', 'other'));
  const captured = await captureSnapshot(options);
  assert.deepEqual(pathEntry(captured, 'src/a.txt').index.map((entry) => entry.stage), [1, 2, 3]);
  assert.equal(captured.snapshot.indexFlags.filter((entry) => entry.path === 'src/a.txt').length, 1);
  assert.ok(captured.stagedPaths.includes('src/a.txt'));
});

test('branch and HEAD movement affect the boundary independently of project content', async (t) => {
  const { root, options } = await fixture(t); const first = await captureSnapshot(options);
  await git(root, 'checkout', '--quiet', '-b', 'new-branch'); const branch = await captureSnapshot(options);
  assert.equal(branch.snapshot.repoIdentity.head, first.snapshot.repoIdentity.head);
  assert.notEqual(branch.boundaryHash, first.boundaryHash);
  await git(root, 'commit', '--allow-empty', '--quiet', '--no-gpg-sign', '-m', 'advance');
  const advanced = await captureSnapshot(options);
  assert.notEqual(advanced.snapshot.repoIdentity.head, branch.snapshot.repoIdentity.head);
  assert.notEqual(advanced.boundaryHash, branch.boundaryHash);
});

test('assume-unchanged and skip-worktree flags cannot hide raw worktree changes', async (t) => {
  const { root, options } = await fixture(t); const clean = await captureSnapshot(options);
  await git(root, 'update-index', '--assume-unchanged', 'src/a.txt'); const assumed = await captureSnapshot(options);
  assert.notEqual(clean.snapshot.indexFingerprint, assumed.snapshot.indexFingerprint);
  assert.equal(assumed.snapshot.indexFlags.find((entry) => entry.path === 'src/a.txt').tag, 'h');
  await write(root, 'src/a.txt', 'hidden by assume unchanged\n');
  assert.equal(await git(root, 'status', '--porcelain'), '');
  assert.ok((await captureSnapshot(options)).dirtyPaths.includes('src/a.txt'));
  await git(root, 'update-index', '--no-assume-unchanged', 'src/a.txt'); await git(root, 'update-index', '--skip-worktree', 'src/a.txt');
  const skipped = await captureSnapshot(options);
  assert.equal(skipped.snapshot.indexFlags.find((entry) => entry.path === 'src/a.txt').tag, 'S');
  assert.ok(skipped.dirtyPaths.includes('src/a.txt'));
});

test('intent-to-add and index refresh are distinguished from content-free timestamp changes', async (t) => {
  const { root, options } = await fixture(t); const initial = await captureSnapshot(options);
  await git(root, 'update-index', '--refresh'); const refreshed = await captureSnapshot(options);
  assert.equal(refreshed.snapshot.indexFingerprint, initial.snapshot.indexFingerprint);
  await write(root, 'intent.txt', 'intent\n'); await git(root, 'add', '-N', 'intent.txt');
  const intent = await captureSnapshot(options);
  assert.notEqual(intent.snapshot.indexFingerprint, initial.snapshot.indexFingerprint);
  assert.ok(intent.stagedPaths.includes('intent.txt'));
  await git(root, 'add', 'intent.txt'); const added = await captureSnapshot(options);
  assert.notEqual(added.snapshot.indexFingerprint, intent.snapshot.indexFingerprint);
});

test('Planning selection references are rebound to raw bytes and detect stale input', async (t) => {
  const { root, options } = await fixture(t);
  const reference = { path: 'docs/plan/Dashboard.md', sha256: hash(await readFile(join(root, 'docs/plan/Dashboard.md'))) };
  await captureSnapshot({ ...options, planningReferences: [reference] });
  await write(root, reference.path, '# Changed dashboard\n');
  await assert.rejects(captureSnapshot({ ...options, planningReferences: [reference] }), { code: 'DRIFT_DETECTED' });
  const missing = { ...options, project: { ...options.project } }; delete missing.project.gitWorkflowPath;
  await assert.rejects(captureSnapshot(missing), { code: 'PROJECT_CONTRACT_MISSING' });
});

test('linked worktree identity uses private Git state and captures its own index', async (t) => {
  const { root, temporary } = await fixture(t); const linked = join(temporary, 'linked');
  await git(root, 'worktree', 'add', '--quiet', '--detach', linked);
  await write(linked, 'src/a.txt', 'linked staged\n'); await git(linked, 'add', 'src/a.txt');
  const project = await discoverProject(linked);
  const captured = await captureSnapshot({ project, runId: 'linked-run', protocolSource, adapterConfigHash: 'c'.repeat(64) });
  assert.equal(captured.snapshot.repoIdentity.repoRoot, linked);
  assert.equal(captured.snapshot.repoIdentity.privateGitDir, project.privateGitDir);
  assert.equal(captured.snapshot.repoIdentity.branch, null);
  assert.deepEqual(captured.stagedPaths, ['src/a.txt']);
  assert.equal(await git(root, 'status', '--porcelain'), '');
});

test('built-in autocrlf and text=auto preserve clean CRLF while detecting real edits', async (t) => {
  const { root, options } = await fixture(t);
  await git(root, 'config', 'core.autocrlf', 'true');
  await write(root, 'src/a.txt', 'initial\r\n');
  const clean = await captureSnapshot(options);
  assert.deepEqual(clean.dirtyPaths, []);
  assert.equal(pathEntry(clean, 'src/a.txt').rawContentHash, hash('initial\r\n'));
  await write(root, 'src/a.txt', 'actual edit\r\n');
  assert.deepEqual((await captureSnapshot(options)).dirtyPaths, ['src/a.txt']);
  await git(root, 'config', 'core.autocrlf', 'false'); await write(root, '.gitattributes', '* text=auto eol=lf\n');
  await git(root, 'add', '.gitattributes'); await git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'attributes');
  await write(root, 'src/a.txt', 'initial\r\n');
  assert.deepEqual((await captureSnapshot(options)).dirtyPaths, []);
  await write(root, 'src/a.txt', 'actual edit\r\n');
  assert.deepEqual((await captureSnapshot(options)).dirtyPaths, ['src/a.txt']);
});

test('Git performs built-in ident and UTF-16 conversion in the isolated normalizer', async (t) => {
  const { root, options } = await fixture(t);
  await write(root, '.gitattributes', 'ident.txt ident\nencoded.txt working-tree-encoding=UTF-16LE text eol=lf\n');
  await write(root, 'ident.txt', '$Id$\n'); await write(root, 'encoded.txt', Buffer.from('encoded\r\n', 'utf16le'));
  await git(root, 'add', '.'); await git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'builtin conversions');
  await write(root, 'ident.txt', `$Id: ${'a'.repeat(40)} $\n`);
  const captured = await captureSnapshot(options);
  assert.deepEqual(captured.dirtyPaths, []);
  assert.equal(pathEntry(captured, 'encoded.txt').rawContentHash, hash(Buffer.from('encoded\r\n', 'utf16le')));
  await write(root, 'encoded.txt', Buffer.from('changed\r\n', 'utf16le'));
  assert.deepEqual((await captureSnapshot(options)).dirtyPaths, ['encoded.txt']);
});

test('external clean filters are never executed to classify dirty files', async (t) => {
  const { root, options } = await fixture(t);
  await write(root, '.gitattributes', '*.txt filter=forbidden\n');
  await git(root, 'config', 'filter.forbidden.clean', 'touch FILTER_RAN');
  await assert.rejects(captureSnapshot(options), { code: 'UNSUPPORTED_PROJECT_FILTER' });
  await assert.rejects(readFile(join(root, 'FILTER_RAN')));
});

test('non-UTF-8 Git filenames are rejected rather than decoded with replacement', async (t) => {
  if (process.platform === 'win32') { t.skip('Byte filenames are a POSIX fixture'); return; }
  const { root, options } = await fixture(t);
  await writeFile(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]), 'invalid filename');
  await assert.rejects(captureSnapshot(options), { code: 'INVALID_UTF8' });
});

test('a leading Unicode BOM in a filename or symlink target is preserved as data', async (t) => {
  const { root, options } = await fixture(t); const name = '\uFEFFfile.txt';
  await write(root, name, 'BOM filename\n');
  const captured = await captureSnapshot(options);
  assert.equal(pathEntry(captured, name).rawContentHash, hash('BOM filename\n'));
  assert.equal(pathEntry(captured, 'file.txt'), undefined);
  try { await symlink(name, join(root, 'bom-link')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.equal(pathEntry(await captureSnapshot(options), 'bom-link').symlinkTarget, name);
});

test('clean Git links record actual submodule HEAD and dirty submodules fail closed', async (t) => {
  const { root, temporary, options } = await fixture(t);
  const source = join(temporary, 'source'); await mkdir(source);
  await git(source, 'init', '--quiet'); await git(source, 'config', 'user.name', 'Fixture'); await git(source, 'config', 'user.email', 'fixture@example.invalid');
  await git(source, 'config', 'core.autocrlf', 'false'); await write(source, 'module.txt', 'module\n');
  await git(source, 'add', '.'); await git(source, 'commit', '--quiet', '--no-gpg-sign', '-m', 'module');
  await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', source, 'module');
  await git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'add module');
  const captured = await captureSnapshot(options);
  assert.equal(pathEntry(captured, 'module').type, 'gitlink');
  assert.equal(pathEntry(captured, 'module').commit, await git(join(root, 'module'), 'rev-parse', 'HEAD'));
  await write(root, 'module/module.txt', 'dirty module\n');
  await assert.rejects(captureSnapshot(options), { code: 'DIRTY_SUBMODULE' });
});
