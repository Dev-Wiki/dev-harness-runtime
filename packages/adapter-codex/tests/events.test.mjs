import assert from 'node:assert/strict';
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
