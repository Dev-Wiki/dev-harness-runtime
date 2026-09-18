import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexBridgePolicy, createCodexBridgeView } from '../dist/executor/bridge-policy.js';

const requestFixture = JSON.parse(readFileSync(new URL('../../contracts/fixtures/execution/request.json', import.meta.url), 'utf8'));

test('Codex bridge policy binds the Core request, read catalog and Task write scope', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-codex-bridge-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = { ...requestFixture, repoRoot: root, docsRoot: join(root, 'docs'),
    dashboardPath: join(root, 'docs/plan/Dashboard.md'), taskPath: join(root, 'docs/plan/tasks/K1.md') };
  const catalog = { repoRoot: root, runId: request.runId, requestId: request.requestId,
    snapshotHash: request.snapshotHash, files: [] };
  const policy = createCodexBridgePolicy(request, catalog);
  const bridge = await createCodexBridgeView(policy);
  assert.equal(bridge.allowsProposal('src/a.ts'), true);
  assert.equal(bridge.allowsProposal('src/other.ts'), false);
  assert.equal(bridge.allowsProposal('docs/plan/tasks/other.md'), false);
  assert.equal(bridge.allowsProposal('docs/plan/tasks/K1.md'), true);
  assert.throws(() => createCodexBridgePolicy(request, { ...catalog, snapshotHash: 'b'.repeat(64) }), { code: 'INVALID_POLICY' });
  await assert.rejects(createCodexBridgeView({ ...policy, identity: { ...policy.identity, requestId: 'other' } }),
    { code: 'INVALID_POLICY' });
  await assert.rejects(createCodexBridgeView({ ...policy, scope: { ...policy.scope,
    planning: { ...policy.scope.planning, taskId: 'K2' } } }), { code: 'INVALID_POLICY' });
  await assert.rejects(createCodexBridgeView({ ...policy, extra: true }), { code: 'INVALID_POLICY' });
});
