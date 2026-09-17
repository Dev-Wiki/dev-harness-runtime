import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseContract, type PluginMetadata } from '@dev-harness-runtime/contracts';
import { readPinnedFile, sha256 } from './input.js';

interface MetadataSource {
  schemaVersion: 1; name: string; displayName: string; description: string;
  author: string; repository: string; distribution: { external: false; reason: string };
}

/** The one shared metadata source; callers must supply real license and notice files. */
export async function loadSharedMetadata(root: string, licensePaths: readonly string[]): Promise<PluginMetadata> {
  const raw: unknown = JSON.parse(await readFile(resolve(root, 'build/manifests/metadata.json'), 'utf8'));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid shared metadata');
  const fields = Object.keys(raw).sort();
  if (fields.join(',') !== ['author', 'description', 'displayName', 'distribution', 'name', 'repository', 'schemaVersion'].sort().join(',')) {
    throw new Error('Shared metadata fields differ from the fixed contract');
  }
  const source = raw as MetadataSource;
  if (source.distribution?.external !== false || typeof source.distribution.reason !== 'string' || !source.distribution.reason) {
    throw new Error('External distribution gate must remain explicit until license review');
  }
  const licenseRefs: PluginMetadata['licenseRefs'] = [];
  for (const path of licensePaths) licenseRefs.push({ path, sha256: sha256(await readPinnedFile(root, path)) });
  return parseContract('pluginMetadata', {
    schemaVersion: source.schemaVersion, name: source.name, displayName: source.displayName,
    description: source.description, author: source.author, repository: source.repository, licenseRefs,
  });
}
