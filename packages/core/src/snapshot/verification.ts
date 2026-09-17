import { ContractValidationError, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { assertTaskStart, assertUnchanged, compareSnapshots } from './guard.js';
import type { CapturedSnapshot } from './types.js';

const includes = (root: string, path: string) => root === path || path.startsWith(`${root}/`);
function requireBoundary(value: unknown, message: string): asserts value {
  if (!value) throw new ContractValidationError('AUTHORIZATION_VIOLATION', message);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Verification has a narrower write policy than a Worker: only explicit untracked artifacts. */
export function assertVerificationArtifacts(request: TaskExecutionRequest, initial: CapturedSnapshot, boundary: CapturedSnapshot, roots: readonly string[]): void {
  const declared = request.verificationPlan.commands.flatMap((command) => command.writableArtifacts);
  const protectedPaths = [...request.scope.files, ...request.scope.directories, ...request.verificationPlan.sources.map((source) => source.path),
    request.scope.planning.dashboardPath.slice(0, request.scope.planning.dashboardPath.lastIndexOf('/')), 'AGENTS.md', 'HARNESS.md', boundary.snapshot.gitWorkflowRef.path];
  for (const root of roots) {
    requireBoundary(declared.includes(root), 'Verification artifact was not declared in the frozen plan');
    requireBoundary(!protectedPaths.some((path) => includes(root, path) || includes(path, root)), 'Verification artifact overlaps source, Planning or frozen governance');
    requireBoundary(!initial.dirtyPaths.some((path) => includes(root, path)), 'Verification cannot overwrite initial user content');
    requireBoundary(!boundary.snapshot.paths.some((entry) => includes(root, entry.path) && entry.index.length > 0), 'Verification artifacts must not include tracked project files');
  }
}

/** Does not establish command provenance; callers must also verify the controlled process receipt. */
export function assertVerificationTransition(initial: CapturedSnapshot, before: CapturedSnapshot, after: CapturedSnapshot, request: TaskExecutionRequest,
  roots: readonly string[] = request.verificationPlan.commands.flatMap((command) => command.writableArtifacts)): string[] {
  assertTaskStart(initial, before, request.scope);
  assertUnchanged(before, before); assertUnchanged(after, after);
  assertVerificationArtifacts(request, initial, before, roots);
  const delta = compareSnapshots(before.snapshot, after.snapshot);
  requireBoundary(!delta.headChanged && !delta.branchChanged && !delta.indexChanged, 'Verification changed Git identity or index');
  requireBoundary(delta.paths.every((path) => roots.some((root) => includes(root, path))), 'Verification changed content outside declared artifacts');
  for (const path of delta.paths) {
    const entry = after.snapshot.paths.find((entry) => entry.path === path);
    requireBoundary(!entry || ((entry.type === 'file' || entry.type === 'missing') && entry.index.length === 0), 'Verification produced a symlink, gitlink or tracked artifact');
  }
  const projection = (value: CapturedSnapshot) => ({ ...value.snapshot, capturedAt: '', paths: value.snapshot.paths.filter((entry) => !roots.some((root) => includes(root, entry.path))),
    dirtyPaths: value.snapshot.dirtyPaths.filter((path) => !roots.some((root) => includes(root, path))) });
  requireBoundary(canonical(projection(before)) === canonical(projection(after)), 'Verification changed a non-artifact boundary');
  return delta.contentPaths;
}
