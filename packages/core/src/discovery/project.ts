import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import MarkdownIt, { type Token } from 'markdown-it';
import { PlanningError } from '../planning/types.js';
import { readProjectText, resolveProjectPath } from './paths.js';

export interface DiscoveryOptions { docsRoot?: string; doctor?: boolean }
export interface ProjectContext {
  repoRoot: string;
  privateGitDir: string;
  stateRoot: string;
  docsRoot: string;
  dashboardPath: string;
  head: string | null;
  agentsPath: string;
  harnessPath: string;
  gitWorkflowPath?: string;
  verificationCommands: { purpose: string; command: string }[];
  issues: { code: string; message: string }[];
}

const execute = promisify(execFile);
const markdown = new MarkdownIt({ html: true });

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) delete env[name];
  for (const name of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/u.test(name)) delete env[name];
  const { stdout } = await execute('git', ['--no-optional-locks', '-C', cwd, ...args], { env, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function canonicalStateRoot(privateGitDir: string, target: string): Promise<string> {
  let ancestor = target;
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  let canonical: string;
  try { canonical = resolve(await realpath(ancestor), relative(ancestor, target)); }
  catch { throw new PlanningError('PATH_ESCAPE', 'State root has an invalid or dangling symlink ancestor', target); }
  const path = relative(privateGitDir, canonical);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new PlanningError('PATH_ESCAPE', 'State root must remain inside the private Git directory', target);
  }
  return canonical;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function inlineText(token: Token | undefined): string {
  return (token?.children ?? []).filter((child) => ['text', 'code_inline'].includes(child.type)).map((child) => child.content).join('').trim();
}

function links(text: string): string[] {
  return markdown.parse(text, {}).flatMap((token) => (token.children ?? [])
    .filter((child) => child.type === 'link_open').map((child) => child.attrGet('href')).filter((href): href is string => typeof href === 'string'));
}

function harnessCommands(text: string, path: string): { purpose: string; command: string }[] {
  const tokens = markdown.parse(text, {});
  const commands: { purpose: string; command: string }[] = [];
  let sectionLevel = 0;
  let sectionCount = 0;
  let headers: string[] = [];
  let table = false;
  let head = false;
  let rowLine: number | undefined;
  let row: { text: string; token: Token | undefined }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.type === 'heading_open') {
      const level = Number(token.tag.slice(1));
      const title = inlineText(tokens[index + 1]).replace(/^\d+[.)、]\s*/u, '');
      if (/^(?:已确认命令(?:[（(].*[）)])?|Confirmed commands)$/iu.test(title)) {
        if (token.level !== 0) throw new PlanningError('PROJECT_CONTRACT_MISSING', 'Confirmed command section must be top-level', path);
        sectionCount += 1; sectionLevel = level;
      } else if (level <= sectionLevel) sectionLevel = 0;
    }
    if (!sectionLevel) continue;
    if (token.type === 'html_block' || token.children?.some((child) => child.type === 'html_inline')) {
      throw new PlanningError('PROJECT_CONTRACT_MISSING', 'Confirmed commands cannot contain hidden HTML', path, token.map ? token.map[0] + 1 : undefined);
    }
    if (token.type === 'table_open' && token.level !== 0) throw new PlanningError('PROJECT_CONTRACT_MISSING', 'Confirmed command tables cannot be nested', path);
    if (token.type === 'table_open') { table = true; headers = []; }
    if (token.type === 'table_close') table = false;
    if (!table) continue;
    if (token.type === 'thead_open') head = true;
    if (token.type === 'thead_close') head = false;
    if (token.type === 'tr_open') { row = []; rowLine = token.map ? token.map[0] + 1 : undefined; }
    if (token.type === 'th_open' || token.type === 'td_open') row.push({ text: inlineText(tokens[index + 1]), token: tokens[index + 1] });
    if (token.type !== 'tr_close') continue;
    if (head) {
      headers = row.map((cell) => cell.text);
      for (const names of [['用途', 'purpose'], ['命令', 'command'], ['状态', 'status']]) {
        if (headers.filter((header) => names.includes(header.toLowerCase())).length > 1) {
          throw new PlanningError('PROJECT_CONTRACT_MISSING', 'HARNESS command table has duplicate columns', path, rowLine);
        }
      }
      continue;
    }
    const column = (chinese: string, english: string) => headers.findIndex((header) => header === chinese || header.toLowerCase() === english);
    const purposeIndex = column('用途', 'purpose'); const commandIndex = column('命令', 'command'); const statusIndex = column('状态', 'status');
    if ([purposeIndex, commandIndex, statusIndex].some((position) => position < 0)) continue;
    if (row[statusIndex]?.text !== 'confirmed') continue;
    const purpose = row[purposeIndex]?.text ?? '';
    const cell = row[commandIndex];
    const code = cell?.token?.children?.filter((child) => child.type === 'code_inline') ?? [];
    const command = code[0]?.content ?? '';
    // eslint-disable-next-line no-control-regex -- Commands are single-line text without NUL.
    if (!purpose || code.length !== 1 || cell?.text !== command || !command.trim() || /[\r\n\0]/u.test(command)
      || /^(?:unknown|missing|todo|tbd)$/iu.test(command) || commands.some((entry) => entry.purpose === purpose)) {
      throw new PlanningError('PROJECT_CONTRACT_MISSING', 'HARNESS confirmed command is invalid or duplicated', path, rowLine);
    }
    commands.push({ purpose, command });
  }
  if (sectionCount !== 1 || !commands.some((entry) => ['test', 'quick', 'bugfix', 'full'].includes(entry.purpose))) {
    throw new PlanningError('PROJECT_CONTRACT_MISSING', 'HARNESS requires one confirmed command section with executable entries', path);
  }
  return commands;
}

async function chooseDocsRoot(repoRoot: string, explicit: string | undefined, governance: readonly string[]): Promise<string> {
  if (explicit !== undefined) {
    const reference = isAbsolute(explicit) ? relative(repoRoot, explicit).split(sep).join('/') : explicit;
    const selected = await resolveProjectPath(repoRoot, repoRoot, reference);
    if (!(await stat(selected)).isDirectory()) throw new PlanningError('DOCS_ROOT_MISSING', 'Explicit docs root is not a directory', selected);
    return selected;
  }
  const candidates: string[] = [];
  for (const name of ['doc', 'docs']) {
    if (await exists(join(repoRoot, name))) {
      const candidate = await resolveProjectPath(repoRoot, repoRoot, name);
      if ((await stat(candidate)).isDirectory()) candidates.push(candidate);
    }
  }
  if (candidates.length === 0) throw new PlanningError('DOCS_ROOT_MISSING', 'Neither doc nor docs exists', repoRoot);
  if (candidates.length === 1) return candidates[0]!;
  const ownership = new Set<string>();
  for (const document of governance) {
    for (const href of links(document)) {
      if (!/^(?:\.\/)?docs?\//u.test(href)) continue;
      const target = await resolveProjectPath(repoRoot, repoRoot, href);
      for (const candidate of candidates) if (target.startsWith(`${candidate}${sep}`)) ownership.add(candidate);
    }
  }
  if (ownership.size === 1) return [...ownership][0]!;
  if (ownership.size > 1) throw new PlanningError('DOCS_ROOT_AMBIGUOUS', 'Governance links refer to both doc and docs', repoRoot);
  const active = [];
  for (const candidate of candidates) if (await exists(join(candidate, 'plan', 'Dashboard.md'))) active.push(candidate);
  if (active.length === 1) return active[0]!;
  throw new PlanningError('DOCS_ROOT_AMBIGUOUS', 'Cannot prove unique doc/docs ownership', repoRoot);
}

/** Read-only discovery: no state directory, docs root, or governance file is created. */
export async function discoverProject(cwd: string, options: DiscoveryOptions = {}): Promise<ProjectContext> {
  let repoRoot: string;
  let privateGitDir: string;
  let stateRoot: string;
  try {
    repoRoot = await realpath(await git(cwd, ['rev-parse', '--show-toplevel']));
    privateGitDir = await realpath(await git(repoRoot, ['rev-parse', '--absolute-git-dir']));
    const stateDirectory = await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'dev-harness-runtime']);
    stateRoot = join(stateDirectory, 'runs');
  } catch { throw new PlanningError('NOT_GIT_REPOSITORY', 'Cannot discover a Git working tree', cwd); }
  stateRoot = await canonicalStateRoot(privateGitDir, stateRoot);
  const issues: ProjectContext['issues'] = [];
  let head: string | null = null;
  try { head = await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']); }
  catch { issues.push({ code: 'UNBORN_HEAD', message: 'Project has no valid HEAD commit' }); }
  let agentsPath = join(repoRoot, 'AGENTS.md'); let harnessPath = join(repoRoot, 'HARNESS.md');
  const governance: string[] = [];
  let verificationCommands: ProjectContext['verificationCommands'] = [];
  for (const name of ['AGENTS.md', 'HARNESS.md']) {
    try {
      const path = await resolveProjectPath(repoRoot, repoRoot, name);
      const text = await readProjectText(path);
      if (!text.trim()) throw new PlanningError('PROJECT_CONTRACT_MISSING', `${name} is empty`, path);
      governance.push(text);
      if (name === 'AGENTS.md') agentsPath = path;
      else { harnessPath = path; verificationCommands = harnessCommands(text, path); }
    } catch (error) {
      issues.push({ code: 'PROJECT_CONTRACT_MISSING', message: `${name}: ${error instanceof Error ? error.message : 'unreadable project contract'}` });
    }
  }
  if (!options.doctor && issues.length) throw new PlanningError(issues[0]!.code, issues[0]!.message, repoRoot);
  let docsRoot: string;
  try { docsRoot = await chooseDocsRoot(repoRoot, options.docsRoot, governance); }
  catch (error) {
    if (!options.doctor || !(error instanceof PlanningError) || error.code !== 'DOCS_ROOT_MISSING') throw error;
    issues.push({ code: error.code, message: error.message }); docsRoot = join(repoRoot, 'docs');
  }
  let dashboardPath = join(docsRoot, 'plan', 'Dashboard.md');
  try { dashboardPath = await resolveProjectPath(repoRoot, docsRoot, 'plan/Dashboard.md'); }
  catch (error) {
    if (!options.doctor) throw error;
    issues.push({ code: error instanceof PlanningError ? error.code : 'PATH_NOT_FOUND', message: 'Dashboard is missing or invalid' });
  }
  const project: ProjectContext = { repoRoot, privateGitDir, stateRoot, docsRoot, dashboardPath, head, agentsPath, harnessPath, verificationCommands, issues };
  const workflows = new Set<string>();
  for (const document of governance) for (const href of links(document)) {
    if (/(?:^|\/)GIT_WORKFLOW\.md$/u.test(href)) workflows.add(await resolveProjectPath(repoRoot, repoRoot, href));
  }
  if (workflows.size > 1) throw new PlanningError('PROJECT_CONTRACT_MISSING', 'Multiple Git workflow references', repoRoot);
  const workflow = [...workflows][0];
  if (workflow) project.gitWorkflowPath = workflow;
  else if (await exists(join(docsRoot, 'GIT_WORKFLOW.md'))) project.gitWorkflowPath = await resolveProjectPath(repoRoot, docsRoot, 'GIT_WORKFLOW.md');
  return project;
}
