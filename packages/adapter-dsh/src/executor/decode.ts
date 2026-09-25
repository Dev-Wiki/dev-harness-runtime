import type { TaskExecutionRequest, TaskExecutionResult } from '@dev-harness-runtime/contracts';
import { DshSessionEventDecoder } from './events.js';
import { readFreshDshSession } from './session-reader.js';

/** Read and decode a completed DSH Session, keeping the logical host log with Core. */
export async function decodeFreshDshExecution(input: {
  dshEntry: string;
  sessionsRoot: string;
  request: TaskExecutionRequest;
  log(bytes: Uint8Array): Promise<void>;
}): Promise<{ sessionId: string; result: TaskExecutionResult; proposals: readonly { path: string; content: string | null }[] }> {
  const session = await readFreshDshSession({ dshEntry: input.dshEntry, sessionsRoot: input.sessionsRoot,
    repoRoot: input.request.repoRoot });
  const decoder = new DshSessionEventDecoder();
  for (const value of [{ type: 'session', ...session.header }, ...session.events]) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      await input.log(bytes.subarray(offset, offset + 1024 * 1024));
    }
  }
  for (const event of session.events) decoder.consume(event);
  const bound = decoder.finish(input.request, session.header);
  return { ...bound, proposals: decoder.proposals() };
}
