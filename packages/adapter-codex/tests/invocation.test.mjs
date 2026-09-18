import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCodexInvocation } from '../dist/executor/invocation.js';

const request = JSON.parse(readFileSync(new URL('../../contracts/fixtures/execution/request.json', import.meta.url), 'utf8'));
const input = { request, prompt: 'one task', mcpCommand: '/usr/bin/node',
  mcpArgs: ['/opt/dhr/mcp-server.js', '/opt/dhr/bridge-policy.json'],
  outputSchema: '/opt/dhr/result.schema.json' };

test('Codex Worker invocation requests isolated configuration and a required proposal MCP entry', () => {
  const argv = createCodexInvocation(input);
  assert.deepEqual(argv.slice(0, 4), ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules']);
  assert.ok(argv.includes('read-only'));
  assert.ok(!argv.includes('workspace-write'));
  assert.ok(!argv.includes('resume'));
  assert.ok(argv.at(-1).startsWith('one task\n\n## Codex 结构化结果'));
  assert.match(argv.at(-1), /顶层仅含 result/u);
  assert.ok(argv.includes('mcp_servers.dhr_proposal.enabled_tools=["dhr_propose_text","dhr_propose_delete","dhr_list_paths","dhr_read_text","dhr_search_text"]'));
  assert.ok(argv.includes('mcp_servers.dhr_proposal.required=true'));
  assert.ok(argv.includes('mcp_servers.dhr_proposal.args=["/opt/dhr/mcp-server.js","/opt/dhr/bridge-policy.json"]'));
  assert.ok(argv.includes('web_search="disabled"'));
  for (const tool of ['apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'plugins', 'shell_tool']) {
    assert.ok(argv.some((value, index) => value === '--disable' && argv[index + 1] === tool));
  }
});

test('Codex Worker invocation rejects relative paths and oversized prompts', () => {
  assert.throws(() => createCodexInvocation({ ...input, mcpCommand: '../node' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => createCodexInvocation({ ...input, mcpArgs: ['only-one'] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => createCodexInvocation({ ...input, outputSchema: '/tmp/../schema.json' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => createCodexInvocation({ ...input, prompt: 'x'.repeat(256 * 1024 + 1) }), { code: 'INVALID_ARGUMENT' });
});
