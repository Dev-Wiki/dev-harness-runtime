import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DshPackager, dshStaticSpec, dshHostDependencies } from '../../build/dist/targets/dsh.js';
import { compareGolden } from '../../build/dist/manifests/golden.js';
import { validateStatic } from '../../build/dist/validators/static.js';
import { apply, inject, name } from '../../packages/adapter-dsh/dist/plugin.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const errors = (checks) => checks.filter((entry) => entry.severity === 'error').map((entry) => entry.code);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dhr-dsh-packaging-'));
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
  const adapter = Buffer.from('export function apply() {}\n');
  const notice = Buffer.from('Local package only.\n');
  await mkdir(join(root, 'packages/cli/dist'), { recursive: true });
  await mkdir(join(root, 'packages/adapter-dsh/dist'), { recursive: true });
  await mkdir(join(root, 'build/manifests'), { recursive: true });
  await writeFile(join(root, 'packages/cli/dist/bundle.js'), runtime);
  await writeFile(join(root, 'packages/adapter-dsh/dist/plugin.js'), adapter);
  await writeFile(join(root, 'build/manifests/DISTRIBUTION_NOTICE.md'), notice);
  const input = { schemaVersion: 1, platform: 'dsh', releaseVersion: '0.1.0',
    adapterVersion: '0.1.0', coreProtocolVersion: 1,
    protocolSource: { schemaVersion: 1, repository: 'https://example.invalid/protocol',
      version: '1.11.8', commit: 'b'.repeat(40), files: [{ path: 'VERSION', sha256: hash('1.11.8\n') }] },
    skills, runtimeBundle: { schemaVersion: 1, version: '0.1.0', path: 'packages/cli/dist/bundle.js',
      sha256: hash(runtime), source },
    adapterBundle: { schemaVersion: 1, version: '0.1.0', path: 'packages/adapter-dsh/dist/plugin.js',
      sha256: hash(adapter), source },
    metadata: { schemaVersion: 1, name: 'dev-harness', displayName: 'Dev Harness',
      description: 'Planning task runtime', author: 'Dev-Wiki', repository: source.repository,
      licenseRefs: [{ path: 'build/manifests/DISTRIBUTION_NOTICE.md', sha256: hash(notice) }] },
    buildTimestamp: '2020-01-02T03:04:06Z' };
  const packager = new DshPackager(root);
  const generated = await packager.generate(input);
  const files = new Map();
  for (const file of generated.files) files.set(file.path, await readFile(join(root, generated.root, file.path)));
  return { root, input, packager, generated, files };
}

test('DSH rc.1 bundle is locked to actual rc.2 components and packs a stable tgz', async (t) => {
  const value = await fixture(t);
  assert.deepEqual(errors(await validateStatic(value.files, value.input, dshStaticSpec)), []);
  assert.equal((await value.packager.validate(value.generated, value.input)).valid, true);
  const manifest = JSON.parse(value.files.get('package.json'));
  assert.deepEqual(manifest.peerDependencies, dshHostDependencies);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  const first = (await value.packager.pack(value.generated, value.input))[0];
  const bytes = await readFile(join(value.root, 'dist', first.file));
  assert.deepEqual((await value.packager.pack(value.generated, value.input))[0], first);
  assert.deepEqual(await readFile(join(value.root, 'dist', first.file)), bytes);
  await compareGolden(new URL('golden/dsh.json', import.meta.url).pathname, {
    paths: value.generated.files.map((file) => file.path), artifact: { file: first.file, sha256: first.sha256 },
  }, { update: process.env.DHR_UPDATE_GOLDEN === '1' });
});

test('DSH manifest, Cordis patch, paths, Skill identity and source-locked bundle fail closed', async (t) => {
  const value = await fixture(t);
  const probe = async (change) => { const files = new Map(value.files); change(files);
    return errors(await validateStatic(files, value.input, dshStaticSpec)); };
  assert.ok((await probe((files) => files.delete('cordis.patch.yml'))).includes('MISSING_REQUIRED_FILE'));
  assert.ok((await probe((files) => files.set('package.json', Buffer.from(JSON.stringify({
    ...JSON.parse(files.get('package.json')), unsupported: true,
  }))))).includes('UNSUPPORTED_MANIFEST_FIELD'));
  assert.ok((await probe((files) => files.set('README.md', Buffer.from('Local path /home/worker/private\n')))).includes('ABSOLUTE_LOCAL_PATH'));
  assert.ok((await probe((files) => files.set('package.json', Buffer.from(JSON.stringify({
    ...JSON.parse(files.get('package.json')), version: '9.9.9',
  }))))).includes('VERSION_MISMATCH'));
  assert.ok((await probe((files) => files.set('package.json', Buffer.from(JSON.stringify({
    ...JSON.parse(files.get('package.json')), files: ['lib'],
  }))))).includes('INVALID_MANIFEST'));
  assert.ok((await probe((files) => files.set('lib/index.js', Buffer.from('changed')))).includes('BUNDLE_DIGEST_MISMATCH'));
  assert.ok((await probe((files) => files.set('skills/status/SKILL.md', Buffer.from(
    files.get('skills/status/SKILL.md').toString().replace('name: status', 'name: run'))))).includes('DUPLICATE_SKILL_NAME'));
  await writeFile(join(value.root, value.generated.root, 'cordis.patch.yml'), '- insert:\n    - id: wrong\n      name: wrong\n');
  assert.ok(errors((await value.packager.validate(value.generated, value.input)).checks).includes('DSH_PATCH'));
});

test('DSH Cordis plugin registers a read-only status command and Worker tool guard, then disposes both', () => {
  assert.equal(name, 'dev-harness-runtime');
  assert.deepEqual(inject, ['commands', 'tools']);
  let command;
  let guard;
  const disposed = [];
  const effects = [];
  const ctx = { commands: { register(definition) { command = definition; return () => disposed.push('command'); } },
    tools: { guard(check) { guard = check; return () => disposed.push('guard'); } },
    effect(register, label) { effects.push({ label, dispose: register() }); } };
  apply(ctx);
  assert.equal(command.name, 'dhr-status');
  assert.equal(command.handler().kind, 'success');
  assert.match(command.handler().text, /Executor is not enabled/u);
  assert.equal(typeof guard, 'function');
  assert.deepEqual(effects.map(({ label }) => label), ['dev-harness-runtime: worker tool gate', 'dev-harness-runtime: dhr-status']);
  for (const { dispose } of effects) dispose();
  assert.deepEqual(disposed, ['guard', 'command']);
});
