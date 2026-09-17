import MarkdownIt, { type Token } from 'markdown-it';
import { PlanningError } from './types.js';
const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false });
export interface MarkdownDocument { tokens: Token[]; lines: string[]; path: string }
export interface Cell { text: string; tokens: Token[] }
export interface Table { headers: string[]; rows: Map<string, Cell>[] }
export function textOf(tokens: readonly Token[]): string {
  return tokens.map((token) => ['text', 'code_inline'].includes(token.type) ? token.content : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : '').join('').trim();
}
export function parseMarkdown(text: string, path: string): MarkdownDocument {
  const tokens = markdown.parse(text, {});
  for (const token of tokens) {
    if ([token, ...(token.children ?? [])].some((entry) => entry.type === 'html_block' || entry.type === 'html_inline')) throw new PlanningError('UNSUPPORTED_PLAN_FORMAT', 'HTML content is not accepted in Planning documents', path, (token.map?.[0] ?? 0) + 1);
  }
  return { tokens, lines: text.split(/\r?\n/u), path };
}
export function section(document: MarkdownDocument, name: string, required = true): Token[] {
  const matches: number[] = [];
  document.tokens.forEach((token, index) => {
    if (token.type === 'heading_open' && textOf(document.tokens[index + 1]?.children ?? []).replace(/^\d+\.\s*/u, '') === name) {
      if (token.tag !== 'h2' || token.level !== 0) throw new PlanningError('UNSUPPORTED_PLAN_FORMAT', `Section ${name} must be a top-level h2`, document.path);
      matches.push(index);
    }
  });
  if (!matches.length && !required) return [];
  if (matches.length !== 1) throw new PlanningError('PLAN_AMBIGUOUS', `Expected exactly one ${name} section`, document.path);
  const start = matches[0]! + 3;
  let end = document.tokens.length;
  for (let index = start; index < end; index++) {
    const token = document.tokens[index]!;
    if (token.type === 'heading_open' && token.level === 0 && ['h1', 'h2'].includes(token.tag)) { end = index; break; }
  }
  return document.tokens.slice(start, end);
}
export function links(tokens: readonly Token[]): { text: string; href: string }[] {
  const result: { text: string; href: string }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === 'inline') result.push(...links(token.children ?? []));
    if (token.type !== 'link_open') continue;
    const end = tokens.findIndex((entry, at) => at > index && entry.type === 'link_close');
    if (end < 0) throw new PlanningError('UNSUPPORTED_PLAN_FORMAT', 'Unclosed link');
    result.push({ text: textOf(tokens.slice(index + 1, end)), href: String(token.attrGet('href') ?? '') }); index = end;
  }
  return result;
}
function rawCellCount(line: string): number {
  const cells: string[] = []; let cell = ''; let escaped = false;
  for (const character of line.trim()) {
    if (character === '|' && !escaped) { cells.push(cell); cell = ''; } else cell += character;
    escaped = character === '\\' && !escaped;
  }
  cells.push(cell);
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells.length;
}
export function tables(document: MarkdownDocument, tokens: readonly Token[]): Table[] {
  const result: Table[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const open = tokens[index]!;
    if (open.type !== 'table_open') continue;
    if (open.level !== 0) throw new PlanningError('UNSUPPORTED_PLAN_FORMAT', 'Nested tables are unsupported', document.path);
    const rows: Cell[][] = []; let row: Cell[] = [];
    for (index++; index < tokens.length && tokens[index]!.type !== 'table_close'; index++) {
      const token = tokens[index]!;
      if (token.type === 'tr_open') row = [];
      if (token.type === 'inline') row.push({ text: textOf(token.children ?? []), tokens: token.children ?? [] });
      if (token.type === 'tr_close') rows.push(row);
    }
    const headers = rows.shift()?.map((cell) => cell.text) ?? [];
    if (new Set(headers).size !== headers.length) throw new PlanningError('PLAN_AMBIGUOUS', 'Duplicate table columns', document.path);
    if (open.map) for (let line = open.map[0]; line < open.map[1]; line++) {
      if (rawCellCount(document.lines[line] ?? '') !== headers.length) throw new PlanningError('UNSUPPORTED_PLAN_FORMAT', 'Table row column count mismatch', document.path, line + 1);
    }
    result.push({ headers, rows: rows.map((cells) => new Map(headers.map((header, at) => [header, cells[at] ?? { text: '', tokens: [] }]))) });
  }
  return result;
}
export function oneTable(document: MarkdownDocument, tokens: readonly Token[], headers: readonly string[]): Table {
  const found = tables(document, tokens).filter((table) => headers.every((header) => table.headers.includes(header)));
  if (found.length !== 1) throw new PlanningError('PLAN_AMBIGUOUS', 'Expected one authoritative table with the required headers', document.path);
  return found[0]!;
}
