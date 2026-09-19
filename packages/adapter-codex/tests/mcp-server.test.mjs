import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleCodexProposalMcp, handleCodexBridgeMcp } from '../dist/executor/mcp-server.js';
import { createCodexBridgeView, withCodexBridgePolicy } from '../dist/executor/bridge-policy.js';

const scope = { schemaVersion: 1, files: ['src/a.ts'], directories: ['src/generated'],
  planning: { taskId: 'K1', taskPath: 'docs/plan/tasks/K1.md', archivePath: 'docs/plan/archive/V1/K1.md',
    dashboardPath: 'docs/plan/Dashboard.md', archiveIndexPath: 'docs/plan/archive/V1/README.md' } };
const policy = (root) => ({ schemaVersion: 1,
  identity: { runId: 'run-a', taskId: 'K1', attempt: 1, requestId: 'request-a', snapshotHash: 'a'.repeat(64) },
  read: { repoRoot: root, runId: 'run-a', requestId: 'request-a', snapshotHash: 'a'.repeat(64),
    files: [{ path: 'src/a.ts', sha256: createHash('sha256').update('HELLO').digest('hex') }] },
  scope });

const call = (args, name = 'dhr_propose_text') => handleCodexProposalMcp({ jsonrpc: '2.0', id: 3,
  method: 'tools/call', params: { name, arguments: args } });

test('proposal MCP exposes side-effect-free text and delete proposal tools', () => {
  const init = handleCodexProposalMcp({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(init.result.serverInfo.name, 'dhr-proposal');
  const listed = handleCodexProposalMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['dhr_propose_text', 'dhr_propose_delete']);
  const proposed = call({ path: 'src/a.ts', content: 'abc' });
  assert.equal(proposed.result.content[0].text, `PROPOSED ${createHash('sha256').update('abc').digest('hex')}`);
  const deleted = call({ path: 'src/a.ts' }, 'dhr_propose_delete');
  assert.equal(deleted.result.content[0].text, `PROPOSED_DELETE ${createHash('sha256').update('src/a.ts').digest('hex')}`);
  assert.equal(handleCodexProposalMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('proposal MCP rejects path traversal, unknown tools and oversized content', () => {
  for (const args of [{ path: '../outside', content: 'x' }, { path: '/absolute', content: 'x' },
    { path: 'src/a.ts', content: 'x', extra: true }, { path: 'src/a.ts', content: 'x'.repeat(4 * 1024 * 1024 + 1) }]) {
    assert.equal(call(args).result.isError, true);
  }
  assert.equal(call({ path: '../outside' }, 'dhr_propose_delete').result.isError, true);
  assert.equal(call({ path: '.git/config' }, 'dhr_propose_delete').result.isError, true);
  assert.equal(call({ path: 'src/a.ts', content: 'x' }, 'dhr_propose_delete').result.isError, true);
  assert.equal(call({}, 'other').result.isError, true);
  assert.equal(handleCodexProposalMcp({ jsonrpc: '2.0', id: 4, method: 'unknown' }).error.code, -32601);
});

test('snapshot-bound MCP lists and reads only frozen files with bounded pages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dhr-codex-mcp-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'HELLO');
  const bridge = await createCodexBridgeView(policy(root));
  const rpc = (name, args) => handleCodexBridgeMcp({ jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name, arguments: args } }, bridge);
  const listed = await handleCodexBridgeMcp({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, bridge);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name),
    ['dhr_propose_text', 'dhr_propose_delete', 'dhr_list_paths', 'dhr_read_text', 'dhr_search_text']);
  assert.deepEqual(JSON.parse((await rpc('dhr_list_paths', { prefix: 'src', after: '' })).result.content[0].text),
    { paths: ['src/a.ts'], next: null });
  assert.deepEqual(JSON.parse((await rpc('dhr_read_text', { path: 'src/a.ts', offset: 0 })).result.content[0].text),
    { path: 'src/a.ts', content: 'HELLO', sha256: createHash('sha256').update('HELLO').digest('hex'), offset: 0, nextOffset: null });
  assert.deepEqual(JSON.parse((await rpc('dhr_read_text', { path: 'src/new.ts', offset: 0 })).result.content[0].text),
    { path: 'src/new.ts', missing: true });
  assert.equal((await rpc('dhr_read_text', { path: '.git/config', offset: 0 })).result.isError, true);
  assert.deepEqual(JSON.parse((await rpc('dhr_search_text', { query: 'ELL', prefix: 'src', after: '' })).result.content[0].text),
    { matches: [{ path: 'src/a.ts', line: 1, column: 2, excerpt: 'HELLO' }], skipped: [], next: null });
  assert.equal((await rpc('dhr_search_text', { query: '', prefix: 'src', after: '' })).result.isError, true);
  assert.equal((await rpc('dhr_propose_text', { path: 'src/outside.ts', content: 'x' })).result.isError, true);
  assert.equal((await rpc('dhr_propose_delete', { path: 'docs/plan/tasks/other.md' })).result.isError, true);
  assert.equal((await rpc('dhr_propose_text', { path: 'src/generated/new.ts', content: 'x' })).result.isError, undefined);
  assert.equal((await rpc('dhr_propose_delete', { path: 'docs/plan/tasks/K1.md' })).result.isError, undefined);
});

test('stdio MCP process loads one private bridge policy and gates proposal calls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dhr-codex-mcp-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'HELLO');
  await withCodexBridgePolicy(policy(root), async (path) => {
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dhr_read_text', arguments: { path: 'src/a.ts', offset: 0 } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dhr_propose_text', arguments: { path: 'other.ts', content: 'x' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dhr_search_text', arguments: { query: 'ELL', prefix: 'src', after: '' } } },
    ];
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/executor/mcp-server.js', import.meta.url)), path],
      { input: messages.map((message) => JSON.stringify(message)).join('\n') + '\n', encoding: 'utf8', timeout: 5000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines[0].result.tools.map((tool) => tool.name),
      ['dhr_propose_text', 'dhr_propose_delete', 'dhr_list_paths', 'dhr_read_text', 'dhr_search_text']);
    assert.equal(JSON.parse(lines[1].result.content[0].text).content, 'HELLO');
    assert.equal(lines[2].result.isError, true);
    assert.equal(JSON.parse(lines[3].result.content[0].text).matches[0].column, 2);
  });
});
