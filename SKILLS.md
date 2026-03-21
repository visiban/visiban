# Agents & Commands

Custom Claude Code automation for the Visiban project. Agents live in `.claude/agents/` and run automatically based on context. Commands live in `.claude/commands/` and are invoked explicitly with `/command-name`.

---

## Agents (`.claude/agents/`)

Agents trigger **automatically** — Claude delegates to them based on what you are working on. You can also invoke one explicitly by name in the conversation (e.g. "run the rbac-check agent").

A `PostToolUse` hook in `.claude/settings.json` additionally triggers the three most critical agents (migration-check, rbac-check, security-review) whenever Claude edits a relevant file.

```
.claude/agents/
├── architect.md          — technical design review before coding starts
├── api-docs.md           — keeps docs/api/ in sync with code changes
├── broadcast-check.md    — verifies broadcast_board_event() wiring
├── changelog.md          — writes CHANGELOG.md [Unreleased] entries
├── dependency.md         — license + CVE + justification check for new packages
├── docs.md               — writes/updates docs/features/, docs/administration/, etc.
├── duplicate-check.md    — scans GitLab issues for duplicates before opening one
├── enterprise-check.md   — OSS vs enterprise boundary evaluation
├── migration-check.md    — Django migration safety audit
├── perf-bench.md         — runs query-count benchmark suite
├── perf-check.md         — N+1 and prefetch audit
├── rbac-check.md         — RBAC and permission enforcement audit
├── regression-check.md   — pre-merge regression audit
├── security-review.md    — OWASP Top 10 + Visiban-specific security audit
├── test-scaffold.md      — generates test scaffolds for new code
└── ux-review.md          — UX/UI design review before frontend work starts
```

---

## Commands (`.claude/commands/`)

Commands are invoked explicitly with `/command-name`. These are workflow orchestrators, not checks — they are always user-initiated.

```
.claude/commands/
├── ci-debug.md   — diagnoses a failing pipeline job
├── mr.md         — creates a GitLab MR with pre-flight checks and CI polling
└── release.md    — guides the full semver release process
```

---

## When each agent triggers automatically

### Planning & design

| Agent | Triggers when |
|---|---|
| `architect` | Before any new feature or functionality change — before writing code |
| `ux-review` | Before any UI/UX change — before writing frontend code |
| `enterprise-check` | OSS vs enterprise classification is unclear |

### Implementation

| Agent | Triggers when |
|---|---|
| `migration-check` | `backend/*/models.py` modified *(also via post-edit hook)* |
| `rbac-check` | Any API endpoint added or modified *(also via post-edit hook on views.py)* |
| `security-review` | Any view, serializer, auth, or file-upload code modified *(also via post-edit hook)* |
| `broadcast-check` | Any write operation on board-scoped resources added or modified |
| `perf-check` | Any viewset, serializer, or database query modified |
| `perf-bench` | New `SerializerMethodField` on `CardSerializer`, new relation on `Card`/`Board`/`CardMovement`, or perf-check flags a potential N+1 |
| `dependency` | Before adding a new pip or npm package |

### Testing & documentation

| Agent | Triggers when |
|---|---|
| `test-scaffold` | New feature or bug fix without existing test coverage |
| `docs` | Writing or updating feature, architecture, or administration documentation |
| `api-docs` | Any endpoint, serializer field, or permission rule added or modified |
| `changelog` | Before opening an MR on any branch that touches source code |

### Verification

| Agent | Triggers when |
|---|---|
| `regression-check` | Before opening an MR on any branch that changes source code |
| `duplicate-check` | Before creating a new GitLab issue |

---

## Agent descriptions

### `architect`
Reviews a feature or implementation for technical debt before any code is written. Audits for premature abstraction, model placement, migration risk, API surface changes, coupling, naming accuracy, test coverage gaps, and reversibility. Flags open questions as blocking / important / deferred and outputs a named debt register for any shortcuts taken.

### `api-docs`
Ensures `docs/api/` is in sync with code changes. Checks that every new or modified endpoint has complete documentation — HTTP method, permissions, request fields, response example, and error cases. Flags missing enterprise callouts and `mkdocs.yml` nav entries.

### `broadcast-check`
Verifies that `broadcast_board_event()` is correctly wired for every write operation. Checks that broadcasts are deferred with `transaction.on_commit()` rather than firing inside a transaction, that payloads are complete, and that the frontend socket handler exists for the event type.

### `changelog`
Writes the correct `CHANGELOG.md [Unreleased]` entry for the current branch. Determines entry type (Added / Changed / Fixed / Security), appends to the existing section without creating duplicate headings, and follows the project's Keep a Changelog format. Required before every MR that touches source code.

### `dependency`
Reviews a new pip or npm package before it is added. Checks the license (blocks GPL-2.0/3.0), looks up known CVEs, evaluates whether the dependency is justified vs. using existing tools, and assesses transitive dependency and bundle size impact.

### `docs`
Guides writing and updating user-facing documentation in `docs/`. Identifies the correct location for new content, applies version callouts (`> **Added in 1.1**`) to net-new features, applies enterprise callouts where required, updates `mkdocs.yml` nav, enforces US English and MkDocs admonition syntax, and verifies the build with `mkdocs build --strict`.

### `duplicate-check`
Scans open (and recently closed) GitLab issues for duplicates before a new issue is created. Fetches the full issue list, extracts key terms from the proposed issue, classifies each candidate as exact duplicate / partial overlap / superseded / conflict / no match, flags any pair of open issues with contradictory requirements, and recommends whether to open, reference, or close as duplicate.

### `enterprise-check`
Evaluates whether a feature belongs in the OSS repo or the enterprise repo, applying the guiding principle: *"Can a small team use Visiban end-to-end without this?"* If no → OSS. If yes → enterprise candidate. Identifies required OSS extension points for enterprise features and flags grey areas with explicit OSS/enterprise boundary definitions.

### `migration-check`
Audits Django model changes for migration safety. Flags missing migrations, destructive operations (`DROP COLUMN`, `NOT NULL` without default, column renames), index additions on large tables, and data migrations without rollback. Recommends multi-step deploy sequences for high-risk changes.

### `perf-bench`
Runs the performance benchmark suite and query-count regression tests against the three most sensitive endpoints (`/cards/`, `/full/`, `/summary/`). Each endpoint has a query budget and a scale invariant. Profiles N+1 root causes in `CardSerializer` method fields and verifies fixes are clean.

### `perf-check`
Reviews backend code for query performance issues. Identifies N+1 patterns in viewsets and serializers, verifies `select_related`/`prefetch_related` coverage against known safe patterns, checks for missing `@transaction.atomic` boundaries, and audits broadcast calls for synchronous loops.

### `rbac-check`
Audits a new or modified API endpoint for correct role-based access control. Verifies authentication gates, board membership checks, minimum role per HTTP action, cross-board ID isolation, and group inheritance via `get_board_role()`. A missing permission check is treated as a security vulnerability.

### `regression-check`
Audits a branch for regressions before merge. Maps changed files to risk zones (schema, API contract, endpoint behaviour, type interfaces, API client, hooks, components), finds indirect dependents via grep, identifies stale mocks and fixtures, checks permission boundary changes, verifies broadcast wiring, runs the affected test suites, and produces a structured regression report.

### `security-review`
Audits new or modified code against the OWASP Top 10 and Visiban-specific patterns. Covers broken access control (IDOR, missing `get_board_role()` calls), cryptographic failures, injection, insecure design, serializer field exposure, WebSocket broadcast safety, and frontend `dangerouslySetInnerHTML` usage.

### `test-scaffold`
Generates a well-structured test suite for new or modified code. Produces Django `TestCase` scaffolds (with `APIClient`, permission boundary tests, and atomic behaviour tests) for backend, and Vitest + React Testing Library scaffolds (with loading, error, and interaction tests) for frontend. Covers behaviour, not implementation.

### `ux-review`
Reviews a UI or UX change against the design system in `frontend/CLAUDE.md`. Audits color token usage, component reuse, typography, interactive states, dark theme correctness, affordance, visual hierarchy, and information density. Runs a polish checklist and surfaces new design rules to add to `frontend/CLAUDE.md`.

---

## Commands

### `/mr`
Creates a GitLab MR for the current branch following project conventions. Runs pre-flight checks (branch name, CHANGELOG updated), drafts a title and description from the git diff and commit history, creates the MR, posts local test results as a comment, polls the CI pipeline, and posts its result.

### `/ci-debug`
Diagnoses a failing GitLab pipeline job. Fetches the job log via `glab`, maps the failure to its root cause (not just the symptom), and prescribes a specific fix. Never suggests retrying without a code change unless the failure is clearly infrastructure-related.

### `/release`
Guides the full release process. Suggests a semver version from `CHANGELOG.md [Unreleased]` and git log, confirms it with the user, runs pre-flight checks, executes `scripts/release.sh {version}`, and verifies the deployed stack and docs site after completion.
