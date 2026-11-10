# dev-harness-runtime documentation

[English](README.en.md) | [简体中文](README.md)

Keep Chinese and English READMEs aligned section by section. Do not omit workflows, module descriptions, commands, capability boundaries, or documentation routes from one language. When either version changes, check and update its counterpart. The specialist documents below are currently **Chinese**; the English overview and index are identified explicitly.

- [English project overview](../README.en.md) and [English documentation index](README.en.md): plugin installation, quick start, and specialist routes with language status.
- [Project integration and usage](../README.en.md#work-with-dev-harness) (English overview): the upstream Skills Bundle, protocol sources, and Runtime execution entry points.
- [Upstream Skills Bundle](https://github.com/Dev-Wiki/dev-harness/blob/main/README.en.md) (English overview): prepare Context, Planning, documentation, verification commands, and Git contracts.
- [Platform capability matrix](PLATFORM_MATRIX.md): packaging, installation, and automatic execution evidence boundaries for each platform.
- [Implementation architecture](../ARCHITECTURE.md): the current workspace, Registry, and CLI boundaries.
- [Build and verification contract](../HARNESS.md): toolchain, confirmed commands, and verification scope.
- [Public contracts](CONTRACTS.md): Planning reading, execution results, authorization, state recovery, and packaging interfaces.
- [Shared packaging pipeline](PACKAGING.md): pinned inputs, stage gates, static checks, and deterministic archives.
- [Build and GitHub Release](RELEASE.md): local builds, release artifacts, and release gates.
- [Contract decisions](decisions/runtime-contracts.md): design choices, source locking, and the engineering baseline.
- [DSH migration boundaries](DSH_MIGRATION.md): Core / Adapter responsibilities, shared behavior, and compatibility with historical state.
- [Controlled Worker bridge](integration/WORKER_BRIDGE.md): records of the controlled Codex / DSH Worker integration.
- [R0 verification record](verification/R0.md): contract walkthrough, source mapping, and document verification.
- [Platform baseline](integration/PLATFORM_BASELINE.md): six formats, actual DSH components, offline samples, and host gates.
- [R1 verification record](verification/R1.md): format validation, version inventory, and archive checks.
- [V0 verification record](verification/V0.md): project scaffold, protocol lock, and CLI installation-package acceptance.
- [K1 verification record](verification/K1.md): shared schemas, positive / negative cases, shared Executor factory, and full regression.
- [K2 verification record](verification/K2.md): Git / worktree discovery, structured Planning reading, archives, and selection gates.
- [K3 verification record](verification/K3.md): content snapshots, drift protection, and real Git commit validation.
- [K3-L verification record](verification/K3-L.md): private state, CAS, multiprocess locks, and crash verification.
- [K3-R verification record](verification/K3-R.md): recovery, interrupted reentry, explicit reconciliation, and affected regression.
- [K4-V verification record](verification/K4-V.md): independent acceptance, actual isolation, exact commits, and evidence recovery.
- [K4-W verification record](verification/K4-W.md): shared Skills, Worker requests, recursion gates, and parent-context / log boundaries.
- [K4 verification record](verification/K4.md): serial three-task execution, the runtime CLI, read-only status, cancellation, and commit recovery.
- [K10-B verification record](verification/K10-B.md): the shared source lock, Fake Packager, static negative cases, and golden artifacts.
- [Recovery and manual reconciliation](RECOVERY.md): Core recovery interfaces, trusted evidence, and the unique successor.
- [Development Dashboard](plan/Dashboard.md): the only active plan, task order, and cross-task state.
- [Readiness assessment](plan/Readiness.md): design inputs, gaps, and initial official-source research evidence.
- [Git workflow](GIT_WORKFLOW.md): branches, commit identity, Conventional Commits, tags, and release-note conventions.
- [Changelog](../CHANGELOG.md): changes in released versions.
- [Design document](design/runtime-design.md): the repository's single design body.

Read task packets on demand from the Dashboard. Completed tasks move to milestone archives when their lifecycle closes. The former workspace design path remains only as a short navigation page.

When installation, execution entry points, or platform capability boundaries change, update the affected English overview and navigation in the same change. Specialist facts and verification records stay in their own authoritative documents; mark untranslated documents explicitly.
