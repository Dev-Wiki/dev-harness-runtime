import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from '../../packages/cli/dist/index.js';
import { releaseLock, withLock } from '../../packages/core/dist/lock/index.js';
import { setupRecovery } from '../../packages/core/tests/recovery/helpers.mjs';
import { git, realSandbox, setupRuntimeFixture } from '../fixtures/fake-executor/fixture.mjs';

const entry = fileURLToPath(new URL('../../packages/cli/bin/dhr.mjs', import.meta.url));
async function cli(args, options = {}) {
  let stdout = ''; let stderr = '';
  const code = await runCli(args, { out: (text) => { stdout += text; }, error: (text) => { stderr += text; } }, options);
  return { code, stdout, stderr };
}
function bin(args, cwd) {
  const env = { ...process.env }; delete env.DEV_HARNESS_WORKER;
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8', timeout: 20_000 });
  assert.ifError(result.error); assert.equal(result.signal, null); return result;
}

test('CLI rejects conflicting selectors, authorization flags, revisions and unknown arguments before services', async () => {
  const invalid = [
    ['run', '--adapter', 'codex'], ['run', '--next'], ['run', '--adapter', 'codex', '--next', '--task', 'A'],
    ['run', '--adapter', 'codex', '--next', '--all-ready'], ['run', '--adapter', 'codex', '--next', '--commit', 'yes'],
    ['run', '--adapter', 'codex', '--next', '--commit-each', '--no-commit'],
    ['run', '--adapter', 'codex', '--next', '--commit', 'deny', '--commit-each'],
    ['run', '--adapter', 'codex', '--next', '--unexpected'], ['run', '--adapter', 'codex', '--next', '--next'],
    ['status'], ['status', 'run-a', '--run', 'run-b'], ['status', '--run', '../outside'],
    ['resume', 'run-a', '--expected-revision', '-1'], ['resume', 'run-a', '--expected-revision', '1.5'],
    ['resume', 'run-a', '--expected-revision', '9007199254740992'], ['resume', 'run-a', '--expected-revision', '0', '--commit-each'],
    ['reconcile', 'run-a', '--expected-revision', '0'], ['doctor', '--resolution', 'approval.json'],
  ];
  for (const args of invalid) {
    const result = await cli(args, { services: { get adapters() { return assert.fail('Invalid CLI input must not inspect trusted services'); } } });
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /^INVALID_ARGUMENT:/u); assert.equal(result.stdout, '');
  }
});

test('production CLI distinguishes unknown adapters from known missing Executors without creating a Run', async (t) => {
  const f = await setupRuntimeFixture(t);
  const before = await git(f.root, 'status', '--porcelain');
  for (const args of [
    ['run', '--adapter', 'codex', '--next'], ['run', '--adapter', 'dsh', '--task', 'A', '--commit', 'task'],
    ['run', '--adapter', 'cursor', '--all-ready', '--commit-each'], ['run', '--adapter', 'opencode', '--next', '--no-commit'],
    ['resume', '--run', 'run-a', '--expected-revision', '0'],
    ['reconcile', 'run-a', '--expected-revision', '0', '--resolution', 'missing.json'],
  ]) {
    const result = bin(args, f.root); assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /^CAPABILITY_MISSING:/u); assert.equal(result.stdout, '');
  }
  const unknown = bin(['run', '--adapter', 'unknown-host', '--next'], f.root);
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /^UNKNOWN_ADAPTER:/u);
  await assert.rejects(readdir(f.project.stateRoot), { code: 'ENOENT' });
  assert.equal(await git(f.root, 'status', '--porcelain'), before);
});

test('doctor bundles real project discovery and Planning while reporting missing execution capability', async (t) => {
  const f = await setupRuntimeFixture(t);
  const result = bin(['doctor', '--project', f.root, '--docs-root', 'docs'], f.root);
  assert.equal(result.status, 2, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.project, f.root); assert.equal(report.planning.tasks, 3); assert.equal(report.planning.orderedTasks, 3);
  assert.deepEqual(report.adapters.map((adapter) => adapter.id), ['codex', 'dsh', 'cursor', 'opencode', 'antigravity']);
  assert.ok(report.adapters.every((adapter) => !adapter.available && !adapter.authorizationEnforced));
  assert.ok(report.issues.some((issue) => issue.code === 'CAPABILITY_MISSING'));
  await assert.rejects(readdir(f.project.stateRoot), { code: 'ENOENT' });
});

test('status reads authoritative private state with an existing lock and leaves every file unchanged', async (t) => {
  const f = await setupRecovery(t);
  const runPath = join(f.project.stateRoot, f.run.runId, 'run.json');
  const before = await readFile(runPath); const names = await readdir(f.project.stateRoot);
  const result = bin(['status', '--run', f.run.runId, '--verbose', '--project', f.root], f.root);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(summary).sort(), ['runId', 'taskId', 'status', 'summary', 'verificationSummary', 'commitSha', 'nextTask', 'logRef'].sort());
  assert.equal(summary.runId, f.run.runId); assert.equal(summary.status, 'CREATED'); assert.equal(summary.logRef, null);
  assert.deepEqual(await readFile(runPath), before); assert.deepEqual(await readdir(f.project.stateRoot), names);
  await withLock(f.handle, (owner) => owner.assertOwner());
  const missing = bin(['status', 'missing-run', '--project', f.root], f.root);
  assert.equal(missing.status, 4); assert.match(missing.stderr, /^STATE_NOT_FOUND:/u);
  assert.deepEqual(await readdir(f.project.stateRoot), names);
  await releaseLock(f.handle);
});

test('explicit trusted services reach real Core capability probing before any Run is created', async (t) => {
  const f = await setupRuntimeFixture(t, { capabilityFalse: 'freshSession' });
  const result = await cli(['run', '--adapter', f.adapter.id, '--task', 'A'], { cwd: f.root, services: f.services });
  assert.equal(result.code, 2, result.stderr); assert.match(result.stderr, /^CAPABILITY_MISSING:/u);
  assert.equal(f.executions.length, 0); await assert.rejects(readdir(f.project.stateRoot), { code: 'ENOENT' });
});

test('CLI cancellation before dispatch returns 130 and does not consult services', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await cli(['run', '--adapter', 'codex', '--next'], { signal: controller.signal,
    services: { get adapters() { return assert.fail('Cancelled CLI must not inspect services'); } } });
  assert.equal(result.code, 130); assert.match(result.stderr, /^CANCELLED:/u); assert.equal(result.stdout, '');
});

test('injected real Core execution returns only the accepted compact projection and status agrees', realSandbox, async (t) => {
  const f = await setupRuntimeFixture(t);
  const head = await git(f.root, 'rev-parse', 'HEAD');
  const result = await cli(['run', '--adapter', f.adapter.id, '--task', 'A', '--commit', 'deny'], { cwd: f.root, services: f.services });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'COMPLETED'); assert.equal(summary.taskId, 'A'); assert.equal(summary.commitSha, null);
  assert.equal(summary.verificationSummary.passed, 1); assert.ok(summary.logRef);
  assert.doesNotMatch(result.stdout, /INDEPENDENT_CORE_CHECK|Fixture Worker claim/u);
  assert.equal(f.executions.length, 1); assert.equal(f.executions[0].request.authorization.commit, 'deny');
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
  const status = bin(['status', '--run', summary.runId], f.root);
  assert.equal(status.status, 0, status.stderr); assert.deepEqual(JSON.parse(status.stdout), summary);
  const state = JSON.parse(await readFile(join(f.project.stateRoot, summary.runId, 'run.json'), 'utf8'));
  assert.equal(state.authorization.commit, 'deny'); assert.deepEqual(state.selectionMode, { mode: 'explicit', taskId: 'A' });
});


test('real bin handles SIGINT and SIGTERM as cancellation with exit 130', { skip: process.platform === 'win32' ? 'POSIX signal process fixture' : false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dhr-cli-signals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const marker = join(root, signal);
    const executable = join(root, 'git');
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setTimeout(()=>process.exit(1),300);\n`);
    await chmod(executable, 0o755);
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}` }; delete env.DEV_HARNESS_WORKER;
    const child = spawn(process.execPath, [entry, 'doctor', '--project', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, exitSignal) => resolve({ code, exitSignal })); });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let ready = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      try { await access(marker); ready = true; break; } catch { await delay(10); }
    }
    assert.equal(ready, true, 'CLI must register handlers and reach asynchronous discovery before sending a signal');
    assert.equal(child.kill(signal), true);
    const result = await finished;
    assert.equal(result.code, 130); assert.equal(result.exitSignal, null);
  }
});

test('resume without a revision reads the current boundary and still enters Core recovery', realSandbox, async (t) => {
  const controller = new AbortController();
  const f = await setupRuntimeFixture(t, { cancelFirst: true, cancelController: controller });
  const first = await cli(['run', '--adapter', f.adapter.id, '--task', 'A'], { cwd: f.root, services: f.services, signal: controller.signal });
  assert.equal(first.code, 130, first.stderr);
  const interrupted = JSON.parse(first.stdout);
  assert.equal(interrupted.status, 'INTERRUPTED');
  f.behavior.cancelFirst = false;
  const resumed = await cli(['resume', interrupted.runId], { cwd: f.root, services: f.services });
  assert.equal(resumed.code, 0, resumed.stderr);
  const accepted = JSON.parse(resumed.stdout);
  assert.equal(accepted.runId, interrupted.runId); assert.equal(accepted.status, 'COMPLETED');
  assert.equal(f.executions.length, 2); assert.notEqual(f.executions[0].request.requestId, f.executions[1].request.requestId);
  assert.equal(f.executions[1].request.attempt, f.executions[0].request.attempt + 1);
});

test('commit-each authorizes only Core while a blocked Worker still has commit deny', async (t) => {
  const f = await setupRuntimeFixture(t, { outcome: 'blocked' });
  const head = await git(f.root, 'rev-parse', 'HEAD');
  f.services.git = { gitBinary: '/usr/bin/git', policy: { async evaluate() { assert.fail('Blocked task cannot enter the commit bridge'); } } };
  const result = await cli(['run', '--adapter', f.adapter.id, '--next', '--commit-each'], { cwd: f.root, services: f.services });
  assert.equal(result.code, 3, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'BLOCKED'); assert.equal(summary.commitSha, null);
  const state = JSON.parse(await readFile(join(f.project.stateRoot, summary.runId, 'run.json'), 'utf8'));
  assert.equal(state.authorization.commit, 'task'); assert.equal(f.executions[0].request.authorization.commit, 'deny');
  assert.deepEqual(state.selectionMode, { mode: 'next' }); assert.equal(f.executions[0].request.taskId, 'A');
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head); assert.deepEqual(state.completedTasks, []);
});

test('reconcile requires an exact EvidenceRef file and never treats approval text as authorization', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dhr-cli-resolution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'resolution.json');
  for (const record of [{ approved: true }, { schemaVersion: 1, path: '../outside', sha256: 'a'.repeat(64) },
    { schemaVersion: 1, path: 'results/resolution.json', sha256: 'a'.repeat(64), approved: true }]) {
    await writeFile(path, JSON.stringify(record));
    const result = await cli(['reconcile', 'run-a', '--expected-revision', '0', '--resolution', path], { cwd: root,
      services: { get adapters() { return assert.fail('Malformed reference must not dispatch Core reconciliation'); } } });
    assert.equal(result.code, 2, result.stderr); assert.match(result.stderr, /^INVALID_ARGUMENT:/u); assert.equal(result.stdout, '');
  }
});
