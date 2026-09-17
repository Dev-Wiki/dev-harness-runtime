import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { serializeSnapshot, snapshotBoundaryHash } from '../../dist/snapshot/capture.js';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const buffer = (text) => Buffer.from(text, 'utf8');
export function replaceText(files, path, from, to) {
  const text = files.get(path).toString('utf8');
  if (!text.includes(from)) throw new Error(`Fixture edit does not match ${path}: ${from}`);
  files.set(path, buffer(text.replace(from, to)));
}

function capture(base, files, initial, currentTaskPath) {
  const paths = [...new Set([...initial.keys(), ...files.keys()])].sort().map((path) => {
    const previous = initial.get(path);
    const index = previous ? [{ stage: 0, blob: createHash('sha1').update(`blob ${previous.length}\0`).update(previous).digest('hex'), mode: '100644' }] : [];
    return files.has(path) ? { path, type: 'file', mode: '100644', deleted: false, rawContentHash: digest(files.get(path)), index }
      : { path, type: 'missing', mode: null, deleted: true, index };
  });
  const ref = (path) => ({ schemaVersion: 1, path, sha256: digest(files.get(path)) });
  const snapshot = { ...base, paths, indexFingerprint: digest(JSON.stringify([...initial].map(([path, bytes]) => [path, digest(bytes)]))),
    indexFlags: [...initial.keys()].sort().map((path) => ({ path, tag: 'H' })),
    dirtyPaths: paths.filter(({ path }) => !initial.has(path) || !files.has(path) || !initial.get(path).equals(files.get(path))).map(({ path }) => path), stagedPaths: [],
    dashboardRef: ref('docs/plan/Dashboard.md'), currentTaskRef: ref(currentTaskPath), dependencyArchiveRefs: [],
    agentsRef: ref('AGENTS.md'), harnessRef: ref('HARNESS.md'), gitWorkflowRef: ref('docs/GIT_WORKFLOW.md') };
  return { snapshot, hash: digest(serializeSnapshot(snapshot)), boundaryHash: snapshotBoundaryHash(snapshot), dirtyPaths: [...snapshot.dirtyPaths], stagedPaths: [] };
}

/** Honest synthetic content captures for pure delta tests; Markdown comes from real reader fixtures. */
export function refreshPlanningFixture(input) {
  const base = input.before.snapshot;
  input.before = capture(base, input.beforeFiles, input.beforeFiles, input.scope.planning.taskPath);
  const current = input.afterFiles.has(input.scope.planning.archivePath) ? input.scope.planning.archivePath : input.scope.planning.taskPath;
  input.after = capture(base, input.afterFiles, input.beforeFiles, current);
  const paths = ['taskPath', 'archivePath', 'archiveIndexPath', 'dashboardPath'].map((key) => input.scope.planning[key]);
  input.closure = { schemaVersion: 1, ...input.scope.planning, summary: 'A completed and archived', changes: paths.map((path) => ({ path,
    beforeHash: input.beforeFiles.has(path) ? digest(input.beforeFiles.get(path)) : null,
    afterHash: input.afterFiles.has(path) ? digest(input.afterFiles.get(path)) : null })) };
  return input;
}

export async function createPlanningFixture() {
  const base = JSON.parse(await readFile(new URL('../../../contracts/fixtures/state/snapshot.json', import.meta.url), 'utf8'));
  const packet = await readFile(new URL('../../../../tests/fixtures/planning/task-packet.md', import.meta.url), 'utf8');
  const dashboard = '# Dashboard\n\n## 当前工作顺序\n\n1. [A — 任务](tasks/A.md)\n2. [B — 任务](tasks/B.md)\n3. [C — 任务](tasks/C.md)\n\n顺序由计划维护者确认。\n\n'
    + '## 活跃任务\n\n| 任务 | 优先级 | 状态 | 依赖 | 下一步 / 阻塞 | 详情 |\n|---|---|---|---|---|---|\n'
    + '| A — 任务 | 🟡 P1 | 🟢 待执行 | 无 | 无 | [执行包](tasks/A.md) |\n'
    + '| B — 任务 | 🔴 P0 | 🟢 待执行 | [A](tasks/A.md) | 无 | [执行包](tasks/B.md) |\n'
    + '| C — 任务 | 🟢 P2 | 📋 规划中 | B | 无 | [执行包](tasks/C.md) |\n\n'
    + '## 近期完成\n\n- [OLD](archive/M0/OLD.md) 已验收。\n\n## 共享验证基线\n\n使用原 [HARNESS](../../HARNESS.md)。\n';
  const index = '# M1 归档\n\n| 任务编号 | 完成日期 | 验收摘要 | 详情 |\n|---|---|---|---|\n| HIST | 2026-09-16 | 原验收通过 | [HIST](HIST.md) |\n';
  const beforeFiles = new Map([
    ['AGENTS.md', '# Rules\n'], ['HARNESS.md', '# Original HARNESS\nRun node --test.\n'], ['docs/GIT_WORKFLOW.md', '# Git\n'],
    ['docs/requirements.md', '# Requirements\n'], ['docs/CONTRACTS.md', '# Contracts\n'],
    ['docs/plan/Dashboard.md', dashboard], ['docs/plan/archive/M1/README.md', index],
    ['docs/plan/archive/M1/HIST.md', '# 任务 HIST：以前的任务\n'], ['docs/plan/archive/M0/OLD.md', '# 任务 OLD：历史任务\n'],
    ['docs/plan/archive/M0/README.md', '# M0\n\n| 任务编号 | 完成日期 | 验收摘要 | 详情 |\n|---|---|---|---|\n| OLD | 2026-09-15 | 已通过 | [OLD](OLD.md) |\n'],
    ...['A', 'B', 'C'].map((id) => [`docs/plan/tasks/${id}.md`, packet.replaceAll('{{ID}}', id).replaceAll('{{TITLE}}', '任务')]),
  ].map(([path, text]) => [path, buffer(text)]));
  const afterFiles = new Map([...beforeFiles].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const taskPath = 'docs/plan/tasks/A.md'; const archivePath = 'docs/plan/archive/M1/A.md';
  let archive = beforeFiles.get(taskPath).toString('utf8').replaceAll('- [ ]', '- [x]');
  archive = archive.replaceAll(/\]\(([^)]+)\)/gu, (_match, href) => `](${posix.relative(posix.dirname(archivePath), posix.normalize(posix.join(posix.dirname(taskPath), href)))})`);
  archive = archive.replace('尚未执行；实施后记录实际证据。', '通过，见 [本次验证](../../../verification/A.md)。');
  archive += '\n## 完成验收结果\n\n本任务全部验收通过，证据已保存。\n';
  afterFiles.delete(taskPath); afterFiles.set(archivePath, buffer(archive));
  afterFiles.set('docs/verification/A.md', buffer('# A verification\nCore verification evidence.\n'));
  replaceText(afterFiles, 'docs/plan/Dashboard.md', '1. [A — 任务](tasks/A.md)\n2. [B — 任务](tasks/B.md)\n3. [C — 任务](tasks/C.md)', '1. [B — 任务](tasks/B.md)\n2. [C — 任务](tasks/C.md)');
  replaceText(afterFiles, 'docs/plan/Dashboard.md', '| A — 任务 | 🟡 P1 | 🟢 待执行 | 无 | 无 | [执行包](tasks/A.md) |\n', '');
  replaceText(afterFiles, 'docs/plan/Dashboard.md', '[A](tasks/A.md)', '[A](archive/M1/A.md)');
  replaceText(afterFiles, 'docs/plan/Dashboard.md', '## 近期完成\n\n', '## 近期完成\n\n- [A](archive/M1/A.md) 本次验收完成。\n');
  afterFiles.set('docs/plan/archive/M1/README.md', buffer(`${index}| A | 2026-09-17 | 本次验收通过 | [A](A.md) |\n`));
  const scope = { schemaVersion: 1, files: ['docs/verification/A.md'], directories: [], planning: {
    taskId: 'A', taskPath, archivePath, dashboardPath: 'docs/plan/Dashboard.md', archiveIndexPath: 'docs/plan/archive/M1/README.md' } };
  return refreshPlanningFixture({ before: { snapshot: base }, beforeFiles, afterFiles, scope });
}
