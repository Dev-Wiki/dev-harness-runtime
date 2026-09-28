import { readFile } from 'node:fs/promises';

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag ?? '')) {
  throw new Error('Expected a SemVer release tag');
}

const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const sections = changelog.split(/^## /mu).slice(1);
const section = sections.find((item) => item.startsWith(`${tag} — `));
if (!section) throw new Error(`CHANGELOG.md has no section for ${tag}`);
const body = section.slice(section.indexOf('\n') + 1).trim();
if (!body) throw new Error(`CHANGELOG.md section for ${tag} is empty`);
process.stdout.write(`发布 ${tag}\n\n${body}\n`);
