import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createConfinedCodexBridge } from '../dist/executor/confined-bridge.js';
import { runConfinedCodexProcess } from '../dist/executor/confined-process.js';
import { runCodexHostNamespace } from '../dist/executor/host-namespace.js';
import { createCodexBridgePolicy, withCodexBridgePolicy } from '../dist/executor/bridge-policy.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const fixture = new URL('../../contracts/fixtures/execution/request.json', import.meta.url);
const bundle = fileURLToPath(new URL('../dist/executor/bridge.bundle.mjs', import.meta.url));

function run(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin' } });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (part) => stdout.push(part));
    child.stderr.on('data', (part) => stderr.push(part));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.end(input);
  });
}

test('confined process supports a system bridge provider without remounting the fixed readonly system tree',
  { skip: !process.env.DHR_TEST_BWRAP }, async (t) => {
    const bubblewrap = await realpath(process.env.DHR_TEST_BWRAP);
    if (!bubblewrap.startsWith('/usr/')) { t.skip('Requires a provider installed in the fixed /usr tree'); return; }
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-system-bridge-test-')));
    try {
      const cwd = join(root, 'project'); const privateRoot = join(root, 'private');
      const repoMirror = join(privateRoot, 'repo');
      await mkdir(cwd); await mkdir(privateRoot); await mkdir(repoMirror);
      const binary = join(privateRoot, 'codex'); const authFile = join(privateRoot, 'auth.json');
      const outputSchema = join(privateRoot, 'schema.json');
      // A native failing target exercises the whole host launch without a Codex or model session.
      await copyFile('/usr/bin/false', binary);
      await copyFile('/usr/bin/true', join(privateRoot, 'codex-code-mode-host'));
      await writeFile(authFile, '{}', { mode: 0o600 }); await writeFile(outputSchema, '{}');
      const request = JSON.parse(await readFile(fixture, 'utf8'));
      let quiescent;
      const input = { binary, argv: [], cwd, env: {}, request, signal: new AbortController().signal,
        log: async () => {}, bubblewrap, nodeBinary: process.execPath, authFile, outputSchema, timeoutMs: 10_000,
        bridge: { command: bubblewrap, args: [], hostSources: [bubblewrap, repoMirror], repoMirror },
        onHostQuiescent(evidence, audit) { quiescent = { evidence, audit }; } };
      await assert.rejects(runConfinedCodexProcess(input), (error) => {
        assert.equal(error.code, 'EXECUTION_FAILED');
        assert.match(error.message, /Confined Codex exited 1 .*after confirmed host quiescence/u);
        return true;
      });
      assert.equal(quiescent.evidence.asPid1, true);
      assert.equal(quiescent.evidence.monitorWaited, true);
      assert.deepEqual(quiescent.audit.connected, {});
      assert.equal(quiescent.audit.denied, 0);
      const invalidSources = ['/usr/bin/../bin/bwrap'];
      if (await realpath('/usr/bin/python3') !== '/usr/bin/python3') invalidSources.push('/usr/bin/python3');
      for (const source of invalidSources) {
        await assert.rejects(runConfinedCodexProcess({ ...input,
          bridge: { ...input.bridge, hostSources: [...input.bridge.hostSources, source] } }),
        { code: 'INVALID_ARGUMENT' });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('confined MCP reads only the frozen catalog and cannot see sibling files',
  { skip: !process.env.DHR_TEST_BWRAP }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dhr-confined-test-'));
    try {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src/a.ts'), 'HELLO');
      await writeFile(join(root, 'private.txt'), 'NEVER_MOUNT');
      const base = JSON.parse(await readFile(fixture, 'utf8'));
      const request = { ...base, repoRoot: root, docsRoot: join(root, 'docs'),
        dashboardPath: join(root, 'docs/plan/Dashboard.md'), taskPath: join(root, 'docs/plan/tasks/K1.md'),
        scope: { ...base.scope, files: ['src/a.ts'] } };
      const catalog = { repoRoot: root, runId: request.runId, requestId: request.requestId,
        snapshotHash: request.snapshotHash, files: [{ path: 'src/a.ts', sha256: hash('HELLO') }] };
      const policy = createCodexBridgePolicy(request, catalog);
      await withCodexBridgePolicy(policy, async (policyPath) => {
        const launch = await createConfinedCodexBridge({ bubblewrap: process.env.DHR_TEST_BWRAP,
          nodeBinary: process.execPath, serverBundle: bundle, policyPath, readCatalog: catalog });
        try {
          const inspect = await run(launch.command, [...launch.args.slice(0, -3), '/dhr/node', '-e',
            `const fs=require('node:fs');console.log(JSON.stringify({allowed:fs.existsSync(process.cwd()+'/src/a.ts'),private:fs.existsSync(process.cwd()+'/private.txt'),home:fs.existsSync(${JSON.stringify(join(homedir(), '.codex'))}),env:Object.keys(process.env).sort()}))`]);
          assert.equal(inspect.code, 0, inspect.stderr);
          const visible = JSON.parse(inspect.stdout.trim());
          assert.equal(visible.allowed, true);
          assert.equal(visible.private, false);
          assert.equal(visible.home, false);
          assert.deepEqual(visible.env, ['HOME', 'LANG', 'PATH', 'PWD', 'TMPDIR']);
          const message = { jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'dhr_read_text', arguments: { path: 'src/a.ts', offset: 0 } } };
          const mcp = await run(launch.command, launch.args, `${JSON.stringify(message)}\n`);
          assert.equal(mcp.code, 0, mcp.stderr);
          const response = JSON.parse(mcp.stdout.trim());
          assert.equal(JSON.parse(response.result.content[0].text).content, 'HELLO');
          assert.ok(launch.args.includes('--die-with-parent'));
          const nestedLaunch = await createConfinedCodexBridge({ bubblewrap: process.env.DHR_TEST_BWRAP,
            nodeBinary: process.execPath, serverBundle: bundle, policyPath, readCatalog: catalog, parentContained: true });
          try {
            assert.ok(!nestedLaunch.args.includes('--die-with-parent'));
            const nested = await runCodexHostNamespace({ bubblewrap: process.env.DHR_TEST_BWRAP,
              nodeBinary: process.execPath, executable: '/dhr/bwrap', argv: nestedLaunch.args,
              cwd: root, timeoutMs: 10_000, tmpfs: [], environment: { HOME: '/tmp', PATH: '/usr/bin' },
              mounts: [...nestedLaunch.hostSources.filter((source) => !source.startsWith('/usr/'))
                .map((source) => ({ source, destination: source })),
                { source: nestedLaunch.command, destination: '/dhr/bwrap' },
                { source: nestedLaunch.repoMirror, destination: root }],
              stdin: Buffer.from(`${JSON.stringify(message)}\n`) });
            assert.equal(nested.exitCode, 0, nested.stderr.toString('utf8'));
            assert.equal(nested.quiescence, 'confirmed');
            const nestedResponse = JSON.parse(nested.stdout.toString('utf8').trim());
            assert.equal(JSON.parse(nestedResponse.result.content[0].text).content, 'HELLO');
          } finally { await nestedLaunch.close(); }
        } finally { await launch.close(); }
      });
      await writeFile(join(root, 'src/a.ts'), 'CHANGED');
      await assert.rejects(withCodexBridgePolicy(policy, async (policyPath) => createConfinedCodexBridge({
        bubblewrap: process.env.DHR_TEST_BWRAP, nodeBinary: process.execPath,
        serverBundle: bundle, policyPath, readCatalog: catalog,
      })), { code: 'INVALID_POLICY' });
      await rm(join(root, 'src/a.ts'));
      await symlink(join(root, 'private.txt'), join(root, 'src/a.ts'));
      await assert.rejects(withCodexBridgePolicy(policy, async (policyPath) => createConfinedCodexBridge({
        bubblewrap: process.env.DHR_TEST_BWRAP, nodeBinary: process.execPath,
        serverBundle: bundle, policyPath, readCatalog: catalog,
      })), { code: 'INVALID_POLICY' });
      await rm(join(root, 'src/a.ts'));
      await link(join(root, 'private.txt'), join(root, 'src/a.ts'));
      await assert.rejects(withCodexBridgePolicy(policy, async (policyPath) => createConfinedCodexBridge({
        bubblewrap: process.env.DHR_TEST_BWRAP, nodeBinary: process.execPath,
        serverBundle: bundle, policyPath, readCatalog: catalog,
      })), { code: 'INVALID_POLICY' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
