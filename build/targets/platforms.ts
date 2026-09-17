import type { PluginPackager } from '@dev-harness-runtime/contracts';
import { Registry, type RuntimeAdapter } from '@dev-harness-runtime/core';
import { adapter as codex } from '@dev-harness-runtime/adapter-codex';
import { adapter as dsh } from '@dev-harness-runtime/adapter-dsh';
import { adapter as cursor } from '@dev-harness-runtime/adapter-cursor';
import { adapter as opencode } from '@dev-harness-runtime/adapter-opencode';
import { adapter as antigravity } from '@dev-harness-runtime/adapter-antigravity';
import { BuildRegistry } from './registry.js';

export interface PlatformRegistration {
  readonly id: string;
  readonly runtime?: RuntimeAdapter;
  readonly packager?: PluginPackager;
}

/** One explicit authority for both execution and packaging capabilities. */
export class PlatformRegistry extends BuildRegistry<PlatformRegistration> {
  override register(entry: PlatformRegistration): void {
    if ((entry.runtime !== undefined && entry.runtime.id !== entry.id)
      || (entry.packager !== undefined && entry.packager.id !== entry.id)) {
      throw new TypeError('Platform capabilities must use the registered platform ID.');
    }
    super.register(entry);
  }

  runtimeRegistry(): Registry<RuntimeAdapter> {
    const registry = new Registry<RuntimeAdapter>('Platform runtime registry');
    for (const entry of this.list()) if (entry.runtime !== undefined) registry.register(entry.runtime);
    return registry;
  }
}

/** Descriptors establish known IDs only; executable capabilities require trusted injection. */
export function createPlatformRegistry(runtimes: readonly RuntimeAdapter[] = []): PlatformRegistry {
  const supplied = new Registry<RuntimeAdapter>('Injected runtime registry');
  for (const runtime of runtimes) supplied.register(runtime);
  const registry = new PlatformRegistry();
  const descriptors = [codex, dsh, cursor, opencode, antigravity, { id: 'agent-plugin' }];
  for (const descriptor of descriptors) {
    const runtime = runtimes.find((entry) => entry.id === descriptor.id);
    registry.register({ id: descriptor.id, ...(runtime === undefined ? {} : { runtime }) });
  }
  for (const runtime of runtimes) {
    if (!descriptors.some((descriptor) => descriptor.id === runtime.id)) registry.register({ id: runtime.id, runtime });
  }
  return registry;
}
