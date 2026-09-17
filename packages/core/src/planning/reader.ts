import { readFile, readdir, stat, lstat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveProjectPath } from '../discovery/paths.js';
import { parseMarkdown, section, links, oneTable, tables, textOf, type Cell, type MarkdownDocument } from './markdown.js';
import { PlanningError, type PlanningDocument, type PlanningReference, type PlanningTask } from './types.js';
const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const states = new Set(['📋 规划中', '🟢 待执行', '🚧 开发中', '📋 远期']);
const headers = ['任务', '优先级', '状态', '依赖', '下一步 / 阻塞', '详情'];
export interface PlanningProject { repoRoot: string; docsRoot: string; dashboardPath: string }
function requireValue(condition: unknown, message: string, path: string): asserts condition {
  if (!condition) throw new PlanningError('UNSUPPORTED_PLAN_FORMAT', message, path);
}
function identity(text: string, path: string): string {
  requireValue(idPattern.test(text), `Invalid Task identity ${text}`, path); return text;
}
function linkMatches(text: string, id: string): boolean {
  return text === id || text === `${id}.md` || text.startsWith(`${id} — `) || text.startsWith(`${id}：`);
}
function exactlyOneLink(cell: Cell, path: string): { text: string; href: string } {
  const found = links(cell.tokens);
  requireValue(found.length === 1 && cell.text === found[0]!.text, 'Cell must contain exactly one Task link', path); return found[0]!;
}
function dependencies(cell: Cell, path: string): { id: string; href?: string }[] {
  if (cell.text === '无') return [];
  const found = links(cell.tokens); const ids = cell.text.split('、').map((id) => identity(id.trim(), path));
  requireValue(new Set(ids).size === ids.length, 'Duplicate dependencies', path);
  requireValue(found.every((link) => ids.includes(link.text)), 'Dependency link text must be the exact Task ID', path);
  return ids.map((id) => { const link = found.find((entry) => entry.text === id); return link ? { id, href: link.href } : { id }; });
}
function packetProblems(document: MarkdownDocument, id: string): string[] {
  const heading = document.tokens.findIndex((token) => token.type === 'heading_open' && token.tag === 'h1');
  const title = textOf(document.tokens[heading + 1]?.children ?? []);
  const match = /^(?:任务\s+)?([A-Za-z][A-Za-z0-9._-]{0,63})(?:：|\s+—\s+)/u.exec(title);
  requireValue(match?.[1] === id, 'Task heading and filename identity disagree', document.path);
  const problems: string[] = [];
  for (const name of ['背景与目标', '执行上下文', '范围', '影响文件', '验收标准', '验证证据', '未知项与停止条件']) {
    const tokens = section(document, name, false);
    if (!tokens.some((token) => token.type === 'inline' && token.content.trim())) problems.push(`Missing ${name}`);
  }
  const context = section(document, '执行上下文', false).filter((token) => token.type === 'inline').map((token) => textOf(token.children ?? [])).join('\n');
  for (const label of ['权威需求', '代码入口', '相关测试', '必须保持的不变量']) if (!new RegExp(`${label}[：:]\\s*\\S`, 'u').test(context)) problems.push(`Missing ${label}`);
  const acceptance = section(document, '验收标准', false).filter((token) => token.type === 'inline');
  if (!acceptance.some((token) => /^\[[ xX]\]\s+\S/u.test(token.content))) problems.push('Missing acceptance checkboxes');
  return problems;
}
export async function readPlan(project: PlanningProject): Promise<PlanningDocument> {
  const references = new Map<string, PlanningReference>();
  const contents = new Map<string, Buffer>();
  const evidenceBytes = async (path: string): Promise<Buffer> => {
    const cached = contents.get(path); if (cached) return cached;
    requireValue((await stat(path)).isFile(), 'Reference must be a regular file', path);
    const bytes = await readFile(path); contents.set(path, bytes);
    references.set(path, { path: relative(project.repoRoot, path).split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex') });
    return bytes;
  };
  const read = async (path: string): Promise<MarkdownDocument> => {
    const info = await stat(path);
    requireValue(info.isFile() && info.size <= 2_000_000, 'Planning input must be a file of at most 2 MB', path);
    const bytes = await evidenceBytes(path); let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new PlanningError('INVALID_UTF8', 'Planning input must be UTF-8', path); }
    references.set(path, { path: relative(project.repoRoot, path).split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex') });
    return parseMarkdown(text, path);
  };
  const resolve = (base: string, href: string) => resolveProjectPath(project.repoRoot, base, href);
  const dashboardPath = await resolve(project.repoRoot, relative(project.repoRoot, project.dashboardPath).split(sep).join('/'));
  requireValue(dashboardPath === join(project.docsRoot, 'plan', 'Dashboard.md'), 'Dashboard must belong to the selected docs root', dashboardPath);
  const dashboard = await read(dashboardPath); const planRoot = dirname(dashboardPath);
  const active = oneTable(dashboard, section(dashboard, '活跃任务'), headers);
  requireValue(active.headers.length === headers.length, 'Unexpected active table columns', dashboardPath);
  const tasks: PlanningTask[] = []; const declaredDependencies = new Map<string, { id: string; href?: string }[]>();
  const paths = new Set<string>();
  for (const row of active.rows) {
    const get = (name: string) => row.get(name)!;
    const match = /^([A-Za-z][A-Za-z0-9._-]{0,63}) — (\S.*)$/u.exec(get('任务').text);
    requireValue(match, 'Expected Task ID — title', dashboardPath);
    const id = match[1]!;
    requireValue(!tasks.some((task) => task.id === id), `Duplicate Task ${id}`, dashboardPath);
    requireValue(states.has(get('状态').text), 'Unknown status or completed Task retained in active table', dashboardPath);
    requireValue(['🔴 P0', '🟡 P1', '🟢 P2'].includes(get('优先级').text), 'Unknown priority', dashboardPath);
    requireValue(get('下一步 / 阻塞').text !== '', 'Empty blocker is incomplete input', dashboardPath);
    const link = exactlyOneLink(get('详情'), dashboardPath);
    const taskPath = await resolve(planRoot, link.href);
    const expected = join(planRoot, 'tasks', `${id}.md`);
    requireValue(taskPath === expected, 'Task detail must point to its canonical tasks/<ID>.md', dashboardPath);
    requireValue(!paths.has(taskPath.toLowerCase()), 'Case-aliased Task paths', dashboardPath); paths.add(taskPath.toLowerCase());
    const packet = await read(taskPath); const contextProblems = packetProblems(packet, id);
    const dependencyList = dependencies(get('依赖'), dashboardPath); declaredDependencies.set(id, dependencyList);
    tasks.push({ id, title: match[2]!, priority: get('优先级').text, status: get('状态').text, blocker: get('下一步 / 阻塞').text, taskPath, dependencies: [], contextComplete: contextProblems.length === 0, contextProblems });
  }
  const order: string[] = []; const orderTokens = section(dashboard, '当前工作顺序');
  for (let index = 0; index < orderTokens.length; index++) {
    const token = orderTokens[index]!;
    if (token.type === 'bullet_list_open' || (token.type === 'ordered_list_open' && token.level !== 0)) throw new PlanningError('UNSUPPORTED_PLAN_FORMAT', 'Work order must use top-level ordered lists', dashboardPath);
    if (token.type !== 'list_item_open') continue;
    requireValue(token.level === 1 && Number(token.info) === order.length + 1, 'Work order numbering must be contiguous from one', dashboardPath);
    const inline = orderTokens[index + 2];
    requireValue(inline?.type === 'inline', 'Task order entry needs one inline link', dashboardPath);
    const children = (inline.children ?? []).filter((child) => !['strong_open', 'strong_close', 'em_open', 'em_close'].includes(child.type) && !(child.type === 'text' && !child.content.trim()));
    requireValue(children[0]?.type === 'link_open', 'Task order entry must begin with a link', dashboardPath);
    const link = links(children)[0]!;
    const path = await resolve(planRoot, link.href);
    const task = tasks.find((entry) => entry.taskPath === path);
    requireValue(task && linkMatches(link.text, task.id), 'Order link identity must match an active Task', dashboardPath);
    requireValue(!order.includes(task.id), 'Repeated Task in work order', dashboardPath); order.push(task.id);
  }
  for (const task of tasks) if (task.status === '🟢 待执行') requireValue(order.includes(task.id), `Ready Task ${task.id} is absent from work order`, dashboardPath);
  // A legacy TaskDetails file may only redirect; it never contributes task data.
  let legacyExists = true;
  try { await lstat(join(planRoot, 'TaskDetails.md')); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') legacyExists = false;
    else throw error;
  }
  if (legacyExists) {
    const legacyPath = await resolve(planRoot, 'TaskDetails.md'); const legacy = await read(legacyPath);
    const found = links(legacy.tokens);
    requireValue(legacy.lines.length <= 20 && !legacy.tokens.some((token) => /(?:table|list)_open$/u.test(token.type) || ['fence', 'code_block'].includes(token.type) || (token.type === 'heading_open' && token.tag !== 'h1')) && found.length === 1 && await resolve(planRoot, found[0]!.href) === dashboardPath, 'TaskDetails must be a short Dashboard redirect', legacyPath);
  }
  const archives = new Map<string, string>();
  const archiveFor = async (id: string): Promise<string> => {
    const cached = archives.get(id); if (cached) return cached;
    let root: string;
    try { root = await resolve(planRoot, 'archive'); } catch (error) {
      if (error instanceof PlanningError && error.code === 'PATH_NOT_FOUND') throw new PlanningError('DEPENDENCY_UNRESOLVED', `No archive for ${id}`, planRoot); throw error;
    }
    const milestones = await readdir(root, { withFileTypes: true });
    const candidates: { indexPath: string; path: string; number: number; date: string; predecessor?: string }[] = [];
    for (const milestone of milestones) {
      if (!milestone.isDirectory() && !milestone.isSymbolicLink()) continue;
      const milestonePath = await resolve(root, milestone.name);
      try { await lstat(join(milestonePath, 'README.md')); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      const indexPath = await resolve(planRoot, `archive/${milestone.name}/README.md`); const index = await read(indexPath);
      for (const table of tables(index, index.tokens)) {
        if (!['任务编号', '完成日期', '验收摘要', '详情'].every((header) => table.headers.includes(header))) continue;
        for (const row of table.rows) {
          if (row.get('任务编号')!.text !== id) continue;
          const date = row.get('完成日期')!.text;
          requireValue(/^\d{4}-\d{2}-\d{2}$/u.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().startsWith(date), 'Invalid archive completion date', indexPath);
          requireValue(row.get('验收摘要')!.text !== '', 'Missing archive acceptance summary', indexPath);
          const link = exactlyOneLink(row.get('详情')!, indexPath); const path = await resolve(dirname(indexPath), link.href);
          const closure = row.get('关闭次数')?.text ?? '1';
          requireValue(/^[1-9]\d*$/u.test(closure) && Number.isSafeInteger(Number(closure)), 'Invalid closure number', indexPath);
          const number = Number(closure);
          requireValue(dirname(path) === dirname(indexPath) && basename(path) === (number === 1 ? `${id}.md` : `${id}.closure-${number}.md`), 'Archive path and closure number disagree', indexPath);
          const predecessor = row.get('前次');
          if (number > 1) {
            requireValue(predecessor && predecessor.text !== '无', 'Repeated closure index must identify its predecessor', indexPath);
            const previousLink = exactlyOneLink(predecessor, indexPath);
            candidates.push({ indexPath, path, number, date, predecessor: await resolve(dirname(indexPath), previousLink.href) });
          } else candidates.push({ indexPath, path, number, date });
        }
      }
    }
    if (!candidates.length) throw new PlanningError('DEPENDENCY_UNRESOLVED', `Missing completed archive for ${id}`, root);
    requireValue(new Set(candidates.map((entry) => entry.indexPath)).size === 1, `Ambiguous cross-milestone archive ${id}`, root);
    candidates.sort((a, b) => a.number - b.number);
    let previous: string | undefined; let previousDate = '';
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      requireValue(candidate.number === index + 1 && candidate.date >= previousDate, 'Closure sequence is duplicate, incomplete or out of order', candidate.indexPath);
      const archive = await read(candidate.path); packetProblems(archive, id);
      const acceptance = section(archive, '验收标准').filter((token) => token.type === 'inline' && /^\[[ xX]\]/u.test(token.content));
      requireValue(acceptance.length > 0 && acceptance.every((token) => /^\[[xX]\]\s+\S/u.test(token.content)), 'Archive acceptance is incomplete', candidate.path);
      const evidence = links(section(archive, '验证证据'));
      requireValue(evidence.length > 0, 'Archive lacks a verification evidence reference', candidate.path);
      for (const link of evidence) { const path = await resolve(dirname(candidate.path), link.href); await evidenceBytes(path); }
      if (previous) {
        requireValue(candidate.predecessor === previous, 'Index predecessor must match the immediately previous closure', candidate.indexPath);
        let hasPrevious = false;
        for (const link of links(archive.tokens)) {
          if (/^[a-z]+:/iu.test(link.href) || /[#?]/u.test(link.href) || basename(link.href) !== basename(previous)) continue;
          if (await resolve(dirname(candidate.path), link.href) === previous) hasPrevious = true;
        }
        requireValue(hasPrevious, 'Repeated closure lacks a link to its predecessor', candidate.path);
      }
      previous = candidate.path; previousDate = candidate.date;
    }
    archives.set(id, previous!); return previous!;
  };
  for (const task of tasks) for (const dependency of declaredDependencies.get(task.id)!) {
    requireValue(dependency.id !== task.id, 'Task cannot depend on itself', dashboardPath);
    const activeDependency = tasks.find((entry) => entry.id === dependency.id);
    const dependencyPath = activeDependency?.taskPath ?? await archiveFor(dependency.id);
    if (dependency.href) {
      const declared = await resolve(planRoot, dependency.href);
      // Reopened active Tasks remain unresolved even if the declaration still points at their old archive.
      requireValue(declared === dependencyPath || (activeDependency && basename(declared).replace(/(?:\.closure-\d+)?\.md$/u, '') === dependency.id), 'Dependency link does not identify its Task or latest closure', dashboardPath);
    }
    task.dependencies.push({ id: dependency.id, path: dependencyPath, completed: !activeDependency });
  }
  const visited = new Set<string>(); const visiting = new Set<string>();
  const visit = (task: PlanningTask): void => {
    if (visiting.has(task.id)) throw new PlanningError('PLAN_AMBIGUOUS', 'Dependency cycle', dashboardPath);
    if (visited.has(task.id)) return; visiting.add(task.id);
    for (const dependency of task.dependencies) { const activeTask = tasks.find((entry) => entry.id === dependency.id); if (activeTask) visit(activeTask); }
    visiting.delete(task.id); visited.add(task.id);
  };
  tasks.forEach(visit);
  return { dashboardPath, order, tasks, references: [...references.values()] };
}
