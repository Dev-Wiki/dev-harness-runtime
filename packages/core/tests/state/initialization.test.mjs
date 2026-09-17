import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { captureSnapshot, discoverProject, serializeSnapshot } from '../../dist/index.js';
import { acquireLock, releaseLock } from '../../dist/lock/index.js';
import {
  StateError, compareAndSwapRun, ensureRunEvidence, initializeRun, listRunIds, readCurrentRun,
  readEvidence, readRunAtRevision, readRunEvidenceCandidate, resumeRunInitialization, serializeRunInitializationSeed,
  writeRunEvidence,
} from '../../dist/state/index.js';
import { withStateFaultForTest } from '../../dist/state/testing.js';

const execute = promisify(execFile);
const template = () => JSON.parse(readFileSync(new URL('../../../contracts/fixtures/state/run-created.json', import.meta.url), 'utf8'));
async function git(root, ...args) { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim(); }
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-initialize-')));
  await git(root, 'init', '--quiet', '-b', 'main');
  await git(root, 'config', 'core.autocrlf', 'false');
  await mkdir(join(root, 'docs/plan'), { recursive: true });
  for (const [name, text] of Object.entries({
    'AGENTS.md': '# Project\n[Git workflow](docs/GIT_WORKFLOW.md)\n',
    'HARNESS.md': '# HARNESS\n\n## 已确认命令\n\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| test | `node --test` | confirmed |\n',
    'docs/GIT_WORKFLOW.md': '# Git workflow\n',
    'docs/plan/Dashboard.md': '# Dashboard\n\n## 当前工作顺序\n\n## 活跃任务\n',
    'source.txt': 'Initial bytes\n',
  })) await writeFile(join(root, name), text);
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', 'Initial fixture');
  const project = await discoverProject(root);
  const handle = await acquireLock(project, { runId: 'run-a', adapter: 'codex' });
  t.after(async () => { await releaseLock(handle).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const seed = template();
  for (const field of ['initialUserChangesRef', 'initialUserChangesHash', 'acceptedSnapshotRef', 'acceptedSnapshotHash']) delete seed[field];
  const captured = await captureSnapshot({ project, runId: seed.runId, protocolSource: seed.protocolSource, adapterConfigHash: seed.adapterConfigHash });
  seed.repoIdentity = structuredClone(captured.snapshot.repoIdentity);
  return { root, project, handle, seed, snapshot: captured.snapshot, captured, runDir: join(project.stateRoot, 'run-a') };
}
const fails = (promise, code) => assert.rejects(promise, (error) => error instanceof StateError && error.code === code);
async function pauseAfterEvidence(context) {
  await assert.rejects(withStateFaultForTest((point, path) => {
    if (point === 'directory-synced' && path.endsWith('initialization.json')) throw new Error('Pause before publishing run.json');
  }, () => initializeRun(context.handle, context.seed, context.snapshot)), /Pause before publishing/u);
}

test('empty-queue initialization stores actual snapshot evidence without inventing a Task', async (t) => {
  const { handle, seed, snapshot, runDir, captured } = await setup(t);
  const state = await initializeRun(handle, seed, snapshot);
  assert.equal(state.currentTaskId, undefined);
  assert.deepEqual(await readdir(join(runDir, 'attempts')), []);
  assert.deepEqual((await readdir(runDir)).sort(), ['attempts', 'results', 'run.json']);
  assert.deepEqual(state.initialUserChangesRef, state.acceptedSnapshotRef);
  assert.equal(state.acceptedSnapshotRef.path, 'results/run-evidence/initial.json');
  assert.equal(state.acceptedSnapshotHash, captured.hash);
  const raw = await readEvidence(handle, 'run-a', 0, state.acceptedSnapshotRef);
  assert.equal(raw.toString(), serializeSnapshot(snapshot));
  const manifest = JSON.parse(await readFile(join(runDir, 'results/run-evidence/initialization.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['initialSnapshotRef', 'runId', 'schemaVersion', 'seedHash']);
  assert.deepEqual(await readCurrentRun(handle, 'run-a'), state);
});

test('seed canonicalization sorts object keys, preserves arrays and rejects non-JSON values', async (t) => {
  const { seed } = await setup(t);
  const reordered = Object.fromEntries(Object.entries(seed).reverse());
  reordered.authorization = Object.fromEntries(Object.entries(seed.authorization).reverse());
  assert.equal(serializeRunInitializationSeed(seed), serializeRunInitializationSeed(reordered));
  assert.ok(serializeRunInitializationSeed(seed).endsWith('\n'));
  for (const unexpected of [undefined, Infinity, NaN, new Date()]) {
    assert.throws(() => serializeRunInitializationSeed({ ...seed, unexpected }), StateError);
  }
  assert.throws(() => serializeRunInitializationSeed({ ...seed, acceptedSnapshotHash: 'a'.repeat(64) }), StateError);
});

test('initializer rejects mismatched Run, worktree, HEAD, protocol and configuration', async (t) => {
  const { handle, seed, snapshot, runDir } = await setup(t);
  for (const change of [
    (value) => { value.runId = 'run-b'; },
    (value) => { value.repoIdentity.repoRoot += '-other'; },
    (value) => { value.repoIdentity.head = 'd'.repeat(40); },
    (value) => { value.protocolSource.version = '2.0.0'; },
    (value) => { value.adapterConfigHash = 'd'.repeat(64); },
  ]) {
    const mismatched = structuredClone(snapshot); change(mismatched);
    await fails(initializeRun(handle, seed, mismatched), 'STATE_IDENTITY_MISMATCH');
  }
  await assert.rejects(readFile(join(runDir, 'run.json')), { code: 'ENOENT' });
});

test('initializer verifies real current bytes instead of accepting a structurally valid stale snapshot', async (t) => {
  const { root, handle, seed, snapshot } = await setup(t);
  await writeFile(join(root, 'source.txt'), 'Changed after capture\n');
  await fails(initializeRun(handle, seed, snapshot), 'EVIDENCE_MISMATCH');
});

test('initialize refuses existing Runs while resume returns the current record without resetting its revision', async (t) => {
  const { handle, seed, snapshot } = await setup(t);
  const state = await initializeRun(handle, seed, snapshot);
  await fails(initializeRun(handle, seed, snapshot), 'STATE_ALREADY_EXISTS');
  const advanced = await compareAndSwapRun(handle, 'run-a', 0, { ...state, revision: 1, phase: 'SELECT' });
  assert.deepEqual(await resumeRunInitialization(handle, seed, snapshot), advanced);
  assert.equal((await readCurrentRun(handle, 'run-a')).revision, 1);
  await assert.rejects(readRunAtRevision(handle, 'run-a'), { code: 'REVISION_CONFLICT' });
});

test('CAS cannot replace or delete a Run creation reconciliation source', async (t) => {
  const { handle, seed, snapshot } = await setup(t);
  seed.reconciledFrom = { runId: 'previous-run', revision: 2, resolutionHash: 'a'.repeat(64), snapshotHash: 'b'.repeat(64) };
  const state = await initializeRun(handle, seed, snapshot);
  const changed = structuredClone(state); changed.revision = 1; changed.reconciledFrom.runId = 'other-source';
  await fails(compareAndSwapRun(handle, 'run-a', 0, changed), 'STATE_IDENTITY_MISMATCH');
  const removed = structuredClone(state); removed.revision = 1; delete removed.reconciledFrom;
  await fails(compareAndSwapRun(handle, 'run-a', 0, removed), 'STATE_IDENTITY_MISMATCH');
});

test('a clean interruption after both immutable initial records can finish the same initialization', async (t) => {
  const context = await setup(t);
  await pauseAfterEvidence(context);
  await fails(readCurrentRun(context.handle, 'run-a'), 'STATE_INCOMPLETE');
  const result = await resumeRunInitialization(context.handle, context.seed, context.snapshot);
  assert.equal(result.revision, 0);
  assert.deepEqual(await resumeRunInitialization(context.handle, context.seed, context.snapshot), result);
});

test('resume rejects changed authorization, selection or snapshot bytes without publishing authority', async (t) => {
  const context = await setup(t); await pauseAfterEvidence(context);
  for (const change of [
    (seed) => { seed.authorization.commit = 'task'; },
    (seed) => { seed.selectionMode = { mode: 'next' }; },
    (seed) => { seed.createdAt = '2026-09-16T00:00:00Z'; },
  ]) {
    const seed = structuredClone(context.seed); change(seed);
    await fails(resumeRunInitialization(context.handle, seed, context.snapshot), 'EVIDENCE_MISMATCH');
  }
  const snapshot = structuredClone(context.snapshot); snapshot.capturedAt = '2026-09-16T00:00:00Z';
  await fails(resumeRunInitialization(context.handle, context.seed, snapshot), 'EVIDENCE_MISMATCH');
  await assert.rejects(readFile(join(context.runDir, 'run.json')), { code: 'ENOENT' });
});

test('resume rejects a fixed initial record whose actual project boundary drifted during interruption', async (t) => {
  const context = await setup(t); await pauseAfterEvidence(context);
  await writeFile(join(context.root, 'source.txt'), 'External work during interruption\n');
  await fails(resumeRunInitialization(context.handle, context.seed, context.snapshot), 'EVIDENCE_MISMATCH');
});

for (const anomaly of ['missing-manifest', 'unknown-temp', 'unexpected-attempt', 'corrupt-initial']) {
  test(`resume fails closed for ${anomaly} and preserves the observed files`, async (t) => {
    const context = await setup(t); await pauseAfterEvidence(context);
    const evidence = join(context.runDir, 'results/run-evidence');
    if (anomaly === 'missing-manifest') await rm(join(evidence, 'initialization.json'));
    if (anomaly === 'unknown-temp') await writeFile(join(context.runDir, '.dhr-unknown.tmp'), 'Do not guess ownership');
    if (anomaly === 'unexpected-attempt') await mkdir(join(context.runDir, 'attempts', 'A-1'));
    if (anomaly === 'corrupt-initial') await writeFile(join(evidence, 'initial.json'), '{"schemaVersion":1');
    await fails(resumeRunInitialization(context.handle, context.seed, context.snapshot), anomaly === 'corrupt-initial' ? 'EVIDENCE_MISMATCH' : 'STATE_INCOMPLETE');
    await assert.rejects(readFile(join(context.runDir, 'run.json')), { code: 'ENOENT' });
    if (anomaly === 'unknown-temp') assert.equal(await readFile(join(context.runDir, '.dhr-unknown.tmp'), 'utf8'), 'Do not guess ownership');
  });
}

test('resume never guesses away a hard-link publication interrupted before unlink', async (t) => {
  const context = await setup(t);
  await assert.rejects(withStateFaultForTest((point) => { if (point === 'linked') throw new Error('Interrupted hard-link'); },
    () => initializeRun(context.handle, context.seed, context.snapshot)), /Interrupted hard-link/u);
  await fails(resumeRunInitialization(context.handle, context.seed, context.snapshot), 'STATE_INCOMPLETE');
  assert.ok((await readdir(join(context.runDir, 'results/run-evidence'))).some((name) => name.endsWith('.tmp')));
});

test('Run-level evidence supports task-free recovery records and canonical snapshot bytes', async (t) => {
  const { handle, seed, snapshot, captured } = await setup(t);
  await initializeRun(handle, seed, snapshot);
  const checkpoint = { schemaVersion: 1, runId: 'run-a', kind: 'initial-boundary', note: 'No Task was started.' };
  const ref = await writeRunEvidence(handle, 'run-a', 0, 'checkpoint', checkpoint);
  assert.equal(ref.path, 'results/run-evidence/checkpoint.json');
  assert.deepEqual(JSON.parse((await readEvidence(handle, 'run-a', 0, ref)).toString()), checkpoint);
  await fails(writeRunEvidence(handle, 'run-a', undefined, 'without-revision', checkpoint), 'REVISION_CONFLICT');
  await fails(readEvidence(handle, 'run-a', undefined, ref), 'REVISION_CONFLICT');
  await fails(writeRunEvidence(handle, 'run-a', 0, 'checkpoint', checkpoint), 'EVIDENCE_EXISTS');
  const observed = await writeRunEvidence(handle, 'run-a', 0, 'observed', snapshot);
  assert.equal(observed.sha256, captured.hash);
  assert.equal((await readEvidence(handle, 'run-a', 0, observed)).toString(), serializeSnapshot(snapshot));
  await fails(writeRunEvidence(handle, 'run-a', 0, '../escape', checkpoint), 'STATE_PATH_INVALID');
  await fails(writeRunEvidence(handle, 'run-a', 0, 'other', { ...checkpoint, runId: 'run-b' }), 'STATE_IDENTITY_MISMATCH');
});

test('ensureRunEvidence reuses only identical canonical bytes without replacing the original file', async (t) => {
  const { handle, seed, snapshot, runDir } = await setup(t);
  await initializeRun(handle, seed, snapshot);
  const evidence = { schemaVersion: 1, runId: 'run-a', message: 'Accepted fixed checkpoint' };
  const ref = await ensureRunEvidence(handle, 'run-a', 0, 'fixed', evidence);
  const path = join(runDir, ref.path);
  const before = await stat(path, { bigint: true });
  const original = await readFile(path);
  assert.deepEqual(await ensureRunEvidence(handle, 'run-a', 0, 'fixed', Object.fromEntries(Object.entries(evidence).reverse())), ref);
  const after = await stat(path, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  await fails(ensureRunEvidence(handle, 'run-a', 0, 'fixed', { ...evidence, message: 'Different checkpoint' }), 'EVIDENCE_EXISTS');
  assert.deepEqual(await readFile(path), original);
  await ensureRunEvidence(handle, 'run-a', 0, 'fixed-snapshot', snapshot);
  const later = { ...snapshot, capturedAt: new Date(Date.parse(snapshot.capturedAt) + 1000).toISOString() };
  await fails(ensureRunEvidence(handle, 'run-a', 0, 'fixed-snapshot', later), 'EVIDENCE_EXISTS');
});

test('evidence published before a state CAS can be safely reused on an identical retry', async (t) => {
  const { handle, seed, snapshot, runDir } = await setup(t);
  await initializeRun(handle, seed, snapshot);
  const checkpoint = { schemaVersion: 1, runId: 'run-a', kind: 'accepted-checkpoint' };
  await assert.rejects(withStateFaultForTest((point, path) => {
    if (point === 'published' && path.endsWith('retry-checkpoint.json')) throw new Error('Interrupted before CAS');
  }, () => ensureRunEvidence(handle, 'run-a', 0, 'retry-checkpoint', checkpoint)), /Interrupted before CAS/u);
  assert.equal((await readCurrentRun(handle, 'run-a')).revision, 0);
  const stored = await readFile(join(runDir, 'results/run-evidence/retry-checkpoint.json'));
  const ref = await ensureRunEvidence(handle, 'run-a', 0, 'retry-checkpoint', checkpoint);
  assert.deepEqual(await readEvidence(handle, 'run-a', 0, ref), stored);
  assert.equal((await readCurrentRun(handle, 'run-a')).revision, 0);
});

test('candidate reads use only the exact requested name and enforce revision and path checks', async (t) => {
  const { handle, seed, snapshot } = await setup(t);
  await initializeRun(handle, seed, snapshot);
  const ref = await ensureRunEvidence(handle, 'run-a', 0, 'observed-snapshot', snapshot);
  assert.equal(await readRunEvidenceCandidate(handle, 'run-a', 0, 'not-written'), undefined);
  const candidate = await readRunEvidenceCandidate(handle, 'run-a', 0, 'observed-snapshot');
  assert.deepEqual(candidate.ref, ref);
  assert.equal(candidate.bytes.toString(), serializeSnapshot(snapshot));
  await fails(readRunEvidenceCandidate(handle, 'run-a', undefined, 'observed-snapshot'), 'REVISION_CONFLICT');
  await fails(readRunEvidenceCandidate(handle, 'run-a', 1, 'observed-snapshot'), 'REVISION_CONFLICT');
  await fails(readRunEvidenceCandidate(handle, 'run-a', 0, '../other-run'), 'STATE_PATH_INVALID');
  await fails(ensureRunEvidence(handle, 'run-a', undefined, 'no-revision', { schemaVersion: 1 }), 'REVISION_CONFLICT');
});

test('candidate reads and evidence reuse reject symlinks instead of interpreting them as missing records', async (t) => {
  const { handle, seed, snapshot, runDir, root } = await setup(t);
  await initializeRun(handle, seed, snapshot);
  const outside = join(root, 'outside-evidence.json');
  await writeFile(outside, '{"schemaVersion":1}\n');
  try { await symlink(outside, join(runDir, 'results/run-evidence/linked.json'), 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('File symlinks require Windows privileges'); return; } throw error; }
  await fails(readRunEvidenceCandidate(handle, 'run-a', 0, 'linked'), 'STATE_PATH_INVALID');
  await fails(ensureRunEvidence(handle, 'run-a', 0, 'linked', { schemaVersion: 1 }), 'STATE_PATH_INVALID');
});

test('diagnostic listing reads every actual Run authority and sorts IDs without mtime heuristics', async (t) => {
  const { handle, seed, snapshot } = await setup(t);
  const otherSeed = structuredClone(seed); otherSeed.runId = 'run-b'; otherSeed.authorization.runId = 'run-b';
  const otherSnapshot = structuredClone(snapshot); otherSnapshot.runId = 'run-b';
  await initializeRun(handle, otherSeed, otherSnapshot);
  await initializeRun(handle, seed, snapshot);
  assert.deepEqual(await listRunIds(handle), ['run-a', 'run-b']);
  assert.equal((await readCurrentRun(handle, 'run-b')).runId, 'run-b');
});

test('diagnostic listing fails closed on incomplete or corrupt Runs, with one explicit reserved-ID exception', async (t) => {
  const context = await setup(t); await pauseAfterEvidence(context);
  await fails(listRunIds(context.handle), 'STATE_INCOMPLETE');
  assert.deepEqual(await listRunIds(context.handle, { allowIncompleteRunId: 'run-a' }), ['run-a']);
  await fails(listRunIds(context.handle, { allowIncompleteRunId: 'run-b' }), 'STATE_INCOMPLETE');
  await writeFile(join(context.runDir, 'run.json'), '{"revision":');
  await fails(listRunIds(context.handle, { allowIncompleteRunId: 'run-a' }), 'STATE_CORRUPT');
});

test('diagnostic listing rejects unknown state-root entries instead of treating them as task results', async (t) => {
  const { handle, seed, snapshot, project } = await setup(t);
  await initializeRun(handle, seed, snapshot);
  await writeFile(join(project.stateRoot, 'latest-result.json'), '{}');
  await fails(listRunIds(handle), 'STATE_PATH_INVALID');
});
