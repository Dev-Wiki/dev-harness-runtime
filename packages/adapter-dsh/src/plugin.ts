/** DSH host surface. Task execution remains disabled until K6 proves its session and permission boundary. */
export const name = 'dev-harness-runtime';
export const inject = ['commands', 'tools'];

interface CommandContext {
  commands: { register(definition: { name: string; description: string;
    handler(): { kind: 'success'; text: string } }): () => void };
  tools: { guard(check: (execution: { readonly name: string }) => string | undefined): () => void };
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

export function apply(ctx: CommandContext): void {
  ctx.effect(() => ctx.tools.guard((execution) => guardUnbridgedWorkerTool(process.env, execution)),
    'dev-harness-runtime: worker tool gate');
  ctx.effect(() => ctx.commands.register({
    name: 'dhr-status',
    description: 'Report the installed dev-harness-runtime bundle status.',
    handler: () => ({ kind: 'success', text: 'dev-harness-runtime bundle installed; task Executor is not enabled.' }),
  }), 'dev-harness-runtime: dhr-status');
}
