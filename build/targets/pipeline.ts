import { readdir, readFile, rename, rm, lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  isRepoPath, parseContract, type Artifact, type GeneratedPlugin, type PluginBuildInput,
  type ValidationReport,
} from '@dev-harness-runtime/contracts';
import { canonicalJson, readPinnedFile, sha256, verifyBuildInput, type SourceEvidence } from '../manifests/input.js';
import { loadSharedMetadata } from '../manifests/metadata.js';
import { validateStatic, type StaticSpec } from '../validators/static.js';
import type { PlatformRegistry } from './platforms.js';

export class BuildError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BuildError'; }
}
interface GeneratedReceipt {
  schemaVersion: 1; input: PluginBuildInput; evidence: SourceEvidence;
  generated: GeneratedPlugin; treeHash: string; specHash: string;
}
interface ValidatedReceipt { schemaVersion: 1; report: ValidationReport; generatedReceiptHash: string; treeHash: string }
export interface BuildPipelineOptions {
  root: string;
  platforms: PlatformRegistry;
  inputs: readonly PluginBuildInput[];
  specifications: Readonly<Record<string, StaticSpec>>;
  sourceRoots?: Readonly<Record<string, string>>;
  targetVersions?: Readonly<Record<string, string>>;
}

const lexical = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const encode = (value: unknown): Uint8Array => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${sha256(bytes).slice(0, 12)}`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function tree(root: string): Promise<ReadonlyMap<string, Uint8Array>> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new BuildError('INVALID_PATH', `Generated root is not a private directory: ${root}`);
  const output = new Map<string, Uint8Array>();
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!isRepoPath(path)) throw new BuildError('INVALID_PATH', `Generated path is unsafe: ${path}`);
      if (entry.isSymbolicLink()) throw new BuildError('INVALID_PATH', `Generated symlink refused: ${path}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else if (entry.isFile()) output.set(path, await readFile(join(directory, entry.name)));
      else throw new BuildError('INVALID_PATH', `Generated special file refused: ${path}`);
    }
  }
  await visit(root, '');
  return new Map([...output].sort(([a], [b]) => lexical(a, b)));
}

function digests(files: ReadonlyMap<string, Uint8Array>): readonly { path: string; sha256: string }[] {
  return [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes) }));
}

/** A stage never calls an earlier stage; durable receipts bind every later stage to unchanged bytes. */
export class BuildPipeline {
  readonly root: string;
  readonly platforms: PlatformRegistry;
  readonly #inputs: ReadonlyMap<string, PluginBuildInput>;
  readonly #specifications: Readonly<Record<string, StaticSpec>>;
  readonly #sourceRoots: Readonly<Record<string, string>>;
  readonly #targetVersions: Readonly<Record<string, string>>;

  constructor(options: BuildPipelineOptions) {
    this.root = resolve(options.root);
    this.platforms = options.platforms;
    const inputs = new Map<string, PluginBuildInput>();
    for (const value of options.inputs) {
      const input = parseContract('pluginBuildInput', value);
      if (inputs.has(input.platform)) throw new BuildError('INVALID_INPUT', `Duplicate platform input: ${input.platform}`);
      inputs.set(input.platform, structuredClone(input));
    }
    this.#inputs = inputs;
    this.#specifications = structuredClone(options.specifications);
    this.#sourceRoots = { ...options.sourceRoots };
    this.#targetVersions = { ...options.targetVersions };
  }

  #selection(id: string) {
    let platform;
    try { platform = this.platforms.get(id); }
    catch { throw new BuildError('UNKNOWN_ADAPTER', `Unknown platform: ${id}`); }
    if (!platform.packager) throw new BuildError('CAPABILITY_MISSING', `Platform ${id} has no registered Packager`);
    const input = this.#inputs.get(id);
    const spec = this.#specifications[id];
    if (!input || !spec) throw new BuildError('CAPABILITY_MISSING', `Platform ${id} has no complete build input and static specification`);
    return { packager: platform.packager, input, spec };
  }

  #locations(id: string) {
    const base = resolve(this.root, '.generated', id);
    return { base, plugin: join(base, 'plugin'), generated: join(base, 'generated.json'), validated: join(base, 'validation.json') };
  }

  async #withStageLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.#selection(id);
    const paths = this.#locations(id);
    for (const path of [resolve(this.root, '.generated'), paths.base]) {
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new BuildError('INVALID_PATH', `Generated ancestor is not a private directory: ${path}`);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    await mkdir(paths.base, { recursive: true });
    const lockPath = join(paths.base, '.stage.lock');
    let handle;
    try { handle = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new BuildError('BUILD_BUSY', `Platform ${id} already has an active or unresolved build stage`);
      }
      throw error;
    }
    try { return await action(); }
    finally { await handle.close(); await rm(lockPath); }
  }

  async #withManifestLock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = resolve(this.root, '.generated', '.manifest.lock');
    let handle;
    try { handle = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new BuildError('BUILD_BUSY', 'Another platform is packing or a prior manifest update is unresolved');
      }
      throw error;
    }
    try { return await action(); }
    finally { await handle.close(); await rm(lockPath); }
  }

  async #assertSourceStable(id: string, evidence: SourceEvidence): Promise<void> {
    const after = await this.#verified(id);
    if (!equal(after.evidence, evidence)) throw new BuildError('SOURCE_DRIFT', `Platform ${id} source changed during build stage`);
  }

  async #verified(id: string) {
    const { packager, input, spec } = this.#selection(id);
    const roots = { ...this.#sourceRoots, 'https://github.com/Dev-Wiki/dev-harness-runtime': this.root };
    const verified = await verifyBuildInput(this.root, input, roots);
    const metadata = await loadSharedMetadata(this.root, input.metadata.licenseRefs.map((ref) => ref.path));
    if (!equal(metadata, input.metadata)) throw new BuildError('INVALID_INPUT', `Platform ${id} metadata differs from the shared source`);
    return { packager, input: verified.input, spec, evidence: verified.evidence };
  }

  async #readGenerated(id: string) {
    const selected = await this.#verified(id);
    const paths = this.#locations(id);
    let receipt: GeneratedReceipt;
    try { receipt = JSON.parse(await readFile(paths.generated, 'utf8')) as GeneratedReceipt; }
    catch { throw new BuildError('STALE_GENERATION', `Platform ${id} has no generated receipt; run dhr build first`); }
    if (receipt.schemaVersion !== 1 || !equal(receipt.input, selected.input)
      || !equal(receipt.evidence, selected.evidence)
      || receipt.specHash !== sha256(canonicalJson(selected.spec))) {
      throw new BuildError('STALE_GENERATION', `Platform ${id} generated input or source changed`);
    }
    const plugin = parseContract('generatedPlugin', receipt.generated);
    if (plugin.platform !== id || plugin.adapterVersion !== selected.input.adapterVersion
      || plugin.inputHash !== selected.evidence.inputHash || plugin.root !== `.generated/${id}/plugin`) {
      throw new BuildError('STALE_GENERATION', `Platform ${id} generated identity differs`);
    }
    const files = await tree(paths.plugin);
    if (!equal(plugin.files, digests(files)) || receipt.treeHash !== sha256(canonicalJson(digests(files)))) {
      throw new BuildError('STALE_GENERATION', `Platform ${id} generated tree changed`);
    }
    return { ...selected, paths, receipt, receiptHash: sha256(encode(receipt)), plugin, files };
  }

  async generate(id: string): Promise<GeneratedPlugin> {
    return this.#withStageLock(id, async () => {
    const selected = await this.#verified(id);
    const paths = this.#locations(id);
    // The generator owns only its fixed private platform tree.
    try { if ((await lstat(paths.plugin)).isSymbolicLink()) throw new BuildError('INVALID_PATH', 'Generated root is a symlink'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await rm(paths.plugin, { recursive: true, force: true });
    await rm(paths.generated, { force: true });
    await rm(paths.validated, { force: true });
    const generated = parseContract('generatedPlugin', await selected.packager.generate(selected.input));
    if (generated.platform !== id || generated.adapterVersion !== selected.input.adapterVersion
      || generated.root !== `.generated/${id}/plugin` || generated.inputHash !== selected.evidence.inputHash) {
      throw new BuildError('INVALID_GENERATION', `Platform ${id} generator returned wrong identity or path`);
    }
    const files = await tree(paths.plugin);
    if (!equal(generated.files, digests(files))) throw new BuildError('INVALID_GENERATION', `Platform ${id} generator file manifest differs from actual bytes`);
    await this.#assertSourceStable(id, selected.evidence);
    const receipt: GeneratedReceipt = {
      schemaVersion: 1, input: selected.input, evidence: selected.evidence, generated,
      treeHash: sha256(canonicalJson(digests(files))), specHash: sha256(canonicalJson(selected.spec)),
    };
    await writeAtomic(paths.generated, encode(receipt));
    return generated;
    });
  }

  async validate(id: string): Promise<ValidationReport> {
    return this.#withStageLock(id, async () => {
    const context = await this.#readGenerated(id);
    await rm(context.paths.validated, { force: true });
    const staticChecks = await validateStatic(context.files, context.input, context.spec);
    const platformReport = parseContract('validationReport', await context.packager.validate(context.plugin, context.input));
    if (platformReport.inputHash !== context.evidence.inputHash) throw new BuildError('INVALID_VALIDATION', 'Packager report input digest differs');
    const after = await tree(context.paths.plugin);
    if (!equal(digests(after), digests(context.files))) throw new BuildError('STALE_GENERATION', 'Packager mutated plugin tree during validation');
    await this.#assertSourceStable(id, context.evidence);
    const checks = [...staticChecks, ...platformReport.checks];
    if (checks.length === 0) checks.push({ code: 'VALIDATED', path: `.generated/${id}/plugin`, message: 'Static and platform validation passed', severity: 'info' });
    const report = parseContract('validationReport', {
      schemaVersion: 1, valid: !checks.some((check) => check.severity === 'error'), checks,
      inputHash: context.evidence.inputHash,
      evidenceRefs: [{ schemaVersion: 1, path: `.generated/${id}/generated.json`, sha256: context.receiptHash }],
    });
    const validated: ValidatedReceipt = {
      schemaVersion: 1, report, generatedReceiptHash: context.receiptHash, treeHash: context.receipt.treeHash,
    };
    await writeAtomic(context.paths.validated, encode(validated));
    return report;
    });
  }

  async pack(id: string): Promise<Artifact[]> {
    return this.#withStageLock(id, async () => {
    const context = await this.#readGenerated(id);
    if (!this.#targetVersions[id]) throw new BuildError('INVALID_INPUT', `Platform ${id} target format version is missing`);
    let validated: ValidatedReceipt;
    try { validated = JSON.parse(await readFile(context.paths.validated, 'utf8')) as ValidatedReceipt; }
    catch { throw new BuildError('VALIDATION_REQUIRED', `Platform ${id} must be validated before packing`); }
    const report = parseContract('validationReport', validated.report);
    if (!report.valid || report.inputHash !== context.evidence.inputHash
      || validated.generatedReceiptHash !== context.receiptHash || validated.treeHash !== context.receipt.treeHash) {
      throw new BuildError('VALIDATION_REQUIRED', `Platform ${id} validation no longer binds the generated bytes`);
    }
    const artifacts = await context.packager.pack(context.plugin, context.input);
    if (artifacts.length === 0) throw new BuildError('INVALID_ARTIFACT', 'Packager produced no artifacts');
    const seen = new Set<string>();
    const normalized: Artifact[] = [];
    for (const value of artifacts) {
      const artifact = parseContract('artifact', value);
      if (artifact.platform !== id || artifact.version !== context.input.releaseVersion
        || artifact.coreProtocolVersion !== context.input.coreProtocolVersion
        || artifact.inputHash !== context.evidence.inputHash
        || !artifact.file.startsWith(`${id}/`) || seen.has(artifact.file.toLowerCase())) {
        throw new BuildError('INVALID_ARTIFACT', `Platform ${id} artifact identity or path differs`);
      }
      seen.add(artifact.file.toLowerCase());
      const bytes = await readPinnedFile(this.root, `dist/${artifact.file}`);
      if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256) {
        throw new BuildError('INVALID_ARTIFACT', `Platform ${id} artifact bytes differ: ${artifact.file}`);
      }
      normalized.push(artifact);
    }
    const after = await tree(context.paths.plugin);
    if (!equal(digests(after), digests(context.files))) throw new BuildError('STALE_GENERATION', 'Packager mutated validated plugin tree');
    await this.#assertSourceStable(id, context.evidence);
    normalized.sort((a, b) => lexical(a.file, b.file));
    const outputDir = resolve(this.root, 'dist', id);
    const actualArtifacts = await tree(outputDir);
    if (!equal([...actualArtifacts.keys()].map((path) => `${id}/${path}`), normalized.map((artifact) => artifact.file))) {
      throw new BuildError('INVALID_ARTIFACT', `Platform ${id} dist tree contains unlisted files`);
    }
    await this.#withManifestLock(() => this.#writeManifest(id, context.input, context.evidence, normalized));
    return normalized;
    });
  }

  async #writeManifest(id: string, input: PluginBuildInput, evidence: SourceEvidence, artifacts: readonly Artifact[]): Promise<void> {
    const targetVersion = this.#targetVersions[id];
    if (!targetVersion) throw new BuildError('INVALID_INPUT', `Platform ${id} target format version is missing`);
    const path = resolve(this.root, 'dist', 'manifest.json');
    let previous: { artifacts: Artifact[]; adapterCompatibility: { platform: string; adapterVersion: string; coreProtocolVersion: number; targetVersion: string }[] } | null = null;
    try { previous = parseContract('releaseManifest', JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (previous) {
      const full = parseContract('releaseManifest', JSON.parse(await readFile(path, 'utf8')));
      if (full.releaseVersion !== input.releaseVersion || full.coreProtocolVersion !== input.coreProtocolVersion
        || full.sourceCommit !== evidence.sourceCommit || !equal(full.protocolSource, input.protocolSource)) {
        throw new BuildError('INVALID_ARTIFACT', 'Existing manifest belongs to another release input');
      }
      for (const artifact of full.artifacts.filter((entry) => entry.platform !== id)) {
        const bytes = await readPinnedFile(this.root, `dist/${artifact.file}`);
        if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256) {
          throw new BuildError('INVALID_ARTIFACT', `Existing manifest references changed artifact: ${artifact.file}`);
        }
      }
    }
    const manifest = parseContract('releaseManifest', {
      schemaVersion: 1, releaseVersion: input.releaseVersion,
      coreProtocolVersion: input.coreProtocolVersion, sourceCommit: evidence.sourceCommit,
      protocolSource: input.protocolSource,
      adapterCompatibility: [...(previous?.adapterCompatibility.filter((entry) => entry.platform !== id) ?? []),
        { platform: id, adapterVersion: input.adapterVersion, coreProtocolVersion: input.coreProtocolVersion, targetVersion }]
        .sort((a, b) => lexical(a.platform, b.platform)),
      artifacts: [...(previous?.artifacts.filter((entry) => entry.platform !== id) ?? []), ...artifacts]
        .sort((a, b) => lexical(a.file, b.file)),
    });
    await writeAtomic(path, encode(manifest));
    await writeAtomic(resolve(this.root, 'dist', 'build-evidence.json'), encode({
      schemaVersion: 1, sourceCommit: evidence.sourceCommit,
      localUnversioned: evidence.localUnversioned, protocolLockHash: evidence.protocolLockHash,
      inputHash: evidence.inputHash, nodeVersion: process.versions.node,
    }));
  }
}
