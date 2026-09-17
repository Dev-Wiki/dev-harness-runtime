import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BuildPipeline, PlatformRegistry } from '../../build/dist/targets/index.js';
import { canonicalJson } from '../../build/dist/manifests/input.js';
import { createZip } from '../../build/dist/manifests/archive.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const command = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'dhr-packaging-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'upstream');
  const repo = join(root, 'runtime');
  await mkdir(source); await mkdir(repo);
  for (const path of [source, repo]) {
    command(path, 'init', '-q');
    command(path, 'config', 'user.name', 'Test');
    command(path, 'config', 'user.email', 'test@example.invalid');
  }
  await writeFile(join(source, 'VERSION'), '1.11.8\n');
  command(source, 'add', '--', 'VERSION'); command(source, 'commit', '-qm', 'pin source');
  const protocolRepository = 'https://example.invalid/upstream';
  const protocolSource = { schemaVersion: 1, repository: protocolRepository, version: '1.11.8',
    commit: command(source, 'rev-parse', 'HEAD'), files: [{ path: 'VERSION', sha256: hash('1.11.8\n') }] };
  const sourceRepository = 'https://github.com/Dev-Wiki/dev-harness-runtime';
  await mkdir(join(repo, 'skills', 'run'), { recursive: true });
  const skill = '---\nname: run\ndescription: Execute one task\n---\n\n# Run\n';
  await writeFile(join(repo, 'skills/run/SKILL.md'), skill);
  await writeFile(join(repo, 'bundle.js'), 'export const value = 1;\n');
  await writeFile(join(repo, 'NOTICE'), 'Local packaging validation notice.\n');
  await writeFile(join(repo, 'package.json'), '{"name":"fixture","version":"0.1.0"}\n');
  await writeFile(join(repo, '.gitignore'), '.generated/\ndist/\n');
  await mkdir(join(repo, 'build/manifests'), { recursive: true });
  await writeFile(join(repo, 'build/manifests/metadata.json'), `${JSON.stringify({ schemaVersion: 1,
    name: 'dev-harness', displayName: 'Dev Harness', description: 'Fixture for packaging',
    author: 'Test', repository: 'https://github.com/Dev-Wiki/dev-harness-runtime',
    distribution: { external: false, reason: 'Fixture is never distributed' } })}\n`);
  await writeFile(join(repo, 'protocol-lock.json'), `${JSON.stringify({ schemaVersion: 1,
    repository: protocolSource.repository, commit: protocolSource.commit,
    protocolVersion: protocolSource.version, files: protocolSource.files })}\n`);
  command(repo, 'add', '--', '.'); command(repo, 'commit', '-qm', 'fixture');
  const sourceRecord = { schemaVersion: 1, repository: sourceRepository, version: '0.1.0',
    commit: command(repo, 'rev-parse', 'HEAD'), path: 'package.json' };
  const input = { schemaVersion: 1, platform: 'fixture', releaseVersion: '0.1.0', adapterVersion: '0.1.0',
    coreProtocolVersion: 1, protocolSource,
    skills: [{ schemaVersion: 1, name: 'run', path: 'skills/run/SKILL.md', sha256: hash(skill),
      source: { ...sourceRecord, path: 'skills/run/SKILL.md' } }],
    runtimeBundle: { schemaVersion: 1, version: '0.1.0', path: 'bundle.js', sha256: hash('export const value = 1;\n'), source: sourceRecord },
    adapterBundle: { schemaVersion: 1, version: '0.1.0', path: 'bundle.js', sha256: hash('export const value = 1;\n'), source: sourceRecord },
    metadata: { schemaVersion: 1, name: 'dev-harness', displayName: 'Dev Harness',
      description: 'Fixture for packaging', author: 'Test', repository: sourceRepository,
      licenseRefs: [{ path: 'NOTICE', sha256: hash('Local packaging validation notice.\n') }] },
    buildTimestamp: '2020-01-02T03:04:06Z' };
  const spec = { requiredFiles: ['plugin.json', 'skills/run/SKILL.md'],
    allowedFiles: ['plugin.json', 'skills/run/SKILL.md'], skillFiles: ['skills/run/SKILL.md'],
    manifests: [{ path: 'plugin.json', schema: { type: 'object', additionalProperties: false,
      required: ['name', 'version', 'entry'], properties: { name: { type: 'string' },
        version: { type: 'string' }, entry: { type: 'string' } } },
    versionFields: { version: 'releaseVersion' }, referenceFields: ['entry'] }] };
  const platforms = new PlatformRegistry();
  const inputHash = hash(canonicalJson(input));
  const pluginRoot = join(repo, '.generated', 'fixture', 'plugin');
  let calls = { generate: 0, validate: 0, pack: 0 };
  const packager = { id: 'fixture',
    async generate(buildInput) {
      calls.generate++;
      await mkdir(join(pluginRoot, 'skills', 'run'), { recursive: true });
      const manifest = `${JSON.stringify({ name: buildInput.metadata.name, version: buildInput.releaseVersion,
        entry: 'skills/run/SKILL.md' })}\n`;
      await writeFile(join(pluginRoot, 'plugin.json'), manifest);
      await writeFile(join(pluginRoot, 'skills/run/SKILL.md'), skill);
      return { schemaVersion: 1, platform: 'fixture', adapterVersion: '0.1.0',
        root: '.generated/fixture/plugin', inputHash,
        files: [{ path: 'plugin.json', sha256: hash(manifest) },
          { path: 'skills/run/SKILL.md', sha256: hash(skill) }] };
    },
    async validate() {
      calls.validate++;
      return { schemaVersion: 1, valid: true, inputHash,
        checks: [{ code: 'FIXTURE_OK', path: 'plugin.json', message: 'Fixture format accepted', severity: 'info' }],
        evidenceRefs: [{ schemaVersion: 1, path: '.generated/fixture/plugin/plugin.json', sha256: hash(await readFile(join(pluginRoot, 'plugin.json'))) }] };
    },
    async pack(_plugin, buildInput) {
      calls.pack++;
      const bytes = createZip(new Map([['plugin.json', await readFile(join(pluginRoot, 'plugin.json'))],
        ['skills/run/SKILL.md', await readFile(join(pluginRoot, 'skills/run/SKILL.md'))]]), buildInput.buildTimestamp);
      await mkdir(join(repo, 'dist', 'fixture'), { recursive: true });
      await writeFile(join(repo, 'dist/fixture/fixture.zip'), bytes);
      return [{ schemaVersion: 1, platform: 'fixture', variant: 'plugin', version: '0.1.0',
        coreProtocolVersion: 1, file: 'fixture/fixture.zip', mediaType: 'application/zip',
        size: bytes.byteLength, sha256: hash(bytes), inputHash }];
    } };
  platforms.register({ id: 'fixture', packager });
  const pipeline = new BuildPipeline({ root: repo, platforms, inputs: [input],
    specifications: { fixture: spec }, sourceRoots: { [protocolRepository]: source },
    targetVersions: { fixture: 'fixture-v1' } });
  return { root: repo, source, input, pipeline, calls, pluginRoot, packager };
}

test('locked input generates identical bytes twice and packs only an unchanged validated tree', async (t) => {
  const fixture = await project(t);
  const first = await fixture.pipeline.generate('fixture');
  const firstReceipt = await readFile(join(fixture.root, '.generated/fixture/generated.json'));
  const second = await fixture.pipeline.generate('fixture');
  const secondReceipt = await readFile(join(fixture.root, '.generated/fixture/generated.json'));
  assert.deepEqual(first, second); assert.deepEqual(firstReceipt, secondReceipt);
  await assert.rejects(fixture.pipeline.pack('fixture'), /validated before packing/u);
  const report = await fixture.pipeline.validate('fixture');
  assert.equal(report.valid, true);
  const artifacts = await fixture.pipeline.pack('fixture');
  const bytes = await readFile(join(fixture.root, 'dist', artifacts[0].file));
  assert.equal(hash(bytes), artifacts[0].sha256);
  const manifest = JSON.parse(await readFile(join(fixture.root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.artifacts, artifacts);
  assert.equal(manifest.adapterCompatibility[0].targetVersion, 'fixture-v1');
  assert.deepEqual(fixture.calls, { generate: 2, validate: 1, pack: 1 });
});

test('validation, pack and source checks refuse mutation without rerunning earlier stages', async (t) => {
  const fixture = await project(t);
  await fixture.pipeline.generate('fixture');
  await writeFile(join(fixture.pluginRoot, 'plugin.json'), '{"version":"9.9.9"}\n');
  await assert.rejects(fixture.pipeline.validate('fixture'), /generated tree changed/u);
  assert.equal(fixture.calls.validate, 0);
  await fixture.pipeline.generate('fixture');
  await fixture.pipeline.validate('fixture');
  await writeFile(join(fixture.pluginRoot, 'plugin.json'), 'corrupted\n');
  await assert.rejects(fixture.pipeline.pack('fixture'), /generated tree changed/u);
  assert.equal(fixture.calls.pack, 0);
  await writeFile(join(fixture.root, 'bundle.js'), 'changed\n');
  await assert.rejects(fixture.pipeline.generate('fixture'), /Bundle digest drift/u);
});

test('wrong locked protocol and missing platform capability stop before generator', async (t) => {
  const fixture = await project(t);
  await writeFile(join(fixture.root, 'protocol-lock.json'), '{}\n');
  await assert.rejects(fixture.pipeline.generate('fixture'), /Protocol source differs/u);
  assert.deepEqual(fixture.calls, { generate: 0, validate: 0, pack: 0 });
  await assert.rejects(fixture.pipeline.generate('missing'), /Unknown platform/u);
});

test('stage and manifest locks refuse overlapping operations without claiming success', async (t) => {
  const fixture = await project(t);
  const original = fixture.packager.generate;
  let begin;
  const entered = new Promise((resolve) => { begin = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fixture.packager.generate = async (input) => { begin(); await gate; return original(input); };
  const first = fixture.pipeline.generate('fixture');
  await entered;
  await assert.rejects(fixture.pipeline.generate('fixture'), /active or unresolved build stage/u);
  release(); await first;
  await fixture.pipeline.validate('fixture');
  await writeFile(join(fixture.root, '.generated/.manifest.lock'), 'unresolved\n');
  await assert.rejects(fixture.pipeline.pack('fixture'), /Another platform is packing/u);
  await rm(join(fixture.root, '.generated/.manifest.lock'));
  assert.equal((await fixture.pipeline.pack('fixture')).length, 1);
});

test('source changes inside trusted callbacks never produce a validated or published claim', async (t) => {
  const fixture = await project(t);
  const originalGenerate = fixture.packager.generate;
  fixture.packager.generate = async (...args) => {
    const result = await originalGenerate(...args);
    await writeFile(join(fixture.root, 'bundle.js'), 'changed during generation\n');
    return result;
  };
  await assert.rejects(fixture.pipeline.generate('fixture'), /Bundle digest drift/u);
  await assert.rejects(readFile(join(fixture.root, '.generated/fixture/generated.json')), { code: 'ENOENT' });
  await writeFile(join(fixture.root, 'bundle.js'), 'export const value = 1;\n');
  fixture.packager.generate = originalGenerate;
  await fixture.pipeline.generate('fixture');
  const originalValidate = fixture.packager.validate;
  fixture.packager.validate = async (...args) => {
    const result = await originalValidate(...args);
    await writeFile(join(fixture.root, 'bundle.js'), 'changed during validation\n');
    return result;
  };
  await assert.rejects(fixture.pipeline.validate('fixture'), /Bundle digest drift/u);
  await assert.rejects(readFile(join(fixture.root, '.generated/fixture/validation.json')), { code: 'ENOENT' });
  await writeFile(join(fixture.root, 'bundle.js'), 'export const value = 1;\n');
  fixture.packager.validate = originalValidate;
  await fixture.pipeline.validate('fixture');
  const originalPack = fixture.packager.pack;
  fixture.packager.pack = async (...args) => {
    const result = await originalPack(...args);
    await writeFile(join(fixture.root, 'bundle.js'), 'changed during packing\n');
    return result;
  };
  await assert.rejects(fixture.pipeline.pack('fixture'), /Bundle digest drift/u);
  await assert.rejects(readFile(join(fixture.root, 'dist/manifest.json')), { code: 'ENOENT' });
});
