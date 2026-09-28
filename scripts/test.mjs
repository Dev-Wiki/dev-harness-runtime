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
if (process.platform === 'win32') {
  // A single Windows test process can otherwise hold the entire suite open
  // indefinitely. Run each file separately so the failing file is visible.
  for (const file of sorted) {
    console.log(`Testing ${file}`);
    const result = spawnSync(process.execPath, ['--test', file], { stdio: 'inherit', timeout: 300_000 });
    if (result.error) throw new Error(`Test file did not finish: ${file}`, { cause: result.error });
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} else {
  const result = spawnSync(process.execPath, ['--test', ...sorted], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
