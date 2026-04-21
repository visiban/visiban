---
name: pre-release
description: Run a pre-release audit of the full Visiban codebase before cutting a release tag.
argument-hint: "<full|security|performance|frontend|docs|contracts|deps|enterprise|tests>"
---

# Pre-Release Audit

You are running a pre-release audit of the full Visiban codebase. Unlike day-to-day agents (which are scoped to what changed in a branch), every agent here audits the **entire codebase** through a "public contract" lens — asking "what becomes a commitment we can't take back at the next release?" rather than "is this change correct?".

## Step 0 — Determine current working release

Before anything else, determine the **current working release** (the version we are about to cut next). This is used to label issues, frame agent prompts, and decide severity. Do not hardcode `1.0` or `1.1` — always resolve dynamically.

Resolution order:
1. Read `frontend/package.json` — the `version` field records the **last shipped** release (e.g. `1.0.0`).
2. The **current working release** is the next open GitLab milestone strictly greater than the shipped version. Query:
   ```bash
   glab api "projects/visiban%2Fvisiban/milestones?state=active" 2>/dev/null \
     | python3 -c "import json,sys; ms=json.load(sys.stdin); print('\n'.join(m['title'] for m in sorted(ms, key=lambda m: [int(x) for x in m['title'].split('.')])))"
   ```
   Pick the smallest milestone title greater than the shipped version. That is `$WORKING_RELEASE` (e.g. `1.1`).
3. Confirm with the user in one line: "Auditing against the **$WORKING_RELEASE** release (last shipped: $SHIPPED). Proceed?" — only if the audit type is `full`. For targeted audits, skip the confirmation and proceed silently.

Export `$WORKING_RELEASE` for use in every subsequent step. Every agent prompt, every GitLab issue, and the final gate check reference this variable — never a hardcoded version string.

---

## Step 0.1 — Determine audit type

Read `$ARGUMENTS`. Valid types: `full`, `security`, `performance`, `frontend`, `docs`, `contracts`, `deps`, `enterprise`, `tests`.

If `$ARGUMENTS` is empty or not one of the above, present this menu and ask the user to choose:

```
Which pre-release audit would you like to run?

  full         All 14 agents in 3 parallel waves
  security     security-review + rbac-check
  performance  perf-check + perf-bench
  frontend     ux-review + broadcast-check
  docs         api-docs + docs
  contracts    architect (full codebase) + migration-check
  deps         dependency
  enterprise   enterprise-check
  tests        test-scaffold (coverage gaps across all apps)
```

Wait for the user's choice before proceeding.

---

## Step 0.5 — Pre-flight: check for prior audit findings

Before launching any agents, check whether a recent pre-release audit has already been run and its findings already filed as GitLab issues for the current working release.

```bash
glab issue list --repo visiban/visiban --state opened --label "$WORKING_RELEASE" --search "audit" 2>/dev/null | head -20
glab issue list --repo visiban/visiban --state opened --label "$WORKING_RELEASE" 2>/dev/null | head -30
```

Also check for recently closed audit issues (resolved since last run):
```bash
glab issue list --repo visiban/visiban --state closed --label "$WORKING_RELEASE" --updated-after "$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d)" 2>/dev/null | head -20
```

**If open `$WORKING_RELEASE` issues exist from a prior audit:**
1. List them for the user grouped by severity (🔴 blocking vs 🟡 should-fix).
2. Say: "A prior audit has N open finding(s) against $WORKING_RELEASE still unresolved (see above). Re-running will re-discover the same issues. Options:
   - **resolve** — work through the open issues first, then re-run the audit
   - **continue** — re-run anyway (e.g. significant code has changed since the last run)
   - **targeted** — run only a specific sub-audit (e.g. `/pre-release security`) on the area you just fixed"
3. Wait for the user's choice before proceeding.
   - If "resolve" → stop here. Do not launch any agents.
   - If "targeted" → jump to Step 0.1 to let the user pick a specific audit type.
   - If "continue" → proceed to Step 1.

**If no open `$WORKING_RELEASE` issues exist** → proceed to Step 1 immediately with no prompt.

---

## Step 1 — Run the audit

For each agent below, the prompt must be written for **full codebase audit mode** — not "what changed in this branch". Frame every prompt as: "Audit the full Visiban codebase as if preparing the **$WORKING_RELEASE** public release. Identify any issues that would become public commitments we can't easily reverse once $WORKING_RELEASE ships."

The phrasing "public commitment" still applies even after 1.0 — every minor release freezes the API, WS event schema, settings names, and DB migration pattern for that release line.

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
1. **architect** — Full codebase architecture audit in "public contract" mode. Review the REST API shape, WebSocket event schema, TypeScript interfaces, settings/env vars, and OSS/enterprise extension boundary. Flag any API shape, field name, event type, or extension point that is inconsistent or fragile and would be painful to change in $WORKING_RELEASE or later. **Account for what already shipped** in prior releases — the architect must not flag already-shipped contracts as "fix now" if they can only be changed in a major bump; instead flag them as "track for next major".
2. **migration-check** — Full migration history audit. Check for destructive operations, missing migrations, NOT NULL columns without defaults, and any pattern that would break a zero-downtime deploy.

### `deps`
1. **dependency** — Full dependency audit across all pip and npm packages. Check licenses (block GPL-2.0/3.0), known CVEs, and whether any dependency has been superseded by a safer or lighter alternative.

### `enterprise`
1. **enterprise-check** — Full OSS/enterprise boundary audit. Verify the OSS core is fully functional without the enterprise repo. Check that all extension points (settings includes, URL patterns, signal hooks) are stable and that no enterprise logic has leaked into OSS files.

### `tests`
1. **test-scaffold** — Full test coverage audit across all backend apps and frontend modules. For each app in `backend/` and each module in `frontend/src/`, identify: (a) public functions/methods/endpoints with no test, (b) edge cases (empty state, permission boundary, error path) that are exercised in code but not in tests, (c) any `SerializerMethodField`, custom model method, or `useCallback` hook that has only routing tests (asserting the right function is called) and lacks state/behaviour tests (asserting the result is correct). Do NOT generate scaffold files — return a structured findings report only, grouped by app/module, severity-rated as 🔴 (no coverage at all) or 🟡 (routing-only / missing edge cases).

### `full`
Run all agents above in 3 parallel waves **with gate checks between waves**. A gate check stops the audit early if blockers are found, so critical issues surface immediately rather than being buried in a 14-agent report.

**Wave 1** (security + performance):
- security-review, rbac-check, perf-check, perf-bench

**Wave 1 gate check** — after all 4 Wave 1 agents complete:
1. Collect all 🔴 blocking findings from the 4 agents.
2. If any 🔴 findings exist:
   - Present them to the user in the consolidated report format (summary + blocking section only).
   - Ask: "Wave 1 found N blocking issue(s) against $WORKING_RELEASE. Fix these first, or continue the audit? (fix first / continue)"
   - If "fix first" → stop here. Run Step 3 (GitLab issue check) for the Wave 1 findings only, then run Step 4 gate check. Do not launch Wave 2.
   - If "continue" → proceed to Wave 2.
3. If no 🔴 findings → proceed to Wave 2 immediately (no prompt needed).

**Wave 2** (frontend + contracts):
- ux-review, broadcast-check, architect (full codebase mode), migration-check

**Wave 2 gate check** — after all 4 Wave 2 agents complete:
1. Collect all 🔴 blocking findings from Wave 2.
2. If any 🔴 findings exist:
   - Present them (along with any Wave 1 blockers) in the consolidated format.
   - Ask: "Wave 2 found N additional blocking issue(s) against $WORKING_RELEASE. Fix these first, or continue the audit? (fix first / continue)"
   - If "fix first" → stop here. Run Step 3 for all findings so far, then Step 4. Do not launch Wave 3.
   - If "continue" → proceed to Wave 3.
3. If no 🔴 findings → proceed to Wave 3 immediately.

**Wave 3** (docs + ecosystem):
- api-docs, docs, dependency, enterprise-check, regression-check, test-scaffold (coverage audit mode — report only, no scaffold generation)

---

## Step 2 — Consolidate findings

After all agents complete, produce a consolidated report using this format:

```
## Pre-Release Audit Report — <type> — <date> — targeting <WORKING_RELEASE>

### Summary
🔴 Blocking: N   🟡 Should-fix: N   🟢 Clean: N

### 🔴 Blocking findings
(issues that must be resolved before the $WORKING_RELEASE tag is cut)

### 🟡 Should-fix findings
(issues that should be tracked against $WORKING_RELEASE but may slip to a patch release)

### 🟢 Clean areas
(agents that found no issues)
```

Severity guide (scoped to $WORKING_RELEASE):
- 🔴 **Blocking** — security vulnerability, data loss risk, broken public API contract being introduced in $WORKING_RELEASE, missing migration, or anything that would be painful/impossible to reverse once $WORKING_RELEASE ships
- 🟡 **Should-fix** — quality issue, stale doc, performance concern, or UX violation that is not release-blocking but should be tracked against $WORKING_RELEASE
- 🟢 **Clean** — no issues found by this agent

**Already-shipped public contracts** (introduced in a prior release) that cannot be changed without a major bump are not $WORKING_RELEASE issues — they are next-major-release issues. File them against the next open major milestone instead.

---

## Step 3 — GitLab issue check

After the report:

1. Query GitLab for open issues related to each 🔴 and 🟡 finding:
   ```bash
   glab issue list --repo visiban/visiban --state opened --search "<keyword>"
   ```

2. For findings that do **not** have an existing open issue, offer to create one:
   - 🔴 findings introduced in $WORKING_RELEASE → milestone: **$WORKING_RELEASE**, label: **$WORKING_RELEASE**, priority::P0
   - 🟡 findings against $WORKING_RELEASE → milestone: **$WORKING_RELEASE**, label: **$WORKING_RELEASE**
   - Already-shipped contract issues needing a major bump → milestone: **next open major milestone** (e.g. `2.0`), label: that major milestone
   - All findings go under the current working milestone unless they genuinely require a major bump to fix — **do not use generic labels like `post-1.0`**; always name the specific target milestone

3. Ask the user: "Create GitLab issues for the N untracked findings above? (y/n)"
   - If yes, create them using `glab issue create` with heredoc descriptions and `--milestone "$WORKING_RELEASE"` (or the next-major milestone for already-shipped contracts)
   - If no, list the findings as a checklist the user can act on manually

---

## Step 4 — Gate check (full audit only)

If the audit type was `full`:

- If any 🔴 blocking findings remain unresolved against $WORKING_RELEASE → **do not proceed to `/release`**. Tell the user: "Pre-release audit found N blocking issue(s) against $WORKING_RELEASE. Resolve these before running `/release`."
- If only 🟡 findings remain → advise the user to triage them, then they may proceed to `/release`
- If all findings are 🟢 → "Pre-release audit passed. You may proceed to `/release` for $WORKING_RELEASE."

---

## Step 5 — Tighten early-detection agents (full audit only, when blockers found)

If the audit type was `full` and any 🔴 or 🟡 findings were found, update the day-to-day agent definitions in `.claude/agents/` so those classes of issue are caught earlier — during normal feature development, not just at release time.

**How to do this:**

For each finding, identify which day-to-day agent *should* have caught it (e.g. a missing `select_related` belongs in `perf-check.md`; an IDOR belongs in `security-review.md`; a missing broadcast belongs in `broadcast-check.md`).

Then update that agent's `SKILL.md` or agent definition using these principles:

1. **Abstract to the class of problem, not the specific instance.** Do not add "check for missing select_related on CardSerializer.labels". Instead, add: "For every relation traversed in a serializer (ForeignKey, ManyToMany, reverse FK, source= with a dotted path), verify the calling view has a corresponding select_related/prefetch_related. Flag any relation that lacks it as a potential N+1." This catches the whole class, not just the one example.

2. **Add the check to the agent's trigger condition if applicable.** If a blocker was found in a context the agent is already supposed to cover (e.g. new viewset), add an explicit check instruction so it won't be missed again.

3. **Do not hardcode filenames or field names.** The agent should check patterns structurally (e.g. "any SerializerMethodField that calls .filter() or .all()") not by name (e.g. "check `labels` on `CardSerializer`").

4. **Add a "what to look for" principle, not a "look for this" rule.** Good: "Check whether every write path that modifies a board-scoped resource calls broadcast_board_event() — look for views that call .save(), .create(), .delete(), or bulk operations without a subsequent broadcast call." Bad: "Check that the card move endpoint calls broadcast."

After updating each affected agent file, list the changes made and which finding they address.

If no 🔴/🟡 findings were found, skip this step.
