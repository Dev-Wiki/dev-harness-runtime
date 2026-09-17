import { createHash } from 'node:crypto';
import { validateResultForRequest, type TaskExecutionRequest, type TaskExecutionResult } from '@dev-harness-runtime/contracts';

export class CodexEventError extends Error {
  constructor(readonly code: 'INVALID_RESULT' | 'CAPABILITY_MISSING' | 'AUTHORIZATION_VIOLATION', message: string) {
    super(message); this.name = 'CodexEventError';
  }
}

/** Decode one fresh Codex exec turn. Raw JSONL must be persisted separately by the controller. */
export class CodexEventDecoder {
  private threadId: string | undefined;
  private finalText: string | undefined;
  private turnStarted = false;
  private completed = false;
  private failed = false;
  private eventCount = 0;
  private pendingProposals = new Map<string, { path: string; content: string }>();
  private acceptedProposals: { path: string; content: string }[] = [];

  private proposalItem(item: object): { id: string; path: string; content: string } {
    if (!('id' in item) || typeof item.id !== 'string' || !('server' in item) || item.server !== 'dhr_proposal'
      || !('tool' in item) || item.tool !== 'dhr_propose_text' || !('arguments' in item)
      || item.arguments === null || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) {
      throw new CodexEventError('AUTHORIZATION_VIOLATION', 'Codex called an unregistered MCP tool');
    }
    const args = item.arguments;
    if (!('path' in args) || typeof args.path !== 'string' || !('content' in args) || typeof args.content !== 'string'
      || Object.keys(args).length !== 2 || Buffer.byteLength(args.content, 'utf8') > 4 * 1024 * 1024) {
      throw new CodexEventError('INVALID_RESULT', 'Codex proposal arguments are malformed');
    }
    return { id: item.id, path: args.path, content: args.content };
  }

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
      } else if (event.type === 'turn.started') {
        if (this.turnStarted) throw new CodexEventError('INVALID_RESULT', 'Codex started more than one turn');
        this.turnStarted = true;
      } else if (event.type === 'item.started') {
        if (!this.turnStarted || !('item' in event) || event.item === null || typeof event.item !== 'object') {
          throw new CodexEventError('INVALID_RESULT', 'Codex started an item outside the turn');
        }
        if ('type' in event.item && event.item.type === 'mcp_tool_call') {
          const proposal = this.proposalItem(event.item);
          if (this.pendingProposals.has(proposal.id)) throw new CodexEventError('INVALID_RESULT', 'Duplicate Codex proposal call');
          this.pendingProposals.set(proposal.id, { path: proposal.path, content: proposal.content });
        }
      } else if (event.type === 'item.completed') {
        if (!this.turnStarted) throw new CodexEventError('INVALID_RESULT', 'Codex item preceded the turn');
        if (!('item' in event) || event.item === null || typeof event.item !== 'object' || !('type' in event.item)) {
          throw new CodexEventError('INVALID_RESULT', 'Codex completed a malformed item');
        }
        if (event.item.type === 'mcp_tool_call') {
          const proposal = this.proposalItem(event.item);
          const pending = this.pendingProposals.get(proposal.id);
          if (pending?.path !== proposal.path || pending.content !== proposal.content || !('status' in event.item)
            || event.item.status !== 'completed' || !('error' in event.item) || event.item.error !== null
            || !('result' in event.item) || event.item.result === null || typeof event.item.result !== 'object'
            || !('content' in event.item.result) || !Array.isArray(event.item.result.content)
            || event.item.result.content.length !== 1) {
            throw new CodexEventError('INVALID_RESULT', 'Codex proposal call did not complete consistently');
          }
          const output: unknown = event.item.result.content[0];
          const expected = `PROPOSED ${createHash('sha256').update(proposal.content, 'utf8').digest('hex')}`;
          if (output === null || typeof output !== 'object' || !('type' in output) || output.type !== 'text'
            || !('text' in output) || output.text !== expected) {
            throw new CodexEventError('INVALID_RESULT', 'Codex proposal receipt hash differs from its arguments');
          }
          this.pendingProposals.delete(proposal.id);
          this.acceptedProposals.push({ path: proposal.path, content: proposal.content });
          return;
        }
        if (event.item.type !== 'agent_message') return;
        if (!('text' in event.item) || typeof event.item.text !== 'string') {
          throw new CodexEventError('INVALID_RESULT', 'Codex final message is not text');
        }
        this.finalText = event.item.text;
      } else if (event.type === 'turn.completed') {
        if (!this.turnStarted || this.finalText === undefined || this.pendingProposals.size !== 0) {
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

  proposals(): readonly { path: string; content: string }[] {
    if (this.failed || !this.completed) throw new CodexEventError('INVALID_RESULT', 'Codex proposals require a complete turn');
    return this.acceptedProposals.map((proposal) => ({ ...proposal }));
  }
}
