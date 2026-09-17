import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startRuntimeRun } from '../../../packages/core/dist/orchestrator/runtime.js';
import { resumeRuntimeRun } from '../../../packages/core/dist/orchestrator/recovery.js';
import { inspectParentContext } from '../../../packages/core/dist/worker/status.js';
import { git, realSandbox, setupRuntimeFixture } from '../../fixtures/fake-executor/fixture.mjs';

const start = (f, patch = {}) => startRuntimeRun({ cwd: f.root, adapter: 'fixture-runtime', selection: { mode: 'all-ready' }, runId: 'e2e-run', ...patch }, f.services);

test('three real Planning closures use separate requests and independent Core acceptance with inherited no-commit boundaries', realSandbox, async (t) => {
  const f = await setupRuntimeFixture(t); const head = await git(f.root, 'rev-parse', 'HEAD');
  const result = await start(f);
  assert.equal(result.exitCode, 0, JSON.stringify(result.state.stopReason)); assert.equal(result.state.status, 'COMPLETED');
  assert.deepEqual(result.state.completedTasks, ['A', 'B', 'C']); assert.equal(result.state.pendingOperation, undefined);
  assert.deepEqual(f.executions.map((entry) => entry.request.taskId), ['A', 'B', 'C']);
  assert.equal(new Set(f.executions.map((entry) => entry.request.requestId)).size, 3); assert.equal(new Set(f.executions.map((entry) => entry.sessionId)).size, 3);
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head); assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '');
  const controlled = [];
  for (const entry of result.state.resultRefs) {
    const accepted = JSON.parse(await readFile(join(f.project.stateRoot, result.state.runId, entry.ref.path), 'utf8'));
    assert.equal(accepted.outcome, 'completed'); assert.equal(accepted.commitSha, undefined);
    assert.ok(accepted.verifiedEvidenceRefs.length > 0); assert.equal(accepted.verification.length, 1);
    assert.ok(accepted.verification[0].stdout.path.startsWith('results/run-evidence/'));
    const output = JSON.parse(await readFile(join(f.project.stateRoot, result.state.runId, accepted.verification[0].stdout.path), 'utf8'));
    assert.equal(Buffer.from(output.bytes, 'base64').toString(), 'INDEPENDENT_CORE_CHECK');
    controlled.push(accepted.verification[0].stdout.path);
  }
  assert.equal(controlled.length, 3); assert.equal(new Set(controlled).size, 3);
  const dashboard = await readFile(join(f.root, 'docs/plan/Dashboard.md'), 'utf8');
  assert.ok(!dashboard.includes('(tasks/')); assert.ok(dashboard.includes('archive/M1/C.md'));
  const parent = await inspectParentContext(f.project, result.state.runId); assert.equal(parent.status, 'COMPLETED');
  assert.equal(parent.taskId, 'C'); assert.equal(parent.nextTask, null);
});

for (const outcome of ['blocked', 'failed', 'partial']) {
  test(`Worker ${outcome} stops the entire queue before B`, async (t) => {
    const f = await setupRuntimeFixture(t, { outcome }); const result = await start(f);
    assert.equal(result.state.status, outcome === 'blocked' ? 'BLOCKED' : outcome === 'partial' ? 'INTERRUPTED' : 'FAILED', JSON.stringify(result.state.stopReason));
    assert.equal(result.exitCode, outcome === 'blocked' ? 3 : 4);
    assert.equal(result.state.stopReason.code, `WORKER_${outcome.toUpperCase()}`);
    assert.equal(f.executions.length, 1); assert.deepEqual(result.state.completedTasks, []);
    assert.equal(result.state.currentTaskId, 'A'); assert.ok(result.state.pendingOperation);
  });
}

test('a false execution capability causes zero executions and creates no Run', async (t) => {
  const f = await setupRuntimeFixture(t, { capabilityFalse: 'freshSession' });
  await assert.rejects(start(f), { code: 'CAPABILITY_MISSING' }); assert.equal(f.executions.length, 0);
  await assert.rejects(readFile(join(f.project.stateRoot, 'e2e-run/run.json')), { code: 'ENOENT' });
});

test('cancelled untouched execution resumes with attempt two and a fresh request/session', realSandbox, async (t) => {
  const controller = new AbortController(); const f = await setupRuntimeFixture(t, { cancelFirst: true, cancelController: controller });
  const cancelled = await start(f, { selection: { mode: 'explicit', taskId: 'A' }, signal: controller.signal });
  assert.equal(cancelled.exitCode, 130, JSON.stringify(cancelled.state.stopReason)); assert.equal(cancelled.state.status, 'INTERRUPTED');
  assert.deepEqual(cancelled.state.completedTasks, []); assert.equal(cancelled.state.currentAttempt, 1);
  const result = await resumeRuntimeRun({ cwd: f.root, runId: cancelled.state.runId, expectedRevision: cancelled.state.revision }, f.services);
  assert.equal(result.exitCode, 0, JSON.stringify(result.state.stopReason)); assert.deepEqual(result.state.completedTasks, ['A']);
  assert.equal(f.executions.length, 2); assert.deepEqual(f.executions.map((entry) => entry.request.attempt), [1, 2]);
  assert.notEqual(f.executions[0].request.requestId, f.executions[1].request.requestId); assert.notEqual(f.executions[0].sessionId, f.executions[1].sessionId);
});

test('a Worker archive rejected by independent acceptance blocks a new Run from laundering dependency completion', realSandbox, async (t) => {
  const f = await setupRuntimeFixture(t, { commandSource: 'process.exit(7)' }); const failed = await start(f);
  assert.equal(failed.state.status, 'FAILED'); assert.equal(failed.state.stopReason.code, 'VERIFICATION_FAILED');
  assert.deepEqual(failed.state.completedTasks, []); assert.equal(f.executions.length, 1);
  await assert.rejects(start(f, { runId: 'second-run', selection: { mode: 'explicit', taskId: 'B' } }), { code: 'PENDING_RECONCILIATION' });
  assert.equal(f.executions.length, 1);
});

test('resume adopts a persisted Worker ending and reruns independent acceptance without repeating development', realSandbox, async (t) => {
  const controller = new AbortController(); const f = await setupRuntimeFixture(t, { cancelAfterWorker: true, cancelController: controller });
  const interrupted = await start(f, { selection: { mode: 'explicit', taskId: 'A' }, signal: controller.signal });
  assert.equal(interrupted.exitCode, 130, JSON.stringify(interrupted.state.stopReason)); assert.equal(interrupted.state.status, 'INTERRUPTED');
  assert.equal(interrupted.state.completedTasks.length, 0); assert.equal(f.executions.length, 1);
  const checkpoint = JSON.parse(await readFile(join(f.project.stateRoot, interrupted.state.runId, interrupted.state.pendingOperation.checkpointRef.path), 'utf8'));
  assert.equal(checkpoint.stage, 'worker-ended');
  const result = await resumeRuntimeRun({ cwd: f.root, runId: interrupted.state.runId, expectedRevision: interrupted.state.revision }, f.services);
  assert.equal(result.exitCode, 0, JSON.stringify(result.state.stopReason)); assert.deepEqual(result.state.completedTasks, ['A']);
  assert.equal(f.executions.length, 1);
  const accepted = JSON.parse(await readFile(join(f.project.stateRoot, result.state.runId, result.state.resultRefs[0].ref.path), 'utf8'));
  const output = JSON.parse(await readFile(join(f.project.stateRoot, result.state.runId, accepted.verification[0].stdout.path), 'utf8'));
  assert.equal(Buffer.from(output.bytes, 'base64').toString(), 'INDEPENDENT_CORE_CHECK');
});
