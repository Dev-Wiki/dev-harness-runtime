/** Opt-in packaged CLI smoke with a synthetic temporary Git project and synthetic Worker Skill. */
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
assert.equal(process.argv.length, 2, 'Packaged Codex smoke does not accept arguments');
assert.ok(process.env.DHR_TEST_BWRAP?.startsWith('/'), 'Set DHR_TEST_BWRAP to a trusted absolute bubblewrap path');
const cleanups = [];
const t = { after: (cleanup) => cleanups.push(cleanup) };
try {
  const f = await setupRuntimeFixture(t);
  const taskPath = join(f.root, 'docs/plan/tasks/A.md');
  const task = await readFile(taskPath, 'utf8');
  const declaration = { schemaVersion: 1,
    scope: { files: ['src/feature.ts', 'tests/feature.test.mjs'], directories: [],
      archivePath: 'docs/plan/archive/M1/A.md' },
    verification: { sources: [], commands: [{ id: 'check', purpose: 'full', criteria: [1, 2], writableArtifacts: [] }], manual: [] } };
  await writeFile(taskPath, `${task}\n## Runtime 配置\n\n\`\`\`dhr-runtime\n${JSON.stringify(declaration)}\n\`\`\`\n`);
  await git(f.root, 'add', '--', 'docs/plan/tasks/A.md');
  await git(f.root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture: add bounded Task declaration');
  const head = await git(f.root, 'rev-parse', 'HEAD');

  const packageRoot = await realpath(new URL('../.generated/codex/plugin/plugins/dev-harness', import.meta.url));
  const stage = await mkdtemp(join(tmpdir(), 'dhr-codex-cli-smoke-'));
  cleanups.push(() => rm(stage, { recursive: true, force: true }));
  const syntheticPackage = join(stage, 'plugin');
  await cp(packageRoot, syntheticPackage, { recursive: true });
  const workerPath = join(syntheticPackage, 'skills/worker/SKILL.md');
  const worker = Buffer.from('---\nname: worker\ndescription: synthetic packaged CLI smoke\n---\n\n'
    + 'This is a disposable synthetic Git project. Read the current request JSON for exact identity fields. '
    + 'Call dhr_list_paths with prefix "src" and after ""; then call dhr_propose_text with path "src/feature.ts" '
    + 'and content "SYNTHETIC_CLI_PROPOSAL". Use no native tools. '
    + 'Return a JSON result with schemaVersion=1 and the exact runId, taskId, attempt, requestId, snapshotHash from the request. '
    + 'Set summary="Synthetic packaged CLI smoke", verification=[], changedFiles=["src/feature.ts"], '
    + 'rawResultRef=null, outcome="blocked", needsPlanning=false, reason="Synthetic CLI transport test only", closure=null.\n');
  await writeFile(workerPath, worker);
  const sourcePath = join(syntheticPackage, 'runtime/source.json');
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  source.workerSkill.sha256 = digest(worker);
  await writeFile(sourcePath, `${JSON.stringify(source)}\n`);

  const launcher = join(syntheticPackage, 'scripts/dhr.mjs');
  const args = [launcher, 'run', '--adapter', 'codex', '--task', 'A', '--project', f.root, '--no-commit'];
  const bwrap = await realpath(process.env.DHR_TEST_BWRAP);
  const child = spawn(process.execPath, args, { env: { ...process.env, DHR_BWRAP: bwrap },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const output = []; const errors = [];
  child.stdout.on('data', (bytes) => output.push(bytes));
  child.stderr.on('data', (bytes) => errors.push(bytes));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => signal ? reject(new Error(`Packaged CLI ended by ${signal}`)) : resolve(status));
  });
  assert.equal(code, 3, Buffer.concat(errors).toString('utf8').slice(-2000));
  const lines = Buffer.concat(output).toString('utf8').split('\n').filter(Boolean);
  const summary = JSON.parse(lines.at(-1));
  assert.equal(summary.status, 'BLOCKED');
  assert.equal(await readFile(join(f.root, 'src/feature.ts'), 'utf8'), 'SYNTHETIC_CLI_PROPOSAL');
  const project = await discoverProject(f.root);
  const run = await inspectRun(project, summary.runId);
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.currentTaskId, 'A');
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '');
  process.stdout.write(`${JSON.stringify({ status: 'passed', packagedCli: true, boundedTask: true,
    coreAppliedProposal: true, outcome: run.status, syntheticOnly: true })}\n`);
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
