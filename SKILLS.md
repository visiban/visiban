# Skills

Custom Claude Code slash commands for the Visiban project. Skills live in `.claude/commands/` and are invoked by typing `/skill-name` in Claude Code.

---

## Directory

```
.claude/commands/
├── architect.md
├── api-docs.md
├── broadcast-check.md
├── changelog.md
├── ci-debug.md
├── dependency.md
├── enterprise-check.md
├── migration-check.md
├── mr.md
├── perf-check.md
├── rbac-check.md
├── release.md
├── test-scaffold.md
└── ux-review.md
```

---

## When to use each skill

### Planning & design

| Skill | Invoke when |
|---|---|
| `/architect` | Starting any new feature or changing existing functionality — before writing code |
| `/ux-review` | Starting any UI or UX change — before writing frontend code |
| `/enterprise-check` | Unsure whether a feature belongs in OSS or the enterprise repo |

### Implementation

| Skill | Invoke when |
|---|---|
| `/migration-check` | Any `backend/*/models.py` file is modified |
| `/rbac-check` | Adding or modifying any API endpoint |
| `/broadcast-check` | Adding or modifying any write operation on board-scoped resources |
| `/perf-check` | Adding or modifying any viewset, serializer, or database query |
| `/dependency` | Before adding a new pip or npm package |

### Testing & documentation

| Skill | Invoke when |
|---|---|
| `/test-scaffold` | Implementing a new feature or bug fix without existing test coverage |
| `/docs` | Writing or updating any feature, architecture, or administration documentation |
| `/api-docs` | Adding or modifying an endpoint, serializer field, or permission rule |
| `/changelog` | Before opening an MR on any branch that touches source code |

### Merge & deploy

| Skill | Invoke when |
|---|---|
| `/mr` | Ready to open a merge request |
| `/ci-debug` | A pipeline job fails — before attempting any fix |
| `/release` | Creating a new release |

---

## Skill descriptions

### `/architect`
Reviews a feature or implementation for technical debt before any code is written. Audits for premature abstraction, model placement, migration risk, API surface changes, coupling, naming accuracy, test coverage gaps, and reversibility. Flags open questions as blocking / important / deferred and outputs a named debt register for any shortcuts taken.

### `/docs`
Guides writing and updating user-facing documentation in `docs/`. Identifies the correct location for new content, applies version callouts (`> **Added in 1.1**`) to net-new features, applies enterprise callouts where required, updates `mkdocs.yml` nav, enforces US English and MkDocs admonition syntax, and verifies the build with `mkdocs build --strict`.

### `/api-docs`
Ensures `docs/api/` is in sync with code changes. Checks that every new or modified endpoint has complete documentation — HTTP method, permissions, request fields, response example, and error cases. Flags missing enterprise callouts and `mkdocs.yml` nav entries.

### `/broadcast-check`
Verifies that `broadcast_board_event()` is correctly wired for every write operation. Checks that broadcasts are deferred with `transaction.on_commit()` rather than firing inside a transaction (which can push rolled-back state to clients), that payloads are complete, and that the frontend socket handler exists for the event type.

### `/changelog`
Writes the correct `CHANGELOG.md [Unreleased]` entry for the current branch. Determines entry type (Added / Changed / Fixed), appends to the existing section without creating duplicate headings, and follows the project's Keep a Changelog format. Required before every MR that touches source code.

### `/ci-debug`
Diagnoses a failing GitLab pipeline job. Fetches the job log via `glab`, maps the failure to its root cause (not just the symptom), and prescribes a specific fix. Never suggests retrying without a code change unless the failure is clearly infrastructure-related.

### `/dependency`
Reviews a new pip or npm package before it is added. Checks the license (blocks GPL-2.0/3.0), looks up known CVEs, evaluates whether the dependency is justified vs. using existing tools, and assesses transitive dependency and bundle size impact.

### `/enterprise-check`
Evaluates whether a feature belongs in the OSS repo or the enterprise repo, applying the guiding principle: *"Can a small team use Visiban end-to-end without this?"* If no → OSS. If yes → enterprise candidate. Identifies required OSS extension points for enterprise features and flags grey areas with explicit OSS/enterprise boundary definitions.

### `/migration-check`
Audits Django model changes for migration safety. Flags missing migrations, destructive operations (`DROP COLUMN`, `NOT NULL` without default, column renames), index additions on large tables, and data migrations without rollback. Recommends multi-step deploy sequences for high-risk changes.

### `/mr`
Creates a GitLab MR for the current branch following project conventions. Runs pre-flight checks (branch name, CHANGELOG updated), drafts a title and description from the git diff and commit history, and creates the MR using heredoc syntax. Confirms the pipeline starts and reminds not to merge until it is green.

### `/perf-check`
Reviews backend code for query performance issues. Identifies N+1 patterns in viewsets and serializers, verifies `select_related`/`prefetch_related` coverage against known safe patterns, checks for missing `@transaction.atomic` boundaries, and audits broadcast calls for synchronous loops. Flags regressions to the full board fetch endpoint.

### `/rbac-check`
Audits a new or modified API endpoint for correct role-based access control. Verifies authentication gates, board membership checks, minimum role per HTTP action, cross-board ID isolation, and group inheritance via `get_board_role()`. A missing permission check is treated as a security vulnerability.

### `/release`
Guides the full release process. Suggests a semver version from `CHANGELOG.md [Unreleased]` and git log, confirms it with the user, runs pre-flight checks, executes `scripts/release.sh {version}`, and verifies the deployed stack and docs site after completion.

### `/test-scaffold`
Generates a well-structured test suite for new or modified code. Produces Django `TestCase` scaffolds (with `APIClient`, permission boundary tests, and atomic behaviour tests) for backend, and Vitest + React Testing Library scaffolds (with loading, error, and interaction tests) for frontend. Covers behaviour, not implementation.

### `/ux-review`
Reviews a UI or UX change against the design system in `frontend/CLAUDE.md`. Audits color token usage, component reuse, typography, interactive states, dark theme correctness, affordance, visual hierarchy, and information density. Runs a polish checklist (hover, focus, transitions, truncation, responsive behaviour) and surfaces new design rules to add to `frontend/CLAUDE.md`.
