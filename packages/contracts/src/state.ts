import { Type, type Static } from '@sinclair/typebox';
import {
  AbsolutePathSchema, AttemptSchema, EvidenceRefSchema, ExecutionIdentitySchema,
  GitOidSchema, HashSchema, IdSchema, ProtocolSourceSchema, RelativePathSchema,
  RepoIdentitySchema, RunAuthorizationSchema, RunIdSchema, SafeIntegerSchema,
  SchemaVersionSchema, ScopeSchema, SelectionModeSchema, TaskIdSchema, TextSchema, TimestampSchema,
  TokenSchema, object,
} from './common.js';

import { validateScope, validateProtocolSource } from './semantics.js';

const FileModeSchema = Type.Union([Type.Literal('100644'), Type.Literal('100755')]);
const IndexModeSchema = Type.Union([
  FileModeSchema, Type.Literal('120000'), Type.Literal('160000'),
]);
const IndexEntrySchema = object({
  stage: Type.Integer({ minimum: 0, maximum: 3 }),
  blob: GitOidSchema,
  mode: IndexModeSchema,
});
const pathProperties = {
  path: RelativePathSchema,
  index: Type.Array(IndexEntrySchema, { maxItems: 3 }),
};

/** Index entries include conflict stages; an empty index denotes an untracked path. */
export const SnapshotPathSchema = Type.Union([
  object({
    ...pathProperties, type: Type.Literal('file'), mode: FileModeSchema,
    deleted: Type.Literal(false), rawContentHash: HashSchema,
  }),
  object({
    ...pathProperties, type: Type.Literal('symlink'), mode: Type.Literal('120000'),
    deleted: Type.Literal(false), symlinkTarget: Type.String({ minLength: 1, maxLength: 4096 }),
  }),
  object({
    ...pathProperties, type: Type.Literal('gitlink'), mode: Type.Literal('160000'),
    deleted: Type.Literal(false), commit: GitOidSchema,
  }),
  object({
    ...pathProperties, type: Type.Literal('missing'), mode: Type.Null(),
    deleted: Type.Literal(true),
  }),
]);

/** Content claims only: capture completeness, realpaths and Git objects need Core verification. */
export const SnapshotSchema = object({
  schemaVersion: SchemaVersionSchema,
  runId: RunIdSchema,
  capturedAt: TimestampSchema,
  repoIdentity: RepoIdentitySchema,
  paths: Type.Array(SnapshotPathSchema),
  dashboardRef: EvidenceRefSchema,
  currentTaskRef: Type.Optional(EvidenceRefSchema),
  dependencyArchiveRefs: Type.Array(EvidenceRefSchema),
  agentsRef: EvidenceRefSchema,
  harnessRef: EvidenceRefSchema,
  gitWorkflowRef: EvidenceRefSchema,
  protocolSource: ProtocolSourceSchema,
  adapterConfigHash: HashSchema,
});
export type Snapshot = Static<typeof SnapshotSchema>;

const OperationKindSchema = Type.Union([
  Type.Literal('execute'), Type.Literal('verify'), Type.Literal('commit'),
]);
const PendingIdentitySchema = object({
  operationId: TokenSchema, kind: OperationKindSchema, identity: ExecutionIdentitySchema,
});
const pendingProperties = {
  schemaVersion: SchemaVersionSchema,
  operationId: TokenSchema,
  identity: ExecutionIdentitySchema,
  scope: ScopeSchema,
  beforeSnapshotRef: EvidenceRefSchema,
  beforeSnapshotHash: HashSchema,
  checkpointRef: Type.Optional(EvidenceRefSchema),
  createdAt: TimestampSchema,
};
export const PendingOperationSchema = Type.Union([
  object({ ...pendingProperties, kind: Type.Literal('execute') }),
  object({ ...pendingProperties, kind: Type.Literal('verify'), verificationPlanRef: EvidenceRefSchema }),
  object({
    ...pendingProperties, kind: Type.Literal('commit'), parent: GitOidSchema,
    paths: Type.Array(RelativePathSchema, { minItems: 1, uniqueItems: true }),
    expectedTree: GitOidSchema, messageHash: HashSchema,
    indexCheckpointRef: Type.Optional(EvidenceRefSchema),
  }),
]);
export type PendingOperation = Static<typeof PendingOperationSchema>;

export const ReconciliationResolutionSchema = object({
  schemaVersion: SchemaVersionSchema,
  runId: RunIdSchema,
  expectedRevision: SafeIntegerSchema,
  currentSnapshotRef: EvidenceRefSchema,
  currentSnapshotHash: HashSchema,
  resolvedBy: TextSchema,
  disposition: TextSchema,
  taskIds: Type.Array(TaskIdSchema, { minItems: 1, uniqueItems: true }),
  evidenceRefs: Type.Array(EvidenceRefSchema, { minItems: 1 }),
  createdAt: TimestampSchema,
});
export type ReconciliationResolution = Static<typeof ReconciliationResolutionSchema>;

const ReconciliationSchema = object({
  schemaVersion: SchemaVersionSchema,
  originalRevision: SafeIntegerSchema,
  originalPendingIdentity: PendingIdentitySchema,
  resolutionRef: EvidenceRefSchema,
  resolvedBy: TextSchema,
  currentSnapshotRef: EvidenceRefSchema,
  currentSnapshotHash: HashSchema,
  taskIds: Type.Array(TaskIdSchema, { minItems: 1, uniqueItems: true }),
  evidenceRefs: Type.Array(EvidenceRefSchema, { minItems: 1 }),
  resolvedAt: TimestampSchema,
  successor: Type.Optional(object({
    runId: RunIdSchema, reservedAt: TimestampSchema,
    createdAt: Type.Optional(TimestampSchema),
  })),
});
const ReconciledFromSchema = object({
  runId: RunIdSchema, revision: SafeIntegerSchema,
  resolutionHash: HashSchema, snapshotHash: HashSchema,
});
export const RunStatusSchema = Type.Union([
  Type.Literal('CREATED'), Type.Literal('RUNNING'), Type.Literal('BLOCKED'),
  Type.Literal('INTERRUPTED'), Type.Literal('FAILED'), Type.Literal('COMPLETED'),
]);
export const RunPhaseSchema = Type.Union([
  Type.Literal('DISCOVERY'), Type.Literal('SELECT'), Type.Literal('SNAPSHOT'),
  Type.Literal('EXECUTE'), Type.Literal('REVALIDATE'), Type.Literal('FINALIZE'),
]);
const StopReasonSchema = object({ code: Type.String({ pattern: '^[A-Z][A-Z0-9_]*$', maxLength: 128 }), message: TextSchema });

export const RunStateSchema = object({
  schemaVersion: SchemaVersionSchema,
  revision: SafeIntegerSchema,
  runId: RunIdSchema,
  adapter: IdSchema,
  status: RunStatusSchema,
  phase: RunPhaseSchema,
  repoIdentity: RepoIdentitySchema,
  selectionMode: SelectionModeSchema,
  protocolSource: ProtocolSourceSchema,
  adapterConfigHash: HashSchema,
  initialUserChangesRef: EvidenceRefSchema,
  initialUserChangesHash: HashSchema,
  acceptedSnapshotRef: EvidenceRefSchema,
  acceptedSnapshotHash: HashSchema,
  currentTaskId: Type.Optional(TaskIdSchema),
  currentAttempt: Type.Optional(AttemptSchema),
  currentRequestId: Type.Optional(TokenSchema),
  completedTasks: Type.Array(TaskIdSchema, { uniqueItems: true }),
  resultRefs: Type.Array(object({ identity: ExecutionIdentitySchema, ref: EvidenceRefSchema })),
  authorization: RunAuthorizationSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  stopReason: Type.Optional(StopReasonSchema),
  pendingOperation: Type.Optional(PendingOperationSchema),
  reconciliation: Type.Optional(ReconciliationSchema),
  reconciledFrom: Type.Optional(ReconciledFromSchema),
});
export type RunState = Static<typeof RunStateSchema>;

export const LockMetadataSchema = object({
  schemaVersion: SchemaVersionSchema,
  ownerToken: TokenSchema,
  runId: RunIdSchema,
  pid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  processStartIdentity: Type.Optional(TextSchema),
  adapter: IdSchema,
  repoRoot: AbsolutePathSchema,
  privateGitDir: AbsolutePathSchema,
  createdAt: TimestampSchema,
});
export type LockMetadata = Static<typeof LockMetadataSchema>;

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function identityKey(identity: Static<typeof ExecutionIdentitySchema>): string {
  return JSON.stringify([identity.runId, identity.taskId, identity.attempt, identity.requestId]);
}

export function validateSnapshot(snapshot: Snapshot): void {
  validateProtocolSource(snapshot.protocolSource);
  const paths = new Set<string>();
  for (const entry of snapshot.paths) {
    const foldedPath = entry.path.toLowerCase();
    invariant(!paths.has(foldedPath), 'Snapshot paths must be unique without case aliases');
    paths.add(foldedPath);
    const stages = entry.index.map((index) => index.stage);
    invariant(new Set(stages).size === stages.length, 'Index stages must be unique for each path');
    invariant(!stages.includes(0) || stages.length === 1, 'Stage zero cannot coexist with conflict stages');
    if (entry.type === 'symlink') invariant(!entry.symlinkTarget.includes('\0'), 'Symlink text cannot contain NUL');
  }
}

/** Validates relationships within a record, never authorizes a disk/Git operation. */
export function validateRunState(state: RunState): void {
  validateProtocolSource(state.protocolSource);
  invariant(state.authorization.runId === state.runId, 'Authorization must bind the Run');
  invariant(Date.parse(state.createdAt) <= Date.parse(state.updatedAt), 'updatedAt precedes createdAt');
  invariant(state.initialUserChangesRef.sha256 === state.initialUserChangesHash, 'Initial user changes digest mismatch');
  invariant(state.acceptedSnapshotRef.sha256 === state.acceptedSnapshotHash, 'Accepted snapshot digest mismatch');
  const current = [state.currentTaskId, state.currentAttempt, state.currentRequestId];
  invariant(current.every((value) => value === undefined) || current.every((value) => value !== undefined), 'Current attempt identity must be complete or absent');
  invariant(new Set(state.completedTasks).size === state.completedTasks.length, 'completedTasks must be unique');
  invariant(state.status !== 'COMPLETED' || state.pendingOperation === undefined, 'COMPLETED cannot have a pending operation');
  if (['BLOCKED', 'INTERRUPTED', 'FAILED'].includes(state.status)) {
    invariant(state.stopReason !== undefined, 'Stopped Runs require stopReason');
  }
  const results = new Set<string>();
  for (const result of state.resultRefs) {
    invariant(result.identity.runId === state.runId, 'Result identity must bind the Run');
    const key = identityKey(result.identity);
    invariant(!results.has(key), 'Result identities must be unique');
    results.add(key);
  }
  const pending = state.pendingOperation;
  if (pending !== undefined) {
    validateScope(pending.scope);
    invariant(pending.identity.runId === state.runId && pending.identity.taskId === state.currentTaskId && pending.identity.attempt === state.currentAttempt && pending.identity.requestId === state.currentRequestId, 'Pending identity must match the current attempt');
    invariant(pending.scope.planning.taskId === pending.identity.taskId, 'Pending scope must bind the current Task');
    invariant(pending.beforeSnapshotRef.sha256 === pending.beforeSnapshotHash, 'Pending boundary digest mismatch');
    invariant(Date.parse(pending.createdAt) >= Date.parse(state.createdAt) && Date.parse(pending.createdAt) <= Date.parse(state.updatedAt), 'Pending operation date is outside Run dates');
    if (pending.kind === 'commit') invariant(state.authorization.commit === 'task', 'Commit intent requires task authorization');
  }
  const reconciliation = state.reconciliation;
  if (reconciliation !== undefined) {
    invariant(reconciliation.originalRevision < state.revision, 'Reconciliation must follow its original revision');
    invariant(reconciliation.originalPendingIdentity.identity.runId === state.runId, 'Reconciliation identity must bind the Run');
    invariant(reconciliation.currentSnapshotRef.sha256 === reconciliation.currentSnapshotHash, 'Reconciliation boundary digest mismatch');
    invariant(Date.parse(reconciliation.resolvedAt) >= Date.parse(state.createdAt) && Date.parse(reconciliation.resolvedAt) <= Date.parse(state.updatedAt), 'Reconciliation date is outside Run dates');
    if (pending !== undefined) {
      invariant(reconciliation.originalPendingIdentity.operationId === pending.operationId && reconciliation.originalPendingIdentity.kind === pending.kind && identityKey(reconciliation.originalPendingIdentity.identity) === identityKey(pending.identity), 'Reconciliation must identify the pending operation');
    }
    const successor = reconciliation.successor;
    if (successor !== undefined) {
      invariant(successor.runId !== state.runId, 'A Run cannot succeed itself');
      invariant(Date.parse(successor.reservedAt) >= Date.parse(reconciliation.resolvedAt) && Date.parse(successor.reservedAt) <= Date.parse(state.updatedAt), 'Successor reservation date is outside reconciliation dates');
      if (successor.createdAt !== undefined) invariant(Date.parse(successor.createdAt) >= Date.parse(successor.reservedAt) && Date.parse(successor.createdAt) <= Date.parse(state.updatedAt), 'Successor creation date is outside reservation dates');
    }
  }
  invariant(state.reconciledFrom?.runId !== state.runId, 'A Run cannot inherit its own reconciliation');
}

export function validateReconciliationResolution(resolution: ReconciliationResolution): void {
  invariant(resolution.currentSnapshotRef.sha256 === resolution.currentSnapshotHash, 'Resolution boundary digest mismatch');
}
