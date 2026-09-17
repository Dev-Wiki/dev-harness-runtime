import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Token } from 'markdown-it';
import { isRepoPath, parseContract, type Closure, type EvidenceRef, type Scope, type Snapshot } from '@dev-harness-runtime/contracts';
import { parseMarkdown, section, links, oneTable, tables, textOf, type MarkdownDocument, type Cell, type Table } from '../planning/markdown.js';
import { assertUnchanged, pathContentHash } from '../snapshot/guard.js';
import type { CapturedSnapshot } from '../snapshot/types.js';

export interface PlanningDeltaInput {
  before: CapturedSnapshot;
  after: CapturedSnapshot;
  scope: Scope;
  closure: Closure;
  /** Original bytes, captured before execution; missing required evidence is an error. */
  beforeFiles: ReadonlyMap<string, Uint8Array>;
  afterFiles: ReadonlyMap<string, Uint8Array>;
}
export interface PlanningDeltaEvidence {
  taskId: string;
  paths: readonly string[];
  beforeRefs: readonly EvidenceRef[];
  afterRefs: readonly EvidenceRef[];
  /** Reference to the original validation baseline, never the Worker's replacement HARNESS. */
  baselineHarnessRef: EvidenceRef;
}
export class PlanningDeltaError extends Error {
  readonly code = 'INVALID_PLANNING_DELTA';
  constructor(message: string, readonly path?: string) { super(`${message}${path ? ` (${path})` : ''}`); this.name = 'PlanningDeltaError'; }
}
const activeHeaders = ['任务', '优先级', '状态', '依赖', '下一步 / 阻塞', '详情'];
const archiveHeaders = ['任务编号', '完成日期', '验收摘要', '详情'];
const recentSectionNames = new Set(['近期完成', '最近完成']);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function check(condition: unknown, message: string, path?: string): asserts condition {
  if (!condition) throw new PlanningDeltaError(message, path);
}
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
type Entries = Map<string, Snapshot['paths'][number]>;

function entries(capture: CapturedSnapshot): Entries {
  assertUnchanged(capture, capture);
  return new Map(capture.snapshot.paths.map((entry) => [entry.path, entry]));
}
function content(entries: Entries, path: string): string | null {
  const entry = entries.get(path);
  if (entry === undefined || entry.type === 'missing') return null;
  check(entry.type === 'file', 'Planning inputs must be regular files', path);
  return entry.rawContentHash;
}
function frozenFiles(files: ReadonlyMap<string, Uint8Array>, entries: Entries): Map<string, Buffer> {
  const verified = new Map<string, Buffer>();
  for (const [path, bytes] of files) {
    check(isRepoPath(path), 'Invalid frozen input path', path);
    const copy = Buffer.from(bytes);
    check(content(entries, path) === hash(copy), 'Frozen bytes do not match the captured raw-content hash', path);
    verified.set(path, copy);
  }
  return verified;
}
function document(files: Map<string, Buffer>, path: string): MarkdownDocument {
  const bytes = files.get(path); check(bytes, 'Required original Markdown bytes are missing', path);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new PlanningDeltaError('Planning Markdown must be valid UTF-8', path); }
  return parseMarkdown(text, path);
}

/** Lexical reference resolution is checked against the complete captured path tree. */
function target(base: string, href: string, files: Entries, mustExist = true): string {
  let decoded: string;
  try { decoded = decodeURIComponent(href); } catch { throw new PlanningDeltaError('Malformed Markdown reference', base); }
  // eslint-disable-next-line no-control-regex -- Match the Planning reader's restricted reference syntax.
  check(href && !/[?#]/u.test(href) && !/[\\:\x00-\x1f\x7f]/u.test(decoded) && !decoded.startsWith('/')
    && !decoded.endsWith('/') && !decoded.split('/').some((part) => part === ''), 'Unsupported Markdown reference', base);
  const path = posix.normalize(posix.join(posix.dirname(base), decoded));
  check(isRepoPath(path), 'Markdown reference escapes the project', base);
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index++) {
    const ancestor = files.get(parts.slice(0, index).join('/'));
    check(ancestor === undefined || ancestor.type === 'missing', 'Reference traverses a captured file or symlink', path);
  }
  if (mustExist) check(files.get(path)?.type === 'file', 'Reference has no captured regular-file target', path);
  return path;
}

function tokenShape(token: Token, path: string, files: Entries, dependencyAlias?: Scope['planning'], checkbox = false): unknown {
  const attrs = (token.attrs ?? []).map(([name, value]) => {
    if (name !== 'href') return [name, value];
    check(typeof value === 'string', 'Markdown link must have a textual reference', path);
    const resolved = target(path, value, files, false);
    const aliased = dependencyAlias && [dependencyAlias.taskPath, dependencyAlias.archivePath].includes(resolved);
    return [name, aliased ? `task:${dependencyAlias.taskId}` : resolved];
  });
  return { type: token.type, tag: token.tag, nesting: token.nesting, level: token.level, hidden: token.hidden,
    attrs, content: token.type === 'inline' ? '' : checkbox && token.type === 'text' ? token.content.replace(/^\[[ xX]\]/u, '[ ]') : token.content,
    info: token.type === 'list_item_open' ? '' : token.info,
    children: token.children?.map((child) => tokenShape(child, path, files, dependencyAlias, checkbox)) ?? [] };
}
function shapes(tokens: readonly Token[], path: string, files: Entries, alias?: Scope['planning'], checkbox = false): unknown[] {
  return tokens.map((token) => tokenShape(token, path, files, alias, checkbox));
}
function bodyName(document: MarkdownDocument, at: number): string {
  return textOf(document.tokens[at + 1]?.children ?? []).replace(/^\d+\.\s*/u, '');
}
function withoutSections(document: MarkdownDocument, bodies: ReadonlySet<string>, whole: ReadonlySet<string> = new Set()): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < document.tokens.length;) {
    const token = document.tokens[index]!;
    const name = token.type === 'heading_open' && token.tag === 'h2' && token.level === 0 ? bodyName(document, index) : '';
    if (!bodies.has(name) && !whole.has(name)) { result.push(token); index++; continue; }
    section(document, name); // Also rejects duplicate or nested authoritative sections.
    if (!whole.has(name)) result.push(...document.tokens.slice(index, index + 3));
    index += 3;
    while (index < document.tokens.length) {
      const next = document.tokens[index]!;
      if (next.type === 'heading_open' && next.level === 0 && ['h1', 'h2'].includes(next.tag)) break;
      index++;
    }
  }
  return result;
}
function removeTable(document: MarkdownDocument, tokens: readonly Token[], headers?: readonly string[]): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type !== 'table_open') { result.push(token); continue; }
    const start = index;
    while (index < tokens.length && tokens[index]!.type !== 'table_close') index++;
    check(index < tokens.length, 'Unclosed Planning table', document.path);
    const tableTokens = tokens.slice(start, index + 1);
    const table = tables(document, tableTokens)[0];
    check(table, 'Invalid Planning table', document.path);
    // Only the authoritative table is mutable; supplemental tables are original context.
    if (headers && !headers.every((header) => table.headers.includes(header))) result.push(...tableTokens);
  }
  return result;
}
function rowShape(row: Map<string, Cell>, path: string, files: Entries, planning?: Scope['planning']): unknown[] {
  return [...row].map(([name, cell]) => [name, shapes(cell.tokens, path, files, name === '依赖' ? planning : undefined)]);
}
function activeRows(document: MarkdownDocument, files: Entries): { table: Table; ids: string[] } {
  const table = oneTable(document, section(document, '活跃任务'), activeHeaders);
  check(table.headers.length === activeHeaders.length, 'Active table must retain the six authoritative columns', document.path);
  const ids: string[] = [];
  for (const row of table.rows) {
    const id = /^([A-Za-z][A-Za-z0-9._-]{0,63}) — \S/u.exec(row.get('任务')!.text)?.[1];
    check(id && !ids.includes(id), 'Invalid or duplicate active Task identity', document.path); ids.push(id);
    check(['📋 规划中', '🟢 待执行', '🚧 开发中', '📋 远期'].includes(row.get('状态')!.text), 'Invalid active Task status', document.path);
    check(['🔴 P0', '🟡 P1', '🟢 P2'].includes(row.get('优先级')!.text) && row.get('下一步 / 阻塞')!.text, 'Invalid active priority or blocker', document.path);
    const detail = links(row.get('详情')!.tokens);
    check(detail.length === 1 && row.get('详情')!.text === detail[0]!.text
      && target(document.path, detail[0]!.href, files) === `${posix.dirname(document.path)}/tasks/${id}.md`, 'Active Task detail does not bind its canonical packet', document.path);
    for (const link of links(row.get('依赖')!.tokens)) target(document.path, link.href, files);
  }
  return { table, ids };
}
function order(document: MarkdownDocument, files: Entries, activeIds: string[]): { items: { id: string; tokens: Token[] }[]; rest: Token[] } {
  const tokens = section(document, '当前工作顺序');
  const items: { id: string; tokens: Token[] }[] = []; const rest: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    check(token.type !== 'bullet_list_open' && !(token.type === 'ordered_list_open' && token.level !== 0), 'Unsupported work-order list', document.path);
    if (['ordered_list_open', 'ordered_list_close'].includes(token.type)) continue;
    if (token.type !== 'list_item_open') { rest.push(token); continue; }
    check(token.level === 1 && Number(token.info) === items.length + 1, 'Work order numbering must be contiguous from one', document.path);
    const start = index;
    while (index < tokens.length && !(tokens[index]!.type === 'list_item_close' && tokens[index]!.level === 1)) index++;
    check(index < tokens.length, 'Unclosed work-order item', document.path);
    const item = tokens.slice(start, index + 1);
    const inline = item[2]; check(inline?.type === 'inline', 'Work-order item must begin with a Task link', document.path);
    const children = (inline.children ?? []).filter((child) => !['strong_open', 'strong_close', 'em_open', 'em_close'].includes(child.type) && !(child.type === 'text' && !child.content.trim()));
    check(children[0]?.type === 'link_open', 'Work-order item must begin with a Task link', document.path);
    const link = links(children)[0]!;
    const path = target(document.path, link.href, files);
    const id = posix.basename(path, '.md');
    check(activeIds.includes(id) && path === `${posix.dirname(document.path)}/tasks/${id}.md`
      && (link.text === id || link.text === `${id}.md` || link.text.startsWith(`${id} — `) || link.text.startsWith(`${id}：`))
      && !items.some((entry) => entry.id === id), 'Work order references an invalid or repeated Task', document.path);
    items.push({ id, tokens: item });
  }
  return { items, rest };
}

function recentSection(document: MarkdownDocument): Token[] {
  const names = document.tokens.flatMap((token, index) => {
    const name = token.type === 'heading_open' ? bodyName(document, index) : '';
    return recentSectionNames.has(name) ? [name] : [];
  });
  check(names.length <= 1, 'Recent-completion sections must have one unambiguous heading', document.path);
  return names.length ? section(document, names[0]!) : [];
}

function recentItems(document: MarkdownDocument, files: Entries): { items: { tokens: Token[]; target: string }[]; rest: Token[] } {
  const body = recentSection(document);
  const items: { tokens: Token[]; target: string }[] = [];
  const table = tables(document, body);
  const append = (tokens: Token[]) => {
    const found = links(tokens);
    check(found.length === 1, 'Recent completion entry must identify exactly one archive', document.path);
    items.push({ tokens, target: target(document.path, found[0]!.href, files) });
  };
  if (table.length) {
    check(table.length === 1, 'Multiple recent-completion tables are unsupported', document.path);
    for (const row of table[0]!.rows) append([...row.values()].flatMap((cell) => cell.tokens));
    check(items.length <= 5, 'Dashboard may retain at most five recent completions', document.path);
    return { items, rest: removeTable(document, body) };
  }
  const rest: Token[] = [];
  for (let index = 0; index < body.length; index++) {
    const token = body[index]!;
    if (['bullet_list_open', 'bullet_list_close', 'ordered_list_open', 'ordered_list_close'].includes(token.type)) { check(token.level === 0, 'Nested recent-completion list', document.path); continue; }
    if (token.type !== 'list_item_open') { rest.push(token); continue; }
    check(token.level === 1, 'Nested recent-completion entry', document.path);
    const start = index;
    while (index < body.length && !(body[index]!.type === 'list_item_close' && body[index]!.level === 1)) index++;
    check(index < body.length, 'Unclosed recent completion', document.path);
    append(body.slice(start, index + 1));
  }
  check(items.length <= 5, 'Dashboard may retain at most five recent completions', document.path);
  return { items, rest };
}

function dashboardDelta(before: MarkdownDocument, after: MarkdownDocument, left: Entries, right: Entries, planning: Scope['planning']): void {
  const old = activeRows(before, left); const next = activeRows(after, right);
  check(equal(old.table.headers, next.table.headers), 'Active table columns changed', after.path);
  check(old.ids.includes(planning.taskId) && !next.ids.includes(planning.taskId), 'Current Task must leave the active table', after.path);
  check(equal(next.ids, old.ids.filter((id) => id !== planning.taskId)), 'Other active Task identities or row order changed', after.path);
  const remaining = old.table.rows.filter((_, index) => old.ids[index] !== planning.taskId);
  check(equal(remaining.map((row) => rowShape(row, before.path, left, planning)), next.table.rows.map((row) => rowShape(row, after.path, right, planning))), 'Another Task status, priority, dependency, blocker, title or scope link changed', after.path);
  const a = order(before, left, old.ids); const b = order(after, right, next.ids);
  check(a.items.some((item) => item.id === planning.taskId), 'Current Task was not in the authoritative work order', before.path);
  check(equal(a.items.filter((item) => item.id !== planning.taskId).map((item) => [item.id, shapes(item.tokens, before.path, left)]), b.items.map((item) => [item.id, shapes(item.tokens, after.path, right)])), 'Other Task order or order-item content changed', after.path);
  check(equal(shapes(a.rest, before.path, left), shapes(b.rest, after.path, right)), 'Work-order explanatory content changed', after.path);
  check(equal(shapes(removeTable(before, section(before, '活跃任务'), activeHeaders), before.path, left), shapes(removeTable(after, section(after, '活跃任务'), activeHeaders), after.path, right)), 'Active-table explanatory content changed', after.path);
  const recentBefore = recentItems(before, left); const recentAfter = recentItems(after, right);
  const oldRecentTables = tables(before, recentSection(before));
  if (oldRecentTables.length) {
    const newRecentTables = tables(after, recentSection(after));
    check(newRecentTables.length === 1 && equal(oldRecentTables[0]!.headers, newRecentTables[0]!.headers), 'Recent-completion table columns changed', after.path);
  }
  check(equal(shapes(recentBefore.rest, before.path, left), shapes(recentAfter.rest, after.path, right)), 'Recent-completion explanatory content changed', after.path);
  const added = recentAfter.items.filter((item) => item.target === planning.archivePath);
  check(added.length <= 1, 'Current completion is repeated in recent summaries', after.path);
  const kept = recentAfter.items.filter((item) => item.target !== planning.archivePath);
  check(kept.length === Math.min(recentBefore.items.length, 5 - added.length), 'Unrelated recent completions were added or removed', after.path);
  let offset = 0;
  for (const item of kept) {
    while (offset < recentBefore.items.length && !equal(shapes(recentBefore.items[offset]!.tokens, before.path, left), shapes(item.tokens, after.path, right))) offset++;
    check(offset < recentBefore.items.length, 'Existing recent completion was rewritten or reordered', after.path); offset++;
  }
  const mutable = new Set(['当前工作顺序', '活跃任务']);
  check(equal(shapes(withoutSections(before, mutable, recentSectionNames), before.path, left), shapes(withoutSections(after, mutable, recentSectionNames), after.path, right)), 'Dashboard changed outside the current Task lifecycle', after.path);
}

function packetDelta(before: MarkdownDocument, archive: MarkdownDocument, left: Entries, right: Entries, taskId: string): void {
  for (const doc of [before, archive]) {
    const heading = doc.tokens.findIndex((token) => token.type === 'heading_open' && token.tag === 'h1');
    check(/^(?:任务\s+)?([A-Za-z][A-Za-z0-9._-]{0,63})(?:：|\s+—\s+)/u.exec(textOf(doc.tokens[heading + 1]?.children ?? []))?.[1] === taskId, 'Task title and archive identity disagree', doc.path);
  }
  const oldChecks = section(before, '验收标准'); const newChecks = section(archive, '验收标准');
  const actual = newChecks.filter((token) => token.type === 'inline' && /^\[[ xX]\]/u.test(token.content));
  check(actual.length > 0 && actual.every((token) => /^\[[xX]\]\s+\S/u.test(token.content)), 'Archive acceptance is incomplete', archive.path);
  check(equal(shapes(oldChecks, before.path, left, undefined, true), shapes(newChecks, archive.path, right, undefined, true)), 'Worker rewrote the original acceptance criteria', archive.path);
  const verification = section(archive, '验证证据');
  const evidence = links(verification); check(evidence.length > 0, 'Archive must refer to verification evidence', archive.path);
  for (const link of evidence) target(archive.path, link.href, right);
  check(section(archive, '完成验收结果').some((token) => token.type === 'inline' && token.content.trim()), 'Archive lacks an explicit completed acceptance record', archive.path);
  const mutable = new Set(['验收标准', '验证证据']);
  check(equal(shapes(withoutSections(before, mutable, new Set(['完成验收结果'])), before.path, left), shapes(withoutSections(archive, mutable, new Set(['完成验收结果'])), archive.path, right)), 'Task packet changed beyond acceptance and archive relocation', archive.path);
}

function archiveIndexDelta(before: MarkdownDocument | undefined, after: MarkdownDocument, left: Entries, right: Entries, planning: Scope['planning']): void {
  const next = oneTable(after, after.tokens, archiveHeaders);
  const old = before ? oneTable(before, before.tokens, archiveHeaders) : undefined;
  if (old) check(equal(old.headers, next.headers), 'Archive index columns changed', after.path);
  const previous = old?.rows ?? [];
  check(previous.every((row) => row.get('任务编号')!.text !== planning.taskId), 'Repeated closure is not supported by this execution scope', after.path);
  check(next.rows.length === previous.length + 1, 'Archive index must append exactly the current Task', after.path);
  check(equal(previous.map((row) => rowShape(row, before!.path, left)), next.rows.slice(0, -1).map((row) => rowShape(row, after.path, right))), 'Existing archive index entries changed', after.path);
  const row = next.rows.at(-1)!;
  check(row.get('任务编号')!.text === planning.taskId, 'Appended archive identity does not match the current Task', after.path);
  const date = row.get('完成日期')!.text;
  check(/^\d{4}-\d{2}-\d{2}$/u.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().startsWith(date), 'Invalid archive completion date', after.path);
  check(row.get('验收摘要')!.text !== '', 'Archive acceptance summary is missing', after.path);
  const detail = links(row.get('详情')!.tokens);
  check(detail.length === 1 && row.get('详情')!.text === detail[0]!.text && target(after.path, detail[0]!.href, right) === planning.archivePath, 'Archive index does not link the authorized archive', after.path);
  check((row.get('关闭次数')?.text ?? '1') === '1' && (!row.has('前次') || row.get('前次')!.text === '无'), 'Unexpected repeated closure or predecessor claim', after.path);
  if (before) check(equal(shapes(removeTable(before, before.tokens, archiveHeaders), before.path, left), shapes(removeTable(after, after.tokens, archiveHeaders), after.path, right)), 'Archive index prose changed outside the appended row', after.path);
}

/** Pure verification only. These bytes never become a Planning writer or a validation command source. */
export function validatePlanningDelta(input: PlanningDeltaInput): PlanningDeltaEvidence {
  const scope = parseContract('scope', input.scope); const planning = scope.planning; const closure = input.closure;
  const left = entries(input.before); const right = entries(input.after);
  const beforeFiles = frozenFiles(input.beforeFiles, left); const afterFiles = frozenFiles(input.afterFiles, right);
  check(input.before.snapshot.runId === input.after.snapshot.runId
    && input.before.snapshot.repoIdentity.repoRoot === input.after.snapshot.repoIdentity.repoRoot
    && input.before.snapshot.repoIdentity.privateGitDir === input.after.snapshot.repoIdentity.privateGitDir, 'Planning boundaries identify different Runs or worktrees');
  check(input.before.snapshot.dashboardRef.path === planning.dashboardPath && input.after.snapshot.dashboardRef.path === planning.dashboardPath
    && input.before.snapshot.currentTaskRef?.path === planning.taskPath
    && (input.after.snapshot.currentTaskRef === undefined || input.after.snapshot.currentTaskRef.path === planning.archivePath), 'Captured Planning references do not bind the current Task lifecycle');
  const root = posix.dirname(planning.dashboardPath);
  check(posix.basename(planning.dashboardPath) === 'Dashboard.md' && planning.taskPath === `${root}/tasks/${planning.taskId}.md`
    && posix.dirname(planning.archivePath) === posix.dirname(planning.archiveIndexPath)
    && posix.basename(planning.archiveIndexPath) === 'README.md'
    && posix.dirname(posix.dirname(planning.archivePath)) === `${root}/archive`, 'Closure paths do not identify one canonical milestone');
  const paths = [planning.taskPath, planning.archivePath, planning.archiveIndexPath, planning.dashboardPath];
  check(closure.schemaVersion === 1 && typeof closure.summary === 'string' && closure.summary.trim()
    && ['taskId', 'taskPath', 'archivePath', 'archiveIndexPath', 'dashboardPath'].every((key) => Reflect.get(closure, key) === Reflect.get(planning, key)), 'Closure does not match the frozen scope');
  check(closure.changes.length === 4 && new Set(closure.changes.map((change) => change.path)).size === 4, 'Closure must declare exactly four unique Planning changes');
  for (const path of paths) {
    const change = closure.changes.find((entry) => entry.path === path);
    check(change && change.beforeHash === content(left, path) && change.afterHash === content(right, path)
      && change.beforeHash !== change.afterHash, 'Closure hash claims do not match captured bytes', path);
  }
  check(content(left, planning.taskPath) !== null && content(right, planning.taskPath) === null
    && content(left, planning.archivePath) === null && content(right, planning.archivePath) !== null, 'Active packet must be removed and a new archive created');
  for (const path of [planning.dashboardPath, planning.archiveIndexPath]) {
    check(content(right, path) !== null, 'Dashboard and archive index must remain present', path);
    if (left.get(path)?.type === 'file') check(left.get(path)!.mode === right.get(path)!.mode, 'Planning file mode changed', path);
  }
  check(left.get(planning.taskPath)!.mode === right.get(planning.archivePath)!.mode, 'Archive changed the Task packet file mode');
  for (const path of new Set([...left.keys(), ...right.keys()])) {
    if (path.startsWith(`${root}/`) && !paths.includes(path)) check(pathContentHash(left.get(path)) === pathContentHash(right.get(path)), 'Another Planning file changed or was omitted from evidence', path);
    if (!path.startsWith(`${root}/archive/`) || content(left, path) === null) continue;
    const name = posix.basename(path);
    check(name !== `${planning.taskId}.md` && !name.startsWith(`${planning.taskId}.closure-`), 'Current Task already has a closure in this or another milestone; repeated closure is unsupported', path);
    if (name === 'README.md') {
      const index = document(beforeFiles, path);
      for (const table of tables(index, index.tokens)) check(table.rows.every((row) => row.get('任务编号')?.text !== planning.taskId), 'Existing milestone index already claims this Task', path);
    }
  }
  const beforeDashboard = document(beforeFiles, planning.dashboardPath); const afterDashboard = document(afterFiles, planning.dashboardPath);
  dashboardDelta(beforeDashboard, afterDashboard, left, right, planning);
  packetDelta(document(beforeFiles, planning.taskPath), document(afterFiles, planning.archivePath), left, right, planning.taskId);
  archiveIndexDelta(content(left, planning.archiveIndexPath) === null ? undefined : document(beforeFiles, planning.archiveIndexPath), document(afterFiles, planning.archiveIndexPath), left, right, planning);
  const refs = (files: Map<string, Buffer>) => [...files].map(([path, bytes]): EvidenceRef => ({ schemaVersion: 1, path, sha256: hash(bytes) }));
  return { taskId: planning.taskId, paths, beforeRefs: refs(beforeFiles), afterRefs: refs(afterFiles), baselineHarnessRef: { ...input.before.snapshot.harnessRef } };
}
