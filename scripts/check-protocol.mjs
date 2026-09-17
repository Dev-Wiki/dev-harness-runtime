import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function validateLock(lock) {
  if (lock.schemaVersion !== 1 || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(lock.repository)
      || !/^[a-f0-9]{40}$/.test(lock.commit) || !/^\d+\.\d+\.\d+$/.test(lock.protocolVersion)
      || !Array.isArray(lock.files) || lock.files.length === 0) throw new Error('Invalid protocol lock metadata');
  const seen = new Set();
  for (const file of lock.files) {
    if (typeof file.path !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(file.path)
        || isAbsolute(file.path) || file.path.split('/').some((part) => ['', '.', '..'].includes(part))
        || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Invalid or duplicate protocol file');
    }
    seen.add(file.path);
  }
  if (!seen.has('VERSION')) throw new Error('Protocol VERSION must be pinned');
}

export function verifyProtocol(lock, source) {
  validateLock(lock);
  const root = realpathSync(source);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (realpathSync(git('rev-parse', '--show-toplevel').trim()) !== root) throw new Error('Source must be a repository root');
  if (git('rev-parse', 'HEAD').trim() !== lock.commit) throw new Error('Protocol source commit drift');
  if (git('status', '--porcelain', '--untracked-files=all') !== '') throw new Error('Protocol source working tree is dirty');
  if (readFileSync(resolve(root, 'VERSION'), 'utf8').trim() !== lock.protocolVersion) throw new Error('Protocol version mismatch');
  for (const file of lock.files) {
    const path = realpathSync(resolve(root, file.path));
    const within = relative(root, path);
    if (isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\')) throw new Error('Protocol path escape');
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (hash !== file.sha256) throw new Error(`Protocol content mismatch: ${file.path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--source') throw new Error('Usage: pnpm verify:protocol --source <checkout>');
    const lock = JSON.parse(readFileSync(new URL('../protocol-lock.json', import.meta.url), 'utf8'));
    verifyProtocol(lock, process.argv[3]);
    process.stdout.write(`Protocol ${lock.protocolVersion}: ${lock.files.length} pinned files verified.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
