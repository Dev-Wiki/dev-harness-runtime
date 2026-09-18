import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { parseContract, type ExecutorCapabilities, type HostEnvironment, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { recordName, type RuntimeAdapter, type WorkerReadCatalog } from '@dev-harness-runtime/core';
import { createConfinedCodexBridge } from './executor/confined-bridge.js';
import { runConfinedCodexProcess, type ConfinedCodexProcessOutput } from './executor/confined-process.js';
import type { CodexHostNamespaceResult, CodexHostStartEvidence } from './executor/host-namespace.js';
import type { IsolatedModelHostResult } from './executor/isolated-model-host.js';
import { probeCodexRuntime } from './executor/probe.js';
import { runCodexSession } from './executor/session.js';

export interface CodexRuntimeOptions {
  readonly binary: string;
  readonly bubblewrap: string;
  readonly nodeBinary: string;
  readonly authFile: string;
  readonly serverBundle: string;
  readonly proposalServer: string;
  readonly configHash: string;
  readonly gitVersion: string;
  readonly targetVersion: string;
  readonly timeoutMs: number;
  /** Only trusted host proxy settings are accepted; project and Worker settings are never inherited. */
  readonly modelProxy?: { readonly HTTPS_PROXY?: string; readonly HTTP_PROXY?: string };
}

export class CodexRuntimeError extends Error {
  constructor(readonly code: 'CAPABILITY_MISSING' | 'AUTHORIZATION_VIOLATION' | 'QUIESCENCE_UNKNOWN', message: string) {
    super(message); this.name = 'CodexRuntimeError';
  }
}

interface HostProof {
  readonly namespace: CodexHostNamespaceResult['evidence'];
  readonly broker: IsolatedModelHostResult['brokerAudit'];
}
interface PreparedInvocation {
  readonly request: TaskExecutionRequest;
  readonly prompt: string;
  readonly readCatalog: WorkerReadCatalog;
  readonly log: (stream: 'stdout' | 'stderr' | 'events', bytes: Uint8Array) => Promise<void>;
  readonly recordHostStart: (record: { schemaVersion: 1; [key: string]: unknown }) => Promise<void>;
  hostStart?: { schemaVersion: 1; kind: 'codex-host-start'; namespace: CodexHostStartEvidence; [key: string]: unknown };
  proof?: HostProof;
  output?: ConfinedCodexProcessOutput;
  hostRecord?: { schemaVersion: 1; [key: string]: unknown };
}
const same = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const identity = (request: TaskExecutionRequest): object => ({ runId: request.runId,
  taskId: request.taskId, attempt: request.attempt, requestId: request.requestId });
const keyOf = (request: TaskExecutionRequest): string => `${request.runId}\0${request.requestId}`;
function fail(code: CodexRuntimeError['code'], message: string): never { throw new CodexRuntimeError(code, message); }
const allowedHosts = new Set(['api.openai.com', 'auth.openai.com', 'chatgpt.com']);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function verifyPersistedHostStart(state: { runId: string; currentTaskId?: string; currentAttempt?: number; currentRequestId?: string },
  entry: { ref: { path: string; sha256: string }; bytes: Buffer }): Promise<void> {
  const requestId = state.currentRequestId;
  if (!requestId || entry.ref.path !== `results/run-evidence/${recordName('host-start', requestId)}.json`
    || digest(entry.bytes) !== entry.ref.sha256) {
    fail('QUIESCENCE_UNKNOWN', 'Codex host start record is missing or changed');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)); }
  catch { return fail('QUIESCENCE_UNKNOWN', 'Codex host start record is not JSON'); }
  const record = object(parsed);
  const namespace = object(record?.namespace);
  const nsIds = object(namespace?.namespaceIds);
  if (!record || record.schemaVersion !== 1 || record.kind !== 'codex-host-start'
    || record.runId !== state.runId || record.taskId !== state.currentTaskId
    || record.attempt !== state.currentAttempt || record.requestId !== requestId
    || !namespace || namespace.network !== 'isolated' || namespace.asPid1 !== true
    || typeof namespace.providerSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(namespace.providerSha256)
    || typeof namespace.nodeSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(namespace.nodeSha256)
    || !Number.isSafeInteger(namespace.initPid) || Number(namespace.initPid) < 2
    || typeof namespace.initStartTime !== 'string' || !/^\d+$/u.test(namespace.initStartTime)
    || !nsIds || !['user', 'pid', 'mnt', 'net', 'ipc', 'uts', 'cgroup'].every((name) =>
      Number.isSafeInteger(nsIds[name]) && Number(nsIds[name]) > 0)) {
    fail('QUIESCENCE_UNKNOWN', 'Codex host start identity is malformed');
  }
  const stat = await readFile(`/proc/${namespace.initPid}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  });
  if (stat !== null && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === namespace.initStartTime) {
    fail('QUIESCENCE_UNKNOWN', 'Recorded Codex namespace PID 1 is still live');
  }
}

async function verifyPersistedHost(input: { request: TaskExecutionRequest; beforeHash: string; afterHash: string;
  evidence: readonly { ref: { path: string; sha256: string }; bytes: Buffer }[] }): Promise<{ providerId: string;
    sessionId: string; authorizationEnforced: true; quiescent: true }> {
  const hostEvidence = input.evidence[0];
  if (!hostEvidence || !hostEvidence.ref.path.startsWith('results/run-evidence/host-0-')
    || digest(hostEvidence.bytes) !== hostEvidence.ref.sha256) {
    throw new CodexRuntimeError('AUTHORIZATION_VIOLATION', 'Codex host evidence is missing or changed');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(hostEvidence.bytes)); }
  catch { return fail('AUTHORIZATION_VIOLATION', 'Codex host evidence is not JSON'); }
  const host = object(parsed);
  const namespace = object(host?.namespace);
  const nsIds = object(namespace?.namespaceIds);
  const broker = object(host?.broker);
  const connected = object(broker?.connected);
  if (!host || host.schemaVersion !== 1 || host.kind !== 'codex-confined-host'
    || !same({ runId: host.runId, taskId: host.taskId, attempt: host.attempt, requestId: host.requestId }, identity(input.request))
    || host.beforeHash !== input.beforeHash || host.afterHash !== input.afterHash
    || host.providerId !== 'codex-linux-namespace'
    || typeof host.sessionId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(host.sessionId)
    || !namespace || namespace.network !== 'isolated' || namespace.asPid1 !== true
    || namespace.monitorWaited !== true || typeof namespace.providerSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(namespace.providerSha256)
    || typeof namespace.nodeSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(namespace.nodeSha256)
    || !Number.isSafeInteger(namespace.initPid) || Number(namespace.initPid) < 2
    || typeof namespace.initStartTime !== 'string' || !/^\d+$/u.test(namespace.initStartTime)
    || !nsIds || !['user', 'pid', 'mnt', 'net', 'ipc', 'uts', 'cgroup'].every((name) =>
      Number.isSafeInteger(nsIds[name]) && Number(nsIds[name]) > 0)
    || !broker || !Array.isArray(broker.allowedHosts)
    || !same([...broker.allowedHosts].sort(), [...allowedHosts].sort())
    || !connected || Object.keys(connected).length < 1
    || Object.entries(connected).some(([name, count]) => !allowedHosts.has(name)
      || !Number.isSafeInteger(count) || Number(count) < 1)
    || !Number.isSafeInteger(broker.denied) || Number(broker.denied) < 0
    || !Array.isArray(host.proposalPaths)
    || host.proposalPaths.some((path) => typeof path !== 'string')
    || new Set(host.proposalPaths).size !== host.proposalPaths.length) {
    throw new CodexRuntimeError('AUTHORIZATION_VIOLATION', 'Codex host control receipt is malformed or not isolated');
  }
  const application = host.applicationReceipt;
  if ((host.proposalPaths as string[]).length > 0 && application === undefined) {
    fail('AUTHORIZATION_VIOLATION', 'Codex proposals have no Core application receipt');
  }
  if (application !== undefined) {
    const receipt = object(application);
    const recorded = receipt && input.evidence.find((entry) => same(entry.ref, receipt)
      && digest(entry.bytes) === receipt.sha256);
    let applied: Record<string, unknown> | undefined;
    try { applied = object(JSON.parse(recorded?.bytes.toString('utf8') ?? 'null')); }
    catch { /* The next guard rejects malformed Core evidence. */ }
    if (!receipt || typeof receipt.path !== 'string' || typeof receipt.sha256 !== 'string'
      || !recorded || !applied || applied.kind !== 'core-proposal-apply-receipt'
      || !same({ runId: applied.runId, taskId: applied.taskId, attempt: applied.attempt,
        requestId: applied.requestId }, identity(input.request))
      || applied.beforeSnapshotHash !== input.beforeHash || applied.afterSnapshotHash !== input.afterHash
      || !Array.isArray(applied.paths)
      || !same([...applied.paths].sort(), [...host.proposalPaths].sort())) {
      fail('AUTHORIZATION_VIOLATION', 'Codex proposal application receipt is absent');
    }
  }
  const pid = namespace.initPid as number;
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  });
  if (stat !== null) {
    const observed = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (observed === namespace.initStartTime) fail('QUIESCENCE_UNKNOWN', 'The recorded Codex namespace init is still live');
  }
  return { providerId: 'codex-linux-namespace', sessionId: host.sessionId as string,
    authorizationEnforced: true, quiescent: true };
}

/** Trusted Core integration for the confined Codex transport. */
export function createCodexRuntimeAdapter(options: CodexRuntimeOptions): RuntimeAdapter {
  const prepared = new Map<string, PreparedInvocation>();
  const running = new Set<string>();
  const executing = new Set<string>();
  const usedThreads = new Set<string>();
  const probes = new Map<string, Promise<ExecutorCapabilities>>();
  const recordFor = (request: TaskExecutionRequest): PreparedInvocation => {
    const entry = prepared.get(keyOf(request));
    if (!entry || !same(entry.request, request)) {
      throw new CodexRuntimeError('AUTHORIZATION_VIOLATION', 'Codex invocation is not bound to the Core request');
    }
    return entry;
  };
  return {
    id: 'codex',
    async environment(project) {
      return parseContract('hostEnvironment', { schemaVersion: 1, repoRoot: project.repoRoot,
        privateGitDir: project.privateGitDir, os: process.platform, architecture: process.arch,
        nodeVersion: process.versions.node, gitVersion: options.gitVersion,
        hostExecutable: options.binary, targetVersion: options.targetVersion,
        configHash: options.configHash });
    },
    async prepareInvocation(input) {
      const request = parseContract('taskExecutionRequest', input.request);
      if (prepared.has(keyOf(request)) || input.readCatalog.repoRoot !== request.repoRoot
        || input.readCatalog.runId !== request.runId || input.readCatalog.requestId !== request.requestId
        || input.readCatalog.snapshotHash !== request.snapshotHash) {
        fail('AUTHORIZATION_VIOLATION', 'Codex invocation identity or frozen catalog differs from Core');
      }
      prepared.set(keyOf(request), { request, prompt: input.invocation.prompt,
        readCatalog: input.readCatalog, log: input.log, recordHostStart: input.recordHostStart });
    },
    executor: {
      id: 'codex',
      async probe(environment: HostEnvironment) {
        if (environment.hostExecutable !== options.binary || environment.configHash !== options.configHash
          || environment.targetVersion !== options.targetVersion) {
          fail('AUTHORIZATION_VIOLATION', 'Codex probe environment differs from the trusted runtime configuration');
        }
        const key = JSON.stringify(environment);
        let pending = probes.get(key);
        if (!pending) { pending = probeCodexRuntime(options); probes.set(key, pending); }
        return pending;
      },
      async execute(request, signal) {
        const entry = recordFor(request);
        const key = keyOf(request);
        if (signal.aborted || executing.has(key) || entry.output) {
          fail('AUTHORIZATION_VIOLATION', 'Codex request is cancelled, repeated or already running');
        }
        executing.add(key);
        let started = false;
        try {
          const output = await runCodexSession({ binary: options.binary, nodeBinary: options.nodeBinary,
            proposalServer: options.proposalServer, request, readCatalog: entry.readCatalog,
            prompt: entry.prompt, env: options.modelProxy ?? {}, signal,
            log: (stream, bytes) => entry.log(stream, bytes),
            bridgeProcess: (policyPath) => createConfinedCodexBridge({
              bubblewrap: options.bubblewrap, nodeBinary: options.nodeBinary,
              serverBundle: options.serverBundle, policyPath, readCatalog: entry.readCatalog, parentContained: true }),
            hostProcess: async (processInput, bridge, outputSchema) => {
              started = true; running.add(key);
              const hosted = await runConfinedCodexProcess({ ...processInput, bridge, outputSchema,
                bubblewrap: options.bubblewrap, nodeBinary: options.nodeBinary,
                authFile: options.authFile, timeoutMs: options.timeoutMs,
                onHostStarted: async (namespace) => {
                  const record = { schemaVersion: 1 as const, kind: 'codex-host-start' as const,
                    ...identity(request), namespace };
                  await entry.recordHostStart(record);
                  entry.hostStart = record;
                },
                onHostQuiescent: (namespace, broker) => {
                  entry.proof = { namespace, broker }; running.delete(key);
                } });
              return hosted;
            },
          });
          const proof = entry.proof;
          if (!started || !proof || running.has(key)
            || proof.namespace.network !== 'isolated' || !proof.namespace.monitorWaited
            || Object.values(proof.broker.connected).every((count) => count < 1)
            || usedThreads.has(output.threadId)) {
            throw new CodexRuntimeError('AUTHORIZATION_VIOLATION', 'Codex host did not prove a distinct confined session');
          }
          usedThreads.add(output.threadId);
          entry.output = { ...output, namespaceEvidence: proof.namespace, brokerAudit: proof.broker };
          return output.result;
        } finally { executing.delete(key); }
      },
    },
    async verifyQuiescence({ state, hostStart }) {
      if (running.size > 0) fail('QUIESCENCE_UNKNOWN', 'A Codex host process has no whole-tree quiescence proof');
      if (!state.currentRequestId) return;
      if (hostStart !== undefined) {
        if (!hostStart) fail('QUIESCENCE_UNKNOWN', 'No durable Codex host start record binds this attempt');
        await verifyPersistedHostStart(state, hostStart);
        return;
      }
      const entry = [...prepared.values()].find((item) => item.request.runId === state.runId
        && item.request.requestId === state.currentRequestId);
      if (!entry?.hostStart || !entry.proof) fail('QUIESCENCE_UNKNOWN', 'Codex host ending is not proven in this process');
    },
    async collectProposals({ request, result }) {
      const entry = recordFor(request);
      const output = entry.output;
      if (!output || !same(output.result, result)) {
        throw new CodexRuntimeError('AUTHORIZATION_VIOLATION', 'Codex result and proposals do not match the confined session');
      }
      return output.proposals.map(({ path, content }) => ({ path,
        content: content === null ? null : Buffer.from(content, 'utf8') }));
    },
    async collectEvidence({ request, before, after, application }) {
      const entry = recordFor(request);
      const output = entry.output;
      const proof = entry.proof;
      if (!output || !proof || before.hash !== request.snapshotHash
        || (application && after.hash !== application.ending.hash)) {
        throw new CodexRuntimeError('AUTHORIZATION_VIOLATION', 'Codex host evidence differs from the Core snapshots');
      }
      const record = { schemaVersion: 1 as const, kind: 'codex-confined-host', ...identity(request),
        beforeHash: before.hash, afterHash: after.hash, sessionId: output.threadId,
        providerId: 'codex-linux-namespace', namespace: proof.namespace, broker: proof.broker,
        proposalPaths: output.proposals.map((proposal) => proposal.path),
        ...(application ? { applicationReceipt: application.receiptRef } : {}) };
      entry.hostRecord = record;
      return [record];
    },
    workerControl: { async verify({ state, request, before, after, evidence }) {
      if (state.runId !== request.runId) fail('AUTHORIZATION_VIOLATION', 'Codex receipt belongs to another Run');
      const entry = prepared.get(keyOf(request));
      let observed: unknown;
      try { observed = JSON.parse(evidence[0]?.bytes.toString('utf8') ?? 'null'); }
      catch { fail('AUTHORIZATION_VIOLATION', 'Codex receipt is not JSON'); }
      if (entry && (!same(entry.request, request) || !entry.output || !entry.proof || !entry.hostRecord
        || !same(observed, entry.hostRecord))) {
        fail('AUTHORIZATION_VIOLATION', 'Codex receipt differs from the live host controller');
      }
      return verifyPersistedHost({ request, beforeHash: before.hash, afterHash: after.hash, evidence });
    } },
    async verifyCheckpoint({ state, checkpoint, before, after, request, evidence }) {
      if (checkpoint.stage === 'execute-intent' && checkpoint.kind === 'execute'
        && before.hash === after.hash && checkpoint.resultRef === undefined) return;
      if (checkpoint.stage !== 'worker-ended' || checkpoint.kind !== 'execute' || !request) {
        throw new CodexRuntimeError('AUTHORIZATION_VIOLATION', 'Codex checkpoint is not a controlled Worker ending');
      }
      await verifyPersistedHost({ request, beforeHash: before.hash, afterHash: after.hash, evidence });
      if (state.runId !== request.runId) fail('AUTHORIZATION_VIOLATION', 'Codex checkpoint belongs to another Run');
    },
  };
}
