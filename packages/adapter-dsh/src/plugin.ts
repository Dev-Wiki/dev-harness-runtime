import { createHash } from 'node:crypto';

// Early syntax feedback only; Core's WorkerProposalCollector revalidates the authoritative scope.
function portableRepoPath(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in model-supplied paths.
  return value.length > 0 && !/[\\:\x00-\x1f\x7f]/u.test(value) && value.split('/').every((part) =>
    part !== '' && part !== '.' && part !== '..' && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

/** DSH host surface. Task execution remains disabled until K6 proves its session and permission boundary. */
export const name = 'dev-harness-runtime';
export const inject = ['commands', 'tools'];

interface ProposalTool {
  name: string; description: string; parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<string>;
}
interface CommandContext {
  commands: { register(definition: { name: string; description: string;
    handler(): { kind: 'success'; text: string } }): () => void };
  tools: {
    get(name: string, scope?: unknown): ProposalTool | undefined;
    register(definition: ProposalTool): () => void;
    guard(check: (execution: { readonly name: string; readonly agent?: unknown }) => string | undefined): () => void;
  };
  effect(register: () => () => void, label: string): void;
}

/** Until the scoped bridge exists, a DHR Worker cannot invoke any DSH model-facing tool. */
export function guardUnbridgedWorkerTool(environment: Readonly<Record<string, string | undefined>>,
  _execution: { readonly name: string }): string | undefined {
  if (environment.DEV_HARNESS_WORKER === '1' && environment.DEV_HARNESS_ADAPTER === 'dsh') {
    return 'DHR Worker tool execution requires a controlled Task bridge';
  }
  return undefined;
}

/** This tool only acknowledges a proposal; it cannot edit or persist project content. */
export function createDshProposalTool(): ProposalTool {
  return {
    name: 'dhr_propose_text',
    description: 'Propose UTF-8 text for one Task-scoped file. This does not write the project; the trusted Runtime decides whether to apply it.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid proposal arguments');
      const value = args as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'content,path' || typeof value.path !== 'string' || !portableRepoPath(value.path)
        || typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > 4 * 1024 * 1024) {
        throw new Error('Proposal requires a repository-relative path and at most 4 MiB of UTF-8 text');
      }
      return `PROPOSED ${createHash('sha256').update(value.content, 'utf8').digest('hex')}`;
    },
  };
}

export function apply(ctx: CommandContext): void {
  const proposalTool = createDshProposalTool();
  ctx.effect(() => ctx.tools.guard((execution) => {
    if (process.env.DEV_HARNESS_WORKER === '1' && process.env.DEV_HARNESS_ADAPTER === 'dsh'
      && execution.name === proposalTool.name && ctx.tools.get(execution.name, execution.agent) === proposalTool) return undefined;
    return guardUnbridgedWorkerTool(process.env, execution);
  }),
    'dev-harness-runtime: worker tool gate');
  if (process.env.DEV_HARNESS_WORKER === '1' && process.env.DEV_HARNESS_ADAPTER === 'dsh') {
    ctx.effect(() => ctx.tools.register(proposalTool), 'dev-harness-runtime: proposal tool');
  }
  ctx.effect(() => ctx.commands.register({
    name: 'dhr-status',
    description: 'Report the installed dev-harness-runtime bundle status.',
    handler: () => ({ kind: 'success', text: 'dev-harness-runtime bundle installed; task Executor is not enabled.' }),
  }), 'dev-harness-runtime: dhr-status');
}
