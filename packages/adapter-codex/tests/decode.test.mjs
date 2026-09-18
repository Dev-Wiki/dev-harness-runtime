import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeCodexExecution } from '../dist/executor/decode.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/execution/${name}.json`, import.meta.url), 'utf8'));
const request = fixture('request');
const result = fixture('result-blocked');
const threadId = '01a0b038-2652-7b22-b53d-c8d197dfb1a8';
const bytes = Buffer.from([
  { type: 'thread.started', thread_id: threadId },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } },
  { type: 'turn.completed' },
].map((event) => JSON.stringify(event)).join('\n') + '\n');

test('Codex JSONL stream tolerates arbitrary byte chunks and retains exact evidence bytes', async () => {
  async function* events() { for (let offset = 0; offset < bytes.length; offset += 7) yield bytes.subarray(offset, offset + 7); }
  const logged = [];
  const decoded = await decodeCodexExecution({ events: events(), request,
    async log(chunk) { logged.push(Buffer.from(chunk)); } });
  assert.deepEqual(decoded, { threadId, result, proposals: [] });
  assert.deepEqual(Buffer.concat(logged), bytes);
});

test('Codex decoding fails before result delivery when evidence persistence or UTF-8 fails', async () => {
  async function* valid() { yield bytes; }
  await assert.rejects(decodeCodexExecution({ events: valid(), request,
    async log() { throw new Error('evidence sink closed'); } }), /evidence sink closed/u);
  async function* invalid() { yield Buffer.from([0xff]); }
  await assert.rejects(decodeCodexExecution({ events: invalid(), request, async log() {} }), { code: 'INVALID_RESULT' });
});
