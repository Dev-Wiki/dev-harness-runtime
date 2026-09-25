import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractValidationError, parseContract, type ExecutorCapabilities, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { runIsolatedModelHost, type WorkerReadCatalog } from '@dev-harness-runtime/core';
import { runConfinedDshSession, type DshConfinedSessionOutput } from './confined-session.js';

export interface DshProbeOptions {
  readonly dshEntry: string;
  readonly profileDirectory: string;
  readonly bubblewrap: string;
  readonly nodeBinary: string;
  readonly apiKey: string;
  readonly pluginSha256: string;
  readonly upstreamProxy?: string;
  readonly targetVersion: string;
  readonly timeoutMs: number;
}

const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function dshProbeRequestFor(root: string): TaskExecutionRequest {
  const runId = 'dsh-probe';
  return parseContract('taskExecutionRequest', { schemaVersion: 1, coreProtocolVersion: 1,
    runId, taskId: 'Probe', attempt: 1, requestId: 'dsh-probe-1', repoRoot: root,
    docsRoot: join(root, 'docs'), dashboardPath: join(root, 'docs/plan/Dashboard.md'),
    taskPath: join(root, 'docs/plan/tasks/Probe.md'),
    snapshotRef: 'attempts/Probe-1/snapshots/before.json', snapshotHash: hash('PROBE_SNAPSHOT'),
    scope: { schemaVersion: 1, files: ['src/a.ts'], directories: [], planning: {
      taskId: 'Probe', taskPath: 'docs/plan/tasks/Probe.md',
      archivePath: 'docs/plan/archive/V1/Probe.md', archiveIndexPath: 'docs/plan/archive/V1/README.md',
      dashboardPath: 'docs/plan/Dashboard.md' } },
    authorization: { schemaVersion: 1, runId, commit: 'deny', push: false, pullRequest: false,
      tag: false, release: false, deploy: false },
    verificationPlan: { schemaVersion: 1, sources: [
      { path: 'HARNESS.md', sha256: hash('PROBE_SOURCE') },
      { path: 'docs/plan/tasks/Probe.md', sha256: hash('PROBE_TASK') }],
    commands: [], manual: [{ id: 'probe-check', acceptanceIds: ['probe-accept'],
      description: 'Synthetic host probe does not claim Task acceptance.' }] },
    protocolSource: { schemaVersion: 1, repository: 'https://example.invalid/probe.git', version: '0.0.0',
      commit: 'c'.repeat(40), files: [{ path: 'skills/worker/SKILL.md', sha256: hash('PROBE_SKILL') }] },
    env: { DEV_HARNESS_WORKER: '1', DEV_HARNESS_RUN_ID: runId,
      DEV_HARNESS_TASK_ID: 'Probe', DEV_HARNESS_ADAPTER: 'dsh' } });
}

async function observedSession(options: DshProbeOptions, request: TaskExecutionRequest,
  readCatalog: WorkerReadCatalog): Promise<DshConfinedSessionOutput> {
  const result = { schemaVersion: 1, runId: request.runId, taskId: request.taskId,
    attempt: request.attempt, requestId: request.requestId, snapshotHash: request.snapshotHash,
    summary: 'Synthetic DSH capability probe.', verification: [], changedFiles: ['src/a.ts'],
    outcome: 'blocked', needsPlanning: false, reason: 'Synthetic capability probe only.' };
  const prompt = `Synthetic confined DSH capability probe. Call dhr_propose_text with {"path":"src/a.ts","content":"UPDATED"} exactly once. Do not use any other tool. Then return exactly this JSON object: ${JSON.stringify(result)}`;
  let starts = 0;
  const output = await runConfinedDshSession({ ...options, request, readCatalog, prompt,
    signal: AbortSignal.timeout(options.timeoutMs), timeoutMs: options.timeoutMs,
    log: async () => {}, recordHostStart: async () => { starts++; } });
  if (starts !== 1 || output.namespaceEvidence.network !== 'isolated'
    || !output.namespaceEvidence.monitorWaited || output.brokerAudit.denied !== 0
    || !output.brokerAudit.connected['api.deepseek.com']
    || output.result.outcome !== 'blocked' || output.result.reason !== result.reason
    || JSON.stringify(output.proposals) !== JSON.stringify([{ path: 'src/a.ts', content: 'UPDATED' }])) {
    throw new Error('DSH synthetic Session did not establish the complete confined bridge behavior');
  }
  return output;
}

/** Two real fresh DSH Sessions and an independent process-tree cancellation. */
export async function probeDshRuntime(options: DshProbeOptions): Promise<ExecutorCapabilities> {
  const base = { schemaVersion: 1 as const, coreProtocolVersion: 1 as const, adapterId: 'dsh',
    targetVersion: options.targetVersion, pluginPackaging: false, evidence: [] };
  const unavailable = (error: unknown): ExecutorCapabilities => ({ ...base,
    available: false, freshSession: false, structuredOutput: false, nonInteractive: false,
    cancellation: false, resumeRunWithFreshSession: false, authorizationEnforced: false,
    reasons: [error instanceof ContractValidationError
      ? `${error.name}: ${error.message}: ${JSON.stringify(error.issues)}`.slice(0, 2048)
      : error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2048) : 'DSH host probe failed'] });
  if (process.platform !== 'linux') return unavailable(new Error('Confined DSH host requires Linux'));
  const root = await mkdtemp(join(tmpdir(), 'dhr-dsh-probe-')).then((path) => realpath(path)).catch(unavailable);
  if (typeof root !== 'string') return root;
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'HELLO');
    const request = dshProbeRequestFor(root);
    const readCatalog: WorkerReadCatalog = { repoRoot: root, runId: request.runId,
      requestId: request.requestId, snapshotHash: request.snapshotHash,
      files: [{ path: 'src/a.ts', sha256: hash('HELLO') }] };
    const first = await observedSession(options, request, readCatalog);
    const second = await observedSession(options, request, readCatalog);
    if (first.sessionId === second.sessionId || await readFile(join(root, 'src/a.ts'), 'utf8') !== 'HELLO') {
      throw new Error('DSH reused a Session or changed the synthetic worktree');
    }
    const cancelled = await runIsolatedModelHost({ bubblewrap: options.bubblewrap,
      nodeBinary: options.nodeBinary, executable: '/dhr/cancel-probe',
      argv: ['-e', 'setInterval(() => {}, 1000)'], cwd: '/tmp', timeoutMs: 10_000,
      signal: AbortSignal.timeout(700), environment: { HOME: '/tmp', PATH: '/usr/bin' }, tmpfs: [],
      mounts: [{ source: options.nodeBinary, destination: '/dhr/cancel-probe' }] },
    { allowedHosts: ['api.deepseek.com'] });
    if (cancelled.termination !== 'aborted' || cancelled.quiescence !== 'confirmed'
      || cancelled.evidence.network !== 'isolated') throw new Error('DSH host cancellation did not prove quiescence');
    const observedAt = new Date().toISOString();
    const evidenceDirectory = await mkdtemp(join(tmpdir(), 'dhr-dsh-probe-evidence-'));
    const report = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: 'dsh-capability-probe', observedAt,
      targetVersion: options.targetVersion, syntheticOnly: true,
      sessions: [first, second].map((session) => ({ sessionId: session.sessionId,
        namespace: session.namespaceEvidence, broker: session.brokerAudit })),
      cancellation: { termination: cancelled.termination, quiescence: cancelled.quiescence,
        namespace: cancelled.evidence } })}\n`);
    try { await writeFile(join(evidenceDirectory, 'report.json'), report, { flag: 'wx', mode: 0o600 }); }
    catch (error) { await rm(evidenceDirectory, { recursive: true, force: true }); throw error; }
    const ref = { schemaVersion: 1 as const, path: 'report.json', sha256: hash(report) };
    const evidence = (['available', 'freshSession', 'structuredOutput', 'nonInteractive',
      'cancellation', 'resumeRunWithFreshSession', 'authorizationEnforced'] as const)
      .map((capability) => ({ capability, observedAt, ref }));
    return { ...base, available: true, freshSession: true, structuredOutput: true,
      nonInteractive: true, cancellation: true, resumeRunWithFreshSession: true,
      authorizationEnforced: true,
      reasons: [`Synthetic probe report: ${join(evidenceDirectory, 'report.json')}; plugin packaging is verified separately`],
      evidence };
  } catch (error) { return unavailable(error); }
  finally { await rm(root, { recursive: true, force: true }); }
}
