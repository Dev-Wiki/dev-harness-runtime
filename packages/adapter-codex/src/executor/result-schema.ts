import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskExecutionResultSchema, validateResultForRequest,
  type TaskExecutionRequest, type TaskExecutionResult } from '@dev-harness-runtime/contracts';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Codex's model-facing schema is derived from the public contract. The contract
 * has a top-level union and optional properties; Structured Outputs requires an
 * object root and required properties, so optional fields become nullable here.
 * Core still validates the original, stricter contract after decoding.
 */
function modelSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelSchema);
  if (!object(value)) return value;
  const converted: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (['$schema', 'title', 'format', 'uniqueItems'].includes(key)) continue;
    if (key === 'const') { converted.enum = [child]; continue; }
    if (key === 'properties' && object(child)) {
      const required = new Set(Array.isArray(value.required) ? value.required : []);
      converted.properties = Object.fromEntries(Object.entries(child).map(([name, schema]) => {
        const item = modelSchema(schema);
        return [name, required.has(name) ? item : { anyOf: [item, { type: 'null' }] }];
      }));
      converted.required = Object.keys(child);
      converted.additionalProperties = false;
      continue;
    }
    if (key === 'required' || key === 'additionalProperties') continue;
    converted[key] = modelSchema(child);
  }
  return converted;
}

export const CODEX_RESULT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: { result: modelSchema(TaskExecutionResultSchema) },
  required: ['result'],
});

/** Give one fresh Codex process a private schema file, then remove that file. */
export async function withCodexResultSchema<T>(run: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dhr-codex-schema-'));
  try {
    const path = join(directory, 'result.schema.json');
    await writeFile(path, `${JSON.stringify(CODEX_RESULT_SCHEMA)}\n`, { flag: 'wx', mode: 0o600 });
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Decode the model envelope, then return only an independently validated Core result. */
export function decodeCodexResultEnvelope(value: unknown, request: TaskExecutionRequest): TaskExecutionResult {
  if (!object(value) || Object.keys(value).length !== 1 || !object(value.result)) {
    throw new Error('Codex result envelope must contain exactly one result object');
  }
  const result = { ...value.result };
  for (const key of ['rawResultRef', 'reason', 'commitIntent', 'closure']) {
    if (result[key] === null) delete result[key];
  }
  return validateResultForRequest(request, result);
}
