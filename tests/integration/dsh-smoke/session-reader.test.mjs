import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readFreshDshSession } from '../../../packages/adapter-dsh/dist/executor/session-reader.js';

const dshEntry = process.env.DHR_TEST_DSH_ENTRY;

test('DSH rc.1 persistence reader accepts only one fresh Session in its isolated store',
  { skip: !dshEntry && 'Set DHR_TEST_DSH_ENTRY to an installed DSH launcher for host validation' }, async () => {
    const requireFromDsh = createRequire(pathToFileURL(dshEntry));
    const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href);
    const { default: Backend } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
    const stage = await mkdtemp(join(tmpdir(), 'dhr-dsh-session-reader-'));
    const cwd = join(stage, 'work'); const sessionsRoot = join(stage, 'sessions');
    await mkdir(cwd);
    try {
      const backend = new Backend(new Context(), { root: sessionsRoot });
      const first = { version: 3, id: 'session-902adca5-4476-4b2b-b8f8-abc1f321bccf',
        createdAt: Date.now(), cwd, isSeeded: false };
      const handle = await backend.create(first);
      await handle.append([{ seq: 0, time: Date.now(), type: 'turn/start', data: { turn: 1 } },
        { seq: 1, time: Date.now(), type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]);
      await handle.flush(); await handle.close();
      const read = await readFreshDshSession({ dshEntry, sessionsRoot, repoRoot: cwd });
      assert.equal(read.header.id, first.id);
      assert.deepEqual(read.events.map(({ type }) => type), ['turn/start', 'turn/end']);
      await assert.rejects(readFreshDshSession({ dshEntry, sessionsRoot, repoRoot: join(stage, 'other') }), { code: 'INVALID_RESULT' });
      const second = await backend.create({ ...first, id: 'session-5a7765c8-28e3-4a74-8867-194ac73a6cf3' });
      await second.flush(); await second.close();
      await assert.rejects(readFreshDshSession({ dshEntry, sessionsRoot, repoRoot: cwd }), { code: 'INVALID_RESULT' });
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
