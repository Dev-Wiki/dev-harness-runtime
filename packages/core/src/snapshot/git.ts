import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRepoPath, type Snapshot } from '@dev-harness-runtime/contracts';
import { PlanningError } from '../planning/types.js';

const execute = promisify(execFile);
export type IndexEntry = Snapshot['paths'][number]['index'][number];
export interface GitBoundary {
  repoRoot: string;
  privateGitDir: string;
  head: string;
  branch: string | null;
  objectFormat: 'sha1' | 'sha256';
  indexFingerprint: string;
  indexFlags: { path: string; tag: string }[];
  index: Map<string, IndexEntry[]>;
  headEntries: Map<string, { blob: string; mode: string }>;
  paths: string[];
  stagedPaths: string[];
  conversionFingerprint?: string;
}

/** Read-only Git plumbing. Hooks, fsmonitor, optional index writes and injected environment are disabled. */
export async function readGit(cwd: string, args: readonly string[]): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
  for (const name of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|EXTERNAL_DIFF|DIFF_OPTS|CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+))$/u.test(name)) delete env[name];
  }
  const result = await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-C', cwd, ...args], {
    env, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024,
  });
  return result.stdout;
}

export function decodeGit(buffer: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new PlanningError('INVALID_UTF8', 'Git paths or references contain invalid UTF-8'); }
}

export async function readGitText(cwd: string, args: readonly string[]): Promise<string> {
  return decodeGit(await readGit(cwd, args)).replace(/\r?\n$/u, '');
}

export async function readOptionalGitText(cwd: string, args: readonly string[]): Promise<string | null> {
  try { return await readGitText(cwd, args); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return null;
    throw error;
  }
}

function records(buffer: Buffer): string[] {
  const text = decodeGit(buffer);
  if (text && !text.endsWith('\0')) throw new PlanningError('INVALID_GIT_OUTPUT', 'Expected NUL-terminated Git output');
  return text ? text.slice(0, -1).split('\0') : [];
}

function checkedPath(path: string): string {
  if (!isRepoPath(path) || path.split('/').some((part) => part.toLowerCase() === '.git')) {
    throw new PlanningError('PATH_INVALID', 'Git returned a nonportable or private project path', path);
  }
  return path;
}

export interface ConversionPlan {
  attributes: Map<string, Map<string, string>>;
  autocrlf: string;
  eol: string;
  fingerprint: string;
}

/** Read effective attributes only; never ask the source repository to apply a content filter. */
export async function readConversionPlan(cwd: string, paths: readonly string[]): Promise<ConversionPlan> {
  const autocrlf = await readOptionalGitText(cwd, ['config', '--get', 'core.autocrlf']) ?? 'false';
  const eol = await readOptionalGitText(cwd, ['config', '--get', 'core.eol']) ?? 'native';
  if (!/^(?:true|false|input|0|1|yes|no|on|off)$/iu.test(autocrlf) || !/^(?:lf|crlf|native)$/iu.test(eol)) {
    throw new PlanningError('INVALID_GIT_CONFIG', 'Invalid built-in Git EOL configuration');
  }
  const attributes = new Map<string, Map<string, string>>();
  for (let index = 0; index < paths.length; index += 100) {
    const result = records(await readGit(cwd, ['check-attr', '--all', '-z', '--', ...paths.slice(index, index + 100)]));
    if (result.length % 3 !== 0) throw new PlanningError('INVALID_GIT_OUTPUT', 'Invalid Git attribute output');
    for (let at = 0; at < result.length; at += 3) {
      const path = result[at]!; const name = result[at + 1]!; const value = result[at + 2]!;
      if (name === 'filter' && !['unset', 'unspecified'].includes(value)) {
        throw new PlanningError('UNSUPPORTED_PROJECT_FILTER', 'External content filters cannot be executed by snapshot capture', path);
      }
      const entries = attributes.get(path) ?? new Map<string, string>(); entries.set(name, value); attributes.set(path, entries);
    }
  }
  return { attributes, autocrlf, eol, fingerprint: createHash('sha256').update(JSON.stringify([autocrlf, eol, [...attributes].map(([path, values]) => [path, [...values]])])).digest('hex') };
}

/**
 * Git owns built-in binary/EOL/ident/encoding rules. Execute them in a temporary
 * repository containing only captured bytes, effective attributes and a copied
 * baseline blob, without source/global config, external filters, hooks or helpers.
 * The baseline index matters: Git's auto-CRLF rule consults existing blob content.
 */
export function createBlobNormalizer(source: GitBoundary, plan: ConversionPlan): {
  normalize(path: string, bytes: Buffer, entry: IndexEntry): Promise<string>;
  dispose(): Promise<void>;
} {
  let temporary: string | undefined;
  const isolated = async (args: readonly string[]): Promise<string> => {
    if (!temporary) throw new Error('Normalizer not initialized');
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: join(temporary, 'empty'), GIT_CONFIG_GLOBAL: join(temporary, 'empty'),
      GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
    const result = await execute('git', ['--no-optional-locks', '-C', temporary, '-c', `core.attributesFile=${join(temporary, 'empty')}`, '-c', 'core.fsmonitor=false', ...args], { env, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
    if (result.stderr.length) throw new PlanningError('INVALID_WORKTREE_ENCODING', decodeGit(result.stderr));
    return decodeGit(result.stdout).trim();
  };
  const initialize = async () => {
    if (temporary) return;
    temporary = await mkdtemp(join(tmpdir(), 'dhr-normalize-'));
    await mkdir(join(temporary, '.git', 'objects'), { recursive: true }); await mkdir(join(temporary, '.git', 'refs'));
    await writeFile(join(temporary, '.git', 'HEAD'), 'ref: refs/heads/snapshot\n'); await writeFile(join(temporary, 'empty'), '');
    const format = source.objectFormat === 'sha256' ? '\n[extensions]\nobjectFormat = sha256\n' : '';
    await writeFile(join(temporary, '.git', 'config'), `[core]\nrepositoryFormatVersion = ${source.objectFormat === 'sha256' ? 1 : 0}\nbare = false\nautocrlf = ${plan.autocrlf}\neol = ${plan.eol}\nsafecrlf = false\n${format}`);
  };
  return {
    async normalize(path, bytes, entry) {
      await initialize();
      const attributes = plan.attributes.get(path) ?? new Map<string, string>();
      const declarations = ['text', 'eol', 'crlf', 'ident', 'working-tree-encoding'].map((name) => {
        const value = attributes.get(name) ?? 'unspecified';
        if (value === 'unset') return `-${name}`;
        if (value === 'unspecified') return `!${name}`;
        if (value === 'set') return name;
        if (!/^[A-Za-z0-9_.+-]+$/u.test(value)) throw new PlanningError('UNSUPPORTED_ATTRIBUTE_VALUE', 'Cannot safely encode a conversion attribute', path);
        return `${name}=${value}`;
      });
      await writeFile(join(temporary!, '.gitattributes'), `input ${declarations.join(' ')} -filter\n`);
      // Store the existing blob only in the isolated object database, never in the project.
      const existing = await readGit(source.repoRoot, ['cat-file', 'blob', entry.blob]);
      await writeFile(join(temporary!, 'baseline'), existing);
      const baseline = await isolated(['hash-object', '-w', '--no-filters', '--', 'baseline']);
      if (baseline !== entry.blob) throw new PlanningError('INVALID_GIT_OBJECT', 'Copied index blob identity changed', path);
      await isolated(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},input`]);
      await writeFile(join(temporary!, 'input'), bytes);
      return isolated(['hash-object', '--path=input', '--', 'input']);
    },
    async dispose() { if (temporary) await rm(temporary, { recursive: true, force: true }); },
  };
}

export async function readGitBoundary(cwd: string): Promise<GitBoundary> {
  const repoRoot = await realpath(await readGitText(cwd, ['rev-parse', '--show-toplevel']));
  const privateGitDir = await realpath(await readGitText(cwd, ['rev-parse', '--absolute-git-dir']));
  const head = await readGitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const branch = await readOptionalGitText(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const format = await readGitText(cwd, ['rev-parse', '--show-object-format']);
  if (format !== 'sha1' && format !== 'sha256') throw new PlanningError('UNSUPPORTED_GIT_FORMAT', 'Unsupported Git object format');
  const stageBytes = await readGit(cwd, ['ls-files', '--stage', '-z']);
  const flagsBytes = await readGit(cwd, ['ls-files', '-v', '-z']);
  const diffBytes = await readGit(cwd, ['diff', '--cached', '--raw', '--full-index', '--no-abbrev', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', head, '--']);
  const index = new Map<string, IndexEntry[]>();
  for (const record of records(stageBytes)) {
    const match = /^(100644|100755|120000|160000) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/u.exec(record);
    if (!match) throw new PlanningError('INVALID_GIT_OUTPUT', 'Invalid index record');
    const mode = match[1];
    if (mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') throw new PlanningError('INVALID_GIT_OUTPUT', 'Invalid index mode');
    const path = checkedPath(match[4]!);
    const entries = index.get(path) ?? [];
    entries.push({ mode, blob: match[2]!, stage: Number(match[3]) }); index.set(path, entries);
  }
  const flagMap = new Map<string, string>();
  for (const record of records(flagsBytes)) {
    const match = /^([A-Za-z]) ([\s\S]+)$/u.exec(record);
    if (!match) throw new PlanningError('INVALID_GIT_OUTPUT', 'Invalid index flag record');
    const path = checkedPath(match[2]!); const tag = match[1]!;
    if (flagMap.has(path) && flagMap.get(path) !== tag) throw new PlanningError('INVALID_GIT_OUTPUT', 'Conflicting index flags', path);
    flagMap.set(path, tag);
  }
  const headEntries = new Map<string, { blob: string; mode: string }>();
  for (const record of records(await readGit(cwd, ['ls-tree', '-r', '-z', '--full-tree', head]))) {
    const match = /^(100644|100755|120000|160000) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/u.exec(record);
    if (!match) throw new PlanningError('INVALID_GIT_OUTPUT', 'Invalid HEAD tree record');
    headEntries.set(checkedPath(match[3]!), { mode: match[1]!, blob: match[2]! });
  }
  const paths = [...new Set([...records(await readGit(cwd, ['ls-files', '--cached', '--others', '-z'])).map(checkedPath), ...headEntries.keys()])].sort();
  const stagedPaths = [...new Set([...index.keys(), ...headEntries.keys()])].filter((path) => {
    const entries = index.get(path) ?? []; const original = headEntries.get(path);
    return entries.length !== 1 || entries[0]?.stage !== 0 || !original || entries[0].blob !== original.blob || entries[0].mode !== original.mode;
  }).sort();
  const fingerprint = createHash('sha256');
  for (const bytes of [stageBytes, flagsBytes, diffBytes]) fingerprint.update(String(bytes.length)).update('\0').update(bytes);
  return { repoRoot, privateGitDir, head, branch, objectFormat: format, indexFingerprint: fingerprint.digest('hex'), indexFlags: [...flagMap].map(([path, tag]) => ({ path, tag })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), index, headEntries, paths, stagedPaths };
}
