import type { RunState } from '@dev-harness-runtime/contracts';
import type { RecoveryDecision, RecoveryFacts } from './types.js';

const stop = (code: string, message: string): RecoveryDecision => ({ action: 'stopped', code, message });

/** Pure classification only. It neither validates evidence nor authorizes a persistent transition. */
export function decideRecovery(state: RunState, facts: RecoveryFacts): RecoveryDecision {
  if (state.status === 'FAILED' || state.status === 'COMPLETED') return stop('RUN_TERMINAL', 'Terminal Runs cannot resume');
  const pending = state.pendingOperation;
  if (!pending) return facts.currentMatchesAccepted ? { action: 'rebuild-summary' } : stop('DRIFT_DETECTED', 'Current project differs from the accepted boundary');
  const checkpoint = facts.checkpoint;
  if (pending.kind === 'execute') {
    if (checkpoint) {
      if (!facts.checkpointVerified) return stop('RECOVERY_EVIDENCE_REQUIRED', 'Checkpoint has no trusted ownership verification');
      if (checkpoint.stage === 'worker-ended') return facts.resultCompleted ? { action: 'adopt-result' } : stop('RESULT_NOT_COMPLETED', 'Candidate Worker result is not completed');
      if (checkpoint.stage === 'worker-checkpoint') return { action: 'execute-new-session', continuation: 'checkpoint', freshSession: true };
      if (checkpoint.stage === 'execute-intent') return facts.currentMatchesBefore ? { action: 'execute-new-session', continuation: 'checkpoint', freshSession: true } : stop('DRIFT_DETECTED', 'Prepared execution intent boundary changed');
      return stop('INVALID_RECOVERY_CHECKPOINT', 'Execute intent has an incompatible checkpoint stage');
    }
    return facts.currentMatchesBefore ? { action: 'execute-new-session', continuation: 'restart', freshSession: true } : stop('PENDING_RECONCILIATION', 'Changed execution boundary has no trusted checkpoint');
  }
  if (pending.kind === 'verify') {
    if (!checkpoint) return facts.currentMatchesBefore ? { action: 'revalidate' } : stop('DRIFT_DETECTED', 'Verification input changed before recovery');
    if (!facts.checkpointVerified) return stop('RECOVERY_EVIDENCE_REQUIRED', 'Verification checkpoint is not trusted');
    if (checkpoint.stage !== 'verification-passed') return stop('INVALID_RECOVERY_CHECKPOINT', 'Verification intent has an incompatible checkpoint stage');
    if (!facts.acceptanceVerified || !facts.resultCompleted) return stop('ACCEPTANCE_REQUIRED', 'Independent acceptance must be verified before finalization');
    return state.authorization.commit === 'deny' ? { action: 'finalize-no-commit' } : { action: 'revalidate' };
  }
  if (facts.commitVerified) return { action: 'adopt-commit' };
  if (!facts.commitAbsent) return stop('DRIFT_DETECTED', 'Current HEAD is neither the recorded parent nor the verified intended commit');
  if (checkpoint && (!facts.checkpointVerified || !['commit-ready', 'index-staged'].includes(checkpoint.stage))) return stop('RECOVERY_EVIDENCE_REQUIRED', 'Commit preparation checkpoint is missing or untrusted');
  return facts.currentMatchesBefore || facts.checkpointVerified ? { action: 'resume-commit' } : stop('DRIFT_DETECTED', 'Index does not match the recorded commit checkpoint');
}
