import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXECUTOR_CONTRACT_SCENARIOS, defineExecutorContractTests,
} from './executor-contract.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../packages/contracts/fixtures/execution/${name}.json`, import.meta.url), 'utf8'));

/** Synthetic fixture harness only; no host, session, process or permission claims. */
function createFakeHarness(scenario) {
  assert.ok(EXECUTOR_CONTRACT_SCENARIOS.includes(scenario));
  const request = fixture('request');
  let stopped = true;
  let acknowledgeStart;
  const started = new Promise((resolve) => { acknowledgeStart = resolve; });
  let activeAbort;
  const executor = {
    id: 'fake',
    async probe(environment) {
      assert.equal(environment.targetVersion, 'fixture-interface-only');
      return fixture('capabilities');
    },
    async execute(receivedRequest, signal) {
      assert.deepEqual(receivedRequest, request);
      assert.ok(signal instanceof AbortSignal);
      if (scenario === 'cancel') {
        return new Promise((resolve, reject) => {
          void resolve;
          stopped = false;
          const abort = () => {
            signal.removeEventListener('abort', abort);
            // The fake has no child process: this flag is its full activity state.
            stopped = true;
            activeAbort = undefined;
            const error = new Error('Synthetic execution cancelled after stopping');
            error.name = 'AbortError';
            reject(error);
          };
          activeAbort = abort;
          signal.addEventListener('abort', abort, { once: true });
          acknowledgeStart();
          if (signal.aborted) abort();
        });
      }
      if (scenario === 'missing-result') return undefined;
      const outcome = ['completed', 'blocked', 'failed', 'partial'].includes(scenario) ? scenario : 'completed';
      const result = fixture(`result-${outcome}`);
      if (scenario === 'invalid-result') result.attempt += 1;
      if (scenario === 'authorization-violation') result.commitSha = 'c'.repeat(40);
      return result;
    },
  };
  return {
    executor, request, started, isStopped: () => stopped,
    expectedSnapshot: 'a'.repeat(64), actualSnapshot: 'b'.repeat(64),
    environment: {
      schemaVersion: 1, repoRoot: request.repoRoot, privateGitDir: `${request.repoRoot}/.git`,
      os: 'linux', architecture: 'x64', nodeVersion: '24.15.0', gitVersion: '2.43.0',
      hostExecutable: null, targetVersion: 'fixture-interface-only', configHash: 'a'.repeat(64),
    },
    cleanup() {
      activeAbort?.();
      assert.equal(stopped, true);
    },
  };
}

defineExecutorContractTests('fake executor (interface fixtures only)', createFakeHarness);
