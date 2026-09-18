import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { serializeSnapshot, snapshotBoundaryHash } from '../../dist/snapshot/capture.js';
import { createWorkerReadCatalog } from '../../dist/worker/read-catalog.js';

const fixture = (group, name) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${group}/${name}.json`, import.meta.url), 'utf8'));
const snapshot = fixture('state', 'snapshot');
const requestFixture = { ...fixture('execution', 'request'), protocolSource: snapshot.protocolSource };
const captured = (value) => ({ snapshot: value,
  hash: createHash('sha256').update(serializeSnapshot(value)).digest('hex'),
  boundaryHash: snapshotBoundaryHash(value), dirtyPaths: value.dirtyPaths, stagedPaths: value.stagedPaths });

test('Core derives a read catalog from only frozen regular files and binds its request identity', () => {
  const before = captured(snapshot);
  const request = { ...requestFixture, snapshotHash: before.hash };
  const catalog = createWorkerReadCatalog(request, before);
  assert.deepEqual(catalog, { repoRoot: request.repoRoot, runId: request.runId,
    requestId: request.requestId, snapshotHash: before.hash,
    files: snapshot.paths.filter((entry) => entry.type === 'file')
      .map((entry) => ({ path: entry.path, sha256: entry.rawContentHash }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) });
  assert.ok(!catalog.files.some((file) => file.path === 'src/link'));
});

test('Core refuses an unbound or aliased read catalog before preparing the host', () => {
  const before = captured(snapshot);
  const request = { ...requestFixture, snapshotHash: before.hash };
  assert.throws(() => createWorkerReadCatalog({ ...request, snapshotHash: 'b'.repeat(64) }, before), { code: 'DRIFT_DETECTED' });
  assert.throws(() => createWorkerReadCatalog({ ...request, protocolSource: {
    ...request.protocolSource, commit: 'c'.repeat(40),
  } }, before), { code: 'DRIFT_DETECTED' });
  const file = snapshot.paths.find((entry) => entry.type === 'file');
  const aliased = { ...snapshot, paths: [...snapshot.paths, { ...file, path: file.path.toUpperCase() }] };
  assert.throws(() => captured(aliased), { code: 'INVALID_CONTRACT' });
});
