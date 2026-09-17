import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexPackager, codexStaticSpec } from '../../build/dist/targets/codex.js';
import { canonicalJson } from '../../build/dist/manifests/input.js';
import { compareGolden } from '../../build/dist/manifests/golden.js';
import { validateStatic } from '../../build/dist/validators/static.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const plugin = 'plugins/dev-harness';
const manifestPath = `${plugin}/.codex-plugin/plugin.json`;
const catalogPath = '.agents/plugins/marketplace.json';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dhr-codex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { schemaVersion: 1, repository: 'https://github.com/Dev-Wiki/dev-harness-runtime',
    version: '0.1.0', commit: 'a'.repeat(40), path: 'package.json' };
  const skills = [];
  for (const name of ['run', 'status', 'worker']) {
    const path = `skills/${name}/SKILL.md`;
    const bytes = Buffer.from(`---\nname: ${name}\ndescription: ${name} planning task\n---\n\n# ${name}\n`);
    await mkdir(join(root, 'skills', name), { recursive: true });
    await writeFile(join(root, path), bytes);
    skills.push({ schemaVersion: 1, name, path, sha256: hash(bytes), source: { ...source, path } });
  }
  const runtime = Buffer.from('export const runCli = () => 0;\n');
  const adapter = Buffer.from('export const adapter = { id: "codex" };\n');
  const notice = Buffer.from('Local package only.\n');
  await mkdir(join(root, 'packages/cli/dist'), { recursive: true });
  await mkdir(join(root, 'packages/adapter-codex/dist'), { recursive: true });
  await mkdir(join(root, 'build/manifests'), { recursive: true });
  await writeFile(join(root, 'packages/cli/dist/bundle.js'), runtime);
  await writeFile(join(root, 'packages/adapter-codex/dist/index.js'), adapter);
  await writeFile(join(root, 'build/manifests/DISTRIBUTION_NOTICE.md'), notice);
  const input = { schemaVersion: 1, platform: 'codex', releaseVersion: '0.1.0',
    adapterVersion: '0.1.0', coreProtocolVersion: 1,
    protocolSource: { schemaVersion: 1, repository: 'https://example.invalid/protocol',
      version: '1.11.8', commit: 'b'.repeat(40), files: [{ path: 'VERSION', sha256: hash('1.11.8\n') }] },
    skills, runtimeBundle: { schemaVersion: 1, version: '0.1.0', path: 'packages/cli/dist/bundle.js',
      sha256: hash(runtime), source },
    adapterBundle: { schemaVersion: 1, version: '0.1.0', path: 'packages/adapter-codex/dist/index.js',
      sha256: hash(adapter), source },
    metadata: { schemaVersion: 1, name: 'dev-harness', displayName: 'Dev Harness',
      description: 'Planning task runtime', author: 'Dev-Wiki',
      repository: source.repository,
      licenseRefs: [{ path: 'build/manifests/DISTRIBUTION_NOTICE.md', sha256: hash(notice) }] },
    buildTimestamp: '2020-01-02T03:04:06Z' };
  const packager = new CodexPackager(root);
  const generated = await packager.generate(input);
  const files = new Map();
  for (const file of generated.files) files.set(file.path, await readFile(join(root, generated.root, file.path)));
  return { root, input, packager, generated, files };
}

const errors = (checks) => checks.filter((entry) => entry.severity === 'error').map((entry) => entry.code);

test('Codex package has one native plugin, one marketplace source, three Skills and deterministic ZIP', async (t) => {
  const value = await fixture(t);
  assert.deepEqual(errors(await validateStatic(value.files, value.input, codexStaticSpec)), []);
  assert.equal((await value.packager.validate(value.generated, value.input)).valid, true);
  const first = (await value.packager.pack(value.generated, value.input))[0];
  const firstBytes = await readFile(join(value.root, 'dist', first.file));
  const second = (await value.packager.pack(value.generated, value.input))[0];
  assert.deepEqual(second, first);
  assert.deepEqual(await readFile(join(value.root, 'dist', first.file)), firstBytes);
  await compareGolden(new URL('golden/codex.json', import.meta.url).pathname, {
    paths: value.generated.files.map((file) => file.path), artifact: { file: first.file, sha256: first.sha256 },
  }, { update: process.env.DHR_UPDATE_GOLDEN === '1' });
  assert.equal(JSON.parse(value.files.get(manifestPath)).version, value.input.releaseVersion);
  assert.equal(JSON.parse(value.files.get(catalogPath)).plugins[0].source.path, './plugins/dev-harness');
});

test('Codex package fails missing files, unsupported fields, absolute paths, duplicate Skills and version drift', async (t) => {
  const value = await fixture(t);
  const probe = async (change) => {
    const files = new Map(value.files);
    change(files);
    return errors(await validateStatic(files, value.input, codexStaticSpec));
  };
  assert.ok((await probe((files) => files.delete(manifestPath))).includes('MISSING_REQUIRED_FILE'));
  assert.ok((await probe((files) => files.set(manifestPath, Buffer.from(JSON.stringify({
    ...JSON.parse(files.get(manifestPath)), unsupported: true,
  }))))).includes('UNSUPPORTED_MANIFEST_FIELD'));
  assert.ok((await probe((files) => files.set(`${plugin}/README.md`, Buffer.from('Local path /home/worker/private\n')))).includes('ABSOLUTE_LOCAL_PATH'));
  assert.ok((await probe((files) => {
    const path = `${plugin}/skills/status/SKILL.md`;
    files.set(path, Buffer.from(files.get(path).toString().replace('name: status', 'name: run')));
  })).includes('DUPLICATE_SKILL_NAME'));
  assert.ok((await probe((files) => files.set(manifestPath, Buffer.from(JSON.stringify({
    ...JSON.parse(files.get(manifestPath)), version: '9.9.9',
  }))))).includes('VERSION_MISMATCH'));
  assert.ok((await probe((files) => files.set(`${plugin}/runtime/dhr.js`, Buffer.from('changed')))).includes('BUNDLE_DIGEST_MISMATCH'));
});

test('Codex package identity and marketplace reference are validated independently', async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.root, value.generated.root, catalogPath), JSON.stringify({
    name: 'dev-harness-local', interface: { displayName: 'Dev Harness Local' },
    plugins: [{ name: 'other', source: { source: 'local', path: './plugins/other' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  }));
  const result = await value.packager.validate(value.generated, value.input);
  assert.equal(result.valid, false);
  assert.ok(errors(result.checks).includes('MARKETPLACE_SOURCE'));
  assert.equal(value.generated.inputHash, hash(canonicalJson(value.input)));
});
