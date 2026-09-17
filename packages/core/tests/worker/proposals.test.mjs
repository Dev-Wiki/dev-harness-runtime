import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { serializeSnapshot } from '../../dist/snapshot/capture.js';
import { WorkerProposalCollector } from '../../dist/worker/proposals.js';

const fixture = (group, name) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${group}/${name}.json`, import.meta.url), 'utf8'));
const snapshot = fixture('state', 'snapshot');
const hash = createHash('sha256').update(serializeSnapshot(snapshot)).digest('hex');
const request = { ...fixture('execution', 'request'), snapshotHash: hash,
  scope: { ...fixture('execution', 'request').scope,
    files: ['src/a.ts', 'src/link'], directories: ['src/generated'] } };
const before = { snapshot, hash, boundaryHash: 'a'.repeat(64), dirtyPaths: snapshot.dirtyPaths, stagedPaths: [] };

test('staged proposals bind to the Core snapshot, copy bytes and preserve original hashes', () => {
  const collector = new WorkerProposalCollector(request, before);
  const bytes = Buffer.from('one');
  const first = collector.write('src/a.ts', bytes);
  bytes.fill(0);
  assert.equal(Buffer.from(first.content).toString(), 'one');
  assert.equal(first.beforeHash, 'a'.repeat(64));
  assert.equal(first.afterHash, createHash('sha256').update('one').digest('hex'));
  collector.write('src/generated/new.ts', Buffer.from('new'));
  const list = collector.list();
  assert.deepEqual(list.map((entry) => entry.path), ['src/a.ts', 'src/generated/new.ts']);
  list[0].content.fill(0);
  assert.equal(Buffer.from(collector.list()[0].content).toString(), 'one');
  assert.equal(collector.delete('src/generated/new.ts'), null);
  assert.equal(collector.delete('src/a.ts').afterHash, null);
  assert.deepEqual(collector.list().map((entry) => entry.path), ['src/a.ts']);
});

test('proposal collector rejects drift, foreign paths, symlinks and oversized content before project writes', () => {
  assert.throws(() => new WorkerProposalCollector(request, { ...before, hash: 'b'.repeat(64) }), { code: 'DRIFT_DETECTED' });
  const collector = new WorkerProposalCollector(request, before);
  for (const path of ['../outside', '.git/config', 'docs/plan/tasks/K2.md', 'src/generated-other/new.ts']) {
    assert.throws(() => collector.write(path, Buffer.from('x')), { code: 'AUTHORIZATION_VIOLATION' });
  }
  assert.throws(() => collector.write('src/link', Buffer.from('x')), { code: 'AUTHORIZATION_VIOLATION' });
  assert.throws(() => collector.write('src/a.ts', Buffer.alloc(4 * 1024 * 1024 + 1)), { code: 'INVALID_RESULT' });
  assert.deepEqual(collector.list(), []);
});
