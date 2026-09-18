import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCodexRuntimeAdapter } from '../dist/index.js';
import { Registry } from '../../../packages/core/dist/registry.js';
import { recordName } from '../../../packages/core/dist/result/frozen.js';
import { runtimeAdapter } from '../../../packages/core/dist/orchestrator/runtime.js';
import { setupRuntimeFixture } from '../../../tests/fixtures/fake-executor/fixture.mjs';

const hash = 'a'.repeat(64);
const options = { binary: '/usr/bin/codex', bubblewrap: '/usr/bin/bwrap', nodeBinary: process.execPath,
  authFile: '/tmp/nonexistent-auth', serverBundle: '/tmp/nonexistent-bundle',
  proposalServer: '/tmp/nonexistent-server', configHash: hash, gitVersion: '2.50.0',
  targetVersion: '0.154.0', timeoutMs: 60_000 };

test('Codex RuntimeAdapter refuses Core execution when its real host probe fails', async (t) => {
  const f = await setupRuntimeFixture(t);
  const adapter = createCodexRuntimeAdapter({ ...options, configHash: f.services.adapterConfigHash });
  const registry = new Registry(); registry.register(adapter);
  const environment = await adapter.environment(f.project);
  assert.equal(environment.repoRoot, f.root);
  assert.equal(environment.privateGitDir, f.project.privateGitDir);
  const capabilities = await adapter.executor.probe(environment);
  assert.equal(capabilities.authorizationEnforced, false);
  assert.equal(capabilities.available, false);
  await assert.rejects(runtimeAdapter({ ...f.services, adapters: registry }, f.project, 'codex'),
    { code: 'CAPABILITY_MISSING' });
});

test('Codex RuntimeAdapter binds the Core request and frozen catalog before starting a host', async () => {
  const adapter = createCodexRuntimeAdapter(options);
  const request = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/execution/request.json', import.meta.url)));
  const readCatalog = { repoRoot: request.repoRoot, runId: request.runId,
    requestId: request.requestId, snapshotHash: request.snapshotHash, files: [] };
  const prepared = { request, invocation: { prompt: 'SYNTHETIC', env: request.env, skillSha256: hash },
    readCatalog, log: async () => {}, recordHostStart: async () => {} };
  await assert.rejects(adapter.prepareInvocation({ ...prepared,
    readCatalog: { ...readCatalog, requestId: 'other' } }), { code: 'AUTHORIZATION_VIOLATION' });
  await adapter.prepareInvocation(prepared);
  await assert.rejects(adapter.prepareInvocation(prepared), { code: 'AUTHORIZATION_VIOLATION' });
  await assert.rejects(adapter.collectProposals({ request: { ...request, requestId: 'other' },
    result: {} }), { code: 'AUTHORIZATION_VIOLATION' });
});

test('fresh process refuses unknown Codex host and checks durable PID 1 identity', async () => {
  const adapter = createCodexRuntimeAdapter(options);
  const request = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/execution/request.json', import.meta.url)));
  const state = { runId: request.runId, currentTaskId: request.taskId,
    currentAttempt: request.attempt, currentRequestId: request.requestId };
  const record = { schemaVersion: 1, kind: 'codex-host-start',
    runId: request.runId, taskId: request.taskId, attempt: request.attempt, requestId: request.requestId,
    namespace: { providerSha256: hash, nodeSha256: hash, initPid: 999999999, initStartTime: '1',
      namespaceIds: Object.fromEntries(['user', 'pid', 'mnt', 'net', 'ipc', 'uts', 'cgroup'].map((name) => [name, 100])),
      network: 'isolated', asPid1: true } };
  const evidence = (value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    return { ref: { path: `results/run-evidence/${recordName('host-start', request.requestId)}.json`,
      sha256: createHash('sha256').update(bytes).digest('hex') }, bytes };
  };
  await assert.rejects(adapter.verifyQuiescence({ state, hostStart: null }), { code: 'QUIESCENCE_UNKNOWN' });
  await assert.rejects(adapter.verifyQuiescence({ state }), { code: 'QUIESCENCE_UNKNOWN' });
  await adapter.verifyQuiescence({ state, hostStart: evidence(record) });
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  await assert.rejects(adapter.verifyQuiescence({ state, hostStart: evidence({ ...record,
    namespace: { ...record.namespace, initPid: process.pid, initStartTime: start } }) }),
  { code: 'QUIESCENCE_UNKNOWN' });
  await assert.rejects(adapter.verifyQuiescence({ state, hostStart: evidence({ ...record, requestId: 'other' }) }),
    { code: 'QUIESCENCE_UNKNOWN' });
});

test('Codex persisted host verifier checks isolation, source identity and namespace liveness', async () => {
  const adapter = createCodexRuntimeAdapter(options);
  const request = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/execution/request.json', import.meta.url)));
  const applied = { schemaVersion: 1, kind: 'core-proposal-apply-receipt', runId: request.runId,
    taskId: request.taskId, attempt: request.attempt, requestId: request.requestId,
    beforeSnapshotHash: request.snapshotHash, afterSnapshotHash: request.snapshotHash,
    paths: ['src/a.ts'] };
  const appliedBytes = Buffer.from(JSON.stringify(applied));
  const appliedRef = { schemaVersion: 1, path: 'results/run-evidence/apply-receipt-request-a.json',
    sha256: createHash('sha256').update(appliedBytes).digest('hex') };
  const record = { schemaVersion: 1, kind: 'codex-confined-host', runId: request.runId,
    taskId: request.taskId, attempt: request.attempt, requestId: request.requestId,
    beforeHash: request.snapshotHash, afterHash: request.snapshotHash,
    providerId: 'codex-linux-namespace', sessionId: '12345678-1234-1234-1234-123456789abc',
    namespace: { providerSha256: hash, nodeSha256: hash, initPid: 999999999,
      initStartTime: '1', namespaceIds: Object.fromEntries(
        ['user', 'pid', 'mnt', 'net', 'ipc', 'uts', 'cgroup'].map((name) => [name, 100])),
      network: 'isolated', asPid1: true, monitorWaited: true },
    broker: { allowedHosts: ['api.openai.com', 'auth.openai.com', 'chatgpt.com'],
      connected: { 'chatgpt.com': 2 }, denied: 1 }, proposalPaths: ['src/a.ts'],
    applicationReceipt: appliedRef };
  const evidence = (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return [{ ref: { schemaVersion: 1, path: 'results/run-evidence/host-0-request-a.json',
      sha256: createHash('sha256').update(bytes).digest('hex') }, bytes },
    { ref: appliedRef, bytes: appliedBytes }];
  };
  const input = { state: { runId: request.runId }, request,
    before: { hash: request.snapshotHash }, after: { hash: request.snapshotHash }, evidence: evidence(record) };
  assert.deepEqual(await adapter.workerControl.verify(input), {
    providerId: 'codex-linux-namespace', sessionId: record.sessionId,
    authorizationEnforced: true, quiescent: true });
  await assert.rejects(adapter.workerControl.verify({ ...input,
    evidence: evidence({ ...record, namespace: { ...record.namespace, network: 'shared' } }) }),
  { code: 'AUTHORIZATION_VIOLATION' });
  await assert.rejects(adapter.workerControl.verify({ ...input,
    evidence: evidence({ ...record, applicationReceipt: undefined }) }),
  { code: 'AUTHORIZATION_VIOLATION' });
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  await assert.rejects(adapter.workerControl.verify({ ...input,
    evidence: evidence({ ...record, namespace: { ...record.namespace, initPid: process.pid, initStartTime: start } }) }),
  { code: 'QUIESCENCE_UNKNOWN' });
});
