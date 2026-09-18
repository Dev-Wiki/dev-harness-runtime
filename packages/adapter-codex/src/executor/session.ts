import type { TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import type { WorkerReadCatalog } from '@dev-harness-runtime/core';
import { createCodexBridgePolicy, withCodexBridgePolicy } from './bridge-policy.js';
import { createCodexInvocation } from './invocation.js';
import { runCodexProcess, type CodexProcessInput, type CodexProcessOutput } from './process.js';
import { withCodexResultSchema } from './result-schema.js';

export interface CodexSessionInput {
  readonly binary: string;
  readonly nodeBinary: string;
  readonly proposalServer: string;
  /** A trusted controller may replace the direct MCP process with a confined launcher. */
  readonly bridgeProcess?: (policyPath: string) => Promise<{
    command: string; args: readonly string[]; close?: () => Promise<void>;
  }>;
  readonly hostProcess?: (input: CodexProcessInput, bridge: {
    command: string; args: readonly string[]; hostSources?: readonly string[];
    repoMirror?: string; close?: () => Promise<void>;
  }, outputSchema: string) => Promise<CodexProcessOutput>;
  readonly request: TaskExecutionRequest;
  readonly readCatalog: WorkerReadCatalog;
  readonly prompt: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly log: (stream: 'events' | 'stderr', bytes: Uint8Array) => Promise<void>;
}

/** One fresh synthetic/host transport session; no authorization or process-tree proof. */
export async function runCodexSession(input: CodexSessionInput): Promise<CodexProcessOutput> {
  const policy = createCodexBridgePolicy(input.request, input.readCatalog);
  return withCodexBridgePolicy(policy, (bridgePolicy) => withCodexResultSchema(async (outputSchema) => {
    const mcp = await input.bridgeProcess?.(bridgePolicy)
      ?? { command: input.nodeBinary, args: [input.proposalServer, bridgePolicy] };
    try {
      const argv = createCodexInvocation({ request: input.request, prompt: input.prompt,
        mcpCommand: mcp.command, mcpArgs: mcp.args, outputSchema });
      const processInput = { binary: input.binary, argv, cwd: input.request.repoRoot,
        env: input.env, request: input.request, signal: input.signal, log: input.log };
      return await (input.hostProcess?.(processInput, mcp, outputSchema) ?? runCodexProcess(processInput));
    } finally { await mcp.close?.(); }
  }));
}
