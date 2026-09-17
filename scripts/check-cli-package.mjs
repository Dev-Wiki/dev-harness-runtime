import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPlanningFixture } from '../packages/core/tests/result/helpers-planning.mjs';

// Run through pnpm so npm_execpath identifies the already-selected pnpm version.
const pnpm = process.env.npm_execpath;
if (!pnpm || !/pnpm/i.test(pnpm)) throw new Error('Use pnpm test:cli-package');
const scratch = mkdtempSync(join(tmpdir(), 'dhr-cli-package-'));
function run(args, cwd) {
  const result = spawnSync(process.execPath, [pnpm, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
try {
  run(['pack', '--pack-destination', scratch], resolve('packages/cli'));
  const archive = readdirSync(scratch).find((name) => name.endsWith('.tgz'));
  assert.ok(archive, 'CLI archive missing');
  // Install the actual tarball in a fresh project, with no workspace links or scripts.
  run(['add', '--offline', '--ignore-scripts', '--store-dir', join(scratch, 'store'), join(scratch, archive)], scratch);
  const packageRoot = join(scratch, 'node_modules/@dev-harness-runtime/cli');
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(metadata.bin), ['dhr']);
  assert.equal(metadata.private, true);
  assert.deepEqual(metadata.dependencies ?? {}, {}, 'Installed CLI must not resolve runtime packages from an external registry');
  const entry = join(packageRoot, metadata.bin.dhr);
  assert.ok(readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n'));
  for (const flag of ['--help', '--version']) {
    const result = spawnSync(process.execPath, [entry, flag], { cwd: dirname(scratch), encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, flag === '--help' ? /用法: dhr/ : /^0\.1\.0\n$/);
  }
  assert.ok(readdirSync(join(scratch, 'node_modules/.bin')).some((name) => name === 'dhr' || name === 'dhr.cmd'));
  const fixtureRoot = join(scratch, 'project'); mkdirSync(fixtureRoot);
  const documents = (await createPlanningFixture()).beforeFiles;
  documents.set('AGENTS.md', Buffer.from('# Rules\n[Git workflow](docs/GIT_WORKFLOW.md).\n'));
  documents.set('HARNESS.md', Buffer.from('# HARNESS\n\n## 已确认命令\n\n| 用途 | 命令 | 状态 |\n|---|---|---|\n| full | `node --test` | confirmed |\n'));
  for (const [path, bytes] of documents) {
    const target = join(fixtureRoot, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  }
  const initialized = spawnSync('git', ['init', '--quiet', fixtureRoot], { encoding: 'utf8' });
  assert.ifError(initialized.error); assert.equal(initialized.status, 0, initialized.stderr);
  const doctor = spawnSync(process.execPath, [entry, 'doctor', '--project', fixtureRoot], { cwd: dirname(scratch), encoding: 'utf8' });
  assert.ifError(doctor.error); assert.equal(doctor.status, 2, doctor.stderr); assert.equal(doctor.stderr, '');
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.project, fixtureRoot); assert.equal(report.planning.tasks, 3);
  assert.ok(report.issues.some((issue) => issue.code === 'CAPABILITY_MISSING'));
  assert.ok(report.adapters.every((adapter) => adapter.available === false));
  const refused = spawnSync(process.execPath, [entry, 'run', '--adapter', 'codex', '--next'], { cwd: fixtureRoot, encoding: 'utf8' });
  assert.ifError(refused.error); assert.equal(refused.status, 2); assert.match(refused.stderr, /^CAPABILITY_MISSING:/u);
  assert.deepEqual(readdirSync(join(fixtureRoot, '.git')).filter((name) => name === 'dev-harness-runtime'), []);
  process.stdout.write('CLI tarball installed offline; bin/help/version, bundled Core discovery/Planning and capability refusal passed.\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
