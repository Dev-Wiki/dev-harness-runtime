import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class DshSessionReadError extends Error {
  constructor(readonly code: 'CAPABILITY_MISSING' | 'INVALID_RESULT', message: string) {
    super(message); this.name = 'DshSessionReadError';
  }
}

interface SessionSnapshot { header: { id: string; cwd?: string; version: number; isSeeded: boolean; parentSession?: string }; sizeBytes?: number }
interface SessionHandle { header: SessionSnapshot['header']; read(): Promise<{ events: unknown[] }>; close(): Promise<void> }
interface SessionBackend { list(): Promise<readonly SessionSnapshot[]>; open(id: string, access: 'read'): Promise<SessionHandle> }

/** Read the only Session in a controller-owned, initially empty DSH store. This does not prove Worker confinement. */
export async function readFreshDshSession(input: { dshEntry: string; sessionsRoot: string; repoRoot: string }): Promise<{
  header: SessionSnapshot['header']; events: readonly unknown[];
}> {
  if (![input.dshEntry, input.sessionsRoot, input.repoRoot].every((path) => isAbsolute(path) && resolve(path) === path)) {
    throw new DshSessionReadError('INVALID_RESULT', 'DSH Session reader requires normalized absolute paths');
  }
  let requireFromDsh: ReturnType<typeof createRequire>;
  try { requireFromDsh = createRequire(pathToFileURL(await realpath(input.dshEntry))); }
  catch { throw new DshSessionReadError('CAPABILITY_MISSING', 'DSH launcher is unavailable'); }
  let cordisPath: string; let backendPath: string;
  try {
    cordisPath = requireFromDsh.resolve('@deepseek-ai/cordis');
    backendPath = requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence-jsonl');
  } catch { throw new DshSessionReadError('CAPABILITY_MISSING', 'DSH Session persistence API is unavailable'); }
  const cordis: unknown = await import(pathToFileURL(cordisPath).href);
  const persistence: unknown = await import(pathToFileURL(backendPath).href);
  if (cordis === null || typeof cordis !== 'object' || !('Context' in cordis) || typeof cordis.Context !== 'function'
    || persistence === null || typeof persistence !== 'object' || !('default' in persistence) || typeof persistence.default !== 'function') {
    throw new DshSessionReadError('CAPABILITY_MISSING', 'DSH Session packages have unexpected exports');
  }
  const Context = cordis.Context as new () => unknown;
  const Backend = persistence.default as new (context: unknown, config: { root: string }) => SessionBackend;
  const backend = new Backend(new Context(), { root: input.sessionsRoot });
  const sessions = await backend.list();
  if (sessions.length !== 1 || !sessions[0] || sessions[0].header.cwd !== input.repoRoot
    || !/^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(sessions[0].header.id)
    || sessions[0].header.version !== 3 || sessions[0].header.isSeeded !== false
    || sessions[0].header.parentSession !== undefined || !Number.isSafeInteger(sessions[0].sizeBytes)
    || (sessions[0].sizeBytes as number) > 32 * 1024 * 1024) {
    throw new DshSessionReadError('INVALID_RESULT', 'DSH store does not contain exactly one fresh bounded Session');
  }
  const handle = await backend.open(sessions[0].header.id, 'read');
  try {
    const content = await handle.read();
    if (handle.header.id !== sessions[0].header.id || handle.header.cwd !== input.repoRoot
      || handle.header.version !== 3 || handle.header.isSeeded !== false || handle.header.parentSession !== undefined
      || !Array.isArray(content.events) || content.events.length > 100_000) {
      throw new DshSessionReadError('INVALID_RESULT', 'DSH Session changed or has unsupported content');
    }
    return { header: structuredClone(handle.header), events: structuredClone(content.events) };
  } finally { await handle.close(); }
}
