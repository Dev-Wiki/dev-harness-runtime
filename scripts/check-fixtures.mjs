import { spawnSync } from 'node:child_process';

const python = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(python, ['tests/fixtures/platform-specs/check.py'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
