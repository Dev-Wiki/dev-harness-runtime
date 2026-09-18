import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseContract, type ExecutorCapabilities, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import type { WorkerReadCatalog } from '@dev-harness-runtime/core';
import { createConfinedCodexBridge } from './confined-bridge.js';
import { runConfinedCodexProcess, type ConfinedCodexProcessOutput } from './confined-process.js';
import { runIsolatedModelHost } from './isolated-model-host.js';
import { runCodexSession } from './session.js';

export interface CodexProbeOptions {
  readonly binary: string;
  readonly bubblewrap: string;
  readonly nodeBinary: string;
  readonly authFile: string;
  readonly serverBundle: string;
  readonly proposalServer: string;
  readonly timeoutMs: number;
  readonly targetVersion: string;
  readonly modelProxy?: { readonly HTTPS_PROXY?: string; readonly HTTP_PROXY?: string };
}

const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const expected = (request: TaskExecutionRequest): object => ({ result: { schemaVersion: 1,
  runId: request.runId, taskId: request.taskId, attempt: request.attempt, requestId: request.requestId,
  snapshotHash: request.snapshotHash, summary: 'Synthetic Codex capability probe.',
  verification: [], changedFiles: ['src/a.ts'], rawResultRef: null,
  outcome: 'blocked', needsPlanning: false, reason: 'Synthetic capability probe only.', closure: null } });

function requestFor(root: string): TaskExecutionRequest {
  const runId = 'codex-probe';
  return parseContract('taskExecutionRequest', { schemaVersion: 1, coreProtocolVersion: 1,
    runId, taskId: 'Probe', attempt: 1, requestId: 'codex-probe-1', repoRoot: root,
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
      DEV_HARNESS_TASK_ID: 'Probe', DEV_HARNESS_ADAPTER: 'codex' } });
}

async function observedSession(options: CodexProbeOptions, request: TaskExecutionRequest,
  readCatalog: WorkerReadCatalog): Promise<ConfinedCodexProcessOutput> {
  const prompt = `Synthetic capability probe in an isolated temporary directory. First call dhr_list_paths with {"prefix":"src","after":""}. Then call dhr_search_text with {"query":"ELL","prefix":"src","after":""}. Then call dhr_read_text with {"path":"src/a.ts","offset":0}. Then call dhr_propose_text with {"path":"src/a.ts","content":"UPDATED"}. Do not use any other tools. Finally return exactly this JSON object: ${JSON.stringify(expected(request))}`;
  let confined: ConfinedCodexProcessOutput | undefined;
  const output = await runCodexSession({ binary: options.binary, nodeBinary: options.nodeBinary,
    proposalServer: options.proposalServer, request, readCatalog, prompt,
    env: options.modelProxy ?? {}, signal: AbortSignal.timeout(options.timeoutMs),
    log: async () => {},
    bridgeProcess: (policyPath) => createConfinedCodexBridge({ bubblewrap: options.bubblewrap,
      nodeBinary: options.nodeBinary, serverBundle: options.serverBundle, policyPath,
      readCatalog, parentContained: true }),
    hostProcess: async (processInput, bridge, outputSchema) => {
      confined = await runConfinedCodexProcess({ ...processInput, bridge, outputSchema,
        bubblewrap: options.bubblewrap, nodeBinary: options.nodeBinary,
        authFile: options.authFile, timeoutMs: options.timeoutMs });
      return confined;
    } });
  if (!confined || output !== confined || confined.namespaceEvidence.network !== 'isolated'
    || confined.namespaceEvidence.asPid1 !== true || confined.namespaceEvidence.monitorWaited !== true
    || Object.values(confined.brokerAudit.connected).every((count) => count < 1)
    || confined.result.outcome !== 'blocked' || confined.result.reason !== 'Synthetic capability probe only.'
    || JSON.stringify(confined.result.changedFiles) !== JSON.stringify(['src/a.ts'])
    || JSON.stringify(confined.proposals) !== JSON.stringify([{ path: 'src/a.ts', content: 'UPDATED' }])) {
    throw new Error('Codex synthetic session did not establish the complete confined bridge behavior');
  }
  return confined;
}

/** A behavior probe: two real fresh Codex turns and an independent process-tree cancellation. */
export async function probeCodexRuntime(options: CodexProbeOptions): Promise<ExecutorCapabilities> {
  const base = { schemaVersion: 1 as const, coreProtocolVersion: 1 as const, adapterId: 'codex',
    targetVersion: options.targetVersion, pluginPackaging: false, evidence: [] };
  const unavailable = (error: unknown): ExecutorCapabilities => ({ ...base,
    available: false, freshSession: false, structuredOutput: false, nonInteractive: false,
    cancellation: false, resumeRunWithFreshSession: false, authorizationEnforced: false,
    reasons: [error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2048) : 'Codex host probe failed'] });
  if (process.platform !== 'linux') return unavailable(new Error('Confined Codex host requires Linux'));
  const root = await mkdtemp(join(tmpdir(), 'dhr-codex-probe-')).then((path) => realpath(path)).catch(unavailable);
  if (typeof root !== 'string') return root;
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'HELLO');
    const request = requestFor(root);
    const readCatalog: WorkerReadCatalog = { repoRoot: root, runId: request.runId,
      requestId: request.requestId, snapshotHash: request.snapshotHash,
      files: [{ path: 'src/a.ts', sha256: hash('HELLO') }] };
    const first = await observedSession(options, request, readCatalog);
    const second = await observedSession(options, request, readCatalog);
    if (first.threadId === second.threadId || await readFile(join(root, 'src/a.ts'), 'utf8') !== 'HELLO') {
      throw new Error('Codex reused a thread or changed the synthetic worktree');
    }
    const cancelled = await runIsolatedModelHost({ bubblewrap: options.bubblewrap,
      nodeBinary: options.nodeBinary, executable: '/dhr/cancel-probe',
      argv: ['-e', 'setInterval(() => {}, 1000)'], cwd: '/tmp', timeoutMs: 10_000,
      signal: AbortSignal.timeout(700), environment: { HOME: '/tmp', PATH: '/usr/bin' }, tmpfs: [],
      mounts: [{ source: options.nodeBinary, destination: '/dhr/cancel-probe' }] },
    { allowedHosts: ['api.openai.com'] });
    if (cancelled.termination !== 'aborted' || cancelled.quiescence !== 'confirmed'
      || cancelled.evidence.network !== 'isolated') throw new Error('Codex host cancellation did not prove quiescence');
    const observedAt = new Date().toISOString();
    const evidenceDirectory = await mkdtemp(join(tmpdir(), 'dhr-codex-probe-evidence-'));
    const report = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: 'codex-capability-probe', observedAt,
      targetVersion: options.targetVersion, syntheticOnly: true,
      sessions: [first, second].map((session) => ({ threadId: session.threadId,
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
