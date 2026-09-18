/** Opt-in real Codex smoke using only a synthetic, temporary Git project and Worker Skill. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { createCodexRuntimeAdapter } from '../packages/adapter-codex/dist/index.js';
import { Registry } from '../packages/core/dist/registry.js';
import { dispatchTask, runtimeAdapter } from '../packages/core/dist/orchestrator/runtime.js';
import { setupAcceptance } from '../packages/core/tests/result/helpers-acceptance.mjs';

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

assert.equal(process.argv.length, 2, 'The Codex Runtime smoke does not accept arguments');
assert.ok(process.env.DHR_TEST_BWRAP && isAbsolute(process.env.DHR_TEST_BWRAP),
  'Set DHR_TEST_BWRAP to a trusted absolute bubblewrap path');
const cleanups = [];
const testContext = { after: (cleanup) => cleanups.push(cleanup) };
try {
  const f = await setupAcceptance(testContext, { initialFiles: { 'src/a.ts': 'HELLO' }, scopeFiles: ['src/a.ts'] });
  const binary = await executable();
  const adapter = createCodexRuntimeAdapter({ binary,
    bubblewrap: await realpath(process.env.DHR_TEST_BWRAP), nodeBinary: process.execPath,
    authFile: await realpath(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')),
    serverBundle: await realpath(new URL('../packages/adapter-codex/dist/executor/bridge.bundle.mjs', import.meta.url)),
    proposalServer: await realpath(new URL('../packages/adapter-codex/dist/executor/mcp-server.js', import.meta.url)),
    configHash: f.run.adapterConfigHash, gitVersion: 'synthetic-fixture', targetVersion: 'local-codex',
    timeoutMs: 120_000,
    modelProxy: { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY } });
  const request = f.request;
  const expected = { result: { schemaVersion: 1, runId: request.runId, taskId: request.taskId,
    attempt: request.attempt, requestId: request.requestId, snapshotHash: request.snapshotHash,
    summary: 'Synthetic Runtime integration smoke.', verification: [], changedFiles: ['src/a.ts'],
    rawResultRef: null, outcome: 'blocked', needsPlanning: false,
    reason: 'Synthetic Runtime integration smoke only.', closure: null } };
  const skill = Buffer.from(`---\nname: worker\ndescription: synthetic Runtime integration smoke\n---\n\nThis is a synthetic, temporary Git project. First call dhr_list_paths with {"prefix":"src","after":""}. Then call dhr_search_text with {"query":"ELL","prefix":"src","after":""}. Then call dhr_read_text with {"path":"src/a.ts","offset":0}. Then call dhr_propose_text with {"path":"src/a.ts","content":"UPDATED"}. Do not use any other tools. Finally return exactly this JSON object: ${JSON.stringify(expected)}\n`);
  const adapters = new Registry(); adapters.register(adapter);
  const services = { protocolSource: f.run.protocolSource, adapterConfigHash: f.run.adapterConfigHash,
    workerSkill: { bytes: skill, sha256: digest(skill) }, adapters, acceptance: {} };
  const checked = await runtimeAdapter(services, f.project, 'codex');
  let state;
  try {
    state = await dispatchTask(f.handle, f.project, f.run, request, f.requestRef,
      f.frozenInputsRef, services, checked);
  } catch (error) {
    const stderr = await readFile(f.attemptPaths.stderrPath, 'utf8').catch(() => '');
    const events = await readFile(f.attemptPaths.eventsPath, 'utf8').catch(() => '');
    const calls = events.split('\n').filter(Boolean).flatMap((line) => {
      try { const item = JSON.parse(line).item; return item?.type === 'mcp_tool_call'
        ? [{ tool: item.tool, status: item.status, error: item.error }] : []; }
      catch { return []; }
    });
    const messages = stderr.split('\n').filter((line) => /\b(?:error|failed|invalid|denied)\b/iu.test(line))
      .map((line) => line.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{12,}/gu, '[REDACTED]').slice(0, 300))
      .slice(-8);
    process.stderr.write(`${JSON.stringify({ calls, stderrMessages: messages })}\n`);
    throw error;
  }
  assert.equal(state.status, 'BLOCKED');
  assert.equal(await readFile(join(f.root, 'src/a.ts'), 'utf8'), 'UPDATED');
  assert.equal(state.resultRefs.length, 1);
  process.stdout.write(`${JSON.stringify({ status: 'passed', hostProbe: true,
    coreAppliedProposal: true, outcome: state.status, syntheticOnly: true })}\n`);
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
