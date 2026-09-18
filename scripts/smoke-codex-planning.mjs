/** Opt-in Codex/Planning smoke. The model sees only a temporary synthetic Git fixture. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, posix } from 'node:path';
import { createCodexRuntimeAdapter } from '../packages/adapter-codex/dist/index.js';
import { Registry } from '../packages/core/dist/registry.js';
import { startRuntimeRun } from '../packages/core/dist/orchestrator/runtime.js';
import { git, setupRuntimeFixture } from '../tests/fixtures/fake-executor/fixture.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
async function executable() {
  if (process.env.DHR_CODEX_BINARY) {
    assert.ok(isAbsolute(process.env.DHR_CODEX_BINARY));
    await access(process.env.DHR_CODEX_BINARY);
    return realpath(process.env.DHR_CODEX_BINARY);
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, 'codex');
    if (await access(candidate).then(() => true, () => false)) return realpath(candidate);
  }
  throw new Error('Codex CLI is unavailable');
}

async function taskPlan(root, request) {
  const p = request.scope.planning;
  const source = await readFile(join(root, p.taskPath), 'utf8');
  let archive = source.replaceAll('- [ ]', '- [x]').replaceAll(/\]\(([^)]+)\)/gu, (_match, href) =>
    `](${posix.relative(posix.dirname(p.archivePath), posix.normalize(posix.join(posix.dirname(p.taskPath), href)))})`);
  archive = archive.replace('尚未执行；实施后记录实际证据。',
    `通过，见 [本次验证](../../../verification/${request.taskId}.md)。`);
  archive += '\n## 完成验收结果\n\n当前任务验收候选完成，等待 Core 独立验证。\n';
  const index = await readFile(join(root, p.archiveIndexPath), 'utf8');
  const indexAfter = `${index}| ${request.taskId} | 2026-09-17 | 当前任务验收候选完成 | [${request.taskId}](${request.taskId}.md) |\n`;
  let dashboard = await readFile(join(root, p.dashboardPath), 'utf8');
  let order = 0;
  dashboard = dashboard.split('\n').filter((line) => !line.startsWith(`| ${request.taskId} — `)
    && !new RegExp(`^\\d+\\. \\[${request.taskId} — `, 'u').test(line))
    .map((line) => /^\d+\. \[/u.test(line) ? line.replace(/^\d+/u, String(++order)) : line).join('\n');
  dashboard = dashboard.replaceAll(`](tasks/${request.taskId}.md)`, `](archive/M1/${request.taskId}.md)`)
    .replace('## 近期完成\n\n', `## 近期完成\n\n- [${request.taskId}](archive/M1/${request.taskId}.md) 当前任务验收完成。\n`);
  const operations = [
    { path: p.archivePath, content: archive },
    { path: p.taskPath, content: null },
    { path: `docs/verification/${request.taskId}.md`, content: '# Verification\nFixture Worker declaration; Core must independently re-run the frozen command.\n' },
    { path: p.archiveIndexPath, content: indexAfter },
    { path: p.dashboardPath, content: dashboard },
  ];
  const beforeHash = async (path) => readFile(join(root, path)).then(digest, (error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const changes = [];
  for (const path of [p.taskPath, p.archivePath, p.archiveIndexPath, p.dashboardPath]) {
    const operation = operations.find((candidate) => candidate.path === path);
    assert.ok(operation);
    changes.push({ path, beforeHash: await beforeHash(path),
      afterHash: operation.content === null ? null : digest(Buffer.from(operation.content)) });
  }
  const result = { schemaVersion: 1, runId: request.runId, taskId: request.taskId,
    attempt: request.attempt, requestId: request.requestId, snapshotHash: request.snapshotHash,
    summary: `Synthetic Planning closure for ${request.taskId}; Core must independently verify.`,
    verification: [], changedFiles: operations.map((operation) => operation.path).sort(),
    rawResultRef: null, outcome: 'completed', needsPlanning: false, reason: null, commitIntent: null,
    closure: { schemaVersion: 1, ...p, summary: 'Current Task only', changes } };
  return { operations, result };
}

function threadIds(events) {
  return events.split('\n').filter(Boolean).flatMap((line) => {
    try { const event = JSON.parse(line); return event.type === 'thread.started' ? [event.thread_id] : []; }
    catch { return []; }
  });
}

assert.equal(process.argv.length, 2, 'The Codex Planning smoke does not accept arguments');
assert.ok(process.env.DHR_TEST_BWRAP && isAbsolute(process.env.DHR_TEST_BWRAP),
  'Set DHR_TEST_BWRAP to a trusted absolute bubblewrap path');
const cleanups = [];
const t = { after: (cleanup) => cleanups.push(cleanup) };
try {
  const f = await setupRuntimeFixture(t);
  const binary = await executable();
  const configHash = f.services.adapterConfigHash;
  const real = createCodexRuntimeAdapter({ binary,
    bubblewrap: await realpath(process.env.DHR_TEST_BWRAP), nodeBinary: process.execPath,
    authFile: await realpath(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')),
    serverBundle: await realpath(new URL('../packages/adapter-codex/dist/executor/bridge.bundle.mjs', import.meta.url)),
    proposalServer: await realpath(new URL('../packages/adapter-codex/dist/executor/mcp-server.js', import.meta.url)),
    configHash, gitVersion: (await git(f.root, '--version')).replace('git version ', ''),
    targetVersion: 'local-codex', timeoutMs: 120_000,
    modelProxy: { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY } });
  const adapter = { ...real,
    async prepareInvocation(input) {
      const plan = await taskPlan(f.root, input.request);
      const instruction = '\n\n## Synthetic fixture controller instructions\n'
        + 'This is a disposable synthetic Git fixture. Do not use any native tools. '
        + 'Call dhr_propose_text once for each operation with non-null content, and dhr_propose_delete once for each null operation. '
        + 'Pass the exact path and content; do not edit the working tree yourself. '
        + 'After all five proposal receipts, return exactly the JSON object below. '
        + 'The empty verification array is intentional: do not invent private log references. Core will independently run its frozen command.\n'
        + `${JSON.stringify({ operations: plan.operations })}\n`
        + `FINAL_JSON=${JSON.stringify({ result: plan.result })}\n`;
      return real.prepareInvocation({ ...input,
        invocation: { ...input.invocation, prompt: input.invocation.prompt + instruction } });
    } };
  const adapters = new Registry(); adapters.register(adapter);
  const skill = Buffer.from('---\nname: worker\ndescription: synthetic Planning closure smoke\n---\n\n'
    + 'Work only on the current synthetic Task with the dhr_propose_text and dhr_propose_delete tools. '
    + 'Follow the appended fixture controller instructions exactly.\n');
  const services = { ...f.services, adapters, workerSkill: { bytes: skill, sha256: digest(skill) } };
  const head = await git(f.root, 'rev-parse', 'HEAD');
  const runId = 'codex-planning-smoke';
  const run = await startRuntimeRun({ cwd: f.root, adapter: 'codex', selection: { mode: 'all-ready' }, runId }, services);
  const eventPaths = ['A', 'B', 'C'].map((id) => join(f.project.stateRoot, runId, 'attempts', `${id}-1`, 'events.jsonl'));
  const threads = [];
  for (const path of eventPaths) {
    const ids = threadIds(await readFile(path, 'utf8').catch(() => ''));
    if (ids.length === 1) threads.push(ids[0]);
  }
  assert.equal(run.exitCode, 0, JSON.stringify({ stopReason: run.state.stopReason, threads }));
  assert.equal(run.state.status, 'COMPLETED');
  assert.deepEqual(run.state.completedTasks, ['A', 'B', 'C']);
  assert.equal(threads.length, 3);
  assert.equal(new Set(threads).size, 3);
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(f.root, 'diff', '--cached', '--name-only'), '');
  for (const entry of run.state.resultRefs) {
    const accepted = JSON.parse(await readFile(join(f.project.stateRoot, runId, entry.ref.path), 'utf8'));
    assert.equal(accepted.outcome, 'completed');
    assert.equal(accepted.verification.length, 1);
    const independent = JSON.parse(await readFile(join(f.project.stateRoot, runId,
      accepted.verification[0].stdout.path), 'utf8'));
    assert.equal(Buffer.from(independent.bytes, 'base64').toString(), 'INDEPENDENT_CORE_CHECK');
  }
  const dashboard = await readFile(join(f.root, 'docs/plan/Dashboard.md'), 'utf8');
  assert.ok(!dashboard.includes('(tasks/'));
  assert.ok(dashboard.includes('archive/M1/C.md'));
  process.stdout.write(`${JSON.stringify({ status: 'passed', completedTasks: run.state.completedTasks,
    distinctThreads: threads.length, independentVerification: true, syntheticOnly: true })}\n`);
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
