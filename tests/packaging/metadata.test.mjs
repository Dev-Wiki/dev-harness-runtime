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
  assert.equal(source.distribution.external, true);
  assert.equal(source.distribution.license, 'MIT');
  const local = await loadSharedMetadata(root, ['build/manifests/DISTRIBUTION_NOTICE.md']);
  assert.equal(local.licenseRefs[0].path, 'build/manifests/DISTRIBUTION_NOTICE.md');
  const fixture = await mkdtemp(join(tmpdir(), 'dhr-metadata-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'build/manifests'), { recursive: true });
  await writeFile(join(fixture, 'build/manifests/metadata.json'), metadataBytes);
  for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'build/manifests/DISTRIBUTION_NOTICE.md']) {
    await writeFile(join(fixture, path), await readFile(resolve(root, path)));
  }
  await assert.rejects(loadSharedMetadata(fixture, []), /External distribution requires/u);
  const metadata = await loadSharedMetadata(fixture, ['build/manifests/DISTRIBUTION_NOTICE.md']);
  assert.equal(metadata.name, source.name);
  assert.equal(metadata.repository, source.repository);
  assert.equal(metadata.licenseRefs.length, 1);
  assert.equal(metadata.licenseRefs[0].path, 'build/manifests/DISTRIBUTION_NOTICE.md');
  await writeFile(join(fixture, 'THIRD_PARTY_NOTICES.md'), 'Missing notices\n');
  await assert.rejects(loadSharedMetadata(fixture, ['build/manifests/DISTRIBUTION_NOTICE.md']), /omits/u);
  await writeFile(join(fixture, 'THIRD_PARTY_NOTICES.md'), await readFile(resolve(root, 'THIRD_PARTY_NOTICES.md')));
  await assert.rejects(loadSharedMetadata(fixture,
    ['build/manifests/DISTRIBUTION_NOTICE.md', 'missing-license.txt']), { code: 'ENOENT' });
});
