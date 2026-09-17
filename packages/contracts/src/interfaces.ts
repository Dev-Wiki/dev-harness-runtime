import type {
  ExecutorCapabilities, TaskExecutionRequest, TaskExecutionResult,
} from './execution.js';
import type {
  AdapterDoctorResult, Artifact, GeneratedPlugin, HostEnvironment,
  PluginBuildInput, ValidationReport,
} from './packaging.js';

/** Host execution boundary; declarations do not establish host capabilities. */
export interface TaskExecutor {
  readonly id: string;
  probe(environment: HostEnvironment): Promise<ExecutorCapabilities>;
  /**
   * Cancellation rejects with an error named AbortError only after the worker
   * and its descendants have terminated and can no longer modify the project.
   */
  execute(request: TaskExecutionRequest, signal: AbortSignal): Promise<TaskExecutionResult>;
}

export interface PluginPackager {
  readonly id: string;
  generate(input: PluginBuildInput): Promise<GeneratedPlugin>;
  validate(plugin: GeneratedPlugin, input: PluginBuildInput): Promise<ValidationReport>;
  /** Pack only the unchanged directory bound to a successful validation and input digest. */
  pack(plugin: GeneratedPlugin, input: PluginBuildInput): Promise<Artifact[]>;
}

export interface PlatformAdapter {
  readonly id: string;
  readonly executor?: TaskExecutor;
  readonly packager: PluginPackager;
  doctor(environment: HostEnvironment): Promise<AdapterDoctorResult>;
}

/** Structural contract implemented by the Core's explicit in-memory registry. */
export interface Registry<T extends { readonly id: string }> {
  /** Reject invalid or duplicate IDs and retain a shallow frozen snapshot. */
  register(entry: T): void;
  /** Reject invalid or unknown IDs. */
  get(id: string): Readonly<T>;
  /** Return a fresh array in registration order. */
  list(): readonly Readonly<T>[];
}
