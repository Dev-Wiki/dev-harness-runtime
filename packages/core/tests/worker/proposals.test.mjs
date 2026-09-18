import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { serializeSnapshot, snapshotBoundaryHash } from '../../dist/snapshot/capture.js';
import { WorkerProposalCollector } from '../../dist/worker/proposals.js';

const fixture = (group, name) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${group}/${name}.json`, import.meta.url), 'utf8'));
const snapshot = fixture('state', 'snapshot');
const hash = createHash('sha256').update(serializeSnapshot(snapshot)).digest('hex');
const request = { ...fixture('execution', 'request'), snapshotHash: hash,
  scope: { ...fixture('execution', 'request').scope,
    files: ['src/a.ts', 'src/link'], directories: ['src/generated'] } };
const before = { snapshot, hash, boundaryHash: snapshotBoundaryHash(snapshot), dirtyPaths: snapshot.dirtyPaths, stagedPaths: [] };
const blocked = { ...fixture('execution', 'result-blocked'), snapshotHash: hash };

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
  assert.doesNotThrow(() => collector.assertDeclaredChanges({ ...blocked, changedFiles: ['src/a.ts'] }));
  assert.throws(() => collector.assertDeclaredChanges(blocked), { code: 'INVALID_RESULT' });
  assert.throws(() => collector.assertDeclaredChanges({ ...blocked, changedFiles: ['src/generated/new.ts'] }), { code: 'INVALID_RESULT' });
});

test('proposal collector rejects drift, foreign paths, symlinks and oversized content before project writes', () => {
  assert.throws(() => new WorkerProposalCollector(request, { ...before, hash: 'b'.repeat(64) }), { code: 'DRIFT_DETECTED' });
  const collector = new WorkerProposalCollector(request, before);
  for (const path of ['../outside', '.git/config', 'docs/plan/tasks/K2.md', 'src/generated-other/new.ts',
    `src/generated/${'a'.repeat(4090)}`]) {
    assert.throws(() => collector.write(path, Buffer.from('x')), { code: 'AUTHORIZATION_VIOLATION' });
  }
  assert.throws(() => collector.write('src/link', Buffer.from('x')), { code: 'AUTHORIZATION_VIOLATION' });
  assert.throws(() => collector.write('src/a.ts', Buffer.alloc(4 * 1024 * 1024 + 1)), { code: 'INVALID_RESULT' });
  assert.deepEqual(collector.list(), []);
});

test('a proposal restoring the baseline is a no-op and is not a declared change', () => {
  const baselineHash = createHash('sha256').update('same').digest('hex');
  const original = { ...snapshot, paths: snapshot.paths.map((entry) => entry.path === 'src/a.ts'
    ? { ...entry, rawContentHash: baselineHash } : entry) };
  const originalHash = createHash('sha256').update(serializeSnapshot(original)).digest('hex');
  const staged = new WorkerProposalCollector({ ...request, snapshotHash: originalHash },
    { ...before, snapshot: original, hash: originalHash, boundaryHash: snapshotBoundaryHash(original) });
  staged.write('src/a.ts', Buffer.from('changed'));
  assert.equal(staged.write('src/a.ts', Buffer.from('same')), null);
  assert.deepEqual(staged.list(), []);
  assert.doesNotThrow(() => staged.assertDeclaredChanges({ ...blocked, snapshotHash: originalHash }));
});

test('proposal records round-trip bytes and reject changed identity, hashes and encoding', () => {
  const staged = new WorkerProposalCollector(request, before);
  staged.write('src/a.ts', Buffer.from('HELLO'));
  staged.write('src/generated/new.ts', Buffer.from('NEW'));
  const record = staged.record();
  assert.deepEqual(WorkerProposalCollector.restore(request, before, record).record(), record);
  assert.throws(() => WorkerProposalCollector.restore(request, before, { ...record, requestId: 'other' }), { code: 'INVALID_RESULT' });
  assert.throws(() => WorkerProposalCollector.restore(request, before, { ...record, files: [
    { ...record.files[0], afterHash: 'b'.repeat(64) }, record.files[1],
  ] }), { code: 'INVALID_RESULT' });
  assert.throws(() => WorkerProposalCollector.restore(request, before, { ...record, files: [
    { ...record.files[0], contentBase64: '@@@@' }, record.files[1],
  ] }), { code: 'INVALID_RESULT' });
  assert.throws(() => WorkerProposalCollector.restore(request, before, { ...record, files: [...record.files].reverse() }),
    { code: 'INVALID_RESULT' });
});

test('proposal staging bounds the number of zero-byte files independently of byte quota', () => {
  const staged = new WorkerProposalCollector(request, before);
  for (let index = 0; index < 1024; index++) staged.write(`src/generated/${index}.txt`, Buffer.alloc(0));
  assert.equal(staged.list().length, 1024);
  assert.throws(() => staged.write('src/generated/extra.txt', Buffer.alloc(0)), { code: 'INVALID_RESULT' });
});

test('ending snapshot must match proposed bytes and no other file transition', () => {
  const staged = new WorkerProposalCollector(request, before);
  staged.write('src/a.ts', Buffer.from('HELLO'));
  const changed = { ...snapshot, dirtyPaths: [...snapshot.dirtyPaths, 'src/a.ts'],
    paths: snapshot.paths.map((entry) => entry.path === 'src/a.ts'
      ? { ...entry, rawContentHash: createHash('sha256').update('HELLO').digest('hex') } : entry) };
  const capture = (value) => ({ snapshot: value,
    hash: createHash('sha256').update(serializeSnapshot(value)).digest('hex'),
    boundaryHash: snapshotBoundaryHash(value), dirtyPaths: value.dirtyPaths, stagedPaths: value.stagedPaths });
  assert.doesNotThrow(() => staged.assertAppliedSnapshot(capture(changed)));
  const wrong = { ...changed, paths: changed.paths.map((entry) => entry.path === 'src/a.ts'
    ? { ...entry, rawContentHash: 'b'.repeat(64) } : entry) };
  assert.throws(() => staged.assertAppliedSnapshot(capture(wrong)), { code: 'AUTHORIZATION_VIOLATION' });
  const wrongMode = { ...changed, paths: changed.paths.map((entry) => entry.path === 'src/a.ts'
    ? { ...entry, mode: '100755' } : entry) };
  assert.throws(() => staged.assertAppliedSnapshot(capture(wrongMode)), { code: 'AUTHORIZATION_VIOLATION' });
  const foreign = { ...changed, paths: [...changed.paths, { path: 'other.txt', type: 'file', mode: '100644',
    deleted: false, rawContentHash: 'b'.repeat(64), index: [] }] };
  assert.throws(() => staged.assertAppliedSnapshot(capture(foreign)), { code: 'AUTHORIZATION_VIOLATION' });
});
