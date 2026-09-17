import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, mkdtemp, rm, cp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { SANDBOX_CONTROL } from './sandbox-control.js';
import type { Snapshot } from '@dev-harness-runtime/contracts';

export type SandboxErrorCode = 'INVALID_SANDBOX' | 'UNSAFE_PATH' | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_CHANGED' | 'OUTPUT_LIMIT' | 'QUIESCENCE_UNKNOWN' | 'DRIFT_DETECTED' | 'CAPABILITY_MISSING';
export class SandboxError extends Error {
  constructor(readonly code: SandboxErrorCode, message: string) { super(message); this.name = 'SandboxError'; }
}

declare const sandboxHandle: unique symbol;
/** In-process capability; serialized or structurally similar objects are not capabilities. */
export interface SandboxHandle { readonly [sandboxHandle]: true }
export interface LinuxSandboxOptions {
  readonly binaryPath: string;
  readonly toolchainMounts: readonly string[];
  readonly path: string;
}
export interface SandboxRunOptions {
  readonly argv: readonly string[];
  /** Absolute repository path, or a relative path within repoRoot. */
  readonly cwd: string;
  readonly repoRoot: string;
  readonly privateGitDir: string;
  /** Existing repository-relative directories; never the repository itself. */
  readonly writableArtifacts: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string>>;
  /** Core-captured complete worktree file set, checked against the isolated copy before overlays. */
  readonly expectedFiles?: Snapshot['paths'];
  /** Core's frozen baseline bytes, never Worker-provided claims. */
  readonly frozenInputs?: readonly { readonly path: string; readonly bytes: Uint8Array }[];
}
export interface SandboxNamespaceEvidence {
  readonly providerSha256: string;
  readonly controllerSha256: string;
  readonly pythonSha256: string;
  readonly monitorPid: number;
  readonly initPid: number;
  readonly initStartTime: string;
  readonly namespaceIds: Readonly<Record<string, number>>;
  readonly pidfdBound: true;
  readonly asPid1: true;
  readonly monitorWaited: true;
}
export interface SandboxResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly termination: 'exited' | 'timeout' | 'aborted';
  readonly quiescence: 'confirmed';
  readonly namespaceEvidence: SandboxNamespaceEvidence;
}

interface Fingerprint { path: string; stamp: string; sha256: string }
interface Mount { source: string; destination: string; option: '--ro-bind' | '--bind'; dev: string; ino: string }
interface Provider {
  binary: Fingerprint; python: Fingerprint; mounts: Mount[]; links: string[]; path: string;
  toolchainMounts: string[];
}
const providers = new WeakMap<object, Provider>();
const MAX_CONTROLLER_OUTPUT = 24 * 1024 * 1024;
const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const contains = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + sep);
function fail(code: SandboxErrorCode, message: string): never { throw new SandboxError(code, message); }

function absolute(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    fail('UNSAFE_PATH', 'Expected a normalized absolute path');
  }
  return value;
}

/** Check every existing ancestor, not just the final component. */
async function checkedDirectory(path: string): Promise<void> {
  absolute(path);
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', `Not a real directory: ${current}`);
  }
}

async function mount(source: string, option: Mount['option'] = '--ro-bind'): Promise<Mount> {
  await checkedDirectory(source);
  const stat = await lstat(source, { bigint: true });
  return { source, destination: source, option, dev: String(stat.dev), ino: String(stat.ino) };
}

async function fingerprint(path: string): Promise<Fingerprint> {
  absolute(path);
  await checkedDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || (before.mode & 0o111n) === 0n || (before.mode & 0o6000n) !== 0n
      || (before.mode & 0o022n) !== 0n || ![0n, BigInt(process.getuid?.() ?? -1)].includes(before.uid)) {
      fail('PROVIDER_UNAVAILABLE', 'Provider executable must be a trusted regular executable without set-id or group/world write');
    }
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const pathStat = await lstat(path, { bigint: true });
    const stamp = (stat: typeof before): string => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    if (stamp(before) !== stamp(after) || stamp(after) !== stamp(pathStat)) fail('PROVIDER_CHANGED', 'Executable changed while fingerprinting');
    if (bytes.subarray(0, 4).toString('hex') !== '7f454c46') fail('PROVIDER_UNAVAILABLE', 'Provider must be a native ELF executable');
    return { path, stamp: stamp(after), sha256: digest(bytes) };
  } finally { await file.close(); }
}

async function unchanged(expected: Fingerprint): Promise<void> {
  const actual = await fingerprint(expected.path);
  if (actual.stamp !== expected.stamp || actual.sha256 !== expected.sha256) fail('PROVIDER_CHANGED', 'Provider executable identity changed');
}

async function inspectTree(root: string, writable: boolean, masked: ReadonlySet<string> = new Set(), toolchain = false): Promise<void> {
  async function visit(path: string): Promise<void> {
    if (masked.has(path)) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      if (writable) fail('UNSAFE_PATH', `Writable artifact contains a symlink: ${path}`);
      // A toolchain symlink never adds a host mount: outside targets remain absent,
      // or resolve inside another already declared readonly mount.
      if (toolchain) return;
      let target: string;
      try { target = await realpath(path); } catch { return fail('UNSAFE_PATH', `Unresolved repository symlink: ${path}`); }
      if (!contains(root, target) || [...masked].some(item => contains(item, target))) {
        fail('UNSAFE_PATH', `Repository symlink escapes its readable boundary: ${path}`);
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (!stat.isFile() || (writable && stat.nlink !== 1)) {
      fail('UNSAFE_PATH', `Unsupported file or writable hardlink: ${path}`);
    }
  }
  await visit(root);
}

function repoPath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

async function verifyMirror(root: string, expected: Snapshot['paths'], hidden: ReadonlySet<string>): Promise<void> {
  const remaining = new Map<string, Snapshot['paths'][number]>();
  const seen = new Set<string>();
  for (const entry of expected) {
    if (!repoPath(entry.path) || seen.has(entry.path)) fail('INVALID_SANDBOX', 'Invalid expected snapshot path');
    seen.add(entry.path);
    if (entry.type === 'gitlink') fail('CAPABILITY_MISSING', 'Verification mirrors do not support Git submodules');
    if (entry.type !== 'missing') remaining.set(entry.path, entry);
  }
  async function visit(path: string): Promise<void> {
    if (hidden.has(path)) return;
    const stat = await lstat(path);
    if (stat.isDirectory()) { for (const name of await readdir(path)) await visit(join(path, name)); return; }
    const key = relative(root, path).split(sep).join('/');
    const entry = remaining.get(key);
    if (!entry) fail('DRIFT_DETECTED', `Unexpected file in verification mirror: ${key}`);
    if (stat.isSymbolicLink()) {
      if (entry.type !== 'symlink' || entry.mode !== '120000' || await readlink(path) !== entry.symlinkTarget) {
        fail('DRIFT_DETECTED', `Symlink changed in verification mirror: ${key}`);
      }
    } else if (!stat.isFile() || entry.type !== 'file' || entry.mode !== ((stat.mode & 0o111) ? '100755' : '100644')
      || digest(await readFile(path)) !== entry.rawContentHash) fail('DRIFT_DETECTED', `File changed in verification mirror: ${key}`);
    remaining.delete(key);
  }
  await visit(root);
  if (remaining.size) fail('DRIFT_DETECTED', `Missing file in verification mirror: ${remaining.keys().next().value}`);
}

function environment(input: Readonly<Record<string, string>> | undefined): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    const allowed = key === 'DEV_HARNESS_WORKER' ? value === '1'
      : ['DEV_HARNESS_RUN_ID', 'DEV_HARNESS_TASK_ID', 'DEV_HARNESS_ADAPTER'].includes(key)
        && typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
    if (!allowed) fail('INVALID_SANDBOX', `Invalid sandbox environment marker: ${key}`);
    result.push('--setenv', key, value);
  }
  return result;
}

/** Linux local capability probe. No successful result implies a remote Agent host capability. */
export async function createLinuxSandbox(options: LinuxSandboxOptions): Promise<SandboxHandle> {
  if (process.platform !== 'linux') fail('PROVIDER_UNAVAILABLE', 'The verification sandbox requires Linux');
  const binary = await fingerprint(absolute(options.binaryPath));
  // -I -S excludes user site packages, PYTHON* environment and working-directory imports.
  const python = await fingerprint(await realpath('/usr/bin/python3'));
  const mounts: Mount[] = [await mount('/usr')];
  const links: string[] = [];
  for (const path of ['/bin', '/sbin', '/lib', '/lib64']) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      if (!contains('/usr', await realpath(path))) fail('PROVIDER_UNAVAILABLE', 'Unsupported system library layout');
      links.push('--symlink', await readlink(path), path);
    } else mounts.push(await mount(path));
  }
  const toolchainMounts: string[] = [];
  for (const path of options.toolchainMounts) {
    absolute(path);
    if (['/', '/home', '/root', '/tmp', '/var', '/etc', '/run', '/mnt', '/mnt/c', '/proc', '/sys', '/dev'].includes(path)
      || contains('/run', path) || contains('/mnt', path) || contains('/proc', path) || contains('/sys', path)
      || contains('/dev', path) || contains('/etc', path)
      || /^\/home\/[^/]+$/.test(path) || path === process.env.HOME) {
      fail('UNSAFE_PATH', 'Toolchain mounts must be specific tool directories, never host credential or IPC roots');
    }
    if (mounts.some(item => contains(item.source, path))) continue;
    await inspectTree(path, false, new Set(), true);
    mounts.push(await mount(path));
    toolchainMounts.push(path);
  }
  if (typeof options.path !== 'string' || !options.path || options.path.split(':').some(path => {
    absolute(path);
    return !mounts.some(item => contains(item.destination, path)) && !['/bin', '/sbin'].includes(path);
  })) fail('INVALID_SANDBOX', 'PATH must contain only explicit readonly tool directories');
  const provider: Provider = { binary, python, mounts, links, path: options.path, toolchainMounts };
  const probeRoot = await mkdtemp(join(tmpdir(), 'dhr-sandbox-probe-'));
  try {
    const result = await execute(provider, { argv: ['/usr/bin/true'], cwd: '.', repoRoot: probeRoot,
      privateGitDir: join(probeRoot, '.git'), writableArtifacts: [], timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.termination !== 'exited') fail('PROVIDER_UNAVAILABLE', `Sandbox capability probe failed: ${result.stderr.toString('utf8')}`);
  } finally { await rm(probeRoot, { recursive: true, force: true }); }
  const handle = Object.freeze(Object.create(null)) as SandboxHandle;
  providers.set(handle, provider);
  return handle;
}

export async function runSandbox(handle: SandboxHandle, options: SandboxRunOptions): Promise<SandboxResult> {
  const provider = typeof handle === 'object' && handle !== null ? providers.get(handle) : undefined;
  if (!provider) fail('INVALID_SANDBOX', 'A live Core sandbox capability is required');
  return execute(provider, { ...options, argv: [...options.argv], writableArtifacts: [...options.writableArtifacts],
    ...(options.environment ? { environment: { ...options.environment } } : {}),
    ...(options.expectedFiles ? { expectedFiles: structuredClone(options.expectedFiles) } : {}),
    ...(options.frozenInputs ? { frozenInputs: options.frozenInputs.map(input => ({ path: input.path, bytes: Uint8Array.from(input.bytes) })) } : {}) });
}

async function execute(provider: Provider, options: SandboxRunOptions): Promise<SandboxResult> {
  await unchanged(provider.binary);
  await unchanged(provider.python);
  const repo = absolute(options.repoRoot);
  const privateGitDir = absolute(options.privateGitDir);
  if (repo === '/' || contains(repo, '/tmp/dhr-home') || contains('/tmp/dhr-home', repo) || contains(privateGitDir, repo)
    || provider.mounts.some(item => contains(item.source, repo) || contains(repo, item.source))) {
    fail('UNSAFE_PATH', 'Repository and toolchain mounts must not overlap');
  }
  await checkedDirectory(repo);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000) fail('INVALID_SANDBOX', 'Invalid command timeout');
  if (!Array.isArray(options.argv) || !options.argv.length || options.argv.some(value => typeof value !== 'string' || value.includes('\0')) || !options.argv[0]) {
    fail('INVALID_SANDBOX', 'A nonempty fixed argv is required');
  }
  const cwd = resolve(repo, options.cwd);
  if (!contains(repo, cwd)) fail('UNSAFE_PATH', 'Command cwd must be inside the repository');
  await checkedDirectory(cwd);
  const hidden = new Set<string>([join(repo, '.git')]);
  if (contains(repo, privateGitDir)) hidden.add(privateGitDir);
  if (provider.mounts.some(item => contains(item.source, privateGitDir))) fail('UNSAFE_PATH', 'Private Git state overlaps a readable toolchain');
  const mounts = [...provider.mounts];
  const artifactMounts: Mount[] = [];
  const artifacts: string[] = [];
  for (const relativePath of options.writableArtifacts) {
    if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('\0')
      || relativePath.split('/').some(part => part === '..' || part === '.' || !part)) fail('UNSAFE_PATH', 'Artifact directories must be normalized relative paths');
    const path = join(repo, relativePath);
    if (!contains(repo, path) || path === repo || [...hidden].some(item => contains(item, path) || contains(path, item))
      || artifacts.some(item => contains(item, path) || contains(path, item))) fail('UNSAFE_PATH', 'Artifact directory overlaps protected paths');
    await checkedDirectory(path);
    await inspectTree(path, true);
    artifactMounts.push(await mount(path, '--bind'));
    artifacts.push(path);
  }
  await inspectTree(repo, false, hidden);
  const stage = await mkdtemp(join(tmpdir(), 'dhr-verification-view-'));
  await chmod(stage, 0o700);
  let mayCleanup = true;
  try {
  const mirror = join(stage, 'repo');
  await cp(repo, mirror, { recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
    filter: source => ![...hidden].some(path => contains(path, source)) });
  // Copying does not claim an atomic host filesystem snapshot: exact captured bytes
  // are checked before the command can see this private, read-only view.
  const mirrorHidden = new Set([...hidden].map(path => join(mirror, relative(repo, path))));
  if (options.expectedFiles) await verifyMirror(mirror, options.expectedFiles, mirrorHidden);
  for (const path of mirrorHidden) await mkdir(path, { recursive: true, mode: 0o700 });
  const frozenPaths = new Set<string>();
  const frozenMounts: string[] = [];
  for (const [index, frozen] of (options.frozenInputs ?? []).entries()) {
    if (!repoPath(frozen.path) || !(frozen.bytes instanceof Uint8Array) || frozenPaths.has(frozen.path)) fail('UNSAFE_PATH', 'Invalid frozen input');
    frozenPaths.add(frozen.path);
    const target = join(repo, frozen.path);
    if ([...hidden, ...artifacts].some(path => contains(path, target) || contains(target, path))) fail('UNSAFE_PATH', 'Frozen inputs overlap protected or writable paths');
    const mirrorTarget = join(mirror, frozen.path);
    // Walk/create only in the private copy; never create a missing baseline file in the host repository.
    let parent = mirror;
    for (const part of frozen.path.split('/').slice(0, -1)) {
      parent = join(parent, part);
      await mkdir(parent, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      await checkedDirectory(parent);
    }
    const existing = await lstat(mirrorTarget).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing && !existing.isFile()) fail('UNSAFE_PATH', 'Frozen target is not a regular file');
    if (!existing) await writeFile(mirrorTarget, '', { flag: 'wx', mode: 0o600 });
    const source = join(stage, `frozen-${index}`);
    await writeFile(source, frozen.bytes, { flag: 'wx', mode: 0o600 });
    frozenMounts.push('--ro-bind', source, target);
  }
  const mirrorMount = await mount(mirror);
  mounts.push({ ...mirrorMount, destination: repo }, ...artifactMounts);
  const args = ['--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-net', '--unshare-uts', '--unshare-cgroup',
    '--disable-userns', '--assert-userns-disabled', '--die-with-parent', '--as-pid-1', '--new-session', '--cap-drop', 'ALL',
    '--clearenv', '--tmpfs', '/tmp', '--dir', '/tmp/dhr-home', '--proc', '/proc', '--dev', '/dev', ...provider.links];
  const tail: string[] = [...frozenMounts];
  tail.push('--remount-ro', '/', '--setenv', 'HOME', '/tmp/dhr-home', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', provider.path,
    '--setenv', 'LANG', 'C.UTF-8', ...environment(options.environment), '--chdir', cwd, '--');
  const startedAt = new Date().toISOString();
  mayCleanup = false;
  const raw = await controller(provider, { binary: provider.binary.path, python: provider.python.path, args, mounts, tail,
    argv: options.argv, timeoutMs: options.timeoutMs }, options.signal);
  mayCleanup = raw.quiescence === 'confirmed';
  await unchanged(provider.binary);
  await unchanged(provider.python);
  for (const path of artifacts) { await checkedDirectory(path); await inspectTree(path, true); }
  const finishedAt = new Date().toISOString();
  if (typeof raw.error === 'string') {
    const code = ['PROVIDER_UNAVAILABLE', 'OUTPUT_LIMIT', 'QUIESCENCE_UNKNOWN'].includes(raw.error)
      ? raw.error as SandboxErrorCode : 'QUIESCENCE_UNKNOWN';
    const diagnostic = raw.error === 'PROVIDER_UNAVAILABLE' && typeof raw.stderr === 'string'
      ? Buffer.from(raw.stderr, 'base64').toString('utf8').slice(0, 4096) : '';
    fail(code, String(raw.message ?? raw.error) + (diagnostic ? `: ${diagnostic}` : ''));
  }
  const evidence = raw.evidence as Record<string, unknown> | undefined;
  if (raw.quiescence !== 'confirmed' || !Number.isInteger(raw.exitCode) || !['exited', 'timeout', 'aborted'].includes(String(raw.termination))
    || (raw.termination === 'exited' && raw.commandReleased !== true)
    || typeof raw.stdout !== 'string' || typeof raw.stderr !== 'string' || !evidence || evidence.pidfdBound !== true
    || !Number.isInteger(evidence.initPid) || !Number.isInteger(evidence.monitorPid) || typeof evidence.initStartTime !== 'string'
    || typeof evidence.namespaceIds !== 'object' || evidence.namespaceIds === null) fail('QUIESCENCE_UNKNOWN', 'Incomplete controller evidence');
  return { stdout: Buffer.from(raw.stdout, 'base64'), stderr: Buffer.from(raw.stderr, 'base64'), exitCode: raw.exitCode as number,
    startedAt, finishedAt, termination: raw.termination as SandboxResult['termination'], quiescence: 'confirmed',
    namespaceEvidence: { providerSha256: provider.binary.sha256, controllerSha256: digest(SANDBOX_CONTROL), pythonSha256: provider.python.sha256,
      monitorPid: evidence.monitorPid as number, initPid: evidence.initPid as number, initStartTime: evidence.initStartTime,
      namespaceIds: evidence.namespaceIds as Record<string, number>, pidfdBound: true, asPid1: true, monitorWaited: true } };
  } finally {
    // A potentially live namespace may still reference these inputs. Preserve them
    // on unknown quiescence for explicit recovery/diagnosis instead of guessing.
    if (mayCleanup) await rm(stage, { recursive: true, force: true });
  }
}

function controller(provider: Provider, config: unknown, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(provider.python.path, ['-I', '-S', '-c', SANDBOX_CONTROL], { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let length = 0;
    let overflow = false;
    const cancel = (): void => { if (!child.stdin.destroyed) child.stdin.write('cancel\n'); };
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length <= MAX_CONTROLLER_OUTPUT) output.push(chunk);
      else { overflow = true; cancel(); }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (errors.reduce((sum, item) => sum + item.length, 0) < 65_536) errors.push(chunk); });
    child.stdin.on('error', () => { /* Controller exit is classified from its final record. */ });
    child.on('error', error => { signal?.removeEventListener('abort', cancel); reject(new SandboxError('PROVIDER_UNAVAILABLE', error.message)); });
    child.on('close', () => {
      signal?.removeEventListener('abort', cancel);
      if (overflow) return reject(new SandboxError('QUIESCENCE_UNKNOWN', 'Controller output limit exceeded'));
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid controller record');
        resolvePromise(parsed as Record<string, unknown>);
      } catch {
        reject(new SandboxError('QUIESCENCE_UNKNOWN', `No complete controller evidence: ${Buffer.concat(errors).toString('utf8')}`));
      }
    });
    child.stdin.write(JSON.stringify({ ...config as Record<string, unknown>, cancelled: signal?.aborted === true }) + '\n');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
