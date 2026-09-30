import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readFreshDshSession } from '../../../packages/adapter-dsh/dist/executor/session-reader.js';
import { decodeFreshDshExecution } from '../../../packages/adapter-dsh/dist/executor/decode.js';

const dshEntry = process.env.DHR_TEST_DSH_ENTRY;
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../packages/contracts/fixtures/execution/${name}.json`, import.meta.url), 'utf8'));

test('DSH 0.2.0-rc.2 persistence reader accepts only one fresh v4 Session in its isolated store',
  { skip: !dshEntry && 'Set DHR_TEST_DSH_ENTRY to an installed DSH launcher for host validation' }, async () => {
    const requireFromDsh = createRequire(pathToFileURL(dshEntry));
    const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href);
    const { default: Backend } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
    const stage = await mkdtemp(join(tmpdir(), 'dhr-dsh-session-reader-'));
    const cwd = join(stage, 'work'); const sessionsRoot = join(stage, 'sessions');
    await mkdir(cwd);
    try {
      const backend = new Backend(new Context(), { root: sessionsRoot });
      const first = { version: 4, id: 'session-902adca5-4476-4b2b-b8f8-abc1f321bccf',
        createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 };
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

test('DSH v4 persistence events decode into one Core-bound result and private log stream',
  { skip: !dshEntry && 'Set DHR_TEST_DSH_ENTRY to an installed DSH launcher for host validation' }, async () => {
    const requireFromDsh = createRequire(pathToFileURL(dshEntry));
    const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href);
    const { default: Backend } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
    const { Session, SessionId } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session')).href);
    const stage = await mkdtemp(join(tmpdir(), 'dhr-dsh-session-decode-'));
    const cwd = join(stage, 'work'); const sessionsRoot = join(stage, 'sessions');
    await mkdir(cwd);
    try {
      const request = { ...fixture('request'), repoRoot: cwd, docsRoot: join(cwd, 'docs'),
        dashboardPath: join(cwd, 'docs/plan/Dashboard.md'), taskPath: join(cwd, 'docs/plan/tasks/K1.md') };
      const result = fixture('result-blocked');
      const header = { version: 4, id: 'session-902adca5-4476-4b2b-b8f8-abc1f321bccf',
        createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 };
      const session = Session.create(SessionId(header.id), [], header);
      session.append('turn/start', { turn: 1 });
      session.append('step/start', { turn: 1, step: 1 });
      session.append('assistant/message', { turn: 1, step: 1, message: {
        id: 'message-test', role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'synthetic' },
        content: [{ type: 'text', text: JSON.stringify(result) }],
      }, stream: [] }, { surfaceOp: 'append' });
      session.append('step/end', { turn: 1, step: 1 });
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      const backend = new Backend(new Context(), { root: sessionsRoot });
      const handle = await backend.create(header);
      await handle.append(session.snapshotEvents()); await handle.flush(); await handle.close();
      const chunks = [];
      const decoded = await decodeFreshDshExecution({ dshEntry, sessionsRoot, request,
        async log(bytes) { chunks.push(Buffer.from(bytes)); } });
      assert.equal(decoded.sessionId, header.id);
      assert.deepEqual(decoded.result, result);
      assert.deepEqual(decoded.proposals, []);
      const logged = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(logged[0].type, 'session');
      assert.equal(logged.at(-1).type, 'turn/end');
      await assert.rejects(decodeFreshDshExecution({ dshEntry, sessionsRoot, request,
        async log() { throw new Error('evidence sink closed'); } }), /evidence sink closed/u);
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
