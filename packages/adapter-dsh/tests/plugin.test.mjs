import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDshProposalTool, guardUnbridgedWorkerTool, inject } from '../dist/plugin.js';

test('DSH Worker denies model-facing tools until a controlled bridge is installed', () => {
  const worker = { DEV_HARNESS_WORKER: '1', DEV_HARNESS_ADAPTER: 'dsh' };
  for (const name of ['bash', 'web', 'subagent', 'workflow', 'fs_write']) {
    assert.match(guardUnbridgedWorkerTool(worker, { name }), /controlled Task bridge/u);
  }
  assert.equal(guardUnbridgedWorkerTool({ ...worker, DEV_HARNESS_ADAPTER: 'codex' }, { name: 'bash' }), undefined);
  assert.equal(guardUnbridgedWorkerTool({}, { name: 'bash' }), undefined);
  assert.deepEqual(inject, ['commands', 'tools']);
});

test('DSH plugin registers and disposes its precheck, guard and Human Command', async () => {
  const registered = [];
  const ctx = {
    commands: { register(command) { registered.push(['command', command]); return () => registered.push(['command-disposed']); } },
    tools: { get() { return undefined; }, register() { throw new Error('non-Worker must not register a proposal tool'); },
      guard(check) { registered.push(['guard', check]); return () => registered.push(['guard-disposed']); } },
    on(name, check, options) { registered.push(['precheck', name, check, options]); return () => registered.push(['precheck-disposed']); },
    effect(register) { const dispose = register(); registered.push(['effect', dispose]); },
  };
  apply(ctx);
  assert.deepEqual(registered.filter(([kind]) => kind !== 'effect').map(([kind]) => kind), ['precheck', 'guard', 'command']);
  assert.deepEqual(registered[0].slice(1, 2), ['tools/pre-execute']);
  assert.deepEqual(registered[0][3], { prepend: true });
  assert.deepEqual(await registered[0][2]({ name: 'bash' }, async () => ({ kind: 'allow' })), { kind: 'allow' });
  const command = registered.find(([kind]) => kind === 'command')[1];
  assert.equal(command.name, 'dhr-status');
  assert.match(command.handler().text, /not enabled/u);
  for (const [, dispose] of registered.filter(([kind]) => kind === 'effect')) dispose();
  assert.deepEqual(registered.slice(-3).map(([kind]) => kind), ['precheck-disposed', 'guard-disposed', 'command-disposed']);
});

test('DSH Worker allows only its exact proposal definition and that tool has no file side effect', async () => {
  const oldWorker = process.env.DEV_HARNESS_WORKER; const oldAdapter = process.env.DEV_HARNESS_ADAPTER;
  process.env.DEV_HARNESS_WORKER = '1'; process.env.DEV_HARNESS_ADAPTER = 'dsh';
  try {
    let definition; let guard; let precheck;
    const effects = [];
    const ctx = {
      commands: { register() { return () => {}; } },
      tools: { get() { return definition; }, register(value) { definition = value; return () => { definition = undefined; }; },
        guard(check) { guard = check; return () => { guard = undefined; }; } },
      on(name, check, options) { assert.equal(name, 'tools/pre-execute'); assert.deepEqual(options, { prepend: true });
        precheck = check; return () => { precheck = undefined; }; },
      effect(register) { effects.push(register()); },
    };
    apply(ctx);
    assert.equal(definition.name, 'dhr_propose_text');
    let downstream = 0;
    const next = async () => { downstream++; return { kind: 'allow' }; };
    assert.deepEqual(await precheck({ name: 'bash' }, next),
      { kind: 'deny', reason: 'DHR Worker tool execution requires a controlled Task bridge' });
    assert.deepEqual(await precheck({ name: 'dhr_propose_text' }, next), { kind: 'allow' });
    assert.equal(downstream, 0);
    assert.equal(guard({ name: 'dhr_propose_text' }), undefined);
    assert.match(guard({ name: 'bash' }), /controlled Task bridge/u);
    const original = definition;
    definition = createDshProposalTool();
    assert.deepEqual(await precheck({ name: 'dhr_propose_text' }, next),
      { kind: 'deny', reason: 'DHR Worker tool execution requires a controlled Task bridge' });
    assert.match(guard({ name: 'dhr_propose_text' }), /controlled Task bridge/u);
    definition = original;
    assert.equal(await definition.execute({ path: 'src/a.ts', content: 'HELLO' }, { signal: new AbortController().signal }),
      'PROPOSED 3733cd977ff8eb18b987357e22ced99f46097f31ecb239e878ae63760e83e4d5');
    await assert.rejects(definition.execute({ path: '../outside', content: 'x' }, { signal: new AbortController().signal }));
    for (const dispose of effects) dispose();
    assert.equal(definition, undefined);
  } finally {
    if (oldWorker === undefined) delete process.env.DEV_HARNESS_WORKER; else process.env.DEV_HARNESS_WORKER = oldWorker;
    if (oldAdapter === undefined) delete process.env.DEV_HARNESS_ADAPTER; else process.env.DEV_HARNESS_ADAPTER = oldAdapter;
  }
});
