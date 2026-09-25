import { CORE_PROTOCOL_VERSION, type AdapterDescriptor } from '@dev-harness-runtime/contracts';

export { persistDshSessionProposals } from './executor/proposal-evidence.js';
export { runConfinedDshSession, DshConfinedSessionError } from './executor/confined-session.js';
export { createDshRuntimeAdapter, DshRuntimeError } from './runtime-adapter.js';
export { createPackagedDshServices, loadDshPackageSource } from './runtime-services.js';

/** Registry metadata only; executable capability is established by the packaged service probe. */
export const adapter = Object.freeze({
  id: 'dsh',
  implemented: false,
  coreProtocolVersion: CORE_PROTOCOL_VERSION,
} satisfies AdapterDescriptor);
