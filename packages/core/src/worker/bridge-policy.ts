import { isRepoPath, parseContract, type Scope } from '@dev-harness-runtime/contracts';

/** The exact path predicate shared by the Worker bridge and final snapshot guard. */
export function createWorkerWritePolicy(scopeInput: Scope): (path: string) => boolean {
  const scope = parseContract('scope', scopeInput);
  const planningPaths = new Set([
    scope.planning.taskPath, scope.planning.archivePath,
    scope.planning.dashboardPath, scope.planning.archiveIndexPath,
  ]);
  const planningRoot = scope.planning.dashboardPath.slice(0, scope.planning.dashboardPath.lastIndexOf('/'));
  const files = new Set(scope.files);
  const directories = scope.directories.map((directory) => `${directory}/`);
  return (path: string): boolean => {
    if (typeof path !== 'string' || !isRepoPath(path) || path.split('/').some((part) => part.toLowerCase() === '.git')) return false;
    if (path.startsWith(`${planningRoot}/`)) return planningPaths.has(path);
    return files.has(path) || directories.some((directory) => path.startsWith(directory));
  };
}
