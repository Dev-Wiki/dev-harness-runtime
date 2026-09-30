import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseContract, type ProtocolSource } from '@dev-harness-runtime/contracts';
import { createLinuxSandbox, prepareDeclaredPlanningTask, Registry,
  type RuntimeAdapter, type RuntimeServices } from '@dev-harness-runtime/core';
import { codexConventionalCommitPolicy } from '@dev-harness-runtime/adapter-codex';
import { createDshRuntimeAdapter, DshRuntimeError } from './runtime-adapter.js';

const execute = promisify(execFile);
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/u;
const packagePaths = { workerSkill: 'skills/worker/SKILL.md', runtimeBundle: 'lib/dhr.js',
  pluginBundle: 'lib/index.js' } as const;
type PackageEntry = { path: string; sha256: string };
export interface DshPackageSource {
  readonly protocolSource: ProtocolSource;
  readonly sourceHash: string;
  readonly workerSkill: { readonly bytes: Uint8Array; readonly sha256: string };
  readonly pluginSha256: string;
}
export interface PackagedDshOptions {
  readonly packageRoot: string;
  readonly dshEntry?: string;
  readonly bubblewrapPath?: string;
  readonly profileDirectory?: string;
  readonly apiKey?: string;
  readonly upstreamProxy?: string;
}
function missing(message: string): never { throw new DshRuntimeError('CAPABILITY_MISSING', message); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    missing(`DSH package source requires exactly ${keys.join(', ')}`);
  }
  return value as Record<string, unknown>;
}
async function packageFile(root: string, path: string): Promise<{ path: string; bytes: Buffer }> {
  try {
    let current = root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if (!current.startsWith(`${root}${sep}`)) missing('DSH package source escaped its root');
      const info = await lstat(current);
      if (info.isSymbolicLink()) missing(`DSH package contains a symlink: ${path}`);
    }
    if (!(await lstat(current)).isFile()) missing(`DSH package file is not regular: ${path}`);
    return { path: current, bytes: await readFile(current) };
  } catch (error) {
    if (error instanceof DshRuntimeError) throw error;
    return missing(`DSH package file is unavailable: ${path}`);
  }
}
function packageEntry(value: unknown, expected: string): PackageEntry {
  const entry = record(value, ['path', 'sha256']);
  if (entry.path !== expected || typeof entry.sha256 !== 'string' || !hashPattern.test(entry.sha256)) {
    missing(`DSH package reference is invalid: ${expected}`);
  }
  return entry as PackageEntry;
}

/** Verify locked protocol, Worker Skill, CLI and plugin bytes from the installed package. */
export async function loadDshPackageSource(packageRoot: string): Promise<DshPackageSource> {
  if (!isAbsolute(packageRoot)) missing('DSH package root must be absolute');
  const root = await realpath(packageRoot);
  if (resolve(packageRoot) !== root) missing('DSH package root must be canonical');
  const source = await packageFile(root, 'source.json');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)); }
  catch { return missing('DSH runtime source manifest is not UTF-8 JSON'); }
  const manifest = record(parsed, ['schemaVersion', 'protocolSource', 'workerSkill', 'runtimeBundle', 'pluginBundle']);
  if (manifest.schemaVersion !== 1) missing('Unsupported DSH runtime source version');
  let protocolSource: ProtocolSource;
  try { protocolSource = parseContract('protocolSource', manifest.protocolSource); }
  catch { return missing('DSH package protocol source is invalid'); }
  const entries = Object.entries(packagePaths).map(([name, path]) => packageEntry(manifest[name], path));
  const verified = await Promise.all(entries.map(async (entry) => {
    const file = await packageFile(root, entry.path);
    if (digest(file.bytes) !== entry.sha256) missing(`DSH package byte digest differs: ${entry.path}`);
    return file;
  }));
  return { protocolSource, sourceHash: digest(source.bytes),
    workerSkill: { bytes: verified[0]!.bytes, sha256: entries[0]!.sha256 },
    pluginSha256: entries[2]!.sha256 };
}

async function executable(name: string, explicit?: string): Promise<string> {
  const candidates = explicit === undefined ? (process.env.PATH ?? '').split(delimiter)
    .filter((directory) => isAbsolute(directory)).map((directory) => join(directory, name)) : [explicit];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) missing(`${name} executable path must be absolute`);
    try {
      const canonical = await realpath(candidate);
      const info = await lstat(canonical);
      if (info.isFile()) { await access(canonical, constants.X_OK); return canonical; }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !['ENOENT', 'EACCES'].includes(String(error.code))) throw error;
    }
  }
  return missing(`Trusted ${name} executable is unavailable`);
}

/** Installed package code supplies trusted Runtime services; project files only declare bounded Tasks. */
export async function createPackagedDshServices(options: PackagedDshOptions): Promise<RuntimeServices> {
  if (process.platform !== 'linux') missing('Confined DSH Runtime currently requires Linux');
  try {
    const source = await loadDshPackageSource(options.packageRoot);
    const [dshEntry, bubblewrap, nodeBinary, gitBinary] = await Promise.all([
      executable('dsh', options.dshEntry), executable('bwrap', options.bubblewrapPath),
      realpath(process.execPath), executable('git', '/usr/bin/git'),
    ]);
    if (!options.apiKey || options.apiKey.length > 8192 || options.apiKey.includes('\0')) missing('DSH model credential is unavailable');
    const profileDirectory = await realpath(options.profileDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'),
      'profiles', 'headless'));
    const [{ stdout: version }, { stdout: gitVersion }] = await Promise.all([
      execute(dshEntry, ['--version'], { encoding: 'utf8', timeout: 10_000 }),
      execute(gitBinary, ['--version'], { encoding: 'utf8', timeout: 10_000 }),
    ]);
    if (version.trim() !== '0.2.0-rc.2') missing('DSH launcher version differs from the verified 0.2.0-rc.2 target');
    const hostHashes = await Promise.all([dshEntry, bubblewrap, nodeBinary, gitBinary]
      .map(async (path) => digest(await readFile(path))));
    const configHash = digest(JSON.stringify({ source: source.sourceHash, dshEntry, bubblewrap, nodeBinary,
      gitBinary, hostHashes, profileDirectory, pluginSha256: source.pluginSha256,
      upstreamProxy: options.upstreamProxy ?? '', targetVersion: version.trim() }));
    const toolchain = dirname(nodeBinary);
    const sandbox = await createLinuxSandbox({ binaryPath: bubblewrap,
      toolchainMounts: [toolchain], path: `${toolchain}:/usr/bin:/bin` });
    const adapter = createDshRuntimeAdapter({ dshEntry, profileDirectory, bubblewrap, nodeBinary,
      apiKey: options.apiKey, pluginSha256: source.pluginSha256,
      configHash, gitVersion: gitVersion.trim().replace(/^git version\s+/u, ''),
      targetVersion: version.trim(), timeoutMs: 600_000,
      ...(options.upstreamProxy ? { upstreamProxy: options.upstreamProxy } : {}) });
    const adapters = new Registry<RuntimeAdapter>(); adapters.register(adapter);
    return { protocolSource: source.protocolSource, adapterConfigHash: configHash,
      workerSkill: source.workerSkill, adapters, acceptance: { sandbox },
      git: { gitBinary, policy: codexConventionalCommitPolicy },
      async prepareTask(input) {
        const prepared = await prepareDeclaredPlanningTask(input);
        if (prepared.verificationPlan.manual.length > 0) {
          missing('DSH package has no trusted manual acceptance channel for this Task');
        }
        return prepared;
      } };
  } catch (error) {
    if (error instanceof DshRuntimeError) throw error;
    return missing(`DSH host prerequisites are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
