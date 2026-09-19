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
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new CodexReadError('UNSAFE_PATH', 'Read target is not a single-link regular file');
    }
    if (before.size > 4n * 1024n * 1024n) throw new CodexReadError('OUTPUT_LIMIT', 'Read target exceeds 4 MiB');
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

  async readPage(path: string, offset = 0): Promise<{ path: string; content: string; sha256: string; offset: number; nextOffset: number | null }
    | { path: string; missing: true }> {
    if (!allowedPath(path)) throw new CodexReadError('UNSAFE_PATH', 'Read path is unsafe');
    // New Task files are absent from the before snapshot. This exact negative receipt
    // lets a Worker inspect absence without mistaking it for bridge or snapshot drift.
    if (!this.files.has(path)) {
      if (offset !== 0) throw new CodexReadError('UNSAFE_PATH', 'Missing file has no read cursor');
      return { path, missing: true };
    }
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

  /** Literal search over at most 16 frozen files; each file returns at most five bounded hits. */
  async search(query: string, prefix = '', after = ''): Promise<{ matches: readonly {
    path: string; line: number; column: number; excerpt: string }[]; skipped: readonly string[]; next: string | null }> {
    if (typeof query !== 'string' || query.length < 1 || query.length > 128
      || [...query].some((character) => { const code = character.codePointAt(0)!; return code < 32 || code === 127; })
      || (prefix && !allowedPath(prefix)) || (after && !allowedPath(after))) {
      throw new CodexReadError('UNSAFE_PATH', 'Search requires a bounded literal and safe path cursors');
    }
    const candidates = this.paths.filter((path) => (!prefix || path === prefix || path.startsWith(`${prefix}/`))
      && (!after || Buffer.compare(Buffer.from(path), Buffer.from(after)) > 0)).slice(0, 17);
    const page = candidates.slice(0, 16);
    const matches: { path: string; line: number; column: number; excerpt: string }[] = [];
    const skipped: string[] = [];
    for (const path of page) {
      let content: string;
      try { content = (await this.read(path)).content; }
      catch (error) {
        if (error instanceof CodexReadError && error.code === 'OUTPUT_LIMIT') { skipped.push(path); continue; }
        throw error;
      }
      let hits = 0;
      let lineNumber = 1;
      let startOfLine = 0;
      while (startOfLine <= content.length && hits < 5) {
        const newline = content.indexOf('\n', startOfLine);
        const endOfLine = newline === -1 ? content.length : newline;
        const raw = content.slice(startOfLine, endOfLine);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        const column = line.indexOf(query);
        if (column !== -1) {
          const start = Math.max(0, column - 48);
          matches.push({ path, line: lineNumber, column: column + 1, excerpt: line.slice(start, start + 200) });
          hits++;
        }
        if (newline === -1) break;
        startOfLine = newline + 1;
        lineNumber++;
      }
    }
    return { matches, skipped, next: candidates.length > 16 ? page.at(-1)! : null };
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
