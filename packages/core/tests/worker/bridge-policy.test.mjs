import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerWritePolicy } from '../../dist/worker/bridge-policy.js';

const scope = {
  schemaVersion: 1,
  files: ['src/exact.ts', 'docs/plan/not-a-task.md'],
  directories: ['src/generated'],
  planning: {
    taskId: 'K5', taskPath: 'docs/plan/tasks/K5.md', archivePath: 'docs/plan/archive/M3/K5.md',
    dashboardPath: 'docs/plan/Dashboard.md', archiveIndexPath: 'docs/plan/archive/M3/README.md',
  },
};

test('bridge write predicate matches final snapshot ownership for code and four planning paths', () => {
  const allowed = createWorkerWritePolicy(scope);
  for (const path of ['src/exact.ts', 'src/generated/nested/new.ts', 'docs/plan/tasks/K5.md',
    'docs/plan/archive/M3/K5.md', 'docs/plan/archive/M3/README.md', 'docs/plan/Dashboard.md']) {
    assert.equal(allowed(path), true, path);
  }
  for (const path of ['src/exact.ts.bak', 'src/generated', 'src/generated-other/file.ts',
    'docs/plan/not-a-task.md', 'docs/plan/tasks/K6.md', 'docs/plan/archive/M3/K6.md',
    '.git/config', 'src/.GIT/config', '../src/exact.ts', 'src//exact.ts', '/src/exact.ts',
    'src\\exact.ts', 'src/generated/../exact.ts', 'src/generated/file.']) {
    assert.equal(allowed(path), false, path);
  }
});

test('bridge policy rejects malformed scopes instead of widening permissions', () => {
  assert.throws(() => createWorkerWritePolicy({ ...scope, files: ['../outside'] }));
});
