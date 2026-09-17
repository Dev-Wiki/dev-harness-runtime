import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseContract } from '@dev-harness-runtime/contracts';
import { discoverProject } from '../../dist/discovery/index.js';
import { acquireLock, releaseLock } from '../../dist/lock/index.js';
import { parseMarkdown, section } from '../../dist/planning/markdown.js';
import { captureSnapshot } from '../../dist/snapshot/capture.js';
import { compareSnapshots } from '../../dist/snapshot/guard.js';
import {
  compareAndSwapRun, createAttempt, ensureRunEvidence, initializeRun, readEvidence, readCurrentRun, writeResult, writeSnapshot,
} from '../../dist/state/index.js';
import { freezeAcceptanceInputs } from '../../dist/result/frozen.js';
import { createPlanningFixture, digest } from './helpers-planning.mjs';

const execute = promisify(execFile);
async function git(root, ...args) { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim(); }
async function write(root, path, bytes) { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
const bindIdentity = (value) => ({ runId: value.runId, taskId: value.taskId, attempt: value.attempt, requestId: value.requestId });
const fileHash = (snapshot, path) => {
  const entry = snapshot.paths.find((entry) => entry.path === path);
  return entry?.type === 'file' ? entry.rawContentHash : null;
};

/** Real Git and snapshot fixtures. The receipt below tests a Core interface, not Agent isolation. */
export async function setupAcceptance(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-acceptance-')));
  let handle;
  t.after(async () => { if (handle) await releaseLock(handle).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const planningFixture = await createPlanningFixture();
  const command = [...(options.command ?? [process.execPath, '-e', 'process.stdout.write("verified")'])];
  const commandText = command.map((argument) => `'${argument.replaceAll("'", "'\"'\"'")}'`).join(' ');
  const harness = Buffer.from('# HARNESS\n\n## 已确认命令\n\n| 用途 | 命令 | 状态 |\n|---|---|---|\n'
    + `| full | \`${commandText}\` | confirmed |\n`);
  const agents = Buffer.from('# Project rules\n\n[Git workflow](docs/GIT_WORKFLOW.md).\n');
  for (const files of [planningFixture.beforeFiles, planningFixture.afterFiles]) {
    files.set('HARNESS.md', Buffer.from(harness)); files.set('AGENTS.md', Buffer.from(agents));
    for (const [path, bytes] of Object.entries(options.initialFiles ?? {})) files.set(path, Buffer.from(bytes));
  }
  for (const [path, bytes] of planningFixture.beforeFiles) await write(root, path, bytes);
  await git(root, 'init', '-q'); await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false'); await git(root, 'add', '.'); await git(root, 'commit', '-q', '--no-gpg-sign', '-m', 'before Worker');
  const project = await discoverProject(root);
  const template = JSON.parse(await readFile(new URL('../../../contracts/fixtures/state/run-created.json', import.meta.url), 'utf8'));
  const taskPath = planningFixture.scope.planning.taskPath;
  const before = await captureSnapshot({ project, runId: template.runId, protocolSource: template.protocolSource,
    adapterConfigHash: template.adapterConfigHash, currentTaskPath: join(root, taskPath) });
  // Discard the helper's synthetic captures; only these real Git captures may enter acceptance.
  planningFixture.before = before; delete planningFixture.after; delete planningFixture.closure;
  handle = await acquireLock(project, { runId: template.runId, adapter: 'codex' });
  const { initialUserChangesRef: _i, initialUserChangesHash: _ih, acceptedSnapshotRef: _a, acceptedSnapshotHash: _ah, ...seed } = template;
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const initial = await initializeRun(handle, { ...seed, repoIdentity: before.snapshot.repoIdentity,
    authorization: { ...seed.authorization, commit: options.commit ?? 'deny' },
    selectionMode: { mode: 'explicit', taskId: 'A' }, createdAt, updatedAt: createdAt }, before.snapshot);
  const identity = { runId: initial.runId, taskId: 'A', attempt: 1, requestId: 'request-a' };
  const scope = structuredClone(planningFixture.scope);
  scope.files = [...new Set([...scope.files, ...(options.scopeFiles ?? [])])];
  const startedAt = new Date().toISOString();
  const run = await compareAndSwapRun(handle, initial.runId, 0, { ...initial, revision: 1, status: 'RUNNING', phase: 'EXECUTE',
    currentTaskId: 'A', currentAttempt: 1, currentRequestId: identity.requestId, updatedAt: startedAt,
    pendingOperation: { schemaVersion: 1, operationId: 'execute-a', kind: 'execute', identity, scope,
      beforeSnapshotRef: initial.acceptedSnapshotRef, beforeSnapshotHash: initial.acceptedSnapshotHash, createdAt: startedAt } });
  const attemptPaths = await createAttempt(handle, initial.runId, run.revision, identity);
  const packet = parseMarkdown(planningFixture.beforeFiles.get(taskPath).toString('utf8'), join(root, taskPath));
  const acceptance = section(packet, '验收标准').filter((token) => token.type === 'inline' && /^\[[ xX]\]\s+/u.test(token.content))
    .map((token, index) => ({ id: `A${index + 1}`, text: token.content.replace(/^\[[ xX]\]\s+/u, '').trim() }));
  const request = parseContract('taskExecutionRequest', { schemaVersion: 1, coreProtocolVersion: 1, ...identity,
    repoRoot: project.repoRoot, docsRoot: project.docsRoot, dashboardPath: project.dashboardPath, taskPath: join(root, taskPath),
    snapshotRef: initial.acceptedSnapshotRef.path, snapshotHash: initial.acceptedSnapshotHash, scope,
    authorization: { ...run.authorization, commit: 'deny' }, protocolSource: run.protocolSource,
    verificationPlan: { schemaVersion: 1, sources: ['HARNESS.md', taskPath, ...(options.verificationSources ?? [])].map((path) => ({ path, sha256: fileHash(before.snapshot, path) })),
      commands: [{ id: 'check', acceptanceIds: acceptance.map((criterion) => criterion.id), argv: command, cwd: '.', writableArtifacts: [...(options.writableArtifacts ?? [])] }],
      manual: options.manualReview ? [{ id: 'review', acceptanceIds: acceptance.map((criterion) => criterion.id), description: 'Fixture independent user review' }] : [] },
    env: { DEV_HARNESS_WORKER: '1', DEV_HARNESS_RUN_ID: identity.runId, DEV_HARNESS_TASK_ID: 'A', DEV_HARNESS_ADAPTER: 'codex' } });
  const frozenInputsRef = await freezeAcceptanceInputs(handle, { expectedRevision: run.revision, request, acceptance });
  const requestRef = await ensureRunEvidence(handle, run.runId, run.revision, 'fixture-request', request);
  let finished = false;

  async function finishWorker(options = {}) {
    assert.equal(finished, false, 'Each fixture represents one Worker ending'); finished = true;
    const files = options.files ?? planningFixture.afterFiles;
    for (const path of planningFixture.beforeFiles.keys()) if (!files.has(path)) await rm(join(root, path));
    for (const [path, bytes] of files) await write(root, path, bytes);
    const ending = await captureSnapshot({ project, runId: run.runId, protocolSource: run.protocolSource, adapterConfigHash: run.adapterConfigHash,
      currentTaskPath: join(root, scope.planning.archivePath) });
    const endingSnapshotRef = await writeSnapshot(handle, run.runId, run.revision, identity, 'worker-ending', ending.snapshot);
    // These are explicitly Worker fixture claims. Acceptance must still execute its own Core verification.
    const stdoutBytes = Buffer.from('Fixture Worker-reported verification; not Core acceptance evidence.\n');
    const stderrBytes = Buffer.alloc(0);
    await writeFile(attemptPaths.stdoutPath, stdoutBytes); await writeFile(attemptPaths.stderrPath, stderrBytes);
    const logRef = (name, bytes) => ({ schemaVersion: 1, path: `attempts/A-1/${name}.log`, sha256: digest(bytes) });
    const paths = ['taskPath', 'archivePath', 'archiveIndexPath', 'dashboardPath'].map((key) => scope.planning[key]);
    const changedFiles = compareSnapshots(before.snapshot, ending.snapshot).paths;
    const candidate = { schemaVersion: 1, ...identity, snapshotHash: before.hash, outcome: 'completed', needsPlanning: false,
      summary: 'Fixture Worker reports Task A closure', changedFiles,
      verification: [{ schemaVersion: 1, ...identity, id: 'check', acceptanceIds: acceptance.map((criterion) => criterion.id),
        kind: 'command', argv: command, cwd: '.', exitCode: 0, result: 'passed', startedAt, finishedAt: new Date().toISOString(),
        beforeSnapshotHash: before.hash, afterSnapshotHash: ending.hash, stdout: logRef('stdout', stdoutBytes), stderr: logRef('stderr', stderrBytes) }],
      closure: { schemaVersion: 1, ...scope.planning, summary: 'Task A archived in the authorized milestone',
        changes: paths.map((path) => ({ path, beforeHash: fileHash(before.snapshot, path), afterHash: fileHash(ending.snapshot, path) })) } };
    // This claimed confirmation is deliberately a Worker log, never independent user approval.
    for (const manual of request.verificationPlan.manual) candidate.verification.push({ schemaVersion: 1, ...identity,
      id: manual.id, acceptanceIds: [...manual.acceptanceIds], kind: 'manual', reviewer: 'fixture-worker-claim',
      confirmation: logRef('stdout', stdoutBytes), result: 'passed', startedAt, finishedAt: new Date().toISOString(),
      beforeSnapshotHash: before.hash, afterSnapshotHash: ending.hash });
    if (options.mutateResult) options.mutateResult(candidate);
    const result = parseContract('taskExecutionResult', candidate);
    planningFixture.after = ending; planningFixture.closure = result.closure;
    const resultRef = await writeResult(handle, run.runId, run.revision, result);
    const proof = { schemaVersion: 1, kind: 'fixture-core-worker-receipt', ...identity, beforeSnapshotHash: before.hash, afterSnapshotHash: ending.hash,
      providerId: 'fixture-provider', sessionId: 'fresh-fixture-session', authorizationEnforced: true, quiescent: true,
      limitation: 'Core service interface fixture; does not prove any real Agent host isolation' };
    const proofRef = await ensureRunEvidence(handle, run.runId, run.revision, 'fixture-worker-proof', proof);
    const proofBytes = await readEvidence(handle, run.runId, run.revision, proofRef);
    const workerControl = { verify: async ({ state, request: supplied, before: left, after: right, evidence }) => {
      assert.deepEqual(bindIdentity(supplied), identity, 'Fixture receipt request identity mismatch');
      assert.deepEqual(supplied, request, 'Fixture receipt must bind the exact original request and scope');
      assert.deepEqual({ runId: state.runId, taskId: state.currentTaskId, attempt: state.currentAttempt, requestId: state.currentRequestId }, identity, 'Fixture receipt state identity mismatch');
      assert.equal(left.hash, before.hash, 'Fixture receipt before hash mismatch');
      assert.equal(right.hash, ending.hash, 'Fixture receipt ending hash mismatch');
      const matches = evidence.filter((item) => item.ref.path === proofRef.path);
      assert.equal(matches.length, 1, 'Fixture receipt must be explicitly supplied once');
      assert.deepEqual(matches[0].ref, proofRef, 'Fixture receipt reference mismatch');
      assert.deepEqual(matches[0].bytes, proofBytes, 'Fixture receipt bytes mismatch');
      assert.equal(digest(matches[0].bytes), proofRef.sha256);
      return { providerId: 'fixture-provider', sessionId: 'fresh-fixture-session', authorizationEnforced: true, quiescent: true };
    } };
    return { result, resultRef, ending, endingSnapshotRef, proofRef, workerEvidenceRefs: [proofRef], workerControl,
      beforeFiles: planningFixture.beforeFiles, afterFiles: files };
  }
  return { root, project, handle, run, request, before, acceptance, frozenInputsRef, requestRef,
    planningFixture, command, commandText, attemptPaths, finishWorker, readRun: () => readCurrentRun(handle, run.runId) };
}
