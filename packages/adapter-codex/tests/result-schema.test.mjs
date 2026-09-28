import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import test from 'node:test';
import { CODEX_RESULT_SCHEMA, decodeCodexResultEnvelope, withCodexResultSchema } from '../dist/executor/result-schema.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/execution/${name}.json`, import.meta.url), 'utf8'));
const request = fixture('request');
const blocked = fixture('result-blocked');

test('Codex output schema has an object root and makes optional contract fields nullable', () => {
  assert.equal(CODEX_RESULT_SCHEMA.type, 'object');
  assert.deepEqual(CODEX_RESULT_SCHEMA.required, ['result']);
  assert.equal(CODEX_RESULT_SCHEMA.additionalProperties, false);
  const outcomes = CODEX_RESULT_SCHEMA.properties.result.anyOf;
  assert.equal(outcomes.length, 2);
  for (const branch of outcomes) {
    assert.deepEqual(branch.required, Object.keys(branch.properties));
    assert.equal(branch.additionalProperties, false);
    assert.ok(branch.properties.rawResultRef.anyOf.some((option) => option.type === 'null'));
  }
  const json = JSON.stringify(CODEX_RESULT_SCHEMA);
  assert.ok(!json.includes('"format"'));
  assert.ok(!json.includes('"uniqueItems"'));
  assert.ok(!json.includes('"const"'));
});

test('Codex envelope removes only optional nulls before validating the exact Core request', () => {
  assert.deepEqual(decodeCodexResultEnvelope({ result: { ...blocked, rawResultRef: null, closure: null } }, request), blocked);
  assert.throws(() => decodeCodexResultEnvelope(blocked, request));
  assert.throws(() => decodeCodexResultEnvelope({ result: { ...blocked, requestId: 'other', rawResultRef: null, closure: null } }, request),
    { code: 'INVALID_RESULT' });
  assert.throws(() => decodeCodexResultEnvelope({ result: { ...blocked, summary: null, rawResultRef: null, closure: null } }, request),
    { code: 'INVALID_RESULT' });
});

test('Codex output schema is private during one invocation and removed afterward', async () => {
  let savedPath;
  await withCodexResultSchema(async (path) => {
    savedPath = path;
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), CODEX_RESULT_SCHEMA);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o077, 0);
  });
  assert.equal(existsSync(savedPath), false);
  await assert.rejects(withCodexResultSchema(async () => { throw new Error('failed invocation'); }), /failed invocation/u);
});
