import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTarGzip, createZip } from '../../build/dist/manifests/archive.js';
import { compareGolden } from '../../build/dist/manifests/golden.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('fixed input archives match reviewed golden and drift requires an explicit update', async (t) => {
  const files = new Map([['plugin.json', Buffer.from('{"name":"dhr","version":"0.1.0"}\n')],
    ['skills/run/SKILL.md', Buffer.from('---\nname: run\ndescription: Run tasks\n---\n')]]);
  const timestamp = '2020-01-02T03:04:06Z';
  const snapshot = { input: 'packaging-fixture-v1', timestamp,
    zip: sha(createZip(files, timestamp)), tarGzip: sha(createTarGzip(files, timestamp)) };
  await compareGolden(new URL('./golden/archive.json', import.meta.url).pathname, snapshot);
  const dir = await mkdtemp(join(tmpdir(), 'dhr-golden-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'snapshot.json');
  await assert.rejects(compareGolden(path, snapshot), /explicit update required/u);
  await compareGolden(path, snapshot, { update: true });
  assert.equal(await readFile(path, 'utf8'), `${JSON.stringify({ input: snapshot.input, tarGzip: snapshot.tarGzip, timestamp, zip: snapshot.zip })}\n`);
  await assert.rejects(compareGolden(path, { ...snapshot, zip: '0'.repeat(64) }), /explicit update required/u);
});
