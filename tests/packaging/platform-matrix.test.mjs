import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/platform-matrix.mjs', import.meta.url));
const variants = {
  codex: ['plugin'], dsh: ['bundle'], cursor: ['plugin'],
  opencode: ['npm', 'local'], antigravity: ['plugin', 'project', 'global'],
  'agent-plugin': ['portable'],
};

test('platform matrix rejects an artifact manifest from a previous source commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dhr-matrix-test-'));
  try {
    await run('git', ['-C', root, 'init', '-b', 'main']);
    const commit = async () => run('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', 'fixture']);
    await commit();
    const { stdout } = await run('git', ['-C', root, 'rev-parse', 'HEAD']);
    const artifacts = [];
    for (const [platform, names] of Object.entries(variants)) {
      await mkdir(join(root, 'dist', platform), { recursive: true });
      for (const name of names) {
        const file = `${platform}/${name}.zip`;
        const bytes = Buffer.from(`${platform}:${name}`);
        await writeFile(join(root, 'dist', file), bytes);
        artifacts.push({ platform, file, size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'dist', 'manifest.json'), JSON.stringify({ sourceCommit: stdout.trim(),
      adapterCompatibility: Object.keys(variants).map(platform => ({ platform })), artifacts }));
    await run(process.execPath, [script, root]);
    await run(process.execPath, [script, '--check', root]);
    assert.match(await readFile(join(root, 'docs', 'PLATFORM_MATRIX.md'), 'utf8'), /SHA-256 已核对/u);

    await commit();
    await assert.rejects(run(process.execPath, [script, '--check', root]),
      /Release manifest belongs to another source commit/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
