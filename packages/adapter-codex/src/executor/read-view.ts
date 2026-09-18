import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { isRepoPath } from '@dev-harness-runtime/contracts';

export class CodexReadError extends Error {
  constructor(readonly code: 'INVALID_POLICY' | 'UNSAFE_PATH' | 'DRIFT_DETECTED' | 'OUTPUT_LIMIT', message: string) {
    super(message); this.name = 'CodexReadError';
  }
}

export interface CodexReadPolicy {
  readonly repoRoot: string;
  readonly runId: string;
  readonly requestId: string;
  readonly snapshotHash: string;
  /** Core-selected regular files from the frozen before snapshot. */
  readonly files: readonly { path: string; sha256: string }[];
}

const allowedPath = (path: string): boolean => path.length <= 4096 && isRepoPath(path)
  && !path.split('/').some((part) => part.toLowerCase() === '.git');
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const stamp = (stat: { dev: bigint; ino: bigint; mode: bigint; nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string =>
  [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

/** Frozen path catalog; reads still recheck actual bytes and file identity. */
export class CodexReadView {
  private readonly files: ReadonlyMap<string, string>;
  private readonly paths: readonly string[];
  private constructor(readonly policy: CodexReadPolicy) {
    this.files = new Map(policy.files.map(({ path, sha256 }) => [path, sha256]));
    this.paths = [...this.files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    Object.freeze(this);
  }

  static async create(input: CodexReadPolicy): Promise<CodexReadView> {
    if (!isAbsolute(input.repoRoot) || normalize(input.repoRoot) !== input.repoRoot
      || await realpath(input.repoRoot).catch(() => null) !== input.repoRoot
      || !input.runId || !input.requestId || !/^[a-f0-9]{64}$/u.test(input.snapshotHash)
      || !Array.isArray(input.files) || input.files.length > 100_000) {
      throw new CodexReadError('INVALID_POLICY', 'Read view does not bind a canonical project and snapshot');
    }
    const seen = new Set<string>();
    const folded = new Set<string>();
    for (const file of input.files) {
      if (!allowedPath(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256)
        || seen.has(file.path) || folded.has(file.path.toLowerCase())) {
        throw new CodexReadError('INVALID_POLICY', 'Read view contains a duplicate or unsafe snapshot path');
      }
      seen.add(file.path);
      folded.add(file.path.toLowerCase());
    }
    return new CodexReadView(Object.freeze({ ...input,
      files: Object.freeze(input.files.map((file) => Object.freeze({ ...file }))) }));
  }

  list(prefix = '', after = ''): { paths: readonly string[]; next: string | null } {
    if ((prefix && !allowedPath(prefix)) || (after && !allowedPath(after))) {
      throw new CodexReadError('UNSAFE_PATH', 'Read catalog prefix or cursor is unsafe');
    }
    const matching = this.paths.filter((path) => (!prefix || path === prefix || path.startsWith(`${prefix}/`))
      && (!after || Buffer.compare(Buffer.from(path), Buffer.from(after)) > 0));
    const page = matching.slice(0, 100);
    return { paths: page, next: matching.length > page.length ? page.at(-1)! : null };
  }

  async read(path: string): Promise<{ path: string; content: string; sha256: string }> {
    if (!allowedPath(path) || !this.files.has(path)) throw new CodexReadError('UNSAFE_PATH', 'Path is outside the frozen read view');
    const target = join(this.policy.repoRoot, ...path.split('/'));
    let parent = this.policy.repoRoot;
    for (const part of path.split('/').slice(0, -1)) {
      parent = join(parent, part);
      const info = await lstat(parent, { bigint: true }).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new CodexReadError('UNSAFE_PATH', 'Read path traverses a symlink or missing directory');
    }
    const before = await lstat(target, { bigint: true }).catch(() => null);
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4n * 1024n * 1024n) {
      throw new CodexReadError('UNSAFE_PATH', 'Read target is not a bounded single-link regular file');
    }
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (stamp(await file.stat({ bigint: true })) !== stamp(before)) {
        throw new CodexReadError('DRIFT_DETECTED', 'Read target changed before opening');
      }
      const bytes = await file.readFile();
      const after = await lstat(target, { bigint: true }).catch(() => null);
      if (bytes.byteLength > 4 * 1024 * 1024 || !after || stamp(after) !== stamp(before)
        || stamp(await file.stat({ bigint: true })) !== stamp(before) || hash(bytes) !== this.files.get(path)) {
        throw new CodexReadError('DRIFT_DETECTED', 'Read target differs from the frozen snapshot');
      }
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new CodexReadError('OUTPUT_LIMIT', 'Read target is not UTF-8 text'); }
      return { path, content, sha256: hash(bytes) };
    } finally { await file.close(); }
  }

  async readPage(path: string, offset = 0): Promise<{ path: string; content: string; sha256: string; offset: number; nextOffset: number | null }> {
    const file = await this.read(path);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.content.length
      || (offset > 0 && offset < file.content.length && /[\uD800-\uDBFF]/u.test(file.content[offset - 1]!)
        && /[\uDC00-\uDFFF]/u.test(file.content[offset]!))) {
      throw new CodexReadError('UNSAFE_PATH', 'Read cursor does not identify a complete text boundary');
    }
    let end = Math.min(offset + 16 * 1024, file.content.length);
    if (end < file.content.length && /[\uD800-\uDBFF]/u.test(file.content[end - 1]!)) end--;
    return { path, content: file.content.slice(offset, end), sha256: file.sha256,
      offset, nextOffset: end < file.content.length ? end : null };
  }
}

/** One fresh host process receives one immutable read catalog by private file. */
export async function withCodexReadPolicy<T>(input: CodexReadPolicy, run: (path: string) => Promise<T>): Promise<T> {
  const view = await CodexReadView.create(input);
  const directory = await mkdtemp(join(tmpdir(), 'dhr-codex-read-policy-'));
  try {
    const path = join(directory, 'policy.json');
    await writeFile(path, `${JSON.stringify(view.policy)}\n`, { flag: 'wx', mode: 0o600 });
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
