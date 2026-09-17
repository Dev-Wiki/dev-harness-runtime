import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateStatic } from '../../build/dist/validators/static.js';

async function fixture() {
  const input = JSON.parse(await readFile(new URL('../../packages/contracts/fixtures/packaging/pluginBuildInput.json', import.meta.url), 'utf8'));
  const manifest = { version: input.releaseVersion, adapter: { version: input.adapterVersion }, protocol: input.coreProtocolVersion,
    main: 'runtime.js', skills: ['skills/run/SKILL.md'], homepage: 'https://example.com/docs/runtime' };
  const schema = { type: 'object', additionalProperties: false, required: ['version', 'adapter', 'protocol', 'main', 'skills'], properties: {
    version: { type: 'string' }, adapter: { type: 'object', additionalProperties: false, required: ['version'], properties: { version: { type: 'string' } } },
    protocol: { type: 'integer' }, main: { type: 'string' }, skills: { type: 'array', items: { type: 'string' } }, homepage: { type: 'string' },
  } };
  const files = new Map([
    ['manifest.json', Buffer.from(JSON.stringify(manifest))],
    ['runtime.js', Buffer.from('export const start = () => "ready";\n')],
    ['skills/run/SKILL.md', Buffer.from('---\nname: run\ndescription: Run one requested task through the controlled runtime.\n---\n# Run\nUse dhr run --task A --no-commit.\n')],
  ]);
  const spec = { requiredFiles: [...files.keys()], allowedFiles: [...files.keys()], skillFiles: ['skills/run/SKILL.md'], manifests: [{ path: 'manifest.json', schema,
    versionFields: { version: 'releaseVersion', 'adapter.version': 'adapterVersion', protocol: 'coreProtocolVersion' }, referenceFields: ['main', 'skills'] }] };
  return { input, files, spec, manifest, schema };
}
const run = (f) => validateStatic(f.files, f.input, f.spec);
const errors = (checks) => checks.filter((entry) => entry.severity === 'error');
const expectCode = async (f, code) => assert.ok((await run(f)).some((entry) => entry.code === code && entry.severity === 'error'), `Missing ${code}`);
function manifest(f, mutate) { mutate(f.manifest); f.files.set('manifest.json', Buffer.from(JSON.stringify(f.manifest))); }

test('closed manifests, exact files, scalar Skills and bound versions pass all static categories', async () => {
  const result = await run(await fixture()); assert.deepEqual(errors(result), []); assert.equal(result.at(-1).code, 'STATIC_VALIDATION_PASSED');
});

test('missing specifications, manifests, Skills and version bindings fail rather than vacuously passing', async () => {
  for (const key of ['requiredFiles', 'allowedFiles', 'manifests', 'skillFiles']) {
    const f = await fixture(); f.spec[key] = []; await expectCode(f, 'INVALID_STATIC_SPEC');
  }
  const f = await fixture(); delete f.spec.manifests[0].versionFields; await expectCode(f, 'VERSION_BINDING_MISSING');
  assert.ok(errors(await validateStatic(f.files, f.input, undefined)).length);
});

test('malformed manifest and missing schema-required fields fail', async () => {
  const bad = await fixture(); bad.files.set('manifest.json', Buffer.from('{')); await expectCode(bad, 'INVALID_MANIFEST');
  const missing = await fixture(); manifest(missing, (value) => { delete value.main; }); await expectCode(missing, 'INVALID_MANIFEST');
});

test('open root, open nested objects and unconstrained schema properties fail before manifest validation', async () => {
  for (const mutate of [
    (schema) => { delete schema.additionalProperties; },
    (schema) => { delete schema.properties.adapter.additionalProperties; },
    (schema) => { schema.properties.extra = {}; },
    (schema) => { schema.properties.extra = true; },
  ]) { const f = await fixture(); mutate(f.schema); await expectCode(f, 'OPEN_MANIFEST_SCHEMA'); }
  const f = await fixture(); f.schema.unknownSchemaKeyword = true; await expectCode(f, 'INVALID_MANIFEST_SCHEMA');
});

test('unknown fields at root and in nested objects are rejected without stripping input', async () => {
  const f = await fixture(); manifest(f, (value) => { value.unknown = true; value.adapter.unknown = true; });
  const results = await run(f); assert.equal(results.filter((entry) => entry.code === 'UNSUPPORTED_MANIFEST_FIELD').length, 2);
  assert.equal(f.manifest.unknown, true); assert.equal(f.manifest.adapter.unknown, true);
});

test('required and unexpected package contents are distinct errors', async () => {
  const f = await fixture(); f.files.delete('runtime.js'); await expectCode(f, 'MISSING_REQUIRED_FILE');
  f.files.set('secret.txt', Buffer.from('not declared')); await expectCode(f, 'UNEXPECTED_PACKAGE_CONTENT');
  f.spec.allowedFiles = f.spec.allowedFiles.filter((path) => path !== 'manifest.json'); await expectCode(f, 'INVALID_STATIC_SPEC');
});

test('absolute, parent-traversing and case-alias package paths cannot become valid report paths', async () => {
  for (const path of ['/tmp/leak.txt', '../leak.txt', 'C:\\work\\leak.txt']) {
    const f = await fixture(); f.files.set(path, Buffer.from('x')); const result = await run(f);
    assert.ok(result.some((entry) => entry.code === 'INVALID_RELATIVE_PATH' && entry.path === 'manifest.json'));
  }
  const f = await fixture(); f.files.set('Runtime.js', Buffer.from('x')); f.spec.allowedFiles.push('Runtime.js'); await expectCode(f, 'CASE_ALIAS_PATH');
});

test('manifest file references must resolve exact relative filenames including nested dot fields', async () => {
  for (const target of ['../runtime.js', '/tmp/runtime.js', 'https://example.com/runtime.js']) {
    const f = await fixture(); manifest(f, (value) => { value.main = target; }); await expectCode(f, 'INVALID_RELATIVE_PATH');
  }
  for (const target of ['missing.js', 'Runtime.js']) {
    const f = await fixture(); manifest(f, (value) => { value.main = target; }); await expectCode(f, 'MISSING_MANIFEST_REFERENCE');
  }
  const f = await fixture(); manifest(f, (value) => { value.skills = []; }); await expectCode(f, 'INVALID_MANIFEST_REFERENCE');
});

test('release, adapter and protocol version fields are bound separately without coercion', async () => {
  for (const mutate of [(value) => { value.version = '9.9.9'; }, (value) => { value.adapter.version = '9.9.9'; }, (value) => { value.protocol = '1'; }]) {
    const f = await fixture(); manifest(f, mutate); await expectCode(f, 'VERSION_MISMATCH');
  }
});

test('malformed, missing, dynamic YAML and invalid scalar Skill frontmatter fail', async () => {
  for (const front of [
    'name: run\n', 'name: Bad_Name\ndescription: text\n', 'name: run\ndescription: ""\n',
    'name: run\ndescription: &anchor text\n', 'name: run\ndescription: *anchor\n',
    'name: run\ndescription: >\n  folded\n', 'name: run\ndescription: [array]\n',
    'name: run\nname: twice\ndescription: text\n', 'name: run\ndescription: !!str text\n',
  ]) { const f = await fixture(); f.files.set('skills/run/SKILL.md', Buffer.from(`---\n${front}---\n`)); await expectCode(f, 'INVALID_SKILL_FRONTMATTER'); }
  const f = await fixture(); f.files.set('skills/run/SKILL.md', Buffer.from('# Missing frontmatter')); await expectCode(f, 'INVALID_SKILL_FRONTMATTER');
});

test('duplicate Skill names are rejected even with distinct valid file paths', async () => {
  const f = await fixture(); const path = 'skills/other/SKILL.md'; f.files.set(path, f.files.get('skills/run/SKILL.md'));
  f.spec.allowedFiles.push(path); f.spec.skillFiles.push(path); await expectCode(f, 'DUPLICATE_SKILL_NAME');
});

test('placeholder and concrete local path checks also inspect compiled bundle text', async () => {
  for (const marker of ['TODO', 'TBD', 'FIXME']) {
    const f = await fixture(); f.files.set('runtime.js', Buffer.from(`export const pending = "${marker}";`)); await expectCode(f, 'UNFINISHED_PLACEHOLDER');
  }
  for (const path of ['/home/user/project', '/tmp/work', '/workspace/project', 'C:\\Users\\name\\repo', '\\\\server\\share\\repo']) {
    const f = await fixture(); f.files.set('runtime.js', Buffer.from(`export const local = ${JSON.stringify(path)};`)); await expectCode(f, 'ABSOLUTE_LOCAL_PATH');
  }
});

test('URLs, relative CLI examples and documented Git-derived paths are not local path literals', async () => {
  const f = await fixture(); f.files.set('runtime.js', Buffer.from('export const documentation = "https://example.com/api/v1";'));
  f.files.set('skills/run/SKILL.md', Buffer.from('---\nname: run\ndescription: "Run the explicitly selected task."\n---\n'
    + 'Use `dhr run --task A --no-commit` and `node ./runtime.js`.\n'
    + 'State is `$(git rev-parse --git-path dev-harness-runtime)/runs/<run-id>/run.json`.\n'
    + '[Manual](https://example.com/docs/runtime)\n'));
  assert.deepEqual(errors(await run(f)), []);
});

test('invalid UTF-8 in required manifest or Skill is an error, not an omitted check', async () => {
  for (const path of ['manifest.json', 'skills/run/SKILL.md']) {
    const f = await fixture(); f.files.set(path, new Uint8Array([0xff, 0xfe])); await expectCode(f, 'INVALID_TEXT_ENCODING');
  }
});

test('JSON escaping cannot hide a local path or placeholder in a manifest string', async () => {
  const f = await fixture();
  f.files.set('manifest.json', Buffer.from(JSON.stringify(f.manifest).replace('https://example.com/docs/runtime', '\\u002fhome/user/private')));
  await expectCode(f, 'ABSOLUTE_LOCAL_PATH');
  f.files.set('manifest.json', Buffer.from(JSON.stringify(f.manifest).replace('https://example.com/docs/runtime', '\\u0054ODO')));
  await expectCode(f, 'UNFINISHED_PLACEHOLDER');
});
