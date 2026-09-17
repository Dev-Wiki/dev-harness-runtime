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
for (const root of ['packages', 'build', 'tests/integration']) collect(root);
if (files.length === 0) throw new Error('No tests discovered');
const result = spawnSync(process.execPath, ['--test', ...files.sort()], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
