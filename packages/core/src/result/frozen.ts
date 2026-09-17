import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, posix, relative } from 'node:path';
import { parseContract, type EvidenceRef, type RunState, type TaskExecutionRequest } from '@dev-harness-runtime/contracts';
import { resolveProjectPath } from '../discovery/paths.js';
import { readConfirmedVerificationCommands } from '../discovery/project.js';
import type { LockHandle } from '../lock/index.js';
import { parseMarkdown, section } from '../planning/markdown.js';
import { loadRecoverySnapshot, sameRecord } from '../recovery/evidence.js';
import { recaptureSnapshot } from '../snapshot/capture.js';
import { assertUnchanged } from '../snapshot/guard.js';
import type { CapturedSnapshot } from '../snapshot/types.js';
import { ensureRunEvidence, readEvidence, readRunAtRevision } from '../state/index.js';

export class AcceptanceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AcceptanceError'; }
}
export function requireAcceptance(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new AcceptanceError(code, message);
}
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const recordName = (prefix: string, identity: string) => `${prefix}-${digest(identity).slice(0, 32)}`;
export interface AcceptanceCriterion { id: string; text: string }
export interface FrozenAcceptanceInputs {
  schemaVersion: 1;
  kind: 'acceptance-inputs';
  runId: string; taskId: string; attempt: number; requestId: string;
  snapshotHash: string;
  requestHash: string;
  acceptance: AcceptanceCriterion[];
  files: { path: string; sha256: string; base64: string }[];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const requestHash = (request: TaskExecutionRequest) => digest(canonical(request));
export const identity = (request: TaskExecutionRequest) => ({ runId: request.runId, taskId: request.taskId, attempt: request.attempt, requestId: request.requestId });

export function bindAcceptanceRequest(state: RunState, request: TaskExecutionRequest): void {
  requireAcceptance(state.runId === request.runId && state.adapter === request.env.DEV_HARNESS_ADAPTER
    && state.repoIdentity.repoRoot === request.repoRoot && sameRecord(state.protocolSource, request.protocolSource)
    && sameRecord({ ...state.authorization, commit: 'deny' }, request.authorization), 'AUTHORIZATION_VIOLATION', 'Request differs from the fixed Run identity, environment or narrowed authorization');
  requireAcceptance(state.pendingOperation && sameRecord(state.pendingOperation.identity, identity(request))
    && sameRecord(state.pendingOperation.scope, request.scope), 'INVALID_RESULT', 'Request does not bind the current pending Task');
  requireAcceptance(state.status === 'RUNNING' || state.status === 'INTERRUPTED', 'RUN_TERMINAL', 'Acceptance needs an active or interrupted pending operation');
}

/** Literal argv only: shell evaluation, expansions and pipelines are not verification policy. */
export function parseLiteralCommand(command: string): string[] {
  const result: string[] = []; let word = ''; let started = false; let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    requireAcceptance(!['\0', '\r', '\n'].includes(char), 'VERIFICATION_PLAN_INVALID', 'Verification command must be a single literal argv');
    if (quote) {
      if (char === quote) quote = '';
      else {
        requireAcceptance(quote === "'" || !['$', '`', '\\'].includes(char), 'VERIFICATION_PLAN_INVALID', 'Shell expansion is unsupported');
        word += char;
      }
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/u.test(char)) { if (started) { result.push(word); word = ''; started = false; } }
    else {
      requireAcceptance(!['$', '`', '\\', '|', '&', ';', '<', '>', '(', ')', '*', '?', '[', ']'].includes(char), 'VERIFICATION_PLAN_INVALID', 'Shell syntax requires an explicitly supported runner');
      word += char; started = true;
    }
  }
  requireAcceptance(!quote, 'VERIFICATION_PLAN_INVALID', 'Unclosed command quote');
  if (started) result.push(word);
  requireAcceptance(result.length > 0 && result.every(Boolean), 'VERIFICATION_PLAN_INVALID', 'Empty argv entries are unsupported');
  return result;
}

function text(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
export function validateFrozenPlan(request: TaskExecutionRequest, acceptance: readonly AcceptanceCriterion[], files: ReadonlyMap<string, Buffer>): void {
  const taskBytes = files.get(request.scope.planning.taskPath); const harnessBytes = files.get('HARNESS.md');
  requireAcceptance(taskBytes && harnessBytes, 'VERIFICATION_PLAN_INVALID', 'Frozen Task and HARNESS are required');
  const task = parseMarkdown(text(taskBytes), request.taskPath);
  const criteria = section(task, '验收标准').filter((token) => token.type === 'inline' && /^\[[ xX]\]\s+/u.test(token.content)).map((token) => token.content.replace(/^\[[ xX]\]\s+/u, '').trim());
  requireAcceptance(criteria.length > 0 && sameRecord(criteria, acceptance.map((entry) => entry.text)), 'VERIFICATION_PLAN_INVALID', 'Acceptance bindings must preserve every original criterion in order');
  const ids = acceptance.map((entry) => entry.id);
  requireAcceptance(new Set(ids).size === ids.length && ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)), 'VERIFICATION_PLAN_INVALID', 'Invalid acceptance identities');
  const covered = [...new Set([...request.verificationPlan.commands, ...request.verificationPlan.manual].flatMap((check) => check.acceptanceIds))].sort();
  requireAcceptance(sameRecord([...ids].sort(), covered), 'VERIFICATION_PLAN_INVALID', 'Verification must cover exactly all frozen acceptance criteria');
  const allowed = readConfirmedVerificationCommands(text(harnessBytes), 'HARNESS.md').map((entry) => entry.command);
  requireAcceptance(allowed.length > 0, 'VERIFICATION_PLAN_INVALID', 'Frozen HARNESS has no supported confirmed commands');
  for (const command of request.verificationPlan.commands) {
    const matched = allowed.some((value) => {
      try { return sameRecord(parseLiteralCommand(value), command.argv); } catch { return false; }
    });
    requireAcceptance(matched, 'VERIFICATION_PLAN_INVALID', 'Command argv is absent from the original HARNESS');
  }
  for (const source of request.verificationPlan.sources) {
    const bytes = files.get(source.path);
    requireAcceptance(bytes && digest(bytes) === source.sha256, 'VERIFICATION_PLAN_INVALID', 'Verification source does not match frozen bytes');
  }
}

/** Direct entry points are mandatory; a trusted planner must additionally list dynamic/transitive verifier inputs. */
function validateCommandSources(request: TaskExecutionRequest, snapshot: CapturedSnapshot, files: ReadonlyMap<string, Buffer>): void {
  const available = new Set(snapshot.snapshot.paths.filter((entry) => entry.type === 'file').map((entry) => entry.path));
  const declared = new Set(request.verificationPlan.sources.map((source) => source.path));
  for (const command of request.verificationPlan.commands) {
    const entryPoints = command.argv.map((argument) => isAbsolute(argument) ? relative(request.repoRoot, argument).split('\\').join('/') : posix.normalize(posix.join(command.cwd, argument)))
      .filter((path) => available.has(path));
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(basename(command.argv[0]!))) {
      const manifest = posix.normalize(posix.join(command.cwd, 'package.json'));
      requireAcceptance(available.has(manifest), 'VERIFICATION_PLAN_INVALID', 'Package-manager verification requires its original package.json');
      entryPoints.push(manifest);
      requireAcceptance(declared.has(manifest), 'VERIFICATION_PLAN_INVALID', 'Package-manager manifest must be a frozen source');
      const bytes = files.get(manifest);
      requireAcceptance(bytes, 'VERIFICATION_PLAN_INVALID', 'Frozen package manifest is missing');
      const value: unknown = JSON.parse(text(bytes));
      requireAcceptance(value !== null && typeof value === 'object' && !Array.isArray(value), 'VERIFICATION_PLAN_INVALID', 'Invalid package manifest');
      const scripts: unknown = Reflect.get(value, 'scripts');
      const name = ['run', 'run-script'].includes(command.argv[1] ?? '') ? command.argv[2] : command.argv[1];
      if (name && scripts !== null && typeof scripts === 'object') {
        for (const scriptName of [`pre${name}`, name, `post${name}`]) {
          const script: unknown = Reflect.get(scripts, scriptName);
          if (typeof script !== 'string') continue;
          // Literal direct scripts have a provable entry path. Complex shell/dynamic
          // dependencies remain the trusted planner's explicit source responsibility.
          let argv: string[]; try { argv = parseLiteralCommand(script); } catch { continue; }
          entryPoints.push(...argv.map((argument) => posix.normalize(posix.join(command.cwd, argument))).filter((path) => available.has(path)));
        }
      }
    }
    requireAcceptance(entryPoints.every((path) => declared.has(path)), 'VERIFICATION_PLAN_INVALID', 'Local verification entry points must be frozen sources');
  }
}

export async function readSnapshotFiles(snapshot: CapturedSnapshot, paths: Iterable<string>): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const path of new Set(paths)) {
    const entry = snapshot.snapshot.paths.find((entry) => entry.path === path);
    if (entry === undefined || entry.type === 'missing') continue;
    requireAcceptance(entry.type === 'file', 'INVALID_RESULT', 'Frozen Planning inputs must be regular files');
    const resolved = await resolveProjectPath(snapshot.snapshot.repoIdentity.repoRoot, snapshot.snapshot.repoIdentity.repoRoot, path);
    const bytes = await readFile(resolved);
    requireAcceptance(digest(bytes) === entry.rawContentHash, 'DRIFT_DETECTED', 'Source changed while reading frozen bytes');
    result.set(path, bytes);
  }
  return result;
}

function frozenPaths(request: TaskExecutionRequest, snapshot: CapturedSnapshot): string[] {
  const planning = request.scope.planning;
  const root = planning.dashboardPath.slice(0, planning.dashboardPath.lastIndexOf('/'));
  return [...request.verificationPlan.sources.map((source) => source.path), snapshot.snapshot.gitWorkflowRef.path,
    planning.taskPath, planning.dashboardPath, planning.archiveIndexPath,
    ...snapshot.snapshot.paths.filter((entry) => entry.type === 'file' && entry.path.startsWith(`${root}/archive/`) && entry.path.endsWith('/README.md')).map((entry) => entry.path)];
}

/** Call after publishing execute intent and before dispatch. Never reconstruct old input from a Worker's new files. */
export async function freezeAcceptanceInputs(handle: LockHandle, options: { expectedRevision: number; request: TaskExecutionRequest; acceptance: AcceptanceCriterion[] }): Promise<EvidenceRef> {
  requireAcceptance(process.env.DEV_HARNESS_WORKER !== '1', 'AUTHORIZATION_VIOLATION', 'Workers cannot freeze Core acceptance inputs');
  const request = parseContract('taskExecutionRequest', structuredClone(options.request));
  const state = await readRunAtRevision(handle, request.runId, options.expectedRevision);
  bindAcceptanceRequest(state, request);
  requireAcceptance(state.pendingOperation?.kind === 'execute' && state.pendingOperation.beforeSnapshotHash === request.snapshotHash, 'INVALID_RESULT', 'Freeze requires this execution intent before dispatch');
  const before = await loadRecoverySnapshot(handle, state, { schemaVersion: 1, path: request.snapshotRef, sha256: request.snapshotHash });
  assertUnchanged(before, await recaptureSnapshot(before));
  const files = await readSnapshotFiles(before, frozenPaths(request, before));
  validateCommandSources(request, before, files);
  const acceptance = structuredClone(options.acceptance);
  validateFrozenPlan(request, acceptance, files);
  assertUnchanged(before, await recaptureSnapshot(before));
  const record: FrozenAcceptanceInputs = { schemaVersion: 1, kind: 'acceptance-inputs', ...identity(request), snapshotHash: before.hash, requestHash: requestHash(request), acceptance,
    files: [...files].map(([path, bytes]) => ({ path, sha256: digest(bytes), base64: bytes.toString('base64') })) };
  return ensureRunEvidence(handle, state.runId, state.revision, recordName('inputs', request.requestId), record);
}

export async function loadFrozenInputs(handle: LockHandle, state: RunState, request: TaskExecutionRequest, before: CapturedSnapshot, ref: EvidenceRef): Promise<{ record: FrozenAcceptanceInputs; files: Map<string, Buffer> }> {
  const raw = await readEvidence(handle, state.runId, state.revision, ref);
  let record: FrozenAcceptanceInputs;
  try { record = JSON.parse(text(raw)) as FrozenAcceptanceInputs; }
  catch { throw new AcceptanceError('INVALID_RESULT', 'Frozen acceptance input is not valid JSON'); }
  requireAcceptance(record && record.schemaVersion === 1 && record.kind === 'acceptance-inputs'
    && sameRecord({ runId: record.runId, taskId: record.taskId, attempt: record.attempt, requestId: record.requestId }, identity(request))
    && record.snapshotHash === before.hash && record.requestHash === requestHash(request)
    && Array.isArray(record.files) && Array.isArray(record.acceptance), 'INVALID_RESULT', 'Frozen inputs do not bind this exact execution request');
  const files = new Map<string, Buffer>();
  for (const file of record.files) {
    requireAcceptance(file && typeof file.path === 'string' && typeof file.base64 === 'string' && typeof file.sha256 === 'string' && !files.has(file.path), 'INVALID_RESULT', 'Invalid or duplicate frozen file');
    const bytes = Buffer.from(file.base64, 'base64');
    const entry = before.snapshot.paths.find((entry) => entry.path === file.path);
    requireAcceptance(bytes.toString('base64') === file.base64 && entry?.type === 'file' && digest(bytes) === file.sha256 && entry.rawContentHash === file.sha256, 'INVALID_RESULT', 'Frozen bytes differ from the execution snapshot');
    files.set(file.path, bytes);
  }
  for (const path of frozenPaths(request, before)) {
    if (before.snapshot.paths.some((entry) => entry.path === path && entry.type === 'file')) requireAcceptance(files.has(path), 'INVALID_RESULT', 'A required frozen input is missing');
  }
  validateFrozenPlan(request, record.acceptance, files);
  validateCommandSources(request, before, files);
  return { record, files };
}
