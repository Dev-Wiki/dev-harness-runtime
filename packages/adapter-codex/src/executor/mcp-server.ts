import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { isRepoPath } from '@dev-harness-runtime/contracts';

type RpcId = string | number;
interface RpcRequest { jsonrpc: '2.0'; id?: RpcId; method: string; params?: unknown }
type RpcResponse = { jsonrpc: '2.0'; id: RpcId; result?: unknown; error?: { code: number; message: string } };
const tool = {
  name: 'dhr_propose_text',
  description: 'Propose UTF-8 content for one Task-scoped repository file. This records a proposal only; the trusted Runtime decides whether to apply it.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false },
};
const failure = (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] });

/** Pure stdio MCP endpoint: it never writes the project or persists a proposal. */
export function handleCodexProposalMcp(value: unknown): RpcResponse | null {
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
  if (input.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [tool] } };
  if (input.method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  const params = input.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params) || !('name' in params) || params.name !== tool.name
    || !('arguments' in params) || params.arguments === null || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
    return { jsonrpc: '2.0', id, result: failure('Unknown proposal tool or invalid arguments') };
  }
  const args = params.arguments as Record<string, unknown>;
  if (Object.keys(args).sort().join(',') !== 'content,path' || typeof args.path !== 'string' || !isRepoPath(args.path)
    || typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > 4 * 1024 * 1024) {
    return { jsonrpc: '2.0', id, result: failure('Proposal requires a repository-relative path and at most 4 MiB of UTF-8 text') };
  }
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text',
    text: `PROPOSED ${createHash('sha256').update(args.content, 'utf8').digest('hex')}` }] } };
}

async function serve(): Promise<void> {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { continue; }
    const response = handleCodexProposalMcp(message);
    if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await serve();
}
