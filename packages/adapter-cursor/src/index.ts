import { CORE_PROTOCOL_VERSION, type AdapterDescriptor } from '@dev-harness-runtime/contracts';

/** Metadata only: no Executor, Packager or doctor claim. */
export const adapter = Object.freeze({
  id: 'cursor',
  implemented: false,
  coreProtocolVersion: CORE_PROTOCOL_VERSION,
} satisfies AdapterDescriptor);
