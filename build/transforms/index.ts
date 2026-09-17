const TOKENS = new Set(["DHR_PATH", "DHR_COMMAND", "DHR_INVOKE"]);
const TOKEN_PATTERN = /\{\{(DHR_PATH|DHR_COMMAND|DHR_INVOKE)\}\}/g;
const MAX_VALUE_BYTES = 4096;

function hasUnpairedSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

/**
 * Replaces only the three literal {{DHR_*}} tokens, using bare token names as
 * keys. Values are at most 4096 UTF-8 bytes and contain no control characters,
 * line separators, or absolute local path literals (including shell arguments).
 * This is a single substitution pass, not a shell parser or a prose rewrite.
 * CRLF in the source becomes LF; missing or recursively introduced known tokens
 * fail. Unrelated {{tokens}} are preserved. Empty replacement values are allowed.
 */
export function applySkillTransform(source: string, replacements: Readonly<Record<string, string>>): string {
  if (typeof source !== "string" || replacements === null || typeof replacements !== "object") {
    throw new TypeError("Skill transform requires source text and a replacement record");
  }
  const values = new Map<string, string>();
  for (const key of Reflect.ownKeys(replacements)) {
    if (typeof key !== "string" || !TOKENS.has(key)) throw new Error(`Unknown skill replacement key: ${String(key)}`);
    const value = replacements[key];
    if (typeof value !== "string" || hasUnpairedSurrogate(value) || Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES
      // eslint-disable-next-line no-control-regex -- Explicitly reject controls and line separators.
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
      throw new Error(`Skill replacement ${key} must be bounded single-line text`);
    }
    if (/(?:^|[\s="'`(;,|&<>])(?:[/\\]|~[/\\]|[A-Za-z]:[/\\])|file:\/\//iu.test(value)) {
      throw new Error(`Skill replacement ${key} contains an absolute local path`);
    }
    values.set(key, value);
  }
  const result = source.replace(/\r\n/g, "\n").replace(TOKEN_PATTERN, (token: string, key: string) => values.get(key) ?? token);
  if (/\{\{(?:DHR_PATH|DHR_COMMAND|DHR_INVOKE)\}\}/.test(result)) throw new Error("Unresolved skill transform token");
  return result;
}
