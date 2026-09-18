import { createHash } from 'node:crypto';
import { parseContract, validateResultForRequest, type Snapshot, type TaskExecutionRequest, type TaskExecutionResult } from '@dev-harness-runtime/contracts';
import type { CapturedSnapshot } from '../snapshot/types.js';
import { serializeSnapshot, snapshotBoundaryHash } from '../snapshot/capture.js';
import { compareSnapshots } from '../snapshot/guard.js';
import { sameRecord } from '../recovery/evidence.js';
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
export interface WorkerProposalRecord {
  readonly schemaVersion: 1;
  readonly kind: 'worker-proposals';
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly requestId: string;
  readonly snapshotHash: string;
  readonly files: readonly {
    readonly path: string;
    readonly beforeHash: string | null;
    readonly afterHash: string | null;
    readonly contentBase64: string | null;
  }[];
}

/** Host-owned, in-memory staging only. This never writes the project or proves confinement. */
export class WorkerProposalCollector {
  private readonly request: TaskExecutionRequest;
  private readonly beforeSnapshot: Snapshot;
  private readonly allowed: (path: string) => boolean;
  private readonly baseline = new Map<string, { type: string; hash: string | null }>();
  private readonly proposals = new Map<string, WorkerFileProposal>();
  private totalBytes = 0;
  private static readonly maxFiles = 1024;

  constructor(requestInput: TaskExecutionRequest, before: CapturedSnapshot) {
    const request = parseContract('taskExecutionRequest', requestInput);
    const snapshot = parseContract('snapshot', before.snapshot);
    if (before.hash !== request.snapshotHash || before.hash !== createHash('sha256').update(serializeSnapshot(snapshot)).digest('hex')
      || before.boundaryHash !== snapshotBoundaryHash(snapshot)
      || JSON.stringify(before.dirtyPaths) !== JSON.stringify(snapshot.dirtyPaths)
      || JSON.stringify(before.stagedPaths) !== JSON.stringify(snapshot.stagedPaths)
      || snapshot.runId !== request.runId || snapshot.repoIdentity.repoRoot !== request.repoRoot) {
      throw new WorkerProposalError('DRIFT_DETECTED', 'Proposal staging does not bind the Core before snapshot');
    }
    this.request = structuredClone(request);
    this.beforeSnapshot = structuredClone(snapshot);
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

  write(path: string, bytes: Uint8Array): WorkerFileProposal | null {
    const initial = this.requirePath(path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 4 * 1024 * 1024) {
      throw new WorkerProposalError('INVALID_RESULT', 'Proposal content must be at most 4 MiB of bytes');
    }
    const content = Uint8Array.from(bytes);
    const previous = this.proposals.get(path);
    const afterHash = createHash('sha256').update(content).digest('hex');
    if (initial?.type === 'file' && initial.hash === afterHash) {
      this.totalBytes -= previous?.content?.byteLength ?? 0;
      this.proposals.delete(path);
      return null;
    }
    if (previous === undefined && this.proposals.size >= WorkerProposalCollector.maxFiles) {
      throw new WorkerProposalError('INVALID_RESULT', 'Proposal set exceeds 1024 files');
    }
    const total = this.totalBytes - (previous?.content?.byteLength ?? 0) + content.byteLength;
    if (total > 16 * 1024 * 1024) throw new WorkerProposalError('INVALID_RESULT', 'Proposal set exceeds 16 MiB');
    const value: WorkerFileProposal = { path, beforeHash: initial?.hash ?? null,
      afterHash, content };
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
    if (previous === undefined && this.proposals.size >= WorkerProposalCollector.maxFiles) {
      throw new WorkerProposalError('INVALID_RESULT', 'Proposal set exceeds 1024 files');
    }
    this.totalBytes -= previous?.content?.byteLength ?? 0;
    const value: WorkerFileProposal = { path, beforeHash: initial.hash, afterHash: null, content: null };
    this.proposals.set(path, value);
    return value;
  }

  list(): readonly WorkerFileProposal[] {
    return [...this.proposals.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
      .map((value) => ({ ...value, content: value.content === null ? null : Uint8Array.from(value.content) }));
  }

  /** A structured result may describe only the file changes accepted by this staging boundary. */
  assertDeclaredChanges(result: TaskExecutionResult): void {
    const bound = validateResultForRequest(this.request, result);
    const proposed = [...this.proposals.keys()].sort();
    const declared = [...bound.changedFiles].sort();
    if (proposed.length !== declared.length || proposed.some((path, index) => path !== declared[index])) {
      throw new WorkerProposalError('INVALID_RESULT', 'Worker result changedFiles differs from accepted proposals');
    }
  }

  /** Compare a Core-captured ending snapshot to the exact proposed bytes and file operations. */
  assertAppliedSnapshot(after: CapturedSnapshot): void {
    const snapshot = parseContract('snapshot', after.snapshot);
    if (after.hash !== createHash('sha256').update(serializeSnapshot(snapshot)).digest('hex')
      || after.boundaryHash !== snapshotBoundaryHash(snapshot)
      || JSON.stringify(after.dirtyPaths) !== JSON.stringify(snapshot.dirtyPaths)
      || JSON.stringify(after.stagedPaths) !== JSON.stringify(snapshot.stagedPaths)
      || snapshot.runId !== this.request.runId
      || snapshot.repoIdentity.repoRoot !== this.request.repoRoot
      || snapshot.repoIdentity.privateGitDir !== this.beforeSnapshot.repoIdentity.privateGitDir
      || snapshot.repoIdentity.head !== this.beforeSnapshot.repoIdentity.head
      || snapshot.repoIdentity.branch !== this.beforeSnapshot.repoIdentity.branch
      || snapshot.indexFingerprint !== this.beforeSnapshot.indexFingerprint
      || !sameRecord(snapshot.protocolSource, this.beforeSnapshot.protocolSource)
      || snapshot.adapterConfigHash !== this.beforeSnapshot.adapterConfigHash) {
      throw new WorkerProposalError('DRIFT_DETECTED', 'Ending snapshot does not bind the unchanged Worker boundary');
    }
    const proposed = this.list();
    const paths = proposed.map((file) => file.path).sort();
    const delta = compareSnapshots(this.beforeSnapshot, snapshot);
    if (JSON.stringify(delta.paths) !== JSON.stringify(paths)
      || JSON.stringify(delta.contentPaths) !== JSON.stringify(paths)) {
      throw new WorkerProposalError('AUTHORIZATION_VIOLATION', 'Ending snapshot paths differ from accepted proposals');
    }
    const afterPaths = new Map(snapshot.paths.map((entry) => [entry.path, entry]));
    const beforePaths = new Map(this.beforeSnapshot.paths.map((entry) => [entry.path, entry]));
    for (const file of proposed) {
      const current = afterPaths.get(file.path);
      const previous = beforePaths.get(file.path);
      if (file.content === null) {
        if ((previous?.index.length ?? 0) > 0 && (current?.type !== 'missing' || current.deleted !== true)) {
          throw new WorkerProposalError('AUTHORIZATION_VIOLATION', `Tracked deletion has no missing entry: ${file.path}`);
        }
        if (current !== undefined && (current.type !== 'missing' || current.deleted !== true
          || !sameRecord(current.index, previous?.index ?? []))) {
          throw new WorkerProposalError('AUTHORIZATION_VIOLATION', `Deleted proposal remains present: ${file.path}`);
        }
      } else if (current?.type !== 'file' || current.rawContentHash !== file.afterHash || current.deleted !== false
        || current.mode !== (previous?.type === 'file' ? previous.mode : '100644')
        || !sameRecord(current.index, previous?.index ?? [])) {
        throw new WorkerProposalError('AUTHORIZATION_VIOLATION', `Applied bytes or mode differ from proposal: ${file.path}`);
      }
    }
  }

  /** Detached proposal bytes for private Run storage; provenance still needs host control evidence. */
  record(): WorkerProposalRecord {
    return { schemaVersion: 1, kind: 'worker-proposals', runId: this.request.runId,
      taskId: this.request.taskId, attempt: this.request.attempt, requestId: this.request.requestId,
      snapshotHash: this.request.snapshotHash,
      files: this.list().map((file) => ({ path: file.path, beforeHash: file.beforeHash,
        afterHash: file.afterHash, contentBase64: file.content === null ? null : Buffer.from(file.content).toString('base64') })) };
  }

  /** Revalidate a stored proposal record against the same Core request and before snapshot. */
  static restore(request: TaskExecutionRequest, before: CapturedSnapshot, input: unknown): WorkerProposalCollector {
    const collector = new WorkerProposalCollector(request, before);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new WorkerProposalError('INVALID_RESULT', 'Proposal record is not an object');
    }
    const record = input as Partial<WorkerProposalRecord>;
    if (Object.keys(record).sort().join(',') !== 'attempt,files,kind,requestId,runId,schemaVersion,snapshotHash,taskId'
      || record.schemaVersion !== 1 || record.kind !== 'worker-proposals' || record.runId !== collector.request.runId
      || record.taskId !== collector.request.taskId || record.attempt !== collector.request.attempt
      || record.requestId !== collector.request.requestId || record.snapshotHash !== collector.request.snapshotHash
      || !Array.isArray(record.files) || record.files.length > WorkerProposalCollector.maxFiles) {
      throw new WorkerProposalError('INVALID_RESULT', 'Proposal record identity differs from the Core request');
    }
    let previousPath: string | undefined;
    for (const item of record.files) {
      if (item === null || typeof item !== 'object'
        || Object.keys(item).sort().join(',') !== 'afterHash,beforeHash,contentBase64,path'
        || typeof item.path !== 'string'
        || (previousPath !== undefined && Buffer.compare(Buffer.from(previousPath), Buffer.from(item.path)) >= 0)
        || (item.beforeHash !== null && typeof item.beforeHash !== 'string')
        || (item.afterHash !== null && typeof item.afterHash !== 'string')
        || (item.contentBase64 !== null && typeof item.contentBase64 !== 'string')) {
        throw new WorkerProposalError('INVALID_RESULT', 'Proposal record file entry is malformed or unordered');
      }
      previousPath = item.path;
      let accepted: WorkerFileProposal | null;
      if (item.contentBase64 === null) accepted = collector.delete(item.path);
      else {
        if (item.contentBase64.length > 6 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.contentBase64)) {
          throw new WorkerProposalError('INVALID_RESULT', 'Proposal record content is not bounded canonical base64');
        }
        const bytes = Buffer.from(item.contentBase64, 'base64');
        if (bytes.toString('base64') !== item.contentBase64) throw new WorkerProposalError('INVALID_RESULT', 'Proposal record content is not canonical base64');
        accepted = collector.write(item.path, bytes);
      }
      if (accepted === null || accepted.beforeHash !== item.beforeHash || accepted.afterHash !== item.afterHash) {
        throw new WorkerProposalError('INVALID_RESULT', 'Proposal record hashes differ from the frozen baseline or content');
      }
    }
    return collector;
  }
}
