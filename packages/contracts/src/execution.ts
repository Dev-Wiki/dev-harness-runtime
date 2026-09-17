import { Type, type Static } from '@sinclair/typebox';
import {
  object, SchemaVersionSchema, TokenSchema, TaskIdSchema, IdSchema, TextSchema,
  HashSchema, GitOidSchema, TimestampSchema, RelativePathSchema, AbsolutePathSchema,
  CwdSchema, FileDigestSchema, EvidenceRefSchema, ProtocolSourceSchema,
  ExecutionIdentityProperties, ScopeSchema, WorkerAuthorizationSchema,
} from './common.js';

const acceptanceIds = Type.Array(TokenSchema, { minItems: 1, uniqueItems: true });
const argv = Type.Array(Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\u0000]+$' }), { minItems: 1, maxItems: 128 });
export const VerificationCommandSchema = object({
  id: TokenSchema, acceptanceIds, argv, cwd: CwdSchema,
  writableArtifacts: Type.Array(RelativePathSchema, { uniqueItems: true }),
});
export const VerificationPlanSchema = object({
  schemaVersion: SchemaVersionSchema,
  sources: Type.Array(FileDigestSchema, { minItems: 1 }),
  commands: Type.Array(VerificationCommandSchema),
  manual: Type.Array(object({ id: TokenSchema, acceptanceIds, description: TextSchema })),
});
export type VerificationPlan = Static<typeof VerificationPlanSchema>;
const evidenceCommon = {
  schemaVersion: SchemaVersionSchema, ...ExecutionIdentityProperties,
  id: TokenSchema, acceptanceIds,
  beforeSnapshotHash: HashSchema, afterSnapshotHash: HashSchema,
  startedAt: TimestampSchema, finishedAt: TimestampSchema,
  result: Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('blocked')]),
};
export const VerificationEvidenceSchema = Type.Union([
  object({ ...evidenceCommon, kind: Type.Literal('command'), argv, cwd: CwdSchema,
    exitCode: Type.Union([Type.Integer({ minimum: -2147483648, maximum: 2147483647 }), Type.Null()]),
    stdout: EvidenceRefSchema, stderr: EvidenceRefSchema }),
  object({ ...evidenceCommon, kind: Type.Literal('manual'), reviewer: TextSchema, confirmation: EvidenceRefSchema }),
]);
export type VerificationEvidence = Static<typeof VerificationEvidenceSchema>;
export const ClosureSchema = object({
  schemaVersion: SchemaVersionSchema, taskId: TaskIdSchema,
  taskPath: RelativePathSchema, archivePath: RelativePathSchema,
  archiveIndexPath: RelativePathSchema, dashboardPath: RelativePathSchema, summary: TextSchema,
  changes: Type.Array(object({ path: RelativePathSchema,
    beforeHash: Type.Union([HashSchema, Type.Null()]), afterHash: Type.Union([HashSchema, Type.Null()]) }), { minItems: 4 }),
});
export type Closure = Static<typeof ClosureSchema>;
export const CommitIntentSchema = object({
  schemaVersion: SchemaVersionSchema, message: TextSchema,
  paths: Type.Array(RelativePathSchema, { minItems: 1, uniqueItems: true }), workflow: FileDigestSchema,
});
export const TaskExecutionRequestSchema = object({
  schemaVersion: SchemaVersionSchema, coreProtocolVersion: SchemaVersionSchema,
  ...ExecutionIdentityProperties,
  repoRoot: AbsolutePathSchema, docsRoot: AbsolutePathSchema,
  dashboardPath: AbsolutePathSchema, taskPath: AbsolutePathSchema,
  snapshotRef: RelativePathSchema, snapshotHash: HashSchema,
  scope: ScopeSchema, authorization: WorkerAuthorizationSchema,
  verificationPlan: VerificationPlanSchema, protocolSource: ProtocolSourceSchema,
  env: object({ DEV_HARNESS_WORKER: Type.Literal('1'),
    DEV_HARNESS_RUN_ID: Type.String(), DEV_HARNESS_TASK_ID: TaskIdSchema, DEV_HARNESS_ADAPTER: IdSchema }),
});
export type TaskExecutionRequest = Static<typeof TaskExecutionRequestSchema>;
const resultCommon = {
  schemaVersion: SchemaVersionSchema, ...ExecutionIdentityProperties,
  snapshotHash: HashSchema, summary: TextSchema,
  verification: Type.Array(VerificationEvidenceSchema),
  changedFiles: Type.Array(RelativePathSchema, { uniqueItems: true }),
  rawResultRef: Type.Optional(EvidenceRefSchema),
};
const completed = {
  ...resultCommon, outcome: Type.Literal('completed'), needsPlanning: Type.Literal(false),
  closure: ClosureSchema, reason: Type.Optional(TextSchema), commitIntent: Type.Optional(CommitIntentSchema),
};
export const TaskExecutionResultSchema = Type.Union([
  object(completed),
  object({ ...resultCommon,
    outcome: Type.Union([Type.Literal('blocked'), Type.Literal('failed'), Type.Literal('partial')]),
    needsPlanning: Type.Boolean(), reason: TextSchema, closure: Type.Optional(ClosureSchema) }),
]);
export type TaskExecutionResult = Static<typeof TaskExecutionResultSchema>;
export const AcceptedTaskExecutionResultSchema = object({
  ...completed, commitSha: Type.Optional(GitOidSchema), acceptedAt: TimestampSchema,
  acceptedSnapshotHash: HashSchema,
  verifiedEvidenceRefs: Type.Array(EvidenceRefSchema, { minItems: 1 }),
});
export type AcceptedTaskExecutionResult = Static<typeof AcceptedTaskExecutionResultSchema>;
export const CAPABILITY_NAMES = ['available', 'freshSession', 'structuredOutput', 'nonInteractive',
  'cancellation', 'resumeRunWithFreshSession', 'pluginPackaging', 'authorizationEnforced'] as const;
const CapabilityNameSchema = Type.Union(CAPABILITY_NAMES.map((name) => Type.Literal(name)));
export const ExecutorCapabilitiesSchema = object({
  schemaVersion: SchemaVersionSchema, coreProtocolVersion: SchemaVersionSchema,
  adapterId: IdSchema, targetVersion: TextSchema,
  available: Type.Boolean(), freshSession: Type.Boolean(), structuredOutput: Type.Boolean(),
  nonInteractive: Type.Boolean(), cancellation: Type.Boolean(), resumeRunWithFreshSession: Type.Boolean(),
  pluginPackaging: Type.Boolean(), authorizationEnforced: Type.Boolean(),
  reasons: Type.Array(TextSchema),
  evidence: Type.Array(object({ capability: CapabilityNameSchema, observedAt: TimestampSchema, ref: EvidenceRefSchema })),
});
export type ExecutorCapabilities = Static<typeof ExecutorCapabilitiesSchema>;
