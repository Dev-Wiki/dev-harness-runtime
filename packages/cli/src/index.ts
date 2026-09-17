import { readFileSync } from 'node:fs';

export interface CliOutput {
  out(text: string): void;
  error(text: string): void;
}

/** The initial CLI is side-effect free apart from explicit output. */
export function runCli(args: readonly string[], output: CliOutput): number {
  // Reject recursive authority before parsing modes or dispatching any command.
  if (process.env.DEV_HARNESS_WORKER === '1' && ['run', 'resume', 'reconcile'].includes(args[0] ?? '')) {
    output.error('AUTHORIZATION_VIOLATION: Worker 环境不能递归调用 dhr run、resume 或 reconcile。\n');
    return 5;
  }
  if (args.length === 0 || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!))) {
    output.out('dev-harness-runtime\n\n用法: dhr [--help | --version]\n\n当前为工程骨架；任务执行与平台打包尚未实现。\n');
    return 0;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    output.out(`${manifest.version}\n`);
    return 0;
  }
  output.error('不支持的命令。使用 dhr --help 查看当前可用入口。\n');
  return 2;
}
