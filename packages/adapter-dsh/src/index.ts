import { CORE_PROTOCOL_VERSION, type AdapterDescriptor } from '@dev-harness-runtime/contracts';

export { persistDshSessionProposals } from './executor/proposal-evidence.js';
export { runConfinedDshSession, DshConfinedSessionError } from './executor/confined-session.js';
export { createDshRuntimeAdapter, DshRuntimeError } from './runtime-adapter.js';

/** Metadata only: no Executor, Packager or doctor claim. */
export const adapter = Object.freeze({
  id: 'dsh',
  implemented: false,
  coreProtocolVersion: CORE_PROTOCOL_VERSION,
} satisfies AdapterDescriptor);
