import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { stat } from 'node:fs/promises';
import test from 'node:test';
import { createCodexModelBroker } from '../dist/executor/model-broker.js';
import { runIsolatedModelHost } from '../dist/executor/isolated-model-host.js';

async function request(socketPath, firstLine, payload = '') {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let text = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Test proxy timed out')));
    socket.on('connect', () => socket.write(`${firstLine}\r\nHost: model.example:443\r\n\r\n${payload}`));
    socket.on('data', (chunk) => { text += chunk.toString('latin1'); if (payload && text.includes(payload)) socket.end(); });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
}

test('model broker forwards only exact HTTPS CONNECT destinations through a trusted upstream',
  { skip: process.platform === 'win32' ? 'Unix socket broker is supported on Linux only' : false }, async () => {
  const seen = [];
  const upstream = createServer((socket) => {
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString('latin1');
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      seen.push(pending.slice(0, end));
      const rest = pending.slice(end + 4);
      pending = '';
      socket.removeAllListeners('data');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest) socket.write(rest);
      socket.on('data', (bytes) => socket.write(bytes));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  let broker;
  try {
    broker = await createCodexModelBroker({ allowedHosts: ['model.example'],
      upstreamProxy: `http://127.0.0.1:${address.port}` });
    assert.equal((await stat(broker.directory)).mode & 0o077, 0);
    const allowed = await request(broker.socketPath, 'CONNECT model.example:443 HTTP/1.1', 'PING');
    assert.match(allowed, /^HTTP\/1\.1 200 Connection Established/u);
    assert.ok(allowed.endsWith('PING'));
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^CONNECT model\.example:443 HTTP\/1\.1/u);
    for (const line of ['CONNECT github.com:443 HTTP/1.1', 'CONNECT model.example:80 HTTP/1.1',
      'GET https://model.example/ HTTP/1.1']) {
      assert.match(await request(broker.socketPath, line), /^HTTP\/1\.1 403 Forbidden/u);
    }
    assert.deepEqual(broker.audit(), { allowedHosts: ['model.example'], connected: { 'model.example': 1 }, denied: 3 });
    assert.equal(seen.length, 1);
  } finally {
    await broker?.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
  await assert.rejects(stat(broker.directory), { code: 'ENOENT' });
});

test('model broker rejects broad or malformed destination grants before listening', async () => {
  for (const hosts of [['*'], ['.example.com'], ['model.example', 'model.example'], ['model.example:443'], ['127.0.0.1']]) {
    await assert.rejects(createCodexModelBroker({ allowedHosts: hosts }), { code: 'INVALID_ARGUMENT' });
  }
});

test('isolated model host cancellation confirms quiescence and closes its broker',
  { skip: !process.env.DHR_TEST_BWRAP }, async () => {
    const result = await runIsolatedModelHost({ bubblewrap: process.env.DHR_TEST_BWRAP,
      nodeBinary: process.execPath, executable: '/dhr/target', argv: ['-e', 'setInterval(()=>{},1000)'], cwd: '/tmp',
      mounts: [{ source: process.execPath, destination: '/dhr/target' }], tmpfs: [],
      environment: { HOME: '/tmp', PATH: '/usr/bin' }, timeoutMs: 10_000,
      signal: AbortSignal.timeout(3000) }, { allowedHosts: ['model.example'] });
    assert.equal(result.termination, 'aborted');
    assert.equal(result.quiescence, 'confirmed');
    assert.equal(result.evidence.network, 'isolated');
    assert.deepEqual(result.brokerAudit.connected, {});
  });

test('isolated host routes only its model CONNECT through the mounted Unix broker',
  { skip: !process.env.DHR_TEST_BWRAP }, async () => {
    let directHits = 0;
    const outside = createServer((socket) => { directHits++; socket.destroy(); });
    await new Promise((resolve) => outside.listen(0, '127.0.0.1', resolve));
    const directAddress = outside.address();
    assert.ok(directAddress && typeof directAddress !== 'string');
    const upstream = createServer((socket) => {
      let pending = '';
      socket.on('data', (part) => {
        pending += part.toString('latin1');
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const rest = pending.slice(end + 4);
        pending = '';
        socket.removeAllListeners('data');
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest) socket.write(rest);
        socket.on('data', (bytes) => socket.write(bytes));
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const address = upstream.address();
      assert.ok(address && typeof address !== 'string');
      const target = `const net=require('node:net');const u=new URL(process.env.HTTPS_PROXY);let direct=false;const test=net.connect(${directAddress.port},'127.0.0.1');test.setTimeout(500);test.on('connect',()=>{direct=true;test.destroy();next()});test.on('error',next);test.on('timeout',()=>{test.destroy();next()});function next(){const s=net.connect(Number(u.port),u.hostname);let data='';let tunnel=false;s.on('connect',()=>s.write('CONNECT model.example:443 HTTP/1.1\\r\\nHost: model.example:443\\r\\n\\r\\n'));s.on('data',(chunk)=>{data+=chunk.toString('latin1');if(!tunnel&&data.includes('\\r\\n\\r\\n')){tunnel=true;s.write('PING')}else if(tunnel&&data.includes('PING')){process.stdout.write(JSON.stringify({direct,proxy:u.hostname,echo:true}));s.end()}});s.on('error',()=>process.exit(14))}`;
      const result = await runIsolatedModelHost({ bubblewrap: process.env.DHR_TEST_BWRAP,
        nodeBinary: process.execPath, executable: '/dhr/target', argv: ['-e', target], cwd: '/tmp',
        mounts: [{ source: process.execPath, destination: '/dhr/target' }], tmpfs: [],
        environment: { HOME: '/tmp', PATH: '/usr/bin' }, timeoutMs: 10_000 },
      { allowedHosts: ['model.example'], upstreamProxy: `http://127.0.0.1:${address.port}` });
      assert.equal(result.exitCode, 0, result.stderr.toString('utf8'));
      assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), { direct: false, proxy: '127.0.0.1', echo: true });
      assert.equal(result.evidence.network, 'isolated');
      assert.deepEqual(result.brokerAudit.connected, { 'model.example': 1 });
      assert.equal(directHits, 0);
    } finally {
      await new Promise((resolve) => upstream.close(resolve));
      await new Promise((resolve) => outside.close(resolve));
    }
  });
