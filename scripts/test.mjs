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
function run(args, timeout) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
if (windows) {
  const guard = resolve('packages/core/tests/snapshot/guard.test.mjs');
  if (!sorted.includes(guard)) throw new Error('Snapshot guard tests not discovered');
  const options = ['--test', '--test-force-exit', '--test-timeout=120000'];
  const guardStatus = run([...options, guard], 300_000);
  if (guardStatus !== 0) process.exitCode = guardStatus;
  else process.exitCode = run([...options, '--test-concurrency=8', ...sorted.filter((file) => file !== guard)], 1_800_000);
} else {
  process.exitCode = run(['--test', ...sorted]);
}
