import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { TaskExecutionRequest, TaskExecutionResult } from '@dev-harness-runtime/contracts';
import { createWorkerTaskBridgePolicy, HostNamespaceError, runIsolatedModelHost, WorkerReadView, type HostNamespaceResult,
  type HostStartEvidence, type IsolatedModelHostResult, type WorkerReadCatalog } from '@dev-harness-runtime/core';
import { decodeFreshDshExecution } from './decode.js';

export class DshConfinedSessionError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'PROVIDER_UNAVAILABLE' | 'EXECUTION_FAILED' | 'AUTHORIZATION_VIOLATION', message: string) {
    super(message); this.name = 'DshConfinedSessionError';
  }
}

export interface DshConfinedSessionInput {
  readonly dshEntry: string;
  readonly profileDirectory: string;
  readonly bubblewrap: string;
  readonly nodeBinary: string;
  readonly apiKey: string;
  /** SHA-256 of the reviewed, self-contained DSH plugin entry. */
  readonly pluginSha256: string;
  readonly upstreamProxy?: string;
  readonly request: TaskExecutionRequest;
  readonly readCatalog: WorkerReadCatalog;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly log: (stream: 'stdout' | 'stderr' | 'events', bytes: Uint8Array) => Promise<void>;
  readonly recordHostStart: (evidence: HostStartEvidence) => Promise<void>;
}

export interface DshConfinedSessionOutput {
  readonly sessionId: string;
  readonly result: TaskExecutionResult;
  readonly proposals: readonly { path: string; content: string | null }[];
  readonly namespaceEvidence: HostNamespaceResult['evidence'];
  readonly brokerAudit: IsolatedModelHostResult['brokerAudit'];
}

const maxMirrorBytes = 64 * 1024 * 1024;
const setup = String.raw`
import { cpSync, mkdirSync } from 'node:fs';
if (process.pid !== 1 || process.argv.length !== 3) process.exit(125);
mkdirSync('/dhr/home/profiles', { recursive: true });
cpSync('/dhr/profile-source', '/dhr/home/profiles/headless', { recursive: true, dereference: true });
process.execve('/dhr/dsh-node', ['/dhr/dsh-node', '/dhr/dsh-package/lib/bin.js', '--profile', 'headless', process.argv[2]], process.env);
`;
const fail = (code: DshConfinedSessionError['code'], message: string): never => { throw new DshConfinedSessionError(code, message); };
const inside = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}${sep}`);
const absolute = (path: string): boolean => isAbsolute(path) && normalize(path) === path && !path.includes('\0');

async function hostInputs(input: DshConfinedSessionInput): Promise<{ packageRoot: string; profileDirectory: string }> {
  if (![input.dshEntry, input.profileDirectory, input.bubblewrap, input.nodeBinary, input.request.repoRoot]
    .every((path) => absolute(path)) || basename(input.dshEntry) !== 'bin.js'
    || basename(dirname(input.dshEntry)) !== 'lib'
    || !input.apiKey || input.apiKey.length > 8192 || input.apiKey.includes('\0')
    || !/^[a-f0-9]{64}$/u.test(input.pluginSha256)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000
    || input.signal.aborted || !input.prompt || Buffer.byteLength(input.prompt, 'utf8') > 1024 * 1024) {
    fail('INVALID_ARGUMENT', 'DSH host needs fixed paths, a bounded prompt, a live signal and trusted model credentials');
  }
  const packageRoot = dirname(dirname(input.dshEntry));
  const [resolvedEntry, resolvedPackage, resolvedProfile] = await Promise.all([
    realpath(input.dshEntry), realpath(packageRoot), realpath(input.profileDirectory),
  ]);
  if (resolvedEntry !== input.dshEntry || resolvedPackage !== packageRoot || resolvedProfile !== input.profileDirectory
    || inside(input.request.repoRoot, packageRoot) || inside(input.request.repoRoot, resolvedProfile)) {
    fail('INVALID_ARGUMENT', 'DSH host package and profile must be canonical and outside the project');
  }
  const [pkg, profile, entryStat, profileStat, pluginBytes] = await Promise.all([
    readFile(join(packageRoot, 'package.json'), 'utf8'), readFile(join(resolvedProfile, 'package.json'), 'utf8'),
    lstat(input.dshEntry), lstat(resolvedProfile),
    readFile(join(resolvedProfile, 'node_modules/dev-harness-runtime/lib/index.js')),
  ]);
  let host: unknown; let installed: unknown;
  try { host = JSON.parse(pkg); installed = JSON.parse(profile); }
  catch { return fail('PROVIDER_UNAVAILABLE', 'DSH package or profile metadata is malformed'); }
  if (!host || typeof host !== 'object' || !('version' in host) || host.version !== '0.1.5-rc.1'
    || !installed || typeof installed !== 'object' || !('dependencies' in installed)
    || !installed.dependencies || typeof installed.dependencies !== 'object'
    || Object.keys(installed.dependencies).join(',') !== 'dev-harness-runtime'
    || !('dsh' in installed) || !installed.dsh || typeof installed.dsh !== 'object'
    || !('profile' in installed.dsh) || !installed.dsh.profile || typeof installed.dsh.profile !== 'object'
    || !('bundles' in installed.dsh.profile) || !Array.isArray(installed.dsh.profile.bundles)
    || installed.dsh.profile.bundles.join(',') !== '@deepseek-ai/dsh-base,@deepseek-ai/dsh-headless,dev-harness-runtime'
    || createHash('sha256').update(pluginBytes).digest('hex') !== input.pluginSha256
    || !entryStat.isFile() || entryStat.isSymbolicLink()
    || !profileStat.isDirectory() || profileStat.isSymbolicLink()) {
    fail('PROVIDER_UNAVAILABLE', 'DSH host or isolated profile differs from the verified target');
  }
  return { packageRoot, profileDirectory: resolvedProfile };
}

async function checkPrivateProfile(root: string): Promise<void> {
  let files = 0; let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        fail('PROVIDER_UNAVAILABLE', 'DSH profile contains a link or special file');
      }
      if (stat.isDirectory()) await walk(path);
      else { files++; bytes += stat.size; }
      if (files > 10_000 || bytes > 64 * 1024 * 1024) {
        fail('PROVIDER_UNAVAILABLE', 'DSH profile exceeds its private copy boundary');
      }
    }
  };
  await walk(root);
}

async function snapshotMirror(root: string, catalog: WorkerReadCatalog): Promise<void> {
  const view = await WorkerReadView.create(catalog);
  let total = 0;
  for (const file of catalog.files) {
    const bytes = await view.readBytes(file.path);
    total += bytes.byteLength;
    if (total > maxMirrorBytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      fail('AUTHORIZATION_VIOLATION', 'DSH frozen mirror differs from the Core read catalog');
    }
    const target = join(root, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o400 });
  }
}

/** A confined DSH transport. Core still owns proposal application and the final authorization receipt. */
export async function runConfinedDshSession(input: DshConfinedSessionInput): Promise<DshConfinedSessionOutput> {
  const { packageRoot } = await hostInputs(input);
  const request = input.request;
  if (input.readCatalog.repoRoot !== request.repoRoot || input.readCatalog.runId !== request.runId
    || input.readCatalog.requestId !== request.requestId || input.readCatalog.snapshotHash !== request.snapshotHash
    || request.env.DEV_HARNESS_WORKER !== '1' || request.env.DEV_HARNESS_ADAPTER !== 'dsh') {
    fail('AUTHORIZATION_VIOLATION', 'DSH read catalog or Worker markers differ from the Core request');
  }
  const stage = await mkdtemp(join(tmpdir(), 'dhr-dsh-confined-'));
  const mirror = join(stage, 'mirror');
  const sessions = join(stage, 'sessions');
  const setupPath = join(stage, 'setup.mjs');
  const policyPath = join(stage, 'policy.json');
  const profileCopy = join(stage, 'profile');
  let retainStage = false;
  try {
    await mkdir(mirror, { mode: 0o700 });
    await mkdir(sessions, { mode: 0o700 });
    await cp(input.profileDirectory, profileCopy, { recursive: true, dereference: false });
    await checkPrivateProfile(profileCopy);
    await hostInputs({ ...input, profileDirectory: profileCopy });
    await snapshotMirror(mirror, input.readCatalog);
    await writeFile(setupPath, setup, { flag: 'wx', mode: 0o400 });
    const policy = createWorkerTaskBridgePolicy(request, input.readCatalog);
    await writeFile(policyPath, `${JSON.stringify(policy)}\n`, { flag: 'wx', mode: 0o400 });
    const raw = await runIsolatedModelHost({
      bubblewrap: input.bubblewrap, nodeBinary: input.nodeBinary,
      executable: '/dhr/dsh-node', argv: ['/dhr/setup.mjs', input.prompt],
      cwd: request.repoRoot, timeoutMs: input.timeoutMs, signal: input.signal,
      environment: { HOME: '/dhr/home', DSH_HOME: '/dhr/home', PATH: '/usr/bin', LANG: 'C.UTF-8',
        DEEPSEEK_API_KEY: input.apiKey, DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_MODE: 'DISABLED',
        NODE_USE_ENV_PROXY: '1', DHR_WORKER_POLICY_PATH: '/dhr/policy.json', ...request.env },
      tmpfs: ['/dhr/home'], sessionEvidenceDirectory: sessions,
      mounts: [
        { source: input.nodeBinary, destination: '/dhr/dsh-node' },
        { source: packageRoot, destination: '/dhr/dsh-package' },
        { source: profileCopy, destination: '/dhr/profile-source' },
        { source: mirror, destination: request.repoRoot },
        { source: setupPath, destination: '/dhr/setup.mjs' },
        { source: policyPath, destination: '/dhr/policy.json' },
        { source: await realpath('/etc/ssl/certs'), destination: '/etc/ssl/certs' },
        { source: await realpath('/etc/resolv.conf'), destination: '/etc/resolv.conf' },
      ],
      onStarted: input.recordHostStart,
    }, { allowedHosts: ['api.deepseek.com'], ...(input.upstreamProxy ? { upstreamProxy: input.upstreamProxy } : {}) });
    await input.log('stdout', raw.stdout);
    await input.log('stderr', raw.stderr);
    if (raw.termination === 'aborted' && input.signal.aborted) {
      throw new DOMException('DSH was cancelled after confirmed host quiescence', 'AbortError');
    }
    if (raw.termination !== 'exited' || raw.exitCode !== 0) {
      fail('EXECUTION_FAILED', 'Confined DSH did not finish its headless turn');
    }
    if (raw.brokerAudit.allowedHosts.length !== 1 || raw.brokerAudit.allowedHosts[0] !== 'api.deepseek.com'
      || Object.keys(raw.brokerAudit.connected).some((host) => host !== 'api.deepseek.com')
      || !raw.brokerAudit.connected['api.deepseek.com'] || raw.brokerAudit.denied !== 0) {
      fail('AUTHORIZATION_VIOLATION', 'DSH model traffic did not use the exact-host broker');
    }
    const decoded = await decodeFreshDshExecution({ dshEntry: input.dshEntry, sessionsRoot: sessions,
      request, log: (bytes) => input.log('events', bytes) });
    return { ...decoded, namespaceEvidence: raw.evidence, brokerAudit: raw.brokerAudit };
  } catch (error) {
    retainStage = error instanceof HostNamespaceError && error.code === 'QUIESCENCE_UNKNOWN';
    throw error;
  } finally {
    if (!retainStage) await rm(stage, { recursive: true, force: true });
  }
}
