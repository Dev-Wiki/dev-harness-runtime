import { Ajv, type ValidateFunction } from 'ajv';
import type { Static, TSchema } from '@sinclair/typebox';
import * as common from './common.js';
import * as execution from './execution.js';
import * as state from './state.js';
import * as packaging from './packaging.js';
import { validateRequest, validateResult, validateEvidence, validateCapabilities, validatePlan, validateScope, validateProtocolSource } from './semantics.js';

export const contractSchemas = {
  taskExecutionRequest: execution.TaskExecutionRequestSchema,
  taskExecutionResult: execution.TaskExecutionResultSchema,
  acceptedTaskExecutionResult: execution.AcceptedTaskExecutionResultSchema,
  verificationEvidence: execution.VerificationEvidenceSchema,
  verificationPlan: execution.VerificationPlanSchema,
  executorCapabilities: execution.ExecutorCapabilitiesSchema,
  scope: common.ScopeSchema,
  runAuthorization: common.RunAuthorizationSchema,
  workerAuthorization: common.WorkerAuthorizationSchema,
  protocolSource: common.ProtocolSourceSchema,
  snapshot: state.SnapshotSchema,
  runState: state.RunStateSchema,
  lockMetadata: state.LockMetadataSchema,
  reconciliationResolution: state.ReconciliationResolutionSchema,
  pluginBuildInput: packaging.PluginBuildInputSchema,
  pluginMetadata: packaging.PluginMetadataSchema,
  generatedPlugin: packaging.GeneratedPluginSchema,
  validationReport: packaging.ValidationReportSchema,
  artifact: packaging.ArtifactSchema,
  releaseManifest: packaging.ReleaseManifestSchema,
  hostEnvironment: packaging.HostEnvironmentSchema,
  adapterDoctorResult: packaging.AdapterDoctorResultSchema,
} as const;
export type ContractName = keyof typeof contractSchemas;
export type ContractValue<N extends ContractName> = Static<(typeof contractSchemas)[N]>;
export type ContractErrorCode = 'INVALID_CONTRACT' | 'INVALID_RESULT' | 'DRIFT_DETECTED' | 'AUTHORIZATION_VIOLATION' | 'CAPABILITY_MISSING';
export class ContractValidationError extends Error {
  constructor(readonly code: ContractErrorCode, message: string, readonly issues: readonly { path: string; message: string }[] = []) {
    super(message); this.name = 'ContractValidationError';
  }
}

export function isRepoPath(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in serialized paths.
  return value.length > 0 && !/[\\:\x00-\x1f\x7f]/u.test(value) && value.split('/').every((part) =>
    part !== '' && part !== '.' && part !== '..' && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}
export function isAbsolutePath(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in execution paths.
  if (/[\x00-\x1f\x7f]/u.test(value)) return false;
  if (value.startsWith('\\') && !/^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//u.test(normalized)) return false;
  return !normalized.split('/').some((part) => part === '.' || part === '..');
}
const ajv = new Ajv({ strict: true, allErrors: true, ownProperties: true });
ajv.addFormat('repo-path', isRepoPath);
ajv.addFormat('absolute-path', isAbsolutePath);
ajv.addFormat('utc-timestamp', (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
});
ajv.addFormat('semver', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/);
function parser<S extends TSchema>(schema: S, semantic?: (value: Static<S>) => void) {
  const validate: ValidateFunction<Static<S>> = ajv.compile<Static<S>>(schema);
  return (value: unknown): Static<S> => {
    if (!validate(value)) throw new ContractValidationError('INVALID_CONTRACT', 'Contract schema validation failed',
      (validate.errors ?? []).map((error) => ({ path: error.instancePath, message: error.message ?? error.keyword })));
    try { semantic?.(value); } catch (error) {
      if (error instanceof ContractValidationError) throw error;
      throw new ContractValidationError('INVALID_CONTRACT', error instanceof Error ? error.message : 'Contract relationship failed');
    }
    return value;
  };
}
const parsers = {
  taskExecutionRequest: parser(contractSchemas.taskExecutionRequest, validateRequest),
  taskExecutionResult: parser(contractSchemas.taskExecutionResult, validateResult),
  acceptedTaskExecutionResult: parser(contractSchemas.acceptedTaskExecutionResult, validateResult),
  verificationEvidence: parser(contractSchemas.verificationEvidence, validateEvidence),
  verificationPlan: parser(contractSchemas.verificationPlan, validatePlan),
  executorCapabilities: parser(contractSchemas.executorCapabilities, validateCapabilities),
  scope: parser(contractSchemas.scope, validateScope),
  runAuthorization: parser(contractSchemas.runAuthorization), workerAuthorization: parser(contractSchemas.workerAuthorization),
  protocolSource: parser(contractSchemas.protocolSource, validateProtocolSource),
  snapshot: parser(contractSchemas.snapshot, state.validateSnapshot), runState: parser(contractSchemas.runState, state.validateRunState),
  lockMetadata: parser(contractSchemas.lockMetadata), reconciliationResolution: parser(contractSchemas.reconciliationResolution, state.validateReconciliationResolution),
  pluginBuildInput: parser(contractSchemas.pluginBuildInput, packaging.validatePluginBuildInput),
  pluginMetadata: parser(contractSchemas.pluginMetadata),
  generatedPlugin: parser(contractSchemas.generatedPlugin, packaging.validateGeneratedPlugin),
  validationReport: parser(contractSchemas.validationReport, packaging.validateValidationReport),
  artifact: parser(contractSchemas.artifact), releaseManifest: parser(contractSchemas.releaseManifest, packaging.validateReleaseManifest),
  hostEnvironment: parser(contractSchemas.hostEnvironment), adapterDoctorResult: parser(contractSchemas.adapterDoctorResult, packaging.validateAdapterDoctorResult),
} satisfies { [N in ContractName]: (value: unknown) => ContractValue<N> };
export function parseContract<N extends ContractName>(name: N, value: unknown): ContractValue<N> {
  // Preserve the key/return relationship already checked by `satisfies`; never cast unvalidated input.
  const parse: (value: unknown) => ContractValue<N> = parsers[name];
  return parse(value);
}
export function parseContractJson<N extends ContractName>(name: N, json: string): ContractValue<N> {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new ContractValidationError('INVALID_CONTRACT', 'Malformed or missing JSON'); }
  return parseContract(name, value);
}
