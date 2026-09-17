/** Public protocol version and scaffold metadata. */
export const CORE_PROTOCOL_VERSION = 1 as const;
export const PLATFORM_IDS = ['codex', 'dsh', 'cursor', 'opencode', 'antigravity'] as const;
export type PlatformId = typeof PLATFORM_IDS[number];
export interface AdapterDescriptor {
  readonly id: PlatformId;
  readonly implemented: false;
  readonly coreProtocolVersion: typeof CORE_PROTOCOL_VERSION;
}

export * from './common.js';
export * from './execution.js';
export * from './state.js';
export * from './packaging.js';
export * from './interfaces.js';
export * from './validation.js';
export * from './binding.js';
