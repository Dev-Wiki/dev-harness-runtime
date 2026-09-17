import assert from 'node:assert/strict';
import { link, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { inspectRun, inspectRunView } from '../../dist/state/inspect.js';
import { inspectParentContext } from '../../dist/worker/status.js';
import { appendAttemptLog, compareAndSwapRun, writeRunEvidence } from '../../dist/state/index.js';
import { fixture, installExecute, publish, setupRecovery } from '../recovery/helpers.mjs';

const runPath = (f) => join(f.project.stateRoot, 'run-a/run.json');
const keys = ['runId', 'taskId', 'status', 'summary', 'verificationSummary', 'commitSha', 'nextTask', 'logRef'].sort();

test('status reads a running Run while its owner lock is held without creating or changing files', async (t) => {
  const f = await setupRecovery(t); await installExecute(f, { status: 'RUNNING' });
  const names = await readdir(f.project.stateRoot, { recursive: true }); const original = await readFile(runPath(f));
  assert.deepEqual(await inspectRun(f.project, 'run-a'), f.run);
  const output = await inspectParentContext(f.project, 'run-a');
  assert.deepEqual(Object.keys(output).sort(), keys); assert.equal(output.status, 'RUNNING'); assert.equal(output.taskId, 'K1');
  assert.deepEqual(await readdir(f.project.stateRoot, { recursive: true }), names);
  assert.deepEqual(await readFile(runPath(f)), original);
});

test('absent state root is STATE_NOT_FOUND and status does not create it', async (t) => {
  const f = await setupRecovery(t);
  await rm(f.project.stateRoot, { recursive: true });
  await assert.rejects(inspectRun(f.project, 'run-a'), { code: 'STATE_NOT_FOUND' });
  await assert.rejects(inspectParentContext(f.project, 'run-a'), { code: 'STATE_NOT_FOUND' });
  await assert.rejects(readdir(f.project.stateRoot), { code: 'ENOENT' });
});

test('status rejects malformed, wrong-identity, hard-linked and symlinked authority without repair', async (t) => {
  const f = await setupRecovery(t); const path = runPath(f); const original = await readFile(path);
  await assert.rejects(inspectRun(f.project, '../run-a'), { code: 'STATE_PATH_INVALID' });
  await writeFile(path, '{'); await assert.rejects(inspectRun(f.project, 'run-a'), { code: 'STATE_CORRUPT' });
  const wrong = JSON.parse(original); wrong.repoIdentity.privateGitDir = join(f.root, 'other-git');
  await writeFile(path, JSON.stringify(wrong)); await assert.rejects(inspectRun(f.project, 'run-a'), { code: 'STATE_IDENTITY_MISMATCH' });
  await writeFile(path, original);
  const alias = join(f.project.stateRoot, 'run-a/alias.json'); await link(path, alias);
  await assert.rejects(inspectRun(f.project, 'run-a'), { code: 'STATE_PATH_INVALID' }); await unlink(alias);
  await unlink(path); await writeFile(alias, original); await symlink(alias, path);
  await assert.rejects(inspectRun(f.project, 'run-a'), { code: 'STATE_PATH_INVALID' });
  assert.deepEqual(await readFile(alias), original);
});

test('status ignores forged summary and Worker text while returning real hashed log references', async (t) => {
  const f = await setupRecovery(t); await installExecute(f, { status: 'RUNNING' });
  const raw = Buffer.from('PRIVATE_WORKER_TEXT\n'.repeat(10000));
  await appendAttemptLog(f.handle, 'run-a', f.run.revision, f.run.pendingOperation.identity, 'stdout', raw);
  await writeFile(join(f.project.stateRoot, 'run-a/summary.json'), JSON.stringify({ status: 'COMPLETED', summary: raw.toString() }));
  const output = await inspectParentContext(f.project, 'run-a');
  assert.equal(output.status, 'RUNNING'); assert.ok(JSON.stringify(output).length < 2048); assert.ok(!JSON.stringify(output).includes('PRIVATE_WORKER_TEXT'));
  const bytes = await inspectRunView(f.project, 'run-a', async (_state, reader) => reader.readEvidence(output.logRef.stdout));
  assert.deepEqual(bytes, raw);
});

async function installAccepted(f) {
  await installExecute(f, { status: 'RUNNING' });
  const value = fixture('execution/result-completed'); delete value.rawResultRef;
  value.snapshotHash = f.request.snapshotHash; value.summary = 'WORKER_TEXT_MUST_NOT_ESCAPE';
  const accepted = { ...value, acceptedAt: f.run.updatedAt, acceptedSnapshotHash: f.run.acceptedSnapshotHash, verifiedEvidenceRefs: [f.run.acceptedSnapshotRef] };
  const ref = await writeRunEvidence(f.handle, 'run-a', f.run.revision, 'status-accepted', accepted);
  const next = { ...f.run, revision: f.run.revision + 1, status: 'COMPLETED', phase: 'FINALIZE', completedTasks: ['K1'], resultRefs: [{ identity: f.run.pendingOperation.identity, ref }] };
  for (const name of ['currentTaskId', 'currentAttempt', 'currentRequestId', 'pendingOperation', 'stopReason']) delete next[name];
  f.run = await compareAndSwapRun(f.handle, 'run-a', f.run.revision, next);
  return ref;
}

test('accepted status verifies result identity and digest and does not trust raw result prose', async (t) => {
  const f = await setupRecovery(t); const ref = await installAccepted(f);
  const output = await inspectParentContext(f.project, 'run-a');
  assert.equal(output.status, 'COMPLETED'); assert.deepEqual(output.verificationSummary, { passed: 2, failed: 0, blocked: 0 });
  assert.ok(!JSON.stringify(output).includes('WORKER_TEXT_MUST_NOT_ESCAPE'));
  const path = join(f.project.stateRoot, 'run-a', ref.path); await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')]));
  await assert.rejects(inspectParentContext(f.project, 'run-a'), { code: 'EVIDENCE_MISMATCH' });
});

test('a concurrent revision transition yields an explicit retry instead of a mixed status', async (t) => {
  const f = await setupRecovery(t);
  await assert.rejects(inspectRunView(f.project, 'run-a', async (state) => {
    await publish(f, { status: 'RUNNING', phase: 'SELECT' });
    return state;
  }), (error) => error.code === 'REVISION_CONFLICT' && /retry/u.test(error.message));
  assert.deepEqual(await inspectRun(f.project, 'run-a'), f.run);
});

test('log append without a revision change invalidates previously captured status refs', async (t) => {
  const f = await setupRecovery(t); await installExecute(f, { status: 'RUNNING' }); const identity = f.run.pendingOperation.identity;
  await assert.rejects(inspectRunView(f.project, 'run-a', async (_state, reader) => {
    const refs = await reader.captureLogs(identity);
    await appendAttemptLog(f.handle, 'run-a', f.run.revision, identity, 'stdout', Buffer.from('new output\n'));
    return refs;
  }), (error) => error.code === 'REVISION_CONFLICT' && /retry/u.test(error.message));
});

test('status verifies persisted snapshot bytes rather than treating run.json references as proof', async (t) => {
  const f = await setupRecovery(t);
  const path = join(f.project.stateRoot, 'run-a', f.run.acceptedSnapshotRef.path);
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')]));
  await assert.rejects(inspectRun(f.project, 'run-a'), { code: 'EVIDENCE_MISMATCH' });
});

test('status rejects another worktree identity and missing attempt logs without fabricating refs', async (t) => {
  const f = await setupRecovery(t); await installExecute(f, { status: 'RUNNING' });
  await assert.rejects(inspectRun({ ...f.project, privateGitDir: join(f.root, 'fake-git') }, 'run-a'));
  await unlink(join(f.project.stateRoot, 'run-a/attempts/K1-1/stdout.log'));
  await assert.rejects(inspectParentContext(f.project, 'run-a'), { code: 'ENOENT' });
});
