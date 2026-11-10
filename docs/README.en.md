# dev-harness-runtime documentation

[English](README.en.md) | [简体中文](README.md)

Start with the [English project overview](../README.en.md) for Codex plugin installation, the self-check, and task invocation examples. This index stays within the existing `docs/` root. **Chinese** means the linked document has not yet been translated; the document itself remains the detailed source of truth.

## Install and use

| Goal | Read | Language |
|---|---|---|
| Install the Codex plugin and check its entry point | [Installation](../README.en.md#install-the-codex-plugin) | English |
| Execute, inspect, or resume a prepared task | [Task quick start](../README.en.md#run-prepared-tasks) | English |
| Prepare the upstream project contracts | [dev-harness overview](https://github.com/Dev-Wiki/dev-harness/blob/main/README.en.md) | English |
| Check packaging and host support evidence | [Platform capability matrix](PLATFORM_MATRIX.md) | Chinese |
| Prepare a Runtime-compatible Planning packet | [Public execution contracts](CONTRACTS.md) | Chinese |
| Recover or explicitly reconcile a Run | [Recovery](RECOVERY.md) | Chinese |
| Understand DSH's Adapter and migration boundaries | [DSH migration](DSH_MIGRATION.md) | Chinese |

For other hosts, start with the English README inside the corresponding release artifact, then follow the platform matrix to its validation record. The English overview describes [language coverage](../README.en.md#language-coverage), including the Chinese structural labels still required for Planning and acceptance.

## Develop and distribute

| Goal | Read | Language |
|---|---|---|
| Understand the Core / Adapter / Build architecture | [Architecture](../ARCHITECTURE.md) | Chinese |
| Select verified commands and environment requirements | [HARNESS](../HARNESS.md) | Chinese |
| Generate, validate, and package platform artifacts | [Packaging contract](PACKAGING.md) | Chinese |
| Build locally and follow release gates | [Build and GitHub Release](RELEASE.md) | Chinese |
| Follow commit and release conventions | [Git workflow](GIT_WORKFLOW.md) | Chinese |
| Review released changes | [Changelog](../CHANGELOG.md) | Chinese |

## Contracts, evidence, and planning

- [Contract decisions](decisions/runtime-contracts.md) (Chinese): design choices and source-locking rationale.
- [Platform baseline](integration/PLATFORM_BASELINE.md) (Chinese): formats, fixtures, and host-validation boundaries.
- [Worker bridge](integration/WORKER_BRIDGE.md) (Chinese): controlled Worker integration.
- [Active Dashboard](plan/Dashboard.md) (Chinese): the single active planning entry point.
- [Readiness assessment](plan/Readiness.md) (Chinese): design inputs and remaining gaps.
- [Chinese documentation index](README.md): links to individual implementation and verification records.

The Chinese project overview and specialist documents own changing project facts. Keep the English overview and navigation aligned when installation, execution entry points, or platform boundaries change. Link to platform evidence and authoritative task state instead of maintaining parallel records in these indexes.
