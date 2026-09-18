import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseContract, type Scope, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { createWorkerWritePolicy, type WorkerReadCatalog } from '@dev-harness-runtime/core';
import { CodexReadError, CodexReadView, type CodexReadPolicy } from './read-view.js';

export interface CodexBridgePolicy {
  readonly schemaVersion: 1;
  readonly identity: {
    readonly runId: string;
    readonly taskId: string;
    readonly attempt: number;
    readonly requestId: string;
    readonly snapshotHash: string;
  };
  readonly read: CodexReadPolicy;
  readonly scope: Scope;
}

export interface CodexBridgeView {
  readonly read: CodexReadView;
  readonly allowsProposal: (path: string) => boolean;
  readonly policy: CodexBridgePolicy;
}

const exact = (value: object, keys: readonly string[]): boolean => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const invalid = (): never => { throw new CodexReadError('INVALID_POLICY', 'Codex bridge policy does not bind one Core Task request'); };

/** Bind the Core-owned read catalog and write scope to exactly one Task attempt. */
export function createCodexBridgePolicy(requestInput: TaskExecutionRequest, read: WorkerReadCatalog): CodexBridgePolicy {
  const request = parseContract('taskExecutionRequest', requestInput);
  if (read.repoRoot !== request.repoRoot || read.runId !== request.runId
    || read.requestId !== request.requestId || read.snapshotHash !== request.snapshotHash) invalid();
  return { schemaVersion: 1,
    identity: { runId: request.runId, taskId: request.taskId, attempt: request.attempt,
      requestId: request.requestId, snapshotHash: request.snapshotHash },
    read: structuredClone(read), scope: structuredClone(request.scope) };
}

/** A fresh MCP subprocess validates the complete private policy before exposing any tools. */
export async function createCodexBridgeView(input: unknown): Promise<CodexBridgeView> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || !exact(input, ['schemaVersion', 'identity', 'read', 'scope'])) invalid();
  const value = input as Partial<CodexBridgePolicy>;
  if (value.schemaVersion !== 1 || value.identity === null || typeof value.identity !== 'object'
    || !exact(value.identity, ['runId', 'taskId', 'attempt', 'requestId', 'snapshotHash'])
    || value.read === null || typeof value.read !== 'object'
    || !exact(value.read, ['repoRoot', 'runId', 'requestId', 'snapshotHash', 'files'])) invalid();
  const identity = value.identity;
  const readPolicy = value.read;
  if (!readPolicy) throw new CodexReadError('INVALID_POLICY', 'Codex bridge read policy is missing');
  const read = await CodexReadView.create(readPolicy);
  let scope: Scope;
  try { scope = parseContract('scope', value.scope); } catch { return invalid(); }
  if (!identity || typeof identity.runId !== 'string' || typeof identity.taskId !== 'string'
    || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1
    || typeof identity.requestId !== 'string' || typeof identity.snapshotHash !== 'string'
    || identity.runId !== read.policy.runId || identity.requestId !== read.policy.requestId
    || identity.snapshotHash !== read.policy.snapshotHash || identity.taskId !== scope.planning.taskId) invalid();
  const policy: CodexBridgePolicy = { schemaVersion: 1, identity: { ...identity } as CodexBridgePolicy['identity'],
    read: read.policy, scope: structuredClone(scope) };
  return { read, allowsProposal: createWorkerWritePolicy(scope), policy };
}

/** One immutable private policy file for one Codex process and one bridge subprocess. */
export async function withCodexBridgePolicy<T>(input: CodexBridgePolicy, run: (path: string) => Promise<T>): Promise<T> {
  const bridge = await createCodexBridgeView(input);
  const directory = await mkdtemp(join(tmpdir(), 'dhr-codex-bridge-policy-'));
  try {
    const path = join(directory, 'policy.json');
    await writeFile(path, `${JSON.stringify(bridge.policy)}\n`, { flag: 'wx', mode: 0o600 });
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
