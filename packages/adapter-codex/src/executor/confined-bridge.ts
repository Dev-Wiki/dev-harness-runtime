import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { WorkerReadCatalog } from '@dev-harness-runtime/core';
import { CodexReadError, CodexReadView } from './read-view.js';

export interface ConfinedCodexBridgeInput {
  /** Trusted Linux bubblewrap executable, selected by the controller. */
  readonly bubblewrap: string;
  readonly nodeBinary: string;
  readonly serverBundle: string;
  readonly policyPath: string;
  readonly readCatalog: WorkerReadCatalog;
  /** The outer Codex host is already a monitored namespace PID 1. */
  readonly parentContained?: boolean;
}

export interface ConfinedCodexBridgeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Exact outer-namespace mount sources needed when Codex itself runs in a private mount namespace. */
  readonly hostSources: readonly string[];
  readonly repoMirror: string;
  readonly close: () => Promise<void>;
}

const maxFile = 16 * 1024 * 1024;
const maxMirror = 64 * 1024 * 1024;
const fail = (message: string): never => { throw new CodexReadError('INVALID_POLICY', message); };
const fingerprint = (stat: { dev: bigint; ino: bigint; mode: bigint; nlink: bigint; size: bigint;
  mtimeNs: bigint; ctimeNs: bigint }): string =>
  [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

async function regular(path: string, executable = false): Promise<string> {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) fail('Bridge input path must be absolute');
  const canonical = await realpath(path);
  if (canonical !== path) fail('Bridge input path must be canonical');
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o6022n) !== 0n
    || ![0n, BigInt(process.getuid?.() ?? -1)].includes(stat.uid)
    || (executable && (stat.mode & 0o111n) === 0n)) fail('Bridge input must be a trusted regular file');
  return path;
}

async function capturedBytes(root: string, path: string, expectedHash: string): Promise<Buffer> {
  let parent = root;
  for (const part of path.split('/').slice(0, -1)) {
    parent = join(parent, part);
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Snapshot path traverses an unsafe directory');
  }
  const source = join(root, ...path.split('/'));
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxFile)) {
    fail('Snapshot source is not a bounded single-link file');
  }
  const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (fingerprint(await file.stat({ bigint: true })) !== fingerprint(before)) fail('Snapshot source changed before reading');
    const bytes = await file.readFile();
    const after = await lstat(source, { bigint: true });
    if (bytes.byteLength > maxFile || fingerprint(after) !== fingerprint(before)
      || fingerprint(await file.stat({ bigint: true })) !== fingerprint(before)
      || createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
      fail('Snapshot source differs from the Core catalog');
    }
    return bytes;
  } finally { await file.close(); }
}

function parentDirectories(path: string): string[] {
  const dirs: string[] = [];
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    dirs.push(current);
  }
  return dirs;
}

/** Build an ephemeral, catalog-only filesystem for the MCP child. This is not a host-tree quiescence receipt. */
export async function createConfinedCodexBridge(input: ConfinedCodexBridgeInput): Promise<ConfinedCodexBridgeLaunch> {
  if (process.platform !== 'linux') fail('Confined Codex bridge requires Linux');
  const view = await CodexReadView.create(input.readCatalog);
  const [binary, node, bundle, policy] = await Promise.all([
    regular(input.bubblewrap, true), regular(input.nodeBinary, true),
    regular(input.serverBundle), regular(input.policyPath),
  ]);
  const stage = await mkdtemp(join(tmpdir(), 'dhr-codex-confined-'));
  try {
    await chmod(stage, 0o700);
    const mirror = join(stage, 'repo');
    await mkdir(mirror, { mode: 0o700 });
    let total = 0;
    for (const entry of view.policy.files) {
      const bytes = await capturedBytes(view.policy.repoRoot, entry.path, entry.sha256);
      total += bytes.byteLength;
      if (total > maxMirror) fail('Snapshot mirror exceeds 64 MiB');
      const target = join(mirror, ...entry.path.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o400 });
    }
    const args = [
      '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-net', '--unshare-uts', '--unshare-cgroup',
      '--disable-userns', '--assert-userns-disabled', ...(input.parentContained ? [] : ['--die-with-parent']),
      '--as-pid-1', '--new-session',
      '--cap-drop', 'ALL', '--clearenv', '--ro-bind', '/usr', '/usr',
      '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--dir', '/dhr',
      ...parentDirectories(view.policy.repoRoot).flatMap((dir) => ['--dir', dir]),
      '--ro-bind', mirror, view.policy.repoRoot,
      '--ro-bind', node, '/dhr/node', '--ro-bind', bundle, '/dhr/server.mjs', '--ro-bind', policy, '/dhr/policy.json',
      '--remount-ro', '/', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
      '--setenv', 'PATH', '/usr/bin', '--setenv', 'LANG', 'C.UTF-8', '--chdir', view.policy.repoRoot,
      '--', '/dhr/node', '/dhr/server.mjs', '/dhr/policy.json',
    ];
    return { command: binary, args, hostSources: [binary, node, bundle, policy, mirror], repoMirror: mirror,
      close: async () => { await rm(stage, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
