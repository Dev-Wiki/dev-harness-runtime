/** Opt-in original DSH Worker smoke in a synthetic temporary Git project. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { discoverProject } from '../packages/core/dist/discovery/index.js';
import { inspectRun } from '../packages/core/dist/state/inspect.js';
import { git, setupRuntimeFixture } from '../tests/fixtures/fake-executor/fixture.mjs';

const execute = promisify(execFile);
const required = (name) => { const value = process.env[name];
  if (!value?.startsWith('/')) throw new Error(`Set ${name} to a trusted absolute path`);
  return value; };
const dshEntry = required('DHR_TEST_DSH_ENTRY');
const artifact = required('DHR_TEST_DSH_PACKAGE');
const bubblewrap = required('DHR_TEST_BWRAP');
assert.ok(process.env.DEEPSEEK_API_KEY, 'Set DEEPSEEK_API_KEY in the trusted host environment');
assert.equal(process.argv.length, 2);
const cleanups = [];
try {
  const f = await setupRuntimeFixture({ after: (cleanup) => cleanups.push(cleanup) });
  const command = 'node --test tests/feature.test.mjs';
  await writeFile(join(f.root, 'HARNESS.md'), '# HARNESS\n\n## 已确认命令\n\n| 用途 | 命令 | 状态 |\n|---|---|---|\n'
    + `| full | \`${command}\` | confirmed |\n`);
  const taskPath = join(f.root, 'docs/plan/tasks/A.md');
  const original = await readFile(taskPath, 'utf8');
  const task = original
    .replace('为 A 实现范围明确、可以独立验收的本地变更。',
      '实现 greet(name)，返回 `Hello, ${name}!`，并增加一个使用 node:test 的本地测试。')
    .replaceAll('`src/feature.ts`', '`src/feature.mjs`')
    .replace('- `tests/feature.test.mjs`\n\n## 建议实施顺序',
      '- `tests/feature.test.mjs`\n- `docs/verification/A.md`\n\n## 建议实施顺序')
    .replace('当前任务的功能满足需求约束。',
      '`src/feature.mjs` 导出 greet(name)，对 `DSH` 返回 `Hello, DSH!`。')
    .replace('项目权威验证命令通过。',
      '`tests/feature.test.mjs` 使用 node:test 验证 greet 函数，且权威命令通过。')
    .replace(/\| 本任务验收 \| `[^`]+`/u, `| 本任务验收 | \`${command}\``);
  assert.ok(task.includes(`| 本任务验收 | \`${command}\``));
  const declaration = { schemaVersion: 1,
    scope: { files: ['src/feature.mjs', 'tests/feature.test.mjs', 'docs/verification/A.md'], directories: [],
      archivePath: 'docs/plan/archive/M1/A.md' },
    verification: { sources: [], commands: [{ id: 'check', purpose: 'full', criteria: [1, 2],
      writableArtifacts: [] }], manual: [] } };
  await writeFile(taskPath, `${task}\n## Runtime 配置\n\n\`\`\`dhr-runtime\n${JSON.stringify(declaration)}\n\`\`\`\n`);
  await git(f.root, 'add', '--', 'HARNESS.md', 'docs/plan/tasks/A.md');
  await git(f.root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture: define autonomous DSH Task A');
  const head = await git(f.root, 'rev-parse', 'HEAD');
  const stage = await mkdtemp(join(tmpdir(), 'dhr-dsh-autonomous-'));
  cleanups.push(() => rm(stage, { recursive: true, force: true }));
  await execute(dshEntry, ['plugin', '--profile', 'headless', 'add', artifact,
    '--offline', '--ignore-scripts', '--strict-peer-dependencies=false', '--store-dir', join(stage, 'store')],
  { cwd: stage, env: { PATH: process.env.PATH ?? '/usr/bin', HOME: process.env.HOME ?? stage,
    DSH_HOME: stage }, maxBuffer: 1024 * 1024 });
  const launcher = join(stage, 'profiles/headless/node_modules/dev-harness-runtime/scripts/dhr.mjs');
  const child = spawn(process.execPath, [launcher, 'run', '--adapter', 'dsh', '--task', 'A',
    '--project', f.root, '--no-commit'], { env: { ...process.env, DHR_DSH_ENTRY: dshEntry,
      DHR_BWRAP: bubblewrap, DSH_HOME: stage }, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = []; const errors = [];
  child.stdout.on('data', (bytes) => output.push(bytes));
  child.stderr.on('data', (bytes) => errors.push(bytes));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => signal
      ? reject(new Error(`DSH packaged CLI ended by ${signal}`)) : resolve(status));
  });
  const lines = Buffer.concat(output).toString('utf8').split('\n').filter(Boolean);
  const summary = lines.length ? JSON.parse(lines.at(-1)) : null;
  const project = await discoverProject(f.root);
  const run = summary?.runId ? await inspectRun(project, summary.runId) : null;
  if (code !== 0 || summary?.status !== 'COMPLETED') {
    const events = run ? await readFile(join(project.stateRoot, run.runId,
      'attempts/A-1/events.jsonl'), 'utf8').catch(() => '') : '';
    const finals = events.split('\n').filter(Boolean).flatMap((line) => {
      try { const event = JSON.parse(line); return event.type === 'assistant/message'
        ? [event.data?.message?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('')]
        : []; } catch { return []; }
    });
    const toolCalls = events.split('\n').filter(Boolean).flatMap((line) => {
      try { const event = JSON.parse(line); return event.type === 'tool/call' ? [event.data?.name] : []; }
      catch { return []; }
    });
    throw new Error(JSON.stringify({ code, summary, stopReason: run?.stopReason,
      stderr: Buffer.concat(errors).toString('utf8').slice(-1200),
      toolCalls, finalMessage: String(finals.at(-1) ?? '').slice(-1500), root: f.root }));
  }
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '');
  assert.ok((await readFile(join(f.root, 'src/feature.mjs'), 'utf8')).includes('greet'));
  assert.ok((await readFile(join(f.root, 'tests/feature.test.mjs'), 'utf8')).includes('node:test'));
  assert.deepEqual(run.completedTasks, ['A']);
  assert.equal(run.resultRefs.length, 1);
  process.stdout.write(`${JSON.stringify({ status: 'passed', packagedCli: true, packagedWorker: true,
    autonomousTask: true, independentVerification: true, outcome: run.status, syntheticOnly: true })}\n`);
} finally {
  if (process.env.DHR_KEEP_SMOKE !== '1') for (const cleanup of cleanups.reverse()) await cleanup();
}
