import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Artifact, GeneratedPlugin, PluginBuildInput, PluginPackager, ValidationReport } from '@dev-harness-runtime/contracts';
import { createZip } from '../manifests/archive.js';
import { canonicalJson, readPinnedFile, sha256 } from '../manifests/input.js';
import type { StaticSpec } from '../validators/static.js';
import { BuildPipeline } from './pipeline.js';
import { createPlatformRegistry, PlatformRegistry } from './platforms.js';
import { repositoryBuildInput } from './source.js';

const id = 'codex';
const plugin = 'plugins/dev-harness';
const manifest = `${plugin}/.codex-plugin/plugin.json`;
const packageManifest = `${plugin}/package.json`;
const catalog = '.agents/plugins/marketplace.json';
const skills = ['run', 'status', 'worker'] as const;
const json = (value: unknown): Uint8Array => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
const digest = (files: ReadonlyMap<string, Uint8Array>) => [...files]
  .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map(([path, bytes]) => ({ path, sha256: sha256(bytes) }));

const string = { type: 'string', minLength: 1 } as const;
export const codexStaticSpec: StaticSpec = {
  requiredFiles: [catalog, manifest, packageManifest, `${plugin}/README.md`, `${plugin}/scripts/dhr.mjs`,
    `${plugin}/runtime/dhr.js`, `${plugin}/runtime/adapter.js`, `${plugin}/DISTRIBUTION_NOTICE.md`],
  allowedFiles: [catalog, manifest, packageManifest, `${plugin}/README.md`, `${plugin}/scripts/dhr.mjs`,
    `${plugin}/runtime/dhr.js`, `${plugin}/runtime/adapter.js`, `${plugin}/DISTRIBUTION_NOTICE.md`,
    ...skills.map((name) => `${plugin}/skills/${name}/SKILL.md`)],
  skillFiles: skills.map((name) => `${plugin}/skills/${name}/SKILL.md`),
  lockedBundles: { [`${plugin}/runtime/dhr.js`]: 'runtimeBundle', [`${plugin}/runtime/adapter.js`]: 'adapterBundle' },
  manifests: [
    { path: packageManifest, schema: { type: 'object', additionalProperties: false,
      required: ['name', 'version', 'type', 'private'], properties: {
        name: { type: 'string', const: 'dev-harness' }, version: string,
        type: { type: 'string', const: 'module' }, private: { type: 'boolean', const: true },
      } }, versionFields: { version: 'releaseVersion' } },
    { path: manifest, schema: { type: 'object', additionalProperties: false,
      required: ['name', 'version', 'description', 'author', 'skills', 'interface'],
      properties: {
        name: { const: 'dev-harness', ...string }, version: string, description: string,
        author: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: string } },
        skills: { const: './skills', ...string },
        interface: { type: 'object', additionalProperties: false,
          required: ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities', 'defaultPrompt'],
          properties: { displayName: string, shortDescription: string, longDescription: string,
            developerName: string, category: { const: 'Productivity', ...string },
            capabilities: { type: 'array', items: string }, defaultPrompt: { type: 'array', minItems: 1, items: string } } },
      } }, versionFields: { version: 'releaseVersion' } },
    { path: catalog, schema: { type: 'object', additionalProperties: false,
      required: ['name', 'interface', 'plugins'], properties: {
        name: { const: 'dev-harness-local', ...string },
        interface: { type: 'object', additionalProperties: false, required: ['displayName'], properties: { displayName: string } },
        plugins: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'object', additionalProperties: false,
          required: ['name', 'source', 'policy', 'category'], properties: {
            name: { const: 'dev-harness', ...string },
            source: { type: 'object', additionalProperties: false, required: ['source', 'path'], properties: {
              source: { type: 'string', const: 'local' }, path: { type: 'string', const: './plugins/dev-harness' } } },
            policy: { type: 'object', additionalProperties: false, required: ['installation', 'authentication'], properties: {
              installation: { type: 'string', const: 'AVAILABLE' }, authentication: { type: 'string', const: 'ON_INSTALL' } } },
            category: { type: 'string', const: 'Productivity' },
          } } },
      } } },
  ],
};

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

/** Compatibility-profile Codex package and repo-local marketplace, with no host capability claim. */
export class CodexPackager implements PluginPackager {
  readonly id = id;
  readonly #root: string;
  constructor(root: string) { this.#root = resolve(root); }
  async #files(input: PluginBuildInput): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    files.set(catalog, json({ name: 'dev-harness-local', interface: { displayName: 'Dev Harness Local' },
      plugins: [{ name: input.metadata.name, source: { source: 'local', path: './plugins/dev-harness' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }));
    files.set(manifest, json({ name: input.metadata.name, version: input.releaseVersion,
      description: input.metadata.description, author: { name: input.metadata.author }, skills: './skills',
      interface: { displayName: input.metadata.displayName, shortDescription: input.metadata.description,
        longDescription: 'Run planning tasks with the shared dev-harness-runtime Core.',
        developerName: input.metadata.author, category: 'Productivity', capabilities: [],
        defaultPrompt: ['Show the current dhr Run status.'] } }));
    files.set(packageManifest, json({ name: input.metadata.name, version: input.releaseVersion, type: 'module', private: true }));
    files.set(`${plugin}/README.md`, Buffer.from(`# Dev Harness Codex plugin\n\nLocal installation: add the extracted marketplace directory with \`codex plugin marketplace add ./marketplace\`, then install \`dev-harness@dev-harness-local\`. The command wrapper is \`node scripts/dhr.mjs\` from this plugin directory. Run execution requires a probed host Executor; package installation alone does not enable it.\n\nThis is a local build. See DISTRIBUTION_NOTICE.md before any external distribution.\n`));
    files.set(`${plugin}/scripts/dhr.mjs`, Buffer.from(launcher));
    files.set(`${plugin}/runtime/dhr.js`, await readPinnedFile(this.#root, input.runtimeBundle.path));
    files.set(`${plugin}/runtime/adapter.js`, await readPinnedFile(this.#root, input.adapterBundle.path));
    files.set(`${plugin}/DISTRIBUTION_NOTICE.md`, await readPinnedFile(this.#root, input.metadata.licenseRefs[0]!.path));
    for (const skill of input.skills) files.set(`${plugin}/${skill.path}`, await readPinnedFile(this.#root, skill.path));
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
    const values = JSON.parse(await readFile(resolve(root, manifest), 'utf8')) as { name?: string; skills?: string };
    const marketplace = JSON.parse(await readFile(resolve(root, catalog), 'utf8')) as { plugins?: { name?: string; source?: { path?: string } }[] };
    const checks: ValidationReport['checks'][number][] = [];
    const add = (code: string, path: string, message: string) => checks.push({ code, path, message, severity: 'error' });
    if (values.name !== input.metadata.name || values.skills !== './skills') add('PLUGIN_IDENTITY', manifest, 'Plugin identity or skill directory differs from shared metadata');
    if (marketplace.plugins?.length !== 1 || marketplace.plugins[0]?.name !== values.name
      || marketplace.plugins[0]?.source?.path !== './plugins/dev-harness') add('MARKETPLACE_SOURCE', catalog, 'Marketplace source does not identify the bundled plugin');
    const actual = generated.files.filter((file) => /^plugins\/dev-harness\/skills\/[^/]+\/SKILL\.md$/u.test(file.path));
    if (actual.length !== input.skills.length) add('SKILL_COUNT', manifest, 'Generated Skill count differs from locked input');
    if (!checks.length) checks.push({ code: 'CODEX_LAYOUT_VALID', path: manifest,
      message: 'Codex compatibility manifest, marketplace reference and Skill count agree', severity: 'info' });
    return { schemaVersion: 1, valid: !checks.some((check) => check.severity === 'error'), checks,
      inputHash: sha256(canonicalJson(input)),
      evidenceRefs: [{ schemaVersion: 1, path: `${generated.root}/${manifest}`,
        sha256: sha256(await readFile(resolve(root, manifest))) }] };
  }
  async pack(generated: GeneratedPlugin, input: PluginBuildInput): Promise<Artifact[]> {
    const files = new Map<string, Uint8Array>();
    for (const file of generated.files) files.set(`marketplace/${file.path}`,
      await readPinnedFile(this.#root, `${generated.root}/${file.path}`));
    const bytes = createZip(files, input.buildTimestamp);
    const filename = `dev-harness-codex-v${input.releaseVersion}.zip`;
    await mkdir(resolve(this.#root, 'dist', id), { recursive: true });
    await writeFile(resolve(this.#root, 'dist', id, filename), bytes);
    return [{ schemaVersion: 1, platform: id, variant: 'marketplace', version: input.releaseVersion,
      coreProtocolVersion: input.coreProtocolVersion, file: `${id}/${filename}`,
      mediaType: 'application/zip', size: bytes.byteLength, sha256: sha256(bytes),
      inputHash: sha256(canonicalJson(input)) }];
  }
}

/** Explicit repository entry point; the caller must provide the pinned protocol checkout. */
export async function createCodexBuildPipeline(root: string, protocolCheckout: string): Promise<BuildPipeline> {
  const input = await repositoryBuildInput(root, id, 'packages/adapter-codex/package.json',
    'packages/adapter-codex/dist/index.js', protocolCheckout);
  const platforms = createPlatformRegistry();
  const existing = platforms.get(id);
  // Registry entries are immutable; replace the metadata-only descriptor in a new registry.
  const registered = createPlatformRegistryWithCodex(platforms, { ...existing, packager: new CodexPackager(root) });
  return new BuildPipeline({ root, platforms: registered, inputs: [input], specifications: { [id]: codexStaticSpec },
    sourceRoots: { [input.protocolSource.repository]: protocolCheckout }, targetVersions: { [id]: 'codex-compat-0.154.0' } });
}

function createPlatformRegistryWithCodex(platforms: ReturnType<typeof createPlatformRegistry>, codex: { id: string; packager: PluginPackager }) {
  const registry = new PlatformRegistry();
  for (const entry of platforms.list()) registry.register(entry.id === id ? codex : entry);
  return registry;
}
