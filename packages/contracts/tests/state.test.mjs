import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ContractValidationError, parseContract } from '../dist/index.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/state/${name}.json`, import.meta.url), 'utf8'));
const rejects = (kind, value) => assert.throws(() => parseContract(kind, value), ContractValidationError);
const validFixtures = [
  ['snapshot', 'snapshot'],
  ['runState', 'run-created'],
  ['runState', 'run-execute'],
  ['runState', 'run-verify'],
  ['runState', 'run-commit'],
  ['runState', 'run-reconciled'],
  ['lockMetadata', 'lock-metadata'],
  ['reconciliationResolution', 'reconciliation-resolution'],
];

for (const [kind, name] of validFixtures) {
  test(`${kind} accepts ${name} fixture`, () => {
    const value = fixture(name);
    assert.deepEqual(parseContract(kind, value), value);
  });
  test(`${kind}/${name} rejects unknown versions and fields`, () => {
    const value = fixture(name);
    rejects(kind, { ...value, schemaVersion: 5 });
    rejects(kind, { ...value, undeclared: true });
  });
}

test('Run states and phases use the canonical vocabulary', () => {
  const state = fixture('run-created');
  for (const status of ['CREATED', 'RUNNING', 'BLOCKED', 'INTERRUPTED', 'FAILED', 'COMPLETED']) {
    const value = { ...state, status };
    if (['BLOCKED', 'INTERRUPTED', 'FAILED'].includes(status)) {
      value.stopReason = { code: 'NO_READY_TASK', message: 'No eligible task is available.' };
    }
    assert.equal(parseContract('runState', value).status, status);
  }
  for (const phase of ['DISCOVERY', 'SELECT', 'SNAPSHOT', 'EXECUTE', 'REVALIDATE', 'FINALIZE']) {
    assert.equal(parseContract('runState', { ...state, phase }).phase, phase);
  }
  rejects('runState', { ...state, status: 'completed' });
  rejects('runState', { ...state, phase: 'VERIFY' });
  rejects('runState', { ...state, status: 'BLOCKED' });
});

test('revision and attempt have distinct safe integer bounds', () => {
  const state = fixture('run-execute');
  for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseContract('runState', { ...state, revision }).revision, revision);
  }
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    rejects('runState', { ...state, revision });
  }
  for (const attempt of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const value = structuredClone(state);
    value.currentAttempt = attempt;
    value.pendingOperation.identity.attempt = attempt;
    rejects('runState', value);
  }
});

test('current attempt is complete or absent and pending identity matches every component', () => {
  const state = fixture('run-execute');
  for (const property of ['currentTaskId', 'currentAttempt', 'currentRequestId']) {
    const value = structuredClone(state);
    delete value[property];
    rejects('runState', value);
  }
  for (const [property, replacement] of [['runId', 'other-run'], ['taskId', 'K2'], ['attempt', 2], ['requestId', 'other-request']]) {
    const value = structuredClone(state);
    value.pendingOperation.identity[property] = replacement;
    rejects('runState', value);
  }
  const otherTaskScope = structuredClone(state);
  otherTaskScope.pendingOperation.scope.planning.taskId = 'K2';
  rejects('runState', otherTaskScope);
});

test('authorization is bound to the Run and commit intent requires task authorization', () => {
  const state = fixture('run-commit');
  for (const mutation of [{ runId: 'other-run' }, { commit: 'deny' }, { push: true }, { commit: 'all' }]) {
    rejects('runState', { ...state, authorization: { ...state.authorization, ...mutation } });
  }
  const missingCommitTree = structuredClone(state);
  delete missingCommitTree.pendingOperation.expectedTree;
  rejects('runState', missingCommitTree);
  const emptyPaths = structuredClone(state);
  emptyPaths.pendingOperation.paths = [];
  rejects('runState', emptyPaths);
  const duplicatePaths = structuredClone(state);
  duplicatePaths.pendingOperation.paths.push(duplicatePaths.pendingOperation.paths[0]);
  rejects('runState', duplicatePaths);
});

test('COMPLETED cannot retain a pending operation or duplicate accepted tasks', () => {
  rejects('runState', { ...fixture('run-execute'), status: 'COMPLETED' });
  rejects('runState', { ...fixture('run-created'), completedTasks: ['K1', 'K1'] });
});

test('Run timestamps are real UTC timestamps in chronological order', () => {
  const state = fixture('run-execute');
  rejects('runState', { ...state, updatedAt: '2026-09-16T00:00:00Z' });
  rejects('runState', { ...state, updatedAt: '2026-02-30T00:00:00Z' });
  rejects('runState', { ...state, updatedAt: '2026-09-17T08:00:00+08:00' });
  const futureOperation = structuredClone(state);
  futureOperation.pendingOperation.createdAt = '2026-09-18T00:00:00Z';
  rejects('runState', futureOperation);
});

test('initial user changes and accepted boundaries remain separately identified', () => {
  const state = fixture('run-created');
  state.completedTasks = ['K1'];
  state.acceptedSnapshotHash = 'c'.repeat(64);
  state.acceptedSnapshotRef.sha256 = state.acceptedSnapshotHash;
  const parsed = parseContract('runState', state);
  assert.notEqual(parsed.initialUserChangesHash, parsed.acceptedSnapshotHash);
  for (const field of ['initialUserChangesHash', 'acceptedSnapshotHash']) {
    rejects('runState', { ...state, [field]: 'd'.repeat(64) });
  }
  const pending = fixture('run-execute');
  pending.pendingOperation.beforeSnapshotHash = 'd'.repeat(64);
  rejects('runState', pending);
});

test('result references bind the Run and reject repeated attempt identities independent of key order', () => {
  const state = fixture('run-execute');
  const identity = state.pendingOperation.identity;
  const ref = { schemaVersion: 1, path: 'results/K1-1.json', sha256: 'a'.repeat(64) };
  state.resultRefs = [{ identity, ref }];
  assert.equal(parseContract('runState', state).resultRefs.length, 1);
  state.resultRefs.push({ identity: { requestId: identity.requestId, attempt: identity.attempt, taskId: identity.taskId, runId: identity.runId }, ref });
  rejects('runState', state);
  state.resultRefs = [{ identity: { ...identity, runId: 'other-run' }, ref }];
  rejects('runState', state);
});

test('snapshot preserves file bytes, executable mode, symlink text and deletion independently of the index', () => {
  const snapshot = parseContract('snapshot', fixture('snapshot'));
  assert.deepEqual(snapshot.paths.map((entry) => entry.type), ['file', 'file', 'symlink', 'missing']);
  assert.equal(snapshot.paths[1].mode, '100755');
  assert.equal(snapshot.paths[1].index.length, 0);
  assert.equal(snapshot.paths[2].symlinkTarget, 'a.ts');
  assert.equal(snapshot.paths[3].deleted, true);
  assert.equal(snapshot.paths[3].index[0].mode, '100644');
  for (const mutation of [{ type: 'directory' }, { mode: '0644' }, { deleted: true }, { rawContentHash: 'A'.repeat(64) }]) {
    const value = fixture('snapshot');
    Object.assign(value.paths[0], mutation);
    rejects('snapshot', value);
  }
  const noBytes = fixture('snapshot');
  delete noBytes.paths[0].rawContentHash;
  rejects('snapshot', noBytes);
});

test('snapshot accepts SHA-256 Git objects and conflict index stages without conflating them', () => {
  const snapshot = fixture('snapshot');
  snapshot.repoIdentity.head = 'd'.repeat(64);
  snapshot.paths[0].index = [1, 2, 3].map((stage) => ({ stage, blob: 'e'.repeat(64), mode: '100644' }));
  assert.equal(parseContract('snapshot', snapshot).paths[0].index.length, 3);
  snapshot.paths[0].index[0].stage = 0;
  rejects('snapshot', snapshot);
  snapshot.paths[0].index[0].stage = 2;
  rejects('snapshot', snapshot);
  snapshot.paths[0].index = [{ stage: 4, blob: 'e'.repeat(64), mode: '100644' }];
  rejects('snapshot', snapshot);
});

test('project and evidence paths reject lexical escape, aliases, and unknown nested fields', () => {
  for (const path of ['', '/etc/passwd', '../outside', 'src/../outside', 'C:/project/file', 'src\\file', 'src/\0file']) {
    const snapshot = fixture('snapshot');
    snapshot.paths[0].path = path;
    rejects('snapshot', snapshot);
    const state = fixture('run-created');
    state.acceptedSnapshotRef.path = path;
    rejects('runState', state);
  }
  const aliases = fixture('snapshot');
  aliases.paths.push({ ...aliases.paths[0], path: 'SRC/A.TS' });
  rejects('snapshot', aliases);
  const unknown = fixture('snapshot');
  unknown.paths[0].index[0].unknown = true;
  rejects('snapshot', unknown);
  const nulLink = fixture('snapshot');
  nulLink.paths[2].symlinkTarget = 'a\0.ts';
  rejects('snapshot', nulLink);
});

test('pending operations reject unknown kinds and incomplete verification intent', () => {
  const state = fixture('run-execute');
  state.pendingOperation.kind = 'deploy';
  rejects('runState', state);
  const verify = fixture('run-verify');
  delete verify.pendingOperation.verificationPlanRef;
  rejects('runState', verify);
});

test('lock metadata represents ownership without claiming Task state or PID-only liveness', () => {
  const lock = fixture('lock-metadata');
  delete lock.processStartIdentity;
  assert.deepEqual(parseContract('lockMetadata', lock), lock);
  rejects('lockMetadata', { ...lock, status: 'RUNNING' });
  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) rejects('lockMetadata', { ...lock, pid });
});

test('reconciliation resolution binds original revision, current boundary, actor, Tasks and evidence', () => {
  const resolution = fixture('reconciliation-resolution');
  for (const patch of [{ expectedRevision: -1 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { taskIds: [] }, { taskIds: ['K1', 'K1'] }, { evidenceRefs: [] }, { disposition: '' }, { resolvedBy: '' }, { currentSnapshotHash: 'f'.repeat(64) }]) {
    rejects('reconciliationResolution', { ...resolution, ...patch });
  }
});

test('reconciliation preserves failed status and reserves exactly one different successor', () => {
  const state = fixture('run-reconciled');
  assert.equal(parseContract('runState', state).status, 'FAILED');
  assert.deepEqual(state.completedTasks, []);
  for (const mutation of [
    (value) => { value.reconciliation.originalRevision = value.revision; },
    (value) => { value.reconciliation.originalPendingIdentity.identity.runId = 'other-run'; },
    (value) => { value.reconciliation.originalPendingIdentity.operationId = 'other-operation'; },
    (value) => { value.reconciliation.successor.runId = value.runId; },
    (value) => { value.reconciliation.successor.successorRunId = 'another-run'; },
    (value) => { value.reconciliation.successor.reservedAt = '2026-09-16T00:00:00Z'; },
    (value) => { value.reconciliation.successor.createdAt = '2026-09-16T00:00:00Z'; },
  ]) {
    const value = structuredClone(state);
    mutation(value);
    rejects('runState', value);
  }
  const successor = fixture('run-created');
  successor.runId = 'run-b';
  successor.authorization.runId = 'run-b';
  successor.reconciledFrom = { runId: 'run-a', revision: 3, resolutionHash: 'a'.repeat(64), snapshotHash: 'a'.repeat(64) };
  assert.equal(parseContract('runState', successor).reconciledFrom.runId, 'run-a');
  successor.reconciledFrom.runId = 'run-b';
  rejects('runState', successor);
});
