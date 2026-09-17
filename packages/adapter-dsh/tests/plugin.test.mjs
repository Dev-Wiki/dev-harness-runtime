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

test('DSH plugin registers and disposes its guard with the Human Command', () => {
  const registered = [];
  const ctx = {
    commands: { register(command) { registered.push(['command', command]); return () => registered.push(['command-disposed']); } },
    tools: { get() { return undefined; }, register() { throw new Error('non-Worker must not register a proposal tool'); },
      guard(check) { registered.push(['guard', check]); return () => registered.push(['guard-disposed']); } },
    effect(register) { const dispose = register(); registered.push(['effect', dispose]); },
  };
  apply(ctx);
  assert.equal(registered[0][0], 'guard');
  assert.equal(registered[2][0], 'command');
  assert.equal(registered[2][1].name, 'dhr-status');
  assert.match(registered[2][1].handler().text, /not enabled/u);
  registered[1][1](); registered[3][1]();
  assert.deepEqual(registered.slice(-2).map(([kind]) => kind), ['guard-disposed', 'command-disposed']);
});

test('DSH Worker allows only its exact proposal definition and that tool has no file side effect', async () => {
  const oldWorker = process.env.DEV_HARNESS_WORKER; const oldAdapter = process.env.DEV_HARNESS_ADAPTER;
  process.env.DEV_HARNESS_WORKER = '1'; process.env.DEV_HARNESS_ADAPTER = 'dsh';
  try {
    let definition; let guard;
    const effects = [];
    const ctx = {
      commands: { register() { return () => {}; } },
      tools: { get() { return definition; }, register(value) { definition = value; return () => { definition = undefined; }; },
        guard(check) { guard = check; return () => { guard = undefined; }; } },
      effect(register) { effects.push(register()); },
    };
    apply(ctx);
    assert.equal(definition.name, 'dhr_propose_text');
    assert.equal(guard({ name: 'dhr_propose_text' }), undefined);
    assert.match(guard({ name: 'bash' }), /controlled Task bridge/u);
    const original = definition;
    definition = createDshProposalTool();
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
