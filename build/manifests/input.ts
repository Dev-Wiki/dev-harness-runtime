import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  isRepoPath, parseContract, type BuildSource, type PluginBuildInput,
} from '@dev-harness-runtime/contracts';

const git = promisify(execFile);
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** Canonical, byte-order-independent JSON used for every build input and receipt digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export async function readPinnedFile(root: string, path: string): Promise<Uint8Array> {
  if (!isRepoPath(path)) throw new Error(`Unsafe source path: ${path}`);
  const base = await realpath(root);
  let cursor = base;
  for (const part of path.split('/')) {
    cursor = resolve(cursor, part);
    if (!cursor.startsWith(`${base}${sep}`)) throw new Error(`Source path escapes root: ${path}`);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Source symlink refused: ${path}`);
  }
  if (!(await lstat(cursor)).isFile()) throw new Error(`Source is not a file: ${path}`);
  return readFile(cursor);
}

export interface SourceEvidence {
  readonly inputHash: string;
  readonly sourceCommit: string;
  readonly localUnversioned: boolean;
  readonly protocolLockHash: string;
}

/** Verify pinned provenance and actual bytes before any generator runs. */
export async function verifyBuildInput(
  root: string, inputValue: unknown, sourceRoots: Readonly<Record<string, string>>,
): Promise<{ input: PluginBuildInput; evidence: SourceEvidence }> {
  const input = parseContract('pluginBuildInput', inputValue);
  const lockBytes = await readPinnedFile(root, 'protocol-lock.json');
  const lock = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lockBytes)) as Record<string, unknown>;
  if (lock.schemaVersion !== 1 || lock.repository !== input.protocolSource.repository
    || lock.commit !== input.protocolSource.commit || lock.protocolVersion !== input.protocolSource.version
    || canonicalJson(lock.files) !== canonicalJson(input.protocolSource.files)) {
    throw new Error('Protocol source differs from protocol-lock.json');
  }
  const sourceRecords: BuildSource[] = [
    ...input.skills.map((skill) => skill.source), input.runtimeBundle.source, input.adapterBundle.source,
  ];
  const repositories = new Map<string, { root: string; commit: string; dirty: boolean }>();
  for (const source of sourceRecords) {
    const sourceRoot = sourceRoots[source.repository];
    if (!sourceRoot) throw new Error(`Source repository has no explicit checkout: ${source.repository}`);
    const earlier = repositories.get(source.repository);
    if (earlier && earlier.commit !== source.commit) throw new Error('One source repository declares conflicting commits');
    if (!earlier) {
      const actualRoot = await realpath(sourceRoot);
      const { stdout: head } = await git('git', ['-C', actualRoot, 'rev-parse', 'HEAD']);
      if (head.trim() !== source.commit) throw new Error(`Source checkout commit drift: ${source.repository}`);
      const { stdout: status } = await git('git', ['-C', actualRoot, 'status', '--porcelain', '--untracked-files=all']);
      repositories.set(source.repository, { root: actualRoot, commit: source.commit, dirty: status !== '' });
    }
    const sourceBytes = await readPinnedFile(sourceRoot, source.path);
    if (source.path.endsWith('package.json')) {
      const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)) as { version?: unknown };
      if (manifest.version !== source.version) throw new Error(`Source package version drift: ${source.repository}`);
    }
  }
  const protocolRoot = sourceRoots[input.protocolSource.repository];
  if (!protocolRoot) throw new Error('Protocol source has no explicit checkout');
  const { stdout: protocolHead } = await git('git', ['-C', protocolRoot, 'rev-parse', 'HEAD']);
  if (protocolHead.trim() !== input.protocolSource.commit) throw new Error('Protocol checkout commit drift');
  const { stdout: protocolStatus } = await git('git', ['-C', protocolRoot, 'status', '--porcelain', '--untracked-files=all']);
  if (protocolStatus !== '') throw new Error('Protocol checkout must be clean');
  for (const file of input.protocolSource.files) {
    const bytes = await readPinnedFile(protocolRoot, file.path);
    if (sha256(bytes) !== file.sha256) throw new Error(`Protocol source digest drift: ${file.path}`);
  }
  for (const skill of input.skills) {
    const bytes = await readPinnedFile(repositories.get(skill.source.repository)!.root, skill.source.path);
    if (sha256(bytes) !== skill.sha256) throw new Error(`Skill source digest drift: ${skill.name}`);
    if (skill.path !== skill.source.path) throw new Error(`Skill source path differs from locked path: ${skill.name}`);
  }
  const bundlePairs = [input.runtimeBundle, input.adapterBundle];
  for (const bundle of bundlePairs) {
    const checkout = repositories.get(bundle.source.repository)!;
    const bytes = await readPinnedFile(root, bundle.path);
    if (sha256(bytes) !== bundle.sha256) throw new Error(`Bundle digest drift: ${bundle.path}`);
    if (bundle.source.path !== 'package.json') {
      // A source path may identify a package manifest or versioned source file.
      await readPinnedFile(checkout.root, bundle.source.path);
    }
  }
  for (const license of input.metadata.licenseRefs) {
    const bytes = await readPinnedFile(root, license.path);
    if (sha256(bytes) !== license.sha256) throw new Error(`License reference digest drift: ${license.path}`);
  }
  const rootRepo = 'https://github.com/Dev-Wiki/dev-harness-runtime';
  const rootHead = await git('git', ['-C', root, 'rev-parse', 'HEAD']);
  const rootStatus = await git('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all']);
  const localUnversioned = rootStatus.stdout !== '' || [...repositories.entries()].some(([repo, info]) =>
    repo === rootRepo ? info.dirty : false);
  return {
    input,
    evidence: {
      inputHash: sha256(canonicalJson(input)), sourceCommit: rootHead.stdout.trim(), localUnversioned,
      protocolLockHash: sha256(lockBytes),
    },
  };
}
