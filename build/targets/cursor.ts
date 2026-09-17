import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Artifact, GeneratedPlugin, PluginBuildInput, PluginPackager, ValidationReport } from '@dev-harness-runtime/contracts';
import { createZip } from '../manifests/archive.js';
import { canonicalJson, readPinnedFile, sha256 } from '../manifests/input.js';
import type { StaticSpec } from '../validators/static.js';
import { BuildPipeline } from './pipeline.js';
import { createPlatformRegistry, PlatformRegistry } from './platforms.js';
import { repositoryBuildInput } from './source.js';

const id = 'cursor';
const manifest = '.cursor-plugin/plugin.json';
const skills = ['run', 'status', 'worker'] as const;
const rulePath = 'rules/dhr-runtime.mdc';
const commandPath = 'commands/dhr-status.md';
const json = (value: unknown): Uint8Array => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
const digest = (files: ReadonlyMap<string, Uint8Array>) => [...files]
  .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map(([path, bytes]) => ({ path, sha256: sha256(bytes) }));
const string = { type: 'string', minLength: 1 } as const;

export const cursorStaticSpec: StaticSpec = {
  requiredFiles: [manifest, 'package.json', rulePath, commandPath, 'scripts/dhr.mjs',
    'runtime/dhr.js', 'runtime/adapter.js', 'README.md', 'DISTRIBUTION_NOTICE.md'],
  allowedFiles: [manifest, 'package.json', rulePath, commandPath, 'scripts/dhr.mjs',
    'runtime/dhr.js', 'runtime/adapter.js', 'README.md', 'DISTRIBUTION_NOTICE.md',
    ...skills.map((name) => `skills/${name}/SKILL.md`)],
  skillFiles: skills.map((name) => `skills/${name}/SKILL.md`),
  lockedBundles: { 'runtime/dhr.js': 'runtimeBundle', 'runtime/adapter.js': 'adapterBundle' },
  manifests: [
    { path: manifest, schema: { type: 'object', additionalProperties: false,
      required: ['name', 'version', 'description', 'author', 'repository', 'skills', 'rules', 'commands'],
      properties: {
        name: { type: 'string', const: 'dev-harness' }, version: string, description: string,
        author: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: string } },
        repository: string, skills: { type: 'string', const: './skills' },
        rules: { type: 'string', const: './rules' }, commands: { type: 'string', const: './commands' },
      } }, versionFields: { version: 'releaseVersion' } },
    { path: 'package.json', schema: { type: 'object', additionalProperties: false,
      required: ['name', 'version', 'private', 'type'], properties: {
        name: { type: 'string', const: 'dev-harness' }, version: string,
        private: { type: 'boolean', const: true }, type: { type: 'string', const: 'module' },
      } }, versionFields: { version: 'releaseVersion' } },
  ],
};

const rule = `---
description: Use the dev-harness-runtime Skills only when the user requests a Runtime action.
alwaysApply: false
---

The shared Skills are the source of task and status behavior. Automatic task execution requires a separately proven host Executor; this plugin alone does not enable it.
`;
const command = `---
name: dhr-status
description: Show the status of an explicitly named dev-harness-runtime Run.
---

Ask for a Run ID if none was supplied. Use the installed \`dhr status --run <run-id>\` read-only entry and return only its verified summary. Never infer Run state from logs or start a new task.
`;
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

export class CursorPackager implements PluginPackager {
  readonly id = id;
  readonly #root: string;
  constructor(root: string) { this.#root = resolve(root); }
  async #files(input: PluginBuildInput): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    files.set(manifest, json({ name: input.metadata.name, version: input.releaseVersion,
      description: input.metadata.description, author: { name: input.metadata.author },
      repository: input.metadata.repository, skills: './skills', rules: './rules', commands: './commands' }));
    files.set('package.json', json({ name: input.metadata.name, version: input.releaseVersion, private: true, type: 'module' }));
    files.set(rulePath, Buffer.from(rule));
    files.set(commandPath, Buffer.from(command));
    files.set('scripts/dhr.mjs', Buffer.from(launcher));
    files.set('runtime/dhr.js', await readPinnedFile(this.#root, input.runtimeBundle.path));
    files.set('runtime/adapter.js', await readPinnedFile(this.#root, input.adapterBundle.path));
    files.set('README.md', Buffer.from('# Dev Harness Cursor Native Plugin\n\nUnzip under the Cursor local plugin directory so `dev-harness/.cursor-plugin/plugin.json` is present, then reload Cursor and inspect Customize for the three Skills, one rule and one command. The bundled CLI is `node scripts/dhr.mjs`; automatic Task execution remains gated by a separate Executor probe. Remove the local plugin directory to uninstall. This is a local build; see DISTRIBUTION_NOTICE.md before any external distribution.\n'));
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
    const values = JSON.parse(await readFile(resolve(root, manifest), 'utf8')) as {
      name?: string; skills?: string; rules?: string; commands?: string;
    };
    const checks: ValidationReport['checks'][number][] = [];
    const add = (code: string, path: string, message: string) => checks.push({ code, path, message, severity: 'error' });
    if (values.name !== input.metadata.name || values.skills !== './skills'
      || values.rules !== './rules' || values.commands !== './commands') {
      add('CURSOR_COMPONENT_PATH', manifest, 'Native manifest does not bind the bundled default component roots');
    }
    if (generated.files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file.path)).length !== input.skills.length) {
      add('SKILL_COUNT', manifest, 'Generated Skill count differs from locked input');
    }
    const ruleText = await readFile(resolve(root, rulePath), 'utf8');
    if (!/^---\ndescription: [^\n]+\nalwaysApply: false\n---\n/u.test(ruleText)) {
      add('CURSOR_RULE', rulePath, 'Rule frontmatter is missing or unexpectedly always applied');
    }
    const commandText = await readFile(resolve(root, commandPath), 'utf8');
    if (!/^---\nname: dhr-status\ndescription: [^\n]+\n---\n/u.test(commandText)) {
      add('CURSOR_COMMAND', commandPath, 'Command frontmatter is invalid');
    }
    if (!checks.length) checks.push({ code: 'CURSOR_LAYOUT_VALID', path: manifest,
      message: 'Native manifest, three Skills, rule and command agree', severity: 'info' });
    return { schemaVersion: 1, valid: !checks.some((check) => check.severity === 'error'), checks,
      inputHash: sha256(canonicalJson(input)), evidenceRefs: [{ schemaVersion: 1,
        path: `${generated.root}/${manifest}`, sha256: sha256(await readFile(resolve(root, manifest))) }] };
  }
  async pack(generated: GeneratedPlugin, input: PluginBuildInput): Promise<Artifact[]> {
    const files = new Map<string, Uint8Array>();
    for (const file of generated.files) files.set(`dev-harness/${file.path}`,
      await readPinnedFile(this.#root, `${generated.root}/${file.path}`));
    const bytes = createZip(files, input.buildTimestamp);
    const filename = `dev-harness-cursor-v${input.releaseVersion}.zip`;
    await mkdir(resolve(this.#root, 'dist', id), { recursive: true });
    await writeFile(resolve(this.#root, 'dist', id, filename), bytes);
    return [{ schemaVersion: 1, platform: id, variant: 'native-plugin', version: input.releaseVersion,
      coreProtocolVersion: input.coreProtocolVersion, file: `${id}/${filename}`,
      mediaType: 'application/zip', size: bytes.byteLength, sha256: sha256(bytes),
      inputHash: sha256(canonicalJson(input)) }];
  }
}

export async function createCursorBuildPipeline(root: string, protocolCheckout: string): Promise<BuildPipeline> {
  const input = await repositoryBuildInput(root, id, 'packages/adapter-cursor/package.json',
    'packages/adapter-cursor/dist/index.js', protocolCheckout);
  const descriptors = createPlatformRegistry();
  const platforms = new PlatformRegistry();
  for (const entry of descriptors.list()) platforms.register(entry.id === id
    ? { ...entry, packager: new CursorPackager(root) } : entry);
  return new BuildPipeline({ root, platforms, inputs: [input], specifications: { [id]: cursorStaticSpec },
    sourceRoots: { [input.protocolSource.repository]: protocolCheckout }, targetVersions: { [id]: 'cursor-native-2026.06.26' } });
}
