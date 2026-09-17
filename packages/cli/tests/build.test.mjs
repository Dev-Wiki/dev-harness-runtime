import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { PlatformRegistry, createPlatformRegistry } from '../../../build/dist/targets/platforms.js';
import { runCli } from '../dist/index.js';
import { setupRuntimeFixture } from '../../../tests/fixtures/fake-executor/fixture.mjs';

async function cli(args, options = {}) {
  let stdout = ''; let stderr = '';
  const code = await runCli(args, { out: (text) => { stdout += text; }, error: (text) => { stderr += text; } }, options);
  return { code, stdout, stderr };
}
function fakeBuild() {
  const platforms = new PlatformRegistry();
  const id = 'fixture';
  const calls = [];
  const results = {
    generate: { platform: id, root: '.generated/fixture', inputHash: 'a'.repeat(64) },
    validate: { valid: true, checks: [{ code: 'FIXTURE_OK' }] },
    pack: [{ platform: id, file: 'dist/fixture.zip' }],
  };
  platforms.register({ id, packager: { id } });
  const build = { platforms, root: process.cwd() };
  for (const method of Object.keys(results)) build[method] = async (adapter) => { calls.push([method, adapter]); return results[method]; };
  return { platforms, build, calls, results };
}

test('default platform descriptors advertise known identities without fabricating capabilities', () => {
  const platforms = createPlatformRegistry();
  assert.deepEqual(platforms.list().map((entry) => entry.id), ['codex', 'dsh', 'cursor', 'opencode', 'antigravity', 'agent-plugin']);
  assert.equal(platforms.runtimeRegistry().list().length, 0);
  assert.ok(platforms.list().every((entry) => entry.packager === undefined));
  assert.throws(() => platforms.register({ id: 'codex' }), /already contains/u);
  assert.throws(() => platforms.register({ id: 'custom', runtime: { id: 'other' } }), /registered platform ID/u);
  assert.throws(() => platforms.register({ id: 'custom', packager: { id: 'other' } }), /registered platform ID/u);
});

test('build commands distinguish unknown platforms and missing packagers before project access', async () => {
  for (const command of ['build', 'validate', 'pack']) {
    for (const id of ['codex', 'agent-plugin', 'unknown-host']) {
      const result = await cli([command, '--adapter', id, '--project', '/missing-build-project']);
      assert.equal(result.code, 2, result.stderr); assert.equal(result.stdout, '');
      assert.match(result.stderr, id === 'unknown-host' ? /^UNKNOWN_ADAPTER:/u : /^CAPABILITY_MISSING:/u);
    }
  }
});

test('malformed build arguments never consult injected services or build pipeline', async () => {
  const options = { get build() { return assert.fail('Invalid CLI arguments cannot inspect a pipeline'); },
    get services() { return assert.fail('Invalid CLI arguments cannot inspect runtime services'); } };
  for (const command of ['build', 'validate', 'pack']) {
    for (const args of [[], ['--adapter'], ['--adapter', 'UPPER'], ['--adapter', 'codex', '--all'],
      ['--adapter', 'codex', '--adapter', 'cursor'], ['--adapter', 'codex', '--docs-root', 'docs'],
      ['--adapter', 'codex', '--next'], ['--adapter', 'codex', '--project'], ['codex']]) {
      const result = await cli([command, ...args], options);
      assert.equal(result.code, 2, result.stderr); assert.match(result.stderr, /^INVALID_ARGUMENT:/u);
    }
  }
});

test('each injected build command dispatches only its own stage through the selected registry', async () => {
  for (const [command, method] of [['build', 'generate'], ['validate', 'validate'], ['pack', 'pack']]) {
    const f = fakeBuild();
    const result = await cli([command, '--adapter', 'fixture', '--project', '.'], { build: f.build, platforms: f.platforms });
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), f.results[method]);
    assert.deepEqual(f.calls, [[method, 'fixture']]);
  }
  const f = fakeBuild(); f.results.validate.valid = false;
  const invalid = await cli(['validate', '--adapter', 'fixture'], { build: f.build });
  assert.equal(invalid.code, 4); assert.equal(JSON.parse(invalid.stdout).valid, false);
  assert.deepEqual(f.calls, [['validate', 'fixture']]);
});

test('different registry objects and project roots are rejected before pipeline dispatch', async () => {
  for (const command of ['build', 'validate', 'pack', 'run', 'doctor']) {
    const f = fakeBuild();
    const args = [command, '--adapter', 'fixture', ...(command === 'run' ? ['--next'] : [])];
    const result = await cli(args, { build: f.build, platforms: createPlatformRegistry() });
    assert.equal(result.code, 2, result.stderr); assert.match(result.stderr, /^INVALID_ARGUMENT:/u);
    assert.deepEqual(f.calls, []);
  }
  const f = fakeBuild();
  const mismatch = await cli(['build', '--adapter', 'fixture', '--project', resolve('other-project')], { build: f.build });
  assert.equal(mismatch.code, 2); assert.match(mismatch.stderr, /^INVALID_ARGUMENT:/u); assert.deepEqual(f.calls, []);
});

test('one explicit registry controls unknown and unavailable platform resolution for every entry', async () => {
  const f = fakeBuild();
  for (const command of ['run', 'doctor', 'build', 'validate', 'pack']) {
    const result = await cli([command, '--adapter', 'codex', ...(command === 'run' ? ['--next'] : [])], { platforms: f.platforms });
    assert.equal(result.code, 2); assert.match(result.stderr, /^UNKNOWN_ADAPTER:/u);
  }
  const runtime = await cli(['run', '--adapter', 'fixture', '--next'], { platforms: f.platforms });
  assert.equal(runtime.code, 2); assert.match(runtime.stderr, /^CAPABILITY_MISSING:/u);
  assert.deepEqual(f.calls, []);
});

test('legacy runtime injection joins the default registry and explicit matching registry reaches Core probe', async (t) => {
  const f = await setupRuntimeFixture(t, { capabilityFalse: 'freshSession' });
  const runtime = f.services.adapters.get(f.adapter.id);
  const platforms = createPlatformRegistry([runtime]);
  assert.equal(platforms.get(runtime.id).runtime, runtime);
  assert.equal(platforms.runtimeRegistry().get(runtime.id).executor, runtime.executor);
  for (const options of [{ services: f.services }, { services: f.services, platforms }]) {
    const result = await cli(['run', '--adapter', runtime.id, '--task', 'A'], { cwd: f.root, ...options });
    assert.equal(result.code, 2, result.stderr); assert.match(result.stderr, /^CAPABILITY_MISSING:/u);
  }
  const doctor = await cli(['doctor', '--adapter', runtime.id], { cwd: f.root, services: f.services, platforms });
  assert.equal(doctor.code, 2, doctor.stderr);
  assert.match(JSON.parse(doctor.stdout).adapters[0].reason, /Registered services have not been probed/u);
  assert.equal(f.executions.length, 0); await assert.rejects(readdir(f.project.stateRoot), { code: 'ENOENT' });
});

test('explicit platform registration cannot silently discard or replace injected runtime services', async (t) => {
  const f = await setupRuntimeFixture(t);
  const runtime = f.services.adapters.get(f.adapter.id);
  for (const platforms of [createPlatformRegistry(), createPlatformRegistry([{ ...runtime }])]) {
    const result = await cli(['run', '--adapter', runtime.id, '--next'], { cwd: f.root, services: f.services, platforms });
    assert.equal(result.code, 2, result.stderr); assert.match(result.stderr, /^INVALID_ARGUMENT:/u);
  }
  assert.equal(f.executions.length, 0); await assert.rejects(readdir(f.project.stateRoot), { code: 'ENOENT' });
});
