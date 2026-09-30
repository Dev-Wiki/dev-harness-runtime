import { createHash } from 'node:crypto';
import { validateResultForRequest, type TaskExecutionRequest, type TaskExecutionResult } from '@dev-harness-runtime/contracts';

export class DshEventError extends Error {
  constructor(readonly code: 'INVALID_RESULT' | 'AUTHORIZATION_VIOLATION' | 'CAPABILITY_MISSING', message: string) {
    super(message); this.name = 'DshEventError';
  }
}

type Proposal = { path: string; content: string | null };
type PendingCall = ({ kind: 'proposal' } & Proposal) | { kind: 'read'; name: string }
  | { kind: 'submit'; raw: unknown; digest: string };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const receipt = (content: string): string => `PROPOSED ${createHash('sha256').update(content, 'utf8').digest('hex')}`;

/** Decode one fresh DSH v4 Session. The trusted controller must retain the raw log separately. */
export class DshSessionEventDecoder {
  private nextSeq = 0;
  private turn: number | undefined;
  private ended = false;
  private failed = false;
  private finalText: string | undefined;
  private pending = new Map<string, PendingCall & { seq: number; turn: number; step: number }>();
  private seenCalls = new Set<string>();
  private accepted: Proposal[] = [];
  private identityReceipt: Record<string, unknown> | undefined;
  private submitted: unknown;

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
          || typeof data.callId !== 'string' || data.callId.length === 0 || this.seenCalls.has(data.callId)) {
          throw new DshEventError('INVALID_RESULT', 'DSH tool call is outside the fresh turn');
        }
        const proposalCall = data.name === 'dhr_propose_text' || data.name === 'dhr_propose_delete';
        const readCall = ['dhr_identity', 'dhr_list_paths', 'dhr_read_text', 'dhr_search_text'].includes(String(data.name));
        const submitCall = data.name === 'dhr_submit_result';
        // A repeated submit is a side-effect-free retry; every other tool stays forbidden after an accepted result.
        if (this.submitted !== undefined && !submitCall) {
          throw new DshEventError('INVALID_RESULT', 'DSH called a tool after submitting its result');
        }
        if (!proposalCall && !readCall && !submitCall) {
          throw new DshEventError('AUTHORIZATION_VIOLATION', 'DSH called an unbridged tool');
        }
        this.seenCalls.add(data.callId);
        this.finalText = undefined;
        let args: unknown;
        try { args = JSON.parse(String(data.arguments)); }
        catch { throw new DshEventError('INVALID_RESULT', 'DSH proposal arguments are not JSON'); }
        if (submitCall) {
          if (!record(args) || Object.keys(args).join(',') !== 'result' || typeof args.result !== 'string'
            || Buffer.byteLength(args.result, 'utf8') > 1024 * 1024) {
            throw new DshEventError('INVALID_RESULT', 'DSH submitted result arguments are malformed');
          }
          let raw: unknown;
          try { raw = JSON.parse(args.result); }
          catch { raw = undefined; }
          if (this.submitted !== undefined
            && (raw === undefined || JSON.stringify(raw) !== JSON.stringify(this.submitted))) {
            throw new DshEventError('INVALID_RESULT', 'DSH resubmitted a result that differs from the accepted one');
          }
          this.pending.set(data.callId, { kind: 'submit', raw,
            digest: raw === undefined ? '' : createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
            seq: value.seq as number, turn: this.turn, step: data.step as number });
          return;
        }
        if (readCall) {
          const keys = data.name === 'dhr_identity' ? '' : data.name === 'dhr_list_paths' ? 'after,prefix'
            : data.name === 'dhr_read_text' ? 'offset,path' : 'after,prefix,query';
          if (!record(args) || Object.keys(args).sort().join(',') !== keys) {
            throw new DshEventError('INVALID_RESULT', 'DSH read arguments are malformed');
          }
          this.pending.set(data.callId, { kind: 'read', name: String(data.name),
            seq: value.seq as number, turn: this.turn, step: data.step as number });
          return;
        }
        if (!record(args) || typeof args.path !== 'string' || (data.name === 'dhr_propose_text'
          ? Object.keys(args).sort().join(',') !== 'content,path' || typeof args.content !== 'string'
            || Buffer.byteLength(args.content, 'utf8') > 4 * 1024 * 1024
          : Object.keys(args).join(',') !== 'path')) {
          throw new DshEventError('INVALID_RESULT', 'DSH proposal arguments are malformed');
        }
        this.pending.set(data.callId, { kind: 'proposal', path: args.path,
          content: data.name === 'dhr_propose_text' ? args.content as string : null,
          seq: value.seq as number, turn: this.turn, step: data.step as number });
      } else if (value.type === 'tool/result') {
        // V4 lifts a tool result into a tool-role message; the retired `tool-result` wrapper is refused.
        const message: unknown = data.message;
        if (this.turn === undefined || this.ended || data.turn !== this.turn || !record(message)
          || message.role !== 'tool' || typeof message.toolCallId !== 'string'
          || !Array.isArray(message.content) || message.content.length !== 1) {
          throw new DshEventError('INVALID_RESULT', 'DSH tool result is outside the fresh turn');
        }
        const toolCallId = message.toolCallId;
        const block: unknown = message.content[0];
        const call = this.pending.get(toolCallId);
        if (call === undefined || call.turn !== data.turn || call.step !== data.step
          || !Array.isArray(value.sourceEventSeqs) || value.sourceEventSeqs.length !== 1
          || value.sourceEventSeqs[0] !== call.seq
          || !record(block) || block.type !== 'text' || typeof block.text !== 'string') {
          throw new DshEventError('INVALID_RESULT', 'DSH proposal receipt does not match its call');
        }
        const response = block.text;
        if (message.isError === true) {
          if (!response.startsWith('Error: ') || Buffer.byteLength(response, 'utf8') > 4096) {
            throw new DshEventError('INVALID_RESULT', 'DSH failed tool receipt is malformed');
          }
          this.pending.delete(toolCallId);
          return;
        }
        if (call.kind === 'submit') {
          if (response.startsWith('INVALID_RESULT: ')) {
            this.pending.delete(toolCallId);
            return;
          }
          if (call.raw === undefined || response !== `SUBMITTED ${call.digest}`) {
            throw new DshEventError('INVALID_RESULT', 'DSH submitted result receipt does not match its call');
          }
          this.submitted = call.raw;
        } else if (call.kind === 'proposal') {
          if (response !== (call.content === null
            ? `PROPOSED_DELETE ${createHash('sha256').update(call.path, 'utf8').digest('hex')}`
            : receipt(call.content))) {
            throw new DshEventError('INVALID_RESULT', 'DSH proposal receipt does not match its call');
          }
          this.accepted.push({ path: call.path, content: call.content });
        } else {
          if (Buffer.byteLength(response, 'utf8') > 1024 * 1024) {
            throw new DshEventError('INVALID_RESULT', 'DSH read receipt exceeds its boundary');
          }
          let parsed: unknown;
          try { parsed = JSON.parse(response); }
          catch { throw new DshEventError('INVALID_RESULT', 'DSH read receipt is not JSON'); }
          if (!record(parsed)) throw new DshEventError('INVALID_RESULT', 'DSH read receipt is malformed');
          if (call.name === 'dhr_identity') this.identityReceipt = parsed;
        }
        this.pending.delete(toolCallId);
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
    if (this.failed || !this.ended || this.finalText === undefined || !record(header) || header.version !== 4
      || typeof header.id !== 'string' || !/^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(header.id)
      || header.cwd !== request.repoRoot || header.isSeeded !== false || header.parentSession !== undefined) {
      throw new DshEventError('INVALID_RESULT', 'DSH did not provide one fresh, complete v4 Session');
    }
    if (this.identityReceipt && (this.identityReceipt.runId !== request.runId
      || this.identityReceipt.taskId !== request.taskId || this.identityReceipt.attempt !== request.attempt
      || this.identityReceipt.requestId !== request.requestId
      || this.identityReceipt.snapshotHash !== request.snapshotHash)) {
      throw new DshEventError('INVALID_RESULT', 'DSH read identity differs from the Core request');
    }
    let raw: unknown;
    if (this.submitted !== undefined) raw = this.submitted;
    else {
      const trimmed = this.finalText.trim();
      const fenced = /^```json\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
      try { raw = JSON.parse(fenced ? fenced[1]! : trimmed); }
      catch { throw new DshEventError('INVALID_RESULT', 'DSH final message is not JSON'); }
    }
    return { sessionId: header.id, result: validateResultForRequest(request, raw) };
  }

  proposals(): readonly Proposal[] {
    if (this.failed || !this.ended) throw new DshEventError('INVALID_RESULT', 'DSH proposals require a complete turn');
    return this.accepted.map((proposal) => ({ ...proposal }));
  }
}
