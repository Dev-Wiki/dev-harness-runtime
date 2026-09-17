import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readParentContext } from '../../dist/worker/summary.js';
import { appendAttemptLog, compareAndSwapRun, readEvidence, writeRunEvidence } from '../../dist/state/index.js';
import { fixture, installExecute, publish, setupRecovery } from '../recovery/helpers.mjs';

const keys = ['runId', 'taskId', 'status', 'summary', 'verificationSummary', 'commitSha', 'nextTask', 'logRef'].sort();
const identity = (context) => context.run.pendingOperation.identity;
const summary = (context) => readParentContext(context.handle, context.run.runId, context.run.revision);

test('empty Run projection uses the sole run.json authority and does not create a summary file', async (t) => {
  const context = await setupRecovery(t); const before = await readFile(join(context.project.stateRoot, 'run-a/run.json'));
  const output = await summary(context);
  assert.deepEqual(Object.keys(output).sort(), keys); assert.equal(output.status, 'CREATED'); assert.equal(output.taskId, null); assert.equal(output.logRef, null);
  await assert.rejects(readFile(join(context.project.stateRoot, 'run-a/summary.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(context.project.stateRoot, 'run-a/run.json')), before);
});

test('multi-megabyte logs stay private and cannot enter compact parent output', async (t) => {
  const context = await setupRecovery(t); await installExecute(context, { status: 'RUNNING' });
  const chunk = Buffer.from('PRIVATE_TRANSCRIPT_MARKER\n'.repeat(20000));
  for (let count = 0; count < 5; count++) await appendAttemptLog(context.handle, 'run-a', context.run.revision, identity(context), 'stdout', chunk);
  const output = await summary(context); const encoded = JSON.stringify(output);
  assert.deepEqual(Object.keys(output).sort(), keys); assert.ok(encoded.length < 2048); assert.ok(!encoded.includes('PRIVATE_TRANSCRIPT_MARKER'));
  assert.equal(output.taskId, 'K1'); assert.equal(output.commitSha, null); assert.deepEqual(output.verificationSummary, { passed: 0, failed: 0, blocked: 0 });
  const bytes = await readEvidence(context.handle, 'run-a', context.run.revision, output.logRef.stdout);
  assert.equal(bytes.length, chunk.length * 5); assert.deepEqual(bytes.subarray(-chunk.length), chunk);
});

test('Worker completed candidate and forged summary.json cannot report accepted completion', async (t) => {
  const context = await setupRecovery(t); await installExecute(context, { status: 'RUNNING' });
  const result = fixture('execution/result-completed'); result.snapshotHash = context.request.snapshotHash;
  const ref = await writeRunEvidence(context.handle, 'run-a', context.run.revision, 'candidate', result);
  await publish(context, { resultRefs: [{ identity: identity(context), ref }] });
  await writeFile(join(context.project.stateRoot, 'run-a/summary.json'), JSON.stringify({ status: 'COMPLETED', summary: 'FORGED_PARENT_TRANSCRIPT' }));
  const output = await summary(context);
  assert.equal(output.status, 'RUNNING'); assert.match(output.summary, /尚未完成 Core 验收/u);
  assert.deepEqual(output.verificationSummary, { passed: 0, failed: 0, blocked: 0 }); assert.ok(!JSON.stringify(output).includes('FORGED'));
});

async function acceptedFixture(context, patch = {}) {
  // Projection fixture only; real acceptance and commit are separately tested in K4-V.
  const result = fixture('execution/result-completed'); delete result.rawResultRef;
  result.snapshotHash = context.request.snapshotHash; result.summary = 'DO_NOT_ECHO_TRANSCRIPT'.repeat(100);
  const accepted = { ...result, acceptedAt: context.run.updatedAt, acceptedSnapshotHash: context.run.acceptedSnapshotHash, verifiedEvidenceRefs: [context.run.acceptedSnapshotRef], ...patch };
  const ref = await writeRunEvidence(context.handle, 'run-a', context.run.revision, 'accepted-projection-fixture', accepted);
  const next = { ...context.run, revision: context.run.revision + 1, status: 'COMPLETED', phase: 'FINALIZE', completedTasks: ['K1'], resultRefs: [{ identity: identity(context), ref }] };
  for (const key of ['currentTaskId', 'currentAttempt', 'currentRequestId', 'pendingOperation', 'stopReason']) delete next[key];
  context.run = await compareAndSwapRun(context.handle, 'run-a', context.run.revision, next);
}

test('accepted projection binds result and logs without echoing stored summary or verification details', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' }); await installExecute(context, { status: 'RUNNING' });
  await acceptedFixture(context, { commitSha: context.run.repoIdentity.head });
  const output = await summary(context);
  assert.equal(output.status, 'COMPLETED'); assert.equal(output.commitSha, context.run.repoIdentity.head);
  assert.deepEqual(output.verificationSummary, { passed: 2, failed: 0, blocked: 0 }); assert.ok(!JSON.stringify(output).includes('DO_NOT_ECHO'));
  assert.equal(output.nextTask, null); assert.ok(output.logRef.stdout.path.startsWith('attempts/K1-1/'));
  await unlink(join(context.project.stateRoot, 'run-a', output.logRef.stderr.path));
  await assert.rejects(summary(context));
});

test('accepted boundary mismatch and stale revision are rejected, not hidden by a compact summary', async (t) => {
  const context = await setupRecovery(t); await installExecute(context, { status: 'RUNNING' }); const old = context.run.revision;
  await acceptedFixture(context, { acceptedSnapshotHash: 'f'.repeat(64) });
  await assert.rejects(summary(context), (error) => error.code === 'STATE_IDENTITY_MISMATCH');
  await assert.rejects(readParentContext(context.handle, 'run-a', old), (error) => error.code === 'REVISION_CONFLICT');
});
