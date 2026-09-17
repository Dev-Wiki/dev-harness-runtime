import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ContractValidationError, assertSnapshotHash, attemptId, parseContract,
  parseContractJson, requireExecutionCapabilities, validateResultForRequest,
} from '../dist/index.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/execution/${name}.json`, import.meta.url), 'utf8'));
const rejects = (kind, value) => assert.throws(() => parseContract(kind, value), ContractValidationError);
const rejectsCode = (callback, code) => assert.throws(callback, (error) => error instanceof ContractValidationError && error.code === code);
const pairs = [
  ['taskExecutionRequest', 'request'], ['executorCapabilities', 'capabilities'],
  ...['completed', 'blocked', 'failed', 'partial'].map((outcome) => ['taskExecutionResult', `result-${outcome}`]),
];

for (const [kind, name] of pairs) {
  test(`${kind} accepts ${name} fixture and rejects unknown version/fields`, () => {
    const value = fixture(name);
    assert.deepEqual(parseContract(kind, value), value);
    rejects(kind, { ...value, schemaVersion: 2 });
    rejects(kind, { ...value, undeclared: true });
  });
}

test('all result outcomes bind to the request', () => {
  const request = fixture('request');
  for (const outcome of ['completed', 'blocked', 'failed', 'partial']) {
    assert.equal(validateResultForRequest(request, fixture(`result-${outcome}`)).outcome, outcome);
  }
  assert.equal(attemptId(request), 'K1-1');
});

test('request versions, attempts and nested authorization fail closed', () => {
  const request = fixture('request');
  rejects('taskExecutionRequest', fixture('invalid-request-version'));
  rejects('taskExecutionRequest', { ...request, coreProtocolVersion: 2 });
  for (const attempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) rejects('taskExecutionRequest', { ...request, attempt });
  for (const patch of [{ commit: 'task' }, { push: true }, { deploy: true }, { unknown: false }, { runId: 'run-b' }]) {
    rejects('taskExecutionRequest', { ...request, authorization: { ...request.authorization, ...patch } });
  }
});

test('request environment and planning scope bind to the exact execution identity', () => {
  const request = fixture('request');
  for (const patch of [{ DEV_HARNESS_RUN_ID: 'run-b' }, { DEV_HARNESS_TASK_ID: 'K2' }, { DEV_HARNESS_WORKER: '0' }, { API_KEY: 'fixture-not-a-secret' }]) {
    rejects('taskExecutionRequest', { ...request, env: { ...request.env, ...patch } });
  }
  request.scope.planning.taskId = 'K2';
  rejects('taskExecutionRequest', request);
});

test('request absolute paths must agree with the repo/docs roots and relative planning paths', () => {
  const request = fixture('request');
  for (const patch of [{ docsRoot: '/outside/docs' }, { taskPath: '/workspace/project/docs/plan/tasks/K2.md' }, { dashboardPath: '/workspace/project/other/Dashboard.md' }]) {
    rejects('taskExecutionRequest', { ...request, ...patch });
  }
  const windows = structuredClone(request);
  for (const key of ['repoRoot', 'docsRoot', 'taskPath', 'dashboardPath']) windows[key] = `C:${windows[key].replaceAll('/', '\\')}`;
  assert.equal(parseContract('taskExecutionRequest', windows).repoRoot, 'C:\\workspace\\project');
});

test('request scope rejects whole-repository, Git metadata, duplicate and escaping paths', () => {
  for (const directories of [['.'], ['.git'], ['src/../other'], ['src', 'SRC']]) {
    const request = fixture('request');
    request.scope.directories = directories;
    rejects('taskExecutionRequest', request);
  }
  const request = fixture('request');
  request.scope.files.push('src/a.ts');
  rejects('taskExecutionRequest', request);
});

test('verification plan freezes authoritative sources and check identities', () => {
  for (const mutate of [
    (value) => { value.verificationPlan.sources = value.verificationPlan.sources.slice(1); },
    (value) => { value.verificationPlan.sources = value.verificationPlan.sources.slice(0, 1); },
    (value) => { value.verificationPlan.commands = []; value.verificationPlan.manual = []; },
    (value) => { value.verificationPlan.manual[0].id = value.verificationPlan.commands[0].id; },
    (value) => { value.verificationPlan.commands[0].argv = []; },
    (value) => { value.verificationPlan.commands[0].argv = ['bad\0command']; },
  ]) {
    const request = fixture('request');
    mutate(request);
    rejects('taskExecutionRequest', request);
  }
});

test('completed requires passed evidence, closure and no planning expansion', () => {
  rejects('taskExecutionResult', fixture('invalid-result-no-evidence'));
  for (const mutate of [
    (value) => { value.verification = []; },
    (value) => { delete value.closure; },
    (value) => { value.needsPlanning = true; },
    (value) => { value.verification[0].result = 'blocked'; value.verification[0].exitCode = null; },
    (value) => { value.closure.taskId = 'K2'; },
    (value) => { value.changedFiles = ['src/a.ts']; },
    (value) => { value.closure.changes[0].afterHash = 'd'.repeat(64); },
    (value) => { value.closure.changes.push({ ...value.closure.changes[0], path: 'other.md' }); },
  ]) {
    const result = fixture('result-completed');
    mutate(result);
    rejects('taskExecutionResult', result);
  }
});

test('noncompleted results require a reason and cannot introduce commit intent', () => {
  for (const outcome of ['blocked', 'failed', 'partial']) {
    const result = fixture(`result-${outcome}`);
    delete result.reason;
    rejects('taskExecutionResult', result);
    result.reason = 'Expected fixture stop.';
    result.commitIntent = { schemaVersion: 1, message: 'commit', paths: ['src/a.ts'], workflow: { path: 'docs/GIT_WORKFLOW.md', sha256: 'a'.repeat(64) } };
    rejects('taskExecutionResult', result);
  }
  rejects('taskExecutionResult', { ...fixture('result-partial'), outcome: 'cancelled' });
});

test('verification command results, identity, dates and private references are validated', () => {
  const source = fixture('result-completed').verification[0];
  assert.deepEqual(parseContract('verificationEvidence', source), source);
  for (const patch of [{ exitCode: 1 }, { finishedAt: '2026-09-16T00:00:00Z' }, { startedAt: '2026-02-30T00:00:00Z' }, { cwd: '..' }]) {
    rejects('verificationEvidence', { ...source, ...patch });
  }
  rejects('verificationEvidence', { ...source, stdout: { ...source.stdout, path: '../outside.log' } });
  for (const patch of [{ taskId: 'K2' }, { requestId: 'other-request' }, { attempt: 2 }, { runId: 'run-b' }]) {
    const result = fixture('result-completed');
    Object.assign(result.verification[0], patch);
    rejects('taskExecutionResult', result);
  }
  assert.equal(parseContract('verificationEvidence', { ...source, result: 'failed', exitCode: 2 }).result, 'failed');
});

test('result/request binding rejects every tuple component and stale snapshot hash', () => {
  const request = fixture('request');
  for (const patch of [{ runId: 'run-b' }, { taskId: 'K2' }, { attempt: 2 }, { requestId: 'other-request' }, { snapshotHash: 'b'.repeat(64) }]) {
    rejectsCode(() => validateResultForRequest(request, { ...fixture('result-partial'), ...patch }), 'INVALID_RESULT');
  }
});

test('result binding rejects missing checks and changed check commands or acceptance IDs', () => {
  const request = fixture('request');
  for (const mutate of [
    (result) => { result.verification.pop(); },
    (result) => { result.verification[0].argv = ['pnpm', 'unapproved']; },
    (result) => { result.verification[0].cwd = 'src'; },
    (result) => { result.verification[0].acceptanceIds = ['unapproved-acceptance']; },
    (result) => { result.verification[0].id = 'unapproved-check'; },
  ]) {
    const result = fixture('result-completed');
    mutate(result);
    rejectsCode(() => validateResultForRequest(request, result), 'INVALID_RESULT');
  }
});

test('out-of-scope declarations and Worker commitSha are authorization violations', () => {
  const request = fixture('request');
  for (const path of ['src/other.ts', 'src/a.ts-extra', '.git/config']) {
    const result = fixture('result-partial');
    result.changedFiles = [path];
    rejectsCode(() => validateResultForRequest(request, result), 'AUTHORIZATION_VIOLATION');
  }
  const committed = { ...fixture('result-completed'), commitSha: 'c'.repeat(40) };
  rejects('taskExecutionResult', committed);
  rejectsCode(() => validateResultForRequest(request, committed), 'AUTHORIZATION_VIOLATION');
});

test('directory scope uses segment boundaries and commit intent has an exact declared file set', () => {
  const request = fixture('request');
  request.scope.directories = ['lib'];
  const partial = fixture('result-partial');
  partial.changedFiles = ['lib/a.ts'];
  assert.equal(validateResultForRequest(request, partial).changedFiles[0], 'lib/a.ts');
  partial.changedFiles = ['library/a.ts'];
  rejectsCode(() => validateResultForRequest(request, partial), 'AUTHORIZATION_VIOLATION');
  const result = fixture('result-completed');
  result.commitIntent = { schemaVersion: 1, message: 'Complete K1', paths: [...result.changedFiles], workflow: { path: 'docs/GIT_WORKFLOW.md', sha256: 'a'.repeat(64) } };
  assert.equal(validateResultForRequest(request, result).commitIntent.message, 'Complete K1');
  result.commitIntent.paths.pop();
  rejectsCode(() => validateResultForRequest(request, result), 'AUTHORIZATION_VIOLATION');
});

test('missing and malformed results fail with a typed error', () => {
  const request = fixture('request');
  for (const result of [undefined, null, '', {}, { status: 'completed' }]) {
    rejectsCode(() => validateResultForRequest(request, result), 'INVALID_RESULT');
  }
  for (const text of ['', '{', 'null']) rejectsCode(() => parseContractJson('taskExecutionResult', text), 'INVALID_CONTRACT');
});

test('snapshot comparison reports drift without mistaking unchanged status for unchanged bytes', () => {
  assert.doesNotThrow(() => assertSnapshotHash('a'.repeat(64), 'a'.repeat(64)));
  rejectsCode(() => assertSnapshotHash('a'.repeat(64), 'b'.repeat(64)), 'DRIFT_DETECTED');
});

test('capability claims need evidence and automatic execution requires all execution capabilities', () => {
  const capabilities = fixture('capabilities');
  assert.doesNotThrow(() => requireExecutionCapabilities(capabilities));
  rejects('executorCapabilities', { ...capabilities, evidence: [] });
  const packagingUnavailable = { ...capabilities, pluginPackaging: false };
  assert.doesNotThrow(() => requireExecutionCapabilities(packagingUnavailable));
  for (const capability of ['available', 'freshSession', 'structuredOutput', 'nonInteractive', 'cancellation', 'resumeRunWithFreshSession', 'authorizationEnforced']) {
    rejectsCode(() => requireExecutionCapabilities({ ...capabilities, [capability]: false }), 'CAPABILITY_MISSING');
  }
  rejects('executorCapabilities', { ...capabilities, freshSession: false, reasons: [] });
});

test('accepted result is distinct from the Worker result and requires Core acceptance evidence', () => {
  const result = fixture('result-completed');
  const accepted = { ...result, acceptedAt: '2026-09-17T00:02:00Z', acceptedSnapshotHash: 'b'.repeat(64), verifiedEvidenceRefs: [{ schemaVersion: 1, path: 'trusted/verification.json', sha256: 'a'.repeat(64) }], commitSha: 'c'.repeat(64) };
  assert.equal(parseContract('acceptedTaskExecutionResult', accepted).commitSha, accepted.commitSha);
  rejects('taskExecutionResult', accepted);
  rejects('acceptedTaskExecutionResult', { ...accepted, verifiedEvidenceRefs: [] });
});
