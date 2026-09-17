import { posix, win32 } from 'node:path';
import type { Scope, ProtocolSource } from './common.js';
import { CAPABILITY_NAMES, type TaskExecutionRequest, type TaskExecutionResult, type VerificationEvidence, type VerificationPlan, type ExecutorCapabilities } from './execution.js';

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function unique(paths: readonly string[]): void {
  invariant(new Set(paths.map((path) => path.toLowerCase())).size === paths.length, 'Duplicate or case-aliased paths/IDs');
}
function editable(path: string): boolean {
  return !path.split('/').some((part) => part.toLowerCase() === '.git');
}
export function validateScope(scope: Scope): void {
  const planning = scope.planning;
  const paths = [planning.taskPath, planning.archivePath, planning.dashboardPath, planning.archiveIndexPath];
  unique(paths); unique([...scope.files, ...scope.directories]);
  unique([...new Set([...paths, ...scope.files, ...scope.directories])]);
  invariant([...paths, ...scope.files, ...scope.directories].every(editable), 'Git/private state is outside editable scope');
  invariant(planning.taskPath.endsWith(`/${planning.taskId}.md`) && planning.archivePath.endsWith(`/${planning.taskId}.md`), 'Planning paths must identify the Task');
}
export function validateProtocolSource(value: ProtocolSource): void {
  unique(value.files.map((file) => file.path));
}
export function validatePlan(plan: VerificationPlan): void {
  const checks = [...plan.commands, ...plan.manual];
  invariant(checks.length > 0, 'Verification plan requires at least one check');
  unique(checks.map((check) => check.id)); unique(plan.sources.map((source) => source.path));
  for (const command of plan.commands) {
    unique(command.writableArtifacts);
    invariant(command.writableArtifacts.every((path) => editable(path) && !plan.sources.some((source) => source.path === path)), 'Verification cannot write Git metadata or its frozen sources');
  }
}
export function validateRequest(value: TaskExecutionRequest): void {
  validateScope(value.scope); validatePlan(value.verificationPlan); validateProtocolSource(value.protocolSource);
  const planningRoot = value.scope.planning.dashboardPath.slice(0, value.scope.planning.dashboardPath.lastIndexOf('/'));
  for (const command of value.verificationPlan.commands) invariant(command.writableArtifacts.every((path) => !path.startsWith(`${planningRoot}/`) && !['AGENTS.md', 'HARNESS.md'].includes(path) && !value.scope.files.includes(path) && !value.scope.directories.some((dir) => path.startsWith(`${dir}/`))), 'Verification artifacts cannot overlap Planning, governance or Task source scope');
  invariant(value.authorization.runId === value.runId && value.scope.planning.taskId === value.taskId, 'Authorization and scope must bind execution identity');
  invariant(value.env.DEV_HARNESS_RUN_ID === value.runId && value.env.DEV_HARNESS_TASK_ID === value.taskId, 'Worker environment must bind execution identity');
  const path = /^[A-Za-z]:[\\/]/u.test(value.repoRoot) || value.repoRoot.startsWith('\\\\') ? win32 : posix;
  const relative = (target: string) => path.relative(value.repoRoot, target).replaceAll('\\', '/');
  for (const target of [value.docsRoot, value.dashboardPath, value.taskPath]) {
    const rel = relative(target);
    invariant(rel !== '' && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel), 'Request paths must be inside repoRoot');
  }
  invariant(relative(value.taskPath) === value.scope.planning.taskPath && relative(value.dashboardPath) === value.scope.planning.dashboardPath, 'Absolute and relative Planning paths disagree');
  const docs = relative(value.docsRoot);
  invariant([value.scope.planning.taskPath, value.scope.planning.dashboardPath, value.scope.planning.archivePath, value.scope.planning.archiveIndexPath].every((p) => p.startsWith(`${docs}/`)), 'Planning paths must be inside docsRoot');
  invariant(value.verificationPlan.sources.some((source) => source.path === 'HARNESS.md') && value.verificationPlan.sources.some((source) => source.path === value.scope.planning.taskPath), 'Verification sources require HARNESS and the current Task');
}
export function validateEvidence(value: VerificationEvidence): void {
  invariant(Date.parse(value.startedAt) <= Date.parse(value.finishedAt), 'Verification finishes before it starts');
  if (value.kind === 'command') {
    invariant(value.result !== 'passed' || value.exitCode === 0, 'Passed command must exit zero');
    invariant(value.result !== 'failed' || (value.exitCode !== null && value.exitCode !== 0), 'Failed command requires a nonzero exit code');
  }
}
export function validateResult(value: TaskExecutionResult): void {
  unique(value.changedFiles); unique(value.verification.map((evidence) => evidence.id));
  for (const evidence of value.verification) {
    validateEvidence(evidence);
    invariant(['runId', 'taskId', 'attempt', 'requestId'].every((key) => Reflect.get(evidence, key) === Reflect.get(value, key)), 'Evidence identity mismatch');
  }
  if (value.closure !== undefined) invariant(value.closure.taskId === value.taskId, 'Closure Task mismatch');
  if (value.outcome === 'completed') {
    invariant(value.verification.length > 0 && value.verification.every((evidence) => evidence.result === 'passed'), 'Completed result requires passed verification');
    invariant(value.closure.taskId === value.taskId, 'Closure Task mismatch');
    unique(value.closure.changes.map((change) => change.path));
    const closurePaths = [value.closure.taskPath, value.closure.archivePath, value.closure.archiveIndexPath, value.closure.dashboardPath];
    unique(closurePaths);
    invariant(value.closure.changes.length === 4 && closurePaths.every((path) => value.closure.changes.some((change) => change.path === path) && value.changedFiles.includes(path)), 'Closure requires exactly four declared Planning changes');
    for (const change of value.closure.changes) {
      invariant(change.beforeHash !== change.afterHash, 'Closure change must alter content');
      if (change.path === value.closure.taskPath) invariant(change.beforeHash !== null && change.afterHash === null, 'Active Task must be removed');
      else if (change.path === value.closure.archivePath) invariant(change.beforeHash === null && change.afterHash !== null, 'Task archive must be created');
      else invariant(change.afterHash !== null, 'Dashboard/index must remain present');
    }
  }
}
export function validateCapabilities(value: ExecutorCapabilities): void {
  for (const name of CAPABILITY_NAMES) invariant(!value[name] || value.evidence.some((item) => item.capability === name), `Capability ${name} requires evidence`);
  invariant(CAPABILITY_NAMES.every((name) => value[name]) || value.reasons.length > 0, 'Unavailable capabilities require reasons');
}
