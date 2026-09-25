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
const flags = process.argv.slice(2);
assert.ok(flags.every((flag) => ['--commit-each', '--three-task'].includes(flag)) && new Set(flags).size === flags.length);
const commitEach = flags.includes('--commit-each');
const threeTask = flags.includes('--three-task');
const cleanups = [];
try {
  const f = await setupRuntimeFixture({ after: (cleanup) => cleanups.push(cleanup) });
  const command = threeTask ? 'node --test' : 'node --test tests/feature.test.mjs';
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
  const specs = [
    { id: 'A', file: 'feature', name: 'greet', goal: '返回 `Hello, ${name}!`', expected: 'Hello, DSH!' },
    { id: 'B', file: 'farewell', name: 'farewell', goal: '调用 A 的 greet(name)，将 `Hello` 改为 `Goodbye`', expected: 'Goodbye, DSH!' },
    { id: 'C', file: 'shout', name: 'shout', goal: '调用 B 的 farewell(name)，将结果转为大写', expected: 'GOODBYE, DSH!' },
  ].slice(0, threeTask ? 3 : 1);
  for (const spec of specs) {
    const taskPath = join(f.root, `docs/plan/tasks/${spec.id}.md`);
    const original = await readFile(taskPath, 'utf8');
    const source = `src/${spec.file}.mjs`;
    const testPath = `tests/${spec.file}.test.mjs`;
    const task = original
      .replace(`为 ${spec.id} 实现范围明确、可以独立验收的本地变更。`,
        `实现 ${spec.name}(name)，${spec.goal}，并增加一个使用 node:test 的本地测试。`)
      .replaceAll('`src/feature.ts`', `\`${source}\``)
      .replaceAll('`tests/feature.test.mjs`', `\`${testPath}\``)
      .replace(`- \`${testPath}\`\n\n## 建议实施顺序`,
        `- \`${testPath}\`\n- \`docs/verification/${spec.id}.md\`\n\n## 建议实施顺序`)
      .replace('当前任务的功能满足需求约束。',
        `\`${source}\` 导出 ${spec.name}(name)，对 \`DSH\` 返回 \`${spec.expected}\`。`)
      .replace('项目权威验证命令通过。',
        `\`${testPath}\` 使用 node:test 验证 ${spec.name} 函数，且权威命令通过。`)
      .replace(/\| 本任务验收 \| `[^`]+`/u, `| 本任务验收 | \`${command}\``);
    assert.ok(task.includes(`| 本任务验收 | \`${command}\``));
    const declaration = { schemaVersion: 1,
      scope: { files: [source, testPath, `docs/verification/${spec.id}.md`], directories: [],
        archivePath: `docs/plan/archive/M1/${spec.id}.md` },
      verification: { sources: [], commands: [{ id: 'check', purpose: 'full', criteria: [1, 2],
        writableArtifacts: [] }], manual: [] } };
    await writeFile(taskPath, `${task}\n## Runtime 配置\n\n\`\`\`dhr-runtime\n${JSON.stringify(declaration)}\n\`\`\`\n`);
  }
  await git(f.root, 'add', '--', 'HARNESS.md', ...specs.map((spec) => `docs/plan/tasks/${spec.id}.md`),
    ...(commitEach ? ['docs/GIT_WORKFLOW.md'] : []));
  await git(f.root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture: define autonomous DSH Task A');
  const head = await git(f.root, 'rev-parse', 'HEAD');
  const stage = await mkdtemp(join(tmpdir(), 'dhr-dsh-autonomous-'));
  cleanups.push(() => rm(stage, { recursive: true, force: true }));
  await execute(dshEntry, ['plugin', '--profile', 'headless', 'add', artifact,
    '--offline', '--ignore-scripts', '--strict-peer-dependencies=false', '--store-dir', join(stage, 'store')],
  { cwd: stage, env: { PATH: process.env.PATH ?? '/usr/bin', HOME: process.env.HOME ?? stage,
    DSH_HOME: stage }, maxBuffer: 1024 * 1024 });
  const launcher = join(stage, 'profiles/headless/node_modules/dev-harness-runtime/scripts/dhr.mjs');
  const child = spawn(process.execPath, [launcher, 'run', '--adapter', 'dsh',
    ...(threeTask ? ['--all-ready'] : ['--task', 'A']),
    '--project', f.root, commitEach ? '--commit-each' : '--no-commit'], { env: { ...process.env, DHR_DSH_ENTRY: dshEntry,
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
      `attempts/${summary?.taskId ?? 'A'}-1/events.jsonl`), 'utf8').catch(() => '') : '';
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
  assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '');
  if (commitEach) {
    const finalHead = await git(f.root, 'rev-parse', 'HEAD');
    assert.notEqual(finalHead, head);
    assert.equal(await git(f.root, 'rev-list', '--count', `${head}..${finalHead}`), String(specs.length));
    assert.equal(summary.commitSha, finalHead);
    assert.match(await git(f.root, 'show', '-s', '--format=%s', finalHead),
      /^(?:feat|fix|test|docs)(?:\([a-z0-9][a-z0-9-]*\))?: .*\p{Script=Han}/u);
    assert.equal(await git(f.root, 'status', '--porcelain'), '');
  } else assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
  for (const spec of specs) {
    assert.ok((await readFile(join(f.root, `src/${spec.file}.mjs`), 'utf8')).includes(spec.name));
    assert.ok((await readFile(join(f.root, `tests/${spec.file}.test.mjs`), 'utf8')).includes('node:test'));
  }
  assert.deepEqual(run.completedTasks, specs.map((spec) => spec.id));
  assert.equal(run.resultRefs.length, specs.length);
  for (const entry of run.resultRefs) {
    const accepted = JSON.parse(await readFile(join(project.stateRoot, run.runId, entry.ref.path), 'utf8'));
    assert.equal(accepted.outcome, 'completed');
    assert.equal(accepted.verification.length, 1);
    assert.equal(accepted.verification[0].result, 'passed');
  }
  const sessions = await Promise.all(specs.map(async (spec) => {
    const events = await readFile(join(project.stateRoot, run.runId, `attempts/${spec.id}-1/events.jsonl`), 'utf8');
    return JSON.parse(events.split('\n')[0]).id;
  }));
  assert.equal(new Set(sessions).size, specs.length);
  process.stdout.write(`${JSON.stringify({ status: 'passed', packagedCli: true, packagedWorker: true,
    autonomousTask: true, independentVerification: true, commitEach,
    completedTasks: run.completedTasks, distinctSessions: sessions.length,
    outcome: run.status, syntheticOnly: true })}\n`);
} finally {
  if (process.env.DHR_KEEP_SMOKE !== '1') for (const cleanup of cleanups.reverse()) await cleanup();
}
