import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Artifact, GeneratedPlugin, PluginBuildInput, PluginPackager, ValidationReport } from '@dev-harness-runtime/contracts';
import { createZip } from '../manifests/archive.js';
import { canonicalJson, readPinnedFile, sha256 } from '../manifests/input.js';
import type { StaticSpec } from '../validators/static.js';
import { BuildPipeline } from './pipeline.js';
import { createPlatformRegistry, PlatformRegistry } from './platforms.js';
import { repositoryBuildInput } from './source.js';

const id = 'antigravity';
const schema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const skillNames = ['run', 'status', 'worker'] as const;
const manifest = 'plugin/plugin.json';
const json = (value: unknown): Uint8Array => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
const digest = (files: ReadonlyMap<string, Uint8Array>) => [...files]
  .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map(([path, bytes]) => ({ path, sha256: sha256(bytes) }));
const string = { type: 'string', minLength: 1 } as const;

const launcher = `#!/usr/bin/env node
import { runCli } from '../runtime/dhr.js';
const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (value) => process.stdout.write(value),
    error: (value) => process.stderr.write(value),
  }, { signal: controller.signal });
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
`;

export const antigravityStaticSpec: StaticSpec = {
  requiredFiles: [manifest, 'plugin/README.md', 'plugin/DISTRIBUTION_NOTICE.md',
    'plugin/package.json', 'plugin/scripts/dhr.mjs', 'plugin/runtime/dhr.js',
    'plugin/runtime/adapter.js', 'project-skills/README.md', 'global-skills/README.md',
    ...skillNames.flatMap((name) => [`project-skills/.agents/skills/${name}/SKILL.md`,
      `global-skills/skills/${name}/SKILL.md`])],
  allowedFiles: [manifest, 'plugin/README.md', 'plugin/DISTRIBUTION_NOTICE.md',
    'plugin/package.json', 'plugin/scripts/dhr.mjs', 'plugin/runtime/dhr.js',
    'plugin/runtime/adapter.js', 'project-skills/README.md', 'global-skills/README.md',
    ...skillNames.flatMap((name) => [`plugin/skills/${name}/SKILL.md`,
      `project-skills/.agents/skills/${name}/SKILL.md`, `global-skills/skills/${name}/SKILL.md`])],
  skillFiles: skillNames.map((name) => `plugin/skills/${name}/SKILL.md`),
  lockedBundles: { 'plugin/runtime/dhr.js': 'runtimeBundle',
    'plugin/runtime/adapter.js': 'adapterBundle' },
  manifests: [
    { path: manifest, schema: { type: 'object', additionalProperties: false,
      required: ['$schema', 'name', 'version', 'description', 'author', 'repository'],
      properties: {
        $schema: { type: 'string', const: schema },
        name: { type: 'string', const: 'dev-harness' }, version: string,
        description: string, author: { type: 'object', additionalProperties: false,
          required: ['name'], properties: { name: string } }, repository: string,
      } }, versionFields: { version: 'releaseVersion' } },
    { path: 'plugin/package.json', schema: { type: 'object', additionalProperties: false,
      required: ['name', 'version', 'private', 'type'], properties: {
        name: { type: 'string', const: 'dev-harness' }, version: string,
        private: { type: 'boolean', const: true }, type: { type: 'string', const: 'module' },
      } }, versionFields: { version: 'releaseVersion' } },
  ],
};

export class AntigravityPackager implements PluginPackager {
  readonly id = id;
  readonly #root: string;
  constructor(root: string) { this.#root = resolve(root); }
  async #files(input: PluginBuildInput): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    files.set(manifest, json({ $schema: schema, name: input.metadata.name,
      version: input.releaseVersion, description: input.metadata.description,
      author: { name: input.metadata.author }, repository: input.metadata.repository }));
    files.set('plugin/package.json', json({ name: input.metadata.name,
      version: input.releaseVersion, private: true, type: 'module' }));
    files.set('plugin/scripts/dhr.mjs', Buffer.from(launcher));
    files.set('plugin/runtime/dhr.js', await readPinnedFile(this.#root, input.runtimeBundle.path));
    files.set('plugin/runtime/adapter.js', await readPinnedFile(this.#root, input.adapterBundle.path));
    files.set('plugin/README.md', Buffer.from('# dev-harness Antigravity Agent Plugin\n\nUnpack the plugin ZIP, then run `agy plugin install <unpacked-plugin-directory>`. Use `agy plugin list` to confirm the three Skills and `agy plugin uninstall dev-harness` to remove it. The bundled CLI is `node scripts/dhr.mjs`. This plugin does not enable automatic Task execution without a proven Executor. For standalone Skills, use the separate project or global ZIP, not both alongside the plugin. See DISTRIBUTION_NOTICE.md before external distribution.\n'));
    files.set('plugin/DISTRIBUTION_NOTICE.md', await readPinnedFile(this.#root, input.metadata.licenseRefs[0]!.path));
    files.set('project-skills/README.md', Buffer.from('# Antigravity project Skills\n\nExtract `.agents/skills/` into the chosen project. These are standalone Skills, not an automatically enabled Runtime Executor.\n'));
    files.set('global-skills/README.md', Buffer.from('# Antigravity global Skills\n\nCopy the `skills/` contents to the Antigravity global Skills directory only when explicitly selected by the user. These are standalone Skills, not an automatically enabled Runtime Executor.\n'));
    for (const skill of input.skills) {
      const bytes = await readPinnedFile(this.#root, skill.path);
      files.set(`plugin/${skill.path}`, bytes);
      files.set(`project-skills/.agents/${skill.path}`, bytes);
      files.set(`global-skills/${skill.path}`, bytes);
    }
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
    for (const skill of input.skills) {
      const plugin = await readFile(resolve(root, 'plugin', skill.path));
      const project = await readFile(resolve(root, 'project-skills/.agents', skill.path));
      const global = await readFile(resolve(root, 'global-skills', skill.path));
      if (!plugin.equals(project) || !plugin.equals(global)) checks.push({
        code: 'ANTIGRAVITY_SKILL_MISMATCH', path: `plugin/${skill.path}`,
        message: 'Plugin, project and global Skill copies differ', severity: 'error',
      });
    }
    if (!checks.length) checks.push({ code: 'ANTIGRAVITY_LAYOUT_VALID', path: manifest,
      message: 'Portable manifest and three identical Skill variants agree', severity: 'info' });
    return { schemaVersion: 1, valid: !checks.some((check) => check.severity === 'error'), checks,
      inputHash: sha256(canonicalJson(input)), evidenceRefs: [{ schemaVersion: 1,
        path: `${generated.root}/${manifest}`, sha256: sha256(await readFile(resolve(root, manifest))) }] };
  }
  async pack(generated: GeneratedPlugin, input: PluginBuildInput): Promise<Artifact[]> {
    const variants = [
      { prefix: 'plugin/', variant: 'agent-plugin', name: `dev-harness-antigravity-v${input.releaseVersion}.zip` },
      { prefix: 'project-skills/', variant: 'project-skills', name: `dev-harness-antigravity-project-skills-v${input.releaseVersion}.zip` },
      { prefix: 'global-skills/', variant: 'global-skills', name: `dev-harness-antigravity-global-skills-v${input.releaseVersion}.zip` },
    ];
    await mkdir(resolve(this.#root, 'dist', id), { recursive: true });
    const artifacts: Artifact[] = [];
    for (const value of variants) {
      const files = new Map<string, Uint8Array>();
      for (const file of generated.files.filter((entry) => entry.path.startsWith(value.prefix))) {
        const path = file.path.slice(value.prefix.length);
        const archivePath = value.variant === 'agent-plugin' ? `dev-harness/${path}` : path;
        files.set(archivePath, await readPinnedFile(this.#root, `${generated.root}/${file.path}`));
      }
      const bytes = createZip(files, input.buildTimestamp);
      await writeFile(resolve(this.#root, 'dist', id, value.name), bytes);
      artifacts.push({ schemaVersion: 1, platform: id, variant: value.variant,
        version: input.releaseVersion, coreProtocolVersion: input.coreProtocolVersion,
        file: `${id}/${value.name}`, mediaType: 'application/zip', size: bytes.byteLength,
        sha256: sha256(bytes), inputHash: sha256(canonicalJson(input)) });
    }
    return artifacts;
  }
}

export async function createAntigravityBuildPipeline(root: string, protocolCheckout: string): Promise<BuildPipeline> {
  const input = await repositoryBuildInput(root, id, 'packages/adapter-antigravity/package.json',
    'packages/adapter-antigravity/dist/index.js', protocolCheckout);
  const descriptors = createPlatformRegistry();
  const platforms = new PlatformRegistry();
  for (const entry of descriptors.list()) platforms.register(entry.id === id
    ? { ...entry, packager: new AntigravityPackager(root) } : entry);
  return new BuildPipeline({ root, platforms, inputs: [input], specifications: { [id]: antigravityStaticSpec },
    sourceRoots: { [input.protocolSource.repository]: protocolCheckout }, targetVersions: { [id]: 'agent-plugins-1.0.0' } });
}
