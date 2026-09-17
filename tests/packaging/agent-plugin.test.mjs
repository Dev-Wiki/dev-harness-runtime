import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentPluginPackager, agentPluginStaticSpec } from '../../build/dist/targets/agent-plugin.js';
import { compareGolden } from '../../build/dist/manifests/golden.js';
import { validateStatic } from '../../build/dist/validators/static.js';
import { runCli } from '../../packages/cli/dist/index.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const errors = (checks) => checks.filter((entry) => entry.severity === 'error').map((entry) => entry.code);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dhr-portable-packaging-'));
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
  const notice = Buffer.from('Local package only.\n');
  const bundle = Buffer.from('export const packager = true;\n');
  await mkdir(join(root, 'build/manifests'), { recursive: true });
  await mkdir(join(root, 'build/dist/targets'), { recursive: true });
  await mkdir(join(root, 'packages/cli/dist'), { recursive: true });
  await writeFile(join(root, 'build/manifests/DISTRIBUTION_NOTICE.md'), notice);
  await writeFile(join(root, 'build/dist/targets/agent-plugin.js'), bundle);
  await writeFile(join(root, 'packages/cli/dist/bundle.js'), bundle);
  const input = { schemaVersion: 1, platform: 'agent-plugin', releaseVersion: '0.1.0',
    adapterVersion: '0.1.0', coreProtocolVersion: 1,
    protocolSource: { schemaVersion: 1, repository: 'https://example.invalid/protocol',
      version: '1.11.8', commit: 'b'.repeat(40), files: [{ path: 'VERSION', sha256: hash('1.11.8\n') }] },
    skills, runtimeBundle: { schemaVersion: 1, version: '0.1.0', path: 'packages/cli/dist/bundle.js',
      sha256: hash(bundle), source },
    adapterBundle: { schemaVersion: 1, version: '0.1.0', path: 'build/dist/targets/agent-plugin.js',
      sha256: hash(bundle), source },
    metadata: { schemaVersion: 1, name: 'dev-harness', displayName: 'Dev Harness',
      description: 'Planning task runtime', author: 'Dev-Wiki', repository: source.repository,
      licenseRefs: [{ path: 'build/manifests/DISTRIBUTION_NOTICE.md', sha256: hash(notice) }] },
    buildTimestamp: '2020-01-02T03:04:06Z' };
  const packager = new AgentPluginPackager(root);
  const generated = await packager.generate(input);
  const files = new Map();
  for (const file of generated.files) files.set(file.path, await readFile(join(root, generated.root, file.path)));
  return { root, input, packager, generated, files };
}

test('Portable Agent Plugin has three Skills, no Executor bundle and a stable ZIP', async (t) => {
  const value = await fixture(t);
  assert.deepEqual(errors(await validateStatic(value.files, value.input, agentPluginStaticSpec)), []);
  assert.equal((await value.packager.validate(value.generated, value.input)).valid, true);
  assert.equal(value.files.size, 6);
  assert.deepEqual(Object.keys(JSON.parse(value.files.get('plugin.json'))),
    ['$schema', 'author', 'description', 'name', 'repository', 'version']);
  assert.ok(!value.generated.files.some((file) => file.path.includes('runtime/') || file.path.includes('adapter')));
  const first = (await value.packager.pack(value.generated, value.input))[0];
  const bytes = await readFile(join(value.root, 'dist', first.file));
  assert.deepEqual((await value.packager.pack(value.generated, value.input))[0], first);
  assert.deepEqual(await readFile(join(value.root, 'dist', first.file)), bytes);
  await compareGolden(new URL('golden/agent-plugin.json', import.meta.url).pathname, {
    paths: value.generated.files.map((file) => file.path), artifact: { file: first.file, sha256: first.sha256 },
  }, { update: process.env.DHR_UPDATE_GOLDEN === '1' });
});

test('Portable manifest, paths, Skills and version fail closed', async (t) => {
  const value = await fixture(t);
  const probe = async (change) => { const files = new Map(value.files); change(files);
    return errors(await validateStatic(files, value.input, agentPluginStaticSpec)); };
  assert.ok((await probe((files) => files.delete('plugin.json'))).includes('MISSING_REQUIRED_FILE'));
  assert.ok((await probe((files) => files.set('plugin.json', Buffer.from(JSON.stringify({
    ...JSON.parse(files.get('plugin.json')), unsupported: true,
  }))))).includes('UNSUPPORTED_MANIFEST_FIELD'));
  assert.ok((await probe((files) => files.set('README.md', Buffer.from('Use /home/worker/private\n')))).includes('ABSOLUTE_LOCAL_PATH'));
  assert.ok((await probe((files) => files.set('plugin.json', Buffer.from(JSON.stringify({
    ...JSON.parse(files.get('plugin.json')), version: '9.9.9',
  }))))).includes('VERSION_MISMATCH'));
  assert.ok((await probe((files) => files.set('skills/status/SKILL.md', Buffer.from(
    files.get('skills/status/SKILL.md').toString().replace('name: status', 'name: run'))))).includes('DUPLICATE_SKILL_NAME'));
});

test('Portable instructions require an available Executor before automatic run', async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.root, value.generated.root, 'README.md'), 'No guard.\n');
  const report = await value.packager.validate(value.generated, value.input);
  assert.ok(errors(report.checks).includes('EXECUTOR_GUARD'));
});

test('Portable platform ID cannot start a Task without a trusted Executor', async () => {
  const output = { text: '', out(value) { this.text += value; }, error(value) { this.text += value; } };
  const exit = await runCli(['run', '--adapter', 'agent-plugin', '--task', 'K1'], output);
  assert.notEqual(exit, 0);
  assert.match(output.text, /CAPABILITY_MISSING/u);
});
