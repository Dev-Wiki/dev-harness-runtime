import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SandboxError } from '../../../packages/core/dist/authorization/sandbox.js';
import { inspectLock } from '../../../packages/core/dist/lock/index.js';
import { Registry } from '../../../packages/core/dist/registry.js';
import { handleRunFailure, startRuntimeRun } from '../../../packages/core/dist/orchestrator/runtime.js';
import { reconcileRuntimeRun, resumeRuntimeRun } from '../../../packages/core/dist/orchestrator/recovery.js';
import { readCurrentRun, readEvidence } from '../../../packages/core/dist/state/index.js';
import { installExecute, setupRecovery } from '../../../packages/core/tests/recovery/helpers.mjs';
import { git, setupRuntimeFixture } from '../../fixtures/fake-executor/fixture.mjs';

const runId = 'cancellation-regression';
const start = (f, patch = {}, services = f.services) => startRuntimeRun({ cwd: f.root, adapter: 'fixture-runtime',
  selection: { mode: 'explicit', taskId: 'A' }, runId, ...patch }, services);
const runPath = f => join(f.project.stateRoot, runId, 'run.json');
function replaceAdapter(f, patch) {
  const adapters = new Registry(); adapters.register({ ...f.adapter, ...patch });
  return { ...f.services, adapters };
}
const abortError = error => error?.name === 'AbortError';

test('already-aborted start performs no discovery probe, dispatch, Run publication or Git mutation', async t => {
  const f = await setupRuntimeFixture(t); const head = await git(f.root, 'rev-parse', 'HEAD');
  const controller = new AbortController(); controller.abort();
  let probes = 0;
  const services = replaceAdapter(f, { async environment() { probes++; assert.fail('An aborted start must stop before probing'); } });
  await assert.rejects(start(f, { signal: controller.signal }, services), abortError);
  assert.equal(probes, 0); assert.equal(f.executions.length, 0);
  await assert.rejects(access(runPath(f)), { code: 'ENOENT' });
  await assert.rejects(access(join(f.project.stateRoot, '.orchestrator.lock')), { code: 'ENOENT' });
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head); assert.equal(await git(f.root, 'status', '--porcelain'), '');
});

test('already-aborted resume preserves the exact interrupted Run and does not dispatch again', async t => {
  const first = new AbortController();
  const f = await setupRuntimeFixture(t, { cancelFirst: true, cancelController: first });
  const interrupted = await start(f, { signal: first.signal });
  assert.equal(interrupted.exitCode, 130); assert.equal(interrupted.state.status, 'INTERRUPTED');
  const original = await readFile(runPath(f)); const head = await git(f.root, 'rev-parse', 'HEAD');
  const cancelled = new AbortController(); cancelled.abort();
  let probes = 0;
  const services = replaceAdapter(f, { async environment() { probes++; assert.fail('An aborted resume must stop before probing'); } });
  await assert.rejects(resumeRuntimeRun({ cwd: f.root, runId, expectedRevision: interrupted.state.revision,
    signal: cancelled.signal }, services), abortError);
  assert.equal(probes, 0); assert.equal(f.executions.length, 1);
  assert.deepEqual(await readFile(runPath(f)), original);
  await assert.rejects(access(join(f.project.stateRoot, '.orchestrator.lock')), { code: 'ENOENT' });
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head); assert.equal(await git(f.root, 'status', '--porcelain'), '');
});

for (const operation of ['resume', 'reconcile']) {
  test(`${operation} retains the owner lock when the Adapter cannot prove quiescence`, async t => {
    const f = await setupRuntimeFixture(t, { outcome: 'partial' });
    const interrupted = await start(f); assert.equal(interrupted.state.status, 'INTERRUPTED');
    const original = await readFile(runPath(f)); const head = await git(f.root, 'rev-parse', 'HEAD');
    let checks = 0;
    const failure = Object.assign(new Error('Fixture controller cannot prove quiescence'), { code: 'LOCK_OWNER_UNKNOWN' });
    // Negative Core-service fixture only. It declares no real Agent process capability.
    const services = replaceAdapter(f, { async verifyQuiescence({ state }) {
      checks++; assert.equal(state.runId, runId); throw failure;
    } });
    const options = { cwd: f.root, runId, expectedRevision: interrupted.state.revision };
    const work = operation === 'resume' ? resumeRuntimeRun(options, services)
      : reconcileRuntimeRun({ ...options, resolutionRef: { schemaVersion: 1, path: 'results/run-evidence/not-read.json', sha256: '0'.repeat(64) } }, services);
    await assert.rejects(work, error => error === failure);
    assert.equal(checks, 1); assert.equal(f.executions.length, 1);
    const lock = await inspectLock(f.project);
    assert.equal(lock.status, 'held'); assert.equal(lock.owner.runId, runId);
    await access(join(f.project.stateRoot, '.orchestrator.lock', 'owner.json'));
    assert.deepEqual(await readFile(runPath(f)), original);
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
  });
}

test('unknown verification lifetime persists interruption and evidence without consulting Worker quiescence', async t => {
  // Real held Core lock and durable state/evidence; no verifier process or host isolation is simulated as successful.
  const f = await setupRecovery(t); await installExecute(f, { status: 'RUNNING', checkpoint: 'worker-checkpoint' });
  const original = await readCurrentRun(f.handle, f.run.runId);
  const checkpoint = await readEvidence(f.handle, original.runId, original.revision, original.pendingOperation.checkpointRef);
  const proof = await readEvidence(f.handle, original.runId, original.revision, f.checkpoint.proofRef);
  const owner = await inspectLock(f.project); assert.equal(owner.status, 'held');
  let workerChecks = 0;
  const error = new SandboxError('QUIESCENCE_UNKNOWN', 'Fixture verifier monitor has no confirmed ending');
  await assert.rejects(handleRunFailure(f.handle, original.runId, error, { async verifyQuiescence() {
    workerChecks++; assert.fail('Worker quiescence cannot establish verifier quiescence');
  } }), actual => actual === error);
  assert.equal(workerChecks, 0);
  const stopped = await readCurrentRun(f.handle, original.runId);
  assert.equal(stopped.status, 'INTERRUPTED'); assert.equal(stopped.stopReason.code, 'QUIESCENCE_UNKNOWN');
  assert.equal(stopped.revision, original.revision + 1);
  assert.deepEqual(stopped.pendingOperation, original.pendingOperation);
  assert.deepEqual(stopped.resultRefs, original.resultRefs); assert.deepEqual(stopped.completedTasks, original.completedTasks);
  assert.deepEqual(await readEvidence(f.handle, stopped.runId, stopped.revision, stopped.pendingOperation.checkpointRef), checkpoint);
  assert.deepEqual(await readEvidence(f.handle, stopped.runId, stopped.revision, f.checkpoint.proofRef), proof);
  const retained = await inspectLock(f.project);
  assert.equal(retained.status, 'held'); assert.equal(retained.owner.ownerToken, owner.owner.ownerToken);
});
