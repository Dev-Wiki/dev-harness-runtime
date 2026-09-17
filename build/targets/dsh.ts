import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Artifact, GeneratedPlugin, PluginBuildInput, PluginPackager, ValidationReport } from '@dev-harness-runtime/contracts';
import { createTarGzip } from '../manifests/archive.js';
import { canonicalJson, readPinnedFile, sha256 } from '../manifests/input.js';
import type { StaticSpec } from '../validators/static.js';
import { BuildPipeline } from './pipeline.js';
import { createPlatformRegistry, PlatformRegistry } from './platforms.js';
import { repositoryBuildInput } from './source.js';

const id = 'dsh';
const skills = ['run', 'status', 'worker'] as const;
const patch = '- insert:\n    - id: dev-harness-runtime\n      name: dev-harness-runtime\n';
const json = (value: unknown): Uint8Array => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
const digest = (files: ReadonlyMap<string, Uint8Array>) => [...files]
  .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map(([path, bytes]) => ({ path, sha256: sha256(bytes) }));
const text = { type: 'string', minLength: 1 } as const;

/** The target host is rc.1, but these are its actually resolved public components. */
export const dshHostDependencies = Object.freeze({
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/dsh-commands': '0.1.5-rc.2',
  '@deepseek-ai/dsh-tools': '0.1.5-rc.2',
});

export const dshStaticSpec: StaticSpec = {
  requiredFiles: ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/dhr.js', 'scripts/dhr.mjs',
    'README.md', 'DISTRIBUTION_NOTICE.md'],
  allowedFiles: ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/dhr.js', 'scripts/dhr.mjs',
    'README.md', 'DISTRIBUTION_NOTICE.md', ...skills.map((name) => `skills/${name}/SKILL.md`)],
  skillFiles: skills.map((name) => `skills/${name}/SKILL.md`),
  lockedBundles: { 'lib/index.js': 'adapterBundle', 'lib/dhr.js': 'runtimeBundle' },
  manifests: [{ path: 'package.json', schema: { type: 'object', additionalProperties: false,
    required: ['name', 'version', 'private', 'type', 'main', 'files', 'dsh', 'peerDependencies'],
    properties: {
      name: { type: 'string', const: 'dev-harness-runtime' }, version: text,
      private: { type: 'boolean', const: true }, type: { type: 'string', const: 'module' },
      main: { type: 'string', const: 'lib/index.js' },
      files: { type: 'array', const: ['lib', 'skills', 'scripts', 'cordis.patch.yml', 'README.md', 'DISTRIBUTION_NOTICE.md'], items: text },
      dsh: { type: 'object', additionalProperties: false, required: ['bundle'], properties: {
        bundle: { type: 'object', additionalProperties: false, required: ['patch'], properties: {
          patch: { type: 'string', const: './cordis.patch.yml' },
        } },
      } },
      peerDependencies: { type: 'object', additionalProperties: false,
        required: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-tools'], properties: {
          '@deepseek-ai/cordis': { type: 'string', const: '4.0.2' },
          '@deepseek-ai/dsh-commands': { type: 'string', const: '0.1.5-rc.2' },
          '@deepseek-ai/dsh-tools': { type: 'string', const: '0.1.5-rc.2' },
        } },
    } }, versionFields: { version: 'releaseVersion' }, referenceFields: ['main'] }],
};

const launcher = `#!/usr/bin/env node
import { runCli } from '../lib/dhr.js';
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

/** Only the DSH host registration lives here; Core remains the single task orchestrator. */
export class DshPackager implements PluginPackager {
  readonly id = id;
  readonly #root: string;
  constructor(root: string) { this.#root = resolve(root); }
  async #files(input: PluginBuildInput): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    files.set('package.json', json({ name: 'dev-harness-runtime', version: input.releaseVersion,
      private: true, type: 'module', main: 'lib/index.js',
      files: ['lib', 'skills', 'scripts', 'cordis.patch.yml', 'README.md', 'DISTRIBUTION_NOTICE.md'],
      dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: dshHostDependencies }));
    files.set('cordis.patch.yml', Buffer.from(patch));
    files.set('lib/index.js', await readPinnedFile(this.#root, input.adapterBundle.path));
    files.set('lib/dhr.js', await readPinnedFile(this.#root, input.runtimeBundle.path));
    files.set('scripts/dhr.mjs', Buffer.from(launcher));
    files.set('README.md', Buffer.from('# dev-harness-runtime DSH bundle\n\nInstall the local tgz into an isolated profile with `dsh plugin --profile <name> add <absolute-tgz-path> --offline --ignore-scripts`. Use `dsh --profile <name> --dump-config` to inspect the Cordis row and `dsh plugin --profile <name> remove dev-harness-runtime` to uninstall. The bundled `node scripts/dhr.mjs` exposes the shared CLI; automatic task execution remains gated by a separate Executor probe.\n\nThis is a local build; see DISTRIBUTION_NOTICE.md before any external distribution.\n'));
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
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }; peerDependencies?: Record<string, string>;
    };
    const yaml = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8');
    const checks: ValidationReport['checks'][number][] = [];
    const add = (code: string, path: string, message: string) => checks.push({ code, path, message, severity: 'error' });
    if (yaml !== patch || packageJson.dsh?.bundle?.patch !== './cordis.patch.yml') {
      add('DSH_PATCH', 'cordis.patch.yml', 'Bundle patch or manifest reference differs from the reviewed Cordis layer');
    }
    if (canonicalJson(packageJson.peerDependencies) !== canonicalJson(dshHostDependencies)) {
      add('DSH_DEPENDENCIES', 'package.json', 'Declared peers differ from the observed rc.1 host component versions');
    }
    if (generated.files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file.path)).length !== input.skills.length) {
      add('SKILL_COUNT', 'package.json', 'Generated Skill count differs from locked input');
    }
    if (!checks.length) checks.push({ code: 'DSH_LAYOUT_VALID', path: 'package.json',
      message: 'DSH bundle patch, resolved peer versions and Skill count agree', severity: 'info' });
    return { schemaVersion: 1, valid: !checks.some((check) => check.severity === 'error'), checks,
      inputHash: sha256(canonicalJson(input)), evidenceRefs: [{ schemaVersion: 1,
        path: `${generated.root}/package.json`, sha256: sha256(await readFile(resolve(root, 'package.json'))) }] };
  }
  async pack(generated: GeneratedPlugin, input: PluginBuildInput): Promise<Artifact[]> {
    const files = new Map<string, Uint8Array>();
    for (const file of generated.files) files.set(`package/${file.path}`,
      await readPinnedFile(this.#root, `${generated.root}/${file.path}`));
    const bytes = createTarGzip(files, input.buildTimestamp);
    const filename = `dev-harness-dsh-v${input.releaseVersion}.tgz`;
    await mkdir(resolve(this.#root, 'dist', id), { recursive: true });
    await writeFile(resolve(this.#root, 'dist', id, filename), bytes);
    return [{ schemaVersion: 1, platform: id, variant: 'bundle', version: input.releaseVersion,
      coreProtocolVersion: input.coreProtocolVersion, file: `${id}/${filename}`,
      mediaType: 'application/gzip', size: bytes.byteLength, sha256: sha256(bytes),
      inputHash: sha256(canonicalJson(input)) }];
  }
}

export async function createDshBuildPipeline(root: string, protocolCheckout: string): Promise<BuildPipeline> {
  const input = await repositoryBuildInput(root, id, 'packages/adapter-dsh/package.json',
    'packages/adapter-dsh/dist/plugin.js', protocolCheckout);
  const descriptors = createPlatformRegistry();
  const platforms = new PlatformRegistry();
  for (const entry of descriptors.list()) platforms.register(entry.id === id
    ? { ...entry, packager: new DshPackager(root) } : entry);
  return new BuildPipeline({ root, platforms, inputs: [input], specifications: { [id]: dshStaticSpec },
    sourceRoots: { [input.protocolSource.repository]: protocolCheckout }, targetVersions: { [id]: 'dsh-0.1.5-rc.1' } });
}
