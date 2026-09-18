import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { TaskExecutionRequest, TaskExecutionResult } from '@dev-harness-runtime/contracts';
import { decodeCodexExecution } from './decode.js';

export class CodexProcessError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'EXECUTION_FAILED' | 'QUIESCENCE_UNKNOWN', message: string) {
    super(message); this.name = 'CodexProcessError';
  }
}

export interface CodexProcessInput {
  readonly binary: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly request: TaskExecutionRequest;
  readonly signal: AbortSignal;
  /** The Core-owned sink retains exact bytes before any result is delivered. */
  readonly log: (stream: 'events' | 'stderr', bytes: Uint8Array) => Promise<void>;
}

export interface CodexProcessOutput {
  readonly threadId: string;
  readonly result: TaskExecutionResult;
  readonly proposals: readonly { path: string; content: string | null }[];
}

/**
 * Spawn and decode one process with no inherited stdin or environment. This is a
 * transport component, not a TaskExecutor or proof of authorization enforcement.
 * A cancellation/error cannot certify escaped descendants; the caller must keep
 * the Run lock until a separate host controller proves the entire tree quiescent.
 */
export async function runCodexProcess(input: CodexProcessInput): Promise<CodexProcessOutput> {
  if (!isAbsolute(input.binary) || !isAbsolute(input.cwd) || input.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || input.signal.aborted) {
    throw new CodexProcessError('INVALID_ARGUMENT', 'Codex process requires fixed absolute paths, valid arguments and a live signal');
  }
  const child = spawn(input.binary, [...input.argv], {
    cwd: input.cwd, env: { ...input.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) throw new CodexProcessError('EXECUTION_FAILED', 'Codex process pipes were not created');
  let cancelled = false;
  const terminate = (): void => {
    cancelled = true;
    child.kill('SIGKILL');
    stdout.destroy();
    stderr.destroy();
  };
  input.signal.addEventListener('abort', terminate, { once: true });
  if (input.signal.aborted) terminate();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const decoded = decodeCodexExecution({ events: stdout, request: input.request, format: 'codex',
    log: (bytes) => input.log('events', bytes) });
  const loggedStderr = (async () => {
    let total = 0;
    for await (const chunk of stderr) {
      total += chunk.byteLength;
      if (total > 32 * 1024 * 1024) throw new CodexProcessError('EXECUTION_FAILED', 'Codex stderr exceeded its boundary');
      await input.log('stderr', chunk);
    }
  })();
  try {
    const [result, , exit] = await Promise.all([decoded, loggedStderr, closed]);
    if (cancelled || input.signal.aborted) throw new CodexProcessError('QUIESCENCE_UNKNOWN', 'Codex was cancelled without whole-tree quiescence proof');
    if (exit.code !== 0 || exit.signal !== null) throw new CodexProcessError('EXECUTION_FAILED', 'Codex process exited unsuccessfully');
    return result;
  } catch (error) {
    child.kill('SIGKILL');
    stdout.destroy();
    stderr.destroy();
    await closed.catch(() => undefined);
    if (cancelled || input.signal.aborted) {
      throw new CodexProcessError('QUIESCENCE_UNKNOWN', 'Codex was cancelled without whole-tree quiescence proof');
    }
    throw error;
  } finally {
    input.signal.removeEventListener('abort', terminate);
  }
}
