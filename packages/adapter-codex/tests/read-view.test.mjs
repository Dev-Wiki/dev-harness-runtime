import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexReadView, withCodexReadPolicy } from '../dist/executor/read-view.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const policy = (repoRoot, files) => ({ repoRoot, runId: 'run-a', requestId: 'request-a', snapshotHash: 'a'.repeat(64), files });
const fixtureRoot = async (prefix) => realpath(await mkdtemp(join(tmpdir(), prefix)));

test('Codex read view lists only frozen paths and returns verified UTF-8 bytes', async (t) => {
  const root = await fixtureRoot('dhr-codex-read-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'HELLO');
  await writeFile(join(root, 'src/secret.ts'), 'SECRET');
  const view = await CodexReadView.create(policy(root, [{ path: 'src/a.ts', sha256: digest('HELLO') }]));
  assert.deepEqual(view.list('src'), { paths: ['src/a.ts'], next: null });
  assert.deepEqual(await view.read('src/a.ts'), { path: 'src/a.ts', content: 'HELLO', sha256: digest('HELLO') });
  assert.deepEqual(await view.readPage('src/a.ts'), { path: 'src/a.ts', content: 'HELLO', sha256: digest('HELLO'),
    offset: 0, nextOffset: null });
  assert.deepEqual(await view.readPage('src/new.ts'), { path: 'src/new.ts', missing: true });
  await assert.rejects(view.readPage('src/new.ts', 1), { code: 'UNSAFE_PATH' });
  await assert.rejects(view.readPage('../outside'), { code: 'UNSAFE_PATH' });
  await assert.rejects(view.read('src/secret.ts'), { code: 'UNSAFE_PATH' });
  await assert.rejects(view.read('../outside'), { code: 'UNSAFE_PATH' });
  await assert.rejects(CodexReadView.create(policy(root, [{ path: '.git/config', sha256: digest('x') }])), { code: 'INVALID_POLICY' });
  await assert.rejects(CodexReadView.create(policy(root, [
    { path: 'src/a.ts', sha256: digest('HELLO') }, { path: 'SRC/A.TS', sha256: digest('HELLO') },
  ])), { code: 'INVALID_POLICY' });
});

test('Codex read view pages long text without splitting a Unicode pair', async (t) => {
  const root = await fixtureRoot('dhr-codex-read-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  const content = 'x'.repeat(16 * 1024 - 1) + '😀' + 'TAIL';
  await writeFile(join(root, 'src/long.ts'), content);
  const view = await CodexReadView.create(policy(root, [{ path: 'src/long.ts', sha256: digest(content) }]));
  const first = await view.readPage('src/long.ts');
  assert.equal(first.nextOffset, 16 * 1024 - 1);
  const second = await view.readPage('src/long.ts', first.nextOffset);
  assert.equal(first.content + second.content, content);
  await assert.rejects(view.readPage('src/long.ts', first.nextOffset + 1), { code: 'UNSAFE_PATH' });
});

test('Codex read view refuses snapshot drift, symlinks and hardlink aliases', async (t) => {
  const root = await fixtureRoot('dhr-codex-read-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'BEFORE');
  const view = await CodexReadView.create(policy(root, [{ path: 'src/a.ts', sha256: digest('BEFORE') }]));
  await writeFile(join(root, 'src/a.ts'), 'AFTER');
  await assert.rejects(view.read('src/a.ts'), { code: 'DRIFT_DETECTED' });
  await assert.rejects(view.readPage('src/a.ts'), { code: 'DRIFT_DETECTED' });
  await writeFile(join(root, 'src/a.ts'), 'BEFORE');
  await link(join(root, 'src/a.ts'), join(root, 'src/hardlink.ts'));
  await assert.rejects(view.read('src/a.ts'), { code: 'UNSAFE_PATH' });
  await rm(join(root, 'src/hardlink.ts'));
  await symlink('a.ts', join(root, 'src/link.ts'));
  const linked = await CodexReadView.create(policy(root, [{ path: 'src/link.ts', sha256: digest('BEFORE') }]));
  await assert.rejects(linked.read('src/link.ts'), { code: 'UNSAFE_PATH' });
});

test('Codex read view paginates a frozen catalog without reading arbitrary directories', async (t) => {
  const root = await fixtureRoot('dhr-codex-read-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = Array.from({ length: 101 }, (_, index) => ({ path: `src/${String(index).padStart(3, '0')}.ts`, sha256: digest('x') }));
  const view = await CodexReadView.create(policy(root, files));
  const first = view.list('src');
  assert.equal(first.paths.length, 100);
  assert.equal(first.next, 'src/099.ts');
  assert.deepEqual(view.list('src', first.next), { paths: ['src/100.ts'], next: null });
});

test('Codex literal search is snapshot-bound, paginated and bounded per file', async (t) => {
  const root = await fixtureRoot('dhr-codex-search-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  const files = [];
  for (let index = 0; index < 17; index++) {
    const path = `src/${String(index).padStart(3, '0')}.ts`;
    const content = index === 15 ? Buffer.from([0xff])
      : index === 0 || index === 16 ? 'first\nneedle here\nlast' : 'nothing';
    await writeFile(join(root, path), content);
    files.push({ path, sha256: digest(content) });
  }
  const view = await CodexReadView.create(policy(root, files));
  const first = await view.search('needle', 'src');
  assert.deepEqual(first, { matches: [{ path: 'src/000.ts', line: 2, column: 1, excerpt: 'needle here' }],
    skipped: ['src/015.ts'], next: 'src/015.ts' });
  assert.deepEqual(await view.search('needle', 'src', first.next), {
    matches: [{ path: 'src/016.ts', line: 2, column: 1, excerpt: 'needle here' }], skipped: [], next: null });
  await assert.rejects(view.search(''), { code: 'UNSAFE_PATH' });
  await assert.rejects(view.search('needle', '../outside'), { code: 'UNSAFE_PATH' });
  await writeFile(join(root, 'src/000.ts'), 'changed');
  await assert.rejects(view.search('needle', 'src'), { code: 'DRIFT_DETECTED' });
});

test('Codex read policy file is private and removed after one invocation', async (t) => {
  const root = await fixtureRoot('dhr-codex-read-');
  t.after(() => rm(root, { recursive: true, force: true }));
  let path;
  await withCodexReadPolicy(policy(root, [{ path: 'src/a.ts', sha256: digest('HELLO') }]), async (value) => {
    path = value;
    assert.equal((await stat(value)).mode & 0o077, 0);
    assert.equal(JSON.parse(await readFile(value, 'utf8')).files[0].path, 'src/a.ts');
  });
  assert.equal(existsSync(path), false);
});
