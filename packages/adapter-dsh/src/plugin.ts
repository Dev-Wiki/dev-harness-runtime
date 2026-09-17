/** DSH host surface. Task execution remains disabled until K6 proves its session and permission boundary. */
export const name = 'dev-harness-runtime';
export const inject = ['commands'];

interface CommandContext {
  commands: { register(definition: { name: string; description: string;
    handler(): { kind: 'success'; text: string } }): () => void };
  effect(register: () => () => void, label: string): void;
}

export function apply(ctx: CommandContext): void {
  ctx.effect(() => ctx.commands.register({
    name: 'dhr-status',
    description: 'Report the installed dev-harness-runtime bundle status.',
    handler: () => ({ kind: 'success', text: 'dev-harness-runtime bundle installed; task Executor is not enabled.' }),
  }), 'dev-harness-runtime: dhr-status');
}
