/** Opt-in Codex plugin installation and explicitly invoked Skill smoke. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

assert.equal(process.argv.length, 2, 'Codex plugin smoke does not accept arguments');

const run = (args, options) => new Promise((resolve, reject) => {
  const child = spawn('codex', args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (bytes) => stdout.push(bytes));
  child.stderr.on('data', (bytes) => stderr.push(bytes));
  child.on('error', reject);
  child.on('close', (code, signal) => {
    const result = { code, signal, stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8') };
    if (signal || code !== 0) reject(new Error(JSON.stringify({ args, ...result })));
    else resolve(result);
  });
});

const stage = await mkdtemp(join(tmpdir(), 'dhr-codex-plugin-smoke-'));
try {
  const marketplace = join(stage, 'marketplace');
  const codexHome = join(stage, 'codex-home');
  const project = join(stage, 'project');
  await cp(await realpath(new URL('../.generated/codex/plugin', import.meta.url)), marketplace, { recursive: true });
  await mkdir(codexHome); await mkdir(project);
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  await copyFile(join(sourceHome, 'auth.json'), join(codexHome, 'auth.json'));
  await chmod(codexHome, 0o700); await chmod(join(codexHome, 'auth.json'), 0o600);
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: stage, NO_COLOR: '1' };

  await run(['plugin', 'marketplace', 'add', marketplace, '--json'], { env, cwd: project });
  await run(['plugin', 'add', 'dev-harness@dev-harness-local', '--json'], { env, cwd: project });
  const listed = JSON.parse((await run(['plugin', 'list', '--json'], { env, cwd: project })).stdout);
  const installed = listed.installed.find((entry) => entry.pluginId === 'dev-harness@dev-harness-local');
  assert.equal(installed?.installed, true); assert.equal(installed?.enabled, true);

  const schemaPath = join(stage, 'schema.json');
  const finalPath = join(stage, 'final.json');
  await writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: false,
    required: ['skill', 'authoritativeState', 'forbiddenCommands'], properties: {
      skill: { type: 'string' }, authoritativeState: { type: 'string' },
      forbiddenCommands: { type: 'array', items: { type: 'string' } } } }));
  const prompt = 'Explicitly use $dev-harness:status. Do not run shell commands, inspect repository files, or list MCP resources. '
    + 'Based only on the explicitly invoked Skill content supplied to this thread, return its skill name, the unique authoritative '
    + 'Run state path ending, and the commands this Skill must not call.';
  const executed = await run(['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
    '--output-schema', schemaPath, '--output-last-message', finalPath, '-C', project, '--', prompt], { env, cwd: project });
  const events = executed.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === 'thread.started'));
  assert.equal(events.some((event) => ['command_execution', 'mcp_tool_call'].includes(event.item?.type)), false,
    'Explicit Skill invocation must not require a fallback command or resource lookup');
  const answer = JSON.parse(await readFile(finalPath, 'utf8'));
  assert.equal(answer.skill, 'dev-harness:status');
  assert.match(answer.authoritativeState, /dev-harness-runtime/iu);
  assert.match(answer.authoritativeState, /run\.json/iu);
  const forbidden = answer.forbiddenCommands.join(' ').toLowerCase();
  for (const command of ['run', 'resume', 'reconcile']) assert.ok(forbidden.includes(command));

  await writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: false,
    required: ['skill', 'cliVersion', 'bundledLauncher'], properties: {
      skill: { type: 'string' }, cliVersion: { type: 'string' }, bundledLauncher: { type: 'boolean' } } }));
  const selfCheckPrompt = 'Explicitly use $dev-harness:run for the plugin installation self-check described by that Skill. '
    + 'Run only the same-plugin bundled CLI with --version; do not run --help, run, resume, reconcile, or inspect project files. '
    + 'Return the invoked skill name, exact CLI version, and whether the launcher came from this plugin package.';
  const selfCheck = await run(['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
    '--output-schema', schemaPath, '--output-last-message', finalPath, '-C', project, '--', selfCheckPrompt], { env, cwd: project });
  const selfCheckEvents = selfCheck.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const commands = selfCheckEvents.filter((event) => event.type === 'item.completed'
    && event.item?.type === 'command_execution');
  const successful = commands.filter((event) => event.item?.status === 'completed' && event.item?.exit_code === 0);
  const launcherCommands = successful.filter((event) => /scripts\/dhr\.mjs/u.test(JSON.stringify(event))
    && /--version/u.test(JSON.stringify(event)));
  assert.equal(launcherCommands.length, 1,
    `Plugin self-check must complete one bundled launcher command: ${JSON.stringify(commands)}`);
  assert.equal(commands.some((event) => /\bdhr\s+(?:run|resume|reconcile)\b/u.test(JSON.stringify(event))), false);
  const checked = JSON.parse(await readFile(finalPath, 'utf8'));
  assert.equal(checked.skill, 'dev-harness:run');
  assert.equal(checked.cliVersion, '0.1.0');
  assert.equal(checked.bundledLauncher, true);
  process.stdout.write(`${JSON.stringify({ status: 'passed', pluginId: installed.pluginId, version: installed.version,
    explicitSkill: answer.skill, authoritativeState: true, forbiddenCommands: true,
    bundledCli: checked.cliVersion, runSkill: checked.skill, syntheticOnly: true })}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
