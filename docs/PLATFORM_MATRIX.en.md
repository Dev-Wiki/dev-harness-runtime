# Platform capability evidence matrix

[English](PLATFORM_MATRIX.en.md) | [简体中文](PLATFORM_MATRIX.md)

This table is generated from the nine actual artifact digests in the local release manifest and the trusted PlatformRegistry. It describes packaging artifacts and the default Registry only, not a substitute for host capability probes. Host installation, in-session Skill invocation, and authorization isolation are documented in the per-task verification records.

| Target | Artifacts | Static artifacts | RuntimeAdapter | Automatic orchestration | Evidence |
|---|---:|---|---|---|---|
| Codex | 1 | SHA-256 verified | Not registered | Disabled | [K5-P](plan/archive/M3/K5-P.md) / [Verification](verification/K5-P.md) |
| DSH | 1 | SHA-256 verified | Not registered | Disabled | [K6-P](plan/archive/M3/K6-P.md) / [Verification](verification/K6-P.md) |
| Cursor | 1 | SHA-256 verified | Not registered | Disabled | [K7](plan/archive/M3/K7.md) / [Verification](verification/K7.md) |
| OpenCode | 2 | SHA-256 verified | Not registered | Disabled | [K8](plan/archive/M3/K8.md) / [Verification](verification/K8.md) |
| Antigravity | 3 | SHA-256 verified | Not registered | Disabled | [K9](plan/archive/M3/K9.md) / [Verification](verification/K9.md) |
| Portable Agent Plugin | 1 | SHA-256 verified | No independent Executor | Disabled | [K10-G](plan/archive/M3/K10-G.md) / [Verification](verification/K10-G.md) |

The packaged Codex / DSH CLI can register a Task Executor after a trusted host probe passes; see [K5](verification/K5.md) and [K6](verification/K6.md). “Not registered / Disabled” in this table means only that the default Registry does not inject host capabilities. Installation and invocation for other hosts are reported separately. Portable carries shared Skills only and has no independent Executor; run requests without a trusted Adapter return `CAPABILITY_MISSING`. External distribution requires the project license, third-party notices, committed sources, and digest gates.
