# Changelog

[English](CHANGELOG.en.md) | [简体中文](CHANGELOG.md)

## Unreleased

### Added

- Complete English counterparts for platform support, public contracts, recovery and migration, build / release, and contributor documentation. English navigation links to the corresponding English bodies.

### Changed

- Generate and check Chinese and English platform matrices from the same verified manifest and Registry. The release-notes tool supports selecting the English changelog.

## v0.1.1 — 2026-09-30

### Fixed

- Fix plugin installation incompatibility on DSH 0.2.0-rc.2: peer declarations for `@deepseek-ai/dsh-commands` and `@deepseek-ai/dsh-tools` change from exact `0.1.5-rc.2` to `^0.2.0-rc.2`; Cordis is recorded as `~4.0.4` according to actual resolution. DSH compares only peer ranges for `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` against its runtime version. The old exact declarations were considered incompatible with 0.2.0-rc.2 and installation was rejected.
- Support DSH 0.2.0-rc.2's Session v4 format: the Session reader accepts `version: 4`; the event decoder interprets `tool/result` using the v4 representation (`role: "tool"` direct messages and `message.toolCallId`) instead of relying on the retired `tool-result` wrapper block.

### Changed

- Migrate the DSH adapter target baseline from `0.1.5-rc.1` to `0.2.0-rc.2`. Update build targets, runtime gates, host tests, fixtures, and platform baseline documentation together, and obtain fresh verification evidence on the actual 0.2.0-rc.2 host.

## v0.1.0 — 2026-09-28

### Added

- Shared Core provides Planning task selection, authorization, snapshots and drift checks, persistent state, recovery, independent acceptance, and serial orchestration.
- Codex and DSH Executors use shared contracts and independent Sessions, with per-task commits after explicit authorization.
- Generate nine local artifacts for Codex, DSH, Cursor, OpenCode, Antigravity, and Portable from the same `run`, `status`, and `worker` Skill sources. The Portable package contains Skills only and has no independent Executor.
- `dhr` provides read-only status and diagnostics, task execution entry points, generation, validation, packaging, and local release dry-run.
- Ubuntu and Windows CI each run full offline verification and the nine-artifact dry-run. The artifact manifest records versions, sources, and SHA-256 digests.
- Adopt the MIT project license; all nine artifacts include the project license and notices for bundled third-party dependencies.

### Changed

- Distinguish platform capabilities by verification evidence. Antigravity installation, discovery, and removal have been verified; model-session Skill invocation was explicitly waived by the user and remains untested.
