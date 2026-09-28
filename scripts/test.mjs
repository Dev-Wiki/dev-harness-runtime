import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = [];
function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'fixtures'].includes(entry.name)) continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) collect(child);
    else if (entry.name.endsWith('.test.mjs')) files.push(child);
  }
}
for (const root of ['packages', 'build', 'tests/integration', 'tests/contract', 'tests/packaging']) collect(root);
if (files.length === 0) throw new Error('No tests discovered');
const sorted = files.sort();
const windows = process.platform === 'win32';
const args = windows ? ['--test', '--test-force-exit', '--test-timeout=120000', ...sorted] : ['--test', ...sorted];
const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: windows ? 900_000 : undefined });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
