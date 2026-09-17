import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readGitText } from '../snapshot/git.js';

export interface LockProject { repoRoot: string; privateGitDir: string; stateRoot: string }

export class LockError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string) {
    super(`${message}${path ? ` (${path})` : ''}`);
    this.name = 'LockError';
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function checkedDirectory(path: string, privateMode = false): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory() || await realpath(path) !== path) {
    throw new LockError('LOCK_PATH_INVALID', 'Expected a canonical directory without symlinks', path);
  }
  if (privateMode && process.platform !== 'win32'
      && ((entry.mode & 0o077) !== 0 || (process.getuid !== undefined && entry.uid !== process.getuid()))) {
    throw new LockError('LOCK_PATH_INVALID', 'State directories must be owned by this user with mode 0700', path);
  }
}

/** Re-resolve Git identity on every operation; never trust a caller-provided .git path. */
export async function checkProject(project: LockProject, create: boolean): Promise<void> {
  try {
    await checkedDirectory(project.repoRoot);
    const repoRoot = await readGitText(project.repoRoot, ['rev-parse', '--show-toplevel']);
    const privateGitDir = await readGitText(project.repoRoot, ['rev-parse', '--absolute-git-dir']);
    const runtimeRoot = await readGitText(project.repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'dev-harness-runtime']);
    if (resolve(repoRoot) !== project.repoRoot || resolve(privateGitDir) !== project.privateGitDir
        || join(resolve(runtimeRoot), 'runs') !== project.stateRoot) {
      throw new LockError('LOCK_PATH_INVALID', 'Git worktree identity no longer matches the lock context');
    }
    await checkedDirectory(project.privateGitDir);
    const suffix = relative(project.privateGitDir, project.stateRoot);
    if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
      throw new LockError('LOCK_PATH_INVALID', 'State root must remain inside this worktree private Git directory', project.stateRoot);
    }
    let path = project.privateGitDir;
    for (const part of suffix.split(sep)) {
      path = join(path, part);
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); }
        catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
      }
      try { await checkedDirectory(path, true); }
      catch (error) { if (!create && hasCode(error, 'ENOENT')) return; throw error; }
    }
  } catch (error) {
    if (error instanceof LockError) throw error;
    throw new LockError('LOCK_PATH_INVALID', 'Cannot establish private Git state directory identity', project.stateRoot);
  }
}
