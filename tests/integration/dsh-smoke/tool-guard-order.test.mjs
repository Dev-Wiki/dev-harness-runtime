import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const dshEntry = process.env.DHR_TEST_DSH_ENTRY;

test('DSH rc.2 runs pre-execute listeners before a denying tool guard',
  { skip: !dshEntry && 'Set DHR_TEST_DSH_ENTRY to the installed DSH rc.1 launcher' }, async () => {
    const requireFromDsh = createRequire(pathToFileURL(dshEntry));
    assert.equal(requireFromDsh('@deepseek-ai/dsh-tools/package.json').version, '0.1.5-rc.2');
    const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href);
    const { SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href);
    const { ToolRuntime } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-tools')).href);
    const context = new Context();
    new SystemPrompt(context, {});
    const runtime = new ToolRuntime(context);
    let pre = 0;
    let body = 0;
    context.on('tools/pre-execute', async (_execution, next) => { pre++; return next(); });
    runtime.guard(() => 'DHR test denial');
    runtime.register({ name: 'dhr_probe', description: 'Read-only test probe',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() { body++; return 'EXECUTED'; } });
    const result = await runtime.execute({ name: 'dhr_probe', arguments: {}, callId: 'dhr-probe', signal: new AbortController().signal });
    assert.deepEqual({ pre, body, isError: result.isError, reason: result.error?.message },
      { pre: 1, body: 0, isError: true, reason: 'DHR test denial' });
  });
