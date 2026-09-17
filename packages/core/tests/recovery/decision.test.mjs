import assert from 'node:assert/strict';
import test from 'node:test';
import { decideRecovery } from '../../dist/recovery/decision.js';
import { parseRecoveryCheckpoint } from '../../dist/recovery/evidence.js';
import { fixture } from './helpers.mjs';
const base = () => ({ ...fixture('state/run-created'), status: 'INTERRUPTED' });
const facts = (patch = {}) => ({ currentMatchesBefore: false, currentMatchesAccepted: false, checkpointVerified: false, acceptanceVerified: false, commitVerified: false, commitAbsent: false, resultCompleted: false, ...patch });
const pending = (kind) => ({ kind, identity: { runId: 'run-a', taskId: 'K1', attempt: 1, requestId: 'request-a' } });

test('recovery decisions distinguish restart, owned checkpoint and unowned drift', () => {
  const state = { ...base(), pendingOperation: pending('execute') };
  assert.deepEqual(decideRecovery(state, facts({ currentMatchesBefore: true })), { action: 'execute-new-session', continuation: 'restart', freshSession: true });
  assert.equal(decideRecovery(state, facts()).code, 'PENDING_RECONCILIATION');
  const checkpoint = { stage: 'worker-checkpoint' };
  assert.equal(decideRecovery(state, facts({ checkpoint })).code, 'RECOVERY_EVIDENCE_REQUIRED');
  assert.equal(decideRecovery(state, facts({ checkpoint, checkpointVerified: true })).continuation, 'checkpoint');
  checkpoint.stage = 'worker-ended';
  assert.equal(decideRecovery(state, facts({ checkpoint, checkpointVerified: true })).code, 'RESULT_NOT_COMPLETED');
  assert.equal(decideRecovery(state, facts({ checkpoint, checkpointVerified: true, resultCompleted: true })).action, 'adopt-result');
});

test('verification and commit decisions never infer acceptance or replay a commit', () => {
  const state = { ...base(), pendingOperation: pending('verify') };
  assert.equal(decideRecovery(state, facts({ currentMatchesBefore: true })).action, 'revalidate');
  const checkpoint = { stage: 'verification-passed' };
  assert.equal(decideRecovery(state, facts({ checkpoint, checkpointVerified: true })).code, 'ACCEPTANCE_REQUIRED');
  assert.equal(decideRecovery(state, facts({ checkpoint, checkpointVerified: true, resultCompleted: true, acceptanceVerified: true })).action, 'finalize-no-commit');
  state.pendingOperation = pending('commit');
  assert.equal(decideRecovery(state, facts()).code, 'DRIFT_DETECTED');
  assert.equal(decideRecovery(state, facts({ commitAbsent: true, currentMatchesBefore: true })).action, 'resume-commit');
  assert.equal(decideRecovery(state, facts({ commitVerified: true })).action, 'adopt-commit');
});

test('accepted boundary alone rebuilds summary and terminal states stay terminal', () => {
  const state = base();
  assert.equal(decideRecovery(state, facts({ currentMatchesAccepted: true })).action, 'rebuild-summary');
  assert.equal(decideRecovery(state, facts()).code, 'DRIFT_DETECTED');
  for (const status of ['FAILED', 'COMPLETED']) assert.equal(decideRecovery({ ...state, status }, facts({ currentMatchesAccepted: true })).code, 'RUN_TERMINAL');
});

test('checkpoint parser rejects unknown keys, phase mismatch and path escape', () => {
  const ref = { schemaVersion: 1, path: 'results/run-evidence/a.json', sha256: 'a'.repeat(64) };
  const checkpoint = { schemaVersion: 1, operationId: 'operation-a', kind: 'execute', identity: pending('execute').identity, stage: 'worker-checkpoint', beforeSnapshotRef: ref, afterSnapshotRef: ref, requestRef: ref, evidenceRefs: [ref] };
  assert.deepEqual(parseRecoveryCheckpoint(checkpoint), checkpoint);
  for (const mutate of [(value) => { value.extra = true; }, (value) => { value.stage = 'index-staged'; }, (value) => { value.evidenceRefs = []; }, (value) => { value.requestRef.path = '../outside'; }, (value) => { value.identity.attempt = 0; }]) {
    const broken = structuredClone(checkpoint); mutate(broken); assert.throws(() => parseRecoveryCheckpoint(broken), { code: 'INVALID_RECOVERY_CHECKPOINT' });
  }
});
