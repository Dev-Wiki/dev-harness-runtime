import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runConfinedDshSession } from '../packages/adapter-dsh/dist/executor/confined-session.js';

const execute = promisify(execFile);
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for the explicit DSH host smoke`);
  return value;
};
const dshEntry = await realpath(required('DHR_TEST_DSH_ENTRY'));
const artifact = await realpath(required('DHR_TEST_DSH_PACKAGE'));
const bubblewrap = await realpath(required('DHR_TEST_BWRAP'));
const apiKey = required('DEEPSEEK_API_KEY');
const nodeBinary = await realpath(process.execPath);
const pluginSha256 = createHash('sha256').update(await readFile(
  new URL('../packages/adapter-dsh/dist/plugin.bundle.js', import.meta.url),
)).digest('hex');
const stage = await mkdtemp(join(tmpdir(), 'dhr-dsh-runtime-smoke-'));
let retain = false;
let diagnostic = '';
try {
  await execute(dshEntry, ['plugin', '--profile', 'headless', 'add', artifact,
    '--offline', '--ignore-scripts', '--strict-peer-dependencies=false', '--store-dir', join(stage, 'store')], {
    cwd: stage, env: { PATH: process.env.PATH ?? '/usr/bin', HOME: process.env.HOME ?? stage,
      DSH_HOME: stage }, maxBuffer: 1024 * 1024,
  });
  await mkdir(join(stage, 'repo'), { mode: 0o700 });
  const repoRoot = await realpath(join(stage, 'repo'));
  await mkdir(join(repoRoot, 'src'), { mode: 0o700 });
  await writeFile(join(repoRoot, 'src/a.ts'), 'BEFORE\n', { flag: 'wx' });
  const fixtureRoot = new URL('../packages/contracts/fixtures/execution/', import.meta.url);
  const requestFixture = JSON.parse(await readFile(new URL('request.json', fixtureRoot), 'utf8'));
  const resultFixture = JSON.parse(await readFile(new URL('result-blocked.json', fixtureRoot), 'utf8'));
  const request = { ...requestFixture, repoRoot, docsRoot: join(repoRoot, 'docs'),
    dashboardPath: join(repoRoot, 'docs/plan/Dashboard.md'), taskPath: join(repoRoot, 'docs/plan/tasks/K1.md'),
    env: { ...requestFixture.env, DEV_HARNESS_ADAPTER: 'dsh' } };
  const result = { ...resultFixture, changedFiles: ['src/a.ts'] };
  const prompt = `Synthetic confined DSH Task. In order, call dhr_identity with {}, dhr_list_paths with {"prefix":"src","after":""}, dhr_read_text with {"path":"src/a.ts","offset":0}, dhr_search_text with {"query":"BEFORE","prefix":"src","after":""}, and dhr_propose_delete with {"path":"src/a.ts"}. Do not use any other tool. Then return exactly this JSON object: ${JSON.stringify(result)}`;
  const starts = []; const logBytes = { stdout: 0, stderr: 0, events: 0 };
  let eventLog = '';
  const output = await runConfinedDshSession({ dshEntry,
    profileDirectory: join(stage, 'profiles/headless'), bubblewrap, nodeBinary, apiKey, pluginSha256,
    request, readCatalog: { repoRoot, runId: request.runId, requestId: request.requestId,
      snapshotHash: request.snapshotHash,
      files: [{ path: 'src/a.ts', sha256: createHash('sha256').update('BEFORE\n').digest('hex') }] },
    prompt, signal: new AbortController().signal, timeoutMs: 120000,
    log: async (stream, bytes) => { logBytes[stream] += bytes.byteLength;
      if (stream === 'stderr') diagnostic += Buffer.from(bytes).toString('utf8');
      if (stream === 'events') eventLog += Buffer.from(bytes).toString('utf8'); },
    recordHostStart: async (evidence) => { starts.push(evidence); },
  });
  assert.equal(starts.length, 1);
  assert.equal(output.namespaceEvidence.network, 'isolated');
  assert.equal(output.namespaceEvidence.monitorWaited, true);
  assert.deepEqual(output.brokerAudit.allowedHosts, ['api.deepseek.com']);
  assert.ok(output.brokerAudit.connected['api.deepseek.com'] > 0);
  assert.equal(output.brokerAudit.denied, 0);
  assert.equal(output.result.outcome, 'blocked');
  assert.deepEqual(output.proposals, [{ path: 'src/a.ts', content: null }]);
  assert.equal(await readFile(join(repoRoot, 'src/a.ts'), 'utf8'), 'BEFORE\n');
  assert.ok(logBytes.events > 0 && logBytes.stdout > 0);
  const toolCalls = eventLog.trim().split('\n').map((line) => JSON.parse(line))
    .filter((event) => event.type === 'tool/call').map((event) => event.data.name);
  assert.deepEqual(toolCalls, ['dhr_identity', 'dhr_list_paths', 'dhr_read_text', 'dhr_search_text', 'dhr_propose_delete']);
  process.stdout.write(`${JSON.stringify({ sessionId: output.sessionId, outcome: output.result.outcome,
    proposals: output.proposals.length, hostStarted: starts.length,
    network: output.namespaceEvidence.network, quiescent: output.namespaceEvidence.monitorWaited,
    modelConnections: output.brokerAudit.connected['api.deepseek.com'], toolCalls, logBytes })}\n`);
} catch (error) {
  retain = error?.code === 'QUIESCENCE_UNKNOWN';
  if (diagnostic) process.stderr.write(diagnostic.slice(-8192));
  throw error;
} finally {
  if (!retain) await rm(stage, { recursive: true, force: true });
}
