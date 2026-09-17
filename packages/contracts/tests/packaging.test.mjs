import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ContractValidationError, parseContract } from '../dist/index.js';

const names = [
  'pluginBuildInput', 'generatedPlugin', 'validationReport', 'artifact',
  'releaseManifest', 'hostEnvironment', 'adapterDoctorResult',
];
const fixtures = Object.fromEntries(await Promise.all(names.map(async (name) => [
  name, JSON.parse(await readFile(new URL(`../fixtures/packaging/${name}.json`, import.meta.url), 'utf8')),
])));

const reject = (name, change) => {
  const value = structuredClone(fixtures[name]);
  change(value);
  assert.throws(() => parseContract(name, value), ContractValidationError);
};

for (const name of names) {
  test(`${name}: accepts complete fixture and preserves its data`, () => {
    assert.deepEqual(parseContract(name, fixtures[name]), fixtures[name]);
  });
  test(`${name}: rejects missing, unsupported and coerced schema versions`, () => {
    reject(name, (value) => { delete value.schemaVersion; });
    reject(name, (value) => { value.schemaVersion = 2; });
    reject(name, (value) => { value.schemaVersion = '1'; });
  });
  test(`${name}: rejects unknown fields`, () => {
    reject(name, (value) => { value.unrecognized = true; });
  });
}

test('build input requires provenance, license declarations and complete metadata', () => {
  reject('pluginBuildInput', (value) => { delete value.runtimeBundle.source; });
  reject('pluginBuildInput', (value) => { delete value.skills[0].sha256; });
  reject('pluginBuildInput', (value) => { delete value.metadata.author; });
  reject('pluginBuildInput', (value) => { value.metadata.licenseRefs = []; });
  reject('pluginBuildInput', (value) => { value.skills[0].source.schemaVersion = 2; });
  reject('pluginBuildInput', (value) => { value.metadata.license = 'unknown field'; });
  reject('pluginBuildInput', (value) => { value.runtimeBundle.source.extra = true; });
  for (const marker of ['TODO', 'TBD', '{{author}}', '<description>']) {
    reject('pluginBuildInput', (value) => { value.metadata.description = marker; });
  }
});

test('packaging rejects traversal and local absolute paths in portable file references', () => {
  for (const path of ['../secret', 'files/../../secret', '/tmp/local', 'C:\\local\\secret', 'files\\secret', 'files/./secret', 'files/secret\0']) {
    reject('pluginBuildInput', (value) => { value.skills[0].path = path; });
    reject('generatedPlugin', (value) => { value.root = path; });
    reject('generatedPlugin', (value) => { value.files[0].path = path; });
    reject('artifact', (value) => { value.file = path; });
    reject('validationReport', (value) => { value.evidenceRefs[0].path = path; });
  }
});

test('duplicate Skills are rejected by name and by source path', () => {
  reject('pluginBuildInput', (value) => {
    value.skills.push({ ...value.skills[0], path: 'skills/other/SKILL.md' });
  });
  reject('pluginBuildInput', (value) => {
    value.skills.push({ ...value.skills[0], name: 'other' });
  });
  reject('pluginBuildInput', (value) => {
    value.skills.push({ ...value.skills[0], name: 'other', path: 'SKILLS/PLANNING/SKILL.md' });
  });
});

test('bundle versions must match their release, adapter and source', () => {
  reject('pluginBuildInput', (value) => { value.runtimeBundle.version = '0.2.0'; });
  reject('pluginBuildInput', (value) => { value.adapterVersion = '0.2.0'; });
  reject('pluginBuildInput', (value) => { value.runtimeBundle.source.version = '0.2.0'; });
  reject('pluginBuildInput', (value) => { value.releaseVersion = 'unfinished'; });
  reject('pluginBuildInput', (value) => { value.coreProtocolVersion = 2; });
});

test('generated files must have unique portable names and valid digests', () => {
  reject('generatedPlugin', (value) => { value.files.push({ ...value.files[0] }); });
  reject('generatedPlugin', (value) => { value.files.push({ ...value.files[0], path: 'PACKAGE.JSON' }); });
  reject('generatedPlugin', (value) => { value.files[0].sha256 = 'a'.repeat(63); });
});

test('validation reports cannot declare success with errors or failure without errors', () => {
  reject('validationReport', (value) => { value.checks[0].severity = 'error'; });
  reject('validationReport', (value) => { value.valid = false; });
  const failure = structuredClone(fixtures.validationReport);
  failure.valid = false;
  failure.checks[0].severity = 'error';
  assert.deepEqual(parseContract('validationReport', failure), failure);
});

test('release manifest binds artifacts to release versions and adapter declarations', () => {
  reject('releaseManifest', (value) => { value.artifacts[0].version = '0.2.0'; });
  reject('releaseManifest', (value) => { value.artifacts[0].platform = 'codex'; });
  reject('releaseManifest', (value) => { value.artifacts[0].coreProtocolVersion = 2; });
  reject('releaseManifest', (value) => { value.artifacts.push({ ...value.artifacts[0] }); });
  reject('releaseManifest', (value) => { value.adapterCompatibility.push({ ...value.adapterCompatibility[0] }); });
});

test('multiple variants of one adapter are allowed when their files are distinct', () => {
  const value = structuredClone(fixtures.releaseManifest);
  value.artifacts.push({ ...value.artifacts[0], variant: 'local', file: 'artifacts/opencode-local.zip', mediaType: 'application/zip' });
  assert.deepEqual(parseContract('releaseManifest', value), value);
});

test('artifact size is a nonnegative safe integer and requires an input digest', () => {
  for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    reject('artifact', (value) => { value.size = size; });
  }
  reject('artifact', (value) => { delete value.inputHash; });
});

test('host environment excludes environment dumps and credentials', () => {
  reject('hostEnvironment', (value) => { value.env = { API_TOKEN: 'fixture-placeholder' }; });
  reject('hostEnvironment', (value) => { value.credential = 'fixture-placeholder'; });
  reject('hostEnvironment', (value) => { value.repoRoot = 'project'; });
  reject('hostEnvironment', (value) => { value.configHash = 'unknown'; });
});

test('doctor cannot claim availability with missing prerequisites or absent evidence', () => {
  reject('adapterDoctorResult', (value) => { value.available = true; });
  const value = structuredClone(fixtures.adapterDoctorResult);
  value.available = true;
  value.observedVersion = '1.0.0';
  value.missingPrerequisites = [];
  value.checks = [{ code: 'HOST_PROBED', status: 'passed', message: 'Synthetic fixture only.', evidenceRefs: fixtures.validationReport.evidenceRefs }];
  value.evidenceRefs = fixtures.validationReport.evidenceRefs;
  assert.deepEqual(parseContract('adapterDoctorResult', value), value);
  value.evidenceRefs = [];
  assert.throws(() => parseContract('adapterDoctorResult', value), ContractValidationError);
});
