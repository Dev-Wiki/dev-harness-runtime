import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { resumeRun } from '../../dist/recovery/resume.js';
import { captureSnapshot } from '../../dist/snapshot/capture.js';
import { readCurrentRun, readEvidence, writeRunEvidence } from '../../dist/state/index.js';
import { withStateFaultForTest } from '../../dist/state/testing.js';
import { environmentFor, fixtureVerifier, git, installCheckpoint, installExecute, publish, setupRecovery, write } from './helpers.mjs';

const options = (context, patch = {}) => ({ expectedRevision: context.run.revision, environment: environmentFor(context.run), verifier: fixtureVerifier(context), ...patch });
const resume = (context, patch) => resumeRun(context.handle, context.run.runId, options(context, patch));
const stopped = (result, code) => { assert.equal(result.decision.action, 'stopped', result.decision.message); assert.equal(result.decision.code, code, result.decision.message); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('unchanged recovery advances attempt and request with a fresh fake Session, then rejects stale CAS', async (t) => {
  const context = await setupRecovery(t); await installExecute(context);
  const result = await resume(context);
  assert.equal(result.decision.action, 'execute-new-session', result.decision.message); assert.equal(result.decision.freshSession, true);
  assert.equal(result.state.currentAttempt, 2); assert.notEqual(result.state.currentRequestId, 'request-a');
  const sessions = [];
  const fakeExecutor = { async execute(request) { sessions.push({ sessionId: `fresh-${sessions.length + 1}`, requestId: request.requestId }); } };
  await fakeExecutor.execute({ requestId: 'request-a' }); await fakeExecutor.execute({ requestId: result.state.currentRequestId });
  assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
  assert.ok((await readdir(join(context.project.stateRoot, 'run-a', 'attempts'))).includes('K1-2'));
  stopped(await resume(context), 'REVISION_CONFLICT');
});

test('old CREATED/RUNNING without trusted quiescence remain unmodified', async (t) => {
  const context = await setupRecovery(t);
  stopped(await resume(context, { verifier: {} }), 'LOCK_OWNER_UNKNOWN');
  assert.equal((await readCurrentRun(context.handle, 'run-a')).revision, 0);
  await installExecute(context, { status: 'RUNNING' });
  stopped(await resume(context, { verifier: {} }), 'LOCK_OWNER_UNKNOWN');
  const result = await resume(context);
  assert.equal(result.decision.action, 'execute-new-session', result.decision.message);
  assert.equal(result.state.revision, context.run.revision + 2);
});

test('current protocol, Adapter configuration and authorization cannot silently change', async (t) => {
  const context = await setupRecovery(t); await installExecute(context);
  for (const [mutate, code] of [
    [(value) => { value.protocolSource.version = '2.0.0'; }, 'ENVIRONMENT_MISMATCH'],
    [(value) => { value.adapterConfigHash = 'd'.repeat(64); }, 'ENVIRONMENT_MISMATCH'],
    [(value) => { value.adapter = 'other'; }, 'ENVIRONMENT_MISMATCH'],
    [(value) => { value.authorization.commit = 'task'; }, 'AUTHORIZATION_VIOLATION'],
  ]) { const environment = environmentFor(context.run); mutate(environment); stopped(await resume(context, { environment }), code); }
  assert.equal((await readCurrentRun(context.handle, 'run-a')).revision, context.run.revision);
});

test('unchanged execution still refuses initial user content in scope and staged input', async (t) => {
  const context = await setupRecovery(t, { dirty: true }); await installExecute(context);
  stopped(await resume(context), 'USER_CHANGES_PRESENT');
});

test('unowned drift preserves the pending intent and old evidence', async (t) => {
  const context = await setupRecovery(t); await installExecute(context);
  await write(context.root, 'src/a.ts', 'unknown external change\n');
  stopped(await resume(context), 'PENDING_RECONCILIATION');
  assert.deepEqual(await readCurrentRun(context.handle, 'run-a'), context.run);
  assert.ok(await readEvidence(context.handle, 'run-a', context.run.revision, context.run.acceptedSnapshotRef));
});

test('controlled checkpoint continues with new request and a bound predecessor chain', async (t) => {
  const context = await setupRecovery(t); await installExecute(context);
  await write(context.root, 'src/a.ts', 'owned partial change\n'); await installCheckpoint(context, 'worker-checkpoint');
  stopped(await resume(context, { verifier: {} }), 'RECOVERY_EVIDENCE_REQUIRED');
  const result = await resume(context);
  assert.equal(result.decision.continuation, 'checkpoint', result.decision.message);
  assert.equal(result.state.currentAttempt, 2);
  const checkpoint = JSON.parse((await readEvidence(context.handle, 'run-a', result.state.revision, result.state.pendingOperation.checkpointRef)).toString());
  assert.equal(checkpoint.stage, 'execute-intent'); assert.deepEqual(checkpoint.evidenceRefs, [context.checkpoint.ref]);
  context.run = result.state;
  const second = await resume(context);
  assert.equal(second.decision.action, 'execute-new-session', second.decision.message); assert.equal(second.state.currentAttempt, 3);
});

test('trusted checkpoint callback cannot authorize out-of-scope edits', async (t) => {
  const context = await setupRecovery(t); await installExecute(context);
  await write(context.root, 'src/other.ts', 'out of scope\n'); await installCheckpoint(context, 'worker-checkpoint');
  stopped(await resume(context), 'AUTHORIZATION_VIOLATION');
});

test('explicit orphan result admission binds identity and only schedules independent revalidation', async (t) => {
  const context = await setupRecovery(t); await installExecute(context);
  await write(context.root, 'src/a.ts', 'owned completed content\n'); const candidate = await installCheckpoint(context, 'worker-ended', { candidate: true });
  stopped(await resume(context), 'PENDING_RECONCILIATION');
  stopped(await resume(context, { candidateCheckpointRef: candidate.ref, verifier: {} }), 'RECOVERY_EVIDENCE_REQUIRED');
  const result = await resume(context, { candidateCheckpointRef: candidate.ref });
  assert.equal(result.decision.action, 'adopt-result', result.decision.message); assert.equal(result.state.phase, 'REVALIDATE');
  assert.deepEqual(result.state.completedTasks, []); assert.equal(result.state.pendingOperation.kind, 'verify');
  assert.deepEqual(result.state.resultRefs[0].ref, candidate.checkpoint.resultRef);
});

test('mismatched checkpoint identity and caller checkpoint cannot be adopted', async (t) => {
  const context = await setupRecovery(t); await installExecute(context); await installCheckpoint(context, 'worker-ended');
  stopped(await resume(context, { checkpointRef: context.run.acceptedSnapshotRef }), 'INVALID_RECOVERY_CHECKPOINT');
  const bad = structuredClone(context.checkpoint.checkpoint); bad.identity.requestId = 'other-request';
  const ref = await writeRunEvidence(context.handle, 'run-a', context.run.revision, 'wrong-identity', bad);
  await publish(context, { pendingOperation: { ...context.run.pendingOperation, checkpointRef: ref } });
  stopped(await resume(context), 'INVALID_RECOVERY_CHECKPOINT');
});

async function installVerify(context, { writableArtifacts, verificationWrites = [] } = {}) {
  await installExecute(context);
  if (writableArtifacts) context.request.verificationPlan.commands[0].writableArtifacts = writableArtifacts;
  await write(context.root, 'src/a.ts', 'owned complete\n'); await installCheckpoint(context, 'worker-ended');
  const adopted = await resume(context); assert.equal(adopted.decision.action, 'adopt-result', adopted.decision.message); context.run = adopted.state;
  await publish(context, { status: 'INTERRUPTED' });
  for (const [path, content] of verificationWrites) await write(context.root, path, content);
  await installCheckpoint(context, 'verification-passed');
}

test('Worker ending -> phase-local verify before -> independent acceptance -> completed no-commit', async (t) => {
  const context = await setupRecovery(t); await installVerify(context);
  assert.notEqual(context.request.snapshotHash, context.run.pendingOperation.beforeSnapshotHash);
  stopped(await resume(context, { verifier: { verifyCheckpoint: fixtureVerifier(context).verifyCheckpoint } }), 'ACCEPTANCE_REQUIRED');
  const parent = await git(context.root, 'rev-parse', 'HEAD');
  const result = await resume(context);
  assert.equal(result.decision.action, 'finalize-no-commit', result.decision.message); assert.equal(result.state.status, 'COMPLETED');
  assert.deepEqual(result.state.completedTasks, ['K1']); assert.equal(await git(context.root, 'rev-parse', 'HEAD'), parent);
  context.run = result.state; stopped(await resume(context), 'RUN_TERMINAL');
});

test('original request snapshot is independently hash checked across verify phases', async (t) => {
  const context = await setupRecovery(t); await installVerify(context);
  const original = join(context.project.stateRoot, 'run-a', context.request.snapshotRef);
  await writeFile(original, Buffer.concat([await readFile(original), Buffer.from(' ')]));
  stopped(await resume(context), 'EVIDENCE_MISMATCH');
});

test('published verification-plan evidence survives a pre-CAS fault and reuses exactly one record', async (t) => {
  const context = await setupRecovery(t); await installExecute(context); await installCheckpoint(context, 'worker-ended');
  let faulted = false;
  const first = await withStateFaultForTest((point, path) => { if (!faulted && point === 'directory-synced' && path.includes('verification-plan-')) { faulted = true; throw new Error('simulated process exit before CAS'); } }, () => resume(context));
  assert.equal(faulted, true); assert.equal(first.decision.action, 'stopped');
  assert.equal((await readCurrentRun(context.handle, 'run-a')).revision, context.run.revision);
  const retry = await resume(context); assert.equal(retry.decision.action, 'adopt-result', retry.decision.message);
  assert.equal(retry.state.revision, context.run.revision + 1);
  const names = await readdir(join(context.project.stateRoot, 'run-a', 'results/run-evidence'));
  assert.equal(names.filter((name) => name.startsWith('verification-plan-')).length, 1);
});

test('published accepted evidence survives a pre-CAS fault without duplicate task acceptance', async (t) => {
  const context = await setupRecovery(t); await installVerify(context);
  let faulted = false;
  await withStateFaultForTest((point, path) => { if (!faulted && point === 'directory-synced' && path.includes('/accepted-')) { faulted = true; throw new Error('simulated acceptance exit'); } }, () => resume(context));
  assert.equal(faulted, true); assert.equal((await readCurrentRun(context.handle, 'run-a')).revision, context.run.revision);
  const retry = await resume(context); assert.equal(retry.decision.action, 'finalize-no-commit', retry.decision.message); assert.deepEqual(retry.state.completedTasks, ['K1']);
});

async function installCommit(context, stage = 'index-staged') {
  await installExecute(context); await write(context.root, 'src/a.ts', 'owned complete\n');
  const before = await captureSnapshot(context.options);
  const beforeRef = await writeRunEvidence(context.handle, 'run-a', context.run.revision, 'commit-before', before.snapshot);
  await git(context.root, 'add', 'src/a.ts'); const tree = await git(context.root, 'write-tree');
  if (stage === 'commit-ready') await git(context.root, 'reset', '--quiet', 'HEAD', '--', 'src/a.ts');
  await publish(context, { phase: 'FINALIZE', pendingOperation: { schemaVersion: 1, operationId: 'commit-a', kind: 'commit', identity: context.run.pendingOperation.identity,
    scope: context.run.pendingOperation.scope, beforeSnapshotRef: beforeRef, beforeSnapshotHash: beforeRef.sha256, parent: before.snapshot.repoIdentity.head,
    expectedTree: tree, paths: ['src/a.ts'], messageHash: hash('accepted Task\n'), createdAt: context.run.updatedAt } });
  await installCheckpoint(context, stage);
}

test('staged but uncommitted recovery returns a Core bridge action without creating a commit', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' }); await installCommit(context);
  const parent = await git(context.root, 'rev-parse', 'HEAD');
  const result = await resume(context); assert.equal(result.decision.action, 'resume-commit', result.decision.message);
  assert.equal(await git(context.root, 'rev-parse', 'HEAD'), parent); assert.deepEqual(result.state.completedTasks, []);
});

test('actual exact commit is adopted once and pre-CAS snapshot evidence retains its first capture time', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' }); await installCommit(context);
  await git(context.root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'accepted Task'); const commit = await git(context.root, 'rev-parse', 'HEAD');
  let faulted = false;
  await withStateFaultForTest((point, path) => { if (!faulted && point === 'directory-synced' && path.includes('/committed-')) { faulted = true; throw new Error('simulated exit after snapshot'); } }, () => resume(context));
  assert.equal(faulted, true);
  const directory = join(context.project.stateRoot, 'run-a', 'results/run-evidence');
  const name = (await readdir(directory)).find((name) => name.startsWith('committed-')); const first = await readFile(join(directory, name));
  const retry = await resume(context); assert.equal(retry.decision.action, 'adopt-commit', retry.decision.message); assert.equal(retry.state.status, 'COMPLETED');
  assert.deepEqual(await readFile(join(directory, name)), first); assert.equal(retry.state.acceptedSnapshotHash, hash(first));
  assert.equal(await git(context.root, 'rev-parse', 'HEAD'), commit); assert.deepEqual(retry.state.completedTasks, ['K1']);
});

test('unrelated real commit is never replayed or accepted', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' }); await installCommit(context);
  await git(context.root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'unrelated message');
  stopped(await resume(context), 'DRIFT_DETECTED');
  assert.deepEqual(await readCurrentRun(context.handle, 'run-a'), context.run);
});

test('empty queue accepted boundary rebuilds summary without a fake Task', async (t) => {
  const context = await setupRecovery(t, { selectionMode: { mode: 'all-ready' } });
  const result = await resume(context); assert.equal(result.decision.action, 'rebuild-summary', result.decision.message);
  assert.equal(result.state.pendingOperation, undefined); assert.equal(result.state.currentTaskId, undefined);
  const summary = JSON.parse(await readFile(join(context.project.stateRoot, 'run-a', 'summary.json'), 'utf8'));
  assert.equal(summary.revision, result.state.revision); assert.deepEqual(summary.completedTasks, []);
});

test('execute-intent rejects predecessor identity or ending-boundary substitution before trusting provenance', async (t) => {
  const context = await setupRecovery(t); await installExecute(context);
  await write(context.root, 'src/a.ts', 'owned partial change\n'); await installCheckpoint(context, 'worker-checkpoint');
  const predecessor = structuredClone(context.checkpoint.checkpoint);
  const first = await resume(context); assert.equal(first.decision.action, 'execute-new-session', first.decision.message); context.run = first.state;
  await publish(context, { status: 'INTERRUPTED' });
  const originalIntent = JSON.parse((await readEvidence(context.handle, 'run-a', context.run.revision, context.run.pendingOperation.checkpointRef)).toString());
  for (const [index, mutate] of [
    (value) => { value.identity.attempt = 9; },
    (value) => { value.afterSnapshotRef = context.run.acceptedSnapshotRef; },
  ].entries()) {
    const prior = structuredClone(predecessor); mutate(prior);
    const priorRef = await writeRunEvidence(context.handle, 'run-a', context.run.revision, `substituted-prior-${index}`, prior);
    const intentRef = await writeRunEvidence(context.handle, 'run-a', context.run.revision, `substituted-intent-${index}`, { ...originalIntent, evidenceRefs: [priorRef] });
    await publish(context, { pendingOperation: { ...context.run.pendingOperation, checkpointRef: intentRef } });
    let verified = false;
    const result = await resume(context, { verifier: { async verifyCheckpoint() { verified = true; } } });
    stopped(result, 'INVALID_RECOVERY_CHECKPOINT'); assert.equal(verified, false);
  }
});

test('staged checkpoint cannot hide governance content drift inside an index operation', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' }); await installCommit(context);
  await write(context.root, 'HARNESS.md', '# Changed governance\n');
  await installCheckpoint(context, 'index-staged');
  let verified = false;
  const verifier = fixtureVerifier(context);
  const result = await resume(context, { verifier: { ...verifier, async verifyCheckpoint(input) { verified = true; await verifier.verifyCheckpoint(input); } } });
  stopped(result, 'DRIFT_DETECTED'); assert.equal(verified, false);
});

test('commit-ready recovery preserves an unstaged boundary and returns only the Core bridge action', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' }); await installCommit(context, 'commit-ready');
  const parent = await git(context.root, 'rev-parse', 'HEAD');
  assert.equal(await git(context.root, 'diff', '--cached', '--name-only'), '');
  assert.deepEqual(context.checkpoint.checkpoint.beforeSnapshotRef, context.checkpoint.checkpoint.afterSnapshotRef);
  const result = await resume(context);
  assert.equal(result.decision.action, 'resume-commit', result.decision.message);
  assert.equal(await git(context.root, 'rev-parse', 'HEAD'), parent);
  assert.equal(await git(context.root, 'diff', '--cached', '--name-only'), '');
  assert.deepEqual(result.state.completedTasks, []);
});

test('commit-ready checkpoint with distinct before and after references fails before trusted callbacks', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' }); await installCommit(context, 'commit-ready');
  const bad = { ...context.checkpoint.checkpoint, afterSnapshotRef: context.run.acceptedSnapshotRef };
  const ref = await writeRunEvidence(context.handle, 'run-a', context.run.revision, 'malformed-commit-ready', bad);
  await publish(context, { pendingOperation: { ...context.run.pendingOperation, checkpointRef: ref } });
  let verified = false;
  stopped(await resume(context, { verifier: { async verifyCheckpoint() { verified = true; } } }), 'INVALID_RECOVERY_CHECKPOINT');
  assert.equal(verified, false);
  assert.deepEqual(await readCurrentRun(context.handle, 'run-a'), context.run);
});

test('verification recovery accepts only explicitly declared untracked artifacts into the accepted boundary', async (t) => {
  const context = await setupRecovery(t);
  await installVerify(context, { writableArtifacts: ['build/report.json'], verificationWrites: [['build/report.json', '{"passed":true}\n']] });
  const result = await resume(context);
  assert.equal(result.decision.action, 'finalize-no-commit', result.decision.message);
  assert.equal(await git(context.root, 'ls-files', '--', 'build/report.json'), '');
  const accepted = JSON.parse(await readEvidence(context.handle, 'run-a', result.state.revision, result.state.acceptedSnapshotRef));
  assert.ok(accepted.paths.some((entry) => entry.path === 'build/report.json' && entry.type === 'file' && entry.index.length === 0));
  assert.deepEqual(result.state.completedTasks, ['K1']);
});

for (const [description, declared, changed] of [
  ['undeclared output', ['build/report.json'], 'build/other.json'],
  ['tracked output', ['src/other.ts'], 'src/other.ts'],
]) {
  test(`verification recovery rejects ${description} before trusting acceptance`, async (t) => {
    const context = await setupRecovery(t);
    await installVerify(context, { writableArtifacts: declared, verificationWrites: [[changed, 'unauthorized verification write\n']] });
    let accepted = false;
    const verifier = { ...fixtureVerifier(context), async verifyAcceptance() { accepted = true; } };
    stopped(await resume(context, { verifier }), 'AUTHORIZATION_VIOLATION');
    assert.equal(accepted, false);
    assert.deepEqual(await readCurrentRun(context.handle, 'run-a'), context.run);
  });
}

test('verification source-scope overlap is rejected when the frozen request is first recovered', async (t) => {
  const context = await setupRecovery(t); await installExecute(context);
  context.request.verificationPlan.commands[0].writableArtifacts = ['src/a.ts'];
  await write(context.root, 'src/a.ts', 'owned complete\n'); await installCheckpoint(context, 'worker-ended');
  stopped(await resume(context), 'INVALID_CONTRACT');
  assert.deepEqual(await readCurrentRun(context.handle, 'run-a'), context.run);
});
