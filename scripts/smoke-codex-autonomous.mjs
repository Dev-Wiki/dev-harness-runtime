/** Opt-in autonomous Codex Task smoke in a synthetic temporary Git project. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProject } from '../packages/core/dist/discovery/index.js';
import { inspectRun } from '../packages/core/dist/state/inspect.js';
import { git, setupRuntimeFixture } from '../tests/fixtures/fake-executor/fixture.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const flags = process.argv.slice(2);
assert.equal(new Set(flags).size, flags.length, 'Autonomous Codex smoke flags must be unique');
assert.ok(flags.every((flag) => ['--packaged-worker', '--commit-each'].includes(flag)),
  'Autonomous Codex smoke accepts only --packaged-worker and --commit-each');
const packagedWorker = flags.includes('--packaged-worker');
const commitEach = flags.includes('--commit-each');
assert.ok(!commitEach || packagedWorker, '--commit-each requires the packaged Worker Skill');
assert.ok(process.env.DHR_TEST_BWRAP?.startsWith('/'), 'Set DHR_TEST_BWRAP to a trusted absolute bubblewrap path');
const cleanups = [];
const t = { after: (cleanup) => cleanups.push(cleanup) };
try {
  const f = await setupRuntimeFixture(t);
  const command = 'node --test tests/feature.test.mjs';
  await writeFile(join(f.root, 'HARNESS.md'), '# HARNESS\n\n## 已确认命令\n\n| 用途 | 命令 | 状态 |\n|---|---|---|\n'
    + `| full | \`${command}\` | confirmed |\n`);
  if (commitEach) await writeFile(join(f.root, 'docs/GIT_WORKFLOW.md'), `# Git 工作流契约

## 提交规范

使用 Conventional Commits：

\`\`\`text
<type>(<scope>): <中文描述>
\`\`\`

- \`feat\`
- \`fix\`
- \`test\`
- \`docs\`
`);
  const taskPath = join(f.root, 'docs/plan/tasks/A.md');
  const original = await readFile(taskPath, 'utf8');
  const task = original
    .replace('为 A 实现范围明确、可以独立验收的本地变更。',
      '实现 greet(name)，返回 `Hello, ${name}!`，并增加一个使用 node:test 的本地测试。')
    .replaceAll('`src/feature.ts`', '`src/feature.mjs`')
    .replace('- `tests/feature.test.mjs`\n\n## 建议实施顺序',
      '- `tests/feature.test.mjs`\n- `docs/verification/A.md`\n\n## 建议实施顺序')
    .replace('当前任务的功能满足需求约束。',
      '`src/feature.mjs` 导出 greet(name)，对 `Codex` 返回 `Hello, Codex!`。')
    .replace('项目权威验证命令通过。',
      '`tests/feature.test.mjs` 使用 node:test 验证 greet 函数，且权威命令通过。')
    .replace(/\| 本任务验收 \| `[^`]+`/u, `| 本任务验收 | \`${command}\``);
  assert.ok(task.includes(`| 本任务验收 | \`${command}\``));
  assert.ok(task.includes('- `docs/verification/A.md`'));
  const declaration = { schemaVersion: 1,
    scope: { files: ['src/feature.mjs', 'tests/feature.test.mjs', 'docs/verification/A.md'], directories: [],
      archivePath: 'docs/plan/archive/M1/A.md' },
    verification: { sources: [], commands: [{ id: 'check', purpose: 'full', criteria: [1, 2], writableArtifacts: [] }], manual: [] } };
  await writeFile(taskPath, `${task}\n## Runtime 配置\n\n\`\`\`dhr-runtime\n${JSON.stringify(declaration)}\n\`\`\`\n`);
  await git(f.root, 'add', '--', 'HARNESS.md', 'docs/plan/tasks/A.md', ...(commitEach ? ['docs/GIT_WORKFLOW.md'] : []));
  await git(f.root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture: define autonomous Task A');
  const head = await git(f.root, 'rev-parse', 'HEAD');

  const packageRoot = await realpath(new URL('../.generated/codex/plugin/plugins/dev-harness', import.meta.url));
  const stage = await mkdtemp(join(tmpdir(), 'dhr-codex-autonomous-'));
  cleanups.push(() => rm(stage, { recursive: true, force: true }));
  const syntheticPackage = join(stage, 'plugin');
  await cp(packageRoot, syntheticPackage, { recursive: true });
  if (!packagedWorker) {
    const workerPath = join(syntheticPackage, 'skills/worker/SKILL.md');
    const worker = Buffer.from(`---
name: worker
description: synthetic autonomous Planning Task smoke
---

You are a single-Task Worker in a disposable Git fixture. Use only dhr_list_paths,
dhr_read_text, dhr_search_text, dhr_propose_text and dhr_propose_delete. Read the
request, Task, Dashboard, HARNESS and relevant files through these tools. Implement
the Task yourself; no file contents or proposal results are precomputed for you.
Do not run native tools, write the worktree directly, modify Git or read private Run state.

For a completed candidate, propose the implementation and test files, then close
only this Task: create its archive with checked acceptance boxes, delete the active
Task, update the archive README, remove A from the Dashboard active table and work
order, rewrite B's dependency link to A's archive, and add a short verification
record at docs/verification/A.md. Do not change B or C Task packets.
The archived Task must preserve the original body and acceptance wording except
checkboxes and verification evidence, with exactly one new second-level heading
"## 完成验收结果" containing a short explicit completed-candidate statement.
Do not add explanatory prose to any other archived section, including the
suggested implementation order; Core compares those sections to the original.
When moving the Task packet from tasks/ to archive/M1/, rebase every relative
Markdown link against the archive's deeper directory. In particular the existing
HARNESS link must still resolve to the project root HARNESS.md, not docs/HARNESS.md.
Core independently checks this structure and runs the frozen verification command.
Use dhr_read_text SHA values for original Planning files and dhr_propose_text SHA
values for proposed files. In closure.changes include exactly taskPath, archivePath,
archiveIndexPath and dashboardPath with their beforeHash and afterHash (null for a
missing or deleted file). changedFiles lists every proposed path, including code,
test and verification record. verification must be [] because only Core can run the
frozen command and write its private evidence. In the final JSON result use the
current request's exact runId, taskId, attempt, requestId and snapshotHash, set
schemaVersion=1, rawResultRef=null, outcome="completed", needsPlanning=false,
reason=null, commitIntent=null, and a complete closure with schemaVersion=1 and
the request scope.planning fields. If you cannot complete these steps, return a
truthful blocked result with reason and no closure.
`);
    await writeFile(workerPath, worker);
    const sourcePath = join(syntheticPackage, 'runtime/source.json');
    const source = JSON.parse(await readFile(sourcePath, 'utf8'));
    source.workerSkill.sha256 = digest(worker);
    await writeFile(sourcePath, `${JSON.stringify(source)}\n`);
  }

  const child = spawn(process.execPath, [join(syntheticPackage, 'scripts/dhr.mjs'), 'run',
    '--adapter', 'codex', '--task', 'A', '--project', f.root, commitEach ? '--commit-each' : '--no-commit'],
  { env: { ...process.env, DHR_BWRAP: await realpath(process.env.DHR_TEST_BWRAP) },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const output = []; const errors = [];
  child.stdout.on('data', (bytes) => output.push(bytes));
  child.stderr.on('data', (bytes) => errors.push(bytes));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => signal ? reject(new Error(`Packaged CLI ended by ${signal}`)) : resolve(status));
  });
  const lines = Buffer.concat(output).toString('utf8').split('\n').filter(Boolean);
  const summary = lines.length ? JSON.parse(lines.at(-1)) : null;
  if (code !== 0 || summary?.status !== 'COMPLETED') {
    const project = await discoverProject(f.root);
    const state = summary?.runId ? await inspectRun(project, summary.runId).catch(() => null) : null;
    throw new Error(JSON.stringify({ code, stderr: Buffer.concat(errors).toString('utf8').slice(-1600),
      summary, stopReason: state?.stopReason, root: f.root }));
  }
  const finalHead = await git(f.root, 'rev-parse', 'HEAD');
  assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '');
  if (commitEach) {
    assert.notEqual(finalHead, head);
    assert.equal(await git(f.root, 'rev-list', '--count', `${head}..${finalHead}`), '1');
    assert.equal(summary.commitSha, finalHead);
    assert.match(await git(f.root, 'show', '-s', '--format=%s', finalHead),
      /^(?:feat|fix|test|docs)(?:\([a-z0-9][a-z0-9-]*\))?: .*\p{Script=Han}/u);
    assert.deepEqual((await git(f.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', finalHead)).split('\n').sort(),
      ['docs/plan/Dashboard.md', 'docs/plan/archive/M1/A.md', 'docs/plan/archive/M1/README.md',
        'docs/plan/tasks/A.md', 'docs/verification/A.md', 'src/feature.mjs', 'tests/feature.test.mjs'].sort());
    assert.equal(await git(f.root, 'status', '--porcelain'), '');
  } else {
    assert.equal(finalHead, head);
  }
  assert.equal((await readFile(join(f.root, 'src/feature.mjs'), 'utf8')).includes('greet'), true);
  assert.equal((await readFile(join(f.root, 'tests/feature.test.mjs'), 'utf8')).includes('node:test'), true);
  const project = await discoverProject(f.root);
  const run = await inspectRun(project, summary.runId);
  assert.deepEqual(run.completedTasks, ['A']);
  process.stdout.write(`${JSON.stringify({ status: 'passed', autonomousTask: true,
    packagedCli: true, packagedWorker, commitEach, independentVerification: true,
    outcome: run.status, commitSha: summary.commitSha, syntheticOnly: true })}\n`);
} finally {
  if (process.env.DHR_KEEP_SMOKE !== '1') for (const cleanup of cleanups.reverse()) await cleanup();
}
