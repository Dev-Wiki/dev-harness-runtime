import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { PlanningError, readPlan, selectTask } from '../../dist/index.js';

const fixtureRoot = new URL('../../../../tests/fixtures/planning/', import.meta.url);
const fixture = (name) => readFile(new URL(name, fixtureRoot), 'utf8');
const defaultRows = [
  { id: 'A', title: '第一个任务', priority: '🟢 P2', blocker: '无；先核对验收命令' },
  { id: 'B', title: '第二个任务', priority: '🔴 P0', dependencies: '[A](tasks/A.md)' },
  { id: 'C', title: '第三个任务', priority: '🟡 P1', dependencies: 'B' },
];
function dashboard(rows, order = rows.map((row) => row.id)) {
  return '# 测试开发看板\n\n## 当前工作顺序\n\n'
    + order.map((id, index) => `${index + 1}. [${id} — 任务](tasks/${id}.md)`).join('\n')
    + '\n\n## 活跃任务\n\n| 任务 | 优先级 | 状态 | 依赖 | 下一步 / 阻塞 | 详情 |\n|---|---|---|---|---|---|\n'
    + rows.map((row) => `| **${row.id} — ${row.title ?? '任务'}** | ${row.priority ?? '🟡 P1'} | ${row.status ?? '🟢 待执行'} | ${row.dependencies ?? '无'} | ${row.blocker ?? '无'} | ${row.details ?? `[执行包](tasks/${row.id}.md)`} |`).join('\n') + '\n';
}
async function write(project, path, content) {
  const target = join(project.repoRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
async function makeProject(t, { rows = defaultRows, order, content } = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'dhr-planning-reader-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const project = { repoRoot, docsRoot: join(repoRoot, 'docs'), dashboardPath: join(repoRoot, 'docs/plan/Dashboard.md') };
  await write(project, 'docs/plan/Dashboard.md', content ?? (rows === defaultRows && order === undefined ? await fixture('dashboard-ready.md') : dashboard(rows, order)));
  const packet = await fixture('task-packet.md');
  for (const row of rows) {
    await write(project, `docs/plan/tasks/${row.id}.md`, packet.replaceAll('{{ID}}', row.id).replaceAll('{{TITLE}}', row.title ?? '任务'));
  }
  await write(project, 'AGENTS.md', '# 项目规范\n\n按 HARNESS 执行验证。\n');
  await write(project, 'HARNESS.md', '# 验证契约\n\n- BuildCommand: `pnpm build`\n- test: `pnpm test`\n');
  await write(project, 'docs/requirements.md', '# 需求\n\n按执行包范围完成变更。\n');
  await write(project, 'docs/CONTRACTS.md', '# 项目契约\n\n保持原有内容与任务身份。\n');
  return project;
}
async function editDashboard(project, edit) {
  await writeFile(project.dashboardPath, edit(await readFile(project.dashboardPath, 'utf8')), 'utf8');
}
async function addArchive(project, { milestone = 'M1', packet, index } = {}) {
  await write(project, `docs/plan/archive/${milestone}/README.md`, index ?? await fixture('archive-index.md'));
  await write(project, `docs/plan/archive/${milestone}/A.md`, packet ?? await fixture('archive-packet.md'));
  await write(project, 'docs/verification/A.md', '# A 验证记录\n\n2026-09-17 在项目根执行 `pnpm test`，退出码 0，全部验收通过。\n');
}
function blocked(result, taskId) {
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasons.some((reason) => reason.taskId === taskId && reason.code.length > 0 && reason.message.length > 0));
}
const rejectsPlan = (project) => assert.rejects(readPlan(project), PlanningError);
const repeatedClosureIndex = '# M1 任务归档\n\n| 任务编号 | 任务 | 完成日期 | 验收摘要 | 详情 | 关闭次数 | 前次 |\n|---|---|---|---|---|---|---|\n'
  + '| A | 首次完成 | 2026-09-17 | 验收通过 | [A](A.md) | 1 | 无 |\n'
  + '| A | 再次完成 | 2026-09-18 | 再次验收通过 | [A](A.closure-2.md) | 2 | [A](A.md) |\n';
async function addRepeatedClosure(project, index = repeatedClosureIndex) {
  await addArchive(project, { index });
  await write(project, 'docs/plan/archive/M1/A.closure-2.md', await fixture('archive-packet.md') + '\n## 关闭记录\n\n关闭次数：2。前次快照：[A](A.md)。\n');
}

for (const mode of ['explicit', 'next', 'all-ready']) {
  test(`Planning selects A using ${mode} without priority reordering`, async (t) => {
    const project = await makeProject(t);
    const plan = await readPlan(project);
    assert.deepEqual(plan.order, ['A', 'B', 'C']);
    const selection = selectTask(plan, mode === 'explicit' ? { mode, taskId: 'A' } : { mode });
    assert.equal(selection.status, 'selected');
    assert.equal(selection.task.id, 'A');
    assert.equal(selection.task.contextComplete, true);
  });
}

test('explicit selection cannot bypass an active dependency or invent a Task', async (t) => {
  const plan = await readPlan(await makeProject(t));
  blocked(selectTask(plan, { mode: 'explicit', taskId: 'B' }), 'B');
  assert.throws(() => selectTask(plan, { mode: 'explicit', taskId: 'MISSING' }),
    (error) => error instanceof PlanningError && error.code === 'TASK_NOT_FOUND');
});

test('explicit selection cannot execute a Task outside the authoritative work order', async (t) => {
  const rows = [{ id: 'A' }, { id: 'F', status: '📋 远期' }];
  const plan = await readPlan(await makeProject(t, { rows, order: ['A'] }));
  blocked(selectTask(plan, { mode: 'explicit', taskId: 'F' }), 'F');
});

for (const status of ['📋 规划中', '🚧 开发中']) {
  test(`explicit cannot bypass ${status}; next/all-ready can select a later eligible Task`, async (t) => {
    const rows = [{ id: 'A', status }, { id: 'B' }];
    const plan = await readPlan(await makeProject(t, { rows }));
    blocked(selectTask(plan, { mode: 'explicit', taskId: 'A' }), 'A');
    for (const mode of ['next', 'all-ready']) assert.equal(selectTask(plan, { mode }).task.id, 'B');
  });
}

for (const blocker of ['G1 待确认', '已解除', '正常', '无。']) {
  test(`blocker ${JSON.stringify(blocker)} is not treated as the canonical no-blocker token`, async (t) => {
    const plan = await readPlan(await makeProject(t, { rows: [{ id: 'A', blocker }] }));
    for (const mode of ['explicit', 'next', 'all-ready']) blocked(selectTask(plan, mode === 'explicit' ? { mode, taskId: 'A' } : { mode }), 'A');
  });
}

test('blank blockers make the plan incomplete rather than an executable or blocked queue', async (t) => {
  for (const blocker of ['', '   ']) {
    await rejectsPlan(await makeProject(t, { rows: [{ id: 'A', blocker }] }));
  }
});

test('every ready Task must appear exactly once in the authoritative work order', async (t) => {
  await rejectsPlan(await makeProject(t, { rows: [{ id: 'A' }, { id: 'B' }], order: ['A'] }));
});

test('TaskDetails may remain as a short compatibility redirect to Dashboard', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'A' }] });
  await write(project, 'docs/plan/TaskDetails.md', '# TaskDetails\n\n任务信息已迁移，请访问 [Dashboard](Dashboard.md)。\n');
  assert.equal(selectTask(await readPlan(project), { mode: 'next' }).task.id, 'A');
});

test('TaskDetails cannot preserve a competing task index', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'A' }] });
  await write(project, 'docs/plan/TaskDetails.md', '# TaskDetails\n\n[Dashboard](Dashboard.md)\n\n## 活跃任务\n\n| 任务 | 状态 |\n|---|---|\n| A | 🟢 待执行 |\n');
  await rejectsPlan(project);
});

test('an existing TaskDetails redirect with a missing target is not treated as an absent compatibility file', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'A' }] });
  await write(project, 'docs/plan/TaskDetails.md', '# TaskDetails\n\n请访问 [Dashboard](missing.md)。\n');
  await rejectsPlan(project);
});

test('empty authoritative queue with a future backlog is normally exhausted', async (t) => {
  const plan = await readPlan(await makeProject(t, { rows: [{ id: 'F', status: '📋 远期', blocker: '远期候选' }], order: [] }));
  for (const mode of ['next', 'all-ready']) assert.deepEqual(selectTask(plan, { mode }), { status: 'completed', reason: 'queueExhausted' });
});

test('incomplete Task context is blocked instead of being accepted as ready', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'A' }] });
  await write(project, 'docs/plan/tasks/A.md', '# 任务 A：不完整任务\n\n## 背景与目标\n\n实现功能。\n');
  const plan = await readPlan(project);
  assert.equal(plan.tasks[0].contextComplete, false);
  assert.ok(plan.tasks[0].contextProblems.length > 0);
  blocked(selectTask(plan, { mode: 'explicit', taskId: 'A' }), 'A');
});

test('reader resolves active table columns by headers rather than positional assumptions', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'A' }] });
  await editDashboard(project, (text) => text.replace(
    '| 任务 | 优先级 | 状态 | 依赖 | 下一步 / 阻塞 | 详情 |\n|---|---|---|---|---|---|\n| **A — 任务** | 🟡 P1 | 🟢 待执行 | 无 | 无 | [执行包](tasks/A.md) |',
    '| 详情 | 状态 | 任务 | 下一步 / 阻塞 | 依赖 | 优先级 |\n|---|---|---|---|---|---|\n| [执行包](tasks/A.md) | 🟢 待执行 | **A — 任务** | 无 | 无 | 🟡 P1 |',
  ));
  assert.equal(selectTask(await readPlan(project), { mode: 'next' }).task.id, 'A');
});

test('escaped pipes remain inside cells and fenced examples do not create authority', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'A', title: '输入 A\\|B', blocker: '无；检查 A\\|B' }] });
  await editDashboard(project, (text) => '# 示例\n\n```markdown\n## 当前工作顺序\n1. [UNKNOWN](tasks/UNKNOWN.md)\n## 活跃任务\n<!-- hidden example -->\n```\n\n' + text);
  const plan = await readPlan(project);
  assert.deepEqual(plan.order, ['A']);
  assert.ok(plan.tasks[0].title.includes('A|B'));
  assert.equal(selectTask(plan, { mode: 'next' }).task.id, 'A');
});

test('paragraph links and unrelated Markdown tables do not become work-order entries', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'A' }] });
  await editDashboard(project, (text) => text.replace('## 活跃任务', '说明中的 [未知任务](tasks/UNKNOWN.md) 不产生任务。\n\n## 活跃任务') + '\n## 其他说明\n\n| 状态 | 详情 |\n|---|---|\n| 示例 | 无 |\n');
  assert.deepEqual((await readPlan(project)).order, ['A']);
});

const malformedDashboards = [
  ['duplicate work-order ID', (text) => text.replace('2. [B — 第二个任务](tasks/B.md)', '2. [A — 第一个任务](tasks/A.md)')],
  ['nonconsecutive order numbers', (text) => text.replace('2. [B', '4. [B')],
  ['order does not start at one', (text) => text.replace('1. [A', '0. [A')],
  ['order item does not begin with its Task link', (text) => text.replace('1. [A', '1. 先执行 [A')],
  ['link label disagrees with Task ID', (text) => text.replace('[A — 第一个任务](tasks/A.md)', '[Z — 第一个任务](tasks/A.md)')],
  ['duplicate active ID', (text) => text + '| **A — 重复任务** | 🟡 P1 | 🟢 待执行 | 无 | 无 | [执行包](tasks/A.md) |\n'],
  ['missing active row', (text) => text.replace(/^\| \*\*A —.*\n/mu, '')],
  ['missing required header', (text) => text.replace('| 下一步 / 阻塞 |', '| 下一步 |')],
  ['duplicate authoritative heading', (text) => text + '\n## 当前工作顺序\n\n1. [A](tasks/A.md)\n'],
  ['wrong heading depth', (text) => text.replace('## 1. 当前工作顺序', '### 当前工作顺序')],
  ['hidden HTML authority', (text) => text + '\n<!-- ## 活跃任务\n隐藏任务 -->\n'],
  ['inline hidden HTML', (text) => text.replace('无；先核对验收命令', '无<span hidden>阻塞</span>')],
  ['completed task remains active', (text) => text.replace('🟢 待执行', '✅ 已完成')],
  ['inexact status token', (text) => text.replace('🟢 待执行', '待执行')],
  ['two detail links', (text) => text.replace('[执行包](tasks/A.md)', '[执行包](tasks/A.md) [另一个](tasks/A.md)')],
  ['detail Task ID mismatch', (text) => text.replace('[执行包](tasks/A.md)', '[执行包](tasks/B.md)')],
];
for (const [name, edit] of malformedDashboards) {
  test(`malformed plan rejects ${name}`, async (t) => {
    const project = await makeProject(t);
    await editDashboard(project, edit);
    await rejectsPlan(project);
  });
}

test('nested authoritative tables and nested work-order lists are unsupported', async (t) => {
  const table = await makeProject(t, { rows: [{ id: 'A' }] });
  await editDashboard(table, (text) => text.replace(/^\|.*$/gmu, (line) => `> ${line}`));
  await rejectsPlan(table);
  const list = await makeProject(t);
  await editDashboard(list, (text) => text.replace('2. [B', '   1. [B'));
  await rejectsPlan(list);
});

for (const target of ['../tasks/A.md', '/tmp/A.md', 'https://example.com/A.md', 'tasks/A.md?mode=ready', 'tasks/A.md#acceptance', 'tasks/a.md', 'tasks/%2e%2e/A.md', 'tasks\\A.md']) {
  test(`Task link rejects unsupported or ambiguous path ${target}`, async (t) => {
    const project = await makeProject(t, { rows: [{ id: 'A' }] });
    await editDashboard(project, (text) => text.replaceAll('tasks/A.md', target));
    await rejectsPlan(project);
  });
}

test('missing Task files and mismatched Task packet identity fail closed', async (t) => {
  const missing = await makeProject(t, { rows: [{ id: 'A' }] });
  await rm(join(missing.repoRoot, 'docs/plan/tasks/A.md'));
  await rejectsPlan(missing);
  const mismatch = await makeProject(t, { rows: [{ id: 'A' }] });
  await write(mismatch, 'docs/plan/tasks/A.md', (await fixture('task-packet.md')).replaceAll('{{ID}}', 'OTHER').replaceAll('{{TITLE}}', '错误身份'));
  await rejectsPlan(mismatch);
});

test('Task links cannot escape the repository through a symlink', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'A' }] });
  const outside = await mkdtemp(join(tmpdir(), 'dhr-planning-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const source = join(project.repoRoot, 'docs/plan/tasks/A.md');
  await writeFile(join(outside, 'A.md'), await readFile(source));
  await rm(source);
  try { await symlink(join(outside, 'A.md'), source, 'file'); }
  catch (error) {
    if (error.code === 'EPERM' && process.platform === 'win32') { t.skip('File symlink creation requires Windows privileges'); return; }
    throw error;
  }
  await rejectsPlan(project);
});

for (const dependencies of ['A', 'B、B', '完成前一阶段后', '[UNKNOWN](tasks/UNKNOWN.md)', 'UNKNOWN']) {
  test(`dependency rejects self, repeated, natural-language or unresolved value ${dependencies}`, async (t) => {
    const project = await makeProject(t, { rows: [{ id: 'A', dependencies }, { id: 'B' }] });
    await rejectsPlan(project);
  });
}

test('dependency cycles are rejected before task selection', async (t) => {
  const rows = [{ id: 'A', dependencies: 'B' }, { id: 'B', dependencies: 'C' }, { id: 'C', dependencies: 'A' }];
  await rejectsPlan(await makeProject(t, { rows }));
});

test('an archived dependency supplies completion evidence and hashed selection references', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'B', dependencies: '[A](archive/M1/A.md)' }] });
  await addArchive(project);
  const plan = await readPlan(project);
  assert.equal(selectTask(plan, { mode: 'next' }).task.id, 'B');
  assert.deepEqual(plan.tasks[0].dependencies.map(({ id, completed }) => ({ id, completed })), [{ id: 'A', completed: true }]);
  for (const suffix of ['docs/plan/Dashboard.md', 'docs/plan/tasks/B.md', 'docs/plan/archive/M1/README.md', 'docs/plan/archive/M1/A.md']) {
    const reference = plan.references.find((item) => item.path.replaceAll('\\', '/').endsWith(suffix));
    assert.ok(reference, `Expected reference for ${suffix}`);
    const target = isAbsolute(reference.path) ? reference.path : join(project.repoRoot, reference.path);
    assert.equal(reference.sha256, createHash('sha256').update(await readFile(target)).digest('hex'));
  }
});

test('plain dependency IDs resolve archive indexes without reading unrelated archive bodies', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'B', dependencies: 'A' }] });
  await addArchive(project, { index: await fixture('archive-index.md') + '| Z | 无关任务 | 2026-09-17 | 已验收 | [Z](Z.md) |\n' });
  await write(project, 'docs/plan/archive/M1/Z.md', 'Unrelated malformed archive body without acceptance evidence.\n');
  const plan = await readPlan(project);
  assert.equal(selectTask(plan, { mode: 'next' }).task.id, 'B');
  assert.ok(!plan.references.some((reference) => reference.path.endsWith('/Z.md')));
});

test('unindexed archive scratch directories do not invalidate an indexed dependency', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'B', dependencies: 'A' }] });
  await addArchive(project);
  await write(project, 'docs/plan/archive/scratch/notes.md', '# 工作笔记\n\n本目录不声明任何任务归档完成记录。\n');
  const plan = await readPlan(project);
  assert.equal(selectTask(plan, { mode: 'next' }).task.id, 'B');
  assert.ok(!plan.references.some((reference) => reference.path.includes('/scratch/')));
});

for (const [name, content] of [
  ['report.html', Buffer.from('<html><body><h2>活跃任务</h2><div hidden>Historical test report</div></body></html>')],
  ['report.txt', Buffer.from('Tests passed. Exit code: 0. This evidence file is not a Task packet.\n')],
  ['report.bin', Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80, 0x0a, 0x7f])],
]) {
  test(`archived evidence ${name} is hashed as raw bytes without Task or Markdown parsing`, async (t) => {
    const project = await makeProject(t, { rows: [{ id: 'B', dependencies: 'A' }] });
    await addArchive(project, { packet: (await fixture('archive-packet.md')).replace('../../../verification/A.md', `../../../verification/${name}`) });
    await write(project, `docs/verification/${name}`, content);
    const plan = await readPlan(project);
    assert.equal(selectTask(plan, { mode: 'next' }).task.id, 'B');
    const reference = plan.references.find((item) => item.path.replaceAll('\\', '/').endsWith(`docs/verification/${name}`));
    assert.ok(reference);
    assert.equal(reference.sha256, createHash('sha256').update(content).digest('hex'));
  });
}

test('a reopened active Task takes precedence over its older completed archive', async (t) => {
  const rows = [{ id: 'A', status: '🚧 开发中' }, { id: 'B', dependencies: '[A](archive/M1/A.md)' }];
  const project = await makeProject(t, { rows });
  await addArchive(project);
  const plan = await readPlan(project);
  const task = plan.tasks.find((entry) => entry.id === 'B');
  assert.equal(task.dependencies[0].completed, false);
  blocked(selectTask(plan, { mode: 'explicit', taskId: 'B' }), 'B');
});

const invalidArchives = [
  ['missing snapshot', async (project) => rm(join(project.repoRoot, 'docs/plan/archive/M1/A.md'))],
  ['missing referenced evidence', async (project) => rm(join(project.repoRoot, 'docs/verification/A.md'))],
  ['missing completion date', async (project) => write(project, 'docs/plan/archive/M1/README.md', (await fixture('archive-index.md')).replace('2026-09-17', ''))],
  ['invalid completion date', async (project) => write(project, 'docs/plan/archive/M1/README.md', (await fixture('archive-index.md')).replace('2026-09-17', '2026-02-30'))],
  ['empty acceptance summary', async (project) => write(project, 'docs/plan/archive/M1/README.md', (await fixture('archive-index.md')).replace('功能与必需检查通过，证据已保存', ''))],
  ['unchecked acceptance', async (project) => write(project, 'docs/plan/archive/M1/A.md', (await fixture('archive-packet.md')).replaceAll('- [x]', '- [ ]'))],
  ['missing evidence section', async (project) => write(project, 'docs/plan/archive/M1/A.md', '# 任务 A：归档\n\n## 验收标准\n\n- [x] 完成。\n')],
  ['wrong archived Task identity', async (project) => write(project, 'docs/plan/archive/M1/A.md', (await fixture('archive-packet.md')).replace('# 任务 A', '# 任务 OTHER'))],
];
for (const [name, mutate] of invalidArchives) {
  test(`archive completion rejects ${name}`, async (t) => {
    const project = await makeProject(t, { rows: [{ id: 'B', dependencies: 'A' }] });
    await addArchive(project);
    await mutate(project);
    await rejectsPlan(project);
  });
}

test('unresolved duplicate closures and cross-milestone histories cannot be ordered heuristically', async (t) => {
  const same = await makeProject(t, { rows: [{ id: 'B', dependencies: 'A' }] });
  await addArchive(same, { index: await fixture('archive-index.md') + '| A | 再次完成 | 2026-09-18 | 再次验收通过 | [A](A.closure-2.md) |\n' });
  await write(same, 'docs/plan/archive/M1/A.closure-2.md', await fixture('archive-packet.md'));
  await rejectsPlan(same);
  const across = await makeProject(t, { rows: [{ id: 'B', dependencies: 'A' }] });
  await addArchive(across, { milestone: 'M1' });
  await addArchive(across, { milestone: 'M2' });
  await rejectsPlan(across);
});

test('explicit closure numbers and predecessor links identify the latest immutable snapshot', async (t) => {
  const project = await makeProject(t, { rows: [{ id: 'B', dependencies: 'A' }] });
  await addRepeatedClosure(project);
  const plan = await readPlan(project);
  assert.equal(selectTask(plan, { mode: 'next' }).task.id, 'B');
  assert.ok(plan.references.some((reference) => reference.path.endsWith('/A.closure-2.md')));
  await write(project, 'docs/plan/archive/M1/A.closure-2.md', await fixture('archive-packet.md'));
  await rejectsPlan(project);
});

for (const [name, edit] of [
  ['missing predecessor column', (index) => index.replace(' | 前次 |', ' |').replace('|---|---|---|---|---|---|---|', '|---|---|---|---|---|---|').replace('| 1 | 无 |', '| 1 |').replace('| 2 | [A](A.md) |', '| 2 |')],
  ['no predecessor for the second closure', (index) => index.replace('| 2 | [A](A.md) |', '| 2 | 无 |')],
  ['wrong predecessor path', (index) => index.replace('| 2 | [A](A.md) |', '| 2 | [A](A-other.md) |')],
]) {
  test(`repeated closure index rejects ${name} even when the snapshot itself links its predecessor`, async (t) => {
    const project = await makeProject(t, { rows: [{ id: 'B', dependencies: 'A' }] });
    await addRepeatedClosure(project, edit(repeatedClosureIndex));
    await write(project, 'docs/plan/archive/M1/A-other.md', await fixture('archive-packet.md'));
    await rejectsPlan(project);
  });
}
