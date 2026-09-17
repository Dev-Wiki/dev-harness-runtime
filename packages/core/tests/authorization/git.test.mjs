import assert from 'node:assert/strict';
import { access, chmod, copyFile, link, mkdir, open, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertSupportedCommitProject, commitAcceptedTask, resumeAcceptedTaskCommit } from '../../dist/authorization/git.js';
import { git, setupRecovery } from '../recovery/helpers.mjs';
import { setupAcceptance } from '../result/helpers-acceptance.mjs';
import { createLinuxSandbox } from '../../dist/authorization/sandbox.js';
import { verifyTaskAcceptance } from '../../dist/result/acceptance.js';
import { readEvidence } from '../../dist/state/index.js';
import { withStateFaultForTest } from '../../dist/state/testing.js';
import { createAcceptanceRecoveryVerifier } from '../../dist/result/recovery.js';
import { resumeRun } from '../../dist/recovery/resume.js';

const gitBinary = '/usr/bin/git';
const linuxTest = process.platform === 'linux' ? test : test.skip;
const fails = (promise, code) => assert.rejects(promise, (error) => error.code === code);

linuxTest('Git commit bridge refuses a caller-created accepted capability before any Git mutation', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  const head = await git(context.root, 'rev-parse', 'HEAD');
  await assert.rejects(commitAcceptedTask(context.handle, {}, { expectedRevision: context.run.revision, gitBinary, policy: { async evaluate() { throw new Error('must not run'); } } }));
  assert.equal(await git(context.root, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(context.root, 'diff', '--cached', '--name-only'), '');
});

linuxTest('supported Git preflight allows ordinary unsigned repositories with no active hooks', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  const project = await assertSupportedCommitProject(context.root, gitBinary);
  assert.equal(project.author.name, 'Fixture'); assert.match(project.fingerprint, /^[a-f0-9]{64}$/u);
});

linuxTest('external Git helper configurations and required signing fail before side effects', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  for (const [key, value, code] of [
    ['filter.custom.clean', 'touch MUST-NOT-EXECUTE', 'UNSUPPORTED_GIT_HELPER'],
    ['filter.custom.process', 'touch MUST-NOT-EXECUTE', 'UNSUPPORTED_GIT_HELPER'],
    ['core.fsmonitor', 'touch MUST-NOT-EXECUTE', 'UNSUPPORTED_GIT_HELPER'],
    ['diff.custom.textconv', 'touch MUST-NOT-EXECUTE', 'UNSUPPORTED_GIT_HELPER'],
    ['trailer.custom.cmd', 'touch MUST-NOT-EXECUTE', 'UNSUPPORTED_GIT_HELPER'],
    ['gpg.ssh.defaultKeyCommand', 'touch MUST-NOT-EXECUTE', 'UNSUPPORTED_GIT_HELPER'],
    ['commit.gpgSign', 'true', 'UNSUPPORTED_GIT_SIGNING'],
    ['remote.origin.promisor', 'true', 'UNSUPPORTED_PARTIAL_CLONE'],
  ]) {
    await git(context.root, 'config', key, value);
    await fails(assertSupportedCommitProject(context.root, gitBinary), code);
    await git(context.root, 'config', '--unset', key);
  }
  assert.equal(await git(context.root, 'status', '--porcelain'), '');
});

linuxTest('post-index-change and reference-transaction hooks are refused without running or disabling them', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  const hooks = join(context.project.privateGitDir, 'hooks');
  for (const name of ['post-index-change', 'reference-transaction', 'post-commit', 'pre-commit']) {
    const path = join(hooks, name);
    await writeFile(path, '#!/bin/sh\nprintf forbidden > MUST-NOT-EXECUTE\n'); await chmod(path, 0o755);
    await fails(assertSupportedCommitProject(context.root, gitBinary), 'UNSUPPORTED_GIT_HOOK');
    await chmod(path, 0o644);
  }
  assert.equal(await git(context.root, 'status', '--porcelain'), '');
});

linuxTest('effective external hook directory and unfinished Git operations are fail-closed', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  const custom = join(context.root, 'custom-hooks'); await mkdir(custom);
  await writeFile(join(custom, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await git(context.root, 'config', 'core.hooksPath', custom);
  await fails(assertSupportedCommitProject(context.root, gitBinary), 'UNSUPPORTED_GIT_HOOK');
  await git(context.root, 'config', '--unset', 'core.hooksPath');
  await writeFile(join(context.project.privateGitDir, 'MERGE_AUTOSTASH'), `${await git(context.root, 'rev-parse', 'HEAD')}\n`);
  await fails(assertSupportedCommitProject(context.root, gitBinary), 'GIT_OPERATION_IN_PROGRESS');
});

linuxTest('Git write metadata cannot redirect mutations through symlinks or reflog hard links', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  await link(join(context.project.privateGitDir, 'logs', 'HEAD'), join(context.root, 'reflog-alias'));
  await fails(assertSupportedCommitProject(context.root, gitBinary), 'UNSUPPORTED_GIT_METADATA');
});

linuxTest('Git object directory symlink is rejected without following a write target', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  await symlink(context.root, join(context.project.privateGitDir, 'objects', 'symlink-probe'));
  await fails(assertSupportedCommitProject(context.root, gitBinary), 'UNSUPPORTED_GIT_METADATA');
});

const actualProvider = { skip: process.platform !== 'linux' ? 'Linux provider only'
  : !process.env.DHR_TEST_BWRAP ? 'Requires explicitly installed real bubblewrap for independent acceptance' : false };
const commitMessage = 'test(task): independently accepted Task A\n';
async function acceptForCommit(t, options = {}) {
  const context = await setupAcceptance(t, { commit: 'task', ...options });
  const originalWorkflow = context.planningFixture.beforeFiles.get('docs/GIT_WORKFLOW.md');
  if (options.changeWorkflow) context.planningFixture.afterFiles.set('docs/GIT_WORKFLOW.md', Buffer.from('# Changed Worker workflow\n'));
  for (const path of options.writableArtifacts ?? []) await mkdir(join(context.root, path), { recursive: true });
  const finished = await context.finishWorker({ mutateResult(result) {
    result.commitIntent = { schemaVersion: 1, message: commitMessage, paths: result.changedFiles,
      workflow: { path: context.before.snapshot.gitWorkflowRef.path, sha256: context.before.snapshot.gitWorkflowRef.sha256 } };
  } });
  const sandbox = await createLinuxSandbox({ binaryPath: process.env.DHR_TEST_BWRAP,
    toolchainMounts: [dirname(process.execPath)], path: `${dirname(process.execPath)}:/usr/bin:/bin` });
  const capability = await verifyTaskAcceptance(context.handle, { runId: context.run.runId, expectedRevision: context.run.revision,
    requestRef: context.requestRef, resultRef: finished.resultRef, endingSnapshotRef: finished.endingSnapshotRef,
    frozenInputsRef: context.frozenInputsRef, workerEvidenceRefs: finished.workerEvidenceRefs }, { sandbox, workerControl: finished.workerControl });
  const accepted = await context.readRun();
  let policyCalls = 0;
  const policy = { async evaluate({ workflow, request, result }) {
    policyCalls += 1;
    assert.deepEqual(workflow.bytes, originalWorkflow, 'Core policy must consume original frozen workflow bytes');
    assert.equal(workflow.sha256, context.before.snapshot.gitWorkflowRef.sha256);
    assert.deepEqual(request, context.request);
    assert.deepEqual(result.commitIntent, finished.result.commitIntent);
    return { message: commitMessage, paths: [...result.commitIntent.paths] };
  } };
  return { ...context, finished, capability, accepted, policy, policyCalls: () => policyCalls,
    commit: () => commitAcceptedTask(context.handle, capability, { expectedRevision: accepted.revision, gitBinary, policy }) };
}

test('real independent acceptance publishes one exact commit and consumes the capability once', actualProvider, async (t) => {
  const context = await acceptForCommit(t);
  const parent = await git(context.root, 'rev-parse', 'HEAD');
  const outcome = await context.commit();
  assert.equal(context.policyCalls(), 1);
  assert.equal(outcome.state.status, 'COMPLETED');
  assert.deepEqual(outcome.state.completedTasks, ['A']);
  assert.equal(outcome.state.pendingOperation, undefined);
  assert.equal(outcome.commitSha, await git(context.root, 'rev-parse', 'HEAD'));
  assert.equal(await git(context.root, 'rev-list', '--count', `${parent}..HEAD`), '1');
  assert.equal(await git(context.root, 'show', '-s', '--format=%P', 'HEAD'), parent);
  assert.equal(await git(context.root, 'rev-parse', 'HEAD^{tree}'), await git(context.root, 'write-tree'));
  assert.equal(await git(context.root, 'show', '-s', '--format=%B', 'HEAD'), commitMessage.trim());
  const changed = (await git(context.root, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', parent, 'HEAD')).split('\n').sort();
  assert.deepEqual(changed, [...context.finished.result.changedFiles].sort());
  assert.equal(await git(context.root, 'status', '--porcelain'), '');
  const result = JSON.parse(await readEvidence(context.handle, outcome.state.runId, outcome.state.revision, outcome.state.resultRefs[0].ref));
  assert.equal(result.commitSha, outcome.commitSha);
  assert.equal(result.acceptedSnapshotHash, outcome.after.hash);
  assert.equal(result.verifiedEvidenceRefs.length, 1);
  await fails(context.commit(), 'ACCEPTANCE_REQUIRED');
  assert.equal(await git(context.root, 'rev-list', '--count', `${parent}..HEAD`), '1');
});

test('accepted workflow edits commit under the original frozen workflow policy', actualProvider, async (t) => {
  const context = await acceptForCommit(t, { scopeFiles: ['docs/GIT_WORKFLOW.md'], changeWorkflow: true });
  assert.equal(await readFile(join(context.root, 'docs/GIT_WORKFLOW.md'), 'utf8'), '# Changed Worker workflow\n');
  const outcome = await context.commit();
  assert.equal(context.policyCalls(), 1);
  assert.equal(await git(context.root, 'show', `${outcome.commitSha}:docs/GIT_WORKFLOW.md`), '# Changed Worker workflow');
});

test('active hooks block an accepted commit before staging and preserve accepted verification evidence', actualProvider, async (t) => {
  const context = await acceptForCommit(t);
  const parent = await git(context.root, 'rev-parse', 'HEAD');
  const hook = join(context.project.privateGitDir, 'hooks', 'post-commit');
  await writeFile(hook, '#!/bin/sh\ngit commit --allow-empty -m unauthorized-extra-commit\nprintf ran > MUST-NOT-EXECUTE\n', { mode: 0o755 });
  await fails(context.commit(), 'UNSUPPORTED_GIT_HOOK');
  assert.equal(await git(context.root, 'rev-parse', 'HEAD'), parent);
  assert.equal(await git(context.root, 'diff', '--cached', '--name-only'), '');
  assert.deepEqual(await context.readRun(), context.accepted);
  await assert.rejects(access(join(context.root, 'MUST-NOT-EXECUTE')));
});

linuxTest('effective configuration fingerprints bind values even when keys are unchanged', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  await git(context.root, 'config', 'commit.cleanup', 'verbatim');
  const first = await assertSupportedCommitProject(context.root, gitBinary);
  await git(context.root, 'config', 'commit.cleanup', 'strip');
  const second = await assertSupportedCommitProject(context.root, gitBinary);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

linuxTest('Git binary gate rejects scripts and writable native executables before execution', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  const script = join(context.root, 'fake-git');
  await writeFile(script, '#!/bin/sh\ntouch MUST-NOT-EXECUTE\n', { mode: 0o755 });
  await fails(assertSupportedCommitProject(context.root, script), 'GIT_TOOLCHAIN_UNTRUSTED');
  const copy = join(context.root, 'writable-git');
  await copyFile(gitBinary, copy); await chmod(copy, 0o777);
  await fails(assertSupportedCommitProject(context.root, copy), 'GIT_TOOLCHAIN_UNTRUSTED');
  await assert.rejects(access(join(context.root, 'MUST-NOT-EXECUTE')));
});

linuxTest('Git binary gate detects a changed executable at the pinned path', async (t) => {
  const context = await setupRecovery(t, { commit: 'task' });
  const copy = join(context.root, 'pinned-git');
  await copyFile(gitBinary, copy); await chmod(copy, 0o755);
  await assertSupportedCommitProject(context.root, copy);
  const file = await open(copy, 'a');
  try { await file.write(Buffer.from('changed executable bytes')); } finally { await file.close(); }
  await fails(assertSupportedCommitProject(context.root, copy), 'GIT_TOOLCHAIN_CHANGED');
});


test('published Git acceptance survives a pre-CAS crash and recovery adopts the single actual commit', actualProvider, async (t) => {
  const context = await acceptForCommit(t);
  const parent = await git(context.root, 'rev-parse', 'HEAD');
  let acceptedPath;
  await assert.rejects(withStateFaultForTest((point, path) => {
    if (!acceptedPath && point === 'directory-synced' && path.includes('/accepted-')) {
      acceptedPath = path;
      throw new Error('Simulated Git acceptance pre-CAS exit');
    }
  }, () => context.commit()), /Simulated Git acceptance pre-CAS exit/u);
  assert.ok(acceptedPath, 'Fault must follow durable accepted evidence publication');
  const interrupted = await context.readRun();
  assert.equal(interrupted.pendingOperation.kind, 'commit');
  assert.deepEqual(interrupted.completedTasks, []);
  const commitSha = await git(context.root, 'rev-parse', 'HEAD');
  assert.notEqual(commitSha, parent);
  assert.equal(await git(context.root, 'rev-list', '--count', `${parent}..HEAD`), '1');
  const publishedBytes = await readFile(acceptedPath);
  const published = JSON.parse(publishedBytes);
  const checkpoint = JSON.parse(await readEvidence(context.handle, interrupted.runId, interrupted.revision, interrupted.pendingOperation.indexCheckpointRef));
  const staged = JSON.parse(await readEvidence(context.handle, interrupted.runId, interrupted.revision, checkpoint.afterSnapshotRef));
  assert.equal(published.acceptedAt, staged.capturedAt);
  let quiescenceChecks = 0;
  const verifier = createAcceptanceRecoveryVerifier(context.handle, {
    workerControl: context.finished.workerControl,
    // Fixture Core process is already quiescent; the real command namespace was independently drained.
    async verifyQuiescence({ state }) { quiescenceChecks += 1; assert.equal(state.runId, interrupted.runId); },
    async verifyWorkerCheckpoint() { assert.fail('Recovery must verify persisted Core acceptance, not replay a Worker checkpoint'); },
  });
  const environment = { adapter: interrupted.adapter, authorization: interrupted.authorization,
    protocolSource: interrupted.protocolSource, adapterConfigHash: interrupted.adapterConfigHash };
  const recovered = await resumeRun(context.handle, interrupted.runId, { expectedRevision: interrupted.revision, verifier, environment });
  assert.equal(recovered.decision.action, 'adopt-commit', recovered.decision.message);
  assert.equal(quiescenceChecks, 1);
  assert.equal(recovered.state.status, 'COMPLETED');
  assert.equal(recovered.state.pendingOperation, undefined);
  assert.deepEqual(recovered.state.completedTasks, ['A']);
  assert.equal(recovered.state.resultRefs.length, 1);
  assert.deepEqual(await readFile(acceptedPath), publishedBytes, 'Recovery must reuse the original evidence bytes and acceptance time');
  assert.deepEqual(await readEvidence(context.handle, recovered.state.runId, recovered.state.revision, recovered.state.resultRefs[0].ref), publishedBytes);
  const names = await readdir(dirname(acceptedPath));
  assert.equal(names.filter((name) => name.startsWith('accepted-')).length, 1);
  assert.equal(names.filter((name) => name.startsWith('committed-')).length, 1);
  assert.equal(published.commitSha, commitSha);
  assert.equal(recovered.state.acceptedSnapshotHash, published.acceptedSnapshotHash);
  assert.equal(await git(context.root, 'rev-parse', 'HEAD'), commitSha);
  const repeated = await resumeRun(context.handle, recovered.state.runId, { expectedRevision: recovered.state.revision, verifier, environment });
  assert.equal(repeated.decision.action, 'stopped');
  assert.match(repeated.decision.message, /Terminal Runs cannot resume/u);
  assert.deepEqual(repeated.state, recovered.state);
  assert.deepEqual(repeated.state.completedTasks, ['A']);
  assert.equal(await git(context.root, 'rev-list', '--count', `${parent}..HEAD`), '1');
  assert.deepEqual(await readFile(acceptedPath), publishedBytes);
});

async function interruptPreparedCommit(context, stage) {
  let injected = false;
  await assert.rejects(withStateFaultForTest(async (point, path) => {
    if (injected || point !== 'directory-synced' || !path.endsWith('/run.json')) return;
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.pendingOperation?.kind === 'commit' && Boolean(state.pendingOperation.indexCheckpointRef) === (stage === 'index-staged')) {
      injected = true; throw new Error(`Simulated ${stage} crash`);
    }
  }, () => context.commit()), new RegExp(`Simulated ${stage} crash`, 'u'));
  assert.equal(injected, true);
  const state = await context.readRun();
  const verifier = createAcceptanceRecoveryVerifier(context.handle, { workerControl: context.finished.workerControl,
    async verifyQuiescence() {}, async verifyWorkerCheckpoint() { assert.fail('Prepared commits require the original Core acceptance chain'); } });
  const resumed = await resumeRun(context.handle, state.runId, { expectedRevision: state.revision, verifier,
    environment: { adapter: state.adapter, authorization: state.authorization, protocolSource: state.protocolSource, adapterConfigHash: state.adapterConfigHash } });
  assert.equal(resumed.decision.action, 'resume-commit', resumed.decision.message);
  return resumed.state;
}

test('persisted verification-passed resumes commit with artifacts without rerunning verification', actualProvider, async t => {
  const context = await acceptForCommit(t, { writableArtifacts: ['out'], command: [process.execPath, '-e',
    'const fs=require("fs");const p="out/count";fs.writeFileSync(p,String(fs.existsSync(p)?Number(fs.readFileSync(p))+1:1))'] });
  const state = await context.readRun();
  const verifier = createAcceptanceRecoveryVerifier(context.handle, { workerControl: context.finished.workerControl,
    async verifyQuiescence() {}, async verifyWorkerCheckpoint() { assert.fail('Must recover persisted Core verification'); } });
  const resumed = await resumeRun(context.handle, state.runId, { expectedRevision: state.revision, verifier,
    environment: { adapter: state.adapter, authorization: state.authorization, protocolSource: state.protocolSource, adapterConfigHash: state.adapterConfigHash } });
  assert.equal(resumed.decision.action, 'revalidate', resumed.decision.message);
  const outcome = await resumeAcceptedTaskCommit(context.handle, state.runId, { expectedRevision: resumed.state.revision, gitBinary,
    policy: context.policy, workerControl: context.finished.workerControl });
  assert.equal(outcome.state.status, 'COMPLETED');
  assert.equal(await readFile(join(context.root, 'out/count'), 'utf8'), '1');
  assert.equal(await git(context.root, 'ls-files', 'out/count'), '');
  assert.equal(context.policyCalls(), 1);
});

for (const stage of ['commit-ready', 'index-staged']) {
  test(`trusted commit continuation finishes the exact ${stage} reservation once`, actualProvider, async t => {
    const context = await acceptForCommit(t); const parent = await git(context.root, 'rev-parse', 'HEAD');
    const state = await interruptPreparedCommit(context, stage);
    const intent = structuredClone(state.pendingOperation);
    const outcome = await resumeAcceptedTaskCommit(context.handle, state.runId, { expectedRevision: state.revision, gitBinary,
      policy: context.policy, workerControl: context.finished.workerControl });
    assert.equal(context.policyCalls(), 2);
    assert.equal(outcome.state.status, 'COMPLETED'); assert.deepEqual(outcome.state.completedTasks, ['A']);
    assert.equal(await git(context.root, 'rev-list', '--count', `${parent}..HEAD`), '1');
    assert.equal(await git(context.root, 'rev-parse', 'HEAD^{tree}'), intent.expectedTree);
    assert.equal(await git(context.root, 'show', '-s', '--format=%B', 'HEAD'), commitMessage.trim());
    assert.deepEqual((await git(context.root, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', parent, 'HEAD')).split('\n').sort(), [...intent.paths].sort());
    await fails(resumeAcceptedTaskCommit(context.handle, state.runId, { expectedRevision: outcome.state.revision, gitBinary,
      policy: context.policy, workerControl: context.finished.workerControl }), 'ACCEPTANCE_REQUIRED');
    assert.equal(await git(context.root, 'rev-list', '--count', `${parent}..HEAD`), '1');
  });
}

test('commit continuation rejects stale revisions, missing provenance and changed policy without staging', actualProvider, async t => {
  const context = await acceptForCommit(t); const state = await interruptPreparedCommit(context, 'commit-ready');
  const options = { expectedRevision: state.revision, gitBinary, policy: context.policy, workerControl: context.finished.workerControl };
  await fails(resumeAcceptedTaskCommit(context.handle, state.runId, { ...options, expectedRevision: state.revision - 1 }), 'REVISION_CONFLICT');
  await fails(resumeAcceptedTaskCommit(context.handle, state.runId, { ...options, workerControl: {} }), 'CAPABILITY_MISSING');
  await fails(resumeAcceptedTaskCommit(context.handle, state.runId, { ...options, policy: { async evaluate() {
    return { message: 'changed message\n', paths: [...state.pendingOperation.paths] };
  } } }), 'GIT_WORKFLOW_MISMATCH');
  await fails(resumeAcceptedTaskCommit(context.handle, state.runId, { ...options, policy: { async evaluate() {
    return { message: commitMessage, paths: state.pendingOperation.paths.slice(1) };
  } } }), 'AUTHORIZATION_VIOLATION');
  assert.equal(await git(context.root, 'diff', '--cached', '--name-only'), '');
  assert.deepEqual(await context.readRun(), state);
});

test('staged commit continuation refuses actual drift and Worker entry without rewriting Git', actualProvider, async t => {
  const context = await acceptForCommit(t); const state = await interruptPreparedCommit(context, 'index-staged');
  const options = { expectedRevision: state.revision, gitBinary, policy: context.policy, workerControl: context.finished.workerControl };
  const previous = process.env.DEV_HARNESS_WORKER;
  try {
    process.env.DEV_HARNESS_WORKER = '1';
    await fails(resumeAcceptedTaskCommit(context.handle, state.runId, options), 'AUTHORIZATION_VIOLATION');
  } finally {
    if (previous === undefined) delete process.env.DEV_HARNESS_WORKER; else process.env.DEV_HARNESS_WORKER = previous;
  }
  await writeFile(join(context.root, 'unrelated.txt'), 'unowned drift');
  const parent = await git(context.root, 'rev-parse', 'HEAD'); const index = await git(context.root, 'write-tree');
  await fails(resumeAcceptedTaskCommit(context.handle, state.runId, options), 'DRIFT_DETECTED');
  assert.equal(await git(context.root, 'rev-parse', 'HEAD'), parent); assert.equal(await git(context.root, 'write-tree'), index);
  assert.deepEqual(await context.readRun(), state);
});

test('commit continuation requires adoption when the reserved commit already happened', actualProvider, async t => {
  const context = await acceptForCommit(t); const state = await interruptPreparedCommit(context, 'index-staged');
  // Model a crash after the exact Git command but before Core finalized its record.
  await git(context.root, 'commit', '--quiet', '--no-gpg-sign', '--cleanup=verbatim', '-m', commitMessage.trim());
  const head = await git(context.root, 'rev-parse', 'HEAD');
  await fails(resumeAcceptedTaskCommit(context.handle, state.runId, { expectedRevision: state.revision, gitBinary,
    policy: context.policy, workerControl: context.finished.workerControl }), 'COMMIT_ADOPTION_REQUIRED');
  assert.equal(await git(context.root, 'rev-parse', 'HEAD'), head);
  const verifier = createAcceptanceRecoveryVerifier(context.handle, { workerControl: context.finished.workerControl,
    async verifyQuiescence() {}, async verifyWorkerCheckpoint() { assert.fail('Must recover Core acceptance'); } });
  const adopted = await resumeRun(context.handle, state.runId, { expectedRevision: state.revision, verifier,
    environment: { adapter: state.adapter, authorization: state.authorization, protocolSource: state.protocolSource, adapterConfigHash: state.adapterConfigHash } });
  assert.equal(adopted.decision.action, 'adopt-commit', adopted.decision.message);
  assert.equal(adopted.state.status, 'COMPLETED'); assert.equal(await git(context.root, 'rev-parse', 'HEAD'), head);
});
