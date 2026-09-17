import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractValidationError, assertSnapshotHash, parseContract,
  requireExecutionCapabilities, validateResultForRequest,
} from '../../packages/contracts/dist/index.js';

export const EXECUTOR_CONTRACT_SCENARIOS = Object.freeze([
  'completed', 'blocked', 'failed', 'partial', 'cancel',
  'invalid-result', 'missing-result', 'drift', 'authorization-violation',
]);

/**
 * Registers reusable interface tests with an explicitly supplied scenario harness.
 * This factory does not inject faults into arbitrary hosts or certify isolation.
 *
 * createHarness(scenario) returns { executor, request, environment?, cleanup? }.
 * A cancellation harness also provides started (a Promise) and isStopped().
 * A drift harness provides expectedSnapshot and actualSnapshot (digest strings).
 * The harness owns scenario setup, observation and cleanup; real host adapters
 * require their own evidence that a stopped worker has no writable descendants.
 */
export function defineExecutorContractTests(name, createHarness) {
  for (const scenario of EXECUTOR_CONTRACT_SCENARIOS) {
    test(`${name}: ${scenario}`, { timeout: 30_000 }, async (t) => {
      const harness = await createHarness(scenario);
      const controller = new AbortController();
      t.after(async () => {
        controller.abort();
        await harness.cleanup?.();
      });
      const request = parseContract('taskExecutionRequest', harness.request);
      assert.equal(typeof harness.executor.id, 'string');
      assert.equal(typeof harness.executor.execute, 'function');
      assert.equal(typeof harness.executor.probe, 'function');
      if (harness.environment !== undefined) {
        const environment = parseContract('hostEnvironment', harness.environment);
        const capabilities = parseContract('executorCapabilities', await harness.executor.probe(environment));
        assert.equal(capabilities.adapterId, harness.executor.id);
        requireExecutionCapabilities(capabilities);
      }

      if (scenario === 'cancel') {
        assert.equal(typeof harness.started?.then, 'function', 'Cancellation harness must expose its start observation');
        assert.equal(typeof harness.isStopped, 'function', 'Cancellation harness must expose its stop observation');
        const execution = harness.executor.execute(request, controller.signal);
        // Attach the rejection observer before requesting cancellation.
        const rejected = assert.rejects(execution, asyncErrorName('AbortError'));
        await harness.started;
        assert.equal(await harness.isStopped(), false);
        controller.abort();
        await rejected;
        assert.equal(await harness.isStopped(), true, 'AbortError must follow worker shutdown');
        return;
      }

      const executeAndValidate = async () => validateResultForRequest(
        request, await harness.executor.execute(request, controller.signal),
      );
      if (scenario === 'invalid-result' || scenario === 'missing-result' || scenario === 'authorization-violation') {
        const code = scenario === 'authorization-violation' ? 'AUTHORIZATION_VIOLATION' : 'INVALID_RESULT';
        await assert.rejects(executeAndValidate, (error) => error instanceof ContractValidationError && error.code === code);
        return;
      }
      const result = await executeAndValidate();
      if (scenario === 'drift') {
        assert.equal(result.outcome, 'completed');
        assert.match(harness.expectedSnapshot, /^[a-f0-9]{64}$/u);
        assert.match(harness.actualSnapshot, /^[a-f0-9]{64}$/u);
        assert.throws(() => assertSnapshotHash(harness.expectedSnapshot, harness.actualSnapshot),
          (error) => error instanceof ContractValidationError && error.code === 'DRIFT_DETECTED');
      } else {
        assert.equal(result.outcome, scenario);
      }
    });
  }
}

function asyncErrorName(name) {
  return (error) => error instanceof Error && error.name === name;
}
