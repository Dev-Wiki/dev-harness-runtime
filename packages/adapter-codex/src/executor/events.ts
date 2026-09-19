import { createHash } from 'node:crypto';
import { isRepoPath, validateResultForRequest, type TaskExecutionRequest, type TaskExecutionResult } from '@dev-harness-runtime/contracts';
import { decodeCodexResultEnvelope } from './result-schema.js';

export class CodexEventError extends Error {
  constructor(readonly code: 'INVALID_RESULT' | 'CAPABILITY_MISSING' | 'AUTHORIZATION_VIOLATION', message: string) {
    super(message); this.name = 'CodexEventError';
  }
}

type ReadCall = { id: string; tool: 'dhr_list_paths'; prefix: string; after: string }
  | { id: string; tool: 'dhr_read_text'; path: string; offset: number }
  | { id: string; tool: 'dhr_search_text'; query: string; prefix: string; after: string }
  | { id: string; tool: 'dhr_identity' };

/** Decode one fresh Codex exec turn. Raw JSONL must be persisted separately by the controller. */
export class CodexEventDecoder {
  private static safeReadPath(value: string): boolean {
    return value.length <= 4096 && isRepoPath(value) && !value.split('/').some((part) => part.toLowerCase() === '.git');
  }
  private threadId: string | undefined;
  private finalText: string | undefined;
  private turnStarted = false;
  private completed = false;
  private failed = false;
  private eventCount = 0;
  private pendingProposals = new Map<string, { path: string; content: string | null }>();
  private pendingReads = new Map<string, ReadCall>();
  private identityReceipt: Record<string, unknown> | undefined;
  private acceptedProposals: { path: string; content: string | null }[] = [];

  private proposalItem(item: object): { id: string; path: string; content: string | null } {
    if (!('id' in item) || typeof item.id !== 'string' || !('server' in item) || item.server !== 'dhr_proposal'
      || !('tool' in item) || (item.tool !== 'dhr_propose_text' && item.tool !== 'dhr_propose_delete') || !('arguments' in item)
      || item.arguments === null || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) {
      throw new CodexEventError('AUTHORIZATION_VIOLATION', 'Codex called an unregistered MCP tool');
    }
    const args = item.arguments;
    if (!('path' in args) || typeof args.path !== 'string' || args.path.length > 4096
      || (item.tool === 'dhr_propose_text' && (!('content' in args) || typeof args.content !== 'string'
        || Object.keys(args).length !== 2 || Buffer.byteLength(args.content, 'utf8') > 4 * 1024 * 1024))
      || (item.tool === 'dhr_propose_delete' && Object.keys(args).join(',') !== 'path')) {
      throw new CodexEventError('INVALID_RESULT', 'Codex proposal arguments are malformed');
    }
    return { id: item.id, path: args.path,
      content: item.tool === 'dhr_propose_text' ? (args as Record<string, unknown>).content as string : null };
  }

  private readItem(item: object): ReadCall {
    if (!('id' in item) || typeof item.id !== 'string' || !('server' in item) || item.server !== 'dhr_proposal'
      || !('tool' in item) || (item.tool !== 'dhr_identity' && item.tool !== 'dhr_list_paths'
        && item.tool !== 'dhr_read_text' && item.tool !== 'dhr_search_text')
      || !('arguments' in item) || item.arguments === null || typeof item.arguments !== 'object'
      || Array.isArray(item.arguments)) throw new CodexEventError('AUTHORIZATION_VIOLATION', 'Codex called an unregistered MCP tool');
    const args = item.arguments as Record<string, unknown>;
    if (item.tool === 'dhr_identity') {
      if (Object.keys(args).length !== 0) throw new CodexEventError('INVALID_RESULT', 'Codex identity arguments are malformed');
      return { id: item.id, tool: 'dhr_identity' };
    }
    if (item.tool === 'dhr_list_paths') {
      if (Object.keys(args).sort().join(',') !== 'after,prefix' || typeof args.prefix !== 'string' || typeof args.after !== 'string'
        || (args.prefix !== '' && !CodexEventDecoder.safeReadPath(args.prefix))
        || (args.after !== '' && !CodexEventDecoder.safeReadPath(args.after))) {
        throw new CodexEventError('INVALID_RESULT', 'Codex list arguments are malformed');
      }
      return { id: item.id, tool: 'dhr_list_paths', prefix: args.prefix, after: args.after };
    }
    if (item.tool === 'dhr_search_text') {
      if (Object.keys(args).sort().join(',') !== 'after,prefix,query' || typeof args.query !== 'string'
        || args.query.length < 1 || args.query.length > 128
        || [...args.query].some((character) => { const code = character.codePointAt(0)!; return code < 32 || code === 127; })
        || typeof args.prefix !== 'string' || typeof args.after !== 'string'
        || (args.prefix !== '' && !CodexEventDecoder.safeReadPath(args.prefix))
        || (args.after !== '' && !CodexEventDecoder.safeReadPath(args.after))) {
        throw new CodexEventError('INVALID_RESULT', 'Codex search arguments are malformed');
      }
      return { id: item.id, tool: 'dhr_search_text', query: args.query, prefix: args.prefix, after: args.after };
    }
    if (Object.keys(args).sort().join(',') !== 'offset,path' || typeof args.path !== 'string'
      || !CodexEventDecoder.safeReadPath(args.path) || !Number.isSafeInteger(args.offset) || (args.offset as number) < 0) {
      throw new CodexEventError('INVALID_RESULT', 'Codex read arguments are malformed');
    }
    return { id: item.id, tool: 'dhr_read_text', path: args.path, offset: args.offset as number };
  }

  private completeRead(item: object): void {
    const read = this.readItem(item);
    const pending = this.pendingReads.get(read.id);
    if (!pending || JSON.stringify(pending) !== JSON.stringify(read) || !('status' in item) || item.status !== 'completed'
      || !('error' in item) || item.error !== null || !('result' in item) || item.result === null
      || typeof item.result !== 'object' || !('content' in item.result) || !Array.isArray(item.result.content)
      || item.result.content.length !== 1 || ('isError' in item.result && item.result.isError === true)) {
      throw new CodexEventError('INVALID_RESULT', 'Codex read call did not complete consistently');
    }
    const output: unknown = item.result.content[0];
    if (output === null || typeof output !== 'object' || !('type' in output) || output.type !== 'text'
      || !('text' in output) || typeof output.text !== 'string') {
      throw new CodexEventError('INVALID_RESULT', 'Codex read receipt is not text');
    }
    let data: unknown;
    try { data = JSON.parse(output.text); } catch { throw new CodexEventError('INVALID_RESULT', 'Codex read receipt is not JSON'); }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new CodexEventError('INVALID_RESULT', 'Codex read receipt is malformed');
    }
    if (read.tool === 'dhr_identity') {
      const identity = data as Record<string, unknown>;
      const env = identity.env;
      if (Object.keys(identity).sort().join(',') !== 'attempt,env,requestId,runId,schemaVersion,snapshotHash,taskId'
        || identity.schemaVersion !== 1 || typeof identity.runId !== 'string' || typeof identity.taskId !== 'string'
        || !Number.isSafeInteger(identity.attempt) || typeof identity.attempt !== 'number' || identity.attempt < 1
        || typeof identity.requestId !== 'string'
        || typeof identity.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/u.test(identity.snapshotHash)
        || env === null || typeof env !== 'object' || Array.isArray(env)
        || Object.keys(env).sort().join(',') !== 'DEV_HARNESS_ADAPTER,DEV_HARNESS_RUN_ID,DEV_HARNESS_TASK_ID,DEV_HARNESS_WORKER'
        || !('DEV_HARNESS_WORKER' in env) || env.DEV_HARNESS_WORKER !== '1'
        || !('DEV_HARNESS_RUN_ID' in env) || env.DEV_HARNESS_RUN_ID !== identity.runId
        || !('DEV_HARNESS_TASK_ID' in env) || env.DEV_HARNESS_TASK_ID !== identity.taskId
        || !('DEV_HARNESS_ADAPTER' in env) || typeof env.DEV_HARNESS_ADAPTER !== 'string') {
        throw new CodexEventError('INVALID_RESULT', 'Codex identity receipt is malformed');
      }
      if (this.identityReceipt !== undefined) throw new CodexEventError('INVALID_RESULT', 'Codex repeated the identity receipt');
      this.identityReceipt = structuredClone(identity);
    } else if (read.tool === 'dhr_read_text') {
      if ('missing' in data) {
        if (read.offset !== 0 || Object.keys(data).sort().join(',') !== 'missing,path'
          || !('path' in data) || data.path !== read.path || data.missing !== true) {
          throw new CodexEventError('INVALID_RESULT', 'Codex missing-file receipt is malformed');
        }
        this.pendingReads.delete(read.id);
        return;
      }
      if (!('path' in data) || data.path !== read.path || !('offset' in data) || data.offset !== read.offset
        || !('content' in data) || typeof data.content !== 'string' || data.content.length > 16 * 1024
        || !('sha256' in data) || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(data.sha256)
        || !('nextOffset' in data) || (data.nextOffset !== null
          && (!Number.isSafeInteger(data.nextOffset) || typeof data.nextOffset !== 'number'
            || data.nextOffset <= read.offset || data.nextOffset - read.offset !== data.content.length))) {
        throw new CodexEventError('INVALID_RESULT', 'Codex read receipt differs from the requested page');
      }
    } else if (read.tool === 'dhr_list_paths') {
      const paths = 'paths' in data ? data.paths : undefined;
      if (!Array.isArray(paths) || paths.length > 100
      || paths.some((path) => typeof path !== 'string' || !CodexEventDecoder.safeReadPath(path)
        || (read.prefix !== '' && path !== read.prefix && !path.startsWith(`${read.prefix}/`))
        || (read.after !== '' && Buffer.compare(Buffer.from(path), Buffer.from(read.after)) <= 0))
      || paths.some((path, index) => index > 0
        && Buffer.compare(Buffer.from(paths[index - 1]), Buffer.from(path)) >= 0)
      || !('next' in data)
      || (data.next !== null && (typeof data.next !== 'string' || data.next !== paths.at(-1)))) {
        throw new CodexEventError('INVALID_RESULT', 'Codex list receipt is malformed');
      }
    } else {
      const matches = 'matches' in data ? data.matches : undefined;
      const skipped = 'skipped' in data ? data.skipped : undefined;
      const next = 'next' in data ? data.next : undefined;
      const validPath = (path: unknown): path is string => typeof path === 'string'
        && CodexEventDecoder.safeReadPath(path)
        && (read.prefix === '' || path === read.prefix || path.startsWith(`${read.prefix}/`))
        && (read.after === '' || Buffer.compare(Buffer.from(path), Buffer.from(read.after)) > 0);
      if (Object.keys(data).sort().join(',') !== 'matches,next,skipped'
        || !Array.isArray(matches) || matches.length > 80
        || !Array.isArray(skipped) || skipped.length > 16
        || skipped.some((path) => !validPath(path))
        || skipped.some((path, index) => index > 0
          && Buffer.compare(Buffer.from(skipped[index - 1]), Buffer.from(path)) >= 0)
        || (next !== null && !validPath(next))
        || matches.some((match) => match === null || typeof match !== 'object' || Array.isArray(match)
          || Object.keys(match).sort().join(',') !== 'column,excerpt,line,path'
          || !('path' in match) || !validPath(match.path)
          || !('line' in match) || !Number.isSafeInteger(match.line) || match.line < 1
          || !('column' in match) || !Number.isSafeInteger(match.column) || match.column < 1
          || !('excerpt' in match) || typeof match.excerpt !== 'string'
          || match.excerpt.length > 200 || !match.excerpt.includes(read.query))
        || matches.some((match, index) => index > 0 && (
          Buffer.compare(Buffer.from(matches[index - 1].path), Buffer.from(match.path)) > 0
          || (matches[index - 1].path === match.path && matches[index - 1].line >= match.line)))) {
        throw new CodexEventError('INVALID_RESULT', 'Codex search receipt is malformed');
      }
      const counts = new Map<string, number>();
      for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
      if (counts.size > 16 || [...counts.values()].some((count) => count > 5)
        || skipped.some((path) => counts.has(path))
        || (next !== null && [...counts.keys(), ...skipped].some((path) => Buffer.compare(Buffer.from(path), Buffer.from(next)) > 0))) {
        throw new CodexEventError('INVALID_RESULT', 'Codex search receipt exceeds its page');
      }
    }
    this.pendingReads.delete(read.id);
  }

  consume(line: string): void {
    if (this.failed) throw new CodexEventError('INVALID_RESULT', 'Codex event stream was already rejected');
    try {
      if (this.completed || ++this.eventCount > 100_000 || line.length > 8 * 1024 * 1024) {
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
        if (!('type' in event.item) || typeof event.item.type !== 'string') {
          throw new CodexEventError('INVALID_RESULT', 'Codex started an item without a type');
        }
        if (event.item.type === 'mcp_tool_call') {
          if ('tool' in event.item && (event.item.tool === 'dhr_identity' || event.item.tool === 'dhr_list_paths'
            || event.item.tool === 'dhr_read_text' || event.item.tool === 'dhr_search_text')) {
            const read = this.readItem(event.item);
            if (this.pendingReads.has(read.id) || this.pendingProposals.has(read.id)) throw new CodexEventError('INVALID_RESULT', 'Duplicate Codex MCP call');
            this.pendingReads.set(read.id, read);
          } else {
            const proposal = this.proposalItem(event.item);
            if (this.pendingProposals.has(proposal.id) || this.pendingReads.has(proposal.id)) throw new CodexEventError('INVALID_RESULT', 'Duplicate Codex MCP call');
            this.pendingProposals.set(proposal.id, { path: proposal.path, content: proposal.content });
          }
        } else if (event.item.type !== 'agent_message' && event.item.type !== 'reasoning') {
          throw new CodexEventError('AUTHORIZATION_VIOLATION', 'Codex started a tool outside the proposal bridge');
        }
      } else if (event.type === 'item.completed') {
        if (!this.turnStarted) throw new CodexEventError('INVALID_RESULT', 'Codex item preceded the turn');
        if (!('item' in event) || event.item === null || typeof event.item !== 'object' || !('type' in event.item)) {
          throw new CodexEventError('INVALID_RESULT', 'Codex completed a malformed item');
        }
        if (event.item.type === 'mcp_tool_call') {
          if ('tool' in event.item && (event.item.tool === 'dhr_identity' || event.item.tool === 'dhr_list_paths'
            || event.item.tool === 'dhr_read_text' || event.item.tool === 'dhr_search_text')) {
            this.completeRead(event.item);
            return;
          }
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
          const expected = proposal.content === null
            ? `PROPOSED_DELETE ${createHash('sha256').update(proposal.path, 'utf8').digest('hex')}`
            : `PROPOSED ${createHash('sha256').update(proposal.content, 'utf8').digest('hex')}`;
          if (output === null || typeof output !== 'object' || !('type' in output) || output.type !== 'text'
            || !('text' in output) || output.text !== expected) {
            throw new CodexEventError('INVALID_RESULT', 'Codex proposal receipt hash differs from its arguments');
          }
          this.pendingProposals.delete(proposal.id);
          this.acceptedProposals.push({ path: proposal.path, content: proposal.content });
          return;
        }
        if (event.item.type === 'reasoning') return;
        if (event.item.type !== 'agent_message') {
          throw new CodexEventError('AUTHORIZATION_VIOLATION', 'Codex completed a tool outside the proposal bridge');
        }
        if (!('text' in event.item) || typeof event.item.text !== 'string') {
          throw new CodexEventError('INVALID_RESULT', 'Codex final message is not text');
        }
        this.finalText = event.item.text;
      } else if (event.type === 'turn.completed') {
        if (!this.turnStarted || this.finalText === undefined || this.pendingProposals.size !== 0 || this.pendingReads.size !== 0) {
          throw new CodexEventError('INVALID_RESULT', 'Codex turn completed without a structured final message');
        }
        this.completed = true;
      } else if (event.type === 'turn.failed' || event.type === 'error') {
        throw new CodexEventError('CAPABILITY_MISSING', 'Codex turn failed');
      } else {
        throw new CodexEventError('INVALID_RESULT', 'Codex emitted an unsupported event type');
      }
    } catch (error) { this.failed = true; throw error; }
  }

  finish(request: TaskExecutionRequest, format: 'contract' | 'codex' = 'contract'): { threadId: string; result: TaskExecutionResult } {
    if (this.failed || !this.completed || this.threadId === undefined || this.finalText === undefined) {
      throw new CodexEventError('INVALID_RESULT', 'Codex stream ended before a complete turn');
    }
    if (this.identityReceipt !== undefined) {
      const expected = { schemaVersion: 1, runId: request.runId, taskId: request.taskId, attempt: request.attempt,
        requestId: request.requestId, snapshotHash: request.snapshotHash, env: request.env };
      if (JSON.stringify(this.identityReceipt) !== JSON.stringify(expected)) {
        throw new CodexEventError('AUTHORIZATION_VIOLATION', 'Codex identity receipt differs from the Core request');
      }
    }
    let raw: unknown;
    try { raw = JSON.parse(this.finalText); } catch { throw new CodexEventError('INVALID_RESULT', 'Codex final message is not JSON'); }
    if (format === 'codex') {
      try { return { threadId: this.threadId, result: decodeCodexResultEnvelope(raw, request) }; }
      catch (error) {
        if (error instanceof Error && 'code' in error) throw error;
        throw new CodexEventError('INVALID_RESULT', 'Codex final message does not match the structured result envelope');
      }
    }
    return { threadId: this.threadId, result: validateResultForRequest(request, raw) };
  }

  proposals(): readonly { path: string; content: string | null }[] {
    if (this.failed || !this.completed) throw new CodexEventError('INVALID_RESULT', 'Codex proposals require a complete turn');
    return this.acceptedProposals.map((proposal) => ({ ...proposal }));
  }
}
