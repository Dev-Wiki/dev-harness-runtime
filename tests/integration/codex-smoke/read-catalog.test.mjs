import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexReadView } from '../../../packages/adapter-codex/dist/executor/read-view.js';
import { serializeSnapshot, snapshotBoundaryHash } from '../../../packages/core/dist/snapshot/capture.js';
import { createWorkerReadCatalog } from '../../../packages/core/dist/worker/read-catalog.js';

const fixture = async (group, name) => JSON.parse(await readFile(new URL(`../../../packages/contracts/fixtures/${group}/${name}.json`, import.meta.url), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('Core frozen catalog is accepted by the Codex bridge and refuses changed bytes', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-codex-catalog-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'HELLO');
  const fixtureSnapshot = await fixture('state', 'snapshot');
  const snapshot = { ...fixtureSnapshot, repoIdentity: { ...fixtureSnapshot.repoIdentity, repoRoot: root },
    paths: fixtureSnapshot.paths.map((entry) => entry.path === 'src/a.ts'
      ? { ...entry, rawContentHash: digest('HELLO') } : entry) };
  const hash = digest(serializeSnapshot(snapshot));
  const before = { snapshot, hash, boundaryHash: snapshotBoundaryHash(snapshot),
    dirtyPaths: snapshot.dirtyPaths, stagedPaths: snapshot.stagedPaths };
  const fixtureRequest = await fixture('execution', 'request');
  const request = { ...fixtureRequest, repoRoot: root, docsRoot: join(root, 'docs'),
    dashboardPath: join(root, 'docs/plan/Dashboard.md'), taskPath: join(root, 'docs/plan/tasks/K1.md'),
    snapshotHash: hash, protocolSource: snapshot.protocolSource };
  const view = await CodexReadView.create(createWorkerReadCatalog(request, before));
  assert.deepEqual(await view.readPage('src/a.ts'), { path: 'src/a.ts', content: 'HELLO', sha256: digest('HELLO'),
    offset: 0, nextOffset: null });
  await writeFile(join(root, 'src/a.ts'), 'CHANGED');
  await assert.rejects(view.readPage('src/a.ts'), { code: 'DRIFT_DETECTED' });
});
