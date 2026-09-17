import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { CORE_PROTOCOL_VERSION, parseContract, type PluginBuildInput } from '@dev-harness-runtime/contracts';
import { readPinnedFile, sha256 } from '../manifests/input.js';
import { loadSharedMetadata } from '../manifests/metadata.js';

const git = promisify(execFile);
const repository = 'https://github.com/Dev-Wiki/dev-harness-runtime';
const skillNames = ['run', 'status', 'worker'] as const;

/** Construct a locked input from real repository bytes, never from a project-supplied executable config. */
export async function repositoryBuildInput(
  root: string, platform: string, adapterManifest: string, adapterBundle: string,
  protocolCheckout: string,
): Promise<PluginBuildInput> {
  const checkout = resolve(root);
  const upstream = resolve(protocolCheckout);
  const [{ stdout: head }, { stdout: committedAt }] = await Promise.all([
    git('git', ['-C', checkout, 'rev-parse', 'HEAD']),
    git('git', ['-C', checkout, 'show', '-s', '--format=%cI', 'HEAD']),
  ]);
  const lock = JSON.parse(await readFile(resolve(checkout, 'protocol-lock.json'), 'utf8')) as {
    repository: string; commit: string; protocolVersion: string;
    files: { path: string; sha256: string }[];
  };
  const release = JSON.parse(await readFile(resolve(checkout, 'package.json'), 'utf8')) as { version: string };
  const adapter = JSON.parse(await readFile(resolve(checkout, adapterManifest), 'utf8')) as { version: string };
  const source = (version: string, path: string) => ({
    schemaVersion: 1 as const, repository, version, commit: head.trim(), path,
  });
  const bundle = async (version: string, path: string, manifest: string) => ({
    schemaVersion: 1 as const, version, path,
    sha256: sha256(await readPinnedFile(checkout, path)), source: source(version, manifest),
  });
  const skills = await Promise.all(skillNames.map(async (name) => {
    const path = `skills/${name}/SKILL.md`;
    return { schemaVersion: 1 as const, name, path,
      sha256: sha256(await readPinnedFile(checkout, path)), source: source(release.version, path) };
  }));
  // The actual checkout is supplied to BuildPipeline for the protocol's clean-tree check.
  // Reading it here catches an accidentally pointed-at directory before constructing input.
  await readPinnedFile(upstream, lock.files[0]!.path);
  return parseContract('pluginBuildInput', {
    schemaVersion: 1, platform, releaseVersion: release.version, adapterVersion: adapter.version,
    coreProtocolVersion: CORE_PROTOCOL_VERSION,
    protocolSource: { schemaVersion: 1, repository: lock.repository, version: lock.protocolVersion,
      commit: lock.commit, files: lock.files },
    skills,
    runtimeBundle: await bundle(release.version, 'packages/cli/dist/bundle.js', 'package.json'),
    adapterBundle: await bundle(adapter.version, adapterBundle, adapterManifest),
    metadata: await loadSharedMetadata(checkout, ['build/manifests/DISTRIBUTION_NOTICE.md']),
    buildTimestamp: new Date(committedAt.trim()).toISOString(),
  });
}
