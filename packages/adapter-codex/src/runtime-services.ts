import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseContract, type ProtocolSource } from '@dev-harness-runtime/contracts';
import { createLinuxSandbox, prepareDeclaredPlanningTask, Registry, type RuntimeAdapter, type RuntimeServices } from '@dev-harness-runtime/core';
import { CodexRuntimeError, createCodexRuntimeAdapter } from './runtime-adapter.js';
import { codexConventionalCommitPolicy } from './commit-policy.js';

const execute = promisify(execFile);
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/u;
const packagePaths = {
  workerSkill: 'skills/worker/SKILL.md', runtimeBundle: 'runtime/dhr.js', adapterBundle: 'runtime/adapter.js',
} as const;
type PackageEntry = { path: string; sha256: string };
export interface CodexPackageSource {
  readonly protocolSource: ProtocolSource;
  readonly sourceHash: string;
  readonly workerSkill: { readonly bytes: Uint8Array; readonly sha256: string };
  readonly adapterBundlePath: string;
}
export interface PackagedCodexOptions {
  readonly packageRoot: string;
  readonly binaryPath?: string;
  readonly bubblewrapPath?: string;
  readonly authFile?: string;
  readonly modelProxy?: { readonly HTTPS_PROXY?: string; readonly HTTP_PROXY?: string };
}
const missing = (message: string): never => { throw new CodexRuntimeError('CAPABILITY_MISSING', message); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    missing(`Codex package source requires exactly ${keys.join(', ')}`);
  }
  return value as Record<string, unknown>;
}
async function packageFile(root: string, path: string): Promise<{ path: string; bytes: Buffer }> {
  try {
    let current = root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if (!current.startsWith(`${root}${sep}`)) missing('Codex package source escaped its root');
      const info = await lstat(current);
      if (info.isSymbolicLink()) missing(`Codex package contains a symlink: ${path}`);
    }
    if (!(await lstat(current)).isFile()) missing(`Codex package file is not regular: ${path}`);
    return { path: current, bytes: await readFile(current) };
  } catch (error) {
    if (error instanceof CodexRuntimeError) throw error;
    return missing(`Codex package file is unavailable: ${path}`);
  }
}
function packageEntry(value: unknown, expected: string): PackageEntry {
  const entry = record(value, ['path', 'sha256']);
  if (entry.path !== expected || typeof entry.sha256 !== 'string' || !hashPattern.test(entry.sha256)) {
    missing(`Codex package reference is invalid: ${expected}`);
  }
  return entry as PackageEntry;
}

/** Verify the installed package's locked inputs before constructing any executable service. */
export async function loadCodexPackageSource(packageRoot: string): Promise<CodexPackageSource> {
  if (!isAbsolute(packageRoot)) missing('Codex plugin root must be absolute');
  const root = await realpath(packageRoot);
  if (resolve(packageRoot) !== root) missing('Codex plugin root must be canonical');
  const source = await packageFile(root, 'runtime/source.json');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)); }
  catch { return missing('Codex runtime source manifest is not UTF-8 JSON'); }
  const manifest = record(parsed, ['schemaVersion', 'protocolSource', 'workerSkill', 'runtimeBundle', 'adapterBundle']);
  if (manifest.schemaVersion !== 1) missing('Unsupported Codex runtime source version');
  let protocolSource: ProtocolSource;
  try { protocolSource = parseContract('protocolSource', manifest.protocolSource); }
  catch { return missing('Codex package protocol source is invalid'); }
  const entries = Object.entries(packagePaths).map(([name, path]) => packageEntry(manifest[name], path));
  const verified = await Promise.all(entries.map(async (entry) => {
    const file = await packageFile(root, entry.path);
    if (digest(file.bytes) !== entry.sha256) missing(`Codex package byte digest differs: ${entry.path}`);
    return file;
  }));
  return { protocolSource, sourceHash: digest(source.bytes),
    workerSkill: { bytes: verified[0]!.bytes, sha256: entries[0]!.sha256 },
    adapterBundlePath: verified[2]!.path };
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

/** This factory is installed package code; project files can only supply the bounded Task declaration. */
export async function createPackagedCodexServices(options: PackagedCodexOptions): Promise<RuntimeServices> {
  if (process.platform !== 'linux') missing('Confined Codex Runtime currently requires Linux');
  try {
    const source = await loadCodexPackageSource(options.packageRoot);
    const [binary, bubblewrap, nodeBinary, gitBinary] = await Promise.all([
      executable('codex', options.binaryPath), executable('bwrap', options.bubblewrapPath),
      realpath(process.execPath), executable('git', '/usr/bin/git'),
    ]);
    const authFile = await realpath(options.authFile ?? join(homedir(), '.codex', 'auth.json'));
    const auth = await lstat(authFile);
    if (!auth.isFile() || auth.isSymbolicLink() || (auth.mode & 0o077) !== 0) missing('Codex auth must be a private regular file');
    const [{ stdout: version }, { stdout: gitVersion }] = await Promise.all([
      execute(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }),
      execute(gitBinary, ['--version'], { encoding: 'utf8', timeout: 10_000 }),
    ]);
    const hostHashes = await Promise.all([binary, bubblewrap, nodeBinary, gitBinary]
      .map(async (path) => digest(await readFile(path))));
    const configHash = digest(JSON.stringify({ source: source.sourceHash, binary, bubblewrap, nodeBinary,
      gitBinary, hostHashes, authFile, modelProxy: options.modelProxy ?? {}, targetVersion: version.trim() }));
    const toolchain = dirname(nodeBinary);
    const sandbox = await createLinuxSandbox({ binaryPath: bubblewrap,
      toolchainMounts: [toolchain], path: `${toolchain}:/usr/bin:/bin` });
    const adapter = createCodexRuntimeAdapter({ binary, bubblewrap, nodeBinary, authFile,
      serverBundle: source.adapterBundlePath, proposalServer: source.adapterBundlePath,
      configHash, gitVersion: gitVersion.trim().replace(/^git version\s+/u, ''), targetVersion: version.trim(),
      timeoutMs: 600_000, ...(options.modelProxy ? { modelProxy: options.modelProxy } : {}) });
    const adapters = new Registry<RuntimeAdapter>(); adapters.register(adapter);
    return { protocolSource: source.protocolSource, adapterConfigHash: configHash,
      workerSkill: source.workerSkill, adapters, acceptance: { sandbox },
      git: { gitBinary, policy: codexConventionalCommitPolicy },
      async prepareTask(input) {
        const prepared = await prepareDeclaredPlanningTask(input);
        if (prepared.verificationPlan.manual.length > 0) {
          missing('Codex package has no trusted manual acceptance channel for this Task');
        }
        return prepared;
      } };
  } catch (error) {
    if (error instanceof CodexRuntimeError) throw error;
    return missing(`Codex host prerequisites are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
