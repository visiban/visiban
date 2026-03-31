# Pre-Release Audit

You are running a pre-release audit of the full Visiban codebase. Unlike day-to-day agents (which are scoped to what changed in a branch), every agent here audits the **entire codebase** through a "public contract" lens — asking "what becomes a commitment we can't take back at 1.0+?" rather than "is this change correct?".

## Step 0 — Determine audit type

Read `$ARGUMENTS`. Valid types: `full`, `security`, `performance`, `frontend`, `docs`, `contracts`, `deps`, `enterprise`.

If `$ARGUMENTS` is empty or not one of the above, present this menu and ask the user to choose:

```
Which pre-release audit would you like to run?

  full         All 13 agents in 3 parallel waves
  security     security-review + rbac-check
  performance  perf-check + perf-bench
  frontend     ux-review + broadcast-check
  docs         api-docs + docs
  contracts    architect (full codebase) + migration-check
  deps         dependency
  enterprise   enterprise-check
```

Wait for the user's choice before proceeding.

---

## Step 1 — Run the audit

For each agent below, the prompt must be written for **full codebase audit mode** — not "what changed in this branch". Frame every prompt as: "Audit the full Visiban codebase as if preparing a 1.0 public release. Identify any issues that would become public commitments we can't easily reverse."

### `security`
Run in parallel:
1. **security-review** — Full codebase OWASP Top 10 audit. Check all views, serializers, authentication paths, file upload handlers, invite flows, and user-controlled input across the entire backend. Flag any IDOR, serializer field exposure, or WebSocket broadcast safety issues.
2. **rbac-check** — Audit every API endpoint across the full codebase. Verify authentication gates, board membership checks, and minimum role enforcement per HTTP action. A missing permission check is a security vulnerability.

### `performance`
Run in parallel:
1. **perf-check** — Full codebase N+1 audit. Review every viewset and serializer for missing `select_related`/`prefetch_related`, unguarded `SerializerMethodField` database hits, and missing transaction boundaries.
2. **perf-bench** — Benchmark audit. Focus on `CardSerializer`, `BoardSerializer`, the `/full/` endpoint, and the analytics/summary endpoints. Identify any relation that will cause query count to scale with board size.

### `frontend`
Run in parallel:
1. **ux-review** — Full frontend codebase review against the Visiban design system in `frontend/CLAUDE.md`. Check all components, layouts, modals, and pages for design system compliance.
2. **broadcast-check** — Full audit of all write operations (create, update, delete, move) on board-scoped resources. Verify `broadcast_board_event()` is correctly wired, deferred with `transaction.on_commit()`, and that the frontend socket handler exists for every event type.

### `docs`
Run in parallel:
1. **api-docs** — Full API surface audit. Every endpoint, serializer field, permission rule, and query parameter must be reflected in `docs/api/`. Flag any missing, stale, or incomplete documentation.
2. **docs** — Full documentation audit. Check `docs/features/`, `docs/getting-started/`, and `docs/administration/` for completeness. Every user-visible feature must have a doc page with correct version callouts and enterprise callouts where applicable.

### `contracts`
Run in parallel:
1. **architect** — Full codebase architecture audit in "public contract" mode. Review the REST API shape, WebSocket event schema, TypeScript interfaces, settings/env vars, and OSS/enterprise extension boundary. Flag any API shape, field name, event type, or extension point that is inconsistent or fragile and would be painful to change post-1.0.
2. **migration-check** — Full migration history audit. Check for destructive operations, missing migrations, NOT NULL columns without defaults, and any pattern that would break a zero-downtime deploy.

### `deps`
1. **dependency** — Full dependency audit across all pip and npm packages. Check licenses (block GPL-2.0/3.0), known CVEs, and whether any dependency has been superseded by a safer or lighter alternative.

### `enterprise`
1. **enterprise-check** — Full OSS/enterprise boundary audit. Verify the OSS core is fully functional without the enterprise repo. Check that all extension points (settings includes, URL patterns, signal hooks) are stable and that no enterprise logic has leaked into OSS files.

### `full`
Run all agents above in 3 parallel waves:

**Wave 1** (security + performance):
- security-review, rbac-check, perf-check, perf-bench

**Wave 2** (frontend + contracts):
- ux-review, broadcast-check, architect (full codebase mode), migration-check

**Wave 3** (docs + ecosystem):
- api-docs, docs, dependency, enterprise-check, regression-check

---

## Step 2 — Consolidate findings

After all agents complete, produce a consolidated report using this format:

```
## Pre-Release Audit Report — <type> — <date>

### Summary
🔴 Blocking: N   🟡 Should-fix: N   🟢 Clean: N

### 🔴 Blocking findings
(issues that must be resolved before a release tag is cut)

### 🟡 Should-fix findings
(issues that should be tracked and resolved soon after release)

### 🟢 Clean areas
(agents that found no issues)
```

Severity guide:
- 🔴 **Blocking** — security vulnerability, data loss risk, broken public API contract, missing migration, or anything that would be painful/impossible to fix post-release without a major bump
- 🟡 **Should-fix** — quality issue, stale doc, performance concern, or UX violation that is not release-blocking but should be tracked
- 🟢 **Clean** — no issues found by this agent

---

## Step 3 — GitLab issue check

After the report:

1. Query GitLab for open issues related to each 🔴 and 🟡 finding:
   ```bash
   glab issue list --repo visiban/visiban --state opened --search "<keyword>"
   ```

2. For findings that do **not** have an existing open issue, offer to create one:
   - 🔴 findings → milestone: current release (or next RC)
   - 🟡 findings → milestone: next minor release or `post-1.0`
   - Label 🔴 as `pre-1.0` (red), 🟡 as `post-1.0` (blue)

3. Ask the user: "Create GitLab issues for the N untracked findings above? (y/n)"
   - If yes, create them using `glab issue create` with heredoc descriptions
   - If no, list the findings as a checklist the user can act on manually

---

## Step 4 — Gate check (full audit only)

If the audit type was `full`:

- If any 🔴 blocking findings remain unresolved → **do not proceed to `/release`**. Tell the user: "Pre-release audit found N blocking issue(s). Resolve these before running `/release`."
- If only 🟡 findings remain → advise the user to triage them, then they may proceed to `/release`
- If all findings are 🟢 → "Pre-release audit passed. You may proceed to `/release`."
