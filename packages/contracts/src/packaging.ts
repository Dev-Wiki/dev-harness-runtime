import { Type, type Static } from '@sinclair/typebox';
import {
  AbsolutePathSchema, EvidenceRefSchema, FileDigestSchema, GitOidSchema, HashSchema,
  IdSchema, ProtocolSourceSchema, RelativePathSchema, SafeIntegerSchema,
  SchemaVersionSchema, SemVerSchema, TextSchema, TimestampSchema, object,
} from './common.js';

const RepositorySchema = Type.String({ pattern: '^https://[^\\s]+$', maxLength: 2048 });

export const BuildSourceSchema = object({
  schemaVersion: SchemaVersionSchema,
  repository: RepositorySchema,
  version: SemVerSchema,
  commit: GitOidSchema,
  path: RelativePathSchema,
});
export type BuildSource = Static<typeof BuildSourceSchema>;

export const SkillSourceSchema = object({
  schemaVersion: SchemaVersionSchema,
  name: IdSchema,
  path: RelativePathSchema,
  sha256: HashSchema,
  source: BuildSourceSchema,
});
export type SkillSource = Static<typeof SkillSourceSchema>;

export const BundleSchema = object({
  schemaVersion: SchemaVersionSchema,
  version: SemVerSchema,
  path: RelativePathSchema,
  sha256: HashSchema,
  source: BuildSourceSchema,
});
export type Bundle = Static<typeof BundleSchema>;

export const PluginMetadataSchema = object({
  schemaVersion: SchemaVersionSchema,
  name: IdSchema,
  displayName: TextSchema,
  description: TextSchema,
  author: TextSchema,
  repository: RepositorySchema,
  licenseRefs: Type.Array(FileDigestSchema, { minItems: 1 }),
});
export type PluginMetadata = Static<typeof PluginMetadataSchema>;

export const PluginBuildInputSchema = object({
  schemaVersion: SchemaVersionSchema,
  platform: IdSchema,
  releaseVersion: SemVerSchema,
  adapterVersion: SemVerSchema,
  coreProtocolVersion: SchemaVersionSchema,
  protocolSource: ProtocolSourceSchema,
  skills: Type.Array(SkillSourceSchema, { minItems: 1 }),
  runtimeBundle: BundleSchema,
  adapterBundle: BundleSchema,
  metadata: PluginMetadataSchema,
  buildTimestamp: TimestampSchema,
});
export type PluginBuildInput = Static<typeof PluginBuildInputSchema>;

export const GeneratedPluginSchema = object({
  schemaVersion: SchemaVersionSchema,
  platform: IdSchema,
  adapterVersion: SemVerSchema,
  root: RelativePathSchema,
  files: Type.Array(FileDigestSchema, { minItems: 1 }),
  inputHash: HashSchema,
});
export type GeneratedPlugin = Static<typeof GeneratedPluginSchema>;

export const ValidationReportSchema = object({
  schemaVersion: SchemaVersionSchema,
  valid: Type.Boolean(),
  checks: Type.Array(object({
    code: Type.String({ pattern: '^[A-Z][A-Z0-9_]*$', maxLength: 128 }),
    path: RelativePathSchema,
    message: TextSchema,
    severity: Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('error')]),
  }), { minItems: 1 }),
  inputHash: HashSchema,
  evidenceRefs: Type.Array(EvidenceRefSchema, { minItems: 1 }),
});
export type ValidationReport = Static<typeof ValidationReportSchema>;

export const ArtifactSchema = object({
  schemaVersion: SchemaVersionSchema,
  platform: IdSchema,
  variant: IdSchema,
  version: SemVerSchema,
  coreProtocolVersion: SchemaVersionSchema,
  file: RelativePathSchema,
  mediaType: Type.String({ pattern: '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$', maxLength: 255 }),
  size: SafeIntegerSchema,
  sha256: HashSchema,
  inputHash: HashSchema,
});
export type Artifact = Static<typeof ArtifactSchema>;

export const ReleaseManifestSchema = object({
  schemaVersion: SchemaVersionSchema,
  releaseVersion: SemVerSchema,
  coreProtocolVersion: SchemaVersionSchema,
  sourceCommit: GitOidSchema,
  protocolSource: ProtocolSourceSchema,
  adapterCompatibility: Type.Array(object({
    platform: IdSchema,
    adapterVersion: SemVerSchema,
    coreProtocolVersion: SchemaVersionSchema,
    targetVersion: TextSchema,
  }), { minItems: 1 }),
  artifacts: Type.Array(ArtifactSchema, { minItems: 1 }),
});
export type ReleaseManifest = Static<typeof ReleaseManifestSchema>;

export const HostEnvironmentSchema = object({
  schemaVersion: SchemaVersionSchema,
  repoRoot: AbsolutePathSchema,
  privateGitDir: AbsolutePathSchema,
  os: IdSchema,
  architecture: IdSchema,
  nodeVersion: SemVerSchema,
  gitVersion: TextSchema,
  hostExecutable: Type.Union([AbsolutePathSchema, Type.Null()]),
  targetVersion: TextSchema,
  configHash: HashSchema,
});
export type HostEnvironment = Static<typeof HostEnvironmentSchema>;

export const AdapterDoctorResultSchema = object({
  schemaVersion: SchemaVersionSchema,
  available: Type.Boolean(),
  targetVersion: TextSchema,
  observedVersion: Type.Union([TextSchema, Type.Null()]),
  checks: Type.Array(object({
    code: Type.String({ pattern: '^[A-Z][A-Z0-9_]*$', maxLength: 128 }),
    status: Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('unknown')]),
    message: TextSchema,
    evidenceRefs: Type.Array(EvidenceRefSchema),
  }), { minItems: 1 }),
  missingPrerequisites: Type.Array(TextSchema, { uniqueItems: true }),
  evidenceRefs: Type.Array(EvidenceRefSchema),
});
export type AdapterDoctorResult = Static<typeof AdapterDoctorResultSchema>;

const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
    throw new Error(`${label} must be unique, including case aliases`);
  }
};

/** Structural parsing must precede these checks; no filesystem or host claims are made. */
export function validatePluginBuildInput(value: PluginBuildInput): void {
  for (const text of [value.metadata.displayName, value.metadata.description, value.metadata.author]) {
    if (/^(?:TODO|TBD|FIXME|UNKNOWN|MISSING|<[^<>]+>|\{\{[^{}]+\}\})$/i.test(text.trim())) {
      throw new Error('Plugin metadata must not contain unfinished placeholders');
    }
  }
  assertUnique(value.skills.map((skill) => skill.name), 'Skill names');
  assertUnique(value.skills.map((skill) => skill.path), 'Skill paths');
  assertUnique(value.metadata.licenseRefs.map((ref) => ref.path), 'License references');
  assertUnique(value.protocolSource.files.map((file) => file.path), 'Protocol files');
  if (value.runtimeBundle.version !== value.releaseVersion
    || value.adapterBundle.version !== value.adapterVersion
    || value.runtimeBundle.source.version !== value.runtimeBundle.version
    || value.adapterBundle.source.version !== value.adapterBundle.version) {
    throw new Error('Bundle, source, release and adapter versions must agree');
  }
}

export function validateGeneratedPlugin(value: GeneratedPlugin): void {
  assertUnique(value.files.map((file) => file.path), 'Generated files');
}

export function validateValidationReport(value: ValidationReport): void {
  if (value.valid === value.checks.some((check) => check.severity === 'error')) {
    throw new Error('Validation status must agree with error checks');
  }
}

export function validateReleaseManifest(value: ReleaseManifest): void {
  assertUnique(value.adapterCompatibility.map((adapter) => adapter.platform), 'Adapter platforms');
  assertUnique(value.artifacts.map((artifact) => artifact.file), 'Artifact files');
  assertUnique(value.artifacts.map((artifact) => `${artifact.platform}/${artifact.variant}`), 'Artifact variants');
  assertUnique(value.protocolSource.files.map((file) => file.path), 'Protocol files');
  for (const artifact of value.artifacts) {
    if (artifact.version !== value.releaseVersion || artifact.coreProtocolVersion !== value.coreProtocolVersion) {
      throw new Error('Artifact versions must agree with the release manifest');
    }
    if (!value.adapterCompatibility.some((adapter) => adapter.platform === artifact.platform)) {
      throw new Error('Every artifact must reference a declared adapter');
    }
  }
  for (const adapter of value.adapterCompatibility) {
    if (adapter.coreProtocolVersion !== value.coreProtocolVersion) {
      throw new Error('Adapter protocol versions must agree with the release manifest');
    }
  }
}

export function validateAdapterDoctorResult(value: AdapterDoctorResult): void {
  assertUnique(value.checks.map((check) => check.code), 'Doctor check codes');
  if (value.available && (value.observedVersion === null
    || value.missingPrerequisites.length !== 0
    || value.checks.some((check) => check.status !== 'passed')
    || value.evidenceRefs.length === 0)) {
    throw new Error('Available adapters require an observed version, passed checks and evidence');
  }
}
