import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Artifact, GeneratedPlugin, PluginBuildInput, PluginPackager, ValidationReport } from '@dev-harness-runtime/contracts';
import { createZip } from '../manifests/archive.js';
import { canonicalJson, readPinnedFile, sha256 } from '../manifests/input.js';
import type { StaticSpec } from '../validators/static.js';
import { BuildPipeline } from './pipeline.js';
import { createPlatformRegistry, PlatformRegistry } from './platforms.js';
import { repositoryBuildInput } from './source.js';

const id = 'agent-plugin';
const schema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const skills = ['run', 'status', 'worker'] as const;
const manifest = 'plugin.json';
const json = (value: unknown): Uint8Array => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
const digest = (files: ReadonlyMap<string, Uint8Array>) => [...files]
  .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map(([path, bytes]) => ({ path, sha256: sha256(bytes) }));
const string = { type: 'string', minLength: 1 } as const;

export const agentPluginStaticSpec: StaticSpec = {
  requiredFiles: [manifest, 'README.md', 'DISTRIBUTION_NOTICE.md'],
  allowedFiles: [manifest, 'README.md', 'DISTRIBUTION_NOTICE.md',
    ...skills.map((name) => `skills/${name}/SKILL.md`)],
  skillFiles: skills.map((name) => `skills/${name}/SKILL.md`),
  manifests: [{ path: manifest, schema: { type: 'object', additionalProperties: false,
    required: ['$schema', 'name', 'version', 'description', 'author', 'repository'],
    properties: {
      $schema: { type: 'string', const: schema }, name: { type: 'string', const: 'dev-harness' },
      version: string, description: string, author: { type: 'object', additionalProperties: false,
        required: ['name'], properties: { name: string } }, repository: string,
    } }, versionFields: { version: 'releaseVersion' } }],
};

/** Portable Skills only: no host Executor is registered or bundled. */
export class AgentPluginPackager implements PluginPackager {
  readonly id = id;
  readonly #root: string;
  constructor(root: string) { this.#root = resolve(root); }
  async #files(input: PluginBuildInput): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    files.set(manifest, json({ $schema: schema, name: input.metadata.name,
      version: input.releaseVersion, description: input.metadata.description,
      author: { name: input.metadata.author }, repository: input.metadata.repository }));
    files.set('README.md', Buffer.from('# dev-harness Portable Agent Plugin\n\nInstall this directory with a client that supports Agent Plugins 1.0.0 and confirm its three Skills are discoverable. Install the shared `dhr` CLI separately. This portable package provides Skills only: before a run request, check `dhr doctor --adapter <host-id>` and require a trusted host Executor with enforced authorization. If no such Adapter is available, stop and report `CAPABILITY_MISSING`; do not perform the task in the conversation. The package does not claim automatic Session orchestration. See DISTRIBUTION_NOTICE.md before external distribution.\n'));
    files.set('DISTRIBUTION_NOTICE.md', await readPinnedFile(this.#root, input.metadata.licenseRefs[0]!.path));
    for (const skill of input.skills) files.set(skill.path, await readPinnedFile(this.#root, skill.path));
    return files;
  }
  async generate(input: PluginBuildInput): Promise<GeneratedPlugin> {
    const files = await this.#files(input);
    for (const [path, bytes] of files) {
      const target = resolve(this.#root, '.generated', id, 'plugin', path);
      await mkdir(resolve(target, '..'), { recursive: true });
      await writeFile(target, bytes);
    }
    return { schemaVersion: 1, platform: id, adapterVersion: input.adapterVersion,
      root: `.generated/${id}/plugin`, files: digest(files), inputHash: sha256(canonicalJson(input)) };
  }
  async validate(generated: GeneratedPlugin, input: PluginBuildInput): Promise<ValidationReport> {
    const root = resolve(this.#root, generated.root);
    const checks: ValidationReport['checks'][number][] = [];
    if (generated.files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file.path)).length !== input.skills.length) {
      checks.push({ code: 'SKILL_COUNT', path: manifest,
        message: 'Portable Skill count differs from locked input', severity: 'error' });
    }
    const readme = await readFile(resolve(root, 'README.md'), 'utf8');
    if (!readme.includes('CAPABILITY_MISSING') || !readme.includes('dhr doctor --adapter')) {
      checks.push({ code: 'EXECUTOR_GUARD', path: 'README.md',
        message: 'Portable instructions must require an installed trusted Executor', severity: 'error' });
    }
    if (!checks.length) checks.push({ code: 'PORTABLE_LAYOUT_VALID', path: manifest,
      message: 'Portable manifest, shared Skills and no-Executor guidance agree', severity: 'info' });
    return { schemaVersion: 1, valid: !checks.some((check) => check.severity === 'error'), checks,
      inputHash: sha256(canonicalJson(input)), evidenceRefs: [{ schemaVersion: 1,
        path: `${generated.root}/${manifest}`, sha256: sha256(await readFile(resolve(root, manifest))) }] };
  }
  async pack(generated: GeneratedPlugin, input: PluginBuildInput): Promise<Artifact[]> {
    const files = new Map<string, Uint8Array>();
    for (const file of generated.files) files.set(`dev-harness/${file.path}`,
      await readPinnedFile(this.#root, `${generated.root}/${file.path}`));
    const bytes = createZip(files, input.buildTimestamp);
    const filename = `dev-harness-agent-plugin-v${input.releaseVersion}.zip`;
    await mkdir(resolve(this.#root, 'dist', id), { recursive: true });
    await writeFile(resolve(this.#root, 'dist', id, filename), bytes);
    return [{ schemaVersion: 1, platform: id, variant: 'portable', version: input.releaseVersion,
      coreProtocolVersion: input.coreProtocolVersion, file: `${id}/${filename}`,
      mediaType: 'application/zip', size: bytes.byteLength, sha256: sha256(bytes),
      inputHash: sha256(canonicalJson(input)) }];
  }
}

export async function createAgentPluginBuildPipeline(root: string, protocolCheckout: string): Promise<BuildPipeline> {
  // The contract requires a bundle source for every target. This packaging-only target
  // binds its own compiled packager as that source; it does not claim an Executor Adapter.
  const input = await repositoryBuildInput(root, id, 'package.json',
    'build/dist/targets/agent-plugin.js', protocolCheckout);
  const descriptors = createPlatformRegistry();
  const platforms = new PlatformRegistry();
  for (const entry of descriptors.list()) platforms.register(entry.id === id
    ? { ...entry, packager: new AgentPluginPackager(root) } : entry);
  return new BuildPipeline({ root, platforms, inputs: [input], specifications: { [id]: agentPluginStaticSpec },
    sourceRoots: { [input.protocolSource.repository]: protocolCheckout }, targetVersions: { [id]: 'agent-plugins-1.0.0' } });
}
