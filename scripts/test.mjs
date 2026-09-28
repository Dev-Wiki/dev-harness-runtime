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
  const failures = [];
  for (const file of sorted) {
    console.log(`Testing ${file}`);
    const result = spawnSync(process.execPath, ['--test', '--test-force-exit', file], { stdio: 'inherit', timeout: 120_000 });
    if (result.error || result.status !== 0) {
      failures.push(file);
      console.error(`Test file failed: ${file}${result.error ? ` (${result.error.message})` : ''}`);
    }
  }
  if (failures.length) {
    console.error(`Failed test files (${failures.length}):\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
} else {
  const result = spawnSync(process.execPath, ['--test', ...sorted], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
