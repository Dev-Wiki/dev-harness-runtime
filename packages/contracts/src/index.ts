/** V0 metadata only. Execution/state schemas belong to K1. */
export const CORE_PROTOCOL_VERSION = 1 as const;
export const PLATFORM_IDS = ['codex', 'dsh', 'cursor', 'opencode', 'antigravity'] as const;
export type PlatformId = typeof PLATFORM_IDS[number];
export interface AdapterDescriptor {
  readonly id: PlatformId;
  readonly implemented: false;
  readonly coreProtocolVersion: typeof CORE_PROTOCOL_VERSION;
}
