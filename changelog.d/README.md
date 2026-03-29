# Changelog Fragments

Each MR that requires a changelog entry drops a small file here instead of
editing `CHANGELOG.md` directly. This eliminates merge conflicts between
concurrent branches.

## File naming

```
<issue-or-slug>.<type>.md
```

- **issue-or-slug** — GitLab issue number (e.g. `434`) or a short kebab-case
  slug when there is no issue (e.g. `fix-csv-header`)
- **type** — one of: `added`, `changed`, `fixed`, `security`

Examples:

```
434.fixed.md
337.added.md
fix-csv-header.fixed.md
```

## File contents

One bullet point per file. Lead with user-visible impact, not implementation
detail. No blank lines, no heading — just the entry text:

```
JSON board export now includes movement history and activity log entries —
previously export → import round-trips silently dropped all timeline data (#434)
```

Multiple bullets in one file are fine when they belong to the same logical
change. Use one file per issue/topic, not one file per bullet.

## What happens at release time

`scripts/assemble-changelog.sh` collects all fragments, groups them by type,
appends them to `CHANGELOG.md` under `[Unreleased]`, and deletes the fragment
files. The release script calls this automatically.

## When to skip

The CI `changelog-check` job auto-skips for branches that only touch CI config,
docs, tests, or tooling. You can also add the `~no-changelog` label to skip
manually.
