export class PlanningError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string, readonly line?: number) {
    super(`${message}${path ? ` (${path}${line ? `:${line}` : ''})` : ''}`); this.name = 'PlanningError';
  }
}
export interface PlanningReference { path: string; sha256: string }
export interface PlanningDependency { id: string; path?: string; completed: boolean }
export interface PlanningTask {
  id: string; title: string; priority: string; status: string; blocker: string;
  taskPath: string; dependencies: PlanningDependency[];
  contextComplete: boolean; contextProblems: string[];
}
export interface PlanningDocument {
  dashboardPath: string; order: string[]; tasks: PlanningTask[]; references: PlanningReference[];
}
export type TaskSelection = { mode: 'explicit'; taskId: string } | { mode: 'next' } | { mode: 'all-ready' };
export type SelectionResult = { status: 'selected'; task: PlanningTask }
  | { status: 'completed'; reason: 'queueExhausted' }
  | { status: 'blocked'; reasons: { taskId: string; code: string; message: string }[] };
