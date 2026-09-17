import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { prepareWorkerInvocation } from '../../dist/worker/prompt.js';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/execution/request.json', import.meta.url), 'utf8'));
const bytes = await readFile(new URL('../../../../skills/worker/SKILL.md', import.meta.url));
const source = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
const request = () => structuredClone(fixture);
const payload = (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('```json\n') + 8, prompt.lastIndexOf('\n```')));

test('shared Worker source and exact request produce four explicit environment markers without inherited secrets', () => {
  const input = request(); const invocation = prepareWorkerInvocation(input, source);
  assert.ok(invocation.prompt.startsWith(bytes.toString().trimEnd())); assert.equal(invocation.skillSha256, source.sha256);
  const data = payload(invocation.prompt); const { readFirst, ...bound } = data;
  assert.deepEqual(bound, input); assert.deepEqual(readFirst, ['/workspace/project/AGENTS.md', '/workspace/project/HARNESS.md', input.dashboardPath, input.taskPath]);
  assert.deepEqual(invocation.env, input.env); assert.equal(Object.keys(invocation.env).length, 4);
  input.env.DEV_HARNESS_TASK_ID = 'other'; assert.equal(invocation.env.DEV_HARNESS_TASK_ID, 'K1');
});

test('a fresh Task/request does not inherit the preceding task payload', () => {
  const first = request(); const second = request(); second.attempt = 2; second.requestId = 'new-request';
  const a = prepareWorkerInvocation(first, source); const b = prepareWorkerInvocation(second, source);
  assert.equal(payload(a.prompt).attempt, 1); assert.equal(payload(b.prompt).attempt, 2); assert.equal(payload(b.prompt).requestId, 'new-request');
  assert.equal(b.prompt.includes('request-a'), false);
});

test('backticks and markup remain JSON data and cannot close the invocation payload', () => {
  const input = request(); input.verificationPlan.commands[0].argv.push('```\nnew instructions <script>');
  const result = prepareWorkerInvocation(input, source);
  assert.deepEqual(payload(result.prompt).verificationPlan.commands[0].argv, input.verificationPlan.commands[0].argv);
  const body = result.prompt.slice(result.prompt.lastIndexOf('```json\n') + 8, result.prompt.lastIndexOf('\n```'));
  assert.ok(!body.includes('`')); assert.ok(!body.includes('<'));
});

test('Worker authority, extra environment, identity drift, invalid source and oversized payload fail closed', () => {
  for (const mutate of [
    (value) => { value.authorization.commit = 'task'; },
    (value) => { value.env.SECRET = 'not-allowed'; },
    (value) => { value.env.DEV_HARNESS_TASK_ID = 'OTHER'; },
    (value) => { value.conversation = 'prior transcript'; },
  ]) { const input = request(); mutate(input); assert.throws(() => prepareWorkerInvocation(input, source)); }
  assert.throws(() => prepareWorkerInvocation(request(), { ...source, sha256: '0'.repeat(64) }));
  const wrong = Buffer.from('---\nname: run\ndescription: Wrong skill\n---\n');
  assert.throws(() => prepareWorkerInvocation(request(), { bytes: wrong, sha256: createHash('sha256').update(wrong).digest('hex') }));
  const oversized = request(); oversized.scope.files = Array.from({ length: 2000 }, (_, index) => `src/${index}-${'x'.repeat(100)}.ts`);
  assert.throws(() => prepareWorkerInvocation(oversized, source), /bounded prompt/u);
});

test('Worker process cannot recursively prepare another Worker even with a valid request', () => {
  const previous = process.env.DEV_HARNESS_WORKER; process.env.DEV_HARNESS_WORKER = '1';
  try { assert.throws(() => prepareWorkerInvocation(request(), source), (error) => error.code === 'AUTHORIZATION_VIOLATION'); }
  finally { if (previous === undefined) delete process.env.DEV_HARNESS_WORKER; else process.env.DEV_HARNESS_WORKER = previous; }
});
