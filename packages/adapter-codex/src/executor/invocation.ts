import { isAbsolute, normalize } from 'node:path';
import type { TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { CodexProcessError } from './process.js';

export interface CodexInvocationInput {
  readonly request: TaskExecutionRequest;
  readonly prompt: string;
  /** Host-owned MCP launch command and arguments, never Worker-provided. */
  readonly mcpCommand: string;
  readonly mcpArgs: readonly string[];
  readonly outputSchema: string;
}

/** Fixed host entry. It narrows configuration but does not itself enforce a tool boundary. */
export function createCodexInvocation(input: CodexInvocationInput): readonly string[] {
  for (const path of [input.request.repoRoot, input.mcpCommand, input.outputSchema]) {
    if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
      throw new CodexProcessError('INVALID_ARGUMENT', 'Codex invocation paths must be normalized and absolute');
    }
  }
  if (!Array.isArray(input.mcpArgs) || input.mcpArgs.length < 2 || input.mcpArgs.length > 128
    || input.mcpArgs.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
    || Buffer.byteLength(JSON.stringify(input.mcpArgs), 'utf8') > 64 * 1024) {
    throw new CodexProcessError('INVALID_ARGUMENT', 'Codex MCP launch arguments are malformed or too large');
  }
  if (!input.prompt || input.prompt.includes('\0')) {
    throw new CodexProcessError('INVALID_ARGUMENT', 'Codex invocation requires a bounded prompt');
  }
  if (Buffer.byteLength(input.prompt, 'utf8') > 256 * 1024) {
    throw new CodexProcessError('INVALID_ARGUMENT', 'Codex invocation prompt is too large');
  }
  const config = (key: string, value: string): string[] => ['-c', `${key}=${value}`];
  return [
    'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--disable', 'apps', '--disable', 'browser_use', '--disable', 'browser_use_external',
    '--disable', 'browser_use_full_cdp_access', '--disable', 'computer_use',
    '--disable', 'plugins', '--disable', 'shell_tool',
    '--sandbox', 'read-only', '--skip-git-repo-check', '--json',
    '--output-schema', input.outputSchema, '-C', input.request.repoRoot,
    ...config('web_search', '"disabled"'),
    ...config('mcp_servers.dhr_proposal.command', JSON.stringify(input.mcpCommand)),
    ...config('mcp_servers.dhr_proposal.args', JSON.stringify(input.mcpArgs)),
    ...config('mcp_servers.dhr_proposal.required', 'true'),
    ...config('mcp_servers.dhr_proposal.enabled_tools', '["dhr_propose_text","dhr_propose_delete","dhr_identity","dhr_list_paths","dhr_read_text","dhr_search_text"]'),
    ...config('mcp_servers.dhr_proposal.tools.dhr_propose_text.approval_mode', '"approve"'),
    ...config('mcp_servers.dhr_proposal.tools.dhr_propose_delete.approval_mode', '"approve"'),
    ...config('mcp_servers.dhr_proposal.tools.dhr_identity.approval_mode', '"approve"'),
    ...config('mcp_servers.dhr_proposal.tools.dhr_list_paths.approval_mode', '"approve"'),
    ...config('mcp_servers.dhr_proposal.tools.dhr_read_text.approval_mode', '"approve"'),
    ...config('mcp_servers.dhr_proposal.tools.dhr_search_text.approval_mode', '"approve"'),
    '--',
    `${input.prompt}\n\n## Codex 结构化结果\n最终只返回一个 JSON 对象，顶层仅含 result；result 是本次 TaskExecutionResult。按输出 Schema 给所有可选属性填 null，Core 会重新核对请求身份、结果与实际文件。不要使用 Markdown 代码块。`,
  ];
}
