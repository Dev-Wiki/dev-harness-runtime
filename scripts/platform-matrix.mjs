import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createPlatformRegistry } from '../build/dist/targets/platforms.js';
import { distributionPlatforms } from '../build/dist/targets/repository.js';

const references = Object.freeze({
  codex: ['Codex', 'K5-P', 'plan/archive/M3/K5-P.md', 'verification/K5-P.md'],
  dsh: ['DSH', 'K6-P', 'plan/archive/M3/K6-P.md', 'verification/K6-P.md'],
  cursor: ['Cursor', 'K7', 'plan/archive/M3/K7.md', 'verification/K7.md'],
  opencode: ['OpenCode', 'K8', 'plan/archive/M3/K8.md', 'verification/K8.md'],
  antigravity: ['Antigravity', 'K9', 'plan/archive/M3/K9.md', 'verification/K9.md'],
  'agent-plugin': ['Portable Agent Plugin', 'K10-G', 'plan/archive/M3/K10-G.md', 'verification/K10-G.md'],
});
const check = process.argv.includes('--check');
const root = resolve(process.argv.find((arg, index) => index >= 2 && arg !== '--check') ?? '.');
const manifest = JSON.parse(await readFile(resolve(root, 'dist/manifest.json'), 'utf8'));
const { stdout: head } = await promisify(execFile)('git', ['-C', root, 'rev-parse', 'HEAD']);
if (manifest.sourceCommit !== head.trim()) throw new Error('Release manifest belongs to another source commit; clean and rebuild local artifacts');
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
const data = distributionPlatforms.map((id) => {
  const [label, task, taskPath, evidencePath] = references[id];
  const count = counts.get(id);
  if (!count || !manifest.adapterCompatibility.some((entry) => entry.platform === id)) {
    throw new Error(`Missing platform in release manifest: ${id}`);
  }
  return { id, label, task, taskPath, evidencePath, count,
    registered: runtimes.some((entry) => entry.id === id) };
});
const render = (language) => {
  const english = language === 'en';
  const rows = data.map(({ id, label, task, taskPath, evidencePath, count, registered }) => {
    const capability = registered ? english ? 'Requires independent host probe' : '需独立宿主 probe'
      : id === 'agent-plugin' ? english ? 'No independent Executor' : '无独立 Executor'
        : english ? 'Not registered' : '未注册';
    const orchestration = registered ? english ? 'Pending probe' : '待 probe' : english ? 'Disabled' : '关闭';
    return `| ${label} | ${count} | ${english ? 'SHA-256 verified' : 'SHA-256 已核对'} | ${capability} | ${orchestration} | [${task}](${taskPath}) / [${english ? 'Verification' : '验证'}](${evidencePath}) |`;
  });
  if (english) return `# Platform capability evidence matrix\n\n[English](PLATFORM_MATRIX.en.md) | [简体中文](PLATFORM_MATRIX.md)\n\nThis table is generated from the nine actual artifact digests in the local release manifest and the trusted PlatformRegistry. It describes packaging artifacts and the default Registry only, not a substitute for host capability probes. Host installation, in-session Skill invocation, and authorization isolation are documented in the per-task verification records.\n\n| Target | Artifacts | Static artifacts | RuntimeAdapter | Automatic orchestration | Evidence |\n|---|---:|---|---|---|---|\n${rows.join('\n')}\n\nThe packaged Codex / DSH CLI can register a Task Executor after a trusted host probe passes; see [K5](verification/K5.md) and [K6](verification/K6.md). “Not registered / Disabled” in this table means only that the default Registry does not inject host capabilities. Installation and invocation for other hosts are reported separately. Portable carries shared Skills only and has no independent Executor; run requests without a trusted Adapter return \`CAPABILITY_MISSING\`. External distribution requires the project license, third-party notices, committed sources, and digest gates.\n`;
  return `# 平台能力证据矩阵\n\n[简体中文](PLATFORM_MATRIX.md) | [English](PLATFORM_MATRIX.en.md)\n\n本表由本地 release manifest 的九个实际产物摘要与可信 PlatformRegistry 生成；只表示打包产物和默认 Registry，不代替宿主能力探测。宿主安装、会话内 Skill 调用及授权隔离见逐任务验证记录。\n\n| 目标 | 产物数 | 静态产物 | RuntimeAdapter | 自动编排 | 证据 |\n|---|---:|---|---|---|---|\n${rows.join('\n')}\n\nCodex / DSH 包内 CLI 能在可信宿主 probe 通过后注册 Task Executor，分别见 [K5](verification/K5.md) 与 [K6](verification/K6.md)；表中的“未注册 / 关闭”仅表示默认 Registry 不注入宿主能力。其余宿主的安装与调用分别报告。Portable 只携带共享 Skill，没有独立 Executor；无可信 Adapter 的运行请求返回 \`CAPABILITY_MISSING\`。对外分发须通过项目许可、第三方声明、已提交来源和摘要门禁。\n`;
};
for (const language of ['zh-CN', 'en']) {
  const name = language === 'en' ? 'PLATFORM_MATRIX.en.md' : 'PLATFORM_MATRIX.md';
  const target = resolve(root, 'docs', name);
  const content = render(language);
  if (check) {
    if (await readFile(target, 'utf8') !== content) throw new Error(`${name} differs from verified manifest and Registry`);
    process.stdout.write(`Checked docs/${name} against ${manifest.artifacts.length} verified artifacts\n`);
  } else {
    await writeFile(target, content);
    process.stdout.write(`Generated docs/${name} from ${manifest.artifacts.length} verified artifacts\n`);
  }
}
