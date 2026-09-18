import { isRepoPath, parseContract, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import type { CapturedSnapshot } from '../snapshot/types.js';
import { sameRecord } from '../recovery/evidence.js';
import { WorkerProposalCollector, WorkerProposalError } from './proposals.js';

/** Host-neutral, Core-owned catalog of readable regular files in one frozen snapshot. */
export interface WorkerReadCatalog {
  readonly repoRoot: string;
  readonly runId: string;
  readonly requestId: string;
  readonly snapshotHash: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

/** The adapter may page only these files and must recheck their bytes before every read. */
export function createWorkerReadCatalog(requestInput: TaskExecutionRequest, before: CapturedSnapshot): WorkerReadCatalog {
  // Share the proposal boundary's independent hash, identity and capture checks.
  new WorkerProposalCollector(requestInput, before);
  const request = parseContract('taskExecutionRequest', requestInput);
  const snapshot = parseContract('snapshot', before.snapshot);
  if (!sameRecord(snapshot.protocolSource, request.protocolSource)) {
    throw new WorkerProposalError('DRIFT_DETECTED', 'Read catalog protocol differs from the Core request');
  }
  const seen = new Set<string>();
  const folded = new Set<string>();
  const files: { path: string; sha256: string }[] = [];
  for (const entry of snapshot.paths) {
    if (entry.type !== 'file') continue;
    const path = entry.path;
    if (path.length > 4096 || !isRepoPath(path) || path.split('/').some((part) => part.toLowerCase() === '.git')
      || seen.has(path) || folded.has(path.toLowerCase())) {
      throw new WorkerProposalError('AUTHORIZATION_VIOLATION', 'Snapshot contains an unsafe or aliased read path');
    }
    seen.add(path);
    folded.add(path.toLowerCase());
    files.push({ path, sha256: entry.rawContentHash });
  }
  if (files.length > 100_000) throw new WorkerProposalError('AUTHORIZATION_VIOLATION', 'Read catalog exceeds 100000 files');
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { repoRoot: request.repoRoot, runId: request.runId, requestId: request.requestId,
    snapshotHash: request.snapshotHash, files };
}
