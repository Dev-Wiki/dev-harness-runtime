import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { persistCodexSessionProposals } from '../../../packages/adapter-codex/dist/executor/proposal-evidence.js';
import { loadWorkerProposals } from '../../../packages/core/dist/worker/proposal-evidence.js';
import { setupAcceptance } from '../../../packages/core/tests/result/helpers-acceptance.mjs';

const blockedFixture = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/execution/result-blocked.json', import.meta.url), 'utf8'));
const resultFor = (request, changedFiles) => ({ ...blockedFixture, runId: request.runId,
  taskId: request.taskId, attempt: request.attempt, requestId: request.requestId,
  snapshotHash: request.snapshotHash, changedFiles });

for (const content of ['AFTER', null]) {
  test(`Codex ${content === null ? 'delete' : 'text'} output becomes immutable Core Run proposal evidence`, async (t) => {
    const f = await setupAcceptance(t, { initialFiles: { 'src/a.ts': 'BEFORE' }, scopeFiles: ['src/a.ts'] });
    const output = { threadId: '01a0b3f2-ddc2-7c30-9f5c-8ff7e992b3bb',
      result: resultFor(f.request, ['src/a.ts']), proposals: [{ path: 'src/a.ts', content }] };
    const ref = await persistCodexSessionProposals(f.handle, f.run.revision, f.request, output);
    const collector = await loadWorkerProposals(f.handle, f.run.revision, f.request, ref);
    assert.deepEqual(collector.list().map((entry) => ({ path: entry.path,
      content: entry.content === null ? null : Buffer.from(entry.content).toString('utf8') })),
    [{ path: 'src/a.ts', content }]);
    assert.equal(await readFile(join(f.root, 'src/a.ts'), 'utf8'), 'BEFORE');
    await assert.rejects(persistCodexSessionProposals(f.handle, f.run.revision, f.request,
      { ...output, result: resultFor(f.request, []) }), { code: 'INVALID_RESULT' });
  });
}
