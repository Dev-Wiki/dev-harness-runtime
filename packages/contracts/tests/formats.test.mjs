import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isRepoPath, isAbsolutePath, parseContract, parseContractJson, ContractValidationError } from '../dist/index.js';
const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/packaging/artifact.json', import.meta.url), 'utf8'));
test('portable relative paths reject traversal, drive paths, aliases and Windows reserved names', () => {
  for (const path of ['', '/', '/x', '../x', 'a/../b', 'a//b', './a', 'a/', 'C:/a', 'a\\b', 'a\0b', 'a\nb', 'a.', 'a ', 'aux.txt', 'x/COM1']) assert.equal(isRepoPath(path), false, path);
  for (const path of ['src/a.ts', '资料/说明.md', '.agents/skills/a.md']) assert.equal(isRepoPath(path), true, path);
});
test('absolute execution paths support POSIX and Windows without accepting dot segments or NUL', () => {
  for (const path of ['/repo', 'C:\\work\\repo', '\\\\server\\share\\repo']) assert.equal(isAbsolutePath(path), true, path);
  for (const path of ['repo', 'C:repo', '\\repo', '\\\\server', '/repo/../x', 'C:\\repo\\.\\x', '/x\0']) assert.equal(isAbsolutePath(path), false, path);
});
test('strict parsing rejects unsupported versions, coercion and extra authorization fields without mutating input', () => {
  const value = fixture(); value.size = '10';
  const before = structuredClone(value);
  assert.throws(() => parseContract('artifact', value), ContractValidationError);
  assert.deepEqual(value, before);
  for (const version of ['01.2.3', '1.2', '1.2.3-01', 'latest', 'v1.2.3']) assert.throws(() => parseContract('artifact', { ...fixture(), version }), ContractValidationError);
  for (const version of ['0.1.0', '1.2.3-rc.1', '1.2.3+build.10']) assert.equal(parseContract('artifact', { ...fixture(), version }).version, version);
});
test('malformed, empty and null JSON fail the public parser', () => {
  for (const json of ['', '{', 'null', '[]']) assert.throws(() => parseContractJson('artifact', json), ContractValidationError);
  assert.deepEqual(parseContractJson('artifact', JSON.stringify(fixture())), fixture());
});
