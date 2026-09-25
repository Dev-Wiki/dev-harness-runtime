import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DshSessionEventDecoder } from '../dist/executor/events.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/execution/${name}.json`, import.meta.url), 'utf8'));
const request = fixture('request');
const blocked = fixture('result-blocked');
const sessionId = 'session-5a7765c8-28e3-4a74-8867-194ac73a6cf3';
const header = { version: 3, id: sessionId, cwd: request.repoRoot, isSeeded: false };
const event = (seq, type, data, extra = {}) => ({ seq, type, data, ...extra });
const receipt = `PROPOSED ${createHash('sha256').update('HELLO').digest('hex')}`;

function transcript(result = blocked) {
  return [
    event(0, 'request/header', { header: {} }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }),
    event(3, 'tool/call', { turn: 1, step: 1, callId: 'call_1', name: 'dhr_propose_text',
      arguments: JSON.stringify({ path: 'src/a.ts', content: 'HELLO' }) }),
    event(4, 'tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'call_1',
      content: [{ type: 'text', text: receipt }] }] } }, { sourceEventSeqs: [3] }),
    event(5, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(result) }] } }),
    event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}

function decode(events = transcript()) {
  const decoder = new DshSessionEventDecoder();
  for (const entry of events) decoder.consume(entry);
  return decoder;
}

test('DSH v3 Session binds fresh identity, proposal receipt and structured result', () => {
  const decoder = decode();
  assert.deepEqual(decoder.finish(request, header), { sessionId, result: blocked });
  assert.deepEqual(decoder.proposals(), [{ path: 'src/a.ts', content: 'HELLO' }]);
  const withReasoning = transcript();
  withReasoning[5].data.message.content.unshift({ type: 'reasoning', text: 'Preparing result' });
  assert.deepEqual(decode(withReasoning).finish(request, header).result, blocked);
  const fenced = transcript();
  fenced[5].data.message.content[0].text = `\`\`\`json\n${JSON.stringify(blocked)}\n\`\`\``;
  assert.deepEqual(decode(fenced).finish(request, header).result, blocked);
  fenced[5].data.message.content[0].text += '\nExtra prose';
  assert.throws(() => decode(fenced).finish(request, header), { code: 'INVALID_RESULT' });
  assert.throws(() => decoder.finish(request, { ...header, isSeeded: true }), { code: 'INVALID_RESULT' });
  assert.throws(() => decode(transcript({ ...blocked, requestId: 'other' })).finish(request, header), { code: 'INVALID_RESULT' });
});

test('DSH result submission is receipt-bound and later tool calls are rejected', () => {
  const submitted = transcript();
  const raw = JSON.stringify(blocked);
  submitted[5] = event(5, 'tool/call', { turn: 1, step: 2, callId: 'call_2', name: 'dhr_submit_result',
    arguments: JSON.stringify({ result: raw }) });
  submitted[6] = event(6, 'tool/result', { turn: 1, step: 2,
    message: { content: [{ type: 'tool-result', toolCallId: 'call_2',
      content: [{ type: 'text', text: `SUBMITTED ${createHash('sha256').update(raw).digest('hex')}` }] }] } },
  { sourceEventSeqs: [5] });
  submitted.push(event(7, 'assistant/message', { turn: 1, step: 3,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }));
  submitted.push(event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
  assert.deepEqual(decode(submitted).finish(request, header).result, blocked);
  const badReceipt = structuredClone(submitted);
  badReceipt[6].data.message.content[0].content[0].text = 'SUBMITTED wrong';
  assert.throws(() => decode(badReceipt), { code: 'INVALID_RESULT' });
  const laterCall = structuredClone(submitted);
  laterCall[7] = event(7, 'tool/call', { turn: 1, step: 3, callId: 'call_3', name: 'dhr_identity',
    arguments: '{}' });
  assert.throws(() => decode(laterCall), { code: 'INVALID_RESULT' });
});

test('DSH rejected bridge read may be corrected without accepting an effect', () => {
  const corrected = transcript();
  corrected.splice(3, 0,
    event(3, 'tool/call', { turn: 1, step: 1, callId: 'bad_read', name: 'dhr_read_text',
      arguments: JSON.stringify({ path: '../outside', offset: 0 }) }),
    event(4, 'tool/result', { turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'bad_read', isError: true,
        content: [{ type: 'text', text: 'Error: Read path is unsafe' }] }] } }, { sourceEventSeqs: [3] }));
  for (let index = 5; index < corrected.length; index++) {
    corrected[index].seq += 2;
    if (corrected[index].type === 'tool/result') corrected[index].sourceEventSeqs = [5];
  }
  assert.deepEqual(decode(corrected).proposals(), [{ path: 'src/a.ts', content: 'HELLO' }]);
  const altered = structuredClone(corrected);
  altered[4].data.message.content[0].content[0].text = 'untrusted receipt';
  assert.throws(() => decode(altered), { code: 'INVALID_RESULT' });
});

test('DSH Session decoder rejects foreign tool, altered receipt, gap, incomplete and repeated turns', () => {
  const foreign = transcript(); foreign[3].data.name = 'bash';
  assert.throws(() => decode(foreign), { code: 'AUTHORIZATION_VIOLATION' });
  const altered = transcript(); altered[4].data.message.content[0].content[0].text = 'PROPOSED wrong';
  assert.throws(() => decode(altered), { code: 'INVALID_RESULT' });
  const gap = transcript(); gap[3].seq = 30;
  assert.throws(() => decode(gap), { code: 'INVALID_RESULT' });
  const incomplete = decode(transcript().slice(0, -1));
  assert.throws(() => incomplete.finish(request, header), { code: 'INVALID_RESULT' });
  const repeated = transcript(); repeated.push(event(7, 'turn/start', { turn: 2 }));
  assert.throws(() => decode(repeated), { code: 'INVALID_RESULT' });
  const failed = transcript(); failed[6].data.reason.kind = 'aborted';
  assert.throws(() => decode(failed), { code: 'CAPABILITY_MISSING' });
});

test('DSH Session decodes a deletion receipt and rejects altered deletion arguments or receipt', () => {
  const deleted = transcript();
  deleted[3].data.name = 'dhr_propose_delete';
  deleted[3].data.arguments = JSON.stringify({ path: 'src/a.ts' });
  deleted[4].data.message.content[0].content[0].text = `PROPOSED_DELETE ${createHash('sha256').update('src/a.ts').digest('hex')}`;
  assert.deepEqual(decode(deleted).proposals(), [{ path: 'src/a.ts', content: null }]);
  const extra = structuredClone(deleted);
  extra[3].data.arguments = JSON.stringify({ path: 'src/a.ts', extra: true });
  assert.throws(() => decode(extra), { code: 'INVALID_RESULT' });
  const receipt = structuredClone(deleted);
  receipt[4].data.message.content[0].content[0].text = 'PROPOSED_DELETE wrong';
  assert.throws(() => decode(receipt), { code: 'INVALID_RESULT' });
});
