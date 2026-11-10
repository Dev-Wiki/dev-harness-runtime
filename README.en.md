# dev-harness-runtime

[English](README.en.md) | [简体中文](README.md)

**The execution Runtime and platform plugin distribution layer for dev-harness.** A shared Core selects Planning Tasks, dispatches Workers, verifies acceptance independently, enforces authorization, and persists state for recovery. Adapters connect hosts; Packagers produce their installation artifacts.

The [dev-harness Skills Bundle](https://github.com/Dev-Wiki/dev-harness/blob/main/README.en.md) prepares project context, planning, documentation, verification commands, and Git policy. Install it separately from the Runtime plugin.

## Platform support

Codex and DSH have verified packaged Task Executors, including task chains, independent acceptance, per-task commits, and recovery in the recorded WSL2 environment. Execution requires a successful capability probe on the actual host.

Cursor, OpenCode, Antigravity, and the Portable Agent Plugin have distinct packaging and host-validation boundaries. A package or installation check alone does not establish automatic execution support. Antigravity model-session Skill invocation remains untested. Consult the [platform matrix](docs/PLATFORM_MATRIX.md) (Chinese) and its linked verification records for the current evidence.

The standalone CLI does not include a default host Executor. Packaged launchers can supply trusted services; a missing capability returns `CAPABILITY_MISSING`.

## Install the Codex plugin

Download the Codex ZIP from the [GitHub releases](https://github.com/Dev-Wiki/dev-harness-runtime/releases) and extract it into a local marketplace directory. Keep the complete archive layout, including `.agents/plugins/marketplace.json` and `plugins/dev-harness/`.

Using the Codex CLI supported by the package, add the extracted marketplace and install the plugin:

```bash
codex plugin marketplace add /absolute/path/to/extracted-marketplace
codex plugin add dev-harness@dev-harness-local
codex plugin list
```

Start a new Codex thread and explicitly invoke the installation self-check:

```text
$dev-harness:run Run the plugin installation self-check.
```

The self-check runs the bundled launcher for version and, if needed, help output. It does not start a Run or read project plans. The plugin resolves its own `scripts/dhr.mjs`; no global `dhr` alias is needed.

Linux Task execution also requires an authenticated Codex CLI and a trusted bubblewrap provider. The Runtime probes these capabilities before creating a Run. The parent Codex sandbox may require approval for the exact bundled command to start nested isolation. Native Windows installation and read-only self-check evidence does not establish Windows Task execution support.

Other platform artifacts include their own English installation README. Use the [documentation index](docs/README.en.md) to find platform evidence and packaging details.

## Run prepared tasks

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

Each Run's authoritative state is `<run-id>/run.json` under the worktree-private Git path `dev-harness-runtime/runs/`. Status returns a compact verified summary and log references. Recovery follows persisted evidence and the original authorization.

## Language coverage

This overview, the quick start, and the [documentation index](docs/README.en.md) are in English. Specialist contracts, platform evidence, and recovery guides are currently Chinese and are marked as such in the index. Platform package installation READMEs are in English; Skill descriptions and CLI messages may still be Chinese.

English invocation examples do not enable English Planning documents. The current Runtime reads fixed Chinese section headings, table labels, and status values, and uses them during acceptance and archiving. Keep those structural labels and preserve the original task requirements. Full English contract generation and execution are separate work from these documentation entry points.

## Work with dev-harness

The Skills Bundle owns the engineering contracts and eight skills. This repository provides `dhr`, platform plugins, and the shared `run / status / worker` skills. These execution entry points use the upstream Planning, Commands, and Git Workflow contracts.

Builds consume the upstream source pinned by [protocol-lock.json](protocol-lock.json). Task execution reads the target project's own Context, Planning, HARNESS, and Git policy. The complete Audit / Finding / Auto Fix / QA workflow is not a built-in automatic pipeline.

## Local development

Use Node `24.15.0`, pnpm `11.1.0`, and Python 3.12 for fixture checks. From the repository root:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm dhr --help
```

The [HARNESS](HARNESS.md) (Chinese) owns verification commands and environment requirements. Its full verification entry is:

```bash
pnpm verify
```

Build and offline checks do not run host model-session smoke tests. To validate an existing upstream checkout against the lock without downloading or updating it:

```bash
pnpm verify:protocol --source /path/to/dev-harness-checkout
```

## Documentation

- [English documentation index](docs/README.en.md): contracts, platforms, recovery, development, and release routes with language status.
- [Chinese project overview](README.md) and [documentation index](docs/README.md).
- [Architecture](ARCHITECTURE.md), [HARNESS](HARNESS.md), and [Git policy](docs/GIT_WORKFLOW.md) (Chinese).
- [Releases](https://github.com/Dev-Wiki/dev-harness-runtime/releases).

## License

[MIT](LICENSE). Bundled dependencies retain their license texts in [third-party notices](THIRD_PARTY_NOTICES.md).
