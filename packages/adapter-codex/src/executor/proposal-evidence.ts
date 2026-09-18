import type { TaskExecutionRequest, EvidenceRef } from '@dev-harness-runtime/contracts';
import { persistWorkerProposals, type LockHandle } from '@dev-harness-runtime/core';
import type { CodexProcessOutput } from './process.js';

/** Publish only a candidate: Core checks the current Run, scope, bytes and declared changes. */
export async function persistCodexSessionProposals(handle: LockHandle, expectedRevision: number,
  request: TaskExecutionRequest, output: CodexProcessOutput): Promise<EvidenceRef> {
  return persistWorkerProposals(handle, expectedRevision, request, output.result,
    output.proposals.map((proposal) => ({ path: proposal.path,
      content: proposal.content === null ? null : Buffer.from(proposal.content, 'utf8') })));
}
