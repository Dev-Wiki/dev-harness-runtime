import { CORE_PROTOCOL_VERSION, type AdapterDescriptor } from '@dev-harness-runtime/contracts';
export { CodexEventDecoder, CodexEventError } from './executor/events.js';

/** Metadata only: no Executor, Packager or doctor claim. */
export const adapter = Object.freeze({
  id: 'codex',
  implemented: false,
  coreProtocolVersion: CORE_PROTOCOL_VERSION,
} satisfies AdapterDescriptor);
