import { CAPABILITY_NAMES, type TaskExecutionRequest, type TaskExecutionResult } from './execution.js';
import { ContractValidationError, parseContract } from './validation.js';

function check(condition: boolean, message: string, code: 'INVALID_RESULT' | 'AUTHORIZATION_VIOLATION' = 'INVALID_RESULT'): asserts condition {
  if (!condition) throw new ContractValidationError(code, message);
}
/** Checks declarations against the request. Core must independently verify all disk/process evidence. */
export function validateResultForRequest(requestInput: unknown, resultInput: unknown): TaskExecutionResult {
  const request = parseContract('taskExecutionRequest', requestInput);
  if (typeof resultInput === 'object' && resultInput !== null && Object.hasOwn(resultInput, 'commitSha')) throw new ContractValidationError('AUTHORIZATION_VIOLATION', 'Worker cannot claim a commit');
  let result: TaskExecutionResult;
  try { result = parseContract('taskExecutionResult', resultInput); }
  catch (error) { throw new ContractValidationError('INVALID_RESULT', error instanceof Error ? error.message : 'Invalid result'); }
  for (const key of ['runId', 'taskId', 'attempt', 'requestId', 'snapshotHash'] as const) check(result[key] === request[key], `Result ${key} mismatch`);
  const planning = request.scope.planning;
  const closurePaths = [planning.taskPath, planning.archivePath, planning.dashboardPath, planning.archiveIndexPath];
  const planningRoot = planning.dashboardPath.slice(0, planning.dashboardPath.lastIndexOf('/'));
  for (const path of result.changedFiles) check(!(path.startsWith(`${planningRoot}/`) && !closurePaths.includes(path)), 'Other Planning files are outside this Task closure', 'AUTHORIZATION_VIOLATION');
  for (const path of result.changedFiles) check(!path.split('/').some((part) => part.toLowerCase() === '.git') && (request.scope.files.includes(path) || request.scope.directories.some((dir) => path.startsWith(`${dir}/`)) || closurePaths.includes(path)), `Out-of-scope change: ${path}`, 'AUTHORIZATION_VIOLATION');
  const plan = request.verificationPlan;
  for (const evidence of result.verification) {
    const expected = evidence.kind === 'command' ? plan.commands.find((entry) => entry.id === evidence.id) : plan.manual.find((entry) => entry.id === evidence.id);
    check(expected !== undefined, 'Unexpected verification');
    check(JSON.stringify([...expected.acceptanceIds].sort()) === JSON.stringify([...evidence.acceptanceIds].sort()), 'Acceptance identity mismatch');
    if (evidence.kind === 'command' && 'argv' in expected) check(JSON.stringify(evidence.argv) === JSON.stringify(expected.argv) && evidence.cwd === expected.cwd, 'Verification command mismatch');
  }
  if (result.closure !== undefined) {
    for (const key of ['taskId', 'taskPath', 'archivePath', 'dashboardPath', 'archiveIndexPath'] as const) check(result.closure[key] === planning[key], 'Closure does not match authorized Planning paths');
  }
  if (result.outcome === 'completed') {
    check(result.verification.length === plan.commands.length + plan.manual.length, 'Incomplete verification coverage');

    if (result.commitIntent) check(JSON.stringify([...result.commitIntent.paths].sort()) === JSON.stringify([...result.changedFiles].sort()), 'Commit intent paths must match declared changes', 'AUTHORIZATION_VIOLATION');
  }
  return result;
}
export function assertSnapshotHash(expected: string, actual: string): void {
  if (expected !== actual) throw new ContractValidationError('DRIFT_DETECTED', 'Snapshot changed across the guarded boundary');
}
/** Evidence references are claims until the caller resolves their trusted provenance. */
export function requireExecutionCapabilities(input: unknown): void {
  const capabilities = parseContract('executorCapabilities', input);
  const missing = CAPABILITY_NAMES.filter((name) => name !== 'pluginPackaging' && !capabilities[name]);
  if (missing.length) throw new ContractValidationError('CAPABILITY_MISSING', `Missing capabilities: ${missing.join(', ')}`);
}
export function attemptId(request: Pick<TaskExecutionRequest, 'taskId' | 'attempt'>): string {
  return `${request.taskId}-${request.attempt}`;
}
