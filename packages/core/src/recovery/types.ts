import type { EvidenceRef, PendingOperation, ProtocolSource, RunAuthorization, RunState, TaskExecutionRequest, TaskExecutionResult } from '@dev-harness-runtime/contracts';
import type { CapturedSnapshot } from '../snapshot/types.js';
import type { AttemptIdentity } from '../state/index.js';

export class RecoveryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RecoveryError'; }
}

export interface RecoveryCheckpoint {
  schemaVersion: 1;
  operationId: string;
  kind: PendingOperation['kind'];
  identity: AttemptIdentity;
  stage: 'execute-intent' | 'worker-checkpoint' | 'worker-ended' | 'verification-passed' | 'index-staged';
  beforeSnapshotRef: EvidenceRef;
  afterSnapshotRef: EvidenceRef;
  requestRef?: EvidenceRef;
  resultRef?: EvidenceRef;
  evidenceRefs: EvidenceRef[];
}

export interface RecoveryEvidenceContext {
  state: RunState;
  checkpoint: RecoveryCheckpoint;
  checkpointRef: EvidenceRef;
  before: CapturedSnapshot;
  after: CapturedSnapshot;
  evidence: { ref: EvidenceRef; bytes: Buffer }[];
  request?: TaskExecutionRequest;
  result?: TaskExecutionResult;
}

/** Trusted Core implementations inspect bound persistent records; fulfillment is never inferred from Worker claims. */
export interface RecoveryVerifier {
  verifyQuiescence?(input: { state: RunState }): Promise<void>;
  /** Prove controlled provenance and a quiescent ending boundary; private-file existence and matching hashes alone are insufficient. */
  verifyCheckpoint?(input: RecoveryEvidenceContext): Promise<void>;
  verifyAcceptance?(input: RecoveryEvidenceContext & { request: TaskExecutionRequest; result: TaskExecutionResult }): Promise<void>;
}

export type RecoveryDecision =
  | { action: 'stopped'; code: string; message: string }
  | { action: 'execute-new-session'; continuation: 'restart' | 'checkpoint'; freshSession: true }
  | { action: 'adopt-result' }
  | { action: 'revalidate' }
  | { action: 'finalize-no-commit' }
  | { action: 'adopt-commit' }
  | { action: 'resume-commit' }
  | { action: 'rebuild-summary' };

/** Decision inputs are diagnostics, not a capability to publish state. resumeRun independently obtains them. */
export interface RecoveryFacts {
  currentMatchesBefore: boolean;
  currentMatchesAccepted: boolean;
  checkpoint?: RecoveryCheckpoint;
  checkpointVerified: boolean;
  acceptanceVerified: boolean;
  commitVerified: boolean;
  commitAbsent: boolean;
  resultCompleted: boolean;
}

export interface ResumeOptions {
  expectedRevision: number;
  verifier: RecoveryVerifier;
  environment: { adapter: string; authorization: RunAuthorization; protocolSource: ProtocolSource; adapterConfigHash: string };
  /** If supplied, must equal the reference already frozen in pendingOperation. */
  checkpointRef?: EvidenceRef;
  /** Explicit orphan adoption entry point; never discovered by a directory scan or timestamp. */
  candidateCheckpointRef?: EvidenceRef;
}
export interface ResumeResult { state: RunState; decision: RecoveryDecision }
