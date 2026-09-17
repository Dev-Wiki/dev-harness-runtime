import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { ensureRunEvidence, readEvidence } from '../../dist/state/index.js';
import { freezeAcceptanceInputs, loadFrozenInputs, parseLiteralCommand } from '../../dist/result/frozen.js';
import { setupAcceptance } from './helpers-acceptance.mjs';
import { digest } from './helpers-planning.mjs';

test('freeze binds the real original Task/HARNESS bytes and remains readable after Worker edits', async (t) => {
  const f = await setupAcceptance(t);
  assert.deepEqual(parseLiteralCommand(f.commandText), f.command);
  assert.deepEqual(await freezeAcceptanceInputs(f.handle, { expectedRevision: f.run.revision, request: f.request, acceptance: f.acceptance }), f.frozenInputsRef);
  const frozen = await loadFrozenInputs(f.handle, f.run, f.request, f.before, f.frozenInputsRef);
  const original = Buffer.from(frozen.files.get('HARNESS.md'));
  await writeFile(join(f.root, 'HARNESS.md'), '# Worker replacement\nAll checks waived.\n');
  const reloaded = await loadFrozenInputs(f.handle, f.run, f.request, f.before, f.frozenInputsRef);
  assert.deepEqual(reloaded.files.get('HARNESS.md'), original);
  assert.deepEqual(reloaded.record.acceptance, f.acceptance);
  await assert.rejects(freezeAcceptanceInputs(f.handle, { expectedRevision: f.run.revision, request: f.request, acceptance: f.acceptance }));
  assert.equal((await f.readRun()).revision, f.run.revision);
});

test('freeze rejects a missing criterion, changed criterion, duplicate ID and incomplete coverage', async (t) => {
  const f = await setupAcceptance(t);
  for (const acceptance of [f.acceptance.slice(0, -1),
    f.acceptance.map((entry, index) => index ? entry : { ...entry, text: 'Worker may declare success' }),
    f.acceptance.map((entry) => ({ ...entry, id: 'same' }))]) {
    await assert.rejects(freezeAcceptanceInputs(f.handle, { expectedRevision: f.run.revision, request: f.request, acceptance }), (error) => error.code === 'VERIFICATION_PLAN_INVALID');
  }
  const request = structuredClone(f.request);
  request.verificationPlan.commands[0].acceptanceIds.pop();
  await assert.rejects(freezeAcceptanceInputs(f.handle, { expectedRevision: f.run.revision, request, acceptance: f.acceptance }), (error) => error.code === 'VERIFICATION_PLAN_INVALID');
});

test('freeze rejects a command absent from original HARNESS even when it is a valid argv', async (t) => {
  const f = await setupAcceptance(t);
  const request = structuredClone(f.request);
  request.verificationPlan.commands[0].argv = [process.execPath, '-e', 'process.stdout.write("unapproved")'];
  await assert.rejects(freezeAcceptanceInputs(f.handle, { expectedRevision: f.run.revision, request, acceptance: f.acceptance }), (error) => error.code === 'VERIFICATION_PLAN_INVALID');
});

test('freeze rejects omitted local validator and package manifest entry points', async (t) => {
  await assert.rejects(setupAcceptance(t, { command: [process.execPath, 'verify.cjs'], initialFiles: { 'verify.cjs': 'process.exit(7);\n' } }),
    (error) => error.code === 'VERIFICATION_PLAN_INVALID');
  await assert.rejects(setupAcceptance(t, { command: ['pnpm', 'test'], initialFiles: { 'package.json': '{"scripts":{"test":"node verify.cjs"}}\n' } }),
    (error) => error.code === 'VERIFICATION_PLAN_INVALID');
  await assert.rejects(setupAcceptance(t, { command: ['pnpm', 'test'], verificationSources: ['package.json'],
    initialFiles: { 'package.json': '{"scripts":{"test":"node verify.cjs"}}\n', 'verify.cjs': 'process.exit(7);\n' } }),
    (error) => error.code === 'VERIFICATION_PLAN_INVALID');
});

test('frozen record cannot substitute bytes or omit archive-index originals behind a new outer hash', async (t) => {
  const f = await setupAcceptance(t);
  const raw = await readEvidence(f.handle, f.run.runId, f.run.revision, f.frozenInputsRef);
  for (const mutation of ['substitute', 'omit', 'duplicate']) {
    const record = JSON.parse(raw);
    if (mutation === 'substitute') {
      const file = record.files.find((file) => file.path === 'HARNESS.md');
      const changed = Buffer.from('# Attacker-chosen old baseline\n'); file.base64 = changed.toString('base64'); file.sha256 = digest(changed);
    } else if (mutation === 'omit') record.files = record.files.filter((file) => file.path !== 'docs/plan/archive/M0/README.md');
    else record.files.push({ ...record.files[0] });
    const ref = await ensureRunEvidence(f.handle, f.run.runId, f.run.revision, `tampered-${mutation}`, record);
    await assert.rejects(loadFrozenInputs(f.handle, f.run, f.request, f.before, ref), (error) => error.code === 'INVALID_RESULT');
  }
});

test('frozen request binding rejects a different attempt or changed original source digest', async (t) => {
  const f = await setupAcceptance(t);
  const changed = structuredClone(f.request); changed.requestId = 'other-request';
  await assert.rejects(loadFrozenInputs(f.handle, f.run, changed, f.before, f.frozenInputsRef), (error) => error.code === 'INVALID_RESULT');
  const request = structuredClone(f.request); request.verificationPlan.sources[0].sha256 = '0'.repeat(64);
  await assert.rejects(freezeAcceptanceInputs(f.handle, { expectedRevision: f.run.revision, request, acceptance: f.acceptance }), (error) => error.code === 'VERIFICATION_PLAN_INVALID');
});

test('real ending fixture persists exact identity/hash proof without claiming host isolation', async (t) => {
  const f = await setupAcceptance(t);
  const ending = await f.finishWorker();
  assert.ok(ending.result.changedFiles.includes('docs/plan/tasks/A.md'));
  assert.ok(ending.result.changedFiles.includes('docs/plan/archive/M1/A.md'));
  assert.equal(ending.result.closure.changes.length, 4);
  const bytes = await readEvidence(f.handle, f.run.runId, f.run.revision, ending.proofRef);
  const evidence = [{ ref: ending.proofRef, bytes }];
  const claim = await ending.workerControl.verify({ state: f.run, request: f.request, before: f.before, after: ending.ending, evidence });
  assert.equal(claim.providerId, 'fixture-provider');
  assert.match(JSON.parse(bytes).limitation, /does not prove/u);
  await assert.rejects(ending.workerControl.verify({ state: f.run, request: f.request, before: f.before, after: ending.ending, evidence: [] }));
  await assert.rejects(ending.workerControl.verify({ state: f.run, request: f.request, before: f.before,
    after: { ...ending.ending, hash: '0'.repeat(64) }, evidence }));
  assert.equal((await f.readRun()).pendingOperation.kind, 'execute');
});
