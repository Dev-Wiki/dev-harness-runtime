import { acquireLock, releaseLock } from '../../dist/lock/index.js';

const project = JSON.parse(process.argv[2]);
let handle;
process.on('message', async (message) => {
  if (message === 'acquire') {
    try {
      handle = await acquireLock(project, { runId: `run-${process.pid}`, adapter: 'codex' });
      process.send({ status: 'acquired' });
    } catch (error) {
      process.send({ status: 'rejected', code: error.code });
    }
  }
  if (message === 'release') {
    try {
      if (handle) await releaseLock(handle);
      process.send({ status: 'released' });
      process.disconnect();
    } catch (error) {
      process.send({ status: 'release-error', code: error.code });
      process.disconnect();
    }
  }
});
process.send({ status: 'ready' });
