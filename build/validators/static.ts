import { Ajv } from 'ajv';
import { isRepoPath, parseContract, type PluginBuildInput, type ValidationReport } from '@dev-harness-runtime/contracts';
import { sha256 } from '../manifests/input.js';

export type ValidationCheck = ValidationReport['checks'][number];
export interface ManifestSpec {
  path: string;
  schema: object;
  versionFields?: Readonly<Record<string, 'releaseVersion' | 'adapterVersion' | 'coreProtocolVersion'>>;
  referenceFields?: readonly string[];
}
export interface StaticSpec {
  requiredFiles: readonly string[];
  allowedFiles: readonly string[];
  manifests: readonly ManifestSpec[];
  skillFiles: readonly string[];
  /** Generated JS may contain checker source or dependency comments; only exact locked bundle bytes may bypass lexical text lint. */
  lockedBundles?: Readonly<Record<string, 'runtimeBundle' | 'adapterBundle'>>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPath = (value: unknown): value is string => typeof value === 'string' && isRepoPath(value);

/** Require an explicit type (or local ref) and close every schema that permits object values. */
function closedSchema(schema: unknown, seen = new Set<object>()): boolean {
  if (schema === false) return true;
  if (!record(schema) || seen.has(schema)) return false;
  seen.add(schema);
  try {
    const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
    if (schema.$ref !== undefined && (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/'))) return false;
    if (!types.length && schema.$ref === undefined) return false;
    if (types.some((type) => !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(String(type)))) return false;
    if ((types.includes('object') || schema.properties !== undefined || schema.patternProperties !== undefined) && schema.additionalProperties !== false) return false;
    if (types.includes('array') && schema.items === undefined) return false;
    for (const key of ['properties', 'patternProperties', 'definitions', '$defs']) {
      if (schema[key] === undefined) continue;
      if (!record(schema[key]) || !Object.values(schema[key]).every((child) => closedSchema(child, seen))) return false;
    }
    for (const key of ['items', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames']) {
      const child = schema[key];
      if (child !== undefined && !(Array.isArray(child) ? child.every((item) => closedSchema(item, seen)) : closedSchema(child, seen))) return false;
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      const children = schema[key];
      if (children !== undefined && (!Array.isArray(children) || !children.every((child) => closedSchema(child, seen)))) return false;
    }
    return true;
  } finally { seen.delete(schema); }
}
function field(value: unknown, path: string): unknown {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(path)) return undefined;
  for (const part of path.split('.')) {
    if ((!record(value) && !Array.isArray(value)) || !Object.hasOwn(value, part)) return undefined;
    value = Reflect.get(value, part);
  }
  return value;
}
function scalar(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || /[\r\n]/u.test(value)) return undefined;
  if (value.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'string' ? parsed : undefined; } catch { return undefined; }
  }
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/u.test(value) ? value.slice(1, -1).replaceAll("''", "'") : undefined;
  if (/^[!&*[{>|%@`]/u.test(value) || /^(?:null|true|false|~|[-+]?\d+(?:\.\d+)?)$/iu.test(value) || /:\s|\s#/u.test(value)) return undefined;
  return value;
}
function frontmatter(text: string): { name: string; description: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const pair = /^(name|description):[ \t]*(.*)$/u.exec(line);
    if (!pair || fields.has(pair[1]!)) return undefined;
    const value = scalar(pair[2]!);
    if (value === undefined) return undefined;
    fields.set(pair[1]!, value);
  }
  const name = fields.get('name'); const description = fields.get('description');
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || !description?.trim() || description.length > 1024) return undefined;
  return { name, description };
}

/** Conservative text lint, not a JavaScript evaluator: runtime path literals are still package findings. */
function absoluteLocalPath(text: string): boolean {
  const scrubbed = text.replace(/\bhttps?:\/\/[^\s<>"'`]+/giu, 'URL')
    .replace(/\$\(git\s+[^)\r\n]*\)(?:\/[A-Za-z0-9._~@+%-]+)*/gu, 'GIT_PATH');
  // JSON/source strings may encode Windows separators twice; neither spelling is portable.
  return /\bfile:\/\//iu.test(scrubbed)
    || /(?:^|[\s"'`=([,;])(?:[A-Za-z]:[\\/]|\\{2,}[^\s\\/]+[\\/]|\/\/[A-Za-z0-9._-]+\/)/u.test(scrubbed)
    || /(?:^|[\s"'`=([,;])\/[A-Za-z0-9._~@+%-]+(?:\/[A-Za-z0-9._~@+%-]+)*\/?(?=$|[\s"'`),;\]}])/u.test(scrubbed);
}

/** Static package checks only; passing cannot establish installation or host execution capability. */
export async function validateStatic(files: ReadonlyMap<string, Uint8Array>, input: PluginBuildInput, spec: StaticSpec): Promise<ValidationCheck[]> {
  const checks: ValidationCheck[] = [];
  const add = (code: string, path: unknown, message: string, severity: 'info' | 'error' = 'error') => {
    checks.push({ code, path: validPath(path) ? path : 'manifest.json', message, severity });
  };
  const lintText = (text: string, path: string) => {
    if (/\b(?:TODO|TBD|FIXME)\b/u.test(text)) add('UNFINISHED_PLACEHOLDER', path, 'Package text contains an unfinished placeholder marker');
    if (absoluteLocalPath(text)) add('ABSOLUTE_LOCAL_PATH', path, 'Package text contains a concrete absolute local path');
  };
  try { parseContract('pluginBuildInput', input); }
  catch { add('INVALID_BUILD_INPUT', 'manifest.json', 'Build input does not satisfy the versioned public contract'); return checks; }
  if (!spec || !Array.isArray(spec.requiredFiles) || !spec.requiredFiles.length || !Array.isArray(spec.allowedFiles) || !spec.allowedFiles.length
    || !Array.isArray(spec.manifests) || !spec.manifests.length || !Array.isArray(spec.skillFiles) || !spec.skillFiles.length) {
    add('INVALID_STATIC_SPEC', 'manifest.json', 'Required files, allowed contents, manifests and Skill files need nonempty explicit specifications'); return checks;
  }
  const list = (values: readonly unknown[], label: string) => {
    const names = new Set<string>();
    for (const path of values) {
      if (!validPath(path)) { add('INVALID_RELATIVE_PATH', path, `${label} contains a noncanonical relative path`); continue; }
      if (names.has(path.toLowerCase())) add('CASE_ALIAS_PATH', path, `${label} repeats a path or its case alias`);
      names.add(path.toLowerCase());
    }
  };
  list([...files.keys()], 'Package'); list(spec.requiredFiles, 'Required files'); list(spec.allowedFiles, 'Allowed files'); list(spec.skillFiles, 'Skill files');
  list(spec.manifests.map((manifest) => manifest?.path), 'Manifests');
  for (const [path, source] of Object.entries(spec.lockedBundles ?? {})) {
    if (!validPath(path) || !spec.allowedFiles.includes(path) || (source !== 'runtimeBundle' && source !== 'adapterBundle')) {
      add('INVALID_STATIC_SPEC', path, 'Locked bundle must be an allowed canonical file bound to an input bundle');
    }
  }
  if (!spec.manifests.some((manifest) => record(manifest?.versionFields) && Object.keys(manifest.versionFields).length > 0)) {
    add('VERSION_BINDING_MISSING', 'manifest.json', 'Static validation needs at least one explicit manifest version binding');
  }
  const mandatory = new Set([...spec.requiredFiles, ...spec.skillFiles, ...spec.manifests.map((manifest) => manifest?.path)]);
  for (const path of mandatory) {
    if (!validPath(path)) continue;
    if (!spec.allowedFiles.includes(path)) add('INVALID_STATIC_SPEC', path, 'A required manifest or Skill is absent from the allowed file set');
    if (!files.has(path)) add('MISSING_REQUIRED_FILE', path, 'Required package file is missing');
  }
  const texts = new Map<string, string>();
  for (const [path, bytes] of files) {
    if (!spec.allowedFiles.includes(path)) add('UNEXPECTED_PACKAGE_CONTENT', path, 'Package file is not in the explicit allowlist');
    if (!(bytes instanceof Uint8Array)) { add('INVALID_PACKAGE_CONTENT', path, 'Package content must be byte data'); continue; }
    const locked = spec.lockedBundles?.[path];
    if (locked !== undefined) {
      if (locked !== 'runtimeBundle' && locked !== 'adapterBundle') {
        add('INVALID_STATIC_SPEC', path, 'Locked bundle references an unsupported input field');
      } else if (sha256(bytes) !== input[locked].sha256) {
        add('BUNDLE_DIGEST_MISMATCH', path, 'Packaged bundle differs from the locked build input');
      }
      continue;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) {
        if (mandatory.has(path)) add('INVALID_TEXT_ENCODING', path, 'Required text contains NUL bytes');
        continue;
      }
      texts.set(path, text);
      lintText(text, path);
    } catch {
      if (spec.skillFiles.includes(path) || spec.manifests.some((manifest) => manifest.path === path)) add('INVALID_TEXT_ENCODING', path, 'Manifest and Skill text must be valid UTF-8');
    }
  }
  const ajv = new Ajv({ strict: true, allErrors: true, ownProperties: true });
  for (const manifest of spec.manifests) {
    if (!manifest || !validPath(manifest.path)) continue;
    if (!record(manifest.schema) || manifest.schema.type !== 'object' || !closedSchema(manifest.schema)) {
      add('OPEN_MANIFEST_SCHEMA', manifest.path, 'Manifest specification must use explicit closed object schemas, including nested objects'); continue;
    }
    let validate;
    try { validate = ajv.compile(manifest.schema); }
    catch { add('INVALID_MANIFEST_SCHEMA', manifest.path, 'Manifest schema is unsupported by strict JSON Schema validation'); continue; }
    const text = texts.get(manifest.path); if (text === undefined) continue;
    let value: unknown;
    try { value = JSON.parse(text); } catch { add('INVALID_MANIFEST', manifest.path, 'Manifest is not valid JSON'); continue; }
    const lintValues = (item: unknown): void => {
      if (typeof item === 'string') lintText(item, manifest.path);
      else if (Array.isArray(item)) item.forEach(lintValues);
      else if (record(item)) Object.values(item).forEach(lintValues);
    };
    lintValues(value);
    if (!validate(value)) {
      for (const error of validate.errors ?? []) add(error.keyword === 'additionalProperties' ? 'UNSUPPORTED_MANIFEST_FIELD' : 'INVALID_MANIFEST', manifest.path,
        `Manifest schema rejected ${error.instancePath || '/'} (${error.keyword})`);
    }
    if (manifest.versionFields !== undefined && !record(manifest.versionFields)) add('INVALID_STATIC_SPEC', manifest.path, 'Version bindings must be an explicit field map');
    for (const [path, source] of Object.entries(manifest.versionFields ?? {})) {
      if ((source !== 'releaseVersion' && source !== 'adapterVersion' && source !== 'coreProtocolVersion') || field(value, path) !== input[source]) {
        add('VERSION_MISMATCH', manifest.path, 'Manifest version does not match its build input binding');
      }
    }
    if (manifest.referenceFields !== undefined && !Array.isArray(manifest.referenceFields)) add('INVALID_STATIC_SPEC', manifest.path, 'Reference fields must be an explicit list');
    else for (const path of manifest.referenceFields ?? []) {
      const target = field(value, path); const refs = Array.isArray(target) ? target : [target];
      if (!refs.length) add('INVALID_MANIFEST_REFERENCE', manifest.path, 'Declared reference field is empty');
      for (const ref of refs) {
        if (!validPath(ref)) add('INVALID_RELATIVE_PATH', manifest.path, 'Manifest references must be exact canonical package-relative paths');
        else if (!files.has(ref)) add('MISSING_MANIFEST_REFERENCE', manifest.path, 'Manifest references a missing or differently cased package file');
      }
    }
  }
  const names = new Set<string>();
  for (const path of spec.skillFiles) {
    const text = texts.get(path); if (text === undefined) continue;
    const front = frontmatter(text);
    if (!front) { add('INVALID_SKILL_FRONTMATTER', path, 'Skill needs unique scalar name and description fields, a valid name, and no unsupported YAML syntax'); continue; }
    if (names.has(front.name)) add('DUPLICATE_SKILL_NAME', path, 'Skill name is repeated in the package');
    lintText(front.description, path);
    names.add(front.name);
  }
  if (!checks.some((check) => check.severity === 'error')) add('STATIC_VALIDATION_PASSED', spec.manifests[0]!.path, 'Manifest, paths, Skills, contents, versions and portable text checks passed', 'info');
  return checks;
}
