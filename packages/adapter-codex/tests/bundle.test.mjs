import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('distributable Codex Adapter imports and serves MCP outside the workspace', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dhr-codex-bundle-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const bundle = join(scratch, 'adapter.mjs');
  await copyFile(new URL('../dist/adapter.bundle.js', import.meta.url), bundle);
  const imported = await import(pathToFileURL(bundle).href);
  assert.equal(typeof imported.createCodexRuntimeAdapter, 'function');
  assert.equal(typeof imported.createPackagedCodexServices, 'function');
  const request = { jsonrpc: '2.0', id: 1, method: 'initialize' };
  const served = spawnSync(process.execPath, [bundle], { cwd: scratch,
    input: `${JSON.stringify(request)}\n`, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH ?? '' } });
  assert.ifError(served.error);
  assert.equal(served.status, 0, served.stderr);
  assert.equal(served.stderr, '');
  assert.equal(JSON.parse(served.stdout).result.serverInfo.name, 'dhr-proposal');
});
