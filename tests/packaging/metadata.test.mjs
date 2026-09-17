import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadSharedMetadata } from '../../build/dist/manifests/metadata.js';

test('shared metadata uses repository source and requires actual license references', async (t) => {
  const root = resolve('.');
  const metadataBytes = await readFile(resolve(root, 'build/manifests/metadata.json'));
  const source = JSON.parse(metadataBytes.toString('utf8'));
  assert.equal(source.distribution.external, false);
  const local = await loadSharedMetadata(root, ['build/manifests/DISTRIBUTION_NOTICE.md']);
  assert.equal(local.licenseRefs[0].path, 'build/manifests/DISTRIBUTION_NOTICE.md');
  const fixture = await mkdtemp(join(tmpdir(), 'dhr-metadata-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'build/manifests'), { recursive: true });
  await writeFile(join(fixture, 'build/manifests/metadata.json'), metadataBytes);
  await writeFile(join(fixture, 'LICENSE'), 'Fixture-only sample; no project license is claimed.\n');
  await assert.rejects(loadSharedMetadata(fixture, []), /Contract schema validation failed/u);
  const metadata = await loadSharedMetadata(fixture, ['LICENSE']);
  assert.equal(metadata.name, source.name);
  assert.equal(metadata.repository, source.repository);
  assert.equal(metadata.licenseRefs.length, 1);
  assert.equal(metadata.licenseRefs[0].path, 'LICENSE');
  await assert.rejects(loadSharedMetadata(fixture, ['missing-license.txt']), { code: 'ENOENT' });
});
