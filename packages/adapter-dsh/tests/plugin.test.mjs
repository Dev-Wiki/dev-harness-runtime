import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, guardUnbridgedWorkerTool, inject } from '../dist/plugin.js';

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
    tools: { guard(check) { registered.push(['guard', check]); return () => registered.push(['guard-disposed']); } },
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
