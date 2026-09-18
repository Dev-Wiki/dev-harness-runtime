import type { TaskExecutionRequest, TaskExecutionResult } from '@dev-harness-runtime/contracts';
import { CodexEventDecoder, CodexEventError } from './events.js';

/** Decode one Codex JSONL stdout stream while retaining its original bytes with Core. */
export async function decodeCodexExecution(input: {
  events: AsyncIterable<Uint8Array>;
  request: TaskExecutionRequest;
  format?: 'contract' | 'codex';
  log(bytes: Uint8Array): Promise<void>;
}): Promise<{ threadId: string; result: TaskExecutionResult; proposals: readonly { path: string; content: string }[] }> {
  const decoder = new CodexEventDecoder();
  const text = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let totalBytes = 0;
  const consumeLines = (): void => {
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/u, '');
      decoder.consume(line);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
    if (pending.length > 1024 * 1024) throw new CodexEventError('INVALID_RESULT', 'Codex JSONL line is too large');
  };
  for await (const chunk of input.events) {
    if (!(chunk instanceof Uint8Array)) throw new CodexEventError('INVALID_RESULT', 'Codex stdout is not bytes');
    totalBytes += chunk.byteLength;
    if (totalBytes > 32 * 1024 * 1024) throw new CodexEventError('INVALID_RESULT', 'Codex stdout exceeded its boundary');
    for (let offset = 0; offset < chunk.byteLength; offset += 1024 * 1024) {
      await input.log(chunk.subarray(offset, offset + 1024 * 1024));
    }
    try { pending += text.decode(chunk, { stream: true }); }
    catch { throw new CodexEventError('INVALID_RESULT', 'Codex stdout is not UTF-8'); }
    consumeLines();
  }
  try { pending += text.decode(); }
  catch { throw new CodexEventError('INVALID_RESULT', 'Codex stdout ends inside UTF-8'); }
  consumeLines();
  if (pending.length > 0) decoder.consume(pending);
  const bound = decoder.finish(input.request, input.format);
  return { ...bound, proposals: decoder.proposals() };
}
