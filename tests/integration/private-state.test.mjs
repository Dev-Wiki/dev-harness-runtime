import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverProject, captureSnapshot } from '../../packages/core/dist/index.js';
import { acquireLock, releaseLock } from '../../packages/core/dist/lock/index.js';
import { createRun, readRunAtRevision, compareAndSwapRun } from '../../packages/core/dist/state/index.js';
const template = JSON.parse(await readFile(new URL('../../packages/contracts/fixtures/state/run-created.json', import.meta.url), 'utf8'));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim(); }
function initial(project) {
  return { ...structuredClone(template), repoIdentity: { repoRoot: project.repoRoot, privateGitDir: project.privateGitDir, head: project.head, branch: 'main' } };
}
async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dhr-private-integration-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'main'); await mkdir(join(root, 'docs/plan'), { recursive: true });
  for (const [path, bytes] of Object.entries({ 'AGENTS.md': '# Rules\n[Workflow](docs/GIT_WORKFLOW.md)\n', 'HARNESS.md': '# Harness\n## 已确认命令\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| full | `node --test` | confirmed |\n', 'docs/GIT_WORKFLOW.md': '# Workflow\n', 'docs/plan/Dashboard.md': '# Dashboard\n', 'source.txt': 'content\n' })) await writeFile(join(root, path), bytes);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Runtime Test'); git(root, 'config', 'user.email', 'runtime@example.invalid'); git(root, 'config', 'core.autocrlf', 'false'); git(root, 'add', '.'); git(root, 'commit', '-m', 'initial');
  return { root, temporary };
}
test('main and linked worktrees keep independent owner locks and same-ID authoritative Run states', async (t) => {
  const { root, temporary } = await fixture(t); const linked = join(temporary, 'linked');
  git(root, 'worktree', 'add', '--detach', linked);
  const mainProject = await discoverProject(root); const linkedProject = await discoverProject(linked);
  const mainLock = await acquireLock(mainProject, { runId: 'run-a', adapter: 'codex' });
  const linkedLock = await acquireLock(linkedProject, { runId: 'run-a', adapter: 'codex' });
  try {
    assert.notEqual(mainProject.stateRoot, linkedProject.stateRoot);
    const main = initial(mainProject); const other = initial(linkedProject); other.repoIdentity.branch = null;
    await createRun(mainLock, main); await createRun(linkedLock, other);
    await compareAndSwapRun(mainLock, 'run-a', 0, { ...main, revision: 1, status: 'RUNNING' });
    assert.equal((await readRunAtRevision(mainLock, 'run-a', 1)).status, 'RUNNING');
    assert.equal((await readRunAtRevision(linkedLock, 'run-a', 0)).status, 'CREATED');
    assert.equal(JSON.parse(await readFile(join(mainProject.stateRoot, 'run-a/run.json'), 'utf8')).revision, 1);
    assert.equal(JSON.parse(await readFile(join(linkedProject.stateRoot, 'run-a/run.json'), 'utf8')).revision, 0);
    assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.equal(git(linked, 'status', '--porcelain', '--untracked-files=all'), '');
  } finally { await releaseLock(linkedLock); await releaseLock(mainLock); }
});
test('private Run writes leave the K3 worktree boundary unchanged', async (t) => {
  const { root } = await fixture(t); const project = await discoverProject(root);
  const options = { project, runId: 'run-a', protocolSource: template.protocolSource, adapterConfigHash: template.adapterConfigHash };
  const before = await captureSnapshot(options);
  const lock = await acquireLock(project, { runId: 'run-a', adapter: 'codex' });
  try { await createRun(lock, initial(project)); }
  finally { await releaseLock(lock); }
  assert.equal((await captureSnapshot(options)).boundaryHash, before.boundaryHash);
});
