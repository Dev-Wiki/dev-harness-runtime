import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { decodeCodexExecution } from './decode.js';
import type { CodexHostNamespaceResult } from './host-namespace.js';
import { runIsolatedModelHost, type IsolatedModelHostResult } from './isolated-model-host.js';
import { CodexProcessError, type CodexProcessInput, type CodexProcessOutput } from './process.js';

export interface ConfinedCodexProcessInput extends CodexProcessInput {
  readonly bubblewrap: string;
  readonly nodeBinary: string;
  readonly authFile: string;
  readonly outputSchema: string;
  readonly timeoutMs: number;
  readonly bridge: {
    readonly command: string;
    readonly args: readonly string[];
    readonly hostSources?: readonly string[];
    readonly repoMirror?: string;
  };
}

export interface ConfinedCodexProcessOutput extends CodexProcessOutput {
  readonly namespaceEvidence: CodexHostNamespaceResult['evidence'];
  readonly brokerAudit: IsolatedModelHostResult['brokerAudit'];
}

const inside = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}${sep}`);

/** Run Codex as namespace PID 1; its nested MCP child keeps a separate no-network namespace. */
export async function runConfinedCodexProcess(input: ConfinedCodexProcessInput): Promise<ConfinedCodexProcessOutput> {
  const bridge = input.bridge;
  if (!bridge.hostSources || !bridge.repoMirror || !bridge.hostSources.includes(bridge.repoMirror)
    || bridge.command !== input.bubblewrap || !bridge.hostSources.includes(bridge.command)
    || bridge.hostSources.some((path) => inside(input.cwd, path))
    || inside(input.cwd, input.authFile) || inside(input.cwd, input.outputSchema)
    || !isAbsolute(input.cwd) || !isAbsolute(input.binary)) {
    throw new CodexProcessError('INVALID_ARGUMENT', 'Confined Codex process needs private bridge sources outside the project');
  }
  const auth = await realpath(input.authFile);
  const authStat = await lstat(auth);
  if (auth !== input.authFile || !authStat.isFile() || authStat.isSymbolicLink()
    || (authStat.mode & 0o077) !== 0) {
    throw new CodexProcessError('INVALID_ARGUMENT', 'Codex auth must be a private regular file');
  }
  const schema = await realpath(input.outputSchema);
  if (schema !== input.outputSchema) throw new CodexProcessError('INVALID_ARGUMENT', 'Codex result Schema path is not canonical');
  const codeModeHost = await realpath(join(dirname(input.binary), 'codex-code-mode-host'));
  const codeModeStat = await lstat(codeModeHost);
  if (!codeModeStat.isFile() || codeModeStat.isSymbolicLink() || (codeModeStat.mode & 0o111) === 0) {
    throw new CodexProcessError('INVALID_ARGUMENT', 'Codex code-mode host must be a native executable');
  }
  const env: Record<string, string> = { HOME: '/dhr/home', CODEX_HOME: '/dhr/home', PATH: '/usr/bin', LANG: 'C.UTF-8' };
  const sources = [...new Set([...bridge.hostSources, schema])];
  const raw = await runIsolatedModelHost({ bubblewrap: input.bubblewrap, nodeBinary: input.nodeBinary,
    executable: '/dhr/codex', argv: input.argv, cwd: input.cwd, timeoutMs: input.timeoutMs,
    signal: input.signal, environment: env, tmpfs: ['/dhr/home'],
    mounts: [
      { source: input.binary, destination: '/dhr/codex' },
      { source: codeModeHost, destination: '/dhr/codex-code-mode-host' },
      { source: auth, destination: '/dhr/home/auth.json' },
      ...sources.map((source) => ({ source, destination: source })),
      { source: bridge.repoMirror, destination: input.cwd },
      { source: await realpath('/etc/ssl/certs'), destination: '/etc/ssl/certs' },
      { source: await realpath('/etc/resolv.conf'), destination: '/etc/resolv.conf' },
    ] }, { allowedHosts: ['api.openai.com', 'auth.openai.com', 'chatgpt.com'],
    ...(input.env.HTTPS_PROXY || input.env.HTTP_PROXY ? { upstreamProxy: input.env.HTTPS_PROXY || input.env.HTTP_PROXY } : {}) });
  for (let offset = 0; offset < raw.stderr.byteLength; offset += 1024 * 1024) {
    await input.log('stderr', raw.stderr.subarray(offset, offset + 1024 * 1024));
  }
  if (raw.termination !== 'exited' || raw.exitCode !== 0) {
    for (let offset = 0; offset < raw.stdout.byteLength; offset += 1024 * 1024) {
      await input.log('events', raw.stdout.subarray(offset, offset + 1024 * 1024));
    }
    if (raw.termination === 'aborted' && input.signal.aborted) throw new DOMException('Codex was cancelled after confirmed host quiescence', 'AbortError');
    throw new CodexProcessError('EXECUTION_FAILED', 'Confined Codex exited unsuccessfully after confirmed host quiescence');
  }
  const events = async function* (): AsyncGenerator<Uint8Array> { yield raw.stdout; };
  const decoded = await decodeCodexExecution({ events: events(), request: input.request, format: 'codex',
    log: (bytes) => input.log('events', bytes) });
  return { ...decoded, namespaceEvidence: raw.evidence, brokerAudit: raw.brokerAudit };
}
