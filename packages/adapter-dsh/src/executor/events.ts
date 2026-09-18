import { createHash } from 'node:crypto';
import { validateResultForRequest, type TaskExecutionRequest, type TaskExecutionResult } from '@dev-harness-runtime/contracts';

export class DshEventError extends Error {
  constructor(readonly code: 'INVALID_RESULT' | 'AUTHORIZATION_VIOLATION' | 'CAPABILITY_MISSING', message: string) {
    super(message); this.name = 'DshEventError';
  }
}

type Proposal = { path: string; content: string };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const receipt = (content: string): string => `PROPOSED ${createHash('sha256').update(content, 'utf8').digest('hex')}`;

/** Decode one fresh DSH v3 Session. The trusted controller must retain the raw log separately. */
export class DshSessionEventDecoder {
  private nextSeq = 0;
  private turn: number | undefined;
  private ended = false;
  private failed = false;
  private finalText: string | undefined;
  private pending = new Map<string, Proposal & { seq: number; turn: number; step: number }>();
  private accepted: Proposal[] = [];

  consume(value: unknown): void {
    if (this.failed) throw new DshEventError('INVALID_RESULT', 'DSH Session was already rejected');
    try {
      if (!record(value) || value.seq !== this.nextSeq++ || this.nextSeq > 100_000
        || typeof value.type !== 'string' || !record(value.data)) {
        throw new DshEventError('INVALID_RESULT', 'DSH Session event is malformed or out of sequence');
      }
      const data = value.data;
      if (value.type === 'turn/start') {
        if (this.turn !== undefined || this.ended || !Number.isSafeInteger(data.turn) || (data.turn as number) < 1) {
          throw new DshEventError('INVALID_RESULT', 'DSH Session did not start one fresh turn');
        }
        this.turn = data.turn as number;
      } else if (value.type === 'turn/end') {
        if (this.turn === undefined || this.ended || data.turn !== this.turn || !record(data.reason)) {
          throw new DshEventError('INVALID_RESULT', 'DSH turn ending is inconsistent');
        }
        if (data.reason.kind !== 'completed') throw new DshEventError('CAPABILITY_MISSING', 'DSH turn did not complete');
        if (this.pending.size !== 0 || this.finalText === undefined) {
          throw new DshEventError('INVALID_RESULT', 'DSH turn ended without settled tools and a final message');
        }
        this.ended = true;
      } else if (value.type === 'tool/call') {
        if (this.turn === undefined || this.ended || data.turn !== this.turn || !Number.isSafeInteger(data.step)
          || typeof data.callId !== 'string' || data.callId.length === 0 || this.pending.has(data.callId)) {
          throw new DshEventError('INVALID_RESULT', 'DSH tool call is outside the fresh turn');
        }
        if (data.name !== 'dhr_propose_text') throw new DshEventError('AUTHORIZATION_VIOLATION', 'DSH called an unbridged tool');
        this.finalText = undefined;
        let args: unknown;
        try { args = JSON.parse(String(data.arguments)); }
        catch { throw new DshEventError('INVALID_RESULT', 'DSH proposal arguments are not JSON'); }
        if (!record(args) || Object.keys(args).sort().join(',') !== 'content,path' || typeof args.path !== 'string'
          || typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > 4 * 1024 * 1024) {
          throw new DshEventError('INVALID_RESULT', 'DSH proposal arguments are malformed');
        }
        this.pending.set(data.callId, { path: args.path, content: args.content,
          seq: value.seq as number, turn: this.turn, step: data.step as number });
      } else if (value.type === 'tool/result') {
        if (this.turn === undefined || this.ended || data.turn !== this.turn || !record(data.message)
          || !Array.isArray(data.message.content) || data.message.content.length !== 1) {
          throw new DshEventError('INVALID_RESULT', 'DSH tool result is outside the fresh turn');
        }
        const block: unknown = data.message.content[0];
        if (!record(block) || block.type !== 'tool-result' || typeof block.toolCallId !== 'string') {
          throw new DshEventError('INVALID_RESULT', 'DSH tool result block is malformed');
        }
        const proposal = this.pending.get(block.toolCallId);
        if (proposal === undefined || proposal.turn !== data.turn || proposal.step !== data.step
          || !Array.isArray(value.sourceEventSeqs) || value.sourceEventSeqs.length !== 1
          || value.sourceEventSeqs[0] !== proposal.seq || block.isError === true
          || !Array.isArray(block.content) || block.content.length !== 1 || !record(block.content[0])
          || block.content[0].type !== 'text' || block.content[0].text !== receipt(proposal.content)) {
          throw new DshEventError('INVALID_RESULT', 'DSH proposal receipt does not match its call');
        }
        this.pending.delete(block.toolCallId);
        this.accepted.push({ path: proposal.path, content: proposal.content });
      } else if (value.type === 'assistant/message') {
        if (this.turn === undefined || this.ended || data.turn !== this.turn || !record(data.message)
          || data.message.role !== 'assistant' || !Array.isArray(data.message.content) || data.interrupted === true) {
          throw new DshEventError('INVALID_RESULT', 'DSH assistant message is inconsistent');
        }
        const blocks: unknown[] = data.message.content;
        if (blocks.every((block) => record(block) && (block.type === 'text' || block.type === 'reasoning')
          && typeof block.text === 'string')) {
          const text = blocks.filter((block) => record(block) && block.type === 'text')
            .map((block) => (block as { text: string }).text).join('');
          if (text.length > 0 && Buffer.byteLength(text, 'utf8') <= 1024 * 1024) this.finalText = text;
        }
      }
    } catch (error) { this.failed = true; throw error; }
  }

  finish(request: TaskExecutionRequest, header: unknown): { sessionId: string; result: TaskExecutionResult } {
    if (this.failed || !this.ended || this.finalText === undefined || !record(header) || header.version !== 3
      || typeof header.id !== 'string' || !/^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(header.id)
      || header.cwd !== request.repoRoot || header.isSeeded !== false || header.parentSession !== undefined) {
      throw new DshEventError('INVALID_RESULT', 'DSH did not provide one fresh, complete Session');
    }
    let raw: unknown;
    try { raw = JSON.parse(this.finalText); }
    catch { throw new DshEventError('INVALID_RESULT', 'DSH final message is not JSON'); }
    return { sessionId: header.id, result: validateResultForRequest(request, raw) };
  }

  proposals(): readonly Proposal[] {
    if (this.failed || !this.ended) throw new DshEventError('INVALID_RESULT', 'DSH proposals require a complete turn');
    return this.accepted.map((proposal) => ({ ...proposal }));
  }
}
