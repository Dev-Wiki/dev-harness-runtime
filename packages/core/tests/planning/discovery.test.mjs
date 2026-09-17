import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { discoverProject, readProjectText, resolveProjectPath } from '../../dist/discovery/index.js';

const execute = promisify(execFile);
const harness = `# HARNESS
## 自动识别构建命令候选
| 用途 | 命令 | 状态 |
|---|---|---|
| full | \`do-not-run\` | confirmed |
## 已确认命令（人工维护）
| 状态 | 语义 | 命令 | 用途 |
|---|---|---|---|
| confirmed | Full checks | \`node --test\` | full |
| candidate | Not approved | \`unknown\` | build |
`;

async function git(root, ...args) {
  return (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
}

async function repository(t, { commit = true, contracts = true, docs = true } = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'dhr-discovery-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'project');
  await mkdir(root);
  await git(root, 'init', '--quiet');
  if (contracts) {
    await writeFile(join(root, 'AGENTS.md'), '# Project governance\n');
    await writeFile(join(root, 'HARNESS.md'), harness);
  }
  if (docs) {
    await mkdir(join(root, 'docs', 'plan'), { recursive: true });
    await writeFile(join(root, 'docs', 'plan', 'Dashboard.md'), '# Dashboard\n');
  }
  await writeFile(join(root, 'README.md'), '# Fixture\n');
  if (commit) {
    await git(root, 'add', '.');
    await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture');
  }
  return { temp, root };
}

test('discovers canonical main-repo paths and confirmed commands without creating state', async (t) => {
  const { root } = await repository(t);
  const project = await discoverProject(join(root, 'docs'));
  assert.equal(project.repoRoot, root);
  assert.equal(project.privateGitDir, join(root, '.git'));
  assert.equal(project.stateRoot, join(root, '.git', 'dev-harness-runtime', 'runs'));
  assert.equal(project.docsRoot, join(root, 'docs'));
  assert.equal(project.dashboardPath, join(root, 'docs', 'plan', 'Dashboard.md'));
  assert.equal(project.head, await git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(project.verificationCommands, [{ purpose: 'full', command: 'node --test' }]);
  assert.deepEqual(project.issues, []);
  await assert.rejects(access(project.stateRoot));
  assert.equal(await readFile(join(root, 'HARNESS.md'), 'utf8'), harness);
});

test('linked worktrees use their private Git directory and independent state root', async (t) => {
  const { temp, root } = await repository(t);
  const linked = join(temp, 'linked');
  await git(root, 'worktree', 'add', '--quiet', '--detach', linked);
  const main = await discoverProject(root);
  const project = await discoverProject(linked);
  assert.equal(project.repoRoot, linked);
  assert.equal(project.privateGitDir, await realpath(await git(linked, 'rev-parse', '--absolute-git-dir')));
  assert.notEqual(project.privateGitDir, main.privateGitDir);
  assert.notEqual(project.stateRoot, main.stateRoot);
  assert.equal(project.stateRoot, join(project.privateGitDir, 'dev-harness-runtime', 'runs'));
  await assert.rejects(access(project.stateRoot));
});

test('ambiguous doc/docs roots fail and explicit existing root wins', async (t) => {
  const { root } = await repository(t);
  await mkdir(join(root, 'doc', 'plan'), { recursive: true });
  await writeFile(join(root, 'doc', 'plan', 'Dashboard.md'), '# Dashboard\n');
  await assert.rejects(discoverProject(root), { code: 'DOCS_ROOT_AMBIGUOUS' });
  assert.equal((await discoverProject(root, { docsRoot: 'doc' })).docsRoot, join(root, 'doc'));
  assert.equal((await discoverProject(root, { docsRoot: join(root, 'docs') })).docsRoot, join(root, 'docs'));
});

test('governance ownership and a unique Dashboard resolve dual roots', async (t) => {
  const { root } = await repository(t);
  await mkdir(join(root, 'doc'));
  assert.equal((await discoverProject(root)).docsRoot, join(root, 'docs'));
  await writeFile(join(root, 'docs', 'GIT_WORKFLOW.md'), '# Workflow\n');
  await writeFile(join(root, 'AGENTS.md'), '# Project\n[Git workflow](docs/GIT_WORKFLOW.md)\n');
  await mkdir(join(root, 'doc', 'plan'));
  await writeFile(join(root, 'doc', 'plan', 'Dashboard.md'), '# Other dashboard\n');
  const project = await discoverProject(root);
  assert.equal(project.docsRoot, join(root, 'docs'));
  assert.equal(project.gitWorkflowPath, join(root, 'docs', 'GIT_WORKFLOW.md'));
  await writeFile(join(root, 'doc', 'guide.md'), '# Guide\n');
  await writeFile(join(root, 'AGENTS.md'), '[Workflow](docs/GIT_WORKFLOW.md)\n[Guide](doc/guide.md)\n');
  await assert.rejects(discoverProject(root), { code: 'DOCS_ROOT_AMBIGUOUS' });
});

test('unborn HEAD blocks execution while doctor reports it without writing', async (t) => {
  const { root } = await repository(t, { commit: false });
  await assert.rejects(discoverProject(root), { code: 'UNBORN_HEAD' });
  const project = await discoverProject(root, { doctor: true });
  assert.equal(project.head, null);
  assert.deepEqual(project.issues.map((issue) => issue.code), ['UNBORN_HEAD']);
  await assert.rejects(access(project.stateRoot));
});

test('missing governance blocks execution and is reported in doctor mode', async (t) => {
  const { root } = await repository(t, { contracts: false });
  await assert.rejects(discoverProject(root), { code: 'PROJECT_CONTRACT_MISSING' });
  const project = await discoverProject(root, { doctor: true });
  assert.equal(project.issues.filter((issue) => issue.code === 'PROJECT_CONTRACT_MISSING').length, 2);
  assert.deepEqual(project.verificationCommands, []);
  await assert.rejects(access(join(root, 'AGENTS.md')));
  await assert.rejects(access(join(root, 'HARNESS.md')));
});

test('candidate-only and duplicated confirmed command contracts are rejected', async (t) => {
  const { root } = await repository(t);
  await writeFile(join(root, 'HARNESS.md'), '# HARNESS\n## Candidates\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| full | `node --test` | confirmed |\n');
  await assert.rejects(discoverProject(root), { code: 'PROJECT_CONTRACT_MISSING' });
  await writeFile(join(root, 'HARNESS.md'), `${harness}\n## 已确认命令\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| quick | \`node --test\` | confirmed |\n`);
  await assert.rejects(discoverProject(root), { code: 'PROJECT_CONTRACT_MISSING' });
});

test('HARNESS rejects hidden HTML, nested tables, duplicate columns and build-only commands', async (t) => {
  const { root } = await repository(t);
  const documents = [
    `<!--\n${harness}\n-->`,
    `${harness}\n<!-- hidden command context -->\n`,
    harness.replace('Full checks', '<span>Full checks</span>'),
    '# HARNESS\n## 已确认命令\n\n> | 用途 | 命令 | 状态 |\n> |---|---|---|\n> | full | `node --test` | confirmed |\n',
    '# HARNESS\n## 已确认命令\n| 用途 | 命令 | 状态 | command |\n|---|---|---|---|\n| full | `node --test` | confirmed | `other` |\n',
    '# HARNESS\n## 已确认命令\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| build | `node build.mjs` | confirmed |\n',
  ];
  for (const document of documents) {
    await writeFile(join(root, 'HARNESS.md'), document);
    await assert.rejects(discoverProject(root), { code: 'PROJECT_CONTRACT_MISSING' });
  }
});

test('discovery rejects a preexisting state-root symlink outside the private Git directory', async (t) => {
  const { root, temp } = await repository(t);
  const outside = join(temp, 'state');
  await mkdir(outside);
  try { await symlink(outside, join(root, '.git', 'dev-harness-runtime'), 'junction'); }
  catch (error) {
    if (error.code === 'EPERM') { t.skip('Creating symlinks requires OS permission'); return; }
    throw error;
  }
  await assert.rejects(discoverProject(root), { code: 'PATH_ESCAPE' });
  await assert.rejects(access(join(outside, 'runs')));
});

test('relative references allow safe parent traversal and encoded Unicode/space', async (t) => {
  const { root } = await repository(t);
  const path = join(root, 'docs', '说明 文档.md');
  await writeFile(path, '# Valid UTF-8\n');
  assert.equal(await resolveProjectPath(root, join(root, 'docs', 'plan'), '../%E8%AF%B4%E6%98%8E%20%E6%96%87%E6%A1%A3.md'), path);
  assert.equal(await resolveProjectPath(root, join(root, 'docs'), '../README.md'), join(root, 'README.md'));
});

test('relative references reject escapes, unsafe syntax, missing files and case aliases', async (t) => {
  const { root } = await repository(t);
  for (const reference of ['../../outside', '/tmp/outside', 'https://example.com/a', 'C:/outside', '..\\README.md', 'README.md?x=1', 'README.md#section', '%00', '%FF']) {
    await assert.rejects(resolveProjectPath(root, root, reference));
  }
  await assert.rejects(resolveProjectPath(root, root, 'missing.md'), { code: 'PATH_NOT_FOUND' });
  await assert.rejects(resolveProjectPath(root, root, 'readme.md'), { code: 'PATH_CASE_MISMATCH' });
});

test('symlinks may resolve inside the repository but cannot escape it', async (t) => {
  const { root, temp } = await repository(t);
  const outside = join(temp, 'outside.md');
  await writeFile(outside, '# Outside\n');
  try {
    await symlink(outside, join(root, 'outside.md'));
    await symlink(join(root, 'README.md'), join(root, 'inside.md'));
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('Creating symlinks requires OS permission'); return; }
    throw error;
  }
  await assert.rejects(resolveProjectPath(root, root, 'outside.md'), { code: 'PATH_ESCAPE' });
  assert.equal(await resolveProjectPath(root, root, 'inside.md'), join(root, 'README.md'));
});

test('text reader rejects malformed UTF-8 without replacement decoding', async (t) => {
  const { root } = await repository(t);
  const path = join(root, 'invalid.md');
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  await assert.rejects(readProjectText(path), { code: 'INVALID_UTF8' });
});
