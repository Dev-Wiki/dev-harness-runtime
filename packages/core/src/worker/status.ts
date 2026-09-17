import type { LockProject } from '../lock/paths.js';
import { inspectRunView } from '../state/inspect.js';
import { projectParentContext, type ParentContextSummary } from './summary.js';

/** Status is lock-free and read-only; verbose consumers may display refs, never log bytes. */
export async function inspectParentContext(project: LockProject, runId: string): Promise<ParentContextSummary> {
  return inspectRunView(project, runId, projectParentContext);
}
