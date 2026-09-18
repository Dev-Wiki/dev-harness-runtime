import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCodexInvocation } from '../dist/executor/invocation.js';

const request = JSON.parse(readFileSync(new URL('../../contracts/fixtures/execution/request.json', import.meta.url), 'utf8'));
const input = { request, prompt: 'one task', nodeBinary: '/usr/bin/node',
  proposalServer: '/opt/dhr/mcp-server.js', outputSchema: '/opt/dhr/result.schema.json' };

test('Codex Worker invocation requests isolated configuration and a required proposal MCP entry', () => {
  const argv = createCodexInvocation(input);
  assert.deepEqual(argv.slice(0, 4), ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules']);
  assert.ok(argv.includes('read-only'));
  assert.ok(!argv.includes('workspace-write'));
  assert.ok(!argv.includes('resume'));
  assert.equal(argv.at(-1), 'one task');
  assert.ok(argv.includes('mcp_servers.dhr_proposal.enabled_tools=["dhr_propose_text"]'));
  assert.ok(argv.includes('mcp_servers.dhr_proposal.required=true'));
  assert.ok(argv.includes('web_search="disabled"'));
  for (const tool of ['apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'plugins', 'shell_tool']) {
    assert.ok(argv.some((value, index) => value === '--disable' && argv[index + 1] === tool));
  }
});

test('Codex Worker invocation rejects relative paths and oversized prompts', () => {
  assert.throws(() => createCodexInvocation({ ...input, proposalServer: '../mcp-server.js' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => createCodexInvocation({ ...input, outputSchema: '/tmp/../schema.json' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => createCodexInvocation({ ...input, prompt: 'x'.repeat(256 * 1024 + 1) }), { code: 'INVALID_ARGUMENT' });
});
