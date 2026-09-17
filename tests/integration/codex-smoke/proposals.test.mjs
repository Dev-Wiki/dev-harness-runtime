import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CodexEventDecoder } from '../../../packages/adapter-codex/dist/executor/events.js';
import { serializeSnapshot } from '../../../packages/core/dist/snapshot/capture.js';
import { WorkerProposalCollector } from '../../../packages/core/dist/worker/proposals.js';

const fixture = (group, name) => JSON.parse(readFileSync(new URL(`../../../packages/contracts/fixtures/${group}/${name}.json`, import.meta.url), 'utf8'));
const snapshot = fixture('state', 'snapshot');
const hash = createHash('sha256').update(serializeSnapshot(snapshot)).digest('hex');
const request = { ...fixture('execution', 'request'), snapshotHash: hash };
const result = { ...fixture('execution', 'result-blocked'), snapshotHash: hash };
const before = { snapshot, hash, boundaryHash: 'a'.repeat(64), dirtyPaths: snapshot.dirtyPaths, stagedPaths: [] };
const line = (type, item) => JSON.stringify({ type, ...(item ? { item } : {}) });

test('a Codex MCP receipt crosses into Core staging without modifying the project', () => {
  const decoder = new CodexEventDecoder();
  decoder.consume(JSON.stringify({ type: 'thread.started', thread_id: '01a0b038-2652-7b22-b53d-c8d197dfb1a8' }));
  decoder.consume(line('turn.started'));
  const item = { id: 'item_0', type: 'mcp_tool_call', server: 'dhr_proposal', tool: 'dhr_propose_text',
    arguments: { path: 'src/a.ts', content: 'HELLO' } };
  decoder.consume(line('item.started', { ...item, status: 'in_progress', error: null, result: null }));
  decoder.consume(line('item.completed', { ...item, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: `PROPOSED ${createHash('sha256').update('HELLO').digest('hex')}` }] } }));
  decoder.consume(line('item.completed', { type: 'agent_message', text: JSON.stringify(result) }));
  decoder.consume(line('turn.completed'));
  assert.equal(decoder.finish(request).result.outcome, 'blocked');
  const collector = new WorkerProposalCollector(request, before);
  for (const proposal of decoder.proposals()) collector.write(proposal.path, Buffer.from(proposal.content, 'utf8'));
  assert.deepEqual(collector.list().map(({ path }) => path), ['src/a.ts']);
  assert.equal(collector.list()[0].beforeHash, 'a'.repeat(64));
});
