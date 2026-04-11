---
name: review
description: Code review against project conventions for a specific file or the full branch diff.
argument-hint: "[path/to/file]"
---

# Code Review

Review code against project conventions. Unlike `security-review` (OWASP focus) or `ux-review` (design system focus), this covers general code quality, patterns, consistency, and correctness.

Usage:
```
/review                    # review all changes on the current branch vs main
/review path/to/file.py    # review a specific file
```

---

## Step 1 — Determine scope

If `$ARGUMENTS` is a file path, review that file. Otherwise, review the full diff of the current branch against `main`:

```bash
git diff main...HEAD
```

---

## Step 2 — Gather context (parallel sub-agents)

Launch **2 sub-agents in parallel** (both with `model: "sonnet"`). Wait for both.

**Sub-agent 1 — Project conventions:**
> Read `CLAUDE.md` and identify:
> - Coding conventions (naming, formatting, patterns)
> - Testing requirements
> - Documentation requirements
> - Security rules
> - Any framework-specific rules
>
> Return a structured checklist of conventions to check against.

**Sub-agent 2 — Related code patterns:**
> For each file in the diff, find 2-3 similar files in the codebase (same directory, same type, similar purpose). Read them to understand the established patterns:
> - Import ordering
> - Error handling patterns
> - Naming conventions in practice
> - Test patterns for similar code
>
> Return: the established patterns with examples.

---

## Step 3 — Review the code

For each file in the diff, check against:

### Correctness
- Logic errors, off-by-one, race conditions
- Missing error handling at system boundaries
- Incomplete state transitions (loading/error/empty states in UI)

### Conventions
- Follows project naming conventions
- Matches established patterns in similar files
- Imports ordered consistently

### Consistency
- New code follows the same patterns as existing code in the same module
- No duplicate logic that could use an existing utility

### Testing gaps
- New public functions/methods without test coverage
- Changed behavior without updated test assertions
- Stale mocks that don't reflect the current module API

### Documentation gaps
- Complex business logic without explaining comments
- User-visible changes without doc updates

---

## Step 4 — Output

Group findings by severity:

```
## Code Review — <branch or file>

### Blocking
- <file:line> — <specific issue and why it matters>

### Suggestions
- <file:line> — <improvement and rationale>

### Observations
- <pattern noticed but not necessarily wrong>

### Summary
X files reviewed, Y issues found (Z blocking).
```

---

## Rules

- Be specific — every finding must include the file, line, and what the issue is
- Explain *why* something is a problem, not just *that* it is
- Do not flag style preferences that aren't in the project's conventions
- Do not suggest refactors beyond what the diff touches
- If the code is clean, say so — do not invent findings
