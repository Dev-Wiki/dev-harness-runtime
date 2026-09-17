import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ContractValidationError, parseContractJson, type EvidenceRef, type RunState } from '@dev-harness-runtime/contracts';
import { checkProject, type LockProject } from '../lock/paths.js';
import { sameRecord } from '../recovery/evidence.js';
import { captureAttemptLogRefsAt, evidencePath, type AttemptIdentity } from './index.js';
import { hasCode, readBytes, requireDirectory } from './files.js';
import { StateError } from './errors.js';

export interface RunInspectionReader {
  readEvidence(ref: EvidenceRef): Promise<Buffer>;
  captureLogs(identity: AttemptIdentity): ReturnType<typeof captureAttemptLogRefsAt>;
}
function coreOnly(): void {
  if (process.env.DEV_HARNESS_WORKER === '1') throw new ContractValidationError('AUTHORIZATION_VIOLATION', 'Workers cannot inspect Core private Run state');
}
function retry(): StateError { return new StateError('REVISION_CONFLICT', 'Run or logs changed during status inspection; retry the read'); }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function stableBytes(path: string): Promise<Buffer> {
  try { return await readBytes(path); }
  catch (error) {
    if (error instanceof StateError && /changed/u.test(error.message)) throw retry();
    throw error;
  }
}

/** Lock-free consistent read: never creates directories, acquires a guard, or repairs state. */
export async function inspectRunView<T>(project: LockProject, runId: string, projectView: (state: RunState, reader: RunInspectionReader) => Promise<T>): Promise<T> {
  coreOnly();
  const location = structuredClone(project);
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(runId)) throw new StateError('STATE_PATH_INVALID', 'Invalid Run directory identity');
  await checkProject(location, false);
  if (location.stateRoot !== join(location.privateGitDir, 'dev-harness-runtime', 'runs')) throw new StateError('STATE_PATH_INVALID', 'Unexpected private state root');
  const directory = join(location.stateRoot, runId);
  try { await requireDirectory(directory); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) throw new StateError('STATE_NOT_FOUND', 'Run state does not exist', directory);
    throw error;
  }
  const path = join(directory, 'run.json');
  let original: Buffer;
  try { original = await stableBytes(path); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) throw new StateError('STATE_INCOMPLETE', 'Run directory has no authoritative run.json', path);
    throw error;
  }
  let state: RunState;
  try { state = parseContractJson('runState', new TextDecoder('utf-8', { fatal: true }).decode(original)); }
  catch { throw new StateError('STATE_CORRUPT', 'Authoritative run.json is not a supported, valid Run record', path); }
  if (state.runId !== runId || state.authorization.runId !== runId || state.repoIdentity.repoRoot !== location.repoRoot
    || state.repoIdentity.privateGitDir !== location.privateGitDir) throw new StateError('STATE_IDENTITY_MISMATCH', 'Run record does not bind its directory and worktree');
  const logReads: { identity: AttemptIdentity; refs: Awaited<ReturnType<typeof captureAttemptLogRefsAt>> }[] = [];
  const reader: RunInspectionReader = {
    async readEvidence(input) {
      const ref = structuredClone(input);
      if (ref.schemaVersion !== 1 || typeof ref.path !== 'string' || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.sha256)) throw new StateError('EVIDENCE_MISMATCH', 'Invalid evidence reference');
      evidencePath(ref.path);
      const bytes = await stableBytes(join(directory, ref.path));
      if (hash(bytes) !== ref.sha256) throw new StateError('EVIDENCE_MISMATCH', 'Evidence contents differ from their authoritative digest', ref.path);
      return bytes;
    },
    async captureLogs(input) {
      const identity = structuredClone(input);
      const current = { runId, taskId: state.currentTaskId, attempt: state.currentAttempt, requestId: state.currentRequestId };
      if (identity.runId !== runId || (!sameRecord(identity, current) && !state.resultRefs.some((entry) => sameRecord(entry.identity, identity)))) {
        throw new StateError('STATE_IDENTITY_MISMATCH', 'Attempt logs are not bound to the inspected Run');
      }
      const refs = await captureAttemptLogRefsAt(directory, `${identity.taskId}-${identity.attempt}`);
      logReads.push({ identity, refs });
      return refs;
    },
  };
  try {
    for (const ref of [state.initialUserChangesRef, state.acceptedSnapshotRef]) {
      const snapshot = parseContractJson('snapshot', new TextDecoder('utf-8', { fatal: true }).decode(await reader.readEvidence(ref)));
      if (snapshot.runId !== runId || snapshot.repoIdentity.repoRoot !== location.repoRoot || snapshot.repoIdentity.privateGitDir !== location.privateGitDir
        || !sameRecord(snapshot.protocolSource, state.protocolSource) || snapshot.adapterConfigHash !== state.adapterConfigHash) {
        throw new StateError('STATE_IDENTITY_MISMATCH', 'Recorded snapshot does not bind the inspected Run and worktree');
      }
    }
    const output = await projectView(structuredClone(state), reader);
    // Logs may grow while revision stays fixed; do not return an already-stale digest.
    for (const entry of logReads) {
      const latest = await captureAttemptLogRefsAt(directory, `${entry.identity.taskId}-${entry.identity.attempt}`);
      if (!sameRecord(entry.refs, latest)) throw retry();
    }
    await checkProject(location, false);
    if (!(await stableBytes(path)).equals(original)) throw retry();
    coreOnly();
    return output;
  } catch (error) {
    if (error instanceof StateError && /changed/u.test(error.message)) throw retry();
    throw error;
  }
}

/** Read the sole authority while an Orchestrator may hold the worktree lock. */
export async function inspectRun(project: LockProject, runId: string): Promise<RunState> {
  return inspectRunView(project, runId, async (state) => state);
}
