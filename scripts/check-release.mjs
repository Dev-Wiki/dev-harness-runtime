import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tag = process.argv[2];
const read = (path) => readFile(resolve(root, path));
const json = async (path) => JSON.parse((await read(path)).toString('utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

const [pkg, metadata, license, thirdParty, notice, manifest, evidence, changelog, sourceMap] = await Promise.all([
  json('package.json'), json('build/manifests/metadata.json'), read('LICENSE'),
  read('THIRD_PARTY_NOTICES.md'), read('build/manifests/DISTRIBUTION_NOTICE.md'),
  json('dist/manifest.json'), json('dist/build-evidence.json'), read('CHANGELOG.md'),
  json('packages/cli/dist/bundle.js.map'),
]);
requireValue(tag === `v${pkg.version}`, 'Release tag does not match package version');
requireValue(changelog.toString('utf8').includes(`## ${tag} — `), 'Release changelog section is missing');
requireValue(metadata.distribution?.external === true && metadata.distribution.license === 'MIT'
  && metadata.distribution.notice === 'build/manifests/DISTRIBUTION_NOTICE.md',
'External MIT distribution declaration is missing');
requireValue(license.length > 0 && thirdParty.length > 0, 'License or third-party notices are empty');
requireValue(notice.includes(license) && notice.includes(thirdParty), 'Bundled distribution notice omits license or third-party text');
requireValue(!notice.toString('utf8').includes('local development and validation only'), 'Local-only distribution notice remains');

const bundledPackages = new Map();
for (const source of sourceMap.sources) {
  const match = source.match(/node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)/u);
  if (match) bundledPackages.set(match[2], match[1]);
}
requireValue(bundledPackages.size > 0, 'No bundled third-party packages found in CLI source map');
for (const [name, store] of bundledPackages) {
  const version = store.slice(store.lastIndexOf('@') + 1);
  const dependencyRoot = resolve(root, 'node_modules/.pnpm', store, 'node_modules', name);
  const licenses = (await readdir(dependencyRoot)).filter((file) => file.toLowerCase().startsWith('license'));
  requireValue(licenses.length === 1, `Expected one license file for ${name}@${version}`);
  const dependencyLicense = (await readFile(resolve(dependencyRoot, licenses[0]))).toString('utf8')
    .trim().split('\n').map((line) => line.trimEnd()).join('\n');
  requireValue(thirdParty.toString('utf8').includes(`## ${name} ${version}\n`)
    && thirdParty.toString('utf8').includes(dependencyLicense),
  `Third-party notice is missing ${name}@${version} or its license text`);
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
requireValue(manifest.releaseVersion === pkg.version && manifest.sourceCommit === head,
  'Manifest version or source commit differs from HEAD');
requireValue(evidence.sourceCommit === head && evidence.localUnversioned === false,
  'Build evidence is uncommitted or belongs to another HEAD');
requireValue(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 9,
  'Release requires exactly nine artifacts');
const names = new Set();
for (const item of manifest.artifacts) {
  requireValue(typeof item.file === 'string' && !item.file.includes('..') && !item.file.startsWith('/'),
    'Artifact path is invalid');
  requireValue(!names.has(item.file), `Duplicate artifact: ${item.file}`);
  names.add(item.file);
  requireValue(item.version === pkg.version, `Artifact version mismatch: ${item.file}`);
  const path = resolve(root, 'dist', item.file);
  const info = await stat(path);
  requireValue(info.isFile() && info.size === item.size, `Artifact size mismatch: ${item.file}`);
  requireValue(sha256(await readFile(path)) === item.sha256, `Artifact hash mismatch: ${item.file}`);
  const entries = execFileSync(item.file.endsWith('.zip') ? 'unzip' : 'tar',
    item.file.endsWith('.zip') ? ['-Z1', path] : ['-tzf', path], { encoding: 'utf8' })
    .trim().split('\n').filter((entry) => entry.endsWith('DISTRIBUTION_NOTICE.md'));
  requireValue(entries.length === 1, `Artifact must contain one distribution notice: ${item.file}`);
  const archivedNotice = execFileSync(item.file.endsWith('.zip') ? 'unzip' : 'tar',
    item.file.endsWith('.zip') ? ['-p', path, entries[0]] : ['-xOzf', path, entries[0]]);
  requireValue(sha256(archivedNotice) === sha256(notice), `Artifact notice mismatch: ${item.file}`);
}
process.stdout.write(`Release ${tag}: ${names.size} artifacts, source ${head}, license and notices verified\n`);
