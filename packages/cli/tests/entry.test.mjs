import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('../bin/dhr.mjs', import.meta.url));
const deniedArguments = [
  ['run'], ['run', '--task', 'A'], ['run', '--next'], ['run', '--all-ready'],
  ['run', '--unknown'], ['run', '--task'], ['run', '--help'],
  ['resume'], ['resume', 'run-a'], ['resume', '--unknown'],
  ['reconcile'], ['reconcile', 'run-a', '--resolution', 'missing.json'], ['reconcile', '--unknown'],
];

function environment(marker) {
  const env = { ...process.env };
  delete env.DEV_HARNESS_WORKER;
  if (marker !== undefined) env.DEV_HARNESS_WORKER = marker;
  return env;
}
function run(args, marker, options = {}) {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 10_000, env: environment(marker), ...options });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('Worker bin rejects every mutating entry before mode validation or repository access', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dhr-cli-worker-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'sentinel'), 'preserve');
  for (const args of deniedArguments) {
    const result = run(args, '1', { cwd });
    assert.equal(result.status, 5, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^AUTHORIZATION_VIOLATION:/u);
  }
  assert.deepEqual(readdirSync(cwd), ['sentinel']);
  assert.equal(readFileSync(join(cwd, 'sentinel'), 'utf8'), 'preserve');
});

test('Worker marker propagates through a real descendant to the dhr bin', () => {
  const script = `const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, process.argv.slice(1), { encoding: 'utf8' });
    if (child.error) throw child.error;
    process.stdout.write(child.stdout); process.stderr.write(child.stderr);
    process.exitCode = child.status ?? 99;`;
  for (const args of [['run', '--all-ready'], ['resume', 'run-a'], ['reconcile', 'run-a']]) {
    const result = spawnSync(process.execPath, ['-e', script, entry, ...args], { encoding: 'utf8', timeout: 10_000, env: environment('1') });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 5, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^AUTHORIZATION_VIOLATION:/u);
  }
});

test('ordinary callers receive parameter errors rather than fabricated execution', () => {
  for (const marker of [undefined, '0']) {
    for (const args of deniedArguments) {
      const result = run(args, marker);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /AUTHORIZATION_VIOLATION/u);
      assert.match(result.stderr, /INVALID_ARGUMENT|CAPABILITY_MISSING/u);
    }
  }
});

test('Worker help, version, status and other nonmutating input retain existing behavior', () => {
  for (const args of [[], ['help'], ['--help'], ['-h'], ['--version'], ['-v'], ['status'], ['--help', 'run'], ['unknown']]) {
    const result = run(args, '1');
    const supported = args.length === 0 || (args.length === 1 && ['help', '--help', '-h', '--version', '-v'].includes(args[0]));
    assert.equal(result.status, supported ? 0 : 2, result.stderr);
    assert.doesNotMatch(result.stderr, /AUTHORIZATION_VIOLATION/u);
    if (supported) assert.equal(result.stderr, '');
    if (['--version', '-v'].includes(args[0])) assert.equal(result.stdout, '0.1.0\n');
  }
});
