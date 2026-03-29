---
name: changelog
model: sonnet
description: Use proactively before opening any merge request on a branch that touches source code. Creates a changelog fragment file in changelog.d/ with the correct entry type. Required — the CI changelog-check job will block merge if the fragment is missing.
tools: Read, Grep, Glob, Write, Edit, Bash
---

# Changelog Fragment

You are creating a changelog fragment for the current branch. Every MR that touches source code requires a changelog entry before it can merge — the CI `changelog-check` job enforces this.

Fragments are small files in `changelog.d/` that get assembled into `CHANGELOG.md` at release time. This eliminates merge conflicts between concurrent branches.

## What to do

Given the work described in the current task or argument provided (or infer from the current branch's git diff and commit messages if no argument is provided):

### 1. Determine the entry type
- `added` — new user-visible feature or behavior
- `changed` — modification to existing behavior (non-breaking)
- `fixed` — bug fix
- `security` — vulnerability fix (use sparingly, be factual)

If multiple types apply, create one fragment file per type.

### 2. Choose a filename

Format: `<issue-or-slug>.<type>.md`

- Use the GitLab issue number when one exists: `434.fixed.md`
- Use a short kebab-case slug when there is no issue: `fix-csv-header.fixed.md`
- For multiple types on the same issue, create separate files: `337.added.md` and `337.changed.md`

### 3. Write the entry

- One bullet point per logical change (the `- ` prefix is optional — the assembly script adds it if missing)
- Lead with the user-visible impact, not the implementation detail
- Examples:
  - ✅ `Double-clicking a column header or swimlane label now opens the edit modal directly`
  - ❌ `Added onDoubleClick handler to ColumnHeader component`
- Keep it to one sentence per bullet; no code references, no internal jargon
- Include the issue number at the end: `(#434)`

### 4. Check for duplicates

Run `ls changelog.d/` to see if a fragment already exists for this issue or topic. Update the existing file rather than creating a duplicate.

### 5. Create the file

Write the fragment to `changelog.d/<filename>`. Confirm the file exists and is correctly named before finishing.

### 6. Preview (optional)

Run `scripts/assemble-changelog.sh --dry-run` to see how the entry will appear in the assembled changelog.

## What NOT to do
- Do not edit `CHANGELOG.md` directly — always create a fragment file
- Do not add entries for: CI config changes, dependency bumps, test-only changes, documentation-only changes, or chore/tooling work — these are exempt from the changelog requirement
- Do not create a fragment that duplicates an existing one
