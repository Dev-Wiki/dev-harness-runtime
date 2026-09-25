import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ContractValidationError, parseContract } from '@dev-harness-runtime/contracts';
import { createWorkerTaskBridgeView, type WorkerTaskBridgeView } from '@dev-harness-runtime/core';

// Early syntax feedback only; Core's WorkerProposalCollector revalidates the authoritative scope.
function portableRepoPath(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in model-supplied paths.
  return value.length > 0 && !/[\\:\x00-\x1f\x7f]/u.test(value) && value.split('/').every((part) =>
    part !== '' && part !== '.' && part !== '..' && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

/** DSH host surface; packaged CLI enables execution only after the real host probe. */
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
    restrict(filter: { allow: readonly string[] }): () => void;
  };
  on(event: 'agent/created', listener: (event: { agent: { ctx: CommandContext } }) => void): () => void;
  on(event: 'tools/pre-execute', check: (execution: { readonly name: string; readonly agent?: unknown },
    next: () => Promise<{ kind: string; reason?: string }>) => Promise<{ kind: string; reason?: string }> | { kind: string; reason?: string },
  options: { prepend: true }): () => void;
  effect(register: () => () => void, label: string): void;
}

/** A DHR Worker cannot invoke other DSH model-facing tool bodies. */
export function guardUnbridgedWorkerTool(environment: Readonly<Record<string, string | undefined>>,
  _execution: { readonly name: string }): string | undefined {
  if (environment.DEV_HARNESS_WORKER === '1' && environment.DEV_HARNESS_ADAPTER === 'dsh') {
    return 'DHR Worker tool execution requires a controlled Task bridge';
  }
  return undefined;
}

/** Short-circuit later host pre-execute listeners before they can run for this Worker call. */
export function createDshWorkerPrecheck(environment: Readonly<Record<string, string | undefined>>,
  isOwnProposal: (execution: { readonly name: string; readonly agent?: unknown }) => boolean) {
  return (execution: { readonly name: string; readonly agent?: unknown }, next: () => Promise<{ kind: string; reason?: string }>) => {
    if (environment.DEV_HARNESS_WORKER !== '1' || environment.DEV_HARNESS_ADAPTER !== 'dsh') return next();
    return isOwnProposal(execution) ? { kind: 'allow' } : {
      kind: 'deny', reason: 'DHR Worker tool execution requires a controlled Task bridge',
    };
  };
}

/** This tool only acknowledges a proposal; it cannot edit or persist project content. */
export function createDshProposalTool(authorizePath?: (path: string) => Promise<void>): ProposalTool {
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
      await authorizePath?.(value.path);
      return `PROPOSED ${createHash('sha256').update(value.content, 'utf8').digest('hex')}`;
    },
  };
}

/** A deletion proposal has no file effect; Core checks existence and Task scope. */
export function createDshDeleteProposalTool(authorizePath?: (path: string) => Promise<void>): ProposalTool {
  return {
    name: 'dhr_propose_delete',
    description: 'Propose deletion of one Task-scoped file. This does not delete the project file; the trusted Runtime decides whether to apply it.',
    parameters: { type: 'object', properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid proposal arguments');
      const value = args as Record<string, unknown>;
      if (Object.keys(value).join(',') !== 'path' || typeof value.path !== 'string' || !portableRepoPath(value.path)) {
        throw new Error('Delete proposal requires one repository-relative path');
      }
      await authorizePath?.(value.path);
      return `PROPOSED_DELETE ${createHash('sha256').update(value.path, 'utf8').digest('hex')}`;
    },
  };
}

/** Validate a candidate in the model's own turn so a malformed result can be corrected before the Session ends. */
export function createDshSubmitTool(load: () => Promise<WorkerTaskBridgeView>): ProposalTool {
  return {
    name: 'dhr_submit_result',
    description: 'Submit the final TaskExecutionResult as a JSON string after all proposals. Required completed closure: schemaVersion, taskId, taskPath, archivePath, archiveIndexPath, dashboardPath, summary, changes (exactly four {path,beforeHash,afterHash} entries). A schema error is returned for correction. Call this as the last tool.',
    parameters: { type: 'object', properties: { result: { type: 'string' } },
      required: ['result'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (!exact(args, ['result']) || typeof args.result !== 'string'
        || Buffer.byteLength(args.result, 'utf8') > 1024 * 1024) return 'INVALID_RESULT: result must be a bounded JSON string';
      try {
        const raw: unknown = JSON.parse(args.result);
        const result = parseContract('taskExecutionResult', raw);
        const view = await load();
        for (const key of ['runId', 'taskId', 'attempt', 'requestId', 'snapshotHash'] as const) {
          if (result[key] !== view.policy.identity[key]) throw new Error(`${key} differs from Core identity`);
        }
        if (result.outcome === 'completed' && result.commitIntent
          && (Buffer.byteLength(result.commitIntent.message, 'utf8') > 256
            || !/^[a-z]+(?:\([a-z0-9][a-z0-9-]*\))?: [^\r\n]*\p{Script=Han}[^\r\n]*\n$/u.test(result.commitIntent.message))) {
          throw new Error('commitIntent.message needs one LF-terminated Conventional Commit subject with a lowercase scope and Chinese description');
        }
        return `SUBMITTED ${createHash('sha256').update(JSON.stringify(raw)).digest('hex')}`;
      } catch (error) {
        const issues = error instanceof ContractValidationError
          ? error.issues.slice(0, 16).map((issue) => `${issue.path || '/'} ${issue.message}`).join('; ') : '';
        return `INVALID_RESULT: ${error instanceof Error ? error.message : 'malformed candidate'}${issues ? `; ${issues}` : ''}`.slice(0, 2400);
      }
    },
  };
}

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Only the trusted controller can provide this private, per-attempt bridge policy. */
export function createDshBridgeLoader(environment: Readonly<Record<string, string | undefined>>): () => Promise<WorkerTaskBridgeView> {
  let pending: Promise<WorkerTaskBridgeView> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const path = environment.DHR_WORKER_POLICY_PATH;
      if (!path || !path.startsWith('/') || path.includes('\0')) throw new Error('DSH Worker bridge policy is missing');
      const bytes = await readFile(path);
      if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('DSH Worker bridge policy exceeds 32 MiB');
      const view = await createWorkerTaskBridgeView(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (view.policy.env.DEV_HARNESS_ADAPTER !== 'dsh'
        || view.policy.env.DEV_HARNESS_RUN_ID !== environment.DEV_HARNESS_RUN_ID
        || view.policy.env.DEV_HARNESS_TASK_ID !== environment.DEV_HARNESS_TASK_ID) {
        throw new Error('DSH Worker bridge policy identity differs from the environment');
      }
      return view;
    })();
    return pending;
  };
}

function readTool(name: string, description: string, properties: Record<string, unknown>,
  keys: readonly string[], load: () => Promise<WorkerTaskBridgeView>,
  run: (view: WorkerTaskBridgeView, args: Record<string, unknown>) => Promise<unknown> | unknown): ProposalTool {
  return { name, description,
    parameters: { type: 'object', properties, required: [...keys], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (!exact(args, keys)) throw new Error('DSH Worker read arguments differ from the tool schema');
      const view = await load();
      exec.signal.throwIfAborted();
      return JSON.stringify(await run(view, args));
    },
  };
}

export function createDshReadTools(load: () => Promise<WorkerTaskBridgeView>): ProposalTool[] {
  return [
    readTool('dhr_identity', 'Return the Core-bound Task and Worker identity.', {}, [], load, (view) =>
      ({ schemaVersion: 1, ...view.policy.identity, env: view.policy.env })),
    readTool('dhr_list_paths', 'List at most 100 paths from the frozen Core snapshot.',
      { prefix: { type: 'string' }, after: { type: 'string' } }, ['prefix', 'after'], load, (view, args) => {
        if (typeof args.prefix !== 'string' || typeof args.after !== 'string') throw new Error('Invalid list cursors');
        return view.read.list(args.prefix, args.after);
      }),
    readTool('dhr_read_text', 'Read one bounded page from a frozen UTF-8 file.',
      { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, ['path', 'offset'], load, (view, args) => {
        if (typeof args.path !== 'string' || !Number.isSafeInteger(args.offset) || (args.offset as number) < 0) {
          throw new Error('Invalid read path or cursor');
        }
        return view.read.readPage(args.path, args.offset as number);
      }),
    readTool('dhr_search_text', 'Search a bounded page of frozen UTF-8 files for a literal string.',
      { query: { type: 'string' }, prefix: { type: 'string' }, after: { type: 'string' } },
      ['query', 'prefix', 'after'], load, (view, args) => {
        if (typeof args.query !== 'string' || typeof args.prefix !== 'string' || typeof args.after !== 'string') {
          throw new Error('Invalid search arguments');
        }
        return view.read.search(args.query, args.prefix, args.after);
      }),
  ];
}

export function apply(ctx: CommandContext): void {
  const load = createDshBridgeLoader(process.env);
  const authorizePath = process.env.DHR_WORKER_POLICY_PATH ? async (path: string) => {
    if (!(await load()).allowsProposal(path)) throw new Error('Proposal path is outside this Task scope');
  } : undefined;
  const proposalTools = [createDshProposalTool(authorizePath), createDshDeleteProposalTool(authorizePath),
    ...(process.env.DHR_WORKER_POLICY_PATH ? [...createDshReadTools(load), createDshSubmitTool(load)] : [])];
  const isOwnProposal = (execution: { readonly name: string; readonly agent?: unknown }) =>
    proposalTools.some((tool) => execution.name === tool.name && ctx.tools.get(execution.name, execution.agent) === tool);
  ctx.effect(() => ctx.on('tools/pre-execute', createDshWorkerPrecheck(process.env, isOwnProposal), { prepend: true }),
    'dev-harness-runtime: worker pre-execute gate');
  ctx.effect(() => ctx.tools.guard((execution) => {
    if (process.env.DEV_HARNESS_WORKER === '1' && process.env.DEV_HARNESS_ADAPTER === 'dsh'
      && isOwnProposal(execution)) return undefined;
    return guardUnbridgedWorkerTool(process.env, execution);
  }),
    'dev-harness-runtime: worker tool gate');
  if (process.env.DEV_HARNESS_WORKER === '1' && process.env.DEV_HARNESS_ADAPTER === 'dsh') {
    ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
      // DSH's scoped restriction hides every inherited global tool from both
      // model presentation and dispatch. Our bridge registrations live in the
      // new Agent scope and therefore remain visible until that scope disposes.
      agent.ctx.tools.restrict({ allow: [] });
      for (const tool of proposalTools) agent.ctx.tools.register(tool);
    }), 'dev-harness-runtime: scoped Worker tool catalog');
  }
  ctx.effect(() => ctx.commands.register({
    name: 'dhr-status',
    description: 'Report the installed dev-harness-runtime bundle status.',
    handler: () => ({ kind: 'success', text: 'dev-harness-runtime bundle installed; task execution requires the packaged CLI host probe.' }),
  }), 'dev-harness-runtime: dhr-status');
}
