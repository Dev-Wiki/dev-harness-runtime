import { BuildPipeline } from './pipeline.js';
import { createPlatformRegistry, PlatformRegistry } from './platforms.js';
import { repositoryBuildInput } from './source.js';
import { CodexPackager, codexStaticSpec } from './codex.js';
import { DshPackager, dshStaticSpec } from './dsh.js';
import { CursorPackager, cursorStaticSpec } from './cursor.js';
import { OpenCodePackager, opencodeStaticSpec } from './opencode.js';
import { AntigravityPackager, antigravityStaticSpec } from './antigravity.js';
import { AgentPluginPackager, agentPluginStaticSpec } from './agent-plugin.js';

export const distributionPlatforms = Object.freeze([
  'codex', 'dsh', 'cursor', 'opencode', 'antigravity', 'agent-plugin',
] as const);
export type DistributionPlatform = typeof distributionPlatforms[number];

/** Build-only registrations from trusted compiled code; no RuntimeAdapter is enabled. */
export async function createRepositoryBuildPipeline(root: string, protocolCheckout: string): Promise<BuildPipeline> {
  const definitions = [
    { id: 'codex', manifest: 'packages/adapter-codex/package.json', bundle: 'packages/adapter-codex/dist/index.js',
      packager: new CodexPackager(root), spec: codexStaticSpec, targetVersion: 'codex-compat-0.154.0' },
    { id: 'dsh', manifest: 'packages/adapter-dsh/package.json', bundle: 'packages/adapter-dsh/dist/plugin.js',
      packager: new DshPackager(root), spec: dshStaticSpec, targetVersion: 'dsh-0.1.5-rc.1' },
    { id: 'cursor', manifest: 'packages/adapter-cursor/package.json', bundle: 'packages/adapter-cursor/dist/index.js',
      packager: new CursorPackager(root), spec: cursorStaticSpec, targetVersion: 'cursor-native-2026.06.26' },
    { id: 'opencode', manifest: 'packages/adapter-opencode/package.json', bundle: 'packages/adapter-opencode/dist/index.js',
      packager: new OpenCodePackager(root), spec: opencodeStaticSpec, targetVersion: 'opencode-plugin-current' },
    { id: 'antigravity', manifest: 'packages/adapter-antigravity/package.json', bundle: 'packages/adapter-antigravity/dist/index.js',
      packager: new AntigravityPackager(root), spec: antigravityStaticSpec, targetVersion: 'agent-plugins-1.0.0' },
    { id: 'agent-plugin', manifest: 'package.json', bundle: 'build/dist/targets/agent-plugin.js',
      packager: new AgentPluginPackager(root), spec: agentPluginStaticSpec, targetVersion: 'agent-plugins-1.0.0' },
  ] as const;
  const inputs = await Promise.all(definitions.map((entry) => repositoryBuildInput(root, entry.id,
    entry.manifest, entry.bundle, protocolCheckout)));
  const descriptors = createPlatformRegistry();
  const platforms = new PlatformRegistry();
  for (const descriptor of descriptors.list()) {
    const entry = definitions.find((candidate) => candidate.id === descriptor.id);
    platforms.register(entry === undefined ? descriptor : { ...descriptor, packager: entry.packager });
  }
  return new BuildPipeline({ root, platforms, inputs,
    specifications: Object.fromEntries(definitions.map((entry) => [entry.id, entry.spec])),
    sourceRoots: { [inputs[0]!.protocolSource.repository]: protocolCheckout },
    targetVersions: Object.fromEntries(definitions.map((entry) => [entry.id, entry.targetVersion])) });
}
