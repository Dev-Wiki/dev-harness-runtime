import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runCodexProcess } from '../dist/executor/process.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/execution/${name}.json`, import.meta.url), 'utf8'));
const request = fixture('request');
const result = fixture('result-blocked');
const threadId = '01a0b038-2652-7b22-b53d-c8d197dfb1a8';
const events = Buffer.from([
  { type: 'thread.started', thread_id: threadId }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ result: {
    ...result, rawResultRef: null, closure: null,
  } }) } },
  { type: 'turn.completed' },
].map((event) => JSON.stringify(event)).join('\n') + '\n');
const base = (script, log, signal = new AbortController().signal) => ({
  binary: process.execPath, argv: ['-e', script], cwd: process.cwd(), env: {}, request, log, signal,
});

test('Codex process transport delivers a result only after exact logs and a clean exit', async () => {
  const logs = { events: [], stderr: [] };
  const script = `process.stderr.write('diagnostic\\n'); process.stdout.write(Buffer.from(${JSON.stringify(events.toString('base64'))}, 'base64'));`;
  const output = await runCodexProcess(base(script, async (stream, bytes) => { logs[stream].push(Buffer.from(bytes)); }));
  assert.deepEqual(output, { threadId, result, proposals: [] });
  assert.deepEqual(Buffer.concat(logs.events), events);
  assert.equal(Buffer.concat(logs.stderr).toString(), 'diagnostic\n');
});

test('Codex process transport rejects nonzero exit and failed evidence persistence', async () => {
  const script = `process.stdout.write(Buffer.from(${JSON.stringify(events.toString('base64'))}, 'base64')); process.exitCode = 7;`;
  await assert.rejects(runCodexProcess(base(script, async () => {})), { code: 'EXECUTION_FAILED' });
  await assert.rejects(runCodexProcess(base(script, async () => { throw new Error('evidence unavailable'); })), /evidence unavailable/u);
});

test('Codex process transport refuses a direct result outside its structured envelope', async () => {
  const direct = Buffer.from([
    { type: 'thread.started', thread_id: threadId }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } },
    { type: 'turn.completed' },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');
  const script = `process.stdout.write(Buffer.from(${JSON.stringify(direct.toString('base64'))}, 'base64'));`;
  await assert.rejects(runCodexProcess(base(script, async () => {})), { code: 'INVALID_RESULT' });
});

test('Codex cancellation does not claim whole-tree quiescence', async () => {
  const controller = new AbortController();
  const running = runCodexProcess(base('setInterval(() => {}, 1000);', async () => {}, controller.signal));
  controller.abort();
  await assert.rejects(running, { code: 'QUIESCENCE_UNKNOWN' });
});
