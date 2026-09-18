import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readPlan } from '../dist/planning/reader.js';
import { captureSnapshot } from '../dist/snapshot/capture.js';
import { prepareDeclaredPlanningTask } from '../dist/orchestrator/planner.js';
import { setupRuntimeFixture } from '../../../tests/fixtures/fake-executor/fixture.mjs';

const configuration = (changes = {}) => ({ schemaVersion: 1,
  scope: { files: ['src/feature.ts', 'tests/feature.test.mjs'], directories: [],
    archivePath: 'docs/plan/archive/M1/A.md', ...changes.scope },
  verification: { sources: [], commands: [{ id: 'check', purpose: 'full', criteria: [1, 2], writableArtifacts: [] }],
    manual: [], ...changes.verification } });

async function prepare(fixture, config) {
  const path = join(fixture.root, 'docs/plan/tasks/A.md');
  const original = await readFile(path, 'utf8');
  await writeFile(path, `${original}\n## Runtime 配置\n\n\`\`\`dhr-runtime\n${JSON.stringify(config)}\n\`\`\`\n`);
  const plan = await readPlan(fixture.project);
  const task = plan.tasks.find((item) => item.id === 'A');
  assert.ok(task);
  const before = await captureSnapshot({ project: fixture.project, runId: 'planner-test',
    protocolSource: fixture.services.protocolSource, adapterConfigHash: fixture.services.adapterConfigHash,
    currentTaskPath: task.taskPath, planningReferences: plan.references });
  return { path, before, input: { project: fixture.project, plan, task, before } };
}

test('declared Planning Task freezes exact impact paths and confirmed verification', async (t) => {
  const fixture = await setupRuntimeFixture(t);
  const { input } = await prepare(fixture, configuration());
  const prepared = await prepareDeclaredPlanningTask(input);
  assert.deepEqual(prepared.scope.files, ['src/feature.ts', 'tests/feature.test.mjs']);
  assert.equal(prepared.scope.planning.archiveIndexPath, 'docs/plan/archive/M1/README.md');
  assert.deepEqual(prepared.acceptance.map((item) => item.id), ['criterion-1', 'criterion-2']);
  assert.deepEqual(prepared.verificationPlan.commands[0].acceptanceIds, ['criterion-1', 'criterion-2']);
  assert.deepEqual(prepared.verificationPlan.sources.map((item) => item.path), ['HARNESS.md', 'docs/plan/tasks/A.md']);
});

test('declaration cannot enlarge the Task impact scope', async (t) => {
  const fixture = await setupRuntimeFixture(t);
  const widened = await prepare(fixture, configuration({ scope: { files: ['src/feature.ts', 'tests/feature.test.mjs', 'src/private.ts'] } }));
  await assert.rejects(() => prepareDeclaredPlanningTask(widened.input), { code: 'UNSUPPORTED_PLAN_FORMAT' });
});

test('declaration cannot invoke a command absent from confirmed HARNESS', async (t) => {
  const fixture = await setupRuntimeFixture(t);
  const { input } = await prepare(fixture, configuration({ verification: { sources: [],
    commands: [{ id: 'check', purpose: 'test', criteria: [1, 2], writableArtifacts: [] }], manual: [] } }));
  await assert.rejects(() => prepareDeclaredPlanningTask(input), { code: 'UNSUPPORTED_PLAN_FORMAT' });
});

test('Task byte drift after snapshot blocks runtime preparation', async (t) => {
  const fixture = await setupRuntimeFixture(t);
  const { path, input } = await prepare(fixture, configuration());
  await writeFile(path, `${await readFile(path, 'utf8')}\nchanged after snapshot\n`);
  await assert.rejects(() => prepareDeclaredPlanningTask(input), { code: 'DRIFT_DETECTED' });
});
