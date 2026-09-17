import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PlanningError } from '../planning/types.js';

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function exactCase(root: string, target: string): Promise<void> {
  let directory = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    const names = await readdir(directory);
    const aliases = names.filter((name) => name.toLowerCase() === part.toLowerCase());
    if (aliases.length === 0) throw new PlanningError('PATH_NOT_FOUND', 'Reference target does not exist', target);
    if (aliases.length !== 1 || aliases[0] !== part) {
      throw new PlanningError('PATH_CASE_MISMATCH', 'Path spelling is missing, ambiguous, or differs in case', target);
    }
    directory = resolve(directory, part);
    if (!contained(root, await realpath(directory))) {
      throw new PlanningError('PATH_ESCAPE', 'Symlink escapes the repository', target);
    }
  }
}

/** Resolve a Markdown reference; parent segments are allowed only within the real repository. */
export async function resolveProjectPath(repoRoot: string, baseDir: string, reference: string): Promise<string> {
  let decoded: string;
  try { decoded = decodeURIComponent(reference); }
  catch { throw new PlanningError('PATH_INVALID', 'Malformed UTF-8 or URL escaping in reference', reference); }
  // eslint-disable-next-line no-control-regex -- Reject control bytes in path references.
  if (!reference || /[?#]/u.test(reference) || !decoded || /[\\:\x00-\x1f\x7f]/u.test(decoded)
    || decoded.startsWith('/') || decoded.endsWith('/') || decoded.split('/').some((part) => part === '')) {
    throw new PlanningError('PATH_INVALID', 'Expected a relative POSIX reference without a URL, query, or fragment', reference);
  }
  const root = await realpath(repoRoot);
  const base = await realpath(baseDir);
  const lexical = resolve(base, ...decoded.split('/'));
  if (!contained(root, base) || !contained(root, lexical)) {
    throw new PlanningError('PATH_ESCAPE', 'Reference escapes the repository', reference);
  }
  try {
    await exactCase(root, lexical);
    const target = await realpath(lexical);
    if (!contained(root, target)) throw new PlanningError('PATH_ESCAPE', 'Symlink escapes the repository', reference);
    await exactCase(root, target);
    return target;
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    throw new PlanningError('PATH_NOT_FOUND', 'Reference target is missing or unreadable', reference);
  }
}

/** Decode governance and planning files strictly, rather than replacing malformed bytes. */
export async function readProjectText(path: string): Promise<string> {
  if (!(await stat(path)).isFile()) throw new PlanningError('PATH_INVALID', 'Expected a regular text file', path);
  const bytes = await readFile(path);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new PlanningError('INVALID_UTF8', 'File is not valid UTF-8', path); }
}
