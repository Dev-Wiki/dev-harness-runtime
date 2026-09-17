import { PlanningError, type PlanningDocument, type PlanningTask, type SelectionResult, type TaskSelection } from './types.js';
function reasons(task: PlanningTask): { taskId: string; code: string; message: string }[] {
  const result: { taskId: string; code: string; message: string }[] = [];
  const add = (code: string, message: string) => result.push({ taskId: task.id, code, message });
  if (task.status !== '🟢 待执行') add('TASK_NOT_READY', task.status);
  if (task.blocker !== '无' && !task.blocker.startsWith('无；')) add('TASK_BLOCKED', task.blocker);
  for (const dependency of task.dependencies) if (!dependency.completed) add('DEPENDENCY_UNRESOLVED', dependency.id);
  if (!task.contextComplete) add('TASK_CONTEXT_INCOMPLETE', task.contextProblems.join('; '));
  return result;
}
/** One selection per read. all-ready callers must reread after each accepted result. */
export function selectTask(plan: PlanningDocument, selection: TaskSelection): SelectionResult {
  if (!['explicit', 'next', 'all-ready'].includes(selection.mode)) throw new PlanningError('INVALID_SELECTION', 'Choose exactly one supported selection mode');
  if (selection.mode === 'explicit') {
    const task = plan.tasks.find((entry) => entry.id === selection.taskId);
    if (!task) throw new PlanningError('TASK_NOT_FOUND', `Unknown active Task ${selection.taskId}`, plan.dashboardPath);
    if (!plan.order.includes(task.id)) return { status: 'blocked', reasons: [{ taskId: task.id, code: 'TASK_NOT_ORDERED', message: 'Task is absent from the authoritative order' }] };
    const blocked = reasons(task);
    return blocked.length ? { status: 'blocked', reasons: blocked } : { status: 'selected', task };
  }
  if (plan.order.length === 0) return { status: 'completed', reason: 'queueExhausted' };
  const blocked: { taskId: string; code: string; message: string }[] = [];
  for (const id of plan.order) {
    const task = plan.tasks.find((entry) => entry.id === id);
    if (!task) throw new PlanningError('TASK_NOT_FOUND', `Order references unknown Task ${id}`, plan.dashboardPath);
    const problems = reasons(task);
    if (problems.length === 0) return { status: 'selected', task };
    blocked.push(...problems);
  }
  return { status: 'blocked', reasons: blocked };
}
