# Git workflow contract

[English](GIT_WORKFLOW.en.md) | [简体中文](GIT_WORKFLOW.md)

This is the repository's authoritative policy for branches, commits, tags, changelogs, and release text.

## Policy source and commit identity

The repository uses the user-selected default template from `dev-harness-git-workflow`. This document is its sole Git and release policy.

Set commit identity only in this repository's local Git configuration:

- `user.name`: `Dev-Wiki`
- `user.email`: `devwiki2014@gmail.com`

Changing global Git identity is outside this project's initialization scope.

## Branch mode

**Confirmed mode**: `single-branch`.

The default branch is `main`; continue development directly on it. The user explicitly confirmed this mode.

Do not create or switch branches unless the project mode changes or the user explicitly requests it.

## Commit convention

Use Conventional Commits:

```text
<type>(<scope>): <中文描述>
```

The placeholder `<中文描述>` means a Chinese description. `scope` is optional. Allowed default `type` values are:

- `feat`
- `fix`
- `docs`
- `style`
- `refactor`
- `perf`
- `test`
- `build`
- `ci`
- `chore`
- `revert`

Descriptions must state the concrete purpose in natural Chinese; use natural English only when the user explicitly requests it. Add project-specific issue references only when the project has defined them.

## Tags

- Use SemVer annotated tags in `vMAJOR.MINOR.PATCH` format.
- Prereleases may use `vMAJOR.MINOR.PATCH-PRERELEASE`.
- Do not create or replace tags without an explicit release or tag request.

## Changelog

The default changelog is `CHANGELOG.md`; initialize it only after explicit user confirmation or when starting the first release.

Release categories use this order, with corresponding internal English categories in parentheses:

1. Breaking changes (`Breaking Changes`)
2. Additions (`Added`)
3. Changes (`Changed`)
4. Deprecations (`Deprecated`)
5. Fixes (`Fixed`)
6. Removals (`Removed`)
7. Security (`Security`)

Deleted content belongs under `Removed`. Final version records omit empty categories.

## Tag annotations and release notes

Generate both from the corresponding changelog version:

```text
发布 vMAJOR.MINOR.PATCH

<按分类整理的非空变更日志内容>
```

The example means "Release vMAJOR.MINOR.PATCH" followed by nonempty changelog entries organized by category. Preserve the category order and omit empty categories. If the matching changelog version is missing, stop and request confirmation; do not invent release content from commit subjects.

## Commit safety checks

Before committing:

- Inspect the full working-tree and index diffs.
- Preserve existing staging boundaries.
- Stage each owned file separately with `git add -- <file>` and verify the staged set.
- Stop if suspected secrets, credentials, unexpectedly large files, or unrelated changes appear.
- Stop on temporary debug output such as `Console.WriteLine`, `Debug.Log`, or bare `print(` unless the project confirms it is intentional.

## Action authorization boundaries

Repository initialization and policy maintenance do not automatically authorize commits or publishing. commit, push, PR, tag, release, and deploy each follow an explicit user request. A commit request does not include subsequent publication.

By design, `dhr release --dry-run` produces local artifacts only; it is not a Git tag or remote release.
