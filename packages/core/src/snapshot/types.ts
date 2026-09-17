import type { ProtocolSource, Snapshot } from '@dev-harness-runtime/contracts';
import type { ProjectContext } from '../discovery/project.js';
import type { PlanningReference } from '../planning/types.js';

export interface CaptureSnapshotOptions {
  project: ProjectContext;
  runId: string;
  protocolSource: ProtocolSource;
  adapterConfigHash: string;
  currentTaskPath?: string;
  planningReferences?: PlanningReference[];
}

export interface CapturedSnapshot {
  snapshot: Snapshot;
  hash: string;
  boundaryHash: string;
  dirtyPaths: string[];
  stagedPaths: string[];
}
