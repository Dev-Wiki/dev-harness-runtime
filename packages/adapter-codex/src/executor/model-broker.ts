import { createServer, connect, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';

export class CodexModelBrokerError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'PROVIDER_UNAVAILABLE', message: string) {
    super(message); this.name = 'CodexModelBrokerError';
  }
}

export interface CodexModelBrokerOptions {
  readonly allowedHosts: readonly string[];
  readonly upstreamProxy?: string;
}
export interface CodexModelBroker {
  readonly directory: string;
  readonly socketPath: string;
  audit(): { allowedHosts: readonly string[]; connected: Readonly<Record<string, number>>; denied: number };
  close(): Promise<void>;
}

const validHost = (value: string): boolean => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(value)
  && value.split('.').every((part) => part.length > 0 && part.length <= 63 && !part.startsWith('-') && !part.endsWith('-'));
const fail = (code: CodexModelBrokerError['code'], message: string): never => { throw new CodexModelBrokerError(code, message); };
const headerLimit = 8192;

interface Header { readonly head: string; readonly rest: Buffer }
function readHeader(socket: Socket): Promise<Header> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const cleanup = (): void => { socket.off('data', data); socket.off('error', error); socket.off('close', closed); clearTimeout(timer); };
    const error = (reason: Error): void => { cleanup(); reject(reason); };
    const closed = (): void => error(new Error('Proxy peer closed before its header'));
    const data = (chunk: Buffer): void => {
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) {
        if (bytes.byteLength > headerLimit) error(new Error('Proxy header exceeded 8 KiB'));
        return;
      }
      if (end > headerLimit) return error(new Error('Proxy header exceeded 8 KiB'));
      socket.pause(); cleanup();
      resolve({ head: bytes.subarray(0, end).toString('latin1'), rest: bytes.subarray(end + 4) });
    };
    const timer = setTimeout(() => error(new Error('Proxy header timed out')), 10_000);
    socket.on('data', data); socket.once('error', error); socket.once('close', closed);
  });
}

function parseUpstream(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('INVALID_ARGUMENT', 'Model upstream proxy URL is malformed'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !validHost(parsed.hostname.toLowerCase())
    || parsed.pathname !== '/' || parsed.search || parsed.hash
    || (parsed.port && (!/^\d+$/u.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535))) {
    fail('INVALID_ARGUMENT', 'Model upstream proxy must be an HTTP(S) host and port');
  }
  return parsed;
}
function dial(host: string, port: number, tls: boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tls ? connectTls({ host, port, servername: host }) : connect({ host, port });
    const event = tls ? 'secureConnect' : 'connect';
    const cleanup = (): void => { clearTimeout(timer); socket.off('error', failed); };
    const failed = (error: Error): void => { cleanup(); socket.destroy(); reject(error); };
    const timer = setTimeout(() => failed(new Error('Model proxy connection timed out')), 10_000);
    socket.once(event, () => { cleanup(); socket.pause(); resolve(socket); });
    socket.once('error', failed);
  });
}
function deny(socket: Socket, code: number): void {
  socket.end(`HTTP/1.1 ${code} ${code === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/** A private Unix socket permits only HTTPS CONNECT to exact model hosts. It never accepts project-supplied destinations. */
export async function createCodexModelBroker(options: CodexModelBrokerOptions): Promise<CodexModelBroker> {
  if (!Array.isArray(options.allowedHosts) || options.allowedHosts.length < 1 || options.allowedHosts.length > 16
    || options.allowedHosts.some((host) => typeof host !== 'string' || host !== host.toLowerCase()
      || !validHost(host) || !host.includes('.') || !/[a-z]/u.test(host))
    || new Set(options.allowedHosts).size !== options.allowedHosts.length) {
    fail('INVALID_ARGUMENT', 'Model broker requires distinct exact DNS host names');
  }
  const upstream = parseUpstream(options.upstreamProxy);
  const allowed = new Set(options.allowedHosts);
  const connections = new Map<string, number>();
  const active = new Set<Socket>();
  let denied = 0;
  let closed = false;
  const directory = await mkdtemp(join(tmpdir(), 'dhr-codex-model-broker-'));
  const socketPath = join(directory, 'broker.sock');
  const server = createServer((client) => {
    active.add(client);
    client.on('error', () => client.destroy());
    client.on('close', () => active.delete(client));
    client.setTimeout(120_000, () => client.destroy());
    void (async () => {
      if (active.size > 64) { denied++; return deny(client, 403); }
      const request = await readHeader(client);
      const first = request.head.split('\r\n', 1)[0] ?? '';
      const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/u.exec(first);
      const host = match?.[1];
      if (!host || !allowed.has(host) || !validHost(host)) { denied++; return deny(client, 403); }
      const remote = await dial(upstream?.hostname ?? host,
        Number(upstream?.port || (upstream?.protocol === 'https:' ? 443 : upstream ? 80 : 443)), upstream?.protocol === 'https:');
      if (closed || client.destroyed) { remote.destroy(); return; }
      active.add(remote);
      remote.on('error', () => remote.destroy());
      remote.on('close', () => active.delete(remote));
      remote.setTimeout(120_000, () => remote.destroy());
      try {
        if (upstream) {
          const auth = upstream.username || upstream.password
            ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64')}\r\n` : '';
          remote.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${auth}\r\n`);
          const responsePending = readHeader(remote);
          remote.resume();
          const response = await responsePending;
          if (!/^HTTP\/1\.[01] 200(?: |$)/u.test(response.head.split('\r\n', 1)[0] ?? '')) {
            denied++; return deny(client, 502);
          }
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (response.rest.byteLength > 0) client.write(response.rest);
        } else client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        connections.set(host, (connections.get(host) ?? 0) + 1);
        if (request.rest.byteLength > 0) remote.write(request.rest);
        client.pipe(remote); remote.pipe(client);
        client.resume(); remote.resume();
      } catch (error) { remote.destroy(); throw error; }
    })().catch(() => { denied++; deny(client, 502); });
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    directory, socketPath,
    audit: () => ({ allowedHosts: [...allowed], connected: Object.fromEntries(connections), denied }),
    close: async () => {
      if (closed) return; closed = true;
      for (const socket of active) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
