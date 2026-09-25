import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseContract, type Scope, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { createWorkerWritePolicy } from './bridge-policy.js';
import type { WorkerReadCatalog } from './read-catalog.js';
import { WorkerReadError, WorkerReadView, type WorkerReadPolicy } from './read-view.js';

export interface WorkerTaskBridgePolicy {
  readonly schemaVersion: 1;
  readonly identity: {
    readonly runId: string;
    readonly taskId: string;
    readonly attempt: number;
    readonly requestId: string;
    readonly snapshotHash: string;
  };
  readonly env: TaskExecutionRequest['env'];
  readonly read: WorkerReadPolicy;
  readonly scope: Scope;
}

export interface WorkerTaskBridgeView {
  readonly read: WorkerReadView;
  readonly allowsProposal: (path: string) => boolean;
  readonly policy: WorkerTaskBridgePolicy;
}

const exact = (value: object, keys: readonly string[]): boolean => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const invalid = (): never => { throw new WorkerReadError('INVALID_POLICY', 'Codex bridge policy does not bind one Core Task request'); };

/** Bind the Core-owned read catalog and write scope to exactly one Task attempt. */
export function createWorkerTaskBridgePolicy(requestInput: TaskExecutionRequest, read: WorkerReadCatalog): WorkerTaskBridgePolicy {
  const request = parseContract('taskExecutionRequest', requestInput);
  if (read.repoRoot !== request.repoRoot || read.runId !== request.runId
    || read.requestId !== request.requestId || read.snapshotHash !== request.snapshotHash) invalid();
  return { schemaVersion: 1,
    identity: { runId: request.runId, taskId: request.taskId, attempt: request.attempt,
      requestId: request.requestId, snapshotHash: request.snapshotHash }, env: structuredClone(request.env),
    read: structuredClone(read), scope: structuredClone(request.scope) };
}

/** A fresh MCP subprocess validates the complete private policy before exposing any tools. */
export async function createWorkerTaskBridgeView(input: unknown): Promise<WorkerTaskBridgeView> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || !exact(input, ['schemaVersion', 'identity', 'env', 'read', 'scope'])) invalid();
  const value = input as Partial<WorkerTaskBridgePolicy>;
  if (value.schemaVersion !== 1 || value.identity === null || typeof value.identity !== 'object'
    || !exact(value.identity, ['runId', 'taskId', 'attempt', 'requestId', 'snapshotHash'])
    || value.env === null || typeof value.env !== 'object'
    || !exact(value.env, ['DEV_HARNESS_WORKER', 'DEV_HARNESS_RUN_ID', 'DEV_HARNESS_TASK_ID', 'DEV_HARNESS_ADAPTER'])
    || value.read === null || typeof value.read !== 'object'
    || !exact(value.read, ['repoRoot', 'runId', 'requestId', 'snapshotHash', 'files'])) invalid();
  const identity = value.identity;
  const env = value.env;
  const readPolicy = value.read;
  if (!readPolicy) throw new WorkerReadError('INVALID_POLICY', 'Codex bridge read policy is missing');
  const read = await WorkerReadView.create(readPolicy);
  let scope: Scope;
  try { scope = parseContract('scope', value.scope); } catch { return invalid(); }
  if (!identity || typeof identity.runId !== 'string' || typeof identity.taskId !== 'string'
    || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1
    || typeof identity.requestId !== 'string' || typeof identity.snapshotHash !== 'string'
    || identity.runId !== read.policy.runId || identity.requestId !== read.policy.requestId
    || identity.snapshotHash !== read.policy.snapshotHash || identity.taskId !== scope.planning.taskId
    || !env || env.DEV_HARNESS_WORKER !== '1' || env.DEV_HARNESS_RUN_ID !== identity.runId
    || env.DEV_HARNESS_TASK_ID !== identity.taskId || typeof env.DEV_HARNESS_ADAPTER !== 'string'
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(env.DEV_HARNESS_ADAPTER)) invalid();
  const policy: WorkerTaskBridgePolicy = { schemaVersion: 1, identity: { ...identity } as WorkerTaskBridgePolicy['identity'],
    env: { ...env } as TaskExecutionRequest['env'], read: read.policy, scope: structuredClone(scope) };
  return { read, allowsProposal: createWorkerWritePolicy(scope), policy };
}

/** One immutable private policy file for one Codex process and one bridge subprocess. */
export async function withWorkerTaskBridgePolicy<T>(input: WorkerTaskBridgePolicy, run: (path: string) => Promise<T>): Promise<T> {
  const bridge = await createWorkerTaskBridgeView(input);
  const directory = await mkdtemp(join(tmpdir(), 'dhr-worker-task-bridge-policy-'));
  try {
    const path = join(directory, 'policy.json');
    await writeFile(path, `${JSON.stringify(bridge.policy)}\n`, { flag: 'wx', mode: 0o600 });
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
