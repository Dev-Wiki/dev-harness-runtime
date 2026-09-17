import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import type { LockContext } from '../lock/index.js';
import { StateError } from './errors.js';
import { stateWritePoint } from './testing.js';

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function stamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

/** Inspect every existing component, including ancestors outside the Run root. */
export async function requireDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new StateError('STATE_PATH_INVALID', 'State directory must be absolute', path);
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    const siblings = await readdir(current);
    if (siblings.some((name) => name.toLowerCase() === component.toLowerCase() && name !== component)) {
      throw new StateError('STATE_PATH_INVALID', 'State path has a case alias', path);
    }
    current = join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StateError('STATE_PATH_INVALID', 'State ancestors must be real directories', current);
  }
}

export async function checkedFile(path: string, mayBeAbsent = false): Promise<void> {
  await requireDirectory(dirname(path));
  const names = await readdir(dirname(path));
  if (names.some((name) => name.toLowerCase() === basename(path).toLowerCase() && name !== basename(path))) throw new StateError('STATE_PATH_INVALID', 'State file has a case alias', path);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new StateError('STATE_PATH_INVALID', 'State files must be unique regular files; interrupted hard-link publication requires inspection', path);
  } catch (error) { if (!mayBeAbsent || !hasCode(error, 'ENOENT')) throw error; }
}

export async function readBytes(path: string): Promise<Buffer> {
  await checkedFile(path);
  const observed = await lstat(path, { bigint: true });
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const first = await handle.stat({ bigint: true });
    if (!first.isFile() || first.nlink !== 1n || stamp(first) !== stamp(observed)) throw new StateError('STATE_PATH_INVALID', 'State file changed before opening', path);
    const bytes = await handle.readFile();
    const last = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (stamp(first) !== stamp(last) || stamp(first) !== stamp(current) || current.isSymbolicLink()) {
      throw new StateError('STATE_CORRUPT', 'State file changed during reading', path);
    }
    await requireDirectory(dirname(path));
    return bytes;
  } finally { await handle.close(); }
}

export async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Some supported platforms do not expose directory fsync. This does not
    // promise power-loss durability where the OS cannot provide that primitive.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].some((code) => hasCode(error, code))
      && !(process.platform === 'win32' && ['EPERM', 'EACCES', 'EBADF'].some((code) => hasCode(error, code)))) throw error;
  } finally { await handle?.close(); }
}

export async function makeDirectory(path: string): Promise<void> {
  await requireDirectory(dirname(path));
  const names = await readdir(dirname(path));
  if (names.some((name) => name.toLowerCase() === basename(path).toLowerCase())) throw new StateError('STATE_ALREADY_EXISTS', 'State directory already exists or has a case alias', path);
  await mkdir(path, { mode: 0o700 });
  await requireDirectory(path);
  await syncDirectory(dirname(path));
}

/** Same-directory publication: failures preserve the old or a complete new file. */
export async function atomicWrite(context: LockContext, path: string, bytes: Buffer, replace: boolean): Promise<void> {
  const containment = relative(context.stateRoot, path);
  if (containment.startsWith(`..${sep}`) || containment === '..' || isAbsolute(containment)) throw new StateError('STATE_PATH_INVALID', 'State publication escapes the private root', path);
  await checkedFile(path, true);
  const temp = join(dirname(path), `.dhr-${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let writtenStamp = '';
  try {
    const midpoint = Math.max(1, Math.floor(bytes.length / 2));
    await handle.writeFile(bytes.subarray(0, midpoint));
    await stateWritePoint('half-written', path);
    await handle.writeFile(bytes.subarray(midpoint));
    await handle.sync();
    writtenStamp = stamp(await handle.stat({ bigint: true }));
    await stateWritePoint('file-synced', path);
  } finally { await handle.close(); }
  await context.assertOwner();
  await checkedFile(path, true);
  const actual = await readBytes(temp);
  if (stamp(await lstat(temp, { bigint: true })) !== writtenStamp
    || createHash('sha256').update(actual).digest('hex') !== createHash('sha256').update(bytes).digest('hex')) {
    throw new StateError('STATE_CORRUPT', 'Atomic temporary file changed before publication', temp);
  }
  if (replace) await rename(temp, path);
  else {
    try { await link(temp, path); }
    catch (error) {
      if (hasCode(error, 'EEXIST')) throw new StateError('EVIDENCE_EXISTS', 'Immutable state file already exists', path);
      throw error;
    }
    // A crash here leaves complete bytes with two links. Readers fail closed
    // until explicit inspection; they never guess which temporary link to erase.
    await stateWritePoint('linked', path);
    await unlink(temp);
  }
  await stateWritePoint('published', path);
  await syncDirectory(dirname(path));
  await stateWritePoint('directory-synced', path);
}
