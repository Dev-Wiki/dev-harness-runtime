/** Opt-in synthetic Codex host smoke. Never run from pnpm verify. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodexSession } from '../packages/adapter-codex/dist/executor/session.js';
import { createConfinedCodexBridge } from '../packages/adapter-codex/dist/executor/confined-bridge.js';
import { runConfinedCodexProcess } from '../packages/adapter-codex/dist/executor/confined-process.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const fixture = new URL('../packages/contracts/fixtures/execution/request.json', import.meta.url);
const server = fileURLToPath(new URL('../packages/adapter-codex/dist/executor/mcp-server.js', import.meta.url));
const serverBundle = fileURLToPath(new URL('../packages/adapter-codex/dist/executor/bridge.bundle.mjs', import.meta.url));
assert.equal(process.argv.length, 2, 'The host smoke does not accept arguments');

async function binary() {
  if (process.env.DHR_CODEX_BINARY) {
    assert.ok(isAbsolute(process.env.DHR_CODEX_BINARY), 'DHR_CODEX_BINARY must be absolute');
    await access(process.env.DHR_CODEX_BINARY, constants.X_OK);
    return realpath(process.env.DHR_CODEX_BINARY);
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter((item) => isAbsolute(item))) {
    const path = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (await access(path, constants.X_OK).then(() => true, () => false)) return realpath(path);
  }
  throw new Error('Set DHR_CODEX_BINARY to the absolute Codex CLI path');
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-codex-host-smoke-')));
try {
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'HELLO');
  const original = JSON.parse(await readFile(fixture, 'utf8'));
  const request = { ...original, repoRoot: root, docsRoot: join(root, 'docs'),
    dashboardPath: join(root, 'docs/plan/Dashboard.md'), taskPath: join(root, 'docs/plan/tasks/K1.md'),
    scope: { ...original.scope, files: ['src/a.ts'] } };
  const catalog = { repoRoot: root, runId: request.runId, requestId: request.requestId,
    snapshotHash: request.snapshotHash, files: [{ path: 'src/a.ts', sha256: hash('HELLO') }] };
  const expected = { result: { schemaVersion: 1, runId: request.runId, taskId: request.taskId,
    attempt: request.attempt, requestId: request.requestId, snapshotHash: request.snapshotHash,
    summary: 'Synthetic bridge smoke.', verification: [], changedFiles: ['src/a.ts'],
    rawResultRef: null, outcome: 'blocked', needsPlanning: false, reason: 'Synthetic smoke only.', closure: null } };
  const prompt = `This is a synthetic bridge test in an isolated temporary directory. First call dhr_list_paths with {"prefix":"src","after":""}. Then call dhr_search_text with {"query":"ELL","prefix":"src","after":""}. Then call dhr_read_text with {"path":"src/a.ts","offset":0}. Then call dhr_propose_text with {"path":"src/a.ts","content":"UPDATED"}. Do not use any other tools. Finally return exactly this JSON object: ${JSON.stringify(expected)}`;
  const logs = { events: [], stderr: [] };
  const env = { HOME: homedir(), PATH: process.platform === 'win32' ? process.env.PATH ?? '' : '/usr/bin:/bin',
    LANG: 'C.UTF-8', ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
    ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}) };
  const confined = process.env.DHR_TEST_BWRAP;
  const hostNamespace = process.env.DHR_TEST_CODEX_HOST === '1';
  assert.ok(!hostNamespace || confined, 'DHR_TEST_CODEX_HOST requires DHR_TEST_BWRAP');
  const authFile = hostNamespace ? await realpath(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')) : undefined;
  let result;
  try {
    result = await runCodexSession({ binary: await binary(), nodeBinary: process.execPath,
      proposalServer: server, request, readCatalog: catalog, prompt, env,
      ...(confined ? { bridgeProcess: (policyPath) => createConfinedCodexBridge({
        bubblewrap: confined, nodeBinary: process.execPath, serverBundle, policyPath, readCatalog: catalog,
        parentContained: hostNamespace,
      }) } : {}),
      ...(hostNamespace ? { hostProcess: (processInput, bridge, outputSchema) => runConfinedCodexProcess({
        ...processInput, bubblewrap: confined, nodeBinary: process.execPath, authFile, outputSchema,
        timeoutMs: 120_000, bridge,
      }) } : {}),
      signal: AbortSignal.timeout(120_000),
      log: async (stream, bytes) => { logs[stream].push(Buffer.from(bytes)); } });
  } catch (error) {
    const eventLines = Buffer.concat(logs.events).toString('utf8').split('\n').filter(Boolean);
    const calls = eventLines.map((line) => JSON.parse(line)).filter((event) => event.item?.type === 'mcp_tool_call')
      .map((event) => ({ event: event.type, tool: event.item.tool, status: event.item.status,
        error: event.item.error }));
    process.stderr.write(`${JSON.stringify({ calls,
      stderr: Buffer.concat(logs.stderr).toString('utf8').slice(-4000) })}\n`);
    throw error;
  }
  const events = Buffer.concat(logs.events).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const tools = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call')
    .map((event) => event.item.tool);
  assert.deepEqual(tools, ['dhr_list_paths', 'dhr_search_text', 'dhr_read_text', 'dhr_propose_text'],
    `Codex MCP calls missing; stderr=${Buffer.concat(logs.stderr).toString('utf8').slice(-4000)}`);
  assert.deepEqual(result.proposals, [{ path: 'src/a.ts', content: 'UPDATED' }]);
  assert.equal(result.result.outcome, 'blocked');
  assert.deepEqual(result.result.changedFiles, ['src/a.ts']);
  assert.equal(await readFile(join(root, 'src/a.ts'), 'utf8'), 'HELLO');
  process.stdout.write(`${JSON.stringify({ status: 'passed', threadId: result.threadId,
    tools, outcome: result.result.outcome, proposalCount: result.proposals.length,
    worktreeUnchanged: true, confinedBridge: Boolean(confined), hostNamespace,
    hostQuiescence: result.namespaceEvidence ? 'confirmed' : 'unproven' })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
