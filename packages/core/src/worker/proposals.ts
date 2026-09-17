import { createHash } from 'node:crypto';
import { parseContract, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import type { CapturedSnapshot } from '../snapshot/types.js';
import { createWorkerWritePolicy } from './bridge-policy.js';

export class WorkerProposalError extends Error {
  constructor(readonly code: 'INVALID_RESULT' | 'AUTHORIZATION_VIOLATION' | 'DRIFT_DETECTED', message: string) {
    super(message); this.name = 'WorkerProposalError';
  }
}

export interface WorkerFileProposal {
  readonly path: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly content: Uint8Array | null;
}

/** Host-owned, in-memory staging only. This never writes the project or proves confinement. */
export class WorkerProposalCollector {
  private readonly allowed: (path: string) => boolean;
  private readonly baseline = new Map<string, { type: string; hash: string | null }>();
  private readonly proposals = new Map<string, WorkerFileProposal>();
  private totalBytes = 0;

  constructor(requestInput: TaskExecutionRequest, before: CapturedSnapshot) {
    const request = parseContract('taskExecutionRequest', requestInput);
    const snapshot = parseContract('snapshot', before.snapshot);
    if (before.hash !== request.snapshotHash || snapshot.runId !== request.runId
      || snapshot.repoIdentity.repoRoot !== request.repoRoot) {
      throw new WorkerProposalError('DRIFT_DETECTED', 'Proposal staging does not bind the Core before snapshot');
    }
    this.allowed = createWorkerWritePolicy(request.scope);
    for (const entry of snapshot.paths) {
      this.baseline.set(entry.path, { type: entry.type, hash: entry.type === 'file' ? entry.rawContentHash : null });
    }
  }

  private requirePath(path: string): { type: string; hash: string | null } | undefined {
    if (!this.allowed(path)) throw new WorkerProposalError('AUTHORIZATION_VIOLATION', `Out-of-scope proposal path: ${path}`);
    const initial = this.baseline.get(path);
    if (initial !== undefined && !['file', 'missing'].includes(initial.type)) {
      throw new WorkerProposalError('AUTHORIZATION_VIOLATION', `Proposal cannot replace a ${initial.type}: ${path}`);
    }
    return initial;
  }

  write(path: string, bytes: Uint8Array): WorkerFileProposal {
    const initial = this.requirePath(path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 4 * 1024 * 1024) {
      throw new WorkerProposalError('INVALID_RESULT', 'Proposal content must be at most 4 MiB of bytes');
    }
    const content = Uint8Array.from(bytes);
    const previous = this.proposals.get(path);
    const total = this.totalBytes - (previous?.content?.byteLength ?? 0) + content.byteLength;
    if (total > 16 * 1024 * 1024) throw new WorkerProposalError('INVALID_RESULT', 'Proposal set exceeds 16 MiB');
    const value: WorkerFileProposal = { path, beforeHash: initial?.hash ?? null,
      afterHash: createHash('sha256').update(content).digest('hex'), content };
    this.proposals.set(path, value); this.totalBytes = total;
    return { ...value, content: Uint8Array.from(content) };
  }

  delete(path: string): WorkerFileProposal | null {
    const initial = this.requirePath(path);
    if (initial === undefined || initial.type === 'missing') {
      const previous = this.proposals.get(path);
      this.totalBytes -= previous?.content?.byteLength ?? 0;
      this.proposals.delete(path);
      return null;
    }
    const previous = this.proposals.get(path);
    this.totalBytes -= previous?.content?.byteLength ?? 0;
    const value: WorkerFileProposal = { path, beforeHash: initial.hash, afterHash: null, content: null };
    this.proposals.set(path, value);
    return value;
  }

  list(): readonly WorkerFileProposal[] {
    return [...this.proposals.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
      .map((value) => ({ ...value, content: value.content === null ? null : Uint8Array.from(value.content) }));
  }
}
