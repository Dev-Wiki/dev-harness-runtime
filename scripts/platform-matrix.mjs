import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPlatformRegistry } from '../build/dist/targets/platforms.js';
import { distributionPlatforms } from '../build/dist/targets/repository.js';

const references = Object.freeze({
  codex: ['Codex', 'K5-P', 'plan/archive/M3/K5-P.md', 'verification/K5-P.md'],
  dsh: ['DSH', 'K6-P', 'plan/archive/M3/K6-P.md', 'verification/K6-P.md'],
  cursor: ['Cursor', 'K7', 'plan/tasks/K7.md', 'verification/K7.md'],
  opencode: ['OpenCode', 'K8', 'plan/tasks/K8.md', 'verification/K8.md'],
  antigravity: ['Antigravity', 'K9', 'plan/tasks/K9.md', 'verification/K9.md'],
  'agent-plugin': ['Portable Agent Plugin', 'K10-G', 'plan/archive/M3/K10-G.md', 'verification/K10-G.md'],
});
const check = process.argv.includes('--check');
const root = resolve(process.argv.find((arg, index) => index >= 2 && arg !== '--check') ?? '.');
const manifest = JSON.parse(await readFile(resolve(root, 'dist/manifest.json'), 'utf8'));
const runtimes = createPlatformRegistry().runtimeRegistry().list();
if (manifest.adapterCompatibility.length !== distributionPlatforms.length || manifest.artifacts.length !== 9) {
  throw new Error('Release manifest must contain six platforms and nine artifacts');
}
const counts = new Map();
for (const artifact of manifest.artifacts) {
  if (!distributionPlatforms.includes(artifact.platform) || !artifact.file.startsWith(`${artifact.platform}/`)
    || artifact.file.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Unsafe artifact path or platform: ${artifact.file}`);
  }
  const bytes = await readFile(resolve(root, 'dist', artifact.file));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== artifact.sha256 || bytes.byteLength !== artifact.size) throw new Error(`Artifact digest mismatch: ${artifact.file}`);
  counts.set(artifact.platform, (counts.get(artifact.platform) ?? 0) + 1);
}
const rows = distributionPlatforms.map((id) => {
  const [label, task, taskPath, evidencePath] = references[id];
  const count = counts.get(id);
  if (!count || !manifest.adapterCompatibility.some((entry) => entry.platform === id)) {
    throw new Error(`Missing platform in release manifest: ${id}`);
  }
  const runtime = runtimes.find((entry) => entry.id === id);
  const capability = runtime === undefined ? id === 'agent-plugin' ? '无独立 Executor' : '未注册' : '需独立宿主 probe';
  return `| ${label} | ${count} | SHA-256 已核对 | ${capability} | ${runtime === undefined ? '关闭' : '待 probe'} | [${task}](${taskPath}) / [验证](${evidencePath}) |`;
});
const content = `# 平台能力证据矩阵\n\n本表由本地 release manifest 的九个实际产物摘要与可信 PlatformRegistry 生成；只表示打包产物和当前注册能力。宿主安装、会话内 Skill 调用及授权隔离见逐任务验证记录，不能从静态包推断。\n\n| 目标 | 产物数 | 静态产物 | RuntimeAdapter | 自动编排 | 证据 |\n|---|---:|---|---|---|---|\n${rows.join('\n')}\n\nCodex / DSH 的 Task Executor 仍须通过真实 fresh Session、结构化结果、取消后静止和逐 Task 授权门禁；其余宿主的安装与调用亦分别报告。Portable 只携带共享 Skill，没有独立 Executor；无可信 Adapter 的运行请求返回 \`CAPABILITY_MISSING\`。对外分发仍受项目许可门禁约束。\n`;
const target = resolve(root, 'docs/PLATFORM_MATRIX.md');
if (check) {
  if (await readFile(target, 'utf8') !== content) throw new Error('PLATFORM_MATRIX.md differs from verified manifest and Registry');
  process.stdout.write(`Checked docs/PLATFORM_MATRIX.md against ${manifest.artifacts.length} verified artifacts\n`);
} else {
  await writeFile(target, content);
  process.stdout.write(`Generated docs/PLATFORM_MATRIX.md from ${manifest.artifacts.length} verified artifacts\n`);
}
