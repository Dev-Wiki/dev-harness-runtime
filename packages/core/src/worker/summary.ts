import { parseContractJson, type AcceptedTaskExecutionResult, type EvidenceRef, type RunState } from '@dev-harness-runtime/contracts';
import type { LockHandle } from '../lock/index.js';
import { sameRecord } from '../recovery/evidence.js';
import { captureAttemptLogRefs, readEvidence, readRunAtRevision, StateError, type AttemptIdentity } from '../state/index.js';

export interface ParentContextSummary {
  runId: string;
  taskId: string | null;
  status: RunState['status'];
  summary: string;
  verificationSummary: { passed: number; failed: number; blocked: number };
  commitSha: string | null;
  /** Selection is reported by the Orchestrator after it rereads Planning, never guessed here. */
  nextTask: string | null;
  logRef: { stdout: EvidenceRef; stderr: EvidenceRef; events: EvidenceRef } | null;
}
function identity(state: RunState): AttemptIdentity | undefined {
  if (state.currentTaskId !== undefined && state.currentAttempt !== undefined && state.currentRequestId !== undefined) {
    return { runId: state.runId, taskId: state.currentTaskId, attempt: state.currentAttempt, requestId: state.currentRequestId };
  }
  const taskId = state.completedTasks.at(-1);
  if (taskId === undefined) return undefined;
  const candidates = state.resultRefs.filter((entry) => entry.identity.taskId === taskId).sort((a, b) => b.identity.attempt - a.identity.attempt);
  if (!candidates[0] || candidates[1]?.identity.attempt === candidates[0].identity.attempt) throw new StateError('STATE_CORRUPT', 'Completed Task does not have a unique latest attempt');
  return candidates[0].identity;
}

/** Read-only projection from run.json and its exact references, never from summary.json or raw Worker text. */
export async function readParentContext(handle: LockHandle, runId: string, expectedRevision: number): Promise<ParentContextSummary> {
  const state = await readRunAtRevision(handle, runId, expectedRevision);
  const current = identity(state);
  let accepted: AcceptedTaskExecutionResult | undefined;
  if (current && state.completedTasks.includes(current.taskId)) {
    const item = state.resultRefs.find((entry) => sameRecord(entry.identity, current));
    if (!item) throw new StateError('STATE_CORRUPT', 'Accepted result is missing');
    accepted = parseContractJson('acceptedTaskExecutionResult', new TextDecoder('utf-8', { fatal: true }).decode(await readEvidence(handle, runId, expectedRevision, item.ref)));
    if (!sameRecord({ runId: accepted.runId, taskId: accepted.taskId, attempt: accepted.attempt, requestId: accepted.requestId }, current)
      || accepted.acceptedSnapshotHash !== state.acceptedSnapshotHash || (state.authorization.commit === 'deny' && accepted.commitSha !== undefined)) {
      throw new StateError('STATE_IDENTITY_MISMATCH', 'Accepted result does not bind the authoritative Run boundary');
    }
  }
  const logRef = current ? await captureAttemptLogRefs(handle, runId, expectedRevision, current) : null;
  const verificationSummary = { passed: 0, failed: 0, blocked: 0 };
  for (const evidence of accepted?.verification ?? []) verificationSummary[evidence.result]++;
  const summary = state.stopReason ? `Run 已停止（${state.stopReason.code}）。`
    : state.status === 'COMPLETED' ? (accepted ? `Task ${current!.taskId} 已接受；本次 Run 已结束。` : `当前队列已结束，接受 ${state.completedTasks.length} 个任务。`)
      : current ? `Task ${current.taskId}：${accepted ? '已接受，等待后续选择' : '尚未完成 Core 验收'}。` : `Run ${state.status}，已接受 ${state.completedTasks.length} 个任务。`;
  // Another Core state transition invalidates this projection instead of mixing revisions.
  await readRunAtRevision(handle, runId, expectedRevision);
  return { runId, taskId: current?.taskId ?? null, status: state.status, summary, verificationSummary,
    commitSha: accepted?.commitSha ?? null, nextTask: null, logRef };
}
