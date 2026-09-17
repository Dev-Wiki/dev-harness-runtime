import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createLinuxSandbox } from '../../dist/authorization/sandbox.js';
import { consumeAcceptedTask, finalizeWithoutCommit, verifyTaskAcceptance } from '../../dist/result/acceptance.js';
import { createAcceptanceRecoveryVerifier, verifyPersistedAcceptance } from '../../dist/result/recovery.js';
import { loadRecoveryCheckpoint } from '../../dist/recovery/evidence.js';
import { resumeRun } from '../../dist/recovery/resume.js';
import { readEvidence, writeRunEvidence } from '../../dist/state/index.js';
import { withStateFaultForTest } from '../../dist/state/testing.js';
import { setupAcceptance } from './helpers-acceptance.mjs';

const execute = promisify(execFile);
const realSandbox = { skip: process.platform !== 'linux' ? 'Linux sandbox provider only' : !process.env.DHR_TEST_BWRAP ? 'Requires explicit real bubblewrap installation' : false };
const provider = () => createLinuxSandbox({ binaryPath: process.env.DHR_TEST_BWRAP, toolchainMounts: [dirname(process.execPath)], path: `${dirname(process.execPath)}:/usr/bin:/bin` });
const input = (f, ending) => ({ runId: f.run.runId, expectedRevision: f.run.revision, requestRef: f.requestRef,
  resultRef: ending.resultRef, endingSnapshotRef: ending.endingSnapshotRef, frozenInputsRef: f.frozenInputsRef, workerEvidenceRefs: ending.workerEvidenceRefs });
const services = async (ending, patch = {}) => ({ sandbox: await provider(), workerControl: ending.workerControl, ...patch });
const git = async (root, ...args) => (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
const rejectsCode = (promise, ...codes) => assert.rejects(promise, (error) => codes.includes(error.code), `Expected ${codes.join('/')}`);

test('accepted capabilities cannot be forged from JSON or another process object', () => {
  assert.throws(() => consumeAcceptedTask({}, {}, 0), (error) => error.code === 'ACCEPTANCE_REQUIRED');
  assert.throws(() => consumeAcceptedTask(Object.freeze({ accepted: true }), {}, 0), (error) => error.code === 'ACCEPTANCE_REQUIRED');
});

test('independent verification writes controlled evidence and no-commit finalizes exactly once', realSandbox, async (t) => {
  const f = await setupAcceptance(t); const ending = await f.finishWorker(); const head = await git(f.root, 'rev-parse', 'HEAD');
  const capability = await verifyTaskAcceptance(f.handle, input(f, ending), await services(ending));
  const verified = await f.readRun();
  assert.equal(verified.pendingOperation.kind, 'verify'); assert.equal(verified.phase, 'FINALIZE'); assert.deepEqual(verified.completedTasks, []);
  assert.equal(JSON.stringify(capability), '{}');
  await rejectsCode(finalizeWithoutCommit(f.handle, capability, verified.revision - 1), 'ACCEPTANCE_REQUIRED');
  const completed = await finalizeWithoutCommit(f.handle, capability, verified.revision);
  assert.equal(completed.status, 'COMPLETED'); assert.deepEqual(completed.completedTasks, ['A']); assert.equal(completed.pendingOperation, undefined);
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
  const accepted = JSON.parse(await readEvidence(f.handle, completed.runId, completed.revision, completed.resultRefs[0].ref));
  assert.equal(accepted.commitSha, undefined); assert.equal(accepted.verification[0].exitCode, 0);
  const stdout = JSON.parse(await readEvidence(f.handle, completed.runId, completed.revision, accepted.verification[0].stdout));
  assert.equal(Buffer.from(stdout.bytes, 'base64').toString(), 'verified');
  assert.notDeepEqual(accepted.verification[0].stdout, ending.result.verification[0].stdout);
  await rejectsCode(finalizeWithoutCommit(f.handle, capability, completed.revision), 'ACCEPTANCE_REQUIRED');
});

test('completed Worker text cannot override a failing independent command', realSandbox, async (t) => {
  const f = await setupAcceptance(t, { command: [process.execPath, '-e', 'process.stderr.write("failed");process.exit(7)'] });
  const ending = await f.finishWorker(); assert.equal(ending.result.verification[0].result, 'passed');
  await rejectsCode(verifyTaskAcceptance(f.handle, input(f, ending), await services(ending)), 'VERIFICATION_FAILED');
  const run = await f.readRun(); assert.deepEqual(run.completedTasks, []); assert.equal(run.pendingOperation.kind, 'verify');
  assert.deepEqual(await readFile(join(f.project.stateRoot, f.run.runId, ending.resultRef.path)), await readEvidence(f.handle, run.runId, run.revision, ending.resultRef));
});

test('changedFiles, result identity and missing evidence are independently rejected', async (t) => {
  const f = await setupAcceptance(t); const ending = await f.finishWorker();
  for (const mutation of ['identity', 'changes', 'evidence', 'commit']) {
    const result = structuredClone(ending.result);
    if (mutation === 'identity') result.requestId = 'other-request';
    if (mutation === 'changes') result.changedFiles = result.changedFiles.filter((path) => path !== 'docs/verification/A.md');
    if (mutation === 'evidence') result.verification[0].stdout.sha256 = '0'.repeat(64);
    if (mutation === 'commit') result.commitSha = f.before.snapshot.repoIdentity.head;
    const resultRef = await writeRunEvidence(f.handle, f.run.runId, f.run.revision, `invalid-${mutation}`, result);
    await rejectsCode(verifyTaskAcceptance(f.handle, { ...input(f, ending), resultRef }, { sandbox: {}, workerControl: ending.workerControl }), 'INVALID_RESULT', 'EVIDENCE_MISMATCH', 'AUTHORIZATION_VIOLATION');
    assert.equal((await f.readRun()).revision, f.run.revision);
  }
});

test('missing provenance or denied host permissions cannot be replaced by valid private JSON', async (t) => {
  const f = await setupAcceptance(t); const ending = await f.finishWorker();
  await rejectsCode(verifyTaskAcceptance(f.handle, { ...input(f, ending), workerEvidenceRefs: [] }, { sandbox: {}, workerControl: ending.workerControl }), 'RECOVERY_EVIDENCE_REQUIRED');
  await rejectsCode(verifyTaskAcceptance(f.handle, input(f, ending), { sandbox: {}, workerControl: {} }), 'CAPABILITY_MISSING');
  await rejectsCode(verifyTaskAcceptance(f.handle, input(f, ending), { sandbox: {}, workerControl: { async verify() {
    return { providerId: 'unsupported', sessionId: 'same', authorizationEnforced: false, quiescent: true };
  } } }), 'AUTHORIZATION_VIOLATION');
  assert.equal((await f.readRun()).revision, f.run.revision);
});

test('incomplete archive cannot be accepted even with a bound Worker control receipt', async (t) => {
  const f = await setupAcceptance(t);
  const path = f.request.scope.planning.archivePath;
  f.planningFixture.afterFiles.set(path, Buffer.from(f.planningFixture.afterFiles.get(path).toString().replace('- [x]', '- [ ]')));
  const ending = await f.finishWorker();
  await rejectsCode(verifyTaskAcceptance(f.handle, input(f, ending), { sandbox: {}, workerControl: ending.workerControl }), 'INVALID_PLANNING_DELTA');
  assert.deepEqual((await f.readRun()).completedTasks, []);
});

test('post-Worker external content drift and unauthorized HEAD advance stop acceptance', async (t) => {
  const f = await setupAcceptance(t); const ending = await f.finishWorker();
  await writeFile(join(f.root, 'outside.txt'), 'unowned');
  await rejectsCode(verifyTaskAcceptance(f.handle, input(f, ending), { sandbox: {}, workerControl: ending.workerControl }), 'DRIFT_DETECTED');
  await git(f.root, 'add', '.'); await git(f.root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'unauthorized outside commit');
  await rejectsCode(verifyTaskAcceptance(f.handle, input(f, ending), { sandbox: {}, workerControl: ending.workerControl }), 'DRIFT_DETECTED');
  assert.equal((await f.readRun()).revision, f.run.revision);
});

test('verification uses frozen HARNESS while preserving an explicitly authorized replacement', realSandbox, async (t) => {
  const f = await setupAcceptance(t, { scopeFiles: ['HARNESS.md'], command: [process.execPath, '-e', 'if(!require("fs").readFileSync("HARNESS.md","utf8").includes("已确认命令"))process.exit(9)'] });
  const replacement = Buffer.from('# Worker replacement\nNo verification needed.\n');
  f.planningFixture.afterFiles.set('HARNESS.md', replacement);
  const ending = await f.finishWorker();
  const capability = await verifyTaskAcceptance(f.handle, input(f, ending), await services(ending));
  assert.deepEqual(await readFile(join(f.root, 'HARNESS.md')), replacement);
  const completed = await finalizeWithoutCommit(f.handle, capability, (await f.readRun()).revision);
  assert.equal(completed.status, 'COMPLETED');
});

test('changing a verification script cannot replace its frozen failing baseline', realSandbox, async (t) => {
  const f = await setupAcceptance(t, { command: [process.execPath, 'verify.cjs'], initialFiles: { 'verify.cjs': 'process.exit(7);\n' },
    scopeFiles: ['verify.cjs'], verificationSources: ['verify.cjs'] });
  f.planningFixture.afterFiles.set('verify.cjs', Buffer.from('process.exit(0);\n'));
  const ending = await f.finishWorker();
  await rejectsCode(verifyTaskAcceptance(f.handle, input(f, ending), await services(ending)), 'VERIFICATION_FAILED');
  assert.equal(await readFile(join(f.root, 'verify.cjs'), 'utf8'), 'process.exit(0);\n');
  assert.deepEqual((await f.readRun()).completedTasks, []);
});

test('explicit untracked build artifacts enter the accepted boundary without joining Task changes', realSandbox, async (t) => {
  const f = await setupAcceptance(t, { writableArtifacts: ['out'], command: [process.execPath, '-e', 'require("fs").writeFileSync("out/build.txt","output")'] });
  await mkdir(join(f.root, 'out')); const ending = await f.finishWorker();
  const capability = await verifyTaskAcceptance(f.handle, input(f, ending), await services(ending));
  const run = await f.readRun(); const data = consumeAcceptedTask(capability, f.handle, run.revision);
  assert.deepEqual(data.verificationArtifactPaths, ['out/build.txt']); assert.ok(!data.taskChangedPaths.includes('out/build.txt'));
  assert.equal(await readFile(join(f.root, 'out/build.txt'), 'utf8'), 'output');
  assert.equal(data.before.snapshot.paths.find((entry) => entry.path === 'out/build.txt').index.length, 0);
});

test('a command cannot change source or stage/commit by claiming success', realSandbox, async (t) => {
  const f = await setupAcceptance(t, { command: [process.execPath, '-e', 'require("fs").writeFileSync("docs/verification/A.md","forged")'] });
  const ending = await f.finishWorker(); const original = await readFile(join(f.root, 'docs/verification/A.md'));
  await rejectsCode(verifyTaskAcceptance(f.handle, input(f, ending), await services(ending)), 'VERIFICATION_FAILED');
  assert.deepEqual(await readFile(join(f.root, 'docs/verification/A.md')), original);
  assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '');
});

test('manual criteria without a trusted confirmation channel remain unaccepted', async (t) => {
  const f = await setupAcceptance(t, { manualReview: true }); const ending = await f.finishWorker();
  await rejectsCode(verifyTaskAcceptance(f.handle, input(f, ending), { sandbox: {}, workerControl: ending.workerControl }), 'MANUAL_ACCEPTANCE_REQUIRED');
  assert.equal((await f.readRun()).revision, f.run.revision);
});

test('independent manual confirmation must bind the exact identity and verified boundary', realSandbox, async (t) => {
  const f = await setupAcceptance(t, { manualReview: true }); const ending = await f.finishWorker();
  let calls = 0;
  const manualControl = { async verify({ state, request, check, after }) {
    calls++;
    // A fixture for the trusted external user-confirmation service, never Worker approval.
    const reviewer = 'fixture-user-confirmation-service';
    const confirmation = await writeRunEvidence(f.handle, state.runId, state.revision, 'fixture-user-confirmation', {
      schemaVersion: 1, kind: 'user-acceptance-confirmation', approved: true,
      identity: { runId: request.runId, taskId: request.taskId, attempt: request.attempt, requestId: request.requestId },
      checkId: check.id, acceptanceIds: check.acceptanceIds, snapshotHash: after.hash, reviewer,
    });
    return { reviewer, confirmation };
  } };
  const capability = await verifyTaskAcceptance(f.handle, input(f, ending), await services(ending, { manualControl }));
  const completed = await finalizeWithoutCommit(f.handle, capability, (await f.readRun()).revision);
  assert.equal(calls, 1); assert.equal(completed.status, 'COMPLETED');
});

test('no-commit finalization rejects project drift after acceptance without dropping pending evidence', realSandbox, async (t) => {
  const f = await setupAcceptance(t); const ending = await f.finishWorker();
  const capability = await verifyTaskAcceptance(f.handle, input(f, ending), await services(ending)); const verified = await f.readRun();
  await writeFile(join(f.root, 'outside.txt'), 'external after acceptance');
  await rejectsCode(finalizeWithoutCommit(f.handle, capability, verified.revision), 'DRIFT_DETECTED');
  assert.deepEqual(await f.readRun(), verified);
});

test('published Core acceptance survives a pre-CAS crash and recovers through the complete evidence chain', realSandbox, async (t) => {
  const f = await setupAcceptance(t); const ending = await f.finishWorker();
  const capability = await verifyTaskAcceptance(f.handle, input(f, ending), await services(ending)); const verified = await f.readRun();
  const context = await loadRecoveryCheckpoint(f.handle, verified, verified.pendingOperation.checkpointRef);
  await verifyPersistedAcceptance(f.handle, context, ending.workerControl);
  await rejectsCode(verifyPersistedAcceptance(f.handle, context, {}), 'CAPABILITY_MISSING');
  const acceptance = JSON.parse(await readEvidence(f.handle, verified.runId, verified.revision, context.checkpoint.evidenceRefs[0]));
  const forged = await writeRunEvidence(f.handle, verified.runId, verified.revision, 'substituted-worker-result', { ...acceptance, verifiedResultRef: ending.resultRef });
  await rejectsCode(verifyPersistedAcceptance(f.handle, { ...context, checkpoint: { ...context.checkpoint, evidenceRefs: [forged] } }, ending.workerControl), 'ACCEPTANCE_REQUIRED');
  let faulted = false;
  await assert.rejects(withStateFaultForTest((point, path) => {
    if (!faulted && point === 'directory-synced' && path.includes('/accepted-')) { faulted = true; throw new Error('Simulated pre-CAS exit'); }
  }, () => finalizeWithoutCommit(f.handle, capability, verified.revision)), /Simulated pre-CAS exit/u);
  assert.equal(faulted, true); assert.deepEqual(await f.readRun(), verified);
  const verifier = createAcceptanceRecoveryVerifier(f.handle, { workerControl: ending.workerControl,
    async verifyQuiescence({ state }) { assert.equal(state.runId, verified.runId); },
    async verifyWorkerCheckpoint() { assert.fail('No Worker execution checkpoint should be replayed'); },
  });
  const resumed = await resumeRun(f.handle, verified.runId, { expectedRevision: verified.revision, verifier,
    environment: { adapter: verified.adapter, authorization: verified.authorization, protocolSource: verified.protocolSource, adapterConfigHash: verified.adapterConfigHash } });
  assert.equal(resumed.decision.action, 'finalize-no-commit', resumed.decision.message);
  assert.deepEqual(resumed.state.completedTasks, ['A']); assert.equal(resumed.state.status, 'COMPLETED');
});
