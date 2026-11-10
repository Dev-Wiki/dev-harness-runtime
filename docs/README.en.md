# dev-harness-runtime documentation

[English](README.en.md) | [简体中文](README.md)

Keep Chinese and English READMEs aligned section by section. Do not omit workflows, module descriptions, commands, capability boundaries, or documentation routes from one language. When either version changes, check and update its counterpart. Platform support, public contracts, recovery, migration, build / release, and contributor documents have English bodies. Historical design, original verification, and task records are identified by language below.

- [English project overview](../README.en.md) and [English documentation index](README.en.md): plugin installation, quick start, and specialist routes with language status.
- [Project integration and usage](../README.en.md#work-with-dev-harness) (English overview): the upstream Skills Bundle, protocol sources, and Runtime execution entry points.
- [Upstream Skills Bundle](https://github.com/Dev-Wiki/dev-harness/blob/main/README.en.md) (English overview): prepare Context, Planning, documentation, verification commands, and Git contracts.
- [Platform capability matrix](PLATFORM_MATRIX.en.md): packaging, installation, and automatic execution evidence boundaries for each platform.
- [Implementation architecture](../ARCHITECTURE.en.md): the current workspace, Registry, and CLI boundaries.
- [Build and verification contract](../HARNESS.en.md): toolchain, confirmed commands, and verification scope.
- [Public contracts](CONTRACTS.en.md): Planning reading, execution results, authorization, state recovery, and packaging interfaces.
- [Shared packaging pipeline](PACKAGING.en.md): pinned inputs, stage gates, static checks, and deterministic archives.
- [Build and GitHub Release](RELEASE.en.md): local builds, release artifacts, and release gates.
- [Contract decisions](decisions/runtime-contracts.md): design choices, source locking, and the engineering baseline. *(Original record; Chinese)*
- [DSH migration boundaries](DSH_MIGRATION.en.md): Core / Adapter responsibilities, shared behavior, and compatibility with historical state.
- [Controlled Worker bridge](integration/WORKER_BRIDGE.md): records of the controlled Codex / DSH Worker integration. *(Original record; Chinese)*
- [R0 verification record](verification/R0.md): contract walkthrough, source mapping, and document verification. *(Original record; Chinese)*
- [Platform baseline](integration/PLATFORM_BASELINE.md): six formats, actual DSH components, offline samples, and host gates. *(Original record; Chinese)*
- [R1 verification record](verification/R1.md): format validation, version inventory, and archive checks. *(Original record; Chinese)*
- [V0 verification record](verification/V0.md): project scaffold, protocol lock, and CLI installation-package acceptance. *(Original record; Chinese)*
- [K1 verification record](verification/K1.md): shared schemas, positive / negative cases, shared Executor factory, and full regression. *(Original record; Chinese)*
- [K2 verification record](verification/K2.md): Git / worktree discovery, structured Planning reading, archives, and selection gates. *(Original record; Chinese)*
- [K3 verification record](verification/K3.md): content snapshots, drift protection, and real Git commit validation. *(Original record; Chinese)*
- [K3-L verification record](verification/K3-L.md): private state, CAS, multiprocess locks, and crash verification. *(Original record; Chinese)*
- [K3-R verification record](verification/K3-R.md): recovery, interrupted reentry, explicit reconciliation, and affected regression. *(Original record; Chinese)*
- [K4-V verification record](verification/K4-V.md): independent acceptance, actual isolation, exact commits, and evidence recovery. *(Original record; Chinese)*
- [K4-W verification record](verification/K4-W.md): shared Skills, Worker requests, recursion gates, and parent-context / log boundaries. *(Original record; Chinese)*
- [K4 verification record](verification/K4.md): serial three-task execution, the runtime CLI, read-only status, cancellation, and commit recovery. *(Original record; Chinese)*
- [K10-B verification record](verification/K10-B.md): the shared source lock, Fake Packager, static negative cases, and golden artifacts. *(Original record; Chinese)*
- [Recovery and manual reconciliation](RECOVERY.en.md): Core recovery interfaces, trusted evidence, and the unique successor.
- [Development Dashboard](plan/Dashboard.md): the only active plan, task order, and cross-task state. *(Original record; Chinese)*
- [Readiness assessment](plan/Readiness.md): design inputs, gaps, and initial official-source research evidence. *(Original record; Chinese)*
- [Git workflow](GIT_WORKFLOW.en.md): branches, commit identity, Conventional Commits, tags, and release-note conventions.
- [Changelog](../CHANGELOG.en.md): changes in released versions.
- [Design document](design/runtime-design.md): the repository's single design body. *(Original record; Chinese)*

Read task packets on demand from the Dashboard. Completed tasks move to milestone archives when their lifecycle closes. The former workspace design path remains only as a short navigation page.

When installation, execution entry points, or platform capability boundaries change, update the affected English overview and navigation in the same change. Specialist facts and verification records stay in their own authoritative documents; mark untranslated documents explicitly.

Place user-document translations beside their source as `filename.en.md`, preserving all sections, tables, examples, limitations, and evidence references. English navigation should link to English bodies. Keep machine-recognized Chinese structural labels, states, and protocol fields literal and explain them in English. Generate and check both platform matrices from the same verified manifest and Registry.
