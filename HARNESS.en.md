# HARNESS — Project build and verification contract

[English](HARNESS.en.md) | [简体中文](HARNESS.md)

This file is the sole source of truth for project build, verification, and execution environments.
It defines executable commands, prerequisites, and verification boundaries, complementing the behavioral, safety, and change constraints in `AGENTS.md`.

## Project type

TypeScript / Node.js ESM workspace. Core orchestration and the CLI are connected. Six platform Packagers can generate local packages from pinned sources. Codex / DSH passed original-Worker three-task chains; Cursor / OpenCode passed in-session Skill invocation; Antigravity passed native installation / discovery / removal, while model-session invocation was waived by the user and remains untested. Native Ubuntu / Windows CI passed offline verification and the nine-artifact dry-run.

## Build and startup troubleshooting

- **WorkingDirectory**: repository root
- **RecommendedTerminal**: PowerShell (Windows) or a project-compatible shell
- **CanRunBuildHere**: yes (WSL2; `pnpm build` passed in the recorded run; other OS environments were not verified)
- **BuildCommand**: `pnpm build`
- **FailureEvidence**: record the complete command, working directory, terminal type, exit code, first 50 lines, and last 100 lines of build output

## Detected build-command candidates

- **build**: `pnpm build`
- **test**: `pnpm test`
- **quick**: `pnpm harness:quick`
- **bugfix**: `pnpm harness:bugfix`
- **full**: `pnpm verify`

## Confirmed commands (manually maintained)

All commands run from the repository root, with the pinned toolchain installed and `pnpm install --frozen-lockfile --ignore-scripts` completed successfully. These records apply to WSL2 / development, require no device, host, model credentials, or user plugins. Evidence: [V0](docs/verification/V0.md), [K1](docs/verification/K1.md), [K2](docs/verification/K2.md), [K3](docs/verification/K3.md), [K3-L](docs/verification/K3-L.md), [K3-R](docs/verification/K3-R.md), [K4-V](docs/verification/K4-V.md), [K4-W](docs/verification/K4-W.md), [K4 / M1 full regression](docs/verification/K4.md), [K10-B packaging checks](docs/verification/K10-B.md), and `package.json`.

| Purpose | Command | Meaning | Status |
|---|---|---|---|
| build | `pnpm build` | TypeScript workspace compilation, standalone CLI bundle, and self-contained Codex Adapter / MCP bridge bundle; does not generate platform plugin artifacts | confirmed |
| test | `pnpm test` | Compile, then run node:test, including tests/packaging checks | confirmed |
| quick | `pnpm harness:quick` | typecheck + lint | confirmed |
| bugfix | `pnpm harness:bugfix` | Compilation and node:test regression | confirmed |
| full | `pnpm verify` | Types, lint, tests, schema consistency, R1 fixtures, and standalone CLI package checks | confirmed |

`harness:build/test/full` map to their corresponding entries. `pnpm dhr --help` / `--version`, `doctor`, and `status --run <run-id>` are available. run / resume / reconcile connect trusted service interfaces; build / validate / pack connect trusted BuildPipeline interfaces. Repository trusted factories can inject all six platform Packagers. The default standalone CLI has neither platform Packagers nor host Executors. The Codex plugin's standalone launcher verifies pinned packaged sources and assembles services. Autonomous synthetic Tasks in temporary Git projects passed packaged-CLI dispatch, controlled application, Planning closure, and independent Core verification.

Repository `pnpm dhr` uses trusted Packagers from fixed source. `pnpm dhr release --dry-run --protocol-checkout <path>` generated nine local artifacts for six platforms in WSL2 and verified repeated digest consistency. Stage entries are `pnpm generate`, `pnpm validate:plugins`, and `pnpm run pack`, all requiring `--protocol-checkout <path>`; `pnpm pack` is pnpm's built-in command. `pnpm matrix:check` checks actual digests against both platform matrices ([Chinese](docs/PLATFORM_MATRIX.en.md), [English](docs/PLATFORM_MATRIX.en.md)). These commands neither install model hosts nor publish; see [RELEASE](docs/RELEASE.en.md). The standalone CLI tarball still has no default Packager or Executor.

- Node `24.15.0`, with package engines `>=24.15.0 <25`; pnpm `11.1.0`.
- TypeScript `6.0.3`, Oxlint `1.76.0`, esbuild `0.28.0`, and `@types/node 24.12.2`; exact dependencies are in the lockfile.
- Fixtures use Python 3.12, invoked as `python` on Windows and `python3` elsewhere.
- Git `2.43.0` is the currently verified lower bound. Upstream checkout validation uses `pnpm verify:protocol --source <checkout>`. Normal verify does not implicitly fetch upstream sources.
- `pnpm test:fixtures` independently validates R1 minimal samples. `pnpm test:cli-package` installs the CLI tarball offline in a temporary directory; it does not install host plugins.
- `pnpm schemas:write` compiles before exporting TypeBox schemas into packages/contracts/schemas. `pnpm schemas:check` checks export consistency after compilation and is included in full.
- `pnpm clean` removes only packages/*/dist and build/dist; `pnpm build` reconstructs them.
- Installation and verification are separate. The workspace uses `verifyDepsBeforeRun: error`; explicitly install first when dependencies disagree.
- Windows / native Linux are support targets; CI is configured but was not executed in the recorded statement. Successful automatic Runtime execution records remain limited to WSL2. Native Windows passed Codex Marketplace installation, Skill discovery, and packaged-CLI read-only self-checks, which do not prove Linux-isolated Executor operation on Windows. The restricted sandbox reports EPERM for Node child-process output capture; these checks require an environment that can execute them.
- `pnpm smoke:codex-host` is an explicitly selected synthetic host test: run `pnpm build` first and authenticate the local Codex CLI. It sends only synthetic requests, schemas, and `HELLO` file contents from temporary directories to the model and is not part of ordinary `pnpm verify`. Optionally set `DHR_TEST_BWRAP` to a trusted absolute bubblewrap path to run the bridge in an isolated MCP subprocess; otherwise it uses direct subprocess mode. It validates the actual bridge and decoding entry, not actual Planning Tasks or authorization for the complete host process tree; see [K5](docs/verification/K5.md).
- `DHR_TEST_BWRAP=<absolute> DHR_TEST_CODEX_HOST=1 pnpm smoke:codex-host` places the Codex host for those synthetic inputs in monitored independent PID / network namespaces. Model requests pass through a loopback Relay in an independent network, private Unix socket, and host-side exact-destination proxy; the MCP bridge is in a nested networkless namespace. `pnpm smoke:codex-host-namespace` checks the host PID 1 session in a synthetic empty directory. Neither is part of ordinary full or proves complete production Adapter authorization.
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-runtime` uses a temporary Git project and synthetic Worker Skill to explicitly test Codex capability probes, Core dispatch, controlled proposal application, and host receipts. It requires authenticated local Codex CLI and is excluded from ordinary `pnpm verify`. The case returns synthetic `blocked`, not actual Planning Task or multitask acceptance.
- `DHR_TEST_BWRAP=<absolute> DHR_TEST_CANCEL_RESUME=1 pnpm smoke:codex-runtime` cancels a started thread's Codex session in the same synthetic project. Core marks it `INTERRUPTED`, then `resumeRuntimeRun` creates a new attempt. The script checks distinct thread IDs, an unchanged working tree after cancellation, and proposal application by Core after recovery. This explicit smoke is excluded from ordinary full.
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-planning` uses a temporary synthetic Git project and real Codex to return five exact proposals and `completed` candidates without Worker verification claims for Planning Tasks A, B, and C. Core applies each and independently runs frozen acceptance commands. The script checks Run `COMPLETED`, three distinct threads, no implicit commits, and independent verification output. A synthetic Worker Skill and controller-provided expected contents are used; this does not prove autonomous model work on real project tasks. It requires local Codex authentication and is excluded from ordinary full.
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-autonomous` uses a packaged CLI and generic synthetic Worker instructions in a temporary Git project. Real Codex independently reads requirements, implements code and node:test, updates verification records, and closes Planning; the controller does not predefine proposal contents. `pnpm smoke:codex-packaged-worker` uses the unmodified original packaged Worker Skill in the same scenario. Core independently runs frozen commands in both and checks Run `COMPLETED` and unchanged HEAD / index. These explicit smokes require local Codex authentication, are excluded from ordinary full, and do not replace real project, interactive plugin Skill invocation, or commit-chain acceptance.
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-commit` uses the original Worker Skill and frozen Chinese Conventional Commits policy in a temporary project with `--commit-each`. Worker verifies its Core-bound request and four environment markers through `dhr_identity`, then returns only a commit candidate. Core creates the unique commit after independent acceptance. The script checks commitSha, parent, exactly seven paths, Chinese subject, empty index, and a clean working tree. This explicit smoke is excluded from ordinary full.
- `DHR_TEST_BWRAP=<absolute> pnpm smoke:codex-restart` sends `SIGTERM` to the first packaged CLI process after the original Worker thread starts. Core waits for host quiescence, persists `INTERRUPTED`, preserves the completed Worker's checkpoint and application results, and releases the lock. A new CLI process then resumes the same Run, repeating only independent acceptance without repeating development, and checks final `COMPLETED`. Forced termination without proof of descendant quiescence retains the lock and rejects automatic takeover under the recovery protocol.
- `pnpm smoke:codex-plugin` installs the current generated Codex Marketplace into isolated temporary configuration with a copy of existing authentication. A first fresh model session explicitly invokes `$dev-harness:status`, checking unique `run.json` authority and forbidden run / resume / reconcile entries without falling back to shell / MCP resource lookup. A second fresh session invokes `$dev-harness:run` for installation self-check, resolves packaged `scripts/dhr.mjs` from the Skill's own plugin root, runs only `--version`, and checks version 0.1.1. Temporary configuration is cleaned up. This explicit smoke is excluded from ordinary full.
- `DHR_TEST_DSH_ENTRY=<absolute-rc.1-bin.js> DHR_TEST_DSH_PACKAGE=<absolute-local-tgz> DHR_TEST_BWRAP=<absolute> pnpm smoke:dsh-runtime` additionally requires `DEEPSEEK_API_KEY` in a trusted environment. It installs the local package offline into a temporary headless profile, checks packaged plugin digests, invokes identity, catalog, read, search, and deletion proposals from isolated new DSH Sessions using synthetic files and Tasks, and checks the exact host-model proxy, complete host quiescence, and unchanged original files. It is excluded from ordinary `pnpm verify` and does not prove production RuntimeAdapter, Core application, cancellation recovery, or Planning three-task acceptance; see [K6](docs/verification/K6.md).
- Adding `DHR_TEST_DSH_PROBE=1` to that command adds two real fresh Sessions and independent namespace-cancellation capability probes. Adding `DHR_TEST_DSH_CORE=1` makes RuntimeAdapter complete synthetic Core dispatch, exact proposal application, and host-receipt validation in a temporary Git project. These explicit modes still do not prove packaged CLI operation, real Run cancellation recovery, or Planning three-task acceptance.
- Adding `DHR_TEST_DSH_PACKAGE_CLI=1` first checks newly installed packaged pinned sources, trusted service factories, and packaged CLI. It replaces and repins a synthetic Worker Skill only in a temporary package copy, then executes one temporary Planning Task through packaged `scripts/dhr.mjs run`, checking Core proposal application, `BLOCKED`, and unchanged HEAD / index. It does not verify an unmodified Worker or three-task chain.
- Adding `DHR_TEST_DSH_CANCEL_RESUME=1` cancels a synthetic Core Run after the persistent host-start record appears, checks `INTERRUPTED`, unchanged original files, and lock release, then uses a new Adapter instance to recover to attempt 2 and checks Core proposal application. It does not prove persistent identity of the canceled Session, an original Worker, or a three-task chain.
- `DHR_TEST_DSH_ENTRY=<absolute-rc.1-bin.js> DHR_TEST_DSH_PACKAGE=<absolute-local-tgz> DHR_TEST_BWRAP=<absolute> pnpm smoke:dsh-autonomous` calls the unmodified Worker Skill through the actually installed packaged CLI, autonomously completes a Planning Task in a temporary Git project, submits a controlled result candidate, and runs frozen checks independently through Core. Default is one Task with `--no-commit`; add `--commit-each` to check controlled Core commits, or `--three-task --commit-each` to check fresh Sessions, independent acceptance, and three exact commits for A→B→C. This explicit real-model smoke is excluded from ordinary `pnpm verify`.
- Shared BuildPipeline generate / validate / pack stages and `dhr build|validate|pack --adapter ID` are implemented. Repository pinned-source factories can generate artifacts for all six platforms. The standalone distribution still does not implicitly read executable project configuration. Per-platform evidence is in the [capability matrix](docs/PLATFORM_MATRIX.en.md).

## High-risk directories

- scripts/: temporary CLI package installation, cleanup of known build outputs, external checkout validation, and bundle generation.
- packages/core/src/authorization, state, lock, recovery, orchestrator: subprocess permissions, Git commits, private-state publication, exclusion, and crash-recovery boundaries.

## Areas that must not be edited directly

- packages/*/dist, build/dist: compiled output; build/targets is editable source.
- node_modules, .cache/pnpm: dependencies and caches maintained by installers.
- .git: version-control metadata.

## Detected candidates

- Windows / Ubuntu CI is configured; repository verification records still distinguish WSL2, native OS environments, and real hosts.

## Items requiring manual confirmation

- The generic standalone CLI has no preinstalled host Executor. The Codex plugin passed autonomous synthetic Tasks with the packaged original Worker Skill, per-task commits, cross-process checkpoint recovery, and explicit in-session Skill invocation.
- The project uses MIT and includes third-party notices. The standalone CLI tarball remains private; this release distributes only the nine platform artifacts as GitHub Release attachments.
- Native Windows has Codex plugin installation and a `$dev-harness:status` self-check Session, but no Runtime Task execution evidence. Ubuntu / Windows CI passed offline verification and the nine-artifact dry-run; this does not establish native Linux host-model-session capability. WSL2 Codex / DSH passed full task chains; other platforms retain their own task-record boundaries.

## K4-V actual isolation checks

The Linux verification provider requires usable user / PID / mount / network / IPC / UTS / cgroup namespaces, pidfd, native bubblewrap, and Python. The recorded WSL2 Linux 6.6.87.2 environment used bubblewrap 0.9.0 (Ubuntu package 0.9.0-1ubuntu0.1), Python 3.12, and `/usr/bin/git` 2.43.0. bubblewrap was only extracted into a temporary directory, not installed system-wide or added as an npm dependency.

Callers must explicitly provide a canonical bubblewrap path and read-only toolchain directories. Focused checks use `DHR_TEST_BWRAP=/absolute/path/to/bwrap`. Without it, related tests are marked skipped and cannot establish isolation or commit-chain verification. Commands and boundaries are in [K4-V](docs/verification/K4-V.md). Ordinary full neither downloads bubblewrap nor implicitly installs host plugins.
