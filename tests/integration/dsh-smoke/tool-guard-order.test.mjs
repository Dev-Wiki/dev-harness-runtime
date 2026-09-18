import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { apply, createDshWorkerPrecheck } from '../../../packages/adapter-dsh/dist/plugin.js';

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

test('DSH rc.2 loads the actual DHR plugin precheck in a Worker context',
  { skip: !dshEntry && 'Set DHR_TEST_DSH_ENTRY to the installed DSH rc.1 launcher' }, async () => {
    const requireFromDsh = createRequire(pathToFileURL(dshEntry));
    const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href);
    const { SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href);
    const { ToolRuntime } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-tools')).href);
    const { CommandRuntime } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-commands')).href);
    const previous = [process.env.DEV_HARNESS_WORKER, process.env.DEV_HARNESS_ADAPTER];
    process.env.DEV_HARNESS_WORKER = '1'; process.env.DEV_HARNESS_ADAPTER = 'dsh';
    try {
      const context = new Context(); new SystemPrompt(context, {}); new CommandRuntime(context);
      const runtime = new ToolRuntime(context);
      const pluginApply = process.env.DHR_TEST_DSH_PLUGIN_ENTRY
        ? (await import(pathToFileURL(process.env.DHR_TEST_DSH_PLUGIN_ENTRY).href)).apply : apply;
      assert.equal(typeof pluginApply, 'function');
      pluginApply(context);
      assert.equal(runtime.get('dhr_propose_text')?.name, 'dhr_propose_text');
      let later = 0;
      context.on('tools/pre-execute', async (_execution, next) => { later++; return next(); });
      const signal = new AbortController().signal;
      const result = await runtime.execute({ name: 'dhr_propose_text', arguments: { path: 'src/a.ts', content: 'HELLO' },
        callId: 'dhr-plugin-proposal', signal });
      assert.equal(result.isError, false);
      assert.equal(later, 0);
      assert.equal(result.value, 'PROPOSED 3733cd977ff8eb18b987357e22ced99f46097f31ecb239e878ae63760e83e4d5');
      const denied = await runtime.execute({ name: 'not_registered', arguments: {}, callId: 'dhr-plugin-denied', signal });
      assert.equal(denied.isError, true);
      assert.equal(denied.error?.message, 'DHR Worker tool execution requires a controlled Task bridge');
      assert.equal(later, 0);
    } finally {
      if (previous[0] === undefined) delete process.env.DEV_HARNESS_WORKER; else process.env.DEV_HARNESS_WORKER = previous[0];
      if (previous[1] === undefined) delete process.env.DEV_HARNESS_ADAPTER; else process.env.DEV_HARNESS_ADAPTER = previous[1];
    }
  });

test('DHR precheck short-circuits later rc.2 listeners for Worker tools',
  { skip: !dshEntry && 'Set DHR_TEST_DSH_ENTRY to the installed DSH rc.1 launcher' }, async () => {
    const requireFromDsh = createRequire(pathToFileURL(dshEntry));
    const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href);
    const { SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href);
    const { ToolRuntime } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-tools')).href);
    const context = new Context(); new SystemPrompt(context, {});
    const runtime = new ToolRuntime(context);
    let later = 0; let body = 0;
    const own = { name: 'dhr_propose_text', description: 'Pure test proposal',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() { body++; return 'PROPOSED'; } };
    const foreign = { ...own, name: 'dhr_probe', async execute() { body++; return 'EXECUTED'; } };
    runtime.register(own); runtime.register(foreign);
    const allowed = (execution) => execution.name === own.name && runtime.get(execution.name, execution.agent) === own;
    const worker = { DEV_HARNESS_WORKER: '1', DEV_HARNESS_ADAPTER: 'dsh' };
    context.on('tools/pre-execute', createDshWorkerPrecheck(worker, allowed), { prepend: true });
    context.on('tools/pre-execute', async (_execution, next) => { later++; return next(); });
    runtime.guard((execution) => allowed(execution) ? undefined : 'DHR test denial');
    const call = (name, callId) => runtime.execute({ name, arguments: {}, callId, signal: new AbortController().signal });
    const denied = await call('dhr_probe', 'dhr-denied');
    assert.equal(denied.isError, true);
    assert.equal(denied.error?.message, 'DHR Worker tool execution requires a controlled Task bridge');
    const accepted = await call('dhr_propose_text', 'dhr-allowed');
    assert.equal(accepted.isError, false);
    assert.deepEqual({ later, body }, { later: 0, body: 1 });
  });

test('a later prepend listener still runs before the DHR precheck',
  { skip: !dshEntry && 'Set DHR_TEST_DSH_ENTRY to the installed DSH rc.1 launcher' }, async () => {
    const requireFromDsh = createRequire(pathToFileURL(dshEntry));
    const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href);
    const { SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href);
    const { ToolRuntime } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-tools')).href);
    const context = new Context(); new SystemPrompt(context, {});
    const runtime = new ToolRuntime(context);
    let earlier = 0; let body = 0;
    const tool = { name: 'dhr_probe', description: 'test', parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() { body++; return 'EXECUTED'; } };
    runtime.register(tool);
    context.on('tools/pre-execute', createDshWorkerPrecheck({ DEV_HARNESS_WORKER: '1', DEV_HARNESS_ADAPTER: 'dsh' }, () => false),
      { prepend: true });
    context.on('tools/pre-execute', async (_execution, next) => { earlier++; return next(); }, { prepend: true });
    const result = await runtime.execute({ name: tool.name, arguments: {}, callId: 'dhr-prepend-order', signal: new AbortController().signal });
    assert.deepEqual({ earlier, body, reason: result.error?.message },
      { earlier: 1, body: 0, reason: 'DHR Worker tool execution requires a controlled Task bridge' });
  });
