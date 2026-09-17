import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPlatformRegistry, type PlatformRegistry, type BuildPipeline } from '@dev-harness-runtime/build';
import { isRepoPath, type EvidenceRef } from '@dev-harness-runtime/contracts';
import {
  discoverProject, inspectParentContext, inspectRun, readPlan, reconcileRuntimeRun, resumeRuntimeRun,
  runtimeExitCode, startRuntimeRun, type RuntimeServices, type TaskSelection,
} from '@dev-harness-runtime/core';

export interface CliOutput { out(text: string): void; error(text: string): void }
export interface CliOptions {
  cwd?: string; signal?: AbortSignal; services?: RuntimeServices;
  /** Runtime entries must reference the same objects as services.adapters.get(id). */
  platforms?: PlatformRegistry; build?: BuildPipeline;
}
const commands = ['doctor', 'status', 'run', 'resume', 'reconcile', 'build', 'validate', 'pack'];
const buildCommands = ['build', 'validate', 'pack'];
const help = `dev-harness-runtime

用法: dhr <命令> [参数]
  doctor [--adapter ID] [--project PATH] [--docs-root PATH]
  status --run ID [--verbose] [--project PATH] [--docs-root PATH]
  run --adapter ID (--task ID | --next | --all-ready) [--commit deny|task]
      [--no-commit | --commit-each] [--project PATH] [--docs-root PATH]
  resume --run ID [--expected-revision N] [--project PATH] [--docs-root PATH]
  reconcile --run ID --expected-revision N --resolution FILE
      [--project PATH] [--docs-root PATH]
  build|validate|pack --adapter ID [--project PATH]
  --help | --version

status/resume/reconcile 也接受位置参数 Run ID。默认不提交；提交选项互斥。
status --verbose 只返回已核验日志引用，不展开原始日志；resume 缺省读取当前 revision 后做 CAS。
resolution 文件必须包含 Core 已持久化的 EvidenceRef JSON，不接受隐式审批。
build 从已编译输入生成产物；validate / pack 不隐式编译或生成。
已知平台: ${createPlatformRegistry().list().map((entry) => entry.id).join(', ')}。当前分发包没有已实现的宿主 Executor / Packager；
run/resume/reconcile 需要可信调用者显式注入服务，否则返回 CAPABILITY_MISSING。
`;
class CliError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CliError'; }
}
function invalid(message: string): never { throw new CliError('INVALID_ARGUMENT', `${message}；使用 dhr --help 查看参数。`); }
interface Parsed {
  command: string; cwd: string; docsRoot?: string; adapter?: string; selection?: TaskSelection;
  commit: 'deny' | 'task'; runId?: string; expectedRevision?: number; resolutionPath?: string;
}
function parse(args: readonly string[], cwd: string): Parsed {
  const command = args[0]!;
  if (!commands.includes(command)) invalid(`不支持的命令 ${command}`);
  const common = buildCommands.includes(command) ? ['--project'] : ['--project', '--docs-root'];
  const allowed = new Set([...common, ...({
    build: ['--adapter'], validate: ['--adapter'], pack: ['--adapter'],
    doctor: ['--adapter'], status: ['--run', '--verbose'],
    run: ['--adapter', '--task', '--next', '--all-ready', '--commit', '--no-commit', '--commit-each'],
    resume: ['--run', '--expected-revision'], reconcile: ['--run', '--expected-revision', '--resolution'],
  } as Record<string, string[]>)[command]!]);
  const booleans = new Set(['--next', '--all-ready', '--no-commit', '--commit-each', '--verbose']);
  const flags = new Map<string, string | true>();
  let positional: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) {
      if (!['status', 'resume', 'reconcile'].includes(command) || positional !== undefined || !arg) invalid(`意外的位置参数 ${arg}`);
      positional = arg; continue;
    }
    if (!allowed.has(arg) || flags.has(arg)) invalid(`未知或重复参数 ${arg}`);
    if (booleans.has(arg)) { flags.set(arg, true); continue; }
    const value = args[++index];
    if (!value || value.startsWith('-') || value.includes('\0')) invalid(`参数 ${arg} 缺少有效值`);
    flags.set(arg, value);
  }
  const value = (key: string): string | undefined => { const result = flags.get(key); return typeof result === 'string' ? result : undefined; };
  const parsed: Parsed = { command, cwd: resolve(cwd, value('--project') ?? '.'), commit: 'deny' };
  const docsRoot = value('--docs-root'); if (docsRoot !== undefined) parsed.docsRoot = docsRoot;
  const adapter = value('--adapter');
  if (adapter !== undefined) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(adapter) || adapter.length > 64) invalid('无效 Adapter ID');
    parsed.adapter = adapter;
  }
  if (buildCommands.includes(command) && !adapter) invalid(`${command} 必须指定 --adapter`);
  if (command === 'run') {
    if (!adapter) invalid('run 必须指定 --adapter');
    if (['--task', '--next', '--all-ready'].filter((key) => flags.has(key)).length !== 1) invalid('run 必须且只能选择 --task、--next 或 --all-ready');
    const taskId = value('--task');
    if (taskId !== undefined && !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(taskId)) invalid('无效 Task ID');
    parsed.selection = taskId !== undefined ? { mode: 'explicit', taskId } : { mode: flags.has('--next') ? 'next' : 'all-ready' };
    if (['--commit', '--no-commit', '--commit-each'].filter((key) => flags.has(key)).length > 1) invalid('提交选项不能同时使用');
    const commit = value('--commit') ?? (flags.has('--commit-each') ? 'task' : 'deny');
    if (commit !== 'deny' && commit !== 'task') invalid('--commit 只接受 deny 或 task');
    parsed.commit = commit;
  }
  if (['status', 'resume', 'reconcile'].includes(command)) {
    if (positional !== undefined && flags.has('--run')) invalid('Run ID 不能重复指定');
    const runId = value('--run') ?? positional;
    if (!runId || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(runId)) invalid('必须提供有效 Run ID');
    parsed.runId = runId;
  }
  if (['resume', 'reconcile'].includes(command)) {
    const revision = value('--expected-revision');
    if (revision === undefined && command === 'reconcile') invalid('reconcile 必须提供 --expected-revision');
    if (revision !== undefined) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(revision) || !Number.isSafeInteger(Number(revision))) invalid('--expected-revision 必须是非负安全整数');
      parsed.expectedRevision = Number(revision);
    }
  }
  if (command === 'reconcile') {
    const path = value('--resolution');
    if (!path) invalid('reconcile 必须指定 --resolution EvidenceRef JSON 文件');
    parsed.resolutionPath = resolve(cwd, path);
  }
  return parsed;
}
function platformsFor(options: CliOptions): PlatformRegistry {
  const platforms = options.platforms ?? options.build?.platforms
    ?? createPlatformRegistry(options.services?.adapters.list());
  if (options.build !== undefined && options.build.platforms !== platforms) {
    invalid('BuildPipeline 与 CLI 必须使用同一个 PlatformRegistry 实例');
  }
  if ((options.platforms !== undefined || options.build !== undefined) && options.services !== undefined) {
    for (const runtime of options.services.adapters.list()) {
      if (!platforms.list().some((entry) => entry.id === runtime.id && entry.runtime === runtime)) {
        invalid(`Runtime 服务与 PlatformRegistry 的 ${runtime.id} 注册对象不一致`);
      }
    }
  }
  return platforms;
}
function checkAdapter(id: string, platforms: PlatformRegistry): void {
  if (!platforms.list().some((entry) => entry.id === id)) throw new CliError('UNKNOWN_ADAPTER', `未知 Adapter: ${id}`);
}
async function resolution(path: string): Promise<EvidenceRef> {
  let record: unknown;
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))); }
  catch { return invalid('--resolution 必须是可读取的 EvidenceRef JSON 文件'); }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) invalid('--resolution 不是 EvidenceRef');
  const ref = record as Record<string, unknown>;
  if (Object.keys(ref).length !== 3 || ref.schemaVersion !== 1 || typeof ref.path !== 'string' || !isRepoPath(ref.path)
    || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.sha256)) invalid('--resolution 不是有效的 EvidenceRef');
  return { schemaVersion: 1, path: ref.path, sha256: ref.sha256 };
}
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError'); }

/** CLI arguments never load executable services from a project, environment variable or Worker result. */
export async function runCli(args: readonly string[], output: CliOutput, options: CliOptions = {}): Promise<number> {
  if (process.env.DEV_HARNESS_WORKER === '1' && ['run', 'resume', 'reconcile'].includes(args[0] ?? '')) {
    output.error('AUTHORIZATION_VIOLATION: Worker 环境不能递归调用 dhr run、resume 或 reconcile。\n'); return 5;
  }
  try {
    abort(options.signal);
    if (args.length === 0 || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!))) { output.out(help); return 0; }
    if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
      const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      output.out(`${manifest.version}\n`); return 0;
    }
    const parsed = parse(args, options.cwd ?? process.cwd());
    const resolutionRef = parsed.command === 'reconcile' && options.services ? await resolution(parsed.resolutionPath!) : undefined;
    const platforms = platformsFor(parsed.command === 'status' ? {} : options);
    if (parsed.adapter !== undefined) checkAdapter(parsed.adapter, platforms);
    if (buildCommands.includes(parsed.command)) {
      if (options.build !== undefined && resolve(options.build.root) !== parsed.cwd) {
        invalid('BuildPipeline root 与 --project / cwd 不一致');
      }
      if (platforms.get(parsed.adapter!).packager === undefined || options.build === undefined) {
        throw new CliError('CAPABILITY_MISSING', '未配置该平台的可信 Packager 和 BuildPipeline；不会加载项目提供的代码。');
      }
      const result = parsed.command === 'build' ? await options.build.generate(parsed.adapter!)
        : parsed.command === 'validate' ? await options.build.validate(parsed.adapter!) : await options.build.pack(parsed.adapter!);
      abort(options.signal); output.out(`${JSON.stringify(result)}\n`);
      return parsed.command === 'validate' && !('valid' in result && result.valid) ? 4 : 0;
    }
    const discovery = parsed.docsRoot === undefined ? {} : { docsRoot: parsed.docsRoot };
    if (parsed.command === 'doctor') {
      const project = await discoverProject(parsed.cwd, { ...discovery, doctor: true });
      const issues = [...project.issues];
      let planning: { tasks: number; orderedTasks: number } | null = null;
      try { const plan = await readPlan(project); planning = { tasks: plan.tasks.length, orderedTasks: plan.order.length }; }
      catch (error) { issues.push({ code: error instanceof Error && 'code' in error ? String(error.code) : 'PLAN_INVALID', message: error instanceof Error ? error.message : 'Planning cannot be read' }); }
      const ids = parsed.adapter === undefined ? platforms.list().map((entry) => entry.id) : [parsed.adapter];
      const adapters = ids.map((id) => ({ id, available: false, authorizationEnforced: false,
        reason: platforms.get(id).runtime !== undefined ? 'Registered services have not been probed by this read-only diagnostic' : 'No implemented host Executor is installed' }));
      issues.push({ code: 'CAPABILITY_MISSING', message: 'Execution capability has not been established; metadata is not an Executor probe' });
      abort(options.signal);
      output.out(`${JSON.stringify({ project: project.repoRoot, docsRoot: project.docsRoot, head: project.head, planning, issues, adapters })}\n`);
      return 2;
    }
    if (parsed.command === 'status') {
      const project = await discoverProject(parsed.cwd, discovery);
      const summary = await inspectParentContext(project, parsed.runId!);
      abort(options.signal); output.out(`${JSON.stringify(summary)}\n`); return 0;
    }
    if (!options.services) throw new CliError('CAPABILITY_MISSING', '未配置可信宿主 Executor 和受控 Runtime 服务；不会启动任务或加载项目提供的代码。');
    if (parsed.command === 'run' && platforms.get(parsed.adapter!).runtime === undefined) {
      throw new CliError('CAPABILITY_MISSING', '该平台没有已注册的宿主 Executor。');
    }
    const services = { ...options.services, adapters: platforms.runtimeRegistry() };
    if (parsed.command === 'resume' && parsed.expectedRevision === undefined) {
      const project = await discoverProject(parsed.cwd, discovery);
      parsed.expectedRevision = (await inspectRun(project, parsed.runId!)).revision;
    }
    const common = { cwd: parsed.cwd, ...discovery, ...(options.signal ? { signal: options.signal } : {}) };
    const result = parsed.command === 'run'
      ? await startRuntimeRun({ ...common, adapter: parsed.adapter!, selection: parsed.selection!, commit: parsed.commit }, services)
      : parsed.command === 'resume'
        ? await resumeRuntimeRun({ ...common, runId: parsed.runId!, expectedRevision: parsed.expectedRevision! }, services)
        : await reconcileRuntimeRun({ ...common, runId: parsed.runId!, expectedRevision: parsed.expectedRevision!, resolutionRef: resolutionRef! }, services);
    const project = await discoverProject(parsed.cwd, discovery);
    output.out(`${JSON.stringify(await inspectParentContext(project, result.state.runId))}\n`);
    return options.signal?.aborted ? 130 : result.exitCode;
  } catch (error) {
    const code = error instanceof Error && error.name === 'AbortError' ? 'CANCELLED'
      : error instanceof Error && 'code' in error ? String(error.code) : 'CLI_FAILED';
    output.error(`${code}: ${error instanceof Error ? error.message : 'CLI request failed'}\n`);
    return options.signal?.aborted ? 130 : runtimeExitCode(error);
  }
}
