import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { parseContract } from '../../../packages/contracts/dist/index.js';
import { Registry } from '../../../packages/core/dist/registry.js';
import { discoverProject } from '../../../packages/core/dist/discovery/index.js';
import { parseMarkdown, section } from '../../../packages/core/dist/planning/markdown.js';
import { createLinuxSandbox } from '../../../packages/core/dist/authorization/sandbox.js';
import { captureSnapshot, serializeSnapshot, snapshotBoundaryHash } from '../../../packages/core/dist/snapshot/capture.js';
import { compareSnapshots } from '../../../packages/core/dist/snapshot/guard.js';
import { createPlanningFixture } from '../../../packages/core/tests/result/helpers-planning.mjs';

const execute = promisify(execFile);
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function git(root, ...args) { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim(); }
async function write(root, path, bytes) { const dest = join(root, path); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, bytes); }
const identity = (request) => ({ runId: request.runId, taskId: request.taskId, attempt: request.attempt, requestId: request.requestId });
const fileHash = (snapshot, path) => snapshot.paths.find((entry) => entry.path === path && entry.type === 'file')?.rawContentHash ?? null;
export const realSandbox = { skip: process.platform !== 'linux' ? 'Linux sandbox fixture only' : !process.env.DHR_TEST_BWRAP ? 'Requires explicit real bubblewrap installation' : false };

/** Core interface fixture, never evidence of a real Agent host's isolation or fresh sessions. */
export async function setupRuntimeFixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-runtime-e2e-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = (await createPlanningFixture()).beforeFiles;
  const command = [process.execPath, '-e', options.commandSource ?? 'process.stdout.write("INDEPENDENT_CORE_CHECK")'];
  const commandText = command.map((arg) => `'${arg.replaceAll("'", "'\"'\"'")}'`).join(' ');
  documents.set('HARNESS.md', Buffer.from('# HARNESS\n\n## 已确认命令\n\n| 用途 | 命令 | 状态 |\n|---|---|---|\n'
    + `| full | \`${commandText}\` | confirmed |\n`));
  documents.set('AGENTS.md', Buffer.from('# Rules\n\n[Git workflow](docs/GIT_WORKFLOW.md).\n'));
  documents.set('docs/plan/Dashboard.md', Buffer.from(documents.get('docs/plan/Dashboard.md').toString()
    .replace('| C — 任务 | 🟢 P2 | 📋 规划中 | B |', '| C — 任务 | 🟢 P2 | 🟢 待执行 | [B](tasks/B.md) |')));
  for (const id of ['A', 'B', 'C']) {
    const path = `docs/plan/tasks/${id}.md`;
    documents.set(path, Buffer.from(documents.get(path).toString().replace('`pnpm test`', `\`${commandText}\``)));
  }
  const seed = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/state/run-created.json', import.meta.url), 'utf8'));
  const probe = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/execution/capabilities.json', import.meta.url), 'utf8'));
  probe.adapterId = 'fixture-runtime'; probe.pluginPackaging = false;
  probe.evidence = probe.evidence.filter((entry) => entry.capability !== 'pluginPackaging');
  for (const evidence of probe.evidence) {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, capability: evidence.capability,
      limitation: 'Controlled in-process Core fixture only; does not prove any real Agent host capability.' }));
    evidence.ref.sha256 = hash(bytes); documents.set(evidence.ref.path, bytes);
  }
  if (options.capabilityFalse) { probe[options.capabilityFalse] = false; probe.reasons.push(`Fixture disables ${options.capabilityFalse}`); }
  for (const [path, bytes] of documents) await write(root, path, bytes);
  await git(root, 'init', '--quiet', '-b', 'main'); await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false'); await git(root, 'add', '.'); await git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture input');
  const project = await discoverProject(root);
  const executions = []; const receipts = new Map(); const invocations = new Map(); const acceptanceRequests = [];
  const behavior = { ...options };
  const capture = (runId) => captureSnapshot({ project, runId, protocolSource: seed.protocolSource, adapterConfigHash: seed.adapterConfigHash });
  async function original(request) {
    // Controller-only read of Core evidence: the fixture Worker never receives a private write capability.
    const bytes = await readFile(join(project.stateRoot, request.runId, request.snapshotRef)); assert.equal(hash(bytes), request.snapshotHash);
    const snapshot = parseContract('snapshot', JSON.parse(bytes));
    return { snapshot, hash: hash(serializeSnapshot(snapshot)), boundaryHash: snapshotBoundaryHash(snapshot), dirtyPaths: snapshot.dirtyPaths, stagedPaths: snapshot.stagedPaths };
  }
  async function closeTask(request) {
    const p = request.scope.planning;
    const source = await readFile(join(root, p.taskPath), 'utf8');
    let archive = source.replaceAll('- [ ]', '- [x]').replaceAll(/\]\(([^)]+)\)/gu, (_match, href) =>
      `](${posix.relative(posix.dirname(p.archivePath), posix.normalize(posix.join(posix.dirname(p.taskPath), href)))})`);
    archive = archive.replace('尚未执行；实施后记录实际证据。', `通过，见 [本次验证](../../../verification/${request.taskId}.md)。`);
    archive += '\n## 完成验收结果\n\n当前任务验收候选完成，等待 Core 独立验证。\n';
    if (behavior.invalidClosure) archive = archive.replace('- [x]', '- [ ]');
    await write(root, p.archivePath, archive); await rm(join(root, p.taskPath));
    await write(root, `docs/verification/${request.taskId}.md`, '# Verification\nFixture Worker declaration; Core must independently re-run the frozen command.\n');
    const index = await readFile(join(root, p.archiveIndexPath), 'utf8');
    await write(root, p.archiveIndexPath, `${index}| ${request.taskId} | 2026-09-17 | 当前任务验收候选完成 | [${request.taskId}](${request.taskId}.md) |\n`);
    let dashboard = await readFile(join(root, p.dashboardPath), 'utf8');
    let order = 0;
    dashboard = dashboard.split('\n').filter((line) => !line.startsWith(`| ${request.taskId} — `)
      && !new RegExp(`^\\d+\\. \\[${request.taskId} — `, 'u').test(line)).map((line) => /^\d+\. \[/u.test(line) ? line.replace(/^\d+/u, String(++order)) : line).join('\n');
    dashboard = dashboard.replaceAll(`](tasks/${request.taskId}.md)`, `](archive/M1/${request.taskId}.md)`)
      .replace('## 近期完成\n\n', `## 近期完成\n\n- [${request.taskId}](archive/M1/${request.taskId}.md) 当前任务验收完成。\n`);
    await write(root, p.dashboardPath, dashboard);
  }
  const adapter = {
    id: 'fixture-runtime',
    async environment() { return { schemaVersion: 1, repoRoot: root, privateGitDir: project.privateGitDir, os: process.platform,
      architecture: process.arch, nodeVersion: process.versions.node, gitVersion: (await git(root, '--version')).replace('git version ', ''),
      hostExecutable: null, targetVersion: 'fixture-interface-only', configHash: seed.adapterConfigHash }; },
    async prepareInvocation(input) { invocations.set(input.request.requestId, input); },
    executor: {
      id: 'fixture-runtime', async probe() { return structuredClone(probe); },
      async execute(request, signal) {
        const prepared = invocations.get(request.requestId); assert.ok(prepared); assert.deepEqual(prepared.request, request);
        const sessionId = `fixture-session-${executions.length + 1}`;
        executions.push({ request: structuredClone(request), sessionId });
        signal.throwIfAborted();
        if (behavior.cancelFirst && executions.length === 1) { behavior.cancelController.abort(); signal.throwIfAborted(); }
        const before = await original(request); const startedAt = new Date().toISOString();
        const outcome = behavior.outcome ?? 'completed';
        if (outcome === 'completed') await closeTask(request);
        const ending = await capture(request.runId);
        const claim = Buffer.from(`Fixture Worker claim for ${request.taskId}; this is not independent Core acceptance.\n`);
        await prepared.log('stdout', claim); await prepared.log('stderr', Buffer.alloc(0));
        await prepared.log('events', Buffer.from(`${JSON.stringify({ sessionId, ...identity(request) })}\n`));
        const ref = (name, bytes) => ({ schemaVersion: 1, path: `attempts/${request.taskId}-${request.attempt}/${name}.log`, sha256: hash(bytes) });
        const result = { schemaVersion: 1, ...identity(request), snapshotHash: request.snapshotHash, outcome,
          summary: `Fixture ${outcome}`, needsPlanning: false, changedFiles: compareSnapshots(before.snapshot, ending.snapshot).contentPaths,
          verification: outcome === 'completed' ? [{ schemaVersion: 1, ...identity(request), id: 'check', acceptanceIds: ['functional', 'verification'],
            kind: 'command', argv: command, cwd: '.', result: 'passed', exitCode: 0, startedAt, finishedAt: new Date().toISOString(),
            beforeSnapshotHash: before.hash, afterSnapshotHash: ending.hash, stdout: ref('stdout', claim), stderr: ref('stderr', Buffer.alloc(0)) }] : [],
          ...(outcome === 'completed' ? { closure: { schemaVersion: 1, ...request.scope.planning, summary: 'Current Task only',
            changes: ['taskPath', 'archivePath', 'archiveIndexPath', 'dashboardPath'].map((key) => { const path = request.scope.planning[key]; return { path,
              beforeHash: fileHash(before.snapshot, path), afterHash: fileHash(ending.snapshot, path) }; }) } } : { reason: `Fixture requested ${outcome}` }) };
        return parseContract('taskExecutionResult', result);
      },
    },
    async collectEvidence({ request, before, after }) {
      assert.deepEqual(invocations.get(request.requestId).request, request); assert.equal(before.hash, request.snapshotHash);
      const execution = executions.find((entry) => entry.request.requestId === request.requestId); assert.ok(execution);
      const record = { schemaVersion: 1, kind: 'fixture-runtime-controller-receipt', ...identity(request),
        beforeHash: before.hash, afterHash: after.hash, sessionId: execution.sessionId, providerId: 'fixture-runtime-controller',
        authorizationEnforced: true, quiescent: true, limitation: 'Core interface fixture only; does not prove real Agent host isolation.' };
      receipts.set(request.requestId, structuredClone(record));
      if (behavior.cancelAfterWorker) behavior.cancelController.abort();
      return [record];
    },
    workerControl: { async verify({ state, request, before, after, evidence }) {
      assert.deepEqual(invocations.get(request.requestId).request, request);
      assert.equal(state.runId, request.runId); assert.deepEqual(state.pendingOperation.identity, identity(request));
      const record = receipts.get(request.requestId); assert.ok(record); assert.equal(before.hash, record.beforeHash); assert.equal(after.hash, record.afterHash);
      assert.equal(evidence.length, 1); assert.equal(hash(evidence[0].bytes), evidence[0].ref.sha256); assert.deepEqual(JSON.parse(evidence[0].bytes), record);
      assert.match(evidence[0].ref.path, /^results\/run-evidence\/host-0-/u);
      acceptanceRequests.push(request.requestId);
      return { providerId: record.providerId, sessionId: record.sessionId, authorizationEnforced: true, quiescent: true };
    } },
    async verifyQuiescence() { /* All fixture writes are awaited; there is no Agent child process. */ },
    async verifyCheckpoint({ checkpoint, evidence }) {
      assert.ok(invocations.has(checkpoint.identity.requestId));
      if (checkpoint.stage === 'worker-ended') assert.deepEqual(JSON.parse(evidence[0].bytes), receipts.get(checkpoint.identity.requestId));
    },
  };
  const adapters = new Registry(); adapters.register(adapter);
  const workerBytes = await readFile(new URL('../../../skills/worker/SKILL.md', import.meta.url));
  const sandbox = process.env.DHR_TEST_BWRAP ? await createLinuxSandbox({ binaryPath: process.env.DHR_TEST_BWRAP,
    toolchainMounts: [dirname(process.execPath)], path: `${dirname(process.execPath)}:/usr/bin:/bin` }) : {};
  const services = { protocolSource: seed.protocolSource, adapterConfigHash: seed.adapterConfigHash,
    workerSkill: { bytes: workerBytes, sha256: hash(workerBytes) }, adapters, acceptance: { sandbox },
    async prepareTask({ task, before }) {
      const taskPath = `docs/plan/tasks/${task.id}.md`;
      const packet = parseMarkdown(await readFile(join(root, taskPath), 'utf8'), taskPath);
      const criteria = section(packet, '验收标准').filter((token) => token.type === 'inline' && /^\[[ xX]\]/u.test(token.content))
        .map((token, index) => ({ id: ['functional', 'verification'][index], text: token.content.replace(/^\[[ xX]\]\s+/u, '') }));
      return { scope: { schemaVersion: 1, files: [`docs/verification/${task.id}.md`], directories: [], planning: { taskId: task.id, taskPath,
        archivePath: `docs/plan/archive/M1/${task.id}.md`, archiveIndexPath: 'docs/plan/archive/M1/README.md', dashboardPath: 'docs/plan/Dashboard.md' } },
      acceptance: criteria, verificationPlan: { schemaVersion: 1, sources: ['HARNESS.md', taskPath].map((path) => ({ path, sha256: fileHash(before.snapshot, path) })),
        commands: [{ id: 'check', acceptanceIds: criteria.map((entry) => entry.id), argv: command, cwd: '.', writableArtifacts: [] }], manual: [] } };
    },
  };
  return { root, project, services, adapter, executions, acceptanceRequests, behavior, command };
}
