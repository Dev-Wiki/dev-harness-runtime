import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isRepoPath } from '@dev-harness-runtime/contracts';
import { createCodexBridgeView, type CodexBridgeView } from './bridge-policy.js';

type RpcId = string | number;
interface RpcRequest { jsonrpc: '2.0'; id?: RpcId; method: string; params?: unknown }
type RpcResponse = { jsonrpc: '2.0'; id: RpcId; result?: unknown; error?: { code: number; message: string } };
const textTool = {
  name: 'dhr_propose_text',
  description: 'Propose UTF-8 content for one Task-scoped repository file. This records a proposal only; the trusted Runtime decides whether to apply it.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false },
};
const deleteTool = {
  name: 'dhr_propose_delete',
  description: 'Propose deletion of one Task-scoped repository file. This records a proposal only; the trusted Runtime decides whether to apply it.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } },
    required: ['path'], additionalProperties: false },
};
const listTool = {
  name: 'dhr_list_paths',
  description: 'List only files in the frozen Core snapshot, at most 100 paths per page.',
  inputSchema: { type: 'object', properties: { prefix: { type: 'string' }, after: { type: 'string' } },
    required: ['prefix', 'after'], additionalProperties: false },
};
const readTool = {
  name: 'dhr_read_text',
  description: 'Read a bounded page of a frozen text file, verifying its snapshot hash; paths absent from the snapshot return a missing receipt.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
    required: ['path', 'offset'], additionalProperties: false },
};
const searchTool = {
  name: 'dhr_search_text',
  description: 'Search a bounded page of frozen UTF-8 files for a literal string; no shell or regular expressions.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, prefix: { type: 'string' }, after: { type: 'string' } },
    required: ['query', 'prefix', 'after'], additionalProperties: false },
};
const failure = (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] });

/** Pure stdio MCP endpoint: it never writes the project or persists a proposal. */
export function handleCodexProposalMcp(value: unknown, allowsProposal: (path: string) => boolean = () => true): RpcResponse | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Partial<RpcRequest>;
  if (!Object.hasOwn(input, 'id')) return null;
  const id = input.id;
  if ((typeof id !== 'string' && typeof id !== 'number') || input.jsonrpc !== '2.0' || typeof input.method !== 'string') {
    return { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : 0,
      error: { code: -32600, message: 'Invalid JSON-RPC request' } };
  }
  if (input.method === 'initialize') return { jsonrpc: '2.0', id, result: {
    protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dhr-proposal', version: '0.1.0' },
  } };
  if (input.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (input.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [textTool, deleteTool] } };
  if (input.method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  const params = input.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params) || !('name' in params)
    || (params.name !== textTool.name && params.name !== deleteTool.name)
    || !('arguments' in params) || params.arguments === null || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
    return { jsonrpc: '2.0', id, result: failure('Unknown proposal tool or invalid arguments') };
  }
  const args = params.arguments as Record<string, unknown>;
  if (typeof args.path !== 'string' || args.path.length > 4096 || !isRepoPath(args.path)
    || args.path.split('/').some((part) => part.toLowerCase() === '.git')) {
    return { jsonrpc: '2.0', id, result: failure('Proposal requires a repository-relative path') };
  }
  if (!allowsProposal(args.path)) return { jsonrpc: '2.0', id, result: failure('Proposal path is outside this Task scope') };
  if (params.name === deleteTool.name) {
    if (Object.keys(args).join(',') !== 'path') return { jsonrpc: '2.0', id, result: failure('Delete proposal accepts only path') };
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text',
      text: `PROPOSED_DELETE ${createHash('sha256').update(args.path, 'utf8').digest('hex')}` }] } };
  }
  if (Object.keys(args).sort().join(',') !== 'content,path' || typeof args.content !== 'string'
    || Buffer.byteLength(args.content, 'utf8') > 4 * 1024 * 1024) {
    return { jsonrpc: '2.0', id, result: failure('Text proposal requires at most 4 MiB of UTF-8 content') };
  }
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text',
    text: `PROPOSED ${createHash('sha256').update(args.content, 'utf8').digest('hex')}` }] } };
}

/** Read tools are present only when a trusted controller supplies a frozen policy. */
export async function handleCodexBridgeMcp(value: unknown, bridge: CodexBridgeView): Promise<RpcResponse | null> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return handleCodexProposalMcp(value, bridge.allowsProposal);
  const input = value as Partial<RpcRequest>;
  if (!Object.hasOwn(input, 'id') || (typeof input.id !== 'string' && typeof input.id !== 'number')
    || input.jsonrpc !== '2.0' || typeof input.method !== 'string') return handleCodexProposalMcp(value, bridge.allowsProposal);
  if (input.method === 'tools/list') return { jsonrpc: '2.0', id: input.id,
    result: { tools: [textTool, deleteTool, listTool, readTool, searchTool] } };
  if (input.method !== 'tools/call' || input.params === null || typeof input.params !== 'object'
    || Array.isArray(input.params) || !('name' in input.params)
    || (input.params.name !== listTool.name && input.params.name !== readTool.name && input.params.name !== searchTool.name)) {
    return handleCodexProposalMcp(value, bridge.allowsProposal);
  }
  const params = input.params;
  if (!('arguments' in params) || params.arguments === null || typeof params.arguments !== 'object'
    || Array.isArray(params.arguments)) return { jsonrpc: '2.0', id: input.id, result: failure('Invalid read arguments') };
  const args = params.arguments as Record<string, unknown>;
  try {
    if (params.name === listTool.name) {
      if (Object.keys(args).sort().join(',') !== 'after,prefix' || typeof args.prefix !== 'string' || typeof args.after !== 'string') {
        return { jsonrpc: '2.0', id: input.id, result: failure('List requires prefix and after strings') };
      }
      return { jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text',
        text: JSON.stringify(bridge.read.list(args.prefix, args.after)) }] } };
    }
    if (params.name === searchTool.name) {
      if (Object.keys(args).sort().join(',') !== 'after,prefix,query' || typeof args.query !== 'string'
        || typeof args.prefix !== 'string' || typeof args.after !== 'string') {
        return { jsonrpc: '2.0', id: input.id, result: failure('Search requires query, prefix and after strings') };
      }
      return { jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text',
        text: JSON.stringify(await bridge.read.search(args.query, args.prefix, args.after)) }] } };
    }
    if (Object.keys(args).sort().join(',') !== 'offset,path' || typeof args.path !== 'string'
      || !Number.isSafeInteger(args.offset) || (args.offset as number) < 0) {
      return { jsonrpc: '2.0', id: input.id, result: failure('Read requires path and nonnegative offset') };
    }
    return { jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text',
      text: JSON.stringify(await bridge.read.readPage(args.path, args.offset as number)) }] } };
  } catch {
    return { jsonrpc: '2.0', id: input.id, result: failure('Frozen read failed') };
  }
}

async function serve(): Promise<void> {
  let bridge: CodexBridgeView | undefined;
  if (process.argv[2]) {
    const bytes = await readFile(process.argv[2]);
    if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('Read policy is too large');
    bridge = await createCodexBridgeView(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }
  const lines = async function* (): AsyncGenerator<string> {
    let parts: Buffer[] = [];
    let size = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const value of process.stdin) {
      const chunk = Buffer.from(value);
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
        size += piece.length;
        if (size > 32 * 1024 * 1024) throw new Error('MCP request line is too large');
        parts.push(piece);
        if (end === -1) break;
        yield decoder.decode(Buffer.concat(parts, size));
        parts = []; size = 0; start = end + 1;
      }
    }
    if (size > 0) yield decoder.decode(Buffer.concat(parts, size));
  };
  for await (const line of lines()) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { continue; }
    const response = bridge ? await handleCodexBridgeMcp(message, bridge) : handleCodexProposalMcp(message);
    if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await serve();
}
