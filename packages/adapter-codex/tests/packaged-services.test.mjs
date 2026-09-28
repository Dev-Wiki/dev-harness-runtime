import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPackagedCodexServices, loadCodexPackageSource } from '../dist/index.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function packageFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhr-codex-services-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['runtime', 'skills/worker']) await mkdir(join(root, path), { recursive: true });
  const bundled = new URL('../dist/adapter.bundle.js', import.meta.url);
  const worker = new URL('../../../skills/worker/SKILL.md', import.meta.url);
  await copyFile(bundled, join(root, 'runtime/adapter.js'));
  await copyFile(worker, join(root, 'skills/worker/SKILL.md'));
  await writeFile(join(root, 'runtime/dhr.js'), 'export const runCli = () => 0;\n');
  const entry = async (path) => ({ path, sha256: digest(await readFile(join(root, path))) });
  const source = { schemaVersion: 1, protocolSource: { schemaVersion: 1,
    repository: 'https://example.invalid/protocol', version: '1.0.0', commit: 'a'.repeat(40),
    files: [{ path: 'VERSION', sha256: digest('1.0.0\n') }] },
    workerSkill: await entry('skills/worker/SKILL.md'), runtimeBundle: await entry('runtime/dhr.js'),
    adapterBundle: await entry('runtime/adapter.js') };
  await writeFile(join(root, 'runtime/source.json'), `${JSON.stringify(source)}\n`);
  return { root, source };
}

test('package source is verified outside the workspace', async (t) => {
  const fixture = await packageFixture(t);
  const loaded = await loadCodexPackageSource(fixture.root);
  assert.deepEqual(loaded.protocolSource, fixture.source.protocolSource);
  assert.equal(loaded.adapterBundlePath, join(fixture.root, 'runtime/adapter.js'));
  await writeFile(join(fixture.root, 'runtime/adapter.js'), 'changed\n');
  await assert.rejects(() => loadCodexPackageSource(fixture.root), { code: 'CAPABILITY_MISSING' });
});

test('installed Codex package assembles trusted services without starting a model session',
  { skip: !process.env.DHR_TEST_BWRAP && 'Requires an explicit local bubblewrap provider' }, async (t) => {
    const fixture = await packageFixture(t);
    const services = await createPackagedCodexServices({ packageRoot: fixture.root,
      bubblewrapPath: process.env.DHR_TEST_BWRAP,
      authFile: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
      modelProxy: { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY } });
    assert.deepEqual(services.protocolSource, fixture.source.protocolSource);
    assert.match(services.adapterConfigHash, /^[a-f0-9]{64}$/u);
    assert.equal(services.adapters.get('codex').id, 'codex');
    assert.equal(services.git?.gitBinary, '/usr/bin/git');
    assert.equal(typeof services.git?.policy.evaluate, 'function');
  });
