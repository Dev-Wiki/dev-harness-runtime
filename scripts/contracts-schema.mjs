import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contractSchemas } from '../packages/contracts/dist/index.js';

const root = new URL('../packages/contracts/schemas/', import.meta.url);
const write = process.argv.includes('--write');
if (process.argv.slice(2).some((arg) => !['--write', '--check'].includes(arg))) throw new Error('Use --write or --check');
if (write) mkdirSync(root, { recursive: true });
for (const [name, schema] of Object.entries(contractSchemas)) {
  const file = new URL(`${name}.schema.json`, root);
  const text = `${JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', title: name, ...schema }, null, 2)}\n`;
  if (write) writeFileSync(file, text);
  else if (readFileSync(file, 'utf8') !== text) throw new Error(`Stale schema: ${fileURLToPath(file)}; build then run pnpm schemas:write`);
}
const expected = Object.keys(contractSchemas).map((name) => `${name}.schema.json`).sort();
if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(expected)) throw new Error('Unexpected schema files');
console.log(`${expected.length} contract schemas ${write ? 'written' : 'verified'}`);
