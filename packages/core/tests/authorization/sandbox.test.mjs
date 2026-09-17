import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, chmod, copyFile, access, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createLinuxSandbox, runSandbox, SandboxError } from '../../dist/authorization/sandbox.js';
import { SANDBOX_CONTROL } from '../../dist/authorization/sandbox-control.js';

const binaryPath = process.env.DHR_TEST_BWRAP;
const actualProvider = { skip: process.platform !== 'linux' ? 'Linux provider only'
  : !binaryPath ? 'Set DHR_TEST_BWRAP to an explicitly installed real bubblewrap; no simulated isolation coverage' : false };
const exec = promisify(execFile);
const isCode = code => error => error instanceof SandboxError && error.code === code;
const config = (binary = binaryPath) => ({ binaryPath: binary, toolchainMounts: [dirname(process.execPath)],
  path: `${dirname(process.execPath)}:/usr/bin:/bin` });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dhr-sandbox-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, 'repo');
  await mkdir(join(repoRoot, 'artifacts'), { recursive: true });
  await mkdir(join(repoRoot, '.git', 'dev-harness'), { recursive: true });
  await writeFile(join(repoRoot, 'source.txt'), 'original source');
  await writeFile(join(repoRoot, '.git', 'config'), 'private git data');
  await writeFile(join(repoRoot, '.git', 'dev-harness', 'token'), 'private run token');
  const handle = await createLinuxSandbox(config());
  const options = { cwd: '.', repoRoot, privateGitDir: join(repoRoot, '.git'), writableArtifacts: ['artifacts'], timeoutMs: 5000 };
  return { root, repoRoot, handle, options, run: (script, extra = {}) => runSandbox(handle, {
    ...options, argv: [process.execPath, '-e', script], ...extra }) };
}

test('sandbox capability rejects forged and serialized handles before execution', async () => {
  await assert.rejects(runSandbox({}, {}), isCode('INVALID_SANDBOX'));
  await assert.rejects(runSandbox(JSON.parse('{}'), {}), isCode('INVALID_SANDBOX'));
});

test('real Linux provider returns actual namespace and process lifetime evidence', actualProvider, async t => {
  const f = await fixture(t);
  const result = await f.run('process.stdout.write("ok");process.stderr.write("diagnostic")');
  assert.equal(result.stdout.toString(), 'ok');
  assert.equal(result.stderr.toString(), 'diagnostic');
  assert.equal(result.exitCode, 0);
  assert.equal(result.termination, 'exited');
  assert.equal(result.quiescence, 'confirmed');
  assert.equal(result.namespaceEvidence.pidfdBound, true);
  assert.equal(result.namespaceEvidence.asPid1, true);
  assert.equal(result.namespaceEvidence.monitorWaited, true);
  assert.ok(result.namespaceEvidence.initPid > 1);
  assert.match(result.namespaceEvidence.initStartTime, /^\d+$/);
  assert.deepEqual(Object.keys(result.namespaceEvidence.namespaceIds).sort(), ['cgroup', 'ipc', 'mnt', 'net', 'pid', 'user', 'uts']);
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  await assert.rejects(runSandbox(JSON.parse(JSON.stringify(f.handle)), f.options), isCode('INVALID_SANDBOX'));
});

test('readonly source and git metadata stay protected while artifacts are writable', actualProvider, async t => {
  const f = await fixture(t);
  const result = await f.run(`const fs=require('node:fs');const assert=require('node:assert/strict');
    assert.throws(()=>fs.writeFileSync('source.txt','changed'));
    assert.throws(()=>fs.readFileSync('.git/config'));
    assert.throws(()=>fs.readFileSync('.git/dev-harness/token'));
    fs.writeFileSync('artifacts/output.txt','verified');`);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.equal(await readFile(join(f.repoRoot, 'source.txt'), 'utf8'), 'original source');
  assert.equal(await readFile(join(f.repoRoot, 'artifacts', 'output.txt'), 'utf8'), 'verified');
});

test('host mount-source descriptors are closed before project code executes', actualProvider, async t => {
  const f = await fixture(t);
  const result = await runSandbox(f.handle, { ...f.options, argv: ['/usr/bin/python3', '-I', '-S', '-c',
    "import os; assert not [fd for fd in os.listdir('/proc/self/fd') if int(fd) > 2 and os.path.exists('/proc/self/fd/' + fd)]"] });
  assert.equal(result.exitCode, 0, result.stderr.toString());
});

test('host credentials, host mounts, inherited environment and host PID namespace are absent', actualProvider, async t => {
  const f = await fixture(t);
  const previous = process.env.DHR_SANDBOX_TEST_SECRET;
  process.env.DHR_SANDBOX_TEST_SECRET = 'must-not-cross';
  t.after(() => { if (previous === undefined) delete process.env.DHR_SANDBOX_TEST_SECRET; else process.env.DHR_SANDBOX_TEST_SECRET = previous; });
  const result = await f.run(`const fs=require('node:fs');const assert=require('node:assert/strict');
    assert.equal(process.pid,1);assert.equal(process.env.DHR_SANDBOX_TEST_SECRET,undefined);
    assert.equal(process.env.NODE_OPTIONS,undefined);assert.deepEqual(fs.readdirSync(process.env.HOME),[]);
    for(const p of ['/run','/mnt/c','/init',${JSON.stringify(join(f.root, 'outside-secret'))}])assert.equal(fs.existsSync(p),false);
    assert.equal(process.env.DEV_HARNESS_WORKER,'1');`, { environment: {
    DEV_HARNESS_WORKER: '1', DEV_HARNESS_RUN_ID: 'run-a', DEV_HARNESS_TASK_ID: 'K4-V', DEV_HARNESS_ADAPTER: 'test' } });
  assert.equal(result.exitCode, 0, result.stderr.toString());
});

test('caller cannot inject runtime environment or broaden artifact paths', actualProvider, async t => {
  const f = await fixture(t);
  for (const environment of [{ PATH: '/bin' }, { HOME: '/root' }, { NODE_OPTIONS: '--inspect' }, { DEV_HARNESS_WORKER: '0' }, { DEV_HARNESS_RUN_ID: '../escape' }]) {
    await assert.rejects(f.run('', { environment }), isCode('INVALID_SANDBOX'));
  }
  for (const writableArtifacts of [['.'], ['../outside'], ['.git'], ['artifacts', 'artifacts/nested'], [f.repoRoot]]) {
    await assert.rejects(f.run('', { writableArtifacts }), isCode('UNSAFE_PATH'));
  }
});

test('network namespace cannot connect to a listening host loopback socket', actualProvider, async t => {
  const f = await fixture(t);
  const server = createServer(socket => socket.end('host'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await f.run(`const s=require('node:net').connect(${server.address().port},'127.0.0.1');
    s.on('connect',()=>process.exit(9));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(8),1500);`);
  assert.equal(result.exitCode, 0, result.stderr.toString());
});

test('nested user namespaces are disabled and process capabilities are dropped', actualProvider, async t => {
  const f = await fixture(t);
  const result = await f.run(`const cp=require('node:child_process');const fs=require('node:fs');const assert=require('node:assert/strict');
    assert.notEqual(cp.spawnSync('/usr/bin/unshare',['-Ur','/usr/bin/true']).status,0);
    const status=fs.readFileSync('/proc/self/status','utf8');assert.match(status,/CapEff:\\s+0+\\n/);`);
  assert.equal(result.exitCode, 0, result.stderr.toString());
});

test('PID 1 exit kills detached delayed descendants before the result is trusted', actualProvider, async t => {
  const f = await fixture(t);
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync('artifacts/escaped','bad'),500);setInterval(()=>{},1000)`;
  const result = await f.run(`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],
    {detached:true,stdio:'ignore'}).unref();process.exit(0)`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.quiescence, 'confirmed');
  await delay(700);
  await assert.rejects(access(join(f.repoRoot, 'artifacts', 'escaped')));
});

test('timeout kills namespace init and waits for all descendants', actualProvider, async t => {
  const f = await fixture(t);
  const result = await f.run(`require('node:child_process').spawn(process.execPath,['-e',
    "setTimeout(()=>require('node:fs').writeFileSync('artifacts/late','bad'),1200)"],{detached:true,stdio:'ignore'});
    setInterval(()=>{},1000)`, { timeoutMs: 300 });
  assert.equal(result.termination, 'timeout');
  assert.equal(result.quiescence, 'confirmed');
  await delay(1300);
  await assert.rejects(access(join(f.repoRoot, 'artifacts', 'late')));
});

test('abort and already-aborted signals never return a successful command', actualProvider, async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 300);
  t.after(() => clearTimeout(timer));
  const result = await f.run('setInterval(()=>{},1000)', { signal: abort.signal });
  assert.equal(result.termination, 'aborted');
  assert.equal(result.quiescence, 'confirmed');
  const early = new AbortController(); early.abort();
  const second = await f.run("require('node:fs').writeFileSync('artifacts/not-started','bad')", { signal: early.signal });
  assert.equal(second.termination, 'aborted');
  await assert.rejects(access(join(f.repoRoot, 'artifacts', 'not-started')));
});

test('output overflow is an error rather than truncated successful evidence', actualProvider, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run("process.stdout.write(Buffer.alloc(9*1024*1024));setInterval(()=>{},1000)"), isCode('OUTPUT_LIMIT'));
});

test('artifact symlinks and hardlinks cannot alias readonly source', actualProvider, async t => {
  const f = await fixture(t);
  await symlink('../source.txt', join(f.repoRoot, 'artifacts', 'alias'));
  await assert.rejects(f.run(''), isCode('UNSAFE_PATH'));
  await rm(join(f.repoRoot, 'artifacts', 'alias'));
  await link(join(f.repoRoot, 'source.txt'), join(f.repoRoot, 'artifacts', 'alias'));
  await assert.rejects(f.run(''), isCode('UNSAFE_PATH'));
});

test('artifact FIFOs and sockets are rejected before execution', actualProvider, async t => {
  const f = await fixture(t);
  const path = join(f.repoRoot, 'artifacts', 'host.fifo');
  await exec('/usr/bin/mkfifo', [path]);
  await assert.rejects(f.run(''), isCode('UNSAFE_PATH'));
  await rm(path);
  const server = createServer();
  await new Promise(resolve => server.listen(join(f.repoRoot, 'artifacts', 'host.sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(f.run(''), isCode('UNSAFE_PATH'));
});

test('controller death during both setup gates cannot authorize project execution', actualProvider, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dhr-sandbox-controller-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const python = await realpath('/usr/bin/python3');
  const mounts = [];
  for (const source of ['/usr', root]) {
    const stat = await lstat(source, { bigint: true });
    mounts.push({ source, destination: source, option: source === root ? '--bind' : '--ro-bind',
      dev: String(stat.dev), ino: String(stat.ino) });
  }
  // Fault injection changes only where this real controller dies, never bwrap or
  // the trusted bootstrap. EOF on block-fd must not become command authorization.
  for (const point of ["os.write(block_w, b'1')", "child.stdin.write(b'1')"]) {
    const script = SANDBOX_CONTROL.replace(point, 'os.kill(os.getpid(), signal.SIGKILL)');
    assert.notEqual(script, SANDBOX_CONTROL);
    const child = spawn(python, ['-I', '-S', '-c', script], { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] });
    const errors = [];
    child.stderr.on('data', data => errors.push(data));
    child.stdout.resume();
    child.stdin.on('error', () => {});
    const completion = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    const args = ['--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-net', '--unshare-uts', '--unshare-cgroup',
      '--disable-userns', '--assert-userns-disabled', '--die-with-parent', '--as-pid-1', '--new-session', '--cap-drop', 'ALL',
      '--clearenv', '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev',
      '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64'];
    child.stdin.write(JSON.stringify({ binary: binaryPath, python, args, mounts, tail: ['--chdir', root, '--'],
      argv: [python, '-I', '-S', '-c', "open('unauthorized', 'w').write('executed')"], timeoutMs: 3000 }) + '\n');
    const result = await completion;
    assert.equal(result.signal, 'SIGKILL', Buffer.concat(errors).toString());
    await delay(200);
    await assert.rejects(access(join(root, 'unauthorized')));
  }
});

test('artifact ancestor symlinks and escaping readonly symlinks fail closed', actualProvider, async t => {
  const f = await fixture(t);
  await symlink('artifacts', join(f.repoRoot, 'alias'));
  await assert.rejects(f.run('', { writableArtifacts: ['alias'] }), isCode('UNSAFE_PATH'));
  await rm(join(f.repoRoot, 'alias'));
  await symlink('/etc/passwd', join(f.repoRoot, 'escape'));
  await assert.rejects(f.run(''), isCode('UNSAFE_PATH'));
});

test('readonly host sockets and FIFOs are rejected before any command starts', actualProvider, async t => {
  const f = await fixture(t);
  const socketPath = join(f.repoRoot, 'host.sock');
  const server = createServer();
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(f.run(''), isCode('UNSAFE_PATH'));
  await new Promise(resolve => server.close(resolve));
  await exec('/usr/bin/mkfifo', [join(f.repoRoot, 'host.fifo')]);
  await assert.rejects(f.run(''), isCode('UNSAFE_PATH'));
});

test('binary fingerprint changes invalidate an existing opaque provider', actualProvider, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dhr-sandbox-binary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copiedBinary = join(root, 'bwrap');
  await copyFile(binaryPath, copiedBinary); await chmod(copiedBinary, 0o700);
  const handle = await createLinuxSandbox(config(copiedBinary));
  await chmod(copiedBinary, 0o500);
  await assert.rejects(runSandbox(handle, { argv: ['/usr/bin/true'], cwd: '.', repoRoot: root,
    privateGitDir: join(root, '.git'), writableArtifacts: [], timeoutMs: 1000 }), isCode('PROVIDER_CHANGED'));
});

test('broad host mounts and symlinked provider binaries are rejected', actualProvider, async t => {
  await assert.rejects(createLinuxSandbox({ ...config(), toolchainMounts: ['/home'] }), isCode('UNSAFE_PATH'));
  const root = await mkdtemp(join(tmpdir(), 'dhr-sandbox-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, 'bwrap'); await symlink(binaryPath, linked);
  await assert.rejects(createLinuxSandbox(config(linked)));
});

const expectedSource = () => [{ path: 'source.txt', type: 'file', mode: '100644', deleted: false,
  rawContentHash: createHash('sha256').update('original source').digest('hex'), index: [] }];

test('verification mirror requires exact captured file content, type, mode and complete path set', actualProvider, async t => {
  const f = await fixture(t);
  assert.equal((await f.run('', { expectedFiles: expectedSource() })).exitCode, 0);
  const wrongHash = expectedSource(); wrongHash[0].rawContentHash = '0'.repeat(64);
  await assert.rejects(f.run('', { expectedFiles: wrongHash }), isCode('DRIFT_DETECTED'));
  const wrongMode = expectedSource(); wrongMode[0].mode = '100755';
  await assert.rejects(f.run('', { expectedFiles: wrongMode }), isCode('DRIFT_DETECTED'));
  await assert.rejects(f.run('', { expectedFiles: [{ ...expectedSource()[0], type: 'symlink', mode: '120000',
    symlinkTarget: 'source.txt' }] }), isCode('DRIFT_DETECTED'));
  await assert.rejects(f.run('', { expectedFiles: [...expectedSource(), ...expectedSource()] }), isCode('INVALID_SANDBOX'));
  await assert.rejects(f.run('', { expectedFiles: [] }), isCode('DRIFT_DETECTED'));
  await writeFile(join(f.repoRoot, 'extra.txt'), 'unaccepted');
  await assert.rejects(f.run('', { expectedFiles: expectedSource() }), isCode('DRIFT_DETECTED'));
  await rm(join(f.repoRoot, 'extra.txt'));
  await symlink('source.txt', join(f.repoRoot, 'alias'));
  const symlinkEntry = { path: 'alias', type: 'symlink', mode: '120000', deleted: false, symlinkTarget: 'source.txt', index: [] };
  assert.equal((await f.run('', { expectedFiles: [...expectedSource(), symlinkEntry] })).exitCode, 0);
  await assert.rejects(f.run('', { expectedFiles: [...expectedSource(), { ...symlinkEntry, mode: '100644' }] }), isCode('DRIFT_DETECTED'));
  await rm(join(f.repoRoot, 'alias'));
  await assert.rejects(f.run('', { expectedFiles: [...expectedSource(), { path: 'module', type: 'gitlink', mode: '160000',
    deleted: false, commit: 'a'.repeat(40), index: [] }] }), isCode('CAPABILITY_MISSING'));
});

test('frozen original files overlay changed and deleted paths without modifying real repository', actualProvider, async t => {
  const f = await fixture(t);
  const frozenInputs = [{ path: 'source.txt', bytes: Buffer.from('frozen original') },
    { path: 'docs/Task/K4-V.md', bytes: Buffer.from('original acceptance criteria') }];
  const result = await f.run(`const fs=require('node:fs');const assert=require('node:assert/strict');
    assert.equal(fs.readFileSync('source.txt','utf8'),'frozen original');
    assert.equal(fs.readFileSync('docs/Task/K4-V.md','utf8'),'original acceptance criteria');
    assert.throws(()=>fs.writeFileSync('docs/Task/K4-V.md','weakened'));`, { expectedFiles: expectedSource(), frozenInputs });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.equal(await readFile(join(f.repoRoot, 'source.txt'), 'utf8'), 'original source');
  await assert.rejects(access(join(f.repoRoot, 'docs')));
  for (const path of ['../outside', '.git/config', 'artifacts/criteria']) {
    await assert.rejects(f.run('', { frozenInputs: [{ path, bytes: Buffer.from('bad') }] }), isCode('UNSAFE_PATH'));
  }
});
