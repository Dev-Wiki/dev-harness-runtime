import type { HostEnvironment, ProtocolSource, RunState, Scope, TaskExecutionRequest, TaskExecutionResult, TaskExecutor, VerificationPlan } from '@dev-harness-runtime/contracts';
import type { ProjectContext } from '../discovery/project.js';
import type { PlanningDocument, PlanningTask, TaskSelection } from '../planning/types.js';
import type { Registry } from '../registry.js';
import type { CapturedSnapshot } from '../snapshot/types.js';
import type { AcceptanceServices, WorkerControlVerifier } from '../result/acceptance.js';
import type { AcceptanceCriterion } from '../result/frozen.js';
import type { GitCommitPolicy } from '../authorization/git.js';
import type { ReconciliationVerifier } from '../recovery/reconcile.js';
import type { RecoveryEvidenceContext } from '../recovery/types.js';
import type { prepareWorkerInvocation } from '../worker/prompt.js';
import type { WorkerReadCatalog } from '../worker/read-catalog.js';
import type { ProposedFileOperation } from '../worker/proposal-evidence.js';
import type { AppliedWorkerProposals } from '../worker/apply-proposals.js';

/** Trusted, explicitly registered host integration. Worker output cannot supply these services. */
export interface RuntimeAdapter {
  id: string;
  executor: TaskExecutor;
  environment(project: ProjectContext): Promise<HostEnvironment>;
  workerControl: WorkerControlVerifier;
  prepareInvocation(input: {
    request: TaskExecutionRequest;
    invocation: ReturnType<typeof prepareWorkerInvocation>;
    readCatalog: WorkerReadCatalog;
    log(stream: 'stdout' | 'stderr' | 'events', bytes: Uint8Array): Promise<void>;
  }): Promise<void>;
  /** Optional proposal transport. Core alone persists and applies these operations after host quiescence. */
  collectProposals?(input: { request: TaskExecutionRequest; result: TaskExecutionResult }): Promise<readonly ProposedFileOperation[]>;
  /** Records originate from the host controller after the entire worker tree is quiescent. */
  collectEvidence(input: { request: TaskExecutionRequest; before: CapturedSnapshot; after: CapturedSnapshot;
    application?: AppliedWorkerProposals }): Promise<{ schemaVersion: 1; [key: string]: unknown }[]>;
  verifyQuiescence(input: { state: RunState }): Promise<void>;
  verifyCheckpoint(input: RecoveryEvidenceContext): Promise<void>;
}

export interface PreparedTask {
  scope: Scope;
  acceptance: AcceptanceCriterion[];
  verificationPlan: VerificationPlan;
}
export interface RuntimeServices {
  protocolSource: ProtocolSource;
  adapterConfigHash: string;
  workerSkill: { bytes: Uint8Array; sha256: string };
  adapters: Registry<RuntimeAdapter>;
  /** Core planner must explicitly cover all verification inputs, including transitive sources. */
  prepareTask(input: { project: ProjectContext; plan: PlanningDocument; task: PlanningTask; before: CapturedSnapshot }): Promise<PreparedTask>;
  acceptance: Omit<AcceptanceServices, 'workerControl' | 'signal'>;
  git?: { gitBinary: string; policy: GitCommitPolicy };
  reconciliation?: Omit<ReconciliationVerifier, 'project'>;
}
export interface StartRunOptions {
  cwd: string;
  adapter: string;
  selection: TaskSelection;
  commit?: 'deny' | 'task';
  runId?: string;
  docsRoot?: string;
  signal?: AbortSignal;
}
export interface ContinueRunOptions {
  cwd: string;
  runId: string;
  expectedRevision: number;
  docsRoot?: string;
  signal?: AbortSignal;
}
export interface RuntimeResult { state: RunState; exitCode: number }
export class RuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RuntimeError'; }
}
