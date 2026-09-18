import { CORE_PROTOCOL_VERSION, type AdapterDescriptor } from '@dev-harness-runtime/contracts';
export { CodexEventDecoder, CodexEventError } from './executor/events.js';
export { handleCodexProposalMcp } from './executor/mcp-server.js';
export { runCodexSession } from './executor/session.js';
export { createConfinedCodexBridge } from './executor/confined-bridge.js';
export { runConfinedCodexProcess } from './executor/confined-process.js';
export { persistCodexSessionProposals } from './executor/proposal-evidence.js';
export { createCodexRuntimeAdapter, CodexRuntimeError } from './runtime-adapter.js';
export type { CodexRuntimeOptions } from './runtime-adapter.js';
export { createPackagedCodexServices, loadCodexPackageSource } from './runtime-services.js';
export type { CodexPackageSource, PackagedCodexOptions } from './runtime-services.js';

/** Descriptor metadata only; the RuntimeAdapter above requires explicit trusted injection. */
export const adapter = Object.freeze({
  id: 'codex',
  implemented: false,
  coreProtocolVersion: CORE_PROTOCOL_VERSION,
} satisfies AdapterDescriptor);
