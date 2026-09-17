import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { discoverProject } from '../../dist/discovery/index.js';
import { captureSnapshot } from '../../dist/snapshot/capture.js';
import { loadRecoverySnapshot } from '../../dist/recovery/evidence.js';
import { acquireLock, releaseLock } from '../../dist/lock/index.js';
import { compareAndSwapRun, createAttempt, initializeRun, writeRunEvidence } from '../../dist/state/index.js';

const execute = promisify(execFile);
export const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
export async function git(root, ...args) { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim(); }
export async function write(root, path, content) { const dest = join(root, path); await mkdir(join(dest, '..'), { recursive: true }); await writeFile(dest, content); }
export async function setupRecovery(t, { dirty = false, commit = 'deny', selectionMode = { mode: 'explicit', taskId: 'K1' } } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-recovery-')));
  await git(root, 'init', '--quiet', '-b', 'main');
  await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  await write(root, 'AGENTS.md', '# Rules\n[Git](docs/GIT_WORKFLOW.md)\n');
  await write(root, 'HARNESS.md', '# HARNESS\n## 已确认命令\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| full | `node --test` | confirmed |\n');
  await write(root, 'docs/GIT_WORKFLOW.md', '# Git\n');
  await write(root, 'docs/plan/Dashboard.md', '# Dashboard\n');
  await write(root, 'docs/plan/tasks/K1.md', '# Task K1\n');
  await write(root, 'docs/plan/archive/V1/README.md', '# Archive\n');
  await write(root, 'src/a.ts', 'initial\n'); await write(root, 'src/other.ts', 'other\n');
  await git(root, 'add', '.'); await git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'initial');
  if (dirty) await write(root, 'src/a.ts', 'user work\n');
  const project = await discoverProject(root);
  const seed = fixture('state/run-created');
  for (const key of ['initialUserChangesRef', 'initialUserChangesHash', 'acceptedSnapshotRef', 'acceptedSnapshotHash']) delete seed[key];
  seed.authorization.commit = commit; seed.selectionMode = selectionMode;
  const options = { project, runId: seed.runId, protocolSource: seed.protocolSource, adapterConfigHash: seed.adapterConfigHash };
  const initial = await captureSnapshot(options); seed.repoIdentity = initial.snapshot.repoIdentity;
  const handle = await acquireLock(project, { runId: seed.runId, adapter: seed.adapter });
  t.after(async () => { await releaseLock(handle).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const run = await initializeRun(handle, seed, initial.snapshot);
  return { root, project, seed, options, initial, handle, run, sequence: 0 };
}
export function requestFor(context, state = context.run) {
  const request = fixture('execution/request');
  request.repoRoot = context.root; request.docsRoot = context.project.docsRoot; request.dashboardPath = context.project.dashboardPath;
  request.taskPath = join(context.root, 'docs/plan/tasks/K1.md');
  request.protocolSource = state.protocolSource; request.env.DEV_HARNESS_ADAPTER = state.adapter;
  request.snapshotRef = state.acceptedSnapshotRef.path; request.snapshotHash = state.acceptedSnapshotHash;
  request.verificationPlan.sources = ['HARNESS.md', 'docs/plan/tasks/K1.md'].map((path) => ({ path, sha256: context.initial.snapshot.paths.find((entry) => entry.path === path).rawContentHash }));
  return request;
}
export const environmentFor = (state) => ({ adapter: state.adapter, authorization: structuredClone(state.authorization), protocolSource: structuredClone(state.protocolSource), adapterConfigHash: state.adapterConfigHash });
export async function publish(context, changes) {
  const next = { ...structuredClone(context.run), ...changes, revision: context.run.revision + 1 };
  if (['INTERRUPTED', 'BLOCKED', 'FAILED'].includes(next.status)) next.stopReason ??= { code: 'PROCESS_INTERRUPTED', message: 'Test fixture interrupted boundary' };
  context.run = await compareAndSwapRun(context.handle, context.run.runId, context.run.revision, next);
  return context.run;
}
export async function installExecute(context, { status = 'INTERRUPTED', checkpoint } = {}) {
  const request = requestFor(context); const identity = { runId: request.runId, taskId: request.taskId, attempt: request.attempt, requestId: request.requestId };
  await publish(context, { status, phase: 'EXECUTE', currentTaskId: identity.taskId, currentAttempt: identity.attempt, currentRequestId: identity.requestId,
    pendingOperation: { schemaVersion: 1, operationId: 'execute-a', kind: 'execute', identity, scope: request.scope, beforeSnapshotRef: context.run.acceptedSnapshotRef,
      beforeSnapshotHash: context.run.acceptedSnapshotHash, createdAt: context.run.updatedAt } });
  await createAttempt(context.handle, context.run.runId, context.run.revision, identity);
  context.request = request;
  if (checkpoint) await installCheckpoint(context, checkpoint);
  return context;
}
export async function installCheckpoint(context, stage, { candidate = false, after, request = context.request, result, evidenceRefs } = {}) {
  const run = context.run; const prefix = `fixture-${++context.sequence}`;
  after ??= stage === 'commit-ready'
    ? await loadRecoverySnapshot(context.handle, run, run.pendingOperation.beforeSnapshotRef)
    : await captureSnapshot(context.options);
  if (stage === 'commit-ready') assert.equal(after.hash, run.pendingOperation.beforeSnapshotHash, 'Prepared commit fixture must reuse its exact before boundary');
  const put = (name, value) => writeRunEvidence(context.handle, run.runId, run.revision, `${prefix}-${name}`, value);
  const afterRef = stage === 'commit-ready' ? run.pendingOperation.beforeSnapshotRef : await put('after', after.snapshot);
  const requestRef = await put('request', request);
  const proofRef = await put('proof', { schemaVersion: 1, runId: run.runId, kind: 'test-only-controlled-proof', operationId: run.pendingOperation.operationId, endingHash: after.hash });
  const checkpoint = { schemaVersion: 1, operationId: run.pendingOperation.operationId, kind: run.pendingOperation.kind, identity: run.pendingOperation.identity, stage,
    beforeSnapshotRef: run.pendingOperation.beforeSnapshotRef, afterSnapshotRef: afterRef, requestRef, evidenceRefs: evidenceRefs ?? [proofRef] };
  if (['worker-ended', 'verification-passed', 'commit-ready', 'index-staged'].includes(stage)) {
    result ??= fixture('execution/result-completed');
    result.snapshotHash = request.snapshotHash;
    for (const record of result.verification) { record.beforeSnapshotHash = request.snapshotHash; record.afterSnapshotHash = after.hash; }
    checkpoint.resultRef = await put('result', result);
  }
  const ref = await put('checkpoint', checkpoint);
  if (!candidate) await publish(context, { pendingOperation: { ...run.pendingOperation, ...(stage === 'index-staged' ? { indexCheckpointRef: ref } : { checkpointRef: ref }) } });
  context.checkpoint = { checkpoint, ref, after, afterRef, proofRef };
  return context.checkpoint;
}
// These callbacks prove only the in-process fixture's explicit bound records. They are not a real host verifier.
export function fixtureVerifier(context) {
  return {
    async verifyQuiescence({ state }) { assert.equal(state.runId, context.run.runId); },
    async verifyCheckpoint(input) {
      assert.equal(input.checkpoint.operationId, input.state.pendingOperation.operationId);
      if (input.checkpoint.stage === 'execute-intent') {
        const previous = JSON.parse(input.evidence[0].bytes.toString());
        assert.equal(previous.identity.attempt + 1, input.checkpoint.identity.attempt);
        assert.deepEqual(previous.afterSnapshotRef, input.checkpoint.beforeSnapshotRef);
        assert.deepEqual(input.evidence[0].ref, context.checkpoint.ref);
      } else {
        assert.deepEqual(input.checkpointRef, context.checkpoint.ref);
        const proof = JSON.parse(input.evidence[0].bytes.toString());
        assert.equal(proof.operationId, input.checkpoint.operationId); assert.equal(proof.endingHash, input.after.hash);
      }
    },
    async verifyAcceptance(input) { assert.equal(input.result.outcome, 'completed'); assert.equal(input.request.snapshotHash, input.result.snapshotHash); assert.deepEqual(input.checkpointRef, context.checkpoint.ref); },
  };
}
