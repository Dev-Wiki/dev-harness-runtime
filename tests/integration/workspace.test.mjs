import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { PLATFORM_IDS, CORE_PROTOCOL_VERSION } from '../../packages/contracts/dist/index.js';
import { AdapterRegistry } from '../../packages/core/dist/index.js';

test('all adapter packages link to contracts but claim no runtime capability', async () => {
  const registry = new AdapterRegistry();
  for (const id of PLATFORM_IDS) {
    const { adapter } = await import(`../../packages/adapter-${id}/dist/index.js`);
    registry.register(adapter);
    assert.equal(adapter.coreProtocolVersion, CORE_PROTOCOL_VERSION);
    assert.equal(adapter.implemented, false);
    assert.equal('executor' in adapter, false);
    assert.equal('packager' in adapter, false);
  }
  assert.equal(registry.list().length, PLATFORM_IDS.length);
});

test('CLI help/version succeed while unavailable commands fail', () => {
  for (const args of [[], ['--help'], ['--version'], ['run'], ['--help', 'run']]) {
    const result = spawnSync(process.execPath, ['packages/cli/bin/dhr.mjs', ...args], { encoding: 'utf8' });
    assert.ifError(result.error);
    const success = args.length < 2 && args[0] !== 'run';
    assert.equal(result.status, success ? 0 : 2, result.stderr);
    if (args[0] === '--version') assert.equal(result.stdout, '0.1.0\n');
    if (args[0] === '--help') assert.match(success ? result.stdout : result.stderr, /dhr/);
  }
});
