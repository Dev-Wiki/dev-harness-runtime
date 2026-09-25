import type { EvidenceRef, TaskExecutionRequest, TaskExecutionResult } from '@dev-harness-runtime/contracts';
import { persistWorkerProposals, type LockHandle } from '@dev-harness-runtime/core';

/** Publish a DSH Session candidate only under the exact pending Core attempt. */
export async function persistDshSessionProposals(handle: LockHandle, expectedRevision: number,
  request: TaskExecutionRequest, output: { result: TaskExecutionResult;
    proposals: readonly { path: string; content: string | null }[] }): Promise<EvidenceRef> {
  return persistWorkerProposals(handle, expectedRevision, request, output.result,
    output.proposals.map((proposal) => ({ path: proposal.path,
      content: proposal.content === null ? null : Buffer.from(proposal.content, 'utf8') })));
}
