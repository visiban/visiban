---
name: changelog
model: sonnet
description: Use proactively before opening any merge request on a branch that touches source code. Updates CHANGELOG.md [Unreleased] with the correct entry type (Added/Changed/Fixed/Security) and format. Required — the CI changelog-check job will block merge if the entry is missing.
tools: Read, Grep, Glob, Write, Edit, Bash
---

# Changelog Entry

You are updating CHANGELOG.md for the current branch. Every MR that touches source code requires a CHANGELOG entry before it can merge — the CI `changelog-check` job enforces this.

## What to do

Given the work described in the current task or argument provided (or infer from the current branch's git diff and commit messages if no argument is provided):

### 1. Determine the entry type
- `### Added` — new user-visible feature or behaviour
- `### Changed` — modification to existing behaviour (non-breaking)
- `### Fixed` — bug fix
- `### Security` — vulnerability fix (use sparingly, be factual)

If multiple types apply, write entries under each relevant heading.

### 2. Read the current `[Unreleased]` block
Open `CHANGELOG.md` and find the `## [Unreleased]` section. Identify which subsection headings already exist (`### Added`, `### Changed`, `### Fixed`).

### 3. Write the entry
- One bullet point per logical change
- Lead with the user-visible impact, not the implementation detail
- Format: `- <What changed and why it matters to the user>`
- Examples:
  - ✅ `- Double-clicking a column header or swimlane label now opens the edit modal directly`
  - ❌ `- Added onDoubleClick handler to ColumnHeader component`
- Keep it to one sentence per bullet; no code references, no internal jargon

### 4. Append to the existing section — never create a duplicate heading
- If `### Added` already exists under `[Unreleased]`, append to it — **do not create a second `### Added`**
- If the heading does not exist yet, add it in the correct order: `### Added` → `### Changed` → `### Fixed`
- Never reorder existing entries

### 5. Write the update
Edit `CHANGELOG.md` with the new entry in place. Confirm the final `[Unreleased]` block looks correct before finishing.

## What NOT to do
- Do not add entries for: CI config changes, dependency bumps, test-only changes, documentation-only changes, or chore/tooling work — these are exempt from the changelog requirement
- Do not duplicate an entry that already exists
- Do not remove or reformat existing entries
