import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/release-notes.mjs', import.meta.url));
const notes = async (args) => {
  const root = await mkdtemp(join(tmpdir(), 'dhr-release-notes-'));
  const output = join(root, 'notes.md');
  const handle = await open(output, 'w');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', handle.fd, 'inherit'] });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Release notes exited ${code}`)));
    });
    return await readFile(output, 'utf8');
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
};
const section = async (file) => {
  const changelog = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
  const version = changelog.split(/^## /mu).find((entry) => entry.startsWith('v0.1.1 — '));
  return version.slice(version.indexOf('\n') + 1).trim();
};

test('release notes retain the default Chinese changelog selection', async () => {
  const stdout = await notes(['v0.1.1']);
  assert.equal(stdout, `发布 v0.1.1\n\n${await section('CHANGELOG.md')}\n`);
});

test('release notes select the matching complete English version', async () => {
  const stdout = await notes(['v0.1.1', '--language', 'en']);
  assert.equal(stdout, `Release v0.1.1\n\n${await section('CHANGELOG.en.md')}\n`);
});

test('release notes reject unsupported language options and missing versions', async () => {
  await assert.rejects(run(process.execPath, [script, 'v0.1.1', '--language', 'fr']), /Expected optional --language/u);
  await assert.rejects(run(process.execPath, [script, 'v99.0.0', '--language', 'en']), /CHANGELOG\.en\.md has no section/u);
});
