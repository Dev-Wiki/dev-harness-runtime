import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compareSnapshots } from '../../dist/snapshot/guard.js';
import { dispatchTask } from '../../dist/orchestrator/runtime.js';
import { readEvidence, readRunAtRevision } from '../../dist/state/index.js';
import { applyWorkerProposals } from '../../dist/worker/apply-proposals.js';
import { persistWorkerProposals } from '../../dist/worker/proposal-evidence.js';
import { setupAcceptance } from '../result/helpers-acceptance.mjs';

const fixture = async (path) => JSON.parse(await readFile(new URL(`../../../contracts/fixtures/${path}.json`, import.meta.url), 'utf8'));
async function blocked(request, changedFiles) {
  return { ...await fixture('execution/result-blocked'), runId: request.runId, taskId: request.taskId,
    attempt: request.attempt, requestId: request.requestId, snapshotHash: request.snapshotHash, changedFiles };
}

test('Core applies only immutable scoped proposal bytes after a frozen Run boundary', async (t) => {
  const f = await setupAcceptance(t, { initialFiles: { 'src/a.ts': 'BEFORE', 'src/remove.ts': 'REMOVE' },
    scopeFiles: ['src/a.ts', 'src/remove.ts'], scopeDirectories: ['src/generated'] });
  const operations = [
    { path: 'src/a.ts', content: Buffer.from('AFTER') },
    { path: 'src/generated/deep/new.ts', content: Buffer.from('NEW') },
    { path: 'src/remove.ts', content: null },
  ];
  const changedFiles = operations.map((item) => item.path).sort();
  const result = await blocked(f.request, changedFiles);
  const ref = await persistWorkerProposals(f.handle, f.run.revision, f.request, result, operations);
  assert.equal((await readFile(join(f.root, 'src/a.ts'), 'utf8')), 'BEFORE');
  const applied = await applyWorkerProposals(f.handle, f.run.revision, f.request, result, ref, f.project);
  assert.equal((await readFile(join(f.root, 'src/a.ts'), 'utf8')), 'AFTER');
  assert.equal((await readFile(join(f.root, 'src/generated/deep/new.ts'), 'utf8')), 'NEW');
  await assert.rejects(readFile(join(f.root, 'src/remove.ts')), { code: 'ENOENT' });
  assert.equal((await stat(join(f.root, 'src/a.ts'))).mode & 0o111, 0);
  assert.deepEqual(compareSnapshots(f.before.snapshot, applied.ending.snapshot).paths, changedFiles);
  const receipt = JSON.parse((await readEvidence(f.handle, f.run.runId, f.run.revision, applied.receiptRef)).toString('utf8'));
  assert.equal(receipt.kind, 'core-proposal-apply-receipt');
  assert.equal(receipt.beforeSnapshotHash, f.before.hash);
  assert.equal(receipt.afterSnapshotHash, applied.ending.hash);
  assert.deepEqual(receipt.proposalRef, ref);
  assert.deepEqual(receipt.paths, changedFiles);
  assert.equal((await readRunAtRevision(f.handle, f.run.runId, f.run.revision)).phase, 'EXECUTE');
});

test('Core refuses stale proposal application without overwriting an intervening user edit', async (t) => {
  const f = await setupAcceptance(t, { initialFiles: { 'src/a.ts': 'BEFORE' }, scopeFiles: ['src/a.ts'] });
  const result = await blocked(f.request, ['src/a.ts']);
  const ref = await persistWorkerProposals(f.handle, f.run.revision, f.request, result,
    [{ path: 'src/a.ts', content: Buffer.from('AFTER') }]);
  await writeFile(join(f.root, 'src/a.ts'), 'USER EDIT');
  await assert.rejects(applyWorkerProposals(f.handle, f.run.revision, f.request, result, ref, f.project),
    { code: 'DRIFT_DETECTED' });
  assert.equal((await readFile(join(f.root, 'src/a.ts'), 'utf8')), 'USER EDIT');
});

test('Core rejects mismatched declared paths and stale revision before project writes', async (t) => {
  const f = await setupAcceptance(t, { initialFiles: { 'src/a.ts': 'BEFORE' }, scopeFiles: ['src/a.ts'] });
  const result = await blocked(f.request, ['src/a.ts']);
  const ref = await persistWorkerProposals(f.handle, f.run.revision, f.request, result,
    [{ path: 'src/a.ts', content: Buffer.from('AFTER') }]);
  await assert.rejects(applyWorkerProposals(f.handle, f.run.revision, f.request,
    await blocked(f.request, []), ref, f.project), { code: 'INVALID_RESULT' });
  await assert.rejects(applyWorkerProposals(f.handle, f.run.revision + 1, f.request, result, ref, f.project),
    { code: 'REVISION_CONFLICT' });
  assert.equal((await readFile(join(f.root, 'src/a.ts'), 'utf8')), 'BEFORE');
});

test('dispatch applies adapter proposals only after quiescence and supplies Core receipts to the verifier', async (t) => {
  const f = await setupAcceptance(t, { initialFiles: { 'src/a.ts': 'BEFORE' }, scopeFiles: ['src/a.ts'] });
  const result = await blocked(f.request, ['src/a.ts']);
  const workerBytes = Buffer.from('---\nname: worker\ndescription: fixture\n---\n');
  const calls = [];
  const adapter = {
    async prepareInvocation() { calls.push('prepare'); },
    executor: { async execute() { calls.push('execute'); return result; } },
    async verifyQuiescence() { calls.push('quiescent'); },
    async collectProposals() { calls.push('proposals'); return [{ path: 'src/a.ts', content: Buffer.from('AFTER') }]; },
    async collectEvidence({ application, after }) {
      calls.push('evidence');
      assert.ok(application); assert.equal(after.hash, application.ending.hash);
      return [{ schemaVersion: 1, kind: 'fixture-host-control', afterHash: after.hash }];
    },
    workerControl: { async verify({ evidence, after }) {
      calls.push('verify');
      assert.equal(evidence.length, 4);
      const receipt = JSON.parse(evidence.find((item) => item.ref.path.includes('apply-receipt')).bytes.toString('utf8'));
      assert.equal(receipt.afterSnapshotHash, after.hash);
      return { providerId: 'fixture-provider', sessionId: 'fixture-session', authorizationEnforced: true, quiescent: true };
    } },
  };
  const state = await dispatchTask(f.handle, f.project, f.run, f.request, f.requestRef, f.frozenInputsRef,
    { workerSkill: { bytes: workerBytes, sha256: createHash('sha256').update(workerBytes).digest('hex') }, acceptance: {} }, adapter);
  assert.equal(state.status, 'BLOCKED');
  assert.equal((await readFile(join(f.root, 'src/a.ts'), 'utf8')), 'AFTER');
  assert.deepEqual(calls, ['prepare', 'execute', 'quiescent', 'proposals', 'evidence', 'verify']);
});
