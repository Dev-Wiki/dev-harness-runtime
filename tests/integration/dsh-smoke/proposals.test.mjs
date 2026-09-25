import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DshSessionEventDecoder } from '../../../packages/adapter-dsh/dist/executor/events.js';
import { serializeSnapshot, snapshotBoundaryHash } from '../../../packages/core/dist/snapshot/capture.js';
import { WorkerProposalCollector } from '../../../packages/core/dist/worker/proposals.js';

const fixture = (group, name) => JSON.parse(readFileSync(new URL(`../../../packages/contracts/fixtures/${group}/${name}.json`, import.meta.url), 'utf8'));
const snapshot = fixture('state', 'snapshot');
const hash = createHash('sha256').update(serializeSnapshot(snapshot)).digest('hex');
const request = { ...fixture('execution', 'request'), snapshotHash: hash };
const result = { ...fixture('execution', 'result-blocked'), snapshotHash: hash, changedFiles: ['src/a.ts'] };
const before = { snapshot, hash, boundaryHash: snapshotBoundaryHash(snapshot), dirtyPaths: snapshot.dirtyPaths, stagedPaths: [] };
const entry = (seq, type, data, extra = {}) => ({ seq, type, data, ...extra });

test('a DSH Session proposal receipt crosses into Core staging and matches declared changes', () => {
  const decoder = new DshSessionEventDecoder();
  const events = [
    entry(0, 'turn/start', { turn: 1 }),
    entry(1, 'tool/call', { turn: 1, step: 1, callId: 'call_1', name: 'dhr_propose_text',
      arguments: JSON.stringify({ path: 'src/a.ts', content: 'HELLO' }) }),
    entry(2, 'tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'call_1',
      content: [{ type: 'text', text: `PROPOSED ${createHash('sha256').update('HELLO').digest('hex')}` }] }] } },
    { sourceEventSeqs: [1] }),
    entry(3, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(result) }] } }),
    entry(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  for (const event of events) decoder.consume(event);
  const bound = decoder.finish(request, { version: 3, id: 'session-5a7765c8-28e3-4a74-8867-194ac73a6cf3',
    cwd: request.repoRoot, isSeeded: false });
  assert.equal(bound.result.outcome, 'blocked');
  const collector = new WorkerProposalCollector(request, before);
  for (const proposal of decoder.proposals()) {
    if (proposal.content === null) collector.delete(proposal.path);
    else collector.write(proposal.path, Buffer.from(proposal.content, 'utf8'));
  }
  collector.assertDeclaredChanges(bound.result);
  assert.deepEqual(collector.list().map(({ path }) => path), ['src/a.ts']);
});

test('a DSH deletion receipt crosses into Core staging without deleting the project file', () => {
  const decoder = new DshSessionEventDecoder();
  const path = 'src/a.ts';
  const events = [
    entry(0, 'turn/start', { turn: 1 }),
    entry(1, 'tool/call', { turn: 1, step: 1, callId: 'delete_1', name: 'dhr_propose_delete',
      arguments: JSON.stringify({ path }) }),
    entry(2, 'tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'delete_1',
      content: [{ type: 'text', text: `PROPOSED_DELETE ${createHash('sha256').update(path).digest('hex')}` }] }] } },
    { sourceEventSeqs: [1] }),
    entry(3, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(result) }] } }),
    entry(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  for (const event of events) decoder.consume(event);
  const bound = decoder.finish(request, { version: 3, id: 'session-5a7765c8-28e3-4a74-8867-194ac73a6cf3',
    cwd: request.repoRoot, isSeeded: false });
  const collector = new WorkerProposalCollector(request, before);
  for (const proposal of decoder.proposals()) {
    if (proposal.content === null) collector.delete(proposal.path);
    else collector.write(proposal.path, Buffer.from(proposal.content, 'utf8'));
  }
  collector.assertDeclaredChanges(bound.result);
  assert.deepEqual(collector.list().map(({ path, content }) => [path, content]), [[path, null]]);
});
