import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { handleCodexProposalMcp } from '../dist/executor/mcp-server.js';

const call = (args, name = 'dhr_propose_text') => handleCodexProposalMcp({ jsonrpc: '2.0', id: 3,
  method: 'tools/call', params: { name, arguments: args } });

test('proposal MCP exposes one side-effect-free text proposal tool', () => {
  const init = handleCodexProposalMcp({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(init.result.serverInfo.name, 'dhr-proposal');
  const listed = handleCodexProposalMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['dhr_propose_text']);
  const proposed = call({ path: 'src/a.ts', content: 'abc' });
  assert.equal(proposed.result.content[0].text, `PROPOSED ${createHash('sha256').update('abc').digest('hex')}`);
  assert.equal(handleCodexProposalMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('proposal MCP rejects path traversal, unknown tools and oversized content', () => {
  for (const args of [{ path: '../outside', content: 'x' }, { path: '/absolute', content: 'x' },
    { path: 'src/a.ts', content: 'x', extra: true }, { path: 'src/a.ts', content: 'x'.repeat(4 * 1024 * 1024 + 1) }]) {
    assert.equal(call(args).result.isError, true);
  }
  assert.equal(call({}, 'other').result.isError, true);
  assert.equal(handleCodexProposalMcp({ jsonrpc: '2.0', id: 4, method: 'unknown' }).error.code, -32601);
});
