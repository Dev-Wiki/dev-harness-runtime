import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { runConfinedDshSession } from '../packages/adapter-dsh/dist/executor/confined-session.js';
import { probeDshRuntime } from '../packages/adapter-dsh/dist/executor/probe.js';
import { createDshRuntimeAdapter } from '../packages/adapter-dsh/dist/index.js';
import { Registry } from '../packages/core/dist/registry.js';
import { dispatchTask, handleRunFailure, runtimeAdapter } from '../packages/core/dist/orchestrator/runtime.js';
import { resumeRuntimeRun } from '../packages/core/dist/orchestrator/recovery.js';
import { releaseLock } from '../packages/core/dist/lock/index.js';
import { recordName } from '../packages/core/dist/index.js';
import { setupAcceptance } from '../packages/core/tests/result/helpers-acceptance.mjs';
import { discoverProject } from '../packages/core/dist/discovery/index.js';
import { inspectRun } from '../packages/core/dist/state/inspect.js';
import { git, setupRuntimeFixture } from '../tests/fixtures/fake-executor/fixture.mjs';

const execute = promisify(execFile);
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for the explicit DSH host smoke`);
  return value;
};
const dshEntry = await realpath(required('DHR_TEST_DSH_ENTRY'));
const artifact = await realpath(required('DHR_TEST_DSH_PACKAGE'));
const bubblewrap = await realpath(required('DHR_TEST_BWRAP'));
const apiKey = required('DEEPSEEK_API_KEY');
const nodeBinary = await realpath(process.execPath);
const pluginSha256 = createHash('sha256').update(await readFile(
  new URL('../packages/adapter-dsh/dist/plugin.bundle.js', import.meta.url),
)).digest('hex');
const stage = await mkdtemp(join(tmpdir(), 'dhr-dsh-runtime-smoke-'));
let retain = false;
let diagnostic = '';
try {
  await execute(dshEntry, ['plugin', '--profile', 'headless', 'add', artifact,
    '--offline', '--ignore-scripts', '--strict-peer-dependencies=false', '--store-dir', join(stage, 'store')], {
    cwd: stage, env: { PATH: process.env.PATH ?? '/usr/bin', HOME: process.env.HOME ?? stage,
      DSH_HOME: stage }, maxBuffer: 1024 * 1024,
  });
  const installedRoot = await realpath(join(stage, 'profiles/headless/node_modules/dev-harness-runtime'));
  const installedRuntime = await import(pathToFileURL(join(installedRoot, 'lib/dhr.js')).href);
  const source = await installedRuntime.loadDshPackageSource(installedRoot);
  assert.equal(source.pluginSha256, pluginSha256);
  const packaged = await installedRuntime.createPackagedDshServices({ packageRoot: installedRoot,
    dshEntry, bubblewrapPath: bubblewrap, profileDirectory: join(stage, 'profiles/headless'), apiKey });
  assert.equal(packaged.adapters.get('dsh').id, 'dsh');
  const { stdout: cliVersion } = await execute(nodeBinary, [join(installedRoot, 'scripts/dhr.mjs'), '--version'],
    { cwd: stage, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.match(cliVersion, /0\.1\.1/u);
  await mkdir(join(stage, 'repo'), { mode: 0o700 });
  const repoRoot = await realpath(join(stage, 'repo'));
  await mkdir(join(repoRoot, 'src'), { mode: 0o700 });
  await writeFile(join(repoRoot, 'src/a.ts'), 'BEFORE\n', { flag: 'wx' });
  const fixtureRoot = new URL('../packages/contracts/fixtures/execution/', import.meta.url);
  const requestFixture = JSON.parse(await readFile(new URL('request.json', fixtureRoot), 'utf8'));
  const resultFixture = JSON.parse(await readFile(new URL('result-blocked.json', fixtureRoot), 'utf8'));
  const request = { ...requestFixture, repoRoot, docsRoot: join(repoRoot, 'docs'),
    dashboardPath: join(repoRoot, 'docs/plan/Dashboard.md'), taskPath: join(repoRoot, 'docs/plan/tasks/K1.md'),
    env: { ...requestFixture.env, DEV_HARNESS_ADAPTER: 'dsh' } };
  const result = { ...resultFixture, changedFiles: ['src/a.ts'] };
  const coreMode = ['DHR_TEST_DSH_CORE', 'DHR_TEST_DSH_PACKAGE_CLI', 'DHR_TEST_DSH_CANCEL_RESUME']
    .some((name) => process.env[name] === '1');
  const prompt = coreMode
    ? `Synthetic confined DSH Task. Call dhr_propose_delete with {"path":"src/a.ts"} exactly once. Do not use any other tool. Then return exactly this JSON object: ${JSON.stringify(result)}`
    : `Synthetic confined DSH Task. In order, call dhr_identity with {}, dhr_list_paths with {"prefix":"src","after":""}, dhr_read_text with {"path":"src/a.ts","offset":0}, dhr_search_text with {"query":"BEFORE","prefix":"src","after":""}, and dhr_propose_delete with {"path":"src/a.ts"}. Do not use any other tool. Then return exactly this JSON object: ${JSON.stringify(result)}`;
  const starts = []; const logBytes = { stdout: 0, stderr: 0, events: 0 };
  let eventLog = '';
  const output = await runConfinedDshSession({ dshEntry,
    profileDirectory: join(stage, 'profiles/headless'), bubblewrap, nodeBinary, apiKey, pluginSha256,
    request, readCatalog: { repoRoot, runId: request.runId, requestId: request.requestId,
      snapshotHash: request.snapshotHash,
      files: [{ path: 'src/a.ts', sha256: createHash('sha256').update('BEFORE\n').digest('hex') }] },
    prompt, signal: new AbortController().signal, timeoutMs: 120000,
    log: async (stream, bytes) => { logBytes[stream] += bytes.byteLength;
      if (stream === 'stderr') diagnostic += Buffer.from(bytes).toString('utf8');
      if (stream === 'events') eventLog += Buffer.from(bytes).toString('utf8'); },
    recordHostStart: async (evidence) => { starts.push(evidence); },
  });
  assert.equal(starts.length, 1);
  assert.equal(output.namespaceEvidence.network, 'isolated');
  assert.equal(output.namespaceEvidence.monitorWaited, true);
  assert.deepEqual(output.brokerAudit.allowedHosts, ['api.deepseek.com']);
  assert.ok(output.brokerAudit.connected['api.deepseek.com'] > 0);
  assert.equal(output.brokerAudit.denied, 0);
  assert.equal(output.result.outcome, 'blocked');
  assert.deepEqual(output.proposals, [{ path: 'src/a.ts', content: null }]);
  assert.equal(await readFile(join(repoRoot, 'src/a.ts'), 'utf8'), 'BEFORE\n');
  assert.ok(logBytes.events > 0 && logBytes.stdout > 0);
  const toolCalls = eventLog.trim().split('\n').map((line) => JSON.parse(line))
    .filter((event) => event.type === 'tool/call').map((event) => event.data.name);
  assert.deepEqual(toolCalls, coreMode ? ['dhr_propose_delete']
    : ['dhr_identity', 'dhr_list_paths', 'dhr_read_text', 'dhr_search_text', 'dhr_propose_delete']);
  let probe;
  if (process.env.DHR_TEST_DSH_PROBE === '1') {
    probe = await probeDshRuntime({ dshEntry, profileDirectory: join(stage, 'profiles/headless'),
      bubblewrap, nodeBinary, apiKey, pluginSha256, targetVersion: 'dsh-0.2.0-rc.2', timeoutMs: 120000 });
    assert.equal(probe.authorizationEnforced, true, probe.reasons.join('; '));
    assert.equal(probe.freshSession, true);
    assert.equal(probe.cancellation, true);
  }
  let coreRuntime;
  if (process.env.DHR_TEST_DSH_CORE === '1' || process.env.DHR_TEST_DSH_CANCEL_RESUME === '1') {
    const cleanups = [];
    try {
      const f = await setupAcceptance({ after: (cleanup) => cleanups.push(cleanup) },
        { adapter: 'dsh', initialFiles: { 'src/a.ts': 'HELLO' }, scopeFiles: ['src/a.ts'] });
      const adapterOptions = { dshEntry, profileDirectory: join(stage, 'profiles/headless'),
        bubblewrap, nodeBinary, apiKey, pluginSha256, configHash: f.run.adapterConfigHash,
        gitVersion: 'synthetic-fixture', targetVersion: 'dsh-0.2.0-rc.2', timeoutMs: 120000 };
      const adapter = createDshRuntimeAdapter(adapterOptions);
      const cancelResume = process.env.DHR_TEST_DSH_CANCEL_RESUME === '1';
      const expected = { schemaVersion: 1, runId: f.request.runId, taskId: f.request.taskId,
        attempt: f.request.attempt, requestId: f.request.requestId, snapshotHash: f.request.snapshotHash,
        summary: 'Synthetic DSH Runtime integration smoke.', verification: [], changedFiles: ['src/a.ts'],
        outcome: 'blocked', needsPlanning: false, reason: 'Synthetic Runtime integration smoke only.' };
      const ending = cancelResume
        ? 'Return one JSON object with schemaVersion=1 and the exact runId, taskId, attempt, requestId, snapshotHash from the current Core request JSON. Set summary="Synthetic DSH cancellation recovery", verification=[], changedFiles=["src/a.ts"], outcome="blocked", needsPlanning=false, reason="Synthetic cancellation recovery only". Do not reuse an earlier attempt identity.'
        : `Return exactly this JSON object: ${JSON.stringify(expected)}`;
      const skill = Buffer.from(`---\nname: worker\ndescription: synthetic DSH Runtime integration smoke\n---\n\nThis is a synthetic temporary project. Call dhr_propose_text with {"path":"src/a.ts","content":"UPDATED"} exactly once. Do not use other tools. ${ending}\n`);
      const adapters = new Registry(); adapters.register(adapter);
      const services = { protocolSource: f.run.protocolSource, adapterConfigHash: f.run.adapterConfigHash,
        workerSkill: { bytes: skill, sha256: createHash('sha256').update(skill).digest('hex') },
        adapters, acceptance: {} };
      const checked = await runtimeAdapter(services, f.project, 'dsh');
      if (cancelResume) {
        const controller = new AbortController();
        const pending = dispatchTask(f.handle, f.project, f.run, f.request, f.requestRef,
          f.frozenInputsRef, services, checked, controller.signal);
        const settled = pending.then((value) => ({ value }), (error) => ({ error }));
        const hostStart = join(f.project.stateRoot, f.run.runId, 'results/run-evidence',
          `${recordName('host-start', f.request.requestId)}.json`);
        let observed = false;
        for (let index = 0; index < 200; index++) {
          if (await access(hostStart).then(() => true, () => false)) { observed = true; break; }
          await pause(50);
        }
        assert.equal(observed, true, 'DSH host did not publish a durable PID 1 start record');
        await pause(300);
        controller.abort();
        const { error: interruption } = await settled;
        assert.equal(interruption?.name, 'AbortError',
          `Expected a cancelled DSH Session, got ${interruption?.name ?? 'completed'}`);
        const stopped = await handleRunFailure(f.handle, f.run.runId, interruption, checked);
        assert.equal(stopped.exitCode, 130);
        assert.equal(stopped.state.status, 'INTERRUPTED');
        assert.equal(await readFile(join(f.root, 'src/a.ts'), 'utf8'), 'HELLO');
        await releaseLock(f.handle);
        const freshAdapters = new Registry(); freshAdapters.register(createDshRuntimeAdapter(adapterOptions));
        const resumed = await resumeRuntimeRun({ cwd: f.root, runId: f.run.runId,
          expectedRevision: stopped.state.revision }, { ...services, adapters: freshAdapters });
        if (resumed.state.status !== 'BLOCKED') {
          const stderr = await readFile(join(f.project.stateRoot, f.run.runId,
            'attempts/A-2/stderr.log'), 'utf8').catch(() => '');
          process.stderr.write(`${JSON.stringify({ resumedState: resumed.state,
            resumedStderr: stderr.slice(-3000) }).slice(-6000)}\n`);
        }
        assert.equal(resumed.state.status, 'BLOCKED');
        assert.equal(resumed.state.currentAttempt, 2);
        assert.equal(await readFile(join(f.root, 'src/a.ts'), 'utf8'), 'UPDATED');
        coreRuntime = { status: resumed.state.status, interrupted: true,
          resumedWithFreshAdapter: true, resumedAttempt: 2, coreAppliedProposal: true };
      } else {
        let state;
        try {
          state = await dispatchTask(f.handle, f.project, f.run, f.request, f.requestRef,
            f.frozenInputsRef, services, checked);
        } catch (error) {
          const stderr = await readFile(f.attemptPaths.stderrPath, 'utf8').catch(() => '');
          process.stderr.write(`${JSON.stringify({ coreStderr: stderr.slice(-4096) })}\n`);
          throw error;
        }
        assert.equal(state.status, 'BLOCKED');
        assert.equal(await readFile(join(f.root, 'src/a.ts'), 'utf8'), 'UPDATED');
        assert.equal(state.resultRefs.length, 1);
        coreRuntime = { status: state.status, coreAppliedProposal: true, hostProbe: true };
      }
    } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  }
  let packagedCli;
  if (process.env.DHR_TEST_DSH_PACKAGE_CLI === '1') {
    const cleanups = [];
    try {
      const f = await setupRuntimeFixture({ after: (cleanup) => cleanups.push(cleanup) });
      const taskPath = join(f.root, 'docs/plan/tasks/A.md');
      const task = await readFile(taskPath, 'utf8');
      const declaration = { schemaVersion: 1,
        scope: { files: ['src/feature.ts', 'tests/feature.test.mjs'], directories: [],
          archivePath: 'docs/plan/archive/M1/A.md' },
        verification: { sources: [], commands: [{ id: 'check', purpose: 'full', criteria: [1, 2],
          writableArtifacts: [] }], manual: [] } };
      await writeFile(taskPath, `${task}\n## Runtime 配置\n\n\`\`\`dhr-runtime\n${JSON.stringify(declaration)}\n\`\`\`\n`);
      await git(f.root, 'add', '--', 'docs/plan/tasks/A.md');
      await git(f.root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture: add bounded Task declaration');
      const head = await git(f.root, 'rev-parse', 'HEAD');
      const syntheticPackage = join(stage, 'synthetic-package');
      await cp(installedRoot, syntheticPackage, { recursive: true });
      const worker = Buffer.from('---\nname: worker\ndescription: synthetic packaged DSH CLI smoke\n---\n\n'
        + 'This is a disposable synthetic Git project. Read the current request JSON for exact identity fields. '
        + 'Call dhr_propose_text with {"path":"src/feature.ts","content":"SYNTHETIC_DSH_CLI_PROPOSAL"} exactly once. '
        + 'Use no other tools. Return one JSON object with schemaVersion=1 and the exact runId, taskId, attempt, '
        + 'requestId, snapshotHash from the current request. Set summary="Synthetic packaged DSH CLI smoke", '
        + 'verification=[], changedFiles=["src/feature.ts"], outcome="blocked", needsPlanning=false, '
        + 'reason="Synthetic CLI transport test only".\n');
      await writeFile(join(syntheticPackage, 'skills/worker/SKILL.md'), worker);
      const sourcePath = join(syntheticPackage, 'source.json');
      const syntheticSource = JSON.parse(await readFile(sourcePath, 'utf8'));
      syntheticSource.workerSkill.sha256 = createHash('sha256').update(worker).digest('hex');
      await writeFile(sourcePath, `${JSON.stringify(syntheticSource)}\n`);
      const launcher = join(syntheticPackage, 'scripts/dhr.mjs');
      const child = spawn(nodeBinary, [launcher, 'run', '--adapter', 'dsh', '--task', 'A',
        '--project', f.root, '--no-commit'], { env: { ...process.env, DHR_DSH_ENTRY: dshEntry,
          DHR_BWRAP: bubblewrap, DSH_HOME: stage }, stdio: ['ignore', 'pipe', 'pipe'] });
      const output = []; const errors = [];
      child.stdout.on('data', (bytes) => output.push(bytes));
      child.stderr.on('data', (bytes) => errors.push(bytes));
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (status, signal) => signal
          ? reject(new Error(`Packaged DSH CLI ended by ${signal}`)) : resolve(status));
      });
      if (code !== 3) {
        const lines = Buffer.concat(output).toString('utf8').split('\n').filter(Boolean);
        let summary;
        try { summary = JSON.parse(lines.at(-1)); } catch { /* Bounded output below still reports the failure. */ }
        const project = await discoverProject(f.root);
        const events = summary?.runId ? await readFile(join(project.stateRoot, summary.runId,
          'attempts/A-1/events.jsonl'), 'utf8').catch(() => '') : '';
        const messages = events.split('\n').filter(Boolean).flatMap((line) => {
          try { const event = JSON.parse(line); return event.type === 'assistant/message'
            ? [event.data?.message?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('')]
            : []; } catch { return []; }
        });
        process.stderr.write(`${JSON.stringify({ packagedStatus: summary?.status,
          finalMessages: messages.slice(-2).map((value) => String(value).slice(-1000)) })}\n`);
      }
      assert.equal(code, 3, JSON.stringify({ stderr: Buffer.concat(errors).toString('utf8').slice(-2000),
        stdout: Buffer.concat(output).toString('utf8').slice(-2000) }));
      const lines = Buffer.concat(output).toString('utf8').split('\n').filter(Boolean);
      const summary = JSON.parse(lines.at(-1));
      assert.equal(summary.status, 'BLOCKED');
      assert.equal(await readFile(join(f.root, 'src/feature.ts'), 'utf8'), 'SYNTHETIC_DSH_CLI_PROPOSAL');
      const project = await discoverProject(f.root);
      const run = await inspectRun(project, summary.runId);
      assert.equal(run.status, 'BLOCKED');
      assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
      assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '');
      packagedCli = { status: run.status, coreAppliedProposal: true };
    } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  }
  process.stdout.write(`${JSON.stringify({ sessionId: output.sessionId, outcome: output.result.outcome,
    proposals: output.proposals.length, hostStarted: starts.length,
    network: output.namespaceEvidence.network, quiescent: output.namespaceEvidence.monitorWaited,
    modelConnections: output.brokerAudit.connected['api.deepseek.com'], toolCalls, logBytes,
    ...(probe ? { hostProbe: probe.authorizationEnforced, probeReport: probe.reasons[0] } : {}),
    ...(coreRuntime ? { coreRuntime } : {}), ...(packagedCli ? { packagedCli } : {}) })}\n`);
} catch (error) {
  retain = error?.code === 'QUIESCENCE_UNKNOWN';
  if (diagnostic) process.stderr.write(diagnostic.slice(-8192));
  throw error;
} finally {
  if (!retain) await rm(stage, { recursive: true, force: true });
}
