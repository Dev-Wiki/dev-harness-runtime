import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readEvidence, readRunAtRevision } from '../../dist/state/index.js';
import { loadWorkerProposals, persistWorkerProposals } from '../../dist/worker/proposal-evidence.js';
import { setupAcceptance } from '../result/helpers-acceptance.mjs';

const fixture = async (path) => JSON.parse(await readFile(new URL(`../../../contracts/fixtures/${path}.json`, import.meta.url), 'utf8'));
const proposal = { path: 'src/a.ts', content: Buffer.from('AFTER') };
async function resultFor(request, changedFiles = [proposal.path]) {
  return { ...await fixture('execution/result-blocked'), runId: request.runId, taskId: request.taskId,
    attempt: request.attempt, requestId: request.requestId, snapshotHash: request.snapshotHash, changedFiles };
}

test('proposal evidence is durable, immutable and bound to the current Run without changing the project', async (t) => {
  const f = await setupAcceptance(t, { initialFiles: { 'src/a.ts': 'BEFORE' }, scopeFiles: ['src/a.ts'] });
  const original = await readFile(join(f.root, 'src/a.ts'));
  const runPath = join(f.project.stateRoot, f.run.runId, 'run.json');
  const runBytes = await readFile(runPath);
  const result = await resultFor(f.request);
  const ref = await persistWorkerProposals(f.handle, f.run.revision, f.request, result, [proposal]);
  assert.match(ref.path, /^results\/run-evidence\/worker-proposals-[a-f0-9]{32}\.json$/u);
  const record = JSON.parse((await readEvidence(f.handle, f.run.runId, f.run.revision, ref)).toString('utf8'));
  assert.equal(record.files[0].contentBase64, proposal.content.toString('base64'));
  assert.deepEqual((await loadWorkerProposals(f.handle, f.run.revision, f.request, ref)).list().map((file) => file.path), ['src/a.ts']);
  await assert.rejects(loadWorkerProposals(f.handle, f.run.revision, f.request, { ...ref, path: 'results/run-evidence/other.json' }),
    { code: 'INVALID_RESULT' });
  assert.deepEqual(await readFile(join(f.root, 'src/a.ts')), original);
  assert.deepEqual(await readFile(runPath), runBytes);
  assert.deepEqual(await persistWorkerProposals(f.handle, f.run.revision, f.request, result, [proposal]), ref);
  await assert.rejects(persistWorkerProposals(f.handle, f.run.revision, f.request, result,
    [{ ...proposal, content: Buffer.from('DIFFERENT') }]), { code: 'EVIDENCE_EXISTS' });
  assert.equal((await readRunAtRevision(f.handle, f.run.runId, f.run.revision)).status, 'RUNNING');
});

test('proposal evidence refuses undeclared changes, altered paths, stale identity and live worktree drift', async (t) => {
  const f = await setupAcceptance(t, { initialFiles: { 'src/a.ts': 'BEFORE' }, scopeFiles: ['src/a.ts'] });
  const result = await resultFor(f.request);
  await assert.rejects(persistWorkerProposals(f.handle, f.run.revision, f.request, await resultFor(f.request, []), [proposal]),
    { code: 'INVALID_RESULT' });
  await assert.rejects(persistWorkerProposals(f.handle, f.run.revision, f.request, result,
    [{ path: 'src/other.ts', content: Buffer.from('NO') }]), { code: 'AUTHORIZATION_VIOLATION' });
  await assert.rejects(persistWorkerProposals(f.handle, f.run.revision, { ...f.request, requestId: 'foreign' }, result, [proposal]),
    { code: 'AUTHORIZATION_VIOLATION' });
  await assert.rejects(persistWorkerProposals(f.handle, f.run.revision + 1, f.request, result, [proposal]),
    { code: 'REVISION_CONFLICT' });
  await writeFile(join(f.root, 'src/a.ts'), 'UNCONTROLLED');
  await assert.rejects(persistWorkerProposals(f.handle, f.run.revision, f.request, result, [proposal]),
    { code: 'DRIFT_DETECTED' });
});
