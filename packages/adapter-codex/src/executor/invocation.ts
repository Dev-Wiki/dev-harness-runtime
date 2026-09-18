import { isAbsolute, normalize } from 'node:path';
import type { TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { CodexProcessError } from './process.js';

export interface CodexInvocationInput {
  readonly request: TaskExecutionRequest;
  readonly prompt: string;
  readonly nodeBinary: string;
  readonly proposalServer: string;
  readonly outputSchema: string;
}

/** Fixed host entry. It narrows configuration but does not itself enforce a tool boundary. */
export function createCodexInvocation(input: CodexInvocationInput): readonly string[] {
  for (const path of [input.request.repoRoot, input.nodeBinary, input.proposalServer, input.outputSchema]) {
    if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
      throw new CodexProcessError('INVALID_ARGUMENT', 'Codex invocation paths must be normalized and absolute');
    }
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
    ...config('mcp_servers.dhr_proposal.command', JSON.stringify(input.nodeBinary)),
    ...config('mcp_servers.dhr_proposal.args', JSON.stringify([input.proposalServer])),
    ...config('mcp_servers.dhr_proposal.required', 'true'),
    ...config('mcp_servers.dhr_proposal.enabled_tools', '["dhr_propose_text"]'),
    ...config('mcp_servers.dhr_proposal.tools.dhr_propose_text.approval_mode', '"approve"'),
    input.prompt,
  ];
}
