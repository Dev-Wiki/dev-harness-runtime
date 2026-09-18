import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readlink, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCodexHostNamespace } from '../dist/executor/host-namespace.js';

const input = (argv, options = {}) => ({ bubblewrap: process.env.DHR_TEST_BWRAP,
  nodeBinary: process.execPath, executable: '/dhr/target', argv, cwd: '/tmp',
  mounts: [{ source: process.execPath, destination: '/dhr/target' }], tmpfs: [],
  environment: { HOME: '/tmp', PATH: '/usr/bin' }, timeoutMs: 10_000, ...options });

test('host namespace gates PID 1 launch and waits until its process tree is gone',
  { skip: !process.env.DHR_TEST_BWRAP }, async () => {
    const result = await runCodexHostNamespace(input(['-e',
      'process.stdout.write(JSON.stringify({pid:process.pid,env:Object.keys(process.env).sort()}))']));
    assert.equal(result.exitCode, 0);
    assert.equal(result.termination, 'exited');
    assert.equal(result.quiescence, 'confirmed');
    assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), { pid: 1, env: ['HOME', 'PATH', 'PWD'] });
    assert.ok(result.evidence.providerSha256.match(/^[a-f0-9]{64}$/u));
    assert.ok(result.evidence.nodeSha256.match(/^[a-f0-9]{64}$/u));
    const hostPid = Number(/\[(\d+)\]$/u.exec(await readlink('/proc/self/ns/pid'))[1]);
    const hostNet = Number(/\[(\d+)\]$/u.exec(await readlink('/proc/self/ns/net'))[1]);
    assert.notEqual(result.evidence.namespaceIds.pid, hostPid);
    assert.equal(result.evidence.namespaceIds.net, hostNet);
    assert.equal(result.evidence.asPid1, true);
    assert.equal(result.evidence.monitorWaited, true);
  });

test('host namespace exit kills an escaped detached descendant',
  { skip: !process.env.DHR_TEST_BWRAP }, async () => {
    let received = '';
    const server = createServer((socket) => { socket.on('data', (part) => { received += part.toString('utf8'); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const childCode = `setTimeout(()=>{const net=require('node:net');const s=net.connect(${address.port},'127.0.0.1');s.on('connect',()=>s.end('ESCAPED'))},700)`;
      const parentCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'}).unref()`;
      const result = await runCodexHostNamespace(input(['-e', parentCode]));
      assert.equal(result.exitCode, 0, result.stderr.toString('utf8'));
      assert.equal(result.quiescence, 'confirmed');
      await pause(950);
      assert.equal(received, '');
      await new Promise((resolve, reject) => { const socket = connect(address.port, '127.0.0.1');
        socket.on('connect', () => socket.end('HOST_OK')); socket.on('error', reject); socket.on('close', resolve); });
      assert.equal(received, 'HOST_OK');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

test('host namespace cancels a live PID 1 and confirms quiescence',
  { skip: !process.env.DHR_TEST_BWRAP }, async () => {
    const result = await runCodexHostNamespace(input(['-e', 'setInterval(()=>{},1000)'],
      { signal: AbortSignal.timeout(1500) }));
    assert.equal(result.termination, 'aborted');
    assert.equal(result.quiescence, 'confirmed');
  });

test('host namespace dies when its controller process is killed',
  { skip: !process.env.DHR_TEST_BWRAP }, async () => {
    const messages = [];
    let ready;
    const seenReady = new Promise((resolve) => { ready = resolve; });
    const server = createServer((socket) => { socket.on('data', (part) => {
      messages.push(part.toString('utf8'));
      if (messages.includes('READY')) ready();
    }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let controller;
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const target = `const net=require('node:net');const send=(s)=>{const c=net.connect(${address.port},'127.0.0.1');c.on('connect',()=>c.end(s))};send('READY');setTimeout(()=>send('ESCAPED'),800);setTimeout(()=>process.exit(0),2500)`;
      const modulePath = fileURLToPath(new URL('../dist/executor/host-namespace.js', import.meta.url));
      const source = `import {runCodexHostNamespace} from ${JSON.stringify(`file://${modulePath}`)};await runCodexHostNamespace(${JSON.stringify(input(['-e', target], { timeoutMs: 10_000 }))})`;
      controller = spawn(process.execPath, ['--input-type=module', '-e', source],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin' } });
      await Promise.race([seenReady, pause(5000).then(() => { throw new Error('Namespace target did not report readiness'); })]);
      controller.kill('SIGKILL');
      await new Promise((resolve) => controller.once('close', resolve));
      await pause(1100);
      assert.deepEqual(messages, ['READY']);
    } finally {
      controller?.kill('SIGKILL');
      await new Promise((resolve) => server.close(resolve));
    }
  });

test('host namespace rejects broad mounts before starting a process', async () => {
  await assert.rejects(runCodexHostNamespace(input(['--version'], {
    mounts: [{ source: '/', destination: '/dhr/host' }],
  })), { code: process.platform === 'linux' ? 'INVALID_ARGUMENT' : 'PROVIDER_UNAVAILABLE' });
});

test('isolated host namespace cannot reach a host loopback listener but can use its own loopback',
  { skip: !process.env.DHR_TEST_BWRAP }, async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const script = `const net=require('node:net');let reached=false;const outside=net.connect(${address.port},'127.0.0.1');outside.setTimeout(500);outside.on('connect',()=>{reached=true;outside.destroy();finish()});outside.on('error',()=>finish());outside.on('timeout',()=>{outside.destroy();finish()});function finish(){const local=net.createServer((socket)=>socket.end('INTERNAL'));local.listen(0,'127.0.0.1',()=>{const client=net.connect(local.address().port,'127.0.0.1');let text='';client.on('data',(chunk)=>text+=chunk);client.on('end',()=>{local.close();process.stdout.write(JSON.stringify({reached,text}))});client.on('error',()=>process.exit(15))})}`;
      const result = await runCodexHostNamespace(input(['-e', script], { network: 'isolated' }));
      assert.equal(result.exitCode, 0, result.stderr.toString('utf8'));
      assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), { reached: false, text: 'INTERNAL' });
      assert.equal(result.evidence.network, 'isolated');
      const hostNet = Number(/\[(\d+)\]$/u.exec(await readlink('/proc/self/ns/net'))[1]);
      assert.notEqual(result.evidence.namespaceIds.net, hostNet);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

test('isolated host namespace reaches only an explicitly mounted host Unix socket',
  { skip: !process.env.DHR_TEST_BWRAP }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dhr-host-socket-'));
    const socketPath = join(directory, 'broker.sock');
    const server = createServer((socket) => socket.end('BROKER_OK'));
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const script = `const net=require('node:net');const client=net.connect(${JSON.stringify(socketPath)});let text='';client.on('data',(chunk)=>text+=chunk);client.on('end',()=>process.stdout.write(text));client.on('error',(error)=>{process.stderr.write(error.message);process.exit(15)})`;
      const result = await runCodexHostNamespace(input(['-e', script], { network: 'isolated',
        mounts: [...input([]).mounts, { source: directory, destination: directory }] }));
      assert.equal(result.exitCode, 0, result.stderr.toString('utf8'));
      assert.equal(result.stdout.toString('utf8'), 'BROKER_OK');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
