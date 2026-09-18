/** Opt-in synthetic Codex model turn under the trusted PID 1 namespace controller. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { runCodexHostNamespace } from '../packages/adapter-codex/dist/executor/host-namespace.js';

assert.equal(process.argv.length, 2, 'Host namespace smoke does not accept arguments');
assert.ok(process.env.DHR_TEST_BWRAP && isAbsolute(process.env.DHR_TEST_BWRAP), 'Set DHR_TEST_BWRAP to a local absolute path');

async function codexBinary() {
  if (process.env.DHR_CODEX_BINARY) {
    assert.ok(isAbsolute(process.env.DHR_CODEX_BINARY));
    return realpath(process.env.DHR_CODEX_BINARY);
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    const path = join(dir, 'codex');
    if (await access(path, constants.X_OK).then(() => true, () => false)) return realpath(path);
  }
  throw new Error('Codex CLI is unavailable');
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-codex-host-namespace-')));
try {
  const auth = await realpath(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'));
  const env = { HOME: '/dhr/home', CODEX_HOME: '/dhr/home', PATH: '/usr/bin', LANG: 'C.UTF-8' };
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const result = await runCodexHostNamespace({ bubblewrap: process.env.DHR_TEST_BWRAP,
    nodeBinary: process.execPath, executable: '/dhr/codex', cwd: root, timeoutMs: 120_000,
    mounts: [
      { source: await codexBinary(), destination: '/dhr/codex' },
      { source: auth, destination: '/dhr/home/auth.json' },
      { source: root, destination: root },
      { source: await realpath('/etc/ssl/certs'), destination: '/etc/ssl/certs' },
      { source: await realpath('/etc/resolv.conf'), destination: '/etc/resolv.conf' },
    ], tmpfs: ['/dhr/home'], environment: env,
    argv: ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--disable', 'shell_tool',
      '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '-C', root,
      'Synthetic empty-workspace host namespace probe. Reply with exactly OK.'] });
  const events = result.stdout.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(result.exitCode, 0, result.stderr.toString('utf8').slice(-2000));
  assert.equal(result.termination, 'exited');
  assert.equal(result.quiescence, 'confirmed');
  assert.ok(events.some((event) => event.type === 'thread.started'));
  assert.ok(events.some((event) => event.type === 'turn.completed'));
  process.stdout.write(JSON.stringify({ status: 'passed', threadId: events.find((event) => event.type === 'thread.started').thread_id,
    namespace: result.evidence.namespaceIds, quiescence: result.quiescence }) + '\n');
} finally { await rm(root, { recursive: true, force: true }); }
