import { createCodexModelBroker, type CodexModelBrokerOptions } from './model-broker.js';
import { CodexHostNamespaceError, runCodexHostNamespace,
  type CodexHostNamespaceInput, type CodexHostNamespaceResult } from './host-namespace.js';

const port = 18643;
const relaySource = String.raw`
const net = require('node:net');
const server = net.createServer((client) => {
  const upstream = net.connect('/dhr/model-broker/broker.sock');
  client.on('error', () => client.destroy());
  upstream.on('error', () => { client.destroy(); upstream.destroy(); });
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream); upstream.pipe(client);
});
server.on('error', () => process.exit(125));
server.listen(18643, '127.0.0.1', () => process.stdout.write('DHR_MODEL_RELAY_READY\n'));
`;
const launcherSource = String.raw`
if (process.pid !== 1) process.exit(125);
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const relay = spawn('/dhr/node', ['-e', ${JSON.stringify(relaySource)}],
  { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: '/usr/bin' } });
let ready = false; let output = '';
const timer = setTimeout(() => process.exit(125), 10000);
relay.on('error', () => process.exit(125));
relay.on('exit', () => { if (!ready) process.exit(125); });
relay.stdout.on('data', (bytes) => {
  output += bytes.toString('utf8');
  if (output.length > 128) process.exit(125);
  if (output === 'DHR_MODEL_RELAY_READY\n') {
    ready = true; clearTimeout(timer); relay.stdout.destroy();
    for (const name of fs.readdirSync('/proc/self/fd')) {
      const fd = Number(name);
      if (fd > 2) { try { fs.closeSync(fd); } catch {} }
    }
    process.execve(process.argv[1], process.argv.slice(1), process.env);
  }
});
`;

export interface IsolatedModelHostResult extends CodexHostNamespaceResult {
  readonly brokerAudit: { readonly allowedHosts: readonly string[];
    readonly connected: Readonly<Record<string, number>>; readonly denied: number };
}

/** Give the Codex namespace loopback access to a private, exact-host model broker and no other network. */
export async function runIsolatedModelHost(input: CodexHostNamespaceInput,
  brokerOptions: CodexModelBrokerOptions): Promise<IsolatedModelHostResult> {
  if (input.network === 'shared' || input.executable === '/dhr/launcher'
    || input.mounts.some((mount) => mount.destination === '/dhr/launcher' || mount.destination === '/dhr/model-broker')) {
    throw new CodexHostNamespaceError('INVALID_ARGUMENT', 'Isolated model host has a conflicting network or launcher mount');
  }
  const broker = await createCodexModelBroker(brokerOptions);
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const result = await runCodexHostNamespace({ ...input, network: 'isolated', executable: '/dhr/launcher',
      argv: ['-e', launcherSource, input.executable, ...input.argv],
      environment: { ...input.environment, HTTPS_PROXY: endpoint, HTTP_PROXY: endpoint,
        ALL_PROXY: endpoint, NO_PROXY: '' },
      mounts: [...input.mounts,
        { source: input.nodeBinary, destination: '/dhr/launcher' },
        { source: broker.directory, destination: '/dhr/model-broker' }],
    });
    return { ...result, brokerAudit: broker.audit() };
  } finally { await broker.close(); }
}
