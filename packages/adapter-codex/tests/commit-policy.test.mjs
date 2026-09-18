import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { codexConventionalCommitPolicy } from '../dist/index.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const bytes = await readFile(new URL('../../../docs/GIT_WORKFLOW.md', import.meta.url));
const workflow = { path: 'docs/GIT_WORKFLOW.md', bytes,
  sha256: digest(bytes) };
const result = (message) => ({ commitIntent: { message, paths: ['src/a.ts'] } });

test('Codex commit policy accepts only the frozen project template and exact Chinese subject', async () => {
  assert.deepEqual(await codexConventionalCommitPolicy.evaluate({ workflow,
    result: result('feat(codex): 完成受控任务\n') }),
  { message: 'feat(codex): 完成受控任务\n', paths: ['src/a.ts'] });
  for (const message of ['feat(codex): finish task\n', 'unknown(codex): 完成任务\n',
    'feat(codex): 完成任务', 'feat(codex): 完成任务\n下一行\n']) {
    await assert.rejects(codexConventionalCommitPolicy.evaluate({ workflow, result: result(message) }),
      { code: 'AUTHORIZATION_VIOLATION' });
  }
  await assert.rejects(codexConventionalCommitPolicy.evaluate({ workflow: { ...workflow,
    bytes: Buffer.from('# Unrelated policy\n') }, result: result('feat: 完成任务\n') }),
  { code: 'AUTHORIZATION_VIOLATION' });
  const unsupported = Buffer.from('# Workflow\n\n## 提交规范\n\n任意提交消息均可。\n');
  await assert.rejects(codexConventionalCommitPolicy.evaluate({ workflow: { ...workflow,
    bytes: unsupported, sha256: digest(unsupported) }, result: result('feat: 完成任务\n') }),
  { code: 'CAPABILITY_MISSING' });
});
