import { lstat, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

async function inspect(path) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing non-directory artifact root: ${path}`);
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in artifact tree: ${target}`);
      if (entry.name === '.stage.lock' || entry.name === '.manifest.lock') throw new Error(`Build lock must be inspected before cleanup: ${target}`);
      if (entry.isDirectory()) await visit(target);
      else if (!entry.isFile()) throw new Error(`Refusing special file in artifact tree: ${target}`);
    }
  };
  await visit(path);
  return true;
}

const roots = [resolve('.generated'), resolve('dist')];
const present = await Promise.all(roots.map(inspect));
for (const [index, path] of roots.entries()) if (present[index]) await rm(path, { recursive: true });
process.stdout.write('Removed generated plugin trees and local distribution artifacts\n');
