# Builds and GitHub Releases

[English](RELEASE.en.md) | [简体中文](RELEASE.md)

`dhr release --dry-run` performs local builds, static validation, packaging, and manifest checks only. It does not execute npm publish, push, tag, GitHub Release, Marketplace, or deploy. GitHub Releases use a separate workflow triggered by a committed annotated `vMAJOR.MINOR.PATCH` tag; before upload it revalidates licensing, third-party notices, versions, sources, and the sizes and SHA-256 digests of all nine artifacts. Codex / DSH automatic Executors have separate host acceptance evidence; a local dry-run does not replace host-session invocation.

Prepare a clean dev-harness checkout whose commit exactly matches `protocol-lock.json`, and set its path as `DHR_PROTOCOL_CHECKOUT` from this repository's root. The adjacent `../dev-harness` checkout has drifted and cannot be used for pinned builds. The protocol path participates only in source verification and is not packaged into artifacts.

```bash
pnpm build
pnpm verify:protocol --source "$DHR_PROTOCOL_CHECKOUT"
pnpm dhr release --dry-run --protocol-checkout "$DHR_PROTOCOL_CHECKOUT"
pnpm matrix:check
```

The commands run `generate → validate → pack` in order for Codex, DSH, Cursor, OpenCode, Antigravity, and Portable. Each stage rechecks sources and the previous stage's actual bytes. `dist/manifest.json` records release, Core, and Adapter versions, target formats, the source commit, and the paths, sizes, and SHA-256 digests of nine artifacts. `dist/build-evidence.json` marks uncommitted local inputs. `docs/PLATFORM_MATRIX.md` and `docs/PLATFORM_MATRIX.en.md` are generated together from the same manifest and trusted Registry; `pnpm matrix:check` checks both language versions against actual files. Outputs remain under `.generated/` and `dist/`; nothing is published externally.

Stages can also be run separately:

```bash
pnpm generate --protocol-checkout "$DHR_PROTOCOL_CHECKOUT"
pnpm validate:plugins --protocol-checkout "$DHR_PROTOCOL_CHECKOUT"
pnpm run pack --protocol-checkout "$DHR_PROTOCOL_CHECKOUT"
```

`pnpm pack` is pnpm's own command, so invoke this project's script as `pnpm run pack`. The repository single-platform entry is `pnpm dhr build|validate|pack --platform <id> --protocol-checkout <path>`. Installed standalone CLI packages do not receive repository Packagers and retain the `CAPABILITY_MISSING` gate. After source commits or version changes, an existing manifest may no longer represent current inputs. Explicitly run `pnpm artifacts:clean` to remove local generated trees, then compile and rerun. Cleanup rejects lock files, symbolic links, and special files.

CI `verify` and `package-dry-run` passed offline checks on both Ubuntu and Windows runners; see [run 36394754252](https://github.com/Dev-Wiki/dev-harness-runtime/actions/runs/36394754252). Host installation and model-session smoke tests are not part of that workflow. The [platform matrix](PLATFORM_MATRIX.en.md) lists verified boundaries per platform. Antigravity session invocation was explicitly waived by the user and remains untested.

## GitHub Release gates

The project uses the [MIT license](../LICENSE). [Third-party notices](../THIRD_PARTY_NOTICES.md) retain the license text for each dependency included in JavaScript bundles. All nine artifacts embed `DISTRIBUTION_NOTICE.md`, combining project and third-party license texts. Source code, the upstream protocol, versions, and changelog must be committed without drift. After a local dry-run, run `node scripts/check-release.mjs v0.1.1` to check all nine actual artifacts, licensing text, and the manifest. `node scripts/release-notes.mjs v0.1.1` generates tag annotations and release notes from the matching [CHANGELOG](../CHANGELOG.en.md) version. Add `--language en` to generate English notes from the matching version in [CHANGELOG.en.md](../CHANGELOG.en.md); the default remains Chinese. This command prints local text only and does not create a tag or publish a release.

After a tag push, the [release workflow](../.github/workflows/release.yml) reinstalls locked dependencies on an Ubuntu runner, validates the protocol, runs full verification, the six-platform nine-artifact dry-run, matrix checks, and release gates, then uses GitHub CLI to create a Release and upload the nine manifest artifacts. It does not publish npm packages or platform Marketplaces, and it does not claim that untested Antigravity session invocation passed. On failure, local historical digests must not be treated as published artifacts; use the final Release attachments and workflow result as authority.

## Published versions

- [v0.1.1 GitHub Release](https://github.com/Dev-Wiki/dev-harness-runtime/releases/tag/v0.1.1): published 2026-09-30 with nine attachments; fixes the DSH 0.2.0-rc.2 peer-compatibility gate and Session v4 format. Full evidence is in the [release verification record](verification/RELEASE-v0.1.1.md).
- [v0.1.0 GitHub Release](https://github.com/Dev-Wiki/dev-harness-runtime/releases/tag/v0.1.0): published 2026-09-28 with nine attachments; sizes and SHA-256 digests match the final build manifest item by item. Full evidence is in the [release verification record](verification/RELEASE-v0.1.0.md).
