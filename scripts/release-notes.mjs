import { readFile } from 'node:fs/promises';

const [tag, ...options] = process.argv.slice(2);
let language = 'zh-CN';
if (options.length !== 0) {
  if (options.length !== 2 || options[0] !== '--language' || !['zh-CN', 'en'].includes(options[1])) {
    throw new Error('Expected optional --language zh-CN|en');
  }
  language = options[1];
}
const source = language === 'en' ? 'CHANGELOG.en.md' : 'CHANGELOG.md';
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag ?? '')) {
  throw new Error('Expected a SemVer release tag');
}

const changelog = await readFile(new URL(`../${source}`, import.meta.url), 'utf8');
const sections = changelog.split(/^## /mu).slice(1);
const section = sections.find((item) => item.startsWith(`${tag} — `));
if (!section) throw new Error(`${source} has no section for ${tag}`);
const body = section.slice(section.indexOf('\n') + 1).trim();
if (!body) throw new Error(`${source} section for ${tag} is empty`);
process.stdout.write(`${language === 'en' ? 'Release' : '发布'} ${tag}\n\n${body}\n`);
