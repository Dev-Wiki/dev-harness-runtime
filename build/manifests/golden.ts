import { readFile, writeFile } from 'node:fs/promises';
import { canonicalJson } from './input.js';

/** Golden snapshots change only when the caller explicitly opts into an update. */
export async function compareGolden(path: string, snapshot: unknown, options: { update?: boolean } = {}): Promise<void> {
  const expected = `${canonicalJson(snapshot)}\n`;
  if (options.update === true) {
    await writeFile(path, expected, { encoding: 'utf8' });
    return;
  }
  let actual: string;
  try { actual = await readFile(path, 'utf8'); }
  catch { throw new Error(`Golden snapshot is missing: ${path}; explicit update required`); }
  if (actual !== expected) throw new Error(`Golden snapshot drift: ${path}; explicit update required`);
}
