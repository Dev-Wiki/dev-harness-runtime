import { join } from 'node:path';
import { acquireLock } from '../../dist/lock/index.js';
import { compareAndSwapRun, readRunAtRevision } from '../../dist/state/index.js';
import { withStateFaultForTest } from '../../dist/state/testing.js';

const [repoRoot, privateGitDir, point] = process.argv.slice(2);
const project = { repoRoot, privateGitDir, stateRoot: join(privateGitDir, 'dev-harness-runtime', 'runs') };
const handle = await acquireLock(project, { runId: 'run-a', adapter: 'codex' });
const state = await readRunAtRevision(handle, 'run-a', 0);
await withStateFaultForTest(async (observed) => {
  if (observed === point) {
    if (process.send === undefined) throw new Error('Kill fixture requires an IPC observer');
    await new Promise((resolve, reject) => process.send({ point }, (error) => error ? reject(error) : resolve()));
    process.kill(process.pid, 'SIGKILL');
  }
}, () => compareAndSwapRun(handle, 'run-a', 0, { ...state, revision: 1 }));
throw new Error('Fault point did not terminate the writer');
