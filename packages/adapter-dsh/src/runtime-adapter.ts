import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { parseContract, type ExecutorCapabilities, type HostEnvironment, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { recordName, type HostNamespaceResult, type HostStartEvidence, type IsolatedModelHostResult,
  type RuntimeAdapter, type WorkerReadCatalog } from '@dev-harness-runtime/core';
import { runConfinedDshSession, type DshConfinedSessionOutput } from './executor/confined-session.js';
import { probeDshRuntime } from './executor/probe.js';

export interface DshRuntimeOptions {
  readonly dshEntry: string;
  readonly profileDirectory: string;
  readonly bubblewrap: string;
  readonly nodeBinary: string;
  readonly apiKey: string;
  readonly pluginSha256: string;
  readonly upstreamProxy?: string;
  readonly configHash: string;
  readonly gitVersion: string;
  readonly targetVersion: string;
  readonly timeoutMs: number;
}
export class DshRuntimeError extends Error {
  constructor(readonly code: 'CAPABILITY_MISSING' | 'AUTHORIZATION_VIOLATION' | 'QUIESCENCE_UNKNOWN', message: string) {
    super(message); this.name = 'DshRuntimeError';
  }
}
interface HostProof {
  readonly namespace: HostNamespaceResult['evidence'];
  readonly broker: IsolatedModelHostResult['brokerAudit'];
}
interface PreparedInvocation {
  readonly request: TaskExecutionRequest;
  readonly prompt: string;
  readonly readCatalog: WorkerReadCatalog;
  readonly log: (stream: 'stdout' | 'stderr' | 'events', bytes: Uint8Array) => Promise<void>;
  readonly recordHostStart: (record: { schemaVersion: 1; [key: string]: unknown }) => Promise<void>;
  hostStart?: { schemaVersion: 1; kind: 'dsh-host-start'; namespace: HostStartEvidence; [key: string]: unknown };
  proof?: HostProof;
  output?: DshConfinedSessionOutput;
  hostRecord?: { schemaVersion: 1; [key: string]: unknown };
}
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const identity = (request: TaskExecutionRequest): object => ({ runId: request.runId,
  taskId: request.taskId, attempt: request.attempt, requestId: request.requestId });
const keyOf = (request: TaskExecutionRequest): string => `${request.runId}\0${request.requestId}`;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function fail(code: DshRuntimeError['code'], message: string): never { throw new DshRuntimeError(code, message); }
const sessionPattern = /^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

function validNamespace(value: unknown, ended: boolean): boolean {
  const ns = object(value);
  const ids = object(ns?.namespaceIds);
  return !!ns && ns.network === 'isolated' && ns.asPid1 === true
    && (!ended || ns.monitorWaited === true)
    && typeof ns.providerSha256 === 'string' && hashPattern.test(ns.providerSha256)
    && typeof ns.nodeSha256 === 'string' && hashPattern.test(ns.nodeSha256)
    && Number.isSafeInteger(ns.initPid) && Number(ns.initPid) > 1
    && typeof ns.initStartTime === 'string' && /^\d+$/u.test(ns.initStartTime)
    && !!ids && ['user', 'pid', 'mnt', 'net', 'ipc', 'uts', 'cgroup'].every((name) =>
      Number.isSafeInteger(ids[name]) && Number(ids[name]) > 0);
}
async function assertPidGone(namespace: Record<string, unknown>): Promise<void> {
  const stat = await readFile(`/proc/${namespace.initPid}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  });
  if (stat !== null && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === namespace.initStartTime) {
    fail('QUIESCENCE_UNKNOWN', 'Recorded DSH namespace PID 1 is still live');
  }
}
async function verifyPersistedHostStart(state: { runId: string; currentTaskId?: string;
  currentAttempt?: number; currentRequestId?: string }, entry: { ref: { path: string; sha256: string }; bytes: Buffer }): Promise<void> {
  const requestId = state.currentRequestId;
  if (!requestId || entry.ref.path !== `results/run-evidence/${recordName('host-start', requestId)}.json`
    || digest(entry.bytes) !== entry.ref.sha256) fail('QUIESCENCE_UNKNOWN', 'DSH host start record is missing or changed');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)); }
  catch { return fail('QUIESCENCE_UNKNOWN', 'DSH host start record is not JSON'); }
  const record = object(parsed);
  if (!record || record.schemaVersion !== 1 || record.kind !== 'dsh-host-start'
    || record.runId !== state.runId || record.taskId !== state.currentTaskId
    || record.attempt !== state.currentAttempt || record.requestId !== requestId
    || !validNamespace(record.namespace, false)) fail('QUIESCENCE_UNKNOWN', 'DSH host start identity is malformed');
  await assertPidGone(object(record.namespace)!);
}
async function verifyPersistedHost(input: { request: TaskExecutionRequest; beforeHash: string; afterHash: string;
  evidence: readonly { ref: { path: string; sha256: string }; bytes: Buffer }[] }): Promise<{
    providerId: string; sessionId: string; authorizationEnforced: true; quiescent: true }> {
  const hostEvidence = input.evidence[0];
  if (!hostEvidence || !hostEvidence.ref.path.startsWith('results/run-evidence/host-0-')
    || digest(hostEvidence.bytes) !== hostEvidence.ref.sha256) {
    fail('AUTHORIZATION_VIOLATION', 'DSH host evidence is missing or changed');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(hostEvidence.bytes)); }
  catch { return fail('AUTHORIZATION_VIOLATION', 'DSH host evidence is not JSON'); }
  const host = object(parsed);
  const broker = object(host?.broker);
  const connected = object(broker?.connected);
  if (!host || host.schemaVersion !== 1 || host.kind !== 'dsh-confined-host'
    || !same({ runId: host.runId, taskId: host.taskId, attempt: host.attempt, requestId: host.requestId }, identity(input.request))
    || host.beforeHash !== input.beforeHash || host.afterHash !== input.afterHash
    || host.providerId !== 'dsh-linux-namespace' || typeof host.sessionId !== 'string'
    || !sessionPattern.test(host.sessionId) || !validNamespace(host.namespace, true)
    || !broker || !same(broker.allowedHosts, ['api.deepseek.com'])
    || !connected || Object.keys(connected).length !== 1
    || !Number.isSafeInteger(connected['api.deepseek.com']) || Number(connected['api.deepseek.com']) < 1
    || broker.denied !== 0 || !Array.isArray(host.proposalPaths)
    || host.proposalPaths.some((path) => typeof path !== 'string')
    || new Set(host.proposalPaths).size !== host.proposalPaths.length) {
    fail('AUTHORIZATION_VIOLATION', 'DSH host control receipt is malformed or not isolated');
  }
  const application = host.applicationReceipt;
  if ((host.proposalPaths as string[]).length > 0 && application === undefined) {
    fail('AUTHORIZATION_VIOLATION', 'DSH proposals have no Core application receipt');
  }
  if (application !== undefined) {
    const receipt = object(application);
    const recorded = receipt && input.evidence.find((entry) => same(entry.ref, receipt)
      && digest(entry.bytes) === receipt.sha256);
    let applied: Record<string, unknown> | undefined;
    try { applied = object(JSON.parse(recorded?.bytes.toString('utf8') ?? 'null')); }
    catch { /* The guard below rejects malformed Core evidence. */ }
    if (!receipt || typeof receipt.path !== 'string' || typeof receipt.sha256 !== 'string'
      || !recorded || !applied || applied.kind !== 'core-proposal-apply-receipt'
      || !same({ runId: applied.runId, taskId: applied.taskId, attempt: applied.attempt,
        requestId: applied.requestId }, identity(input.request))
      || applied.beforeSnapshotHash !== input.beforeHash || applied.afterSnapshotHash !== input.afterHash
      || !Array.isArray(applied.paths)
      || !same([...applied.paths].sort(), [...(host.proposalPaths as string[])].sort())) {
      fail('AUTHORIZATION_VIOLATION', 'DSH proposal application receipt is absent');
    }
  }
  await assertPidGone(object(host.namespace)!);
  return { providerId: 'dsh-linux-namespace', sessionId: host.sessionId as string,
    authorizationEnforced: true, quiescent: true };
}

/** Trusted Core integration for the confined DSH transport. */
export function createDshRuntimeAdapter(options: DshRuntimeOptions): RuntimeAdapter {
  const prepared = new Map<string, PreparedInvocation>();
  const running = new Set<string>();
  const executing = new Set<string>();
  const usedSessions = new Set<string>();
  const probes = new Map<string, Promise<ExecutorCapabilities>>();
  const recordFor = (request: TaskExecutionRequest): PreparedInvocation => {
    const entry = prepared.get(keyOf(request));
    if (!entry || !same(entry.request, request)) fail('AUTHORIZATION_VIOLATION', 'DSH invocation is not bound to the Core request');
    return entry;
  };
  return {
    id: 'dsh',
    async environment(project) {
      return parseContract('hostEnvironment', { schemaVersion: 1, repoRoot: project.repoRoot,
        privateGitDir: project.privateGitDir, os: process.platform, architecture: process.arch,
        nodeVersion: process.versions.node, gitVersion: options.gitVersion,
        hostExecutable: options.dshEntry, targetVersion: options.targetVersion,
        configHash: options.configHash });
    },
    async prepareInvocation(input) {
      const request = parseContract('taskExecutionRequest', input.request);
      if (prepared.has(keyOf(request)) || input.readCatalog.repoRoot !== request.repoRoot
        || input.readCatalog.runId !== request.runId || input.readCatalog.requestId !== request.requestId
        || input.readCatalog.snapshotHash !== request.snapshotHash) {
        fail('AUTHORIZATION_VIOLATION', 'DSH invocation identity or frozen catalog differs from Core');
      }
      prepared.set(keyOf(request), { request, prompt: input.invocation.prompt,
        readCatalog: input.readCatalog, log: input.log, recordHostStart: input.recordHostStart });
    },
    executor: {
      id: 'dsh',
      async probe(environment: HostEnvironment) {
        if (environment.hostExecutable !== options.dshEntry || environment.configHash !== options.configHash
          || environment.targetVersion !== options.targetVersion) {
          fail('AUTHORIZATION_VIOLATION', 'DSH probe environment differs from the trusted runtime configuration');
        }
        const key = JSON.stringify(environment);
        let pending = probes.get(key);
        if (!pending) { pending = probeDshRuntime(options); probes.set(key, pending); }
        return pending;
      },
      async execute(request, signal) {
        const entry = recordFor(request);
        const key = keyOf(request);
        if (signal.aborted || executing.has(key) || entry.output) {
          fail('AUTHORIZATION_VIOLATION', 'DSH request is cancelled, repeated or already running');
        }
        executing.add(key);
        try {
          const output = await runConfinedDshSession({ ...options, request,
            readCatalog: entry.readCatalog, prompt: entry.prompt, signal,
            log: entry.log,
            recordHostStart: async (namespace) => {
              const record = { schemaVersion: 1 as const, kind: 'dsh-host-start' as const,
                ...identity(request), namespace };
              await entry.recordHostStart(record);
              entry.hostStart = record;
              running.add(key);
            },
            onHostQuiescent: (namespace, broker) => {
              entry.proof = { namespace, broker }; running.delete(key);
            } });
          const proof = entry.proof;
          if (!entry.hostStart || !proof || running.has(key)
            || proof.namespace.network !== 'isolated' || !proof.namespace.monitorWaited
            || proof.broker.denied !== 0 || !proof.broker.connected['api.deepseek.com']
            || usedSessions.has(output.sessionId)) {
            fail('AUTHORIZATION_VIOLATION', 'DSH host did not prove a distinct confined Session');
          }
          usedSessions.add(output.sessionId);
          entry.output = output;
          return output.result;
        } finally { executing.delete(key); }
      },
    },
    async verifyQuiescence({ state, hostStart }) {
      if (running.size > 0) fail('QUIESCENCE_UNKNOWN', 'A DSH host process has no whole-tree quiescence proof');
      if (!state.currentRequestId) return;
      if (hostStart !== undefined) {
        if (!hostStart) fail('QUIESCENCE_UNKNOWN', 'No durable DSH host start record binds this attempt');
        await verifyPersistedHostStart(state, hostStart);
        return;
      }
      const entry = [...prepared.values()].find((item) => item.request.runId === state.runId
        && item.request.requestId === state.currentRequestId);
      if (!entry?.hostStart || !entry.proof) fail('QUIESCENCE_UNKNOWN', 'DSH host ending is not proven in this process');
    },
    async collectProposals({ request, result }) {
      const entry = recordFor(request);
      if (!entry.output || !same(entry.output.result, result)) {
        fail('AUTHORIZATION_VIOLATION', 'DSH result and proposals do not match the confined Session');
      }
      return entry.output.proposals.map(({ path, content }) => ({ path,
        content: content === null ? null : Buffer.from(content, 'utf8') }));
    },
    async collectEvidence({ request, before, after, application }) {
      const entry = recordFor(request);
      if (!entry.output || !entry.proof || before.hash !== request.snapshotHash
        || (application && after.hash !== application.ending.hash)) {
        fail('AUTHORIZATION_VIOLATION', 'DSH host evidence differs from the Core snapshots');
      }
      const record = { schemaVersion: 1 as const, kind: 'dsh-confined-host', ...identity(request),
        beforeHash: before.hash, afterHash: after.hash, sessionId: entry.output.sessionId,
        providerId: 'dsh-linux-namespace', namespace: entry.proof.namespace, broker: entry.proof.broker,
        proposalPaths: entry.output.proposals.map((proposal) => proposal.path),
        ...(application ? { applicationReceipt: application.receiptRef } : {}) };
      entry.hostRecord = record;
      return [record];
    },
    workerControl: { async verify({ state, request, before, after, evidence }) {
      if (state.runId !== request.runId) fail('AUTHORIZATION_VIOLATION', 'DSH receipt belongs to another Run');
      const entry = prepared.get(keyOf(request));
      let observed: unknown;
      try { observed = JSON.parse(evidence[0]?.bytes.toString('utf8') ?? 'null'); }
      catch { fail('AUTHORIZATION_VIOLATION', 'DSH receipt is not JSON'); }
      if (entry && (!same(entry.request, request) || !entry.output || !entry.proof || !entry.hostRecord
        || !same(observed, entry.hostRecord))) {
        fail('AUTHORIZATION_VIOLATION', 'DSH receipt differs from the live host controller');
      }
      return verifyPersistedHost({ request, beforeHash: before.hash, afterHash: after.hash, evidence });
    } },
    async verifyCheckpoint({ state, checkpoint, before, after, request, evidence }) {
      if (checkpoint.stage === 'execute-intent' && checkpoint.kind === 'execute'
        && before.hash === after.hash && checkpoint.resultRef === undefined) return;
      if (checkpoint.stage !== 'worker-ended' || checkpoint.kind !== 'execute' || !request) {
        fail('AUTHORIZATION_VIOLATION', 'DSH checkpoint is not a controlled Worker ending');
      }
      await verifyPersistedHost({ request, beforeHash: before.hash, afterHash: after.hash, evidence });
      if (state.runId !== request.runId) fail('AUTHORIZATION_VIOLATION', 'DSH checkpoint belongs to another Run');
    },
  };
}
