import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlanningDelta } from '../../dist/result/planning.js';
import { createPlanningFixture, refreshPlanningFixture, replaceText, digest } from './helpers-planning.mjs';

test('independent lifecycle validation accepts a move, append and one-Task removal with equivalent dependency links', async () => {
  const input = await createPlanningFixture();
  const evidence = validatePlanningDelta(input);
  assert.equal(evidence.taskId, 'A'); assert.equal(evidence.paths.length, 4);
  assert.deepEqual(evidence.baselineHarnessRef, input.before.snapshot.harnessRef);
  assert.ok(evidence.afterRefs.some((ref) => ref.path === input.scope.planning.archivePath));
});

test('authoritative active columns are located by header names, not fixed positions', async () => {
  const input = await createPlanningFixture();
  for (const files of [input.beforeFiles, input.afterFiles]) {
    const path = input.scope.planning.dashboardPath;
    const text = files.get(path).toString('utf8');
    files.set(path, Buffer.from(text.split('\n').map((line) => {
      if (!line.startsWith('|')) return line;
      const cells = line.slice(1, -1).split('|');
      [cells[1], cells[2]] = [cells[2], cells[1]];
      return `|${cells.join('|')}|`;
    }).join('\n')));
  }
  refreshPlanningFixture(input);
  assert.doesNotThrow(() => validatePlanningDelta(input));
});

test('an authorized HARNESS change never becomes this validator original baseline', async () => {
  const input = await createPlanningFixture();
  input.scope.files.push('HARNESS.md');
  input.afterFiles.set('HARNESS.md', Buffer.from('# Changed HARNESS\nRun nothing.\n'));
  refreshPlanningFixture(input);
  const evidence = validatePlanningDelta(input);
  assert.equal(evidence.baselineHarnessRef.sha256, digest(input.beforeFiles.get('HARNESS.md')));
  assert.notEqual(evidence.baselineHarnessRef.sha256, digest(input.afterFiles.get('HARNESS.md')));
});

test('omitted frozen bytes and byte/hash substitutions are rejected', async () => {
  const input = await createPlanningFixture();
  input.beforeFiles.delete(input.scope.planning.taskPath);
  assert.throws(() => validatePlanningDelta(input), /bytes are missing/u);
  const second = await createPlanningFixture();
  second.beforeFiles.set(second.scope.planning.taskPath, Buffer.from('# rewritten baseline'));
  assert.throws(() => validatePlanningDelta(second), /raw-content hash/u);
  const third = await createPlanningFixture();
  third.beforeFiles.delete('docs/plan/archive/M0/README.md');
  assert.throws(() => validatePlanningDelta(third), /bytes are missing/u);
});

for (const [description, from, to] of [
  ['another Task priority', '| B — 任务 | 🔴 P0 |', '| B — 任务 | 🟢 P2 |'],
  ['another Task status', '| B — 任务 | 🔴 P0 | 🟢 待执行 |', '| B — 任务 | 🔴 P0 | 📋 规划中 |'],
  ['another Task dependency', '| C — 任务 | 🟢 P2 | 📋 规划中 | B |', '| C — 任务 | 🟢 P2 | 📋 规划中 | 无 |'],
  ['another Task order', '1. [B — 任务](tasks/B.md)\n2. [C — 任务](tasks/C.md)', '1. [C — 任务](tasks/C.md)\n2. [B — 任务](tasks/B.md)'],
  ['shared validation prose', '使用原 [HARNESS](../../HARNESS.md)。', '只需相信 Worker 的通过声明。'],
]) {
  test(`lifecycle delta rejects changing ${description}`, async () => {
    const input = await createPlanningFixture();
    replaceText(input.afterFiles, input.scope.planning.dashboardPath, from, to); refreshPlanningFixture(input);
    assert.throws(() => validatePlanningDelta(input));
  });
}

test('other Task packet edits remain visible even if omitted from supplied Markdown maps', async () => {
  const input = await createPlanningFixture();
  replaceText(input.afterFiles, 'docs/plan/tasks/B.md', '当前任务的功能与验证。', '整个仓库的无限范围修改。');
  refreshPlanningFixture(input);
  input.beforeFiles.delete('docs/plan/tasks/B.md'); input.afterFiles.delete('docs/plan/tasks/B.md');
  assert.throws(() => validatePlanningDelta(input), /Another Planning file changed/u);
});

for (const [description, from, to] of [
  ['unmet acceptance', '- [x] 当前任务的功能满足需求约束。', '- [ ] 当前任务的功能满足需求约束。'],
  ['rewritten acceptance', '当前任务的功能满足需求约束。', 'Worker 声明通过即可。'],
  ['expanded Task scope', '当前任务的功能与验证。', '所有任务的任意功能与验证。'],
  ['missing evidence target', '../../../verification/A.md', '../../../verification/missing.md'],
  ['missing completion record', '## 完成验收结果', '## 其他说明'],
  ['wrong Task identity', '# 任务 A：任务', '# 任务 OTHER：任务'],
]) {
  test(`archive validation rejects ${description}`, async () => {
    const input = await createPlanningFixture();
    replaceText(input.afterFiles, input.scope.planning.archivePath, from, to); refreshPlanningFixture(input);
    assert.throws(() => validatePlanningDelta(input));
  });
}

test('completion cannot retain the active Task packet or active table row', async () => {
  const input = await createPlanningFixture();
  input.afterFiles.set(input.scope.planning.taskPath, input.beforeFiles.get(input.scope.planning.taskPath)); refreshPlanningFixture(input);
  assert.throws(() => validatePlanningDelta(input));
  const second = await createPlanningFixture();
  replaceText(second.afterFiles, second.scope.planning.dashboardPath, '| B — 任务 |', '| A — 任务 | 🟡 P1 | 🟢 待执行 | 无 | 无 | [执行包](tasks/A.md) |\n| B — 任务 |');
  refreshPlanningFixture(second);
  assert.throws(() => validatePlanningDelta(second));
});

test('archive index is append-only and its current row must bind date, identity and path', async () => {
  for (const [from, to] of [
    ['原验收通过', '悄悄改写历史验收'], ['| A | 2026-09-17 |', '| OTHER | 2026-09-17 |'],
    ['| A | 2026-09-17 |', '| A | 2026-02-30 |'], ['[A](A.md)', '[A](../M0/OLD.md)'],
  ]) {
    const input = await createPlanningFixture();
    replaceText(input.afterFiles, input.scope.planning.archiveIndexPath, from, to); refreshPlanningFixture(input);
    assert.throws(() => validatePlanningDelta(input));
  }
});

test('missing index creation is supported but a different milestone or an old closure is rejected', async () => {
  const input = await createPlanningFixture();
  input.beforeFiles.delete(input.scope.planning.archiveIndexPath);
  replaceText(input.afterFiles, input.scope.planning.archiveIndexPath, '| HIST | 2026-09-16 | 原验收通过 | [HIST](HIST.md) |\n', '');
  refreshPlanningFixture(input); assert.doesNotThrow(() => validatePlanningDelta(input));
  const different = await createPlanningFixture();
  different.closure.archivePath = 'docs/plan/archive/M2/A.md';
  assert.throws(() => validatePlanningDelta(different), /frozen scope/u);
  const old = await createPlanningFixture();
  old.beforeFiles.set('docs/plan/archive/M0/A.closure-2.md', Buffer.from('# 任务 A：旧关闭\n'));
  old.afterFiles.set('docs/plan/archive/M0/A.closure-2.md', old.beforeFiles.get('docs/plan/archive/M0/A.closure-2.md'));
  refreshPlanningFixture(old); assert.throws(() => validatePlanningDelta(old), /already has a closure/u);
  const ambiguous = await createPlanningFixture();
  replaceText(ambiguous.beforeFiles, 'docs/plan/archive/M0/README.md', '| OLD |', '| A |');
  ambiguous.afterFiles.set('docs/plan/archive/M0/README.md', ambiguous.beforeFiles.get('docs/plan/archive/M0/README.md'));
  refreshPlanningFixture(ambiguous); assert.throws(() => validatePlanningDelta(ambiguous), /already claims this Task/u);
});

test('recent completions are bounded and cannot rewrite another Task summary', async () => {
  const input = await createPlanningFixture();
  replaceText(input.afterFiles, input.scope.planning.dashboardPath, '[OLD](archive/M0/OLD.md) 已验收。', '[OLD](archive/M0/OLD.md) 现在有了新范围。');
  refreshPlanningFixture(input); assert.throws(() => validatePlanningDelta(input), /rewritten or reordered/u);
  const tooMany = await createPlanningFixture();
  replaceText(tooMany.afterFiles, tooMany.scope.planning.dashboardPath, '## 近期完成\n\n', `## 近期完成\n\n${'- [OLD](archive/M0/OLD.md) 额外摘要。\n'.repeat(4)}`);
  refreshPlanningFixture(tooMany); assert.throws(() => validatePlanningDelta(tooMany), /at most five/u);
});

test('a recent-completion list can keep four old entries and add only the current closure', async () => {
  const input = await createPlanningFixture();
  for (const id of ['P1', 'P2', 'P3', 'P4']) {
    const path = `docs/plan/archive/M0/${id}.md`; const bytes = Buffer.from(`# 任务 ${id}：历史任务\n`);
    input.beforeFiles.set(path, bytes); input.afterFiles.set(path, Buffer.from(bytes));
  }
  const old = ['OLD', 'P1', 'P2', 'P3', 'P4'].map((id) => `- [${id}](archive/M0/${id}.md) 已验收。`).join('\n');
  const kept = ['OLD', 'P1', 'P2', 'P3'].map((id) => `- [${id}](archive/M0/${id}.md) 已验收。`).join('\n');
  replaceText(input.beforeFiles, input.scope.planning.dashboardPath, '- [OLD](archive/M0/OLD.md) 已验收。', old);
  replaceText(input.afterFiles, input.scope.planning.dashboardPath, '- [OLD](archive/M0/OLD.md) 已验收。', kept);
  refreshPlanningFixture(input); assert.doesNotThrow(() => validatePlanningDelta(input));
});

test('Worker closure hash claims cannot replace independent before/after evidence', async () => {
  const input = await createPlanningFixture();
  input.closure.changes[0].beforeHash = 'a'.repeat(64);
  assert.throws(() => validatePlanningDelta(input), /claims do not match/u);
});

for (const location of ['active', 'archive']) {
  test(`supplemental ${location} tables remain protected original context`, async () => {
    const input = await createPlanningFixture();
    const path = location === 'active' ? input.scope.planning.dashboardPath : input.scope.planning.archiveIndexPath;
    const marker = location === 'active' ? '## 近期完成' : '# M1 归档';
    const extra = '| 约束 | 原始依据 |\n|---|---|\n| 共享规则 | 保留人工验收 |\n\n';
    for (const files of [input.beforeFiles, input.afterFiles]) replaceText(files, path, marker, `${extra}${marker}`);
    refreshPlanningFixture(input);
    assert.doesNotThrow(() => validatePlanningDelta(input));
    replaceText(input.afterFiles, path, '保留人工验收', '由 Worker 自行豁免');
    refreshPlanningFixture(input);
    assert.throws(() => validatePlanningDelta(input), /explanatory content changed|prose changed/u);
  });
}

test('the real Dashboard 最近完成 heading supports the same bounded lifecycle update', async () => {
  const input = await createPlanningFixture();
  for (const files of [input.beforeFiles, input.afterFiles]) {
    replaceText(files, input.scope.planning.dashboardPath, '## 近期完成', '## 最近完成');
  }
  refreshPlanningFixture(input);
  assert.doesNotThrow(() => validatePlanningDelta(input));
  replaceText(input.afterFiles, input.scope.planning.dashboardPath, '使用原 [HARNESS](../../HARNESS.md)。', '共享验证规则被改写。');
  refreshPlanningFixture(input);
  assert.throws(() => validatePlanningDelta(input), /outside the current Task lifecycle/u);
});

test('recent-completion aliases cannot coexist or repeat even when a heading has an empty body', async () => {
  for (const existing of ['近期完成', '最近完成']) {
    for (const heading of ['近期完成', '最近完成']) {
      for (const side of ['beforeFiles', 'afterFiles']) {
        const input = await createPlanningFixture();
        for (const files of [input.beforeFiles, input.afterFiles]) {
          replaceText(files, input.scope.planning.dashboardPath, '## 近期完成', `## ${existing}`);
        }
        replaceText(input[side], input.scope.planning.dashboardPath, '## 共享验证基线', `## ${heading}\n\n## 共享验证基线`);
        refreshPlanningFixture(input);
        assert.throws(() => validatePlanningDelta(input), /one unambiguous heading/u);
      }
    }
  }
});
