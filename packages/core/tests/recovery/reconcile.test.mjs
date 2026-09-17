import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { discoverProject } from '../../dist/discovery/index.js';
import { acquireLock, releaseLock } from '../../dist/lock/index.js';
import { captureSnapshot } from '../../dist/snapshot/capture.js';
import { compareAndSwapRun, initializeRun, readCurrentRun, writeRunEvidence } from '../../dist/state/index.js';
import { withStateFaultForTest } from '../../dist/state/testing.js';
import { assertNewRunAllowed, createReconciledSuccessor, reconcileRun } from '../../dist/recovery/reconcile.js';

const execute = promisify(execFile);
const contractFixture = async (name) => JSON.parse(await readFile(new URL(`../../../contracts/fixtures/state/${name}.json`, import.meta.url), 'utf8'));
const planningFixture = (name) => readFile(new URL(`../../../../tests/fixtures/planning/${name}`, import.meta.url), 'utf8');
async function git(root, ...args) { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim(); }
async function write(root, path, value) { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value); }
const pending = (error) => error.code === 'PENDING_RECONCILIATION';
function dashboard(archived) {
  const id = archived ? 'NEXT' : 'K1';
  return `# Dashboard\n\n## 当前工作顺序\n\n1. [${id} — 任务](tasks/${id}.md)\n\n## 活跃任务\n\n`
    + '| 任务 | 优先级 | 状态 | 依赖 | 下一步 / 阻塞 | 详情 |\n|---|---|---|---|---|---|\n'
    + `| ${id} — 任务 | 🟡 P1 | 🟢 待执行 | ${archived ? 'K1' : '无'} | 无 | [执行包](tasks/${id}.md) |\n`;
}

async function fixture(t, archived = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-reconcile-')));
  let handle;
  t.after(async () => { if (handle) await releaseLock(handle); await rm(root, { recursive: true, force: true }); });
  await git(root, 'init', '-q'); await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  await write(root, 'AGENTS.md', '# Rules\n[Git](docs/GIT_WORKFLOW.md)\n');
  await write(root, 'HARNESS.md', '# HARNESS\n## 已确认命令\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| full | `node --test` | confirmed |\n');
  await write(root, 'docs/GIT_WORKFLOW.md', '# Git\n');
  await write(root, 'docs/requirements.md', '# Requirements\n');
  await write(root, 'docs/CONTRACTS.md', '# Contracts\n');
  await write(root, 'docs/plan/Dashboard.md', dashboard(false));
  const packet = await planningFixture('task-packet.md');
  await write(root, 'docs/plan/tasks/K1.md', packet.replaceAll('{{ID}}', 'K1').replaceAll('{{TITLE}}', '任务'));
  await write(root, 'src/a.ts', 'export const initial = true;\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-q', '--no-gpg-sign', '-m', 'initial');
  const project = await discoverProject(root);
  handle = await acquireLock(project, { runId: 'reconcile-owner', adapter: 'codex' });
  const template = await contractFixture('run-created');
  const captured = await captureSnapshot({ project, runId: 'run-a', protocolSource: template.protocolSource, adapterConfigHash: template.adapterConfigHash });
  const { initialUserChangesRef: _i, initialUserChangesHash: _ih, acceptedSnapshotRef: _a, acceptedSnapshotHash: _ah, ...seed } = template;
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const initial = await initializeRun(handle, { ...seed, repoIdentity: captured.snapshot.repoIdentity, createdAt, updatedAt: createdAt }, captured.snapshot);
  const executing = await contractFixture('run-execute');
  const failed = await compareAndSwapRun(handle, 'run-a', 0, { ...initial, revision: 1, status: 'FAILED', phase: 'EXECUTE',
    currentTaskId: 'K1', currentAttempt: 1, currentRequestId: 'request-a', updatedAt: new Date().toISOString(),
    stopReason: { code: 'INVALID_RESULT', message: 'Unaccepted failed execution' },
    pendingOperation: { ...executing.pendingOperation, beforeSnapshotRef: initial.acceptedSnapshotRef,
      beforeSnapshotHash: initial.acceptedSnapshotHash, createdAt } });
  if (archived) {
    await write(root, 'docs/plan/Dashboard.md', dashboard(true));
    await write(root, 'docs/plan/tasks/NEXT.md', packet.replaceAll('{{ID}}', 'NEXT').replaceAll('{{TITLE}}', '后续任务'));
    await rm(join(root, 'docs/plan/tasks/K1.md'));
    await write(root, 'docs/plan/archive/M1/K1.md', (await planningFixture('archive-packet.md')).replaceAll('任务 A：', '任务 K1 — ').replaceAll('verification/A.md', 'verification/K1.md'));
    await write(root, 'docs/plan/archive/M1/README.md', (await planningFixture('archive-index.md')).replaceAll('| A |', '| K1 |').replaceAll('[A](A.md)', '[K1](K1.md)'));
    await write(root, 'docs/verification/K1.md', '# Core verification\n');
  }
  const current = await captureSnapshot({ project, runId: 'run-a', protocolSource: template.protocolSource, adapterConfigHash: template.adapterConfigHash });
  const currentRef = await writeRunEvidence(handle, 'run-a', failed.revision, 'alignment-current', current.snapshot);
  const proof = await writeRunEvidence(handle, 'run-a', failed.revision, 'alignment-proof', { schemaVersion: 1, runId: 'run-a', operationId: 'operation-a', trustedFixtureProof: true });
  const resolution = { schemaVersion: 1, runId: 'run-a', expectedRevision: failed.revision, currentSnapshotRef: currentRef, currentSnapshotHash: currentRef.sha256,
    resolvedBy: 'maintainer', disposition: archived ? 'Retained archive after independent acceptance' : 'Restored active task',
    taskIds: ['K1'], evidenceRefs: [proof], createdAt: new Date().toISOString() };
  const ref = await writeRunEvidence(handle, 'run-a', failed.revision, 'resolution', resolution);
  const verifier = { project, verifyEvidence: async ({ state, bytes }) => {
    const proof = JSON.parse(bytes); return proof.operationId === state.pendingOperation.operationId && proof.trustedFixtureProof === true;
  } };
  return { root, project, handle, failed, current, currentRef, proof, resolution, ref, verifier };
}

test('explicit alignment preserves failed status, reason, completedTasks and pending history', async (t) => {
  const f = await fixture(t);
  await assert.rejects(assertNewRunAllowed(f.handle, f.verifier), pending);
  const state = await reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier);
  assert.equal(state.revision, 2);
  for (const field of ['status', 'stopReason', 'completedTasks', 'pendingOperation', 'currentTaskId', 'currentAttempt', 'currentRequestId']) assert.deepEqual(state[field], f.failed[field]);
  assert.equal(state.reconciliation.originalRevision, 1);
  assert.equal(state.reconciliation.originalPendingIdentity.operationId, 'operation-a');
  await assert.rejects(assertNewRunAllowed(f.handle, f.verifier), pending);
  await assert.rejects(reconcileRun(f.handle, 'run-a', state.revision, f.ref, f.verifier), pending);
});

test('Worker environments cannot reconcile, consume alignment, or pass a new Run gate', async (t) => {
  const f = await fixture(t);
  const previous = process.env.DEV_HARNESS_WORKER;
  process.env.DEV_HARNESS_WORKER = '1';
  try {
    for (const operation of [() => reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier),
      () => createReconciledSuccessor(f.handle, 'run-a', 1, 'run-b', f.verifier), () => assertNewRunAllowed(f.handle, f.verifier)]) {
      await assert.rejects(operation(), (error) => error.code === 'AUTHORIZATION_VIOLATION');
    }
  } finally { if (previous === undefined) delete process.env.DEV_HARNESS_WORKER; else process.env.DEV_HARNESS_WORKER = previous; }
  assert.equal((await readCurrentRun(f.handle, 'run-a')).revision, 1);
});

test('resolution must bind the expected revision and include the actual pending Task', async (t) => {
  const f = await fixture(t);
  for (const [name, mutation] of [['wrong-revision', { expectedRevision: 0 }], ['wrong-task', { taskIds: ['OTHER'] }]]) {
    const ref = await writeRunEvidence(f.handle, 'run-a', 1, name, { ...f.resolution, ...mutation });
    await assert.rejects(reconcileRun(f.handle, 'run-a', 1, ref, f.verifier), pending);
  }
  await assert.rejects(reconcileRun(f.handle, 'run-a', 1, f.ref, { project: f.project }), pending);
  await assert.rejects(reconcileRun(f.handle, 'run-a', 1, f.ref, { ...f.verifier, verifyEvidence: async () => false }), pending);
  assert.equal((await readCurrentRun(f.handle, 'run-a')).revision, 1);
});

test('evidence tampering and actual content drift cannot be accepted by resolution text', async (t) => {
  const f = await fixture(t);
  const path = join(f.project.stateRoot, 'run-a', f.proof.path);
  const original = await readFile(path);
  await writeFile(path, 'changed');
  await assert.rejects(reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier), (error) => error.code === 'EVIDENCE_MISMATCH');
  await writeFile(path, original);
  await writeFile(join(f.root, 'src/a.ts'), 'export const external = true;\n');
  await assert.rejects(reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier), pending);
});

test('retained archive requires independent Core acceptance, not documentation claims', async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier), pending);
  let calls = 0;
  const state = await reconcileRun(f.handle, 'run-a', 1, f.ref, { ...f.verifier, verifyArchivedTask: async ({ taskId, current }) => {
    calls += 1; assert.equal(taskId, 'K1');
    const path = 'docs/plan/archive/M1/K1.md';
    return { path, sha256: current.snapshot.paths.find((entry) => entry.path === path).rawContentHash };
  } });
  assert.equal(calls, 1);
  assert.equal(state.status, 'FAILED');
  assert.deepEqual(state.completedTasks, []);
});

test('one persisted successor consumes alignment and closed history does not pin future commits', async (t) => {
  const f = await fixture(t);
  const aligned = await reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier);
  const successor = await createReconciledSuccessor(f.handle, 'run-a', aligned.revision, 'run-b', f.verifier);
  let source = await readCurrentRun(f.handle, 'run-a');
  assert.equal(source.reconciliation.successor.runId, 'run-b');
  assert.equal(source.reconciliation.successor.createdAt, successor.createdAt);
  assert.equal(successor.reconciledFrom.revision, aligned.revision);
  assert.equal(successor.reconciledFrom.snapshotHash, f.currentRef.sha256);
  assert.equal(successor.authorization.runId, 'run-b');
  await assert.rejects(assertNewRunAllowed(f.handle, f.verifier), pending);
  await assert.rejects(createReconciledSuccessor(f.handle, 'run-a', source.revision, 'run-c', f.verifier), pending);
  const completed = await compareAndSwapRun(f.handle, 'run-b', 0, { ...successor, revision: 1, status: 'COMPLETED', phase: 'FINALIZE', updatedAt: new Date().toISOString() });
  await writeFile(join(f.root, 'src/a.ts'), 'export const later = true;\n');
  await git(f.root, 'add', '.'); await git(f.root, 'commit', '-q', '--no-gpg-sign', '-m', 'later legitimate work');
  await assertNewRunAllowed(f.handle, f.verifier);
  source = await readCurrentRun(f.handle, 'run-a');
  const same = await createReconciledSuccessor(f.handle, 'run-a', source.revision, 'run-b', f.verifier);
  assert.equal(same.runId, 'run-b'); assert.equal(same.revision, completed.revision);
  await assert.rejects(reconcileRun(f.handle, 'run-a', source.revision, f.ref, f.verifier), pending);
});

for (const crashPoint of ['reservation', 'initialization-evidence', 'successor-published']) {
  test(`successor retry uses the same reserved ID after ${crashPoint} interruption`, async (t) => {
    const f = await fixture(t);
    const aligned = await reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier);
    let injected = false;
    await assert.rejects(withStateFaultForTest((point, path) => {
      const normalized = path.replaceAll('\\', '/');
      const target = crashPoint === 'reservation' ? '/run-a/run.json'
        : crashPoint === 'initialization-evidence' ? '/run-b/results/run-evidence/initialization.json' : '/run-b/run.json';
      if (!injected && point === 'directory-synced' && normalized.endsWith(target)) { injected = true; throw new Error('injected interruption'); }
    }, () => createReconciledSuccessor(f.handle, 'run-a', aligned.revision, 'run-b', f.verifier)), /injected interruption/);
    assert.equal(injected, true);
    const reserved = await readCurrentRun(f.handle, 'run-a');
    assert.equal(reserved.reconciliation.successor.runId, 'run-b');
    assert.equal(reserved.reconciliation.successor.createdAt, undefined);
    await assert.rejects(createReconciledSuccessor(f.handle, 'run-a', reserved.revision, 'run-c', f.verifier), pending);
    const successor = await createReconciledSuccessor(f.handle, 'run-a', reserved.revision, 'run-b', f.verifier);
    assert.equal(successor.runId, 'run-b'); assert.equal(successor.revision, 0);
    assert.equal((await readCurrentRun(f.handle, 'run-a')).reconciliation.successor.createdAt, successor.createdAt);
  });
}

test('new Run gate rejects unbound consumers and new unresolved operations after consumption', async (t) => {
  const f = await fixture(t);
  const aligned = await reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier);
  const successor = await createReconciledSuccessor(f.handle, 'run-a', aligned.revision, 'run-b', f.verifier);
  const executing = await contractFixture('run-execute');
  await compareAndSwapRun(f.handle, 'run-b', 0, { ...successor, revision: 1, status: 'FAILED', phase: 'EXECUTE',
    currentTaskId: 'K1', currentAttempt: 1, currentRequestId: 'request-b', updatedAt: new Date().toISOString(),
    stopReason: { code: 'INVALID_RESULT', message: 'New unresolved operation' }, pendingOperation: { ...executing.pendingOperation,
      identity: { runId: 'run-b', taskId: 'K1', attempt: 1, requestId: 'request-b' }, beforeSnapshotRef: successor.acceptedSnapshotRef,
      beforeSnapshotHash: successor.acceptedSnapshotHash, createdAt: successor.createdAt } });
  await assert.rejects(assertNewRunAllowed(f.handle, f.verifier), pending);
  const path = join(f.project.stateRoot, 'run-b/run.json');
  const corrupted = JSON.parse(await readFile(path, 'utf8'));
  corrupted.reconciledFrom.runId = 'unknown-source';
  await writeFile(path, JSON.stringify(corrupted));
  await assert.rejects(assertNewRunAllowed(f.handle, f.verifier), pending);
});

test('new Run gate rejects duplicate consumers of one explicit alignment', async (t) => {
  const f = await fixture(t);
  const aligned = await reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier);
  const successor = await createReconciledSuccessor(f.handle, 'run-a', aligned.revision, 'run-b', f.verifier);
  const { initialUserChangesRef: _i, initialUserChangesHash: _ih, acceptedSnapshotRef: _a, acceptedSnapshotHash: _ah, ...seed } = successor;
  await initializeRun(f.handle, { ...seed, runId: 'run-c', authorization: { ...seed.authorization, runId: 'run-c' } }, { ...f.current.snapshot, runId: 'run-c' });
  await assert.rejects(assertNewRunAllowed(f.handle, f.verifier), (error) => pending(error) && /multiple or unreserved consumers/u.test(error.message));
});

test('new Run gate rejects a schema-valid cyclic successor graph before using its evidence', async (t) => {
  const f = await fixture(t);
  const aligned = await reconcileRun(f.handle, 'run-a', 1, f.ref, f.verifier);
  const successor = await createReconciledSuccessor(f.handle, 'run-a', aligned.revision, 'run-b', f.verifier);
  const source = await readCurrentRun(f.handle, 'run-a');
  const at = new Date().toISOString();
  const operation = { ...f.failed.pendingOperation,
    identity: { runId: 'run-b', taskId: 'K1', attempt: 1, requestId: 'request-b' },
    beforeSnapshotRef: successor.acceptedSnapshotRef, beforeSnapshotHash: successor.acceptedSnapshotHash, createdAt: at };
  const cyclic = { ...successor, revision: 3, status: 'FAILED', phase: 'EXECUTE', updatedAt: at,
    currentTaskId: 'K1', currentAttempt: 1, currentRequestId: 'request-b', stopReason: f.failed.stopReason, pendingOperation: operation,
    reconciliation: { schemaVersion: 1, originalRevision: 1,
      originalPendingIdentity: { operationId: operation.operationId, kind: operation.kind, identity: operation.identity },
      resolutionRef: successor.acceptedSnapshotRef, resolvedBy: 'maintainer', currentSnapshotRef: successor.acceptedSnapshotRef,
      currentSnapshotHash: successor.acceptedSnapshotHash, taskIds: ['K1'], evidenceRefs: [successor.acceptedSnapshotRef], resolvedAt: at,
      successor: { runId: 'run-a', reservedAt: at } } };
  await writeFile(join(f.project.stateRoot, 'run-b/run.json'), JSON.stringify(cyclic));
  await writeFile(join(f.project.stateRoot, 'run-a/run.json'), JSON.stringify({ ...source,
    reconciledFrom: { runId: 'run-b', revision: 2, resolutionHash: successor.acceptedSnapshotHash, snapshotHash: successor.acceptedSnapshotHash } }));
  await assert.rejects(assertNewRunAllowed(f.handle, f.verifier), (error) => pending(error) && /successor cycle/u.test(error.message));
});
