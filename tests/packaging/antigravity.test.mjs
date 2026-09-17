import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AntigravityPackager, antigravityStaticSpec } from '../../build/dist/targets/antigravity.js';
import { compareGolden } from '../../build/dist/manifests/golden.js';
import { validateStatic } from '../../build/dist/validators/static.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const errors = (checks) => checks.filter((entry) => entry.severity === 'error').map((entry) => entry.code);
const manifestPath = 'plugin/plugin.json';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dhr-antigravity-packaging-'));
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
  const adapter = Buffer.from('export const adapter = { id: "antigravity" };\n');
  const notice = Buffer.from('Local package only.\n');
  await mkdir(join(root, 'packages/cli/dist'), { recursive: true });
  await mkdir(join(root, 'packages/adapter-antigravity/dist'), { recursive: true });
  await mkdir(join(root, 'build/manifests'), { recursive: true });
  await writeFile(join(root, 'packages/cli/dist/bundle.js'), runtime);
  await writeFile(join(root, 'packages/adapter-antigravity/dist/index.js'), adapter);
  await writeFile(join(root, 'build/manifests/DISTRIBUTION_NOTICE.md'), notice);
  const input = { schemaVersion: 1, platform: 'antigravity', releaseVersion: '0.1.0',
    adapterVersion: '0.1.0', coreProtocolVersion: 1,
    protocolSource: { schemaVersion: 1, repository: 'https://example.invalid/protocol',
      version: '1.11.8', commit: 'b'.repeat(40), files: [{ path: 'VERSION', sha256: hash('1.11.8\n') }] },
    skills, runtimeBundle: { schemaVersion: 1, version: '0.1.0', path: 'packages/cli/dist/bundle.js',
      sha256: hash(runtime), source },
    adapterBundle: { schemaVersion: 1, version: '0.1.0', path: 'packages/adapter-antigravity/dist/index.js',
      sha256: hash(adapter), source },
    metadata: { schemaVersion: 1, name: 'dev-harness', displayName: 'Dev Harness',
      description: 'Planning task runtime', author: 'Dev-Wiki', repository: source.repository,
      licenseRefs: [{ path: 'build/manifests/DISTRIBUTION_NOTICE.md', sha256: hash(notice) }] },
    buildTimestamp: '2020-01-02T03:04:06Z' };
  const packager = new AntigravityPackager(root);
  const generated = await packager.generate(input);
  const files = new Map();
  for (const file of generated.files) files.set(file.path, await readFile(join(root, generated.root, file.path)));
  return { root, input, packager, generated, files };
}

test('Antigravity Plugin, project Skills and global Skills have stable independent ZIPs', async (t) => {
  const value = await fixture(t);
  assert.deepEqual(errors(await validateStatic(value.files, value.input, antigravityStaticSpec)), []);
  assert.equal((await value.packager.validate(value.generated, value.input)).valid, true);
  const manifest = JSON.parse(value.files.get(manifestPath));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(value.files.size, 18);
  const first = await value.packager.pack(value.generated, value.input);
  const firstBytes = await Promise.all(first.map((artifact) => readFile(join(value.root, 'dist', artifact.file))));
  assert.deepEqual(first.map((artifact) => artifact.variant), ['agent-plugin', 'project-skills', 'global-skills']);
  assert.deepEqual(await value.packager.pack(value.generated, value.input), first);
  for (const [index, artifact] of first.entries()) {
    assert.deepEqual(await readFile(join(value.root, 'dist', artifact.file)), firstBytes[index]);
  }
  await compareGolden(new URL('golden/antigravity.json', import.meta.url).pathname, {
    paths: value.generated.files.map((file) => file.path),
    artifacts: first.map((artifact) => ({ file: artifact.file, sha256: artifact.sha256 })),
  }, { update: process.env.DHR_UPDATE_GOLDEN === '1' });
});

test('Antigravity rejects missing, unsupported, unsafe, duplicate and mismatched content', async (t) => {
  const value = await fixture(t);
  const probe = async (change) => { const files = new Map(value.files); change(files);
    return errors(await validateStatic(files, value.input, antigravityStaticSpec)); };
  assert.ok((await probe((files) => files.delete(manifestPath))).includes('MISSING_REQUIRED_FILE'));
  assert.ok((await probe((files) => files.set(manifestPath, Buffer.from(JSON.stringify({
    ...JSON.parse(files.get(manifestPath)), unsupported: true,
  }))))).includes('UNSUPPORTED_MANIFEST_FIELD'));
  assert.ok((await probe((files) => files.set('plugin/README.md', Buffer.from('Use /home/worker/private\n')))).includes('ABSOLUTE_LOCAL_PATH'));
  assert.ok((await probe((files) => files.set(manifestPath, Buffer.from(JSON.stringify({
    ...JSON.parse(files.get(manifestPath)), version: '9.9.9',
  }))))).includes('VERSION_MISMATCH'));
  assert.ok((await probe((files) => files.set('plugin/runtime/dhr.js', Buffer.from('changed')))).includes('BUNDLE_DIGEST_MISMATCH'));
  assert.ok((await probe((files) => files.set('plugin/skills/status/SKILL.md', Buffer.from(
    files.get('plugin/skills/status/SKILL.md').toString().replace('name: status', 'name: run'))))).includes('DUPLICATE_SKILL_NAME'));
});

test('Antigravity standalone Skills remain exact copies of the Plugin Skills', async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.root, value.generated.root, 'project-skills/.agents/skills/run/SKILL.md'), 'changed\n');
  const report = await value.packager.validate(value.generated, value.input);
  assert.ok(errors(report.checks).includes('ANTIGRAVITY_SKILL_MISMATCH'));
});
