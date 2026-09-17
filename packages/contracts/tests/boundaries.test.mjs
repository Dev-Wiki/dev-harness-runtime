import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseContract, validateResultForRequest, ContractValidationError } from '../dist/index.js';
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/execution/${name}.json`, import.meta.url), 'utf8'));
test('verification output declarations cannot authorize Git metadata, Planning, baseline or source writes', () => {
  for (const path of ['.git/HEAD', 'HARNESS.md', 'AGENTS.md', 'docs/plan/Dashboard.md', 'docs/plan/tasks/Other.md', 'src/a.ts']) {
    const request = fixture('request'); request.verificationPlan.commands[0].writableArtifacts = [path];
    assert.throws(() => parseContract('taskExecutionRequest', request), ContractValidationError, path);
  }
});
test('a broad docs scope cannot authorize another Planning Task', () => {
  const request = fixture('request'); request.scope.directories = ['docs'];
  const result = fixture('result-partial'); result.changedFiles.push('docs/plan/tasks/Other.md');
  assert.throws(() => validateResultForRequest(request, result), { code: 'AUTHORIZATION_VIOLATION' });
});
test('partial closure remains bound to the current Task', () => {
  const request = fixture('request'); const result = fixture('result-partial');
  result.closure = fixture('result-completed').closure;
  result.closure.archivePath = 'docs/plan/archive/V1/Other.md';
  assert.throws(() => validateResultForRequest(request, result), { code: 'INVALID_RESULT' });
});
test('common protocol source rejects duplicate and case-aliased files', () => {
  const source = fixture('request').protocolSource;
  source.files.push({ ...source.files[0], path: source.files[0].path.toUpperCase() });
  assert.throws(() => parseContract('protocolSource', source), ContractValidationError);
  const request = fixture('request'); request.protocolSource = source;
  assert.throws(() => parseContract('taskExecutionRequest', request), ContractValidationError);
});

test('scope rejects case aliases across code and Planning authorization', () => {
  const request = fixture('request');
  request.scope.files.push(request.scope.planning.taskPath.toUpperCase());
  assert.throws(() => parseContract('taskExecutionRequest', request), ContractValidationError);
});
