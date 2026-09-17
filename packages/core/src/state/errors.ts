export type StateErrorCode = 'STATE_NOT_FOUND' | 'STATE_ALREADY_EXISTS' | 'STATE_INCOMPLETE'
  | 'STATE_CORRUPT' | 'STATE_PATH_INVALID' | 'REVISION_CONFLICT' | 'REVISION_OVERFLOW'
  | 'STATE_IDENTITY_MISMATCH' | 'EVIDENCE_EXISTS' | 'EVIDENCE_MISMATCH';

export class StateError extends Error {
  constructor(readonly code: StateErrorCode, message: string, readonly path?: string) {
    super(message); this.name = 'StateError';
  }
}
