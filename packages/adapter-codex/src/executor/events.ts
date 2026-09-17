import { validateResultForRequest, type TaskExecutionRequest, type TaskExecutionResult } from '@dev-harness-runtime/contracts';

export class CodexEventError extends Error {
  constructor(readonly code: 'INVALID_RESULT' | 'CAPABILITY_MISSING', message: string) {
    super(message); this.name = 'CodexEventError';
  }
}

/** Decode one fresh Codex exec turn. Raw JSONL must be persisted separately by the controller. */
export class CodexEventDecoder {
  private threadId: string | undefined;
  private finalText: string | undefined;
  private completed = false;
  private failed = false;
  private eventCount = 0;

  consume(line: string): void {
    if (this.failed) throw new CodexEventError('INVALID_RESULT', 'Codex event stream was already rejected');
    try {
      if (this.completed || ++this.eventCount > 100_000 || line.length > 1024 * 1024) {
        throw new CodexEventError('INVALID_RESULT', 'Codex event stream exceeded its boundary');
      }
      let event: unknown;
      try { event = JSON.parse(line); } catch { throw new CodexEventError('INVALID_RESULT', 'Codex emitted invalid JSONL'); }
      if (event === null || typeof event !== 'object' || Array.isArray(event) || !('type' in event) || typeof event.type !== 'string') {
        throw new CodexEventError('INVALID_RESULT', 'Codex emitted an invalid event');
      }
      if (this.threadId === undefined && event.type !== 'thread.started') {
        throw new CodexEventError('INVALID_RESULT', 'Codex event preceded the fresh thread identity');
      }
      if (event.type === 'thread.started') {
        if (this.threadId !== undefined || !('thread_id' in event) || typeof event.thread_id !== 'string'
          || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(event.thread_id)) {
          throw new CodexEventError('INVALID_RESULT', 'Codex did not provide one fresh thread identity');
        }
        this.threadId = event.thread_id;
      } else if (event.type === 'item.completed') {
        if (!('item' in event) || event.item === null || typeof event.item !== 'object'
          || !('type' in event.item) || event.item.type !== 'agent_message') return;
        if (!('text' in event.item) || typeof event.item.text !== 'string') {
          throw new CodexEventError('INVALID_RESULT', 'Codex final message is not text');
        }
        this.finalText = event.item.text;
      } else if (event.type === 'turn.completed') {
        if (this.finalText === undefined) {
          throw new CodexEventError('INVALID_RESULT', 'Codex turn completed without a structured final message');
        }
        this.completed = true;
      } else if (event.type === 'turn.failed' || event.type === 'error') {
        throw new CodexEventError('CAPABILITY_MISSING', 'Codex turn failed');
      }
    } catch (error) { this.failed = true; throw error; }
  }

  finish(request: TaskExecutionRequest): { threadId: string; result: TaskExecutionResult } {
    if (this.failed || !this.completed || this.threadId === undefined || this.finalText === undefined) {
      throw new CodexEventError('INVALID_RESULT', 'Codex stream ended before a complete turn');
    }
    let raw: unknown;
    try { raw = JSON.parse(this.finalText); } catch { throw new CodexEventError('INVALID_RESULT', 'Codex final message is not JSON'); }
    return { threadId: this.threadId, result: validateResultForRequest(request, raw) };
  }
}
