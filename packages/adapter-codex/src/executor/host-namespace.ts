import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export class CodexHostNamespaceError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'PROVIDER_UNAVAILABLE' | 'QUIESCENCE_UNKNOWN' | 'OUTPUT_LIMIT', message: string) {
    super(message); this.name = 'CodexHostNamespaceError';
  }
}

export interface CodexHostMount { readonly source: string; readonly destination: string }
export interface CodexHostNamespaceInput {
  readonly bubblewrap: string;
  readonly nodeBinary: string;
  /** Absolute executable path inside the namespace. */
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly mounts: readonly CodexHostMount[];
  readonly tmpfs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  /** Isolated mode has no host network access; a controlled model proxy must be supplied separately. */
  readonly network?: 'shared' | 'isolated';
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}
export interface CodexHostNamespaceResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly termination: 'exited' | 'timeout' | 'aborted';
  readonly quiescence: 'confirmed';
  readonly evidence: {
    readonly providerSha256: string;
    readonly nodeSha256: string;
    readonly initPid: number;
    readonly initStartTime: string;
    readonly namespaceIds: Readonly<Record<string, number>>;
    readonly network: 'shared' | 'isolated';
    readonly asPid1: true;
    readonly monitorWaited: true;
  };
}

const ready = Buffer.from('DHR_HOST_NAMESPACE_READY\n');
const maxOutput = 32 * 1024 * 1024;
const bootstrap = String.raw`
if (process.pid !== 1) process.exit(125);
process.stdout.write('DHR_HOST_NAMESPACE_READY\n');
const fs = require('node:fs');
const gate = Buffer.alloc(1);
if (fs.readSync(5, gate, 0, 1, null) !== 1 || gate[0] !== 49) process.exit(125);
for (const name of fs.readdirSync('/proc/self/fd')) {
  const fd = Number(name);
  if (fd > 2) { try { fs.closeSync(fd); } catch {} }
}
process.execve(process.argv[1], process.argv.slice(1), process.env);
`;
const fail = (code: CodexHostNamespaceError['code'], message: string): never => { throw new CodexHostNamespaceError(code, message); };
const contains = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}${sep}`);
const absolute = (path: string): string => {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
    fail('INVALID_ARGUMENT', 'Namespace paths must be normalized and absolute');
  }
  return path;
};
const inode = (link: string): number => {
  const match = /\[(\d+)\]$/u.exec(link);
  if (match === null) throw new CodexHostNamespaceError('QUIESCENCE_UNKNOWN', 'Namespace identifier is malformed');
  return Number(match[1]);
};

interface Provider { readonly path: string; readonly sha256: string; readonly stamp: string }
const stamp = (stat: { dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
async function provider(path: string): Promise<Provider> {
  absolute(path);
  if (await realpath(path) !== path) fail('PROVIDER_UNAVAILABLE', 'Namespace provider path is not canonical');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || (before.mode & 0o111n) === 0n
      || (before.mode & 0o6022n) !== 0n || ![0n, BigInt(process.getuid?.() ?? -1)].includes(before.uid)) {
      fail('PROVIDER_UNAVAILABLE', 'Namespace provider must be a trusted executable file');
    }
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (stamp(before) !== stamp(after) || stamp(after) !== stamp(named)
      || bytes.subarray(0, 4).toString('hex') !== '7f454c46') {
      fail('PROVIDER_UNAVAILABLE', 'Namespace provider changed or is not a native ELF executable');
    }
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), stamp: stamp(after) };
  } finally { await file.close(); }
}
async function unchanged(expected: Provider): Promise<void> {
  const actual = await provider(expected.path);
  if (actual.stamp !== expected.stamp || actual.sha256 !== expected.sha256) {
    fail('PROVIDER_UNAVAILABLE', 'Namespace provider changed during execution');
  }
}

function directories(path: string): string[] {
  let parent: string = sep;
  const result: string[] = [];
  for (const part of path.split(sep).filter(Boolean)) {
    parent = join(parent, part); result.push(parent);
  }
  return result;
}

function validate(input: CodexHostNamespaceInput): void {
  absolute(input.cwd); absolute(input.executable);
  if (input.network !== undefined && input.network !== 'shared' && input.network !== 'isolated') {
    fail('INVALID_ARGUMENT', 'Namespace network mode is invalid');
  }
  if (!Array.isArray(input.argv) || input.argv.length > 256 || input.argv.some((arg) =>
    typeof arg !== 'string' || arg.length > 131_000 || arg.includes('\0'))
    || (input.stdin !== undefined && (!(input.stdin instanceof Uint8Array) || input.stdin.byteLength > 32 * 1024 * 1024))
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000) {
    fail('INVALID_ARGUMENT', 'Namespace command or timeout is invalid');
  }
  if (!Array.isArray(input.mounts) || input.mounts.length > 256 || !Array.isArray(input.tmpfs) || input.tmpfs.length > 16) {
    fail('INVALID_ARGUMENT', 'Namespace mount list is invalid');
  }
  const destinations = new Set<string>();
  for (const mount of input.mounts) {
    absolute(mount.source); absolute(mount.destination);
    if ([...destinations].some((path) => contains(path, mount.destination) || contains(mount.destination, path))
      || ['/', '/usr', '/proc', '/dev', '/tmp', '/dhr/node'].includes(mount.destination)
      || ['/usr', '/proc', '/dev', '/bin', '/lib', '/lib64'].some((path) => contains(path, mount.destination))
      || ['/', '/home', '/root', '/tmp', '/etc', '/proc', '/dev'].includes(mount.source)) {
      fail('INVALID_ARGUMENT', 'Namespace mount is broad, duplicate or overlaps a fixed boundary');
    }
    destinations.add(mount.destination);
  }
  const tmpfs = new Set(input.tmpfs);
  for (const path of tmpfs) {
    absolute(path);
    if (!path.startsWith('/dhr/') || destinations.has(path)) fail('INVALID_ARGUMENT', 'Namespace tmpfs must be private');
  }
  if (tmpfs.size !== input.tmpfs.length) fail('INVALID_ARGUMENT', 'Namespace tmpfs entries repeat');
  if (!destinations.has(input.executable)) fail('INVALID_ARGUMENT', 'Namespace executable must be an exact readonly mount');
  for (const [key, value] of Object.entries(input.environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || typeof value !== 'string' || value.length > 8192 || value.includes('\0')) {
      fail('INVALID_ARGUMENT', 'Namespace environment is malformed');
    }
  }
}

function buildArgs(input: CodexHostNamespaceInput): string[] {
  const allDirs = new Set<string>(['/dhr']);
  for (const path of [input.cwd, input.executable, ...input.mounts.map((mount) => mount.destination), ...input.tmpfs]) {
    for (const dir of directories(path).slice(0, path === input.cwd ? undefined : -1)) allDirs.add(dir);
  }
  const orderedDirs = [...allDirs].filter((dir) => !['/usr', '/proc', '/dev', '/tmp', '/bin', '/lib', '/lib64'].includes(dir))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const args = ['--info-fd', '3', '--block-fd', '4', '--unshare-user', '--unshare-ipc', '--unshare-pid',
    ...(input.network === 'isolated' ? ['--unshare-net'] : []),
    '--unshare-uts', '--unshare-cgroup', '--die-with-parent', '--as-pid-1', '--new-session', '--cap-drop', 'ALL',
    '--clearenv', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ...orderedDirs.flatMap((dir) => ['--dir', dir]),
    ...input.tmpfs.flatMap((path) => ['--tmpfs', path]),
    '--ro-bind', input.nodeBinary, '/dhr/node',
    ...input.mounts.flatMap(({ source, destination }) => ['--ro-bind', source, destination]),
    '--remount-ro', '/', ...Object.entries(input.environment).flatMap(([key, value]) => ['--setenv', key, value]),
    '--chdir', input.cwd, '--', '/dhr/node', '-e', bootstrap, '--', input.executable, ...input.argv];
  return args;
}

async function namespaceGone(pid: number, expected: number): Promise<boolean> {
  for (let i = 0; i < 400; i++) {
    const link = await readlink(`/proc/${pid}/ns/pid`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
      throw error;
    });
    if (link === null || inode(link) !== expected) return true;
    await pause(25);
  }
  return false;
}

/** A gated PID 1 host process. Network mode and lifecycle are verified separately from tool authorization. */
export async function runCodexHostNamespace(input: CodexHostNamespaceInput): Promise<CodexHostNamespaceResult> {
  if (process.platform !== 'linux') fail('PROVIDER_UNAVAILABLE', 'Host namespaces require Linux');
  validate(input);
  const [binary, node] = await Promise.all([provider(input.bubblewrap), provider(input.nodeBinary)]);
  for (const mount of input.mounts) {
    if (await realpath(mount.source) !== mount.source) fail('INVALID_ARGUMENT', 'Namespace mount source is not canonical');
    const stat = await lstat(mount.source);
    if ((!stat.isFile() && !stat.isDirectory()) || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
      fail('INVALID_ARGUMENT', 'Namespace mount source is not a trusted file or directory');
    }
  }
  if (input.signal?.aborted) fail('INVALID_ARGUMENT', 'Namespace run was cancelled before launch');
  const child = spawn(binary.path, buildArgs(input), { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
  const infoStream = child.stdio[3] as Readable;
  const blockStream = child.stdio[4] as Writable;
  const gateStream = child.stdio.at(5) as Writable;
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; const info: Buffer[] = [];
  let outputSize = 0; let overflow = false; let infoSize = 0;
  let termination: CodexHostNamespaceResult['termination'] = 'exited';
  let graceTimer: NodeJS.Timeout | undefined;
  let rejectGrace!: (reason: CodexHostNamespaceError) => void;
  const grace = new Promise<never>((_resolve, reject) => { rejectGrace = reject; });
  const stop = (reason: 'timeout' | 'aborted'): void => {
    if (termination !== 'exited') return;
    termination = reason;
    child.stdin.end(); blockStream.end(); gateStream.end(); child.kill('SIGKILL');
    graceTimer = setTimeout(() => rejectGrace(new CodexHostNamespaceError('QUIESCENCE_UNKNOWN',
      'Namespace monitor did not stop after termination')), 10_000);
    graceTimer.unref();
  };
  const onAbort = (): void => stop('aborted');
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('timeout'), input.timeoutMs);
  const collect = (target: Buffer[], chunk: Buffer): void => {
    outputSize += chunk.byteLength;
    if (outputSize > maxOutput) { overflow = true; stop('aborted'); }
    else target.push(chunk);
  };
  child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
  infoStream.on('data', (chunk: Buffer) => { infoSize += chunk.byteLength; if (infoSize <= 65_536) info.push(chunk); else stop('aborted'); });
  child.stdin.on('error', () => { /* Exit and namespace proof classify a closed gate. */ });
  blockStream.on('error', () => { /* Exit and namespace proof classify a closed block FD. */ });
  gateStream.on('error', () => { /* Exit and namespace proof classify a closed start gate. */ });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const boundedClose = Promise.race([closed, grace]);
  const infoEnded = new Promise<void>((resolve) => { infoStream.once('end', resolve); });
  let initPid: number | undefined; let pidNamespace: number | undefined;
  let startTime = ''; const namespaceIds: Record<string, number> = {};
  try {
    await Promise.race([infoEnded, boundedClose.then(() => undefined)]);
    if (termination !== 'exited' || infoSize > 65_536) fail('QUIESCENCE_UNKNOWN', 'Namespace setup did not finish before termination');
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(Buffer.concat(info).toString('utf8')); }
    catch { return fail('PROVIDER_UNAVAILABLE', 'Namespace provider returned no info-fd record'); }
    if (!Number.isSafeInteger(parsed['child-pid']) || (parsed['child-pid'] as number) <= 1) {
      fail('QUIESCENCE_UNKNOWN', 'Namespace init PID is invalid');
    }
    initPid = parsed['child-pid'] as number;
    const stat = await readFile(`/proc/${initPid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[1]) !== child.pid) fail('QUIESCENCE_UNKNOWN', 'Namespace init is not a direct provider child');
    startTime = fields[19] ?? '';
    for (const name of ['pid', 'mnt', 'ipc', 'uts', 'user', 'cgroup', 'net']) {
      const actual = inode(await readlink(`/proc/${initPid}/ns/${name}`));
      const host = inode(await readlink(`/proc/self/ns/${name}`));
      if ((name === 'net' && (input.network === 'isolated' ? actual === host : actual !== host))
        || (name !== 'net' && actual === host)
        || (name !== 'user' && name !== 'net' && actual !== parsed[`${name}-namespace`])) {
        fail('QUIESCENCE_UNKNOWN', `Namespace boundary failed: ${name}`);
      }
      namespaceIds[name] = actual;
    }
    pidNamespace = namespaceIds.pid;
    if (pidNamespace === undefined) fail('QUIESCENCE_UNKNOWN', 'PID namespace evidence is absent');
    blockStream.end();
    const readyAt = await Promise.race([new Promise<boolean>((resolve) => {
      const check = (): void => {
        const bytes = Buffer.concat(stdout);
        if (bytes.byteLength >= ready.byteLength) resolve(bytes.subarray(0, ready.byteLength).equals(ready));
        else child.stdout.once('data', check);
      };
      check();
    }), boundedClose.then(() => false)]);
    if (!readyAt || termination !== 'exited') fail('QUIESCENCE_UNKNOWN', 'Trusted PID 1 bootstrap did not become ready');
    child.stdin.end(input.stdin);
    gateStream.end('1');
    const exit = await boundedClose;
    if (initPid === undefined || pidNamespace === undefined) {
      throw new CodexHostNamespaceError('QUIESCENCE_UNKNOWN', 'Namespace init evidence disappeared from controller state');
    }
    if (!await namespaceGone(initPid, pidNamespace)) fail('QUIESCENCE_UNKNOWN', 'Host namespace init remains live');
    await Promise.all([unchanged(binary), unchanged(node)]);
    if (overflow) fail('OUTPUT_LIMIT', 'Host namespace output exceeded 32 MiB');
    return { stdout: Buffer.concat(stdout).subarray(ready.byteLength), stderr: Buffer.concat(stderr), exitCode: exit.code,
      termination, quiescence: 'confirmed', evidence: { providerSha256: binary.sha256, nodeSha256: node.sha256, initPid,
        initStartTime: startTime, namespaceIds, network: input.network ?? 'shared', asPid1: true, monitorWaited: true } };
  } catch (error) {
    if (termination === 'exited') stop('aborted');
    await boundedClose.catch(() => undefined);
    if (initPid === undefined || pidNamespace === undefined || !await namespaceGone(initPid, pidNamespace)) {
      throw new CodexHostNamespaceError('QUIESCENCE_UNKNOWN', 'Host process tree could not be proven quiescent');
    }
    throw error;
  } finally {
    clearTimeout(timer); clearTimeout(graceTimer); input.signal?.removeEventListener('abort', onAbort);
  }
}
