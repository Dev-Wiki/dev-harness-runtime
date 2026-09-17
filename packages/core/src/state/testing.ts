// Internal test seam, intentionally absent from the state and package exports.
// No environment variable, persisted field or Worker request can enable faults.
import { AsyncLocalStorage } from 'node:async_hooks';

export type StateWritePoint = 'half-written' | 'file-synced' | 'linked' | 'published' | 'directory-synced';
const faults = new AsyncLocalStorage<(point: StateWritePoint, path: string) => void | Promise<void>>();

export async function stateWritePoint(point: StateWritePoint, path: string): Promise<void> {
  await faults.getStore()?.(point, path);
}

export function withStateFaultForTest<T>(inject: (point: StateWritePoint, path: string) => void | Promise<void>, work: () => Promise<T>): Promise<T> {
  if (process.env.DEV_HARNESS_WORKER === '1') throw new Error('Worker cannot install state fault injection');
  return faults.run(inject, work);
}
