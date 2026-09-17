import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Artifact, GeneratedPlugin, PluginBuildInput, PluginPackager, ValidationReport } from '@dev-harness-runtime/contracts';
import { createTarGzip, createZip } from '../manifests/archive.js';
import { canonicalJson, readPinnedFile, sha256 } from '../manifests/input.js';
import type { StaticSpec } from '../validators/static.js';
import { BuildPipeline } from './pipeline.js';
import { createPlatformRegistry, PlatformRegistry } from './platforms.js';
import { repositoryBuildInput } from './source.js';

const id = 'opencode';
const skillNames = ['run', 'status', 'worker'] as const;
const npmRoot = 'npm';
const localRoot = 'local';
const npmManifest = `${npmRoot}/package.json`;
const npmEntry = `${npmRoot}/dist/index.js`;
const localEntry = `${localRoot}/.opencode/plugins/dev-harness.js`;
const string = { type: 'string', minLength: 1 } as const;
const json = (value: unknown): Uint8Array => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
const digest = (files: ReadonlyMap<string, Uint8Array>) => [...files]
  .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map(([path, bytes]) => ({ path, sha256: sha256(bytes) }));

const plugin = `/** OpenCode loads this named export at startup. Execution remains in shared dhr Core. */
export const DevHarnessPlugin = async () => ({});
`;
const launcher = `#!/usr/bin/env node
import { runCli } from './dhr.js';
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

export const opencodeStaticSpec: StaticSpec = {
  requiredFiles: [npmManifest, npmEntry, `${npmRoot}/dist/dhr.js`, `${npmRoot}/dist/adapter.js`,
    `${npmRoot}/dist/cli.mjs`, `${npmRoot}/README.md`, `${npmRoot}/DISTRIBUTION_NOTICE.md`,
    localEntry, `${localRoot}/.opencode/runtime/dhr.js`, `${localRoot}/.opencode/runtime/adapter.js`,
    `${localRoot}/.opencode/runtime/cli.mjs`, `${localRoot}/README.md`, `${localRoot}/DISTRIBUTION_NOTICE.md`],
  allowedFiles: [npmManifest, npmEntry, `${npmRoot}/dist/dhr.js`, `${npmRoot}/dist/adapter.js`,
    `${npmRoot}/dist/cli.mjs`, `${npmRoot}/README.md`, `${npmRoot}/DISTRIBUTION_NOTICE.md`,
    localEntry, `${localRoot}/.opencode/runtime/dhr.js`, `${localRoot}/.opencode/runtime/adapter.js`,
    `${localRoot}/.opencode/runtime/cli.mjs`, `${localRoot}/README.md`, `${localRoot}/DISTRIBUTION_NOTICE.md`,
    ...skillNames.flatMap((name) => [`${npmRoot}/skills/${name}/SKILL.md`,
      `${localRoot}/.opencode/skills/${name}/SKILL.md`])],
  // The local set is the authoritative frontmatter set; npm copies are checked byte-for-byte below.
  skillFiles: skillNames.map((name) => `${localRoot}/.opencode/skills/${name}/SKILL.md`),
  lockedBundles: { [`${npmRoot}/dist/dhr.js`]: 'runtimeBundle',
    [`${npmRoot}/dist/adapter.js`]: 'adapterBundle',
    [`${localRoot}/.opencode/runtime/dhr.js`]: 'runtimeBundle',
    [`${localRoot}/.opencode/runtime/adapter.js`]: 'adapterBundle' },
  manifests: [{ path: npmManifest, schema: { type: 'object', additionalProperties: false,
    required: ['name', 'version', 'private', 'type', 'main', 'exports', 'files'],
    properties: {
      name: { type: 'string', const: 'dev-harness-opencode' }, version: string,
      private: { type: 'boolean', const: false }, type: { type: 'string', const: 'module' },
      main: { type: 'string', const: './dist/index.js' },
      exports: { type: 'object', additionalProperties: false, required: ['.'],
        properties: { '.': { type: 'string', const: './dist/index.js' } } },
      files: { type: 'array', const: ['dist', 'skills', 'README.md', 'DISTRIBUTION_NOTICE.md'], items: string },
    } }, versionFields: { version: 'releaseVersion' } }],
};

/** npm and project-local OpenCode formats share one generated, locked input. */
export class OpenCodePackager implements PluginPackager {
  readonly id = id;
  readonly #root: string;
  constructor(root: string) { this.#root = resolve(root); }
  async #files(input: PluginBuildInput): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    files.set(npmManifest, json({ name: 'dev-harness-opencode', version: input.releaseVersion,
      private: false, type: 'module', main: './dist/index.js', exports: { '.': './dist/index.js' },
      files: ['dist', 'skills', 'README.md', 'DISTRIBUTION_NOTICE.md'] }));
    files.set(npmEntry, Buffer.from(plugin));
    files.set(localEntry, Buffer.from(plugin));
    files.set(`${npmRoot}/dist/cli.mjs`, Buffer.from(launcher));
    files.set(`${localRoot}/.opencode/runtime/cli.mjs`, Buffer.from(launcher));
    const runtime = await readPinnedFile(this.#root, input.runtimeBundle.path);
    const adapter = await readPinnedFile(this.#root, input.adapterBundle.path);
    files.set(`${npmRoot}/dist/dhr.js`, runtime);
    files.set(`${npmRoot}/dist/adapter.js`, adapter);
    files.set(`${localRoot}/.opencode/runtime/dhr.js`, runtime);
    files.set(`${localRoot}/.opencode/runtime/adapter.js`, adapter);
    files.set(`${npmRoot}/README.md`, Buffer.from('# dev-harness-opencode npm package\n\nThis local tgz is a reproducible package, not a published registry release. After an authorized npm publish, add `dev-harness-opencode` to `opencode.json` `plugin` and restart OpenCode. OpenCode does not promise discovery of skills inside npm packages: copy `skills/<name>/SKILL.md` to the project `.opencode/skills/<name>/SKILL.md`, or install the separate local ZIP. Test the plugin and Skills separately. The bundled CLI is `node dist/cli.mjs`; automatic Task execution needs a proven Executor and remains disabled. See DISTRIBUTION_NOTICE.md before external distribution.\n'));
    files.set(`${localRoot}/README.md`, Buffer.from('# dev-harness-opencode local plugin\n\nExtract `.opencode/plugins/dev-harness.js`, `.opencode/skills/` and `.opencode/runtime/` into an isolated project, then restart OpenCode. OpenCode loads JavaScript from `.opencode/plugins/` and discovers project Skills from `.opencode/skills/`. The bundled CLI is `node .opencode/runtime/cli.mjs`. Remove these exact installed files to uninstall. Do not install the npm and local plugin variants together: OpenCode loads both. Automatic Task execution needs a proven Executor and remains disabled. See DISTRIBUTION_NOTICE.md before external distribution.\n'));
    const notice = await readPinnedFile(this.#root, input.metadata.licenseRefs[0]!.path);
    files.set(`${npmRoot}/DISTRIBUTION_NOTICE.md`, notice);
    files.set(`${localRoot}/DISTRIBUTION_NOTICE.md`, notice);
    for (const skill of input.skills) {
      const bytes = await readPinnedFile(this.#root, skill.path);
      files.set(`${npmRoot}/${skill.path}`, bytes);
      files.set(`${localRoot}/.opencode/${skill.path}`, bytes);
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
    const add = (code: string, path: string, message: string) => checks.push({ code, path, message, severity: 'error' });
    const manifest = JSON.parse(await readFile(resolve(root, npmManifest), 'utf8')) as { name?: string; main?: string };
    if (manifest.name !== 'dev-harness-opencode' || manifest.main !== './dist/index.js') {
      add('OPENCODE_NPM_ENTRY', npmManifest, 'npm package name or entry differs from the reviewed local package');
    }
    const npmText = await readFile(resolve(root, npmEntry), 'utf8');
    const localText = await readFile(resolve(root, localEntry), 'utf8');
    if (npmText !== plugin || localText !== plugin) {
      add('OPENCODE_PLUGIN_ENTRY', npmEntry, 'Both variants must export the same reviewed plugin function');
    }
    for (const skill of input.skills) {
      const npmBytes = await readFile(resolve(root, npmRoot, skill.path));
      const localBytes = await readFile(resolve(root, localRoot, '.opencode', skill.path));
      if (!npmBytes.equals(localBytes)) add('OPENCODE_SKILL_MISMATCH', skill.path, 'Variant Skills differ');
    }
    if (!checks.length) checks.push({ code: 'OPENCODE_LAYOUT_VALID', path: npmManifest,
      message: 'npm and project-local plugin entries and Skills agree', severity: 'info' });
    return { schemaVersion: 1, valid: !checks.some((check) => check.severity === 'error'), checks,
      inputHash: sha256(canonicalJson(input)), evidenceRefs: [{ schemaVersion: 1,
        path: `${generated.root}/${npmManifest}`, sha256: sha256(await readFile(resolve(root, npmManifest))) }] };
  }
  async pack(generated: GeneratedPlugin, input: PluginBuildInput): Promise<Artifact[]> {
    const npmFiles = new Map<string, Uint8Array>();
    const localFiles = new Map<string, Uint8Array>();
    for (const file of generated.files) {
      const bytes = await readPinnedFile(this.#root, `${generated.root}/${file.path}`);
      if (file.path.startsWith(`${npmRoot}/`)) npmFiles.set(`package/${file.path.slice(npmRoot.length + 1)}`, bytes);
      else if (file.path.startsWith(`${localRoot}/`)) localFiles.set(file.path.slice(localRoot.length + 1), bytes);
      else throw new Error(`Unexpected OpenCode generated path: ${file.path}`);
    }
    const versions = [
      { variant: 'npm', filename: `dev-harness-opencode-v${input.releaseVersion}.tgz`,
        bytes: createTarGzip(npmFiles, input.buildTimestamp), mediaType: 'application/gzip' },
      { variant: 'local', filename: `dev-harness-opencode-local-v${input.releaseVersion}.zip`,
        bytes: createZip(localFiles, input.buildTimestamp), mediaType: 'application/zip' },
    ];
    await mkdir(resolve(this.#root, 'dist', id), { recursive: true });
    const artifacts: Artifact[] = [];
    for (const value of versions) {
      await writeFile(resolve(this.#root, 'dist', id, value.filename), value.bytes);
      artifacts.push({ schemaVersion: 1, platform: id, variant: value.variant,
        version: input.releaseVersion, coreProtocolVersion: input.coreProtocolVersion,
        file: `${id}/${value.filename}`, mediaType: value.mediaType, size: value.bytes.byteLength,
        sha256: sha256(value.bytes), inputHash: sha256(canonicalJson(input)) });
    }
    return artifacts;
  }
}

export async function createOpenCodeBuildPipeline(root: string, protocolCheckout: string): Promise<BuildPipeline> {
  const input = await repositoryBuildInput(root, id, 'packages/adapter-opencode/package.json',
    'packages/adapter-opencode/dist/index.js', protocolCheckout);
  const descriptors = createPlatformRegistry();
  const platforms = new PlatformRegistry();
  for (const entry of descriptors.list()) platforms.register(entry.id === id
    ? { ...entry, packager: new OpenCodePackager(root) } : entry);
  return new BuildPipeline({ root, platforms, inputs: [input], specifications: { [id]: opencodeStaticSpec },
    sourceRoots: { [input.protocolSource.repository]: protocolCheckout }, targetVersions: { [id]: 'opencode-plugin-current' } });
}
