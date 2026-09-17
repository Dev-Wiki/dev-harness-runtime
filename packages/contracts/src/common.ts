import { Type, type TProperties, type Static } from '@sinclair/typebox';

export const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
export const SchemaVersionSchema = Type.Literal(1);
export const SafeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const AttemptSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const IdSchema = Type.String({ pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 64 });
export const RunIdSchema = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' });
export const TaskIdSchema = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$' });
export const TokenSchema = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' });
export const TextSchema = Type.String({ minLength: 1, maxLength: 4096 });
export const HashSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const GitOidSchema = Type.String({ pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' });
export const SemVerSchema = Type.String({ format: 'semver' });
export const TimestampSchema = Type.String({ format: 'utc-timestamp' });
export const RelativePathSchema = Type.String({ minLength: 1, maxLength: 4096, format: 'repo-path' });
export const AbsolutePathSchema = Type.String({ minLength: 1, maxLength: 4096, format: 'absolute-path' });
export const CwdSchema = Type.Union([Type.Literal('.'), RelativePathSchema]);
export const FileDigestSchema = object({ path: RelativePathSchema, sha256: HashSchema });
export const EvidenceRefSchema = object({ schemaVersion: SchemaVersionSchema, path: RelativePathSchema, sha256: HashSchema });
export type EvidenceRef = Static<typeof EvidenceRefSchema>;
export const ProtocolSourceSchema = object({
  schemaVersion: SchemaVersionSchema,
  repository: Type.String({ pattern: '^https://[^\\s]+$', maxLength: 2048 }),
  version: SemVerSchema,
  commit: GitOidSchema,
  files: Type.Array(FileDigestSchema, { minItems: 1 }),
});
export type ProtocolSource = Static<typeof ProtocolSourceSchema>;
export const RepoIdentitySchema = object({
  repoRoot: AbsolutePathSchema, privateGitDir: AbsolutePathSchema,
  head: GitOidSchema, branch: Type.Union([TextSchema, Type.Null()]),
});
export const SelectionModeSchema = Type.Union([
  object({ mode: Type.Literal('explicit'), taskId: TaskIdSchema }),
  object({ mode: Type.Literal('next') }), object({ mode: Type.Literal('all-ready') }),
]);
const externalDenials = {
  push: Type.Literal(false), pullRequest: Type.Literal(false), tag: Type.Literal(false),
  release: Type.Literal(false), deploy: Type.Literal(false),
};
export const RunAuthorizationSchema = object({
  schemaVersion: SchemaVersionSchema, runId: RunIdSchema,
  commit: Type.Union([Type.Literal('deny'), Type.Literal('task')]), ...externalDenials,
});
export const WorkerAuthorizationSchema = object({
  schemaVersion: SchemaVersionSchema, runId: RunIdSchema, commit: Type.Literal('deny'), ...externalDenials,
});
export type RunAuthorization = Static<typeof RunAuthorizationSchema>;
export type WorkerAuthorization = Static<typeof WorkerAuthorizationSchema>;
export const ExecutionIdentityProperties = {
  runId: RunIdSchema, taskId: TaskIdSchema, attempt: AttemptSchema, requestId: TokenSchema,
};
export const ExecutionIdentitySchema = object(ExecutionIdentityProperties);
export const ScopeSchema = object({
  schemaVersion: SchemaVersionSchema,
  files: Type.Array(RelativePathSchema, { uniqueItems: true }),
  directories: Type.Array(RelativePathSchema, { uniqueItems: true }),
  planning: object({
    taskId: TaskIdSchema, taskPath: RelativePathSchema, archivePath: RelativePathSchema,
    dashboardPath: RelativePathSchema, archiveIndexPath: RelativePathSchema,
  }),
});
export type Scope = Static<typeof ScopeSchema>;
