import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OpenCodePackager, opencodeStaticSpec } from '../../build/dist/targets/opencode.js';
import { compareGolden } from '../../build/dist/manifests/golden.js';
import { validateStatic } from '../../build/dist/validators/static.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const errors = (checks) => checks.filter((entry) => entry.severity === 'error').map((entry) => entry.code);
const manifestPath = 'npm/package.json';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dhr-opencode-packaging-'));
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
  const adapter = Buffer.from('export const adapter = { id: "opencode" };\n');
  const notice = Buffer.from('Local package only.\n');
  await mkdir(join(root, 'packages/cli/dist'), { recursive: true });
  await mkdir(join(root, 'packages/adapter-opencode/dist'), { recursive: true });
  await mkdir(join(root, 'build/manifests'), { recursive: true });
  await writeFile(join(root, 'packages/cli/dist/bundle.js'), runtime);
  await writeFile(join(root, 'packages/adapter-opencode/dist/index.js'), adapter);
  await writeFile(join(root, 'build/manifests/DISTRIBUTION_NOTICE.md'), notice);
  const input = { schemaVersion: 1, platform: 'opencode', releaseVersion: '0.1.0',
    adapterVersion: '0.1.0', coreProtocolVersion: 1,
    protocolSource: { schemaVersion: 1, repository: 'https://example.invalid/protocol',
      version: '1.11.8', commit: 'b'.repeat(40), files: [{ path: 'VERSION', sha256: hash('1.11.8\n') }] },
    skills, runtimeBundle: { schemaVersion: 1, version: '0.1.0', path: 'packages/cli/dist/bundle.js',
      sha256: hash(runtime), source },
    adapterBundle: { schemaVersion: 1, version: '0.1.0', path: 'packages/adapter-opencode/dist/index.js',
      sha256: hash(adapter), source },
    metadata: { schemaVersion: 1, name: 'dev-harness', displayName: 'Dev Harness',
      description: 'Planning task runtime', author: 'Dev-Wiki', repository: source.repository,
      licenseRefs: [{ path: 'build/manifests/DISTRIBUTION_NOTICE.md', sha256: hash(notice) }] },
    buildTimestamp: '2020-01-02T03:04:06Z' };
  const packager = new OpenCodePackager(root);
  const generated = await packager.generate(input);
  const files = new Map();
  for (const file of generated.files) files.set(file.path, await readFile(join(root, generated.root, file.path)));
  return { root, input, packager, generated, files };
}

test('OpenCode npm and local variants have distinct native layouts and deterministic artifacts', async (t) => {
  const value = await fixture(t);
  assert.deepEqual(errors(await validateStatic(value.files, value.input, opencodeStaticSpec)), []);
  assert.equal((await value.packager.validate(value.generated, value.input)).valid, true);
  assert.equal(value.files.size, 19);
  assert.deepEqual(JSON.parse(value.files.get(manifestPath)).exports, { '.': './dist/index.js' });
  assert.match(value.files.get('local/.opencode/plugins/dev-harness.js').toString(), /export const DevHarnessPlugin/u);
  const first = await value.packager.pack(value.generated, value.input);
  const firstBytes = await Promise.all(first.map((artifact) => readFile(join(value.root, 'dist', artifact.file))));
  assert.deepEqual(first.map((artifact) => artifact.variant), ['npm', 'local']);
  assert.deepEqual(await value.packager.pack(value.generated, value.input), first);
  for (const [index, artifact] of first.entries()) {
    assert.deepEqual(await readFile(join(value.root, 'dist', artifact.file)), firstBytes[index]);
  }
  await compareGolden(new URL('golden/opencode.json', import.meta.url).pathname, {
    paths: value.generated.files.map((file) => file.path),
    artifacts: first.map((artifact) => ({ file: artifact.file, sha256: artifact.sha256 })),
  }, { update: process.env.DHR_UPDATE_GOLDEN === '1' });
});

test('OpenCode rejects missing, unsupported, unsafe, duplicate and inconsistent package content', async (t) => {
  const value = await fixture(t);
  const probe = async (change) => { const files = new Map(value.files); change(files);
    return errors(await validateStatic(files, value.input, opencodeStaticSpec)); };
  assert.ok((await probe((files) => files.delete('local/.opencode/plugins/dev-harness.js'))).includes('MISSING_REQUIRED_FILE'));
  assert.ok((await probe((files) => files.set(manifestPath, Buffer.from(JSON.stringify({
    ...JSON.parse(files.get(manifestPath)), unsupported: true,
  }))))).includes('UNSUPPORTED_MANIFEST_FIELD'));
  assert.ok((await probe((files) => files.set('local/README.md', Buffer.from('Use /home/worker/private\n')))).includes('ABSOLUTE_LOCAL_PATH'));
  assert.ok((await probe((files) => files.set(manifestPath, Buffer.from(JSON.stringify({
    ...JSON.parse(files.get(manifestPath)), version: '9.9.9',
  }))))).includes('VERSION_MISMATCH'));
  assert.ok((await probe((files) => files.set('npm/dist/dhr.js', Buffer.from('changed')))).includes('BUNDLE_DIGEST_MISMATCH'));
  assert.ok((await probe((files) => files.set('local/.opencode/skills/status/SKILL.md', Buffer.from(
    files.get('local/.opencode/skills/status/SKILL.md').toString().replace('name: status', 'name: run'))))).includes('DUPLICATE_SKILL_NAME'));
});

test('OpenCode variant entries and Skill copies must remain identical', async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.root, value.generated.root, 'local/.opencode/plugins/dev-harness.js'), 'export default 1;\n');
  let report = await value.packager.validate(value.generated, value.input);
  assert.ok(errors(report.checks).includes('OPENCODE_PLUGIN_ENTRY'));
  await writeFile(join(value.root, value.generated.root, 'npm/skills/run/SKILL.md'), 'different\n');
  report = await value.packager.validate(value.generated, value.input);
  assert.ok(errors(report.checks).includes('OPENCODE_SKILL_MISMATCH'));
});
