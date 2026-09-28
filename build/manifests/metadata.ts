import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseContract, type PluginMetadata } from '@dev-harness-runtime/contracts';
import { readPinnedFile, sha256 } from './input.js';

interface MetadataSource {
  schemaVersion: 1; name: string; displayName: string; description: string;
  author: string; repository: string;
  distribution: { external: false; reason: string } | { external: true; license: 'MIT'; notice: string };
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
  const distribution = source.distribution;
  if (distribution?.external === true) {
    if (Object.keys(distribution).sort().join(',') !== 'external,license,notice'
      || distribution.license !== 'MIT'
      || distribution.notice !== 'build/manifests/DISTRIBUTION_NOTICE.md'
      || !licensePaths.includes(distribution.notice)) {
      throw new Error('External distribution requires the reviewed MIT license and notice reference');
    }
    const [license, thirdParty, notice] = await Promise.all([
      readPinnedFile(root, 'LICENSE'), readPinnedFile(root, 'THIRD_PARTY_NOTICES.md'),
      readPinnedFile(root, distribution.notice),
    ]);
    if (!license.length || !thirdParty.length
      || !Buffer.from(notice).includes(Buffer.from(license))
      || !Buffer.from(notice).includes(Buffer.from(thirdParty))) {
      throw new Error('External distribution notice omits the project license or third-party notices');
    }
  } else if (distribution?.external !== false || Object.keys(distribution).sort().join(',') !== 'external,reason'
    || typeof distribution.reason !== 'string' || !distribution.reason) {
    throw new Error('Invalid distribution declaration');
  }
  const licenseRefs: PluginMetadata['licenseRefs'] = [];
  for (const path of licensePaths) licenseRefs.push({ path, sha256: sha256(await readPinnedFile(root, path)) });
  return parseContract('pluginMetadata', {
    schemaVersion: source.schemaVersion, name: source.name, displayName: source.displayName,
    description: source.description, author: source.author, repository: source.repository, licenseRefs,
  });
}
