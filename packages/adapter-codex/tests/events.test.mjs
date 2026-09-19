import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CodexEventDecoder } from '../dist/executor/events.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/execution/${name}.json`, import.meta.url), 'utf8'));
const request = fixture('request');
const blocked = fixture('result-blocked');
const threadId = '01a0b024-276e-7811-905c-688e5b2e97f2';
const event = (type, extra = {}) => JSON.stringify({ type, ...extra });

function stream(result = blocked) {
  const decoder = new CodexEventDecoder();
  decoder.consume(event('thread.started', { thread_id: threadId }));
  decoder.consume(event('turn.started'));
  decoder.consume(event('item.completed', { item: { type: 'agent_message', text: 'working' } }));
  decoder.consume(event('item.completed', { item: { type: 'agent_message', text: JSON.stringify(result) } }));
  decoder.consume(event('turn.completed'));
  return decoder;
}

test('Codex events bind one fresh thread and the final structured result to the Core request', () => {
  assert.deepEqual(stream().finish(request), { threadId, result: blocked });
  assert.throws(() => stream({ ...blocked, requestId: 'other' }).finish(request), { code: 'INVALID_RESULT' });
  assert.throws(() => stream({ ...blocked, commitSha: 'a'.repeat(40) }).finish(request), { code: 'AUTHORIZATION_VIOLATION' });
});

test('Codex event decoder rejects missing, repeated, failed, malformed and trailing events', () => {
  assert.throws(() => new CodexEventDecoder().finish(request), { code: 'INVALID_RESULT' });
  assert.throws(() => new CodexEventDecoder().consume(event('turn.started')), { code: 'INVALID_RESULT' });
  assert.throws(() => new CodexEventDecoder().consume('not json'), { code: 'INVALID_RESULT' });
  const repeated = new CodexEventDecoder();
  repeated.consume(event('thread.started', { thread_id: threadId }));
  assert.throws(() => repeated.consume(event('thread.started', { thread_id: threadId })), { code: 'INVALID_RESULT' });
  assert.throws(() => repeated.consume(event('turn.failed')), { code: 'INVALID_RESULT' });
  const duplicateTurn = new CodexEventDecoder();
  duplicateTurn.consume(event('thread.started', { thread_id: threadId }));
  duplicateTurn.consume(event('turn.started'));
  assert.throws(() => duplicateTurn.consume(event('turn.started')), { code: 'INVALID_RESULT' });
  const noTurn = new CodexEventDecoder();
  noTurn.consume(event('thread.started', { thread_id: threadId }));
  assert.throws(() => noTurn.consume(event('item.completed', { item: { type: 'agent_message', text: JSON.stringify(blocked) } })), { code: 'INVALID_RESULT' });
  const failed = new CodexEventDecoder();
  failed.consume(event('thread.started', { thread_id: threadId }));
  assert.throws(() => failed.consume(event('turn.failed')), { code: 'CAPABILITY_MISSING' });
  assert.throws(() => stream().consume(event('turn.completed')), { code: 'INVALID_RESULT' });
  const incomplete = new CodexEventDecoder();
  incomplete.consume(event('thread.started', { thread_id: threadId }));
  incomplete.consume(event('turn.started'));
  incomplete.consume(event('item.completed', { item: { type: 'agent_message', text: 'not json' } }));
  incomplete.consume(event('turn.completed'));
  assert.throws(() => incomplete.finish(request), { code: 'INVALID_RESULT' });
});

test('Codex proposal receipts must match one completed MCP call before staging', () => {
  const proposal = { id: 'item_3', type: 'mcp_tool_call', server: 'dhr_proposal', tool: 'dhr_propose_text',
    arguments: { path: 'src/a.ts', content: 'HELLO' } };
  const receipt = { content: [{ type: 'text', text: `PROPOSED ${createHash('sha256').update('HELLO').digest('hex')}` }] };
  const decoder = new CodexEventDecoder();
  decoder.consume(event('thread.started', { thread_id: threadId }));
  decoder.consume(event('turn.started'));
  decoder.consume(event('item.started', { item: { ...proposal, result: null, error: null, status: 'in_progress' } }));
  decoder.consume(event('item.completed', { item: { ...proposal, result: receipt, error: null, status: 'completed' } }));
  decoder.consume(event('item.completed', { item: { type: 'agent_message', text: JSON.stringify(blocked) } }));
  decoder.consume(event('turn.completed'));
  assert.deepEqual(decoder.finish(request).result, blocked);
  assert.deepEqual(decoder.proposals(), [{ path: 'src/a.ts', content: 'HELLO' }]);

  const bad = new CodexEventDecoder();
  bad.consume(event('thread.started', { thread_id: threadId })); bad.consume(event('turn.started'));
  bad.consume(event('item.started', { item: proposal }));
  assert.throws(() => bad.consume(event('item.completed', { item: { ...proposal, result: { content: [{ type: 'text', text: 'PROPOSED wrong' }] }, error: null, status: 'completed' } })), { code: 'INVALID_RESULT' });
  const foreign = new CodexEventDecoder();
  foreign.consume(event('thread.started', { thread_id: threadId })); foreign.consume(event('turn.started'));
  assert.throws(() => foreign.consume(event('item.started', { item: { ...proposal, server: 'other' } })), { code: 'AUTHORIZATION_VIOLATION' });
});

test('Codex decoder rejects native tools and unknown event kinds before a result can be accepted', () => {
  for (const type of ['command_execution', 'file_change', 'web_search']) {
    const decoder = new CodexEventDecoder();
    decoder.consume(event('thread.started', { thread_id: threadId })); decoder.consume(event('turn.started'));
    assert.throws(() => decoder.consume(event('item.started', { item: { id: 'item_2', type } })), { code: 'AUTHORIZATION_VIOLATION' });
    assert.throws(() => decoder.finish(request), { code: 'INVALID_RESULT' });
  }
  const updated = new CodexEventDecoder();
  updated.consume(event('thread.started', { thread_id: threadId })); updated.consume(event('turn.started'));
  assert.throws(() => updated.consume(event('item.updated', { item: { id: 'item_2', type: 'command_execution' } })), { code: 'INVALID_RESULT' });
});

test('Codex delete proposal requires a matching path receipt', () => {
  const item = { id: 'item_4', type: 'mcp_tool_call', server: 'dhr_proposal', tool: 'dhr_propose_delete',
    arguments: { path: 'src/a.ts' } };
  const decoder = new CodexEventDecoder();
  decoder.consume(event('thread.started', { thread_id: threadId })); decoder.consume(event('turn.started'));
  decoder.consume(event('item.started', { item: { ...item, status: 'in_progress', error: null, result: null } }));
  decoder.consume(event('item.completed', { item: { ...item, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: `PROPOSED_DELETE ${createHash('sha256').update('src/a.ts').digest('hex')}` }] } } }));
  decoder.consume(event('item.completed', { item: { type: 'agent_message', text: JSON.stringify(blocked) } }));
  decoder.consume(event('turn.completed'));
  assert.deepEqual(decoder.proposals(), [{ path: 'src/a.ts', content: null }]);
  const bad = new CodexEventDecoder();
  bad.consume(event('thread.started', { thread_id: threadId })); bad.consume(event('turn.started'));
  bad.consume(event('item.started', { item }));
  assert.throws(() => bad.consume(event('item.completed', { item: { ...item, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: 'PROPOSED_DELETE wrong' }] } } })), { code: 'INVALID_RESULT' });
});

test('Codex read and list calls require paired bounded receipts', () => {
  const decoder = new CodexEventDecoder();
  decoder.consume(event('thread.started', { thread_id: threadId })); decoder.consume(event('turn.started'));
  const list = { id: 'item_5', type: 'mcp_tool_call', server: 'dhr_proposal', tool: 'dhr_list_paths',
    arguments: { prefix: 'src', after: '' } };
  decoder.consume(event('item.started', { item: list }));
  decoder.consume(event('item.completed', { item: { ...list, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: JSON.stringify({ paths: ['src/a.ts'], next: null }) }] } } }));
  const read = { id: 'item_6', type: 'mcp_tool_call', server: 'dhr_proposal', tool: 'dhr_read_text',
    arguments: { path: 'src/a.ts', offset: 0 } };
  decoder.consume(event('item.started', { item: read }));
  decoder.consume(event('item.completed', { item: { ...read, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: JSON.stringify({ path: 'src/a.ts', content: 'HELLO',
      sha256: createHash('sha256').update('HELLO').digest('hex'), offset: 0, nextOffset: null }) }] } } }));
  decoder.consume(event('item.completed', { item: { type: 'agent_message', text: JSON.stringify(blocked) } }));
  decoder.consume(event('turn.completed'));
  assert.deepEqual(decoder.proposals(), []);
  assert.equal(decoder.finish(request).result.outcome, 'blocked');

  const bad = new CodexEventDecoder();
  bad.consume(event('thread.started', { thread_id: threadId })); bad.consume(event('turn.started'));
  bad.consume(event('item.started', { item: read }));
  assert.throws(() => bad.consume(event('item.completed', { item: { ...read, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: JSON.stringify({ path: '../outside', content: 'NO',
      sha256: 'a'.repeat(64), offset: 0, nextOffset: null }) }] } } })), { code: 'INVALID_RESULT' });
});

test('Codex accepts only an exact missing-file receipt for a new frozen path', () => {
  const call = { id: 'item_missing', type: 'mcp_tool_call', server: 'dhr_proposal', tool: 'dhr_read_text',
    arguments: { path: 'src/new.ts', offset: 0 } };
  const receipt = { content: [{ type: 'text', text: JSON.stringify({ path: 'src/new.ts', missing: true }) }] };
  const decoder = new CodexEventDecoder();
  decoder.consume(event('thread.started', { thread_id: threadId })); decoder.consume(event('turn.started'));
  decoder.consume(event('item.started', { item: call }));
  decoder.consume(event('item.completed', { item: { ...call, status: 'completed', error: null, result: receipt } }));
  decoder.consume(event('item.completed', { item: { type: 'agent_message', text: JSON.stringify(blocked) } }));
  decoder.consume(event('turn.completed'));
  assert.equal(decoder.finish(request).result.outcome, 'blocked');

  for (const invalid of [{ path: 'src/new.ts', missing: false }, { path: '../outside', missing: true },
    { path: 'src/new.ts', missing: true, content: '' }]) {
    const bad = new CodexEventDecoder();
    bad.consume(event('thread.started', { thread_id: threadId })); bad.consume(event('turn.started'));
    bad.consume(event('item.started', { item: call }));
    assert.throws(() => bad.consume(event('item.completed', { item: { ...call, status: 'completed', error: null,
      result: { content: [{ type: 'text', text: JSON.stringify(invalid) }] } } })), { code: 'INVALID_RESULT' });
  }
});

test('Codex identity receipt is exact, single-use and bound to the Core request', () => {
  const call = { id: 'item_identity', type: 'mcp_tool_call', server: 'dhr_proposal', tool: 'dhr_identity', arguments: {} };
  const identity = { schemaVersion: 1, runId: request.runId, taskId: request.taskId, attempt: request.attempt,
    requestId: request.requestId, snapshotHash: request.snapshotHash, env: request.env };
  const receipt = { content: [{ type: 'text', text: JSON.stringify(identity) }] };
  const decoder = new CodexEventDecoder();
  decoder.consume(event('thread.started', { thread_id: threadId })); decoder.consume(event('turn.started'));
  decoder.consume(event('item.started', { item: call }));
  decoder.consume(event('item.completed', { item: { ...call, status: 'completed', error: null, result: receipt } }));
  decoder.consume(event('item.completed', { item: { type: 'agent_message', text: JSON.stringify(blocked) } }));
  decoder.consume(event('turn.completed'));
  assert.equal(decoder.finish(request).result.outcome, 'blocked');

  const mismatched = new CodexEventDecoder();
  mismatched.consume(event('thread.started', { thread_id: threadId })); mismatched.consume(event('turn.started'));
  mismatched.consume(event('item.started', { item: call }));
  mismatched.consume(event('item.completed', { item: { ...call, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: JSON.stringify({ ...identity, requestId: 'other' }) }] } } }));
  mismatched.consume(event('item.completed', { item: { type: 'agent_message', text: JSON.stringify(blocked) } }));
  mismatched.consume(event('turn.completed'));
  assert.throws(() => mismatched.finish(request), { code: 'AUTHORIZATION_VIOLATION' });

  const repeated = new CodexEventDecoder();
  repeated.consume(event('thread.started', { thread_id: threadId })); repeated.consume(event('turn.started'));
  repeated.consume(event('item.started', { item: call }));
  repeated.consume(event('item.completed', { item: { ...call, status: 'completed', error: null, result: receipt } }));
  const second = { ...call, id: 'item_identity_2' };
  repeated.consume(event('item.started', { item: second }));
  assert.throws(() => repeated.consume(event('item.completed', { item: { ...second, status: 'completed', error: null,
    result: receipt } })), { code: 'INVALID_RESULT' });
});

test('Codex literal search requires a paired bounded receipt', () => {
  const call = { id: 'item_7', type: 'mcp_tool_call', server: 'dhr_proposal', tool: 'dhr_search_text',
    arguments: { query: 'ELL', prefix: 'src', after: '' } };
  const data = { matches: [{ path: 'src/a.ts', line: 1, column: 2, excerpt: 'HELLO' }], skipped: [], next: null };
  const decoder = new CodexEventDecoder();
  decoder.consume(event('thread.started', { thread_id: threadId })); decoder.consume(event('turn.started'));
  decoder.consume(event('item.started', { item: call }));
  decoder.consume(event('item.completed', { item: { ...call, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: JSON.stringify(data) }] } } }));
  decoder.consume(event('item.completed', { item: { type: 'agent_message', text: JSON.stringify(blocked) } }));
  decoder.consume(event('turn.completed'));
  assert.equal(decoder.finish(request).result.outcome, 'blocked');

  const bad = new CodexEventDecoder();
  bad.consume(event('thread.started', { thread_id: threadId })); bad.consume(event('turn.started'));
  bad.consume(event('item.started', { item: call }));
  assert.throws(() => bad.consume(event('item.completed', { item: { ...call, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: JSON.stringify({ ...data,
      matches: [{ ...data.matches[0], excerpt: 'unrelated' }] }) }] } } })), { code: 'INVALID_RESULT' });
});
