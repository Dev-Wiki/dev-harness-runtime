import { createHash } from 'node:crypto';
import { relative, sep, posix } from 'node:path';
import { isRepoPath, parseContract, type VerificationPlan } from '@dev-harness-runtime/contracts';
import { readConfirmedVerificationCommands } from '../discovery/project.js';
import { parseMarkdown, section } from '../planning/markdown.js';
import { PlanningError } from '../planning/types.js';
import { readSnapshotFiles, parseLiteralCommand } from '../result/frozen.js';
import type { RuntimeServices, PreparedTask } from './types.js';

type PrepareInput = Parameters<RuntimeServices['prepareTask']>[0];
type Entry = Record<string, unknown>;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function error(path: string, message: string): never {
  throw new PlanningError('UNSUPPORTED_PLAN_FORMAT', message, path);
}
function record(value: unknown, path: string, keys: readonly string[]): Entry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    error(path, `Runtime declaration requires exactly: ${keys.join(', ')}`);
  }
  return value as Entry;
}
function strings(value: unknown, path: string, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !isRepoPath(item))
    || new Set(value.map((item: string) => item.toLowerCase())).size !== value.length) {
    error(path, `${label} must contain unique repository-relative paths`);
  }
  return value as string[];
}
function identities(value: unknown, path: string, count: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !Number.isInteger(item) || item < 1 || item > count)
    || new Set(value).size !== value.length) error(path, 'Verification criteria must identify distinct Task checkboxes');
  return value.map((item: number) => `criterion-${item}`);
}
function sourceHash(input: PrepareInput, path: string): string {
  const found = input.before.snapshot.paths.find((entry) => entry.path === path);
  if (found?.type !== 'file') error(path, 'Frozen verification source must be an existing regular file');
  return found.rawContentHash;
}
function impactPaths(tokens: ReturnType<typeof section>, path: string): { files: string[]; directories: string[] } {
  const files: string[] = []; const directories: string[] = [];
  let listDepth = 0;
  for (const token of tokens) {
    if (token.type === 'list_item_open') listDepth++;
    if (token.type === 'list_item_close') listDepth--;
    if (token.type !== 'inline' || listDepth === 0) continue;
    const paths = (token.children ?? []).filter((child) => child.type === 'code_inline').map((child) => child.content);
    if (paths.length !== 1) error(path, 'Every impact-file bullet must contain exactly one code path');
    const raw = paths[0]!;
    const directory = raw.endsWith('/');
    const normalized = directory ? raw.slice(0, -1) : raw;
    if (!isRepoPath(normalized)) error(path, 'Impact-file path is not repository-relative');
    (directory ? directories : files).push(normalized);
  }
  if (files.length + directories.length === 0) error(path, 'Impact-file list is empty');
  if (new Set([...files, ...directories].map((entry) => entry.toLowerCase())).size !== files.length + directories.length) {
    error(path, 'Impact-file paths are duplicated or case-aliased');
  }
  return { files, directories };
}

/** Freeze the current Task's explicit non-executable declaration against its original snapshot. */
export async function prepareDeclaredPlanningTask(input: PrepareInput): Promise<PreparedTask> {
  const { project, task, before } = input;
  const taskPath = relative(project.repoRoot, task.taskPath).split(sep).join('/');
  const dashboardPath = relative(project.repoRoot, project.dashboardPath).split(sep).join('/');
  const docsPath = relative(project.repoRoot, project.docsRoot).split(sep).join('/');
  if (!isRepoPath(taskPath) || !isRepoPath(dashboardPath) || !isRepoPath(docsPath)
    || taskPath !== `${docsPath}/plan/tasks/${task.id}.md`
    || dashboardPath !== `${docsPath}/plan/Dashboard.md`) {
    error(taskPath, 'Selected Task and Dashboard do not belong to the discovered plan');
  }
  const files = await readSnapshotFiles(before, [taskPath, 'HARNESS.md']);
  const taskBytes = files.get(taskPath); const harnessBytes = files.get('HARNESS.md');
  if (!taskBytes || !harnessBytes) error(taskPath, 'Task and HARNESS must be frozen regular files');
  const utf8 = (bytes: Uint8Array, path: string) => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return error(path, 'Runtime input is not UTF-8'); }
  };
  const packet = parseMarkdown(utf8(taskBytes, taskPath), taskPath);
  const runtime = section(packet, 'Runtime 配置');
  const fences = runtime.filter((token) => token.type === 'fence');
  if (fences.length !== 1 || fences[0]!.info.trim() !== 'dhr-runtime' || Buffer.byteLength(fences[0]!.content) > 65_536) {
    error(taskPath, 'Runtime 配置 requires one bounded dhr-runtime JSON fence');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fences[0]!.content); }
  catch { return error(taskPath, 'Runtime declaration is not JSON'); }
  const config = record(parsed, taskPath, ['schemaVersion', 'scope', 'verification']);
  if (config.schemaVersion !== 1) error(taskPath, 'Unsupported Runtime declaration version');
  const declaredScope = record(config.scope, taskPath, ['files', 'directories', 'archivePath']);
  const scopeFiles = strings(declaredScope.files, taskPath, 'Scope files');
  const scopeDirectories = strings(declaredScope.directories, taskPath, 'Scope directories');
  const impact = impactPaths(section(packet, '影响文件'), taskPath);
  if (JSON.stringify([...scopeFiles].sort()) !== JSON.stringify([...impact.files].sort())
    || JSON.stringify([...scopeDirectories].sort()) !== JSON.stringify([...impact.directories].sort())) {
    error(taskPath, 'Runtime scope must equal the Task impact-file list');
  }
  const archivePath = declaredScope.archivePath;
  if (typeof archivePath !== 'string' || !isRepoPath(archivePath)
    || !archivePath.startsWith(`${docsPath}/plan/archive/`)
    || archivePath.split('/').length !== docsPath.split('/').length + 4
    || !archivePath.endsWith(`/${task.id}.md`)) {
    error(taskPath, 'Archive path must identify this Task in one plan milestone');
  }
  const archiveIndexPath = posix.join(posix.dirname(archivePath), 'README.md');
  sourceHash(input, archiveIndexPath);
  if (before.snapshot.paths.some((entry) => entry.path === archivePath && entry.type !== 'missing')) {
    error(taskPath, 'Target Task archive already exists');
  }
  const scope = parseContract('scope', { schemaVersion: 1, files: scopeFiles, directories: scopeDirectories,
    planning: { taskId: task.id, taskPath, archivePath, archiveIndexPath, dashboardPath } });
  const acceptance = section(packet, '验收标准').filter((token) => token.type === 'inline' && /^\[[ xX]\]\s+/u.test(token.content))
    .map((token, index) => ({ id: `criterion-${index + 1}`, text: token.content.replace(/^\[[ xX]\]\s+/u, '').trim() }));
  if (acceptance.length === 0) error(taskPath, 'Task has no acceptance checkboxes');
  const verification = record(config.verification, taskPath, ['sources', 'commands', 'manual']);
  const extraSources = strings(verification.sources, taskPath, 'Verification sources');
  if (extraSources.some((path) => ['HARNESS.md', taskPath].includes(path) || scopeFiles.includes(path)
    || scopeDirectories.some((directory) => path.startsWith(`${directory}/`)))) {
    error(taskPath, 'Verification sources cannot repeat governance or overlay candidate Task files');
  }
  const sources = ['HARNESS.md', taskPath, ...extraSources].map((path) => ({ path, sha256: sourceHash(input, path) }));
  const confirmed = readConfirmedVerificationCommands(utf8(harnessBytes, 'HARNESS.md'), 'HARNESS.md');
  const taskCommands = new Set(section(packet, '验证证据').flatMap((token) => token.type === 'inline'
    ? (token.children ?? []).filter((child) => child.type === 'code_inline').map((child) => child.content) : []));
  if (!Array.isArray(verification.commands) || !Array.isArray(verification.manual)) {
    error(taskPath, 'Verification commands and manual checks must be arrays');
  }
  const commands: VerificationPlan['commands'] = verification.commands.map((value: unknown) => {
    const entry = record(value, taskPath, ['id', 'purpose', 'criteria', 'writableArtifacts']);
    const selected = confirmed.find((item) => item.purpose === entry.purpose);
    if (typeof entry.id !== 'string' || !selected || !taskCommands.has(selected.command)) {
      error(taskPath, 'Verification command must occur in both Task evidence and confirmed HARNESS');
    }
    return { id: entry.id, acceptanceIds: identities(entry.criteria, taskPath, acceptance.length),
      argv: parseLiteralCommand(selected.command), cwd: '.',
      writableArtifacts: strings(entry.writableArtifacts, taskPath, 'Verification artifacts') };
  });
  const manual: VerificationPlan['manual'] = verification.manual.map((value: unknown) => {
    const entry = record(value, taskPath, ['id', 'criteria', 'description']);
    if (typeof entry.id !== 'string' || typeof entry.description !== 'string' || !entry.description.trim()) {
      error(taskPath, 'Manual acceptance needs an ID and description');
    }
    return { id: entry.id, acceptanceIds: identities(entry.criteria, taskPath, acceptance.length), description: entry.description };
  });
  const verificationPlan = parseContract('verificationPlan', { schemaVersion: 1, sources, commands, manual });
  const covered = new Set([...commands, ...manual].flatMap((check) => check.acceptanceIds));
  if (covered.size !== acceptance.length || acceptance.some((criterion) => !covered.has(criterion.id))) {
    error(taskPath, 'Every original acceptance checkbox must have a verification check');
  }
  if (hash(taskBytes) !== sourceHash(input, taskPath) || hash(harnessBytes) !== sourceHash(input, 'HARNESS.md')) {
    error(taskPath, 'Runtime inputs drifted from the Task snapshot');
  }
  return { scope, acceptance, verificationPlan };
}
