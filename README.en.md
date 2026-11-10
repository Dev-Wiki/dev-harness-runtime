# dev-harness-runtime

[English](README.en.md) | [简体中文](README.md)

## Project overview

**The execution Runtime and platform plugin distribution layer for dev-harness.** A shared Core selects Planning Tasks, dispatches Workers, verifies acceptance independently, enforces authorization, and persists state for recovery. Adapters connect hosts; Packagers produce their installation artifacts.

## Current stage

The shared Core supports serial task orchestration, independent acceptance, state, and recovery. The shared `run / status / worker` skills are in place. `dhr` provides read-only `doctor / status` commands and trusted service entry points for execution commands.

Codex and DSH have verified packaged Task Executors, including task chains, independent acceptance, per-task commits, and recovery in the recorded WSL2 environment. Execution requires a successful capability probe on the actual host.

Nine local artifacts for Codex, DSH, Cursor, OpenCode, Antigravity, and Portable have passed the shared packaging checks. Antigravity model-session Skill invocation was explicitly waived by the user and remains untested. See the [platform matrix](docs/PLATFORM_MATRIX.md) (Chinese) and the per-platform verification records for capability boundaries.

- Project and repository name: `dev-harness-runtime`
- CLI: `dhr`
- DSH adapter target: `0.2.0-rc.2`
- Run state root: `$(git rev-parse --git-path dev-harness-runtime)/runs/`
- The only authoritative state file for each Run: `<run-id>/run.json`

Cursor, OpenCode, Antigravity, and the Portable Agent Plugin have distinct packaging and host-validation boundaries. A package or installation check alone does not establish automatic execution support; the platform matrix and its linked verification records define the actual support boundaries.

The standalone CLI does not include a default host Executor. Packaged launchers can supply trusted services; a missing capability returns `CAPABILITY_MISSING`.

## Programming languages

TypeScript, JavaScript (ESM), and Python fixture validation.

## Build system

pnpm workspace, TypeScript compilation, and an esbuild CLI bundle.

## Core modules

- `packages/contracts`: versioned TypeBox schemas, strict structural and relationship validation, execution-result identity binding, and JSON Schema export.
- `packages/core/src/discovery`: actual Git / worktree discovery, documentation-root selection, and project-contract reading.
- `packages/core/src/planning`: structured Markdown reading, dependency-archive verification, and single-task selection in authoritative order.
- `packages/core/src/snapshot`: snapshots of raw file / index / HEAD content, drift checks, and authorized-change validation.
- `packages/core/src/state / lock`: private Run persistence, revision CAS, operation evidence, exclusive ownership, and lock-free read-only status checks.
- `packages/core/src/recovery`: recovery classified by persistent evidence and actual boundaries, explicit reconciliation, and gates for new Runs; partial results with noncompleted endings stop safely, while trusted worker checkpoints can continue remaining work.
- `packages/core/src/result`: frozen original acceptance inputs, single-task Planning deltas, independent controlled acceptance, and acceptance capabilities.
- `packages/core/src/authorization`: a Linux isolated verification provider, controlled commits under frozen Git policy, and commit recovery.
- `packages/core/src/worker`: shared Worker request construction, recursion guards, and compact parent-context projections.
- `packages/core/src/orchestrator`: trusted RuntimeAdapter registration, the task execution loop, plan rereading after acceptance, and resume / reconcile integration.
- `packages/cli`: argument, exit-code, and signal boundaries; read-only doctor / status entry points; explicit RuntimeServices / BuildPipeline injection; and a standalone bundle generated during build.
- `packages/adapter-* / build/targets`: one PlatformRegistry shared by run and build / validate / pack; trusted host Executors register only after a real probe passes, and Packagers for all six platforms are connected.
- `build/manifests`, `build/validators`, `build/transforms`: source and shared-metadata validation, static package checks, constrained Skill transformations, and deterministic archives.
- `skills/run`, `skills/status`, `skills/worker`: the single shared source for Skill behavior, with platform differences handled by subsequent transformations.

## Install the Codex plugin

Download the Codex ZIP from the [GitHub releases](https://github.com/Dev-Wiki/dev-harness-runtime/releases) and extract it into a local marketplace directory. Keep the complete archive layout, including `.agents/plugins/marketplace.json` and `plugins/dev-harness/`.

Using the Codex CLI supported by the package, add the extracted marketplace and install the plugin:

```bash
codex plugin marketplace add /absolute/path/to/extracted-marketplace
codex plugin add dev-harness@dev-harness-local
codex plugin list
```

After installation, start a new Codex thread and use the self-check described under [Usage](#usage).

Other platform artifacts include their own English installation README. Use the [documentation index](docs/README.en.md) to find platform evidence and packaging details.

## Usage

- Install dependencies: `pnpm install --frozen-lockfile --ignore-scripts`
- Build: `pnpm build`
- Run: `pnpm dhr --help`
- Codex plugin: after installing the local Marketplace, explicitly invoke `$dev-harness:status` or `$dev-harness:run` in a new thread. Each Skill calls `scripts/dhr.mjs` from the same plugin package; no global `dhr` alias is required.

### Run prepared tasks

Explicitly invoke the plugin from a new Codex thread. The installation self-check does not read project plans or create a Run:

```text
$dev-harness:run Run the plugin installation self-check.
```

It runs the bundled launcher for version and, if needed, help output.

Open the target project in Codex. Before running a task, prepare its project contracts and a ready Planning packet with bounded write scope, archive targets, confirmed verification commands, and a `dhr-runtime` declaration. The exact requirements are in the [execution contract](docs/CONTRACTS.md#自动执行-task-的冻结声明) (Chinese).

Choose the intended scope and commit policy explicitly:

```text
$dev-harness:run Execute task ID K5 with no commit.
$dev-harness:run Execute the next ready Task with no commit.
$dev-harness:run Execute all ready Tasks and commit each task after acceptance.
```

The default is no commit. The third example authorizes Core to commit each Task only after independent acceptance. Workers return candidate results; Core decides whether acceptance has passed.

Once a Run returns its `runId`, query or resume it from a new thread:

```text
$dev-harness:status Show the status of Run <run-id>.
$dev-harness:run Resume Run <run-id>.
```

Linux Task execution also requires an authenticated Codex CLI and a trusted bubblewrap provider. The Runtime probes these capabilities before creating a Run and stops with a diagnostic if they are missing. If the parent Codex sandbox cannot start nested isolation, approval is requested only for the exact verified bundled `dhr` command; check the plugin cache path, task ID, project path, and commit mode before approval. Native Windows installation and read-only self-check evidence does not establish Windows Task execution support.

Status returns a compact verified summary and log references. Recovery follows persisted evidence and the original authorization.

## Work with dev-harness

The Skills Bundle owns the engineering contracts and eight skills. This repository provides `dhr`, platform plugins, and the shared `run / status / worker` skills. These execution entry points use the upstream Planning, Commands, and Git Workflow contracts.

Install the [dev-harness Skills Bundle](https://github.com/Dev-Wiki/dev-harness/blob/main/README.en.md) separately from the Runtime plugin. It prepares project context, planning, documentation, verification commands, and Git policy.

Builds consume the upstream source pinned by [protocol-lock.json](protocol-lock.json). Task execution reads the target project's own Context, Planning, HARNESS, and Git policy. The complete Audit / Finding / Auto Fix / QA workflow is not a built-in automatic pipeline.

See the [platform capability matrix](docs/PLATFORM_MATRIX.md) (Chinese) for packaging, installation, and automatic execution support. DSH is an Adapter / Packager target in this repository; its host capabilities are maintained through this repository's implementation and verification records.

## Project entry points

- [Documentation index](docs/README.en.md)
- [Development Dashboard](docs/plan/Dashboard.md) (Chinese)
- [Readiness assessment](docs/plan/Readiness.md) (Chinese)
- [Git commit and release policy](docs/GIT_WORKFLOW.md) (Chinese)
- [Shared packaging contract](docs/PACKAGING.md) (Chinese)
- [v0.1.1 GitHub Release](https://github.com/Dev-Wiki/dev-harness-runtime/releases/tag/v0.1.1)
- [v0.1.0 GitHub Release](https://github.com/Dev-Wiki/dev-harness-runtime/releases/tag/v0.1.0)
- [MIT license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md)

## Local development

Use Node `24.15.0`, pnpm `11.1.0`, and Python 3.12 for fixture checks. Dependency versions are pinned by the lockfile. From the repository root:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
pnpm dhr --help
```

Local verification has been completed in WSL2. Offline verification and the nine-artifact dry-run have passed on native Ubuntu / Windows CI; see [CI run 36394754252](https://github.com/Dev-Wiki/dev-harness-runtime/actions/runs/36394754252). The [HARNESS](HARNESS.md) (Chinese) owns build, test, and command semantics; [ARCHITECTURE](ARCHITECTURE.md) (Chinese) describes module boundaries.

`protocol-lock.json` pins the upstream commit and file digests. Build and offline checks do not run host model-session smoke tests. To validate an existing upstream checkout without downloading or updating the protocol:

```bash
pnpm verify:protocol --source /path/to/dev-harness-checkout
```

## Language coverage

The Chinese and English READMEs cover the same project overview, current stage, modules, installation, task usage, integration boundaries, and development entry points. Specialist contracts, platform evidence, and recovery guides are currently Chinese and are marked as such in the [documentation index](docs/README.en.md). Platform package installation READMEs are in English; Skill descriptions and CLI messages may still be Chinese.

English invocation examples do not enable English Planning documents. The current Runtime reads fixed Chinese section headings, table labels, and status values, and uses them during acceptance and archiving. Keep those structural labels and preserve the original task requirements. Full English contract generation and execution are separate work from these documentation entry points.
