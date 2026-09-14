---
name: batch
model: opus
disable-model-invocation: true
description: >
  Pick up a batch of milestone issues and land them in parallel — one git
  worktree and one delegated agent per issue, each finishing with its own MR.
  Asks which milestone and which labels to pull from; never infers either.
  Enforces token-discipline (Sonnet by default, a hard wave cap, per-agent
  commit verification). User-invoked only — it spawns many agents and spends
  real money, so it must never start on a model's own initiative.
---

# Batch

Land several milestone issues in one wave. Each issue gets its own worktree, its
own delegated agent, and its own MR. You are the orchestrator: you choose the
issues, brief the agents, verify what they actually produced, and report. You do
**not** implement the issues yourself.

## Why this skill is shaped the way it is

`CLAUDE.md`'s own cost-discipline section puts this project's active-session spend
at roughly 110M tokens/day, and warns that "a cache miss on a 1M-token working
context costs several dollars." A batch multiplies that risk by however many
agents run at once: `turn count × context size × fan-out`. A fan-out of five
agents that each wander into unnecessary exploration costs the same as landing
twenty-five focused ones. Every rule below attacks one of those three factors —
turn count, context size, or fan-out — not because a specific incident measured
it here, but because the arithmetic is the same regardless of project.

Do not treat these as style preferences. A wave that ignores them is not merely
slower — it is the difference between a batch that costs a few million tokens and
one that costs an order of magnitude more for the same landed MRs.

## Step 1 — Ask. Never infer.

Ask both questions with `AskUserQuestion` in a **single call** (two questions, one
round trip). Do not guess either answer, and do not skip the ask because the
answer looks obvious.

1. **Which milestone?** Offer the active dated milestones from
   `glab api "projects/:id/milestones?state=active"`, nearest due date first.
2. **Which labels to pull from?** Multi-select. Offer the domain labels actually
   present on that milestone's open issues — read them, do not offer a
   hardcoded list. If the project starts using `release::` commitment labels
   (committed/reserve/stretch), offer those too.

Also ask **wave size** if the user has not said one, defaulting to **5**. See the
cap rule below for why the number is small.

If the user names milestone and labels in their invocation (`/batch 1.2
lens`), take them and skip the ask.

## Step 2 — Select the issues

```bash
glab issue list --milestone <M> --label <L> --per-page 100
```

Then filter, in this order:

1. **Drop anything already claimed** — a `status::wip` label, or an issue number
   that already has an open MR. `scripts/wt new` refuses a claimed issue (see
   `scripts/wt help`), but check first so you are not selecting work you cannot
   start.
2. **Drop anything blocked** on an unmerged branch or an unanswered 🔴 question
   from a prior `architect`/`ux-design` review.
3. **Prefer issues with an identified root cause.** An issue whose body already
   names the file and the mechanism is one an agent can finish in a bounded
   number of turns. A vague issue is where an agent starts exploring and the
   turn count runs away.
4. **Prefer independent issues.** Two agents touching the same file collide on
   the merged tree even when both are green alone — check the paths each issue
   implies before pairing them in one wave (`backend/boards/views.py`,
   `frontend/src/components/**`, `changelog.d/*`, and `frontend/CLAUDE.md`'s
   numbered rule list are the recurring hotspots in this repo).
5. **Respect any `release::` ordering** if the milestone uses those labels —
   committed before reserve before stretch, unless the user said otherwise.

Report the selected list to the user before spawning anything. One line per
issue: number, title, chosen model, and why that model.

## Step 3 — One worktree per issue

Never let two agents share a checkout, and never create the worktrees from
inside an agent.

```bash
scripts/wt new <issue>      # branch + worktree off latest origin/main, claims status::wip
```

- The WIP cap is 10 (`WT_CAP`, default in `scripts/wt`). If the wave would
  exceed it, either shrink the wave or raise it deliberately with
  `WT_CAP=<n> scripts/wt new <issue>` — and say so in your report. Do **not**
  delete another session's worktree to make room; a worktree you did not
  create belongs to someone else's session.
- Each worktree's `.envrc` sets `COMPOSE_PROJECT_NAME` to reuse the main
  checkout's running Docker Compose stack — there is **no per-worktree test
  database isolation** in this project (unlike some sibling projects). If two
  agents in the same wave both run backend tests concurrently against the
  shared Postgres/Valkey containers, they can collide on the same Django test
  database name. Either serialize `pytest`/`manage.py test` runs across the
  wave's agents, or have each agent's brief set a distinct `DATABASE_URL`
  before running backend tests. Frontend `vitest`/`playwright` runs do not hit
  this — they don't share stateful services the same way.
- `git stash` is **not** worktree-scoped. Tell every agent to use
  `scripts/wt stash`, never bare `git stash` — see `scripts/wt help`.

## Step 4 — Delegate, on the cheapest model that can do the job

One agent per issue, all spawned **in a single message** so they run
concurrently.

### Model choice

**Default to Sonnet.** Most issues in this project's fast-path table (bugfixes,
single-endpoint features, settings sub-page wiring) do not need Opus.

Escalate to Opus only when the issue meets one of these, and **say which one** in
your report:

- The root cause is unknown and must be found, not just fixed.
- The fix spans both `backend/` and `frontend/` with a contract change (a
  serializer field, a WebSocket event shape) that both sides must agree on.
- It changes the git-lens pipeline-derivation logic, board WebSocket broadcast
  semantics, or another area with subtle invariants.
- It requires a design judgment the issue does not settle — a new interaction
  pattern, an OSS/Enterprise boundary call, or a backward-compatibility
  question under `CLAUDE.md`'s API contract rules.

"This issue is important" is not escalation criteria. Neither is "it touches
security" — a one-line permission-class fix with a named root cause is Sonnet
work; `rbac-check` and `security-review` catch what Sonnet misses.

**Read-only gates always run on Sonnet.** `regression-check`, `rbac-check`,
`perf-check`, `security-review`, `broadcast-check`, `migration-check` read a diff
and report findings. None needs Opus.

### The brief

Each agent's prompt must be **self-contained**. An agent that has to go
rediscover context spends its budget on cache reads of files you could have
named. Include:

- The issue number, title, and the **full issue body** — paste it, do not make
  the agent fetch it.
- Its worktree path, and the instruction to `cd` there and `source .envrc` first.
- The specific files or symbols to start from, if the issue names them.
- The exact gates that apply to this diff, from `CLAUDE.md`'s fast-path table —
  and which are `n/a`, so the agent does not run the whole battery.
- The scoped test command — the affected test file, not the whole suite
  (`cd backend && pytest <path> -q`, or `cd frontend && npx vitest run <file>`,
  or `cd frontend && npx playwright test e2e/<spec>.spec.ts`).
- The completion contract from Step 5.

Tell each agent explicitly:

- **Do not re-delegate.** A subagent must execute, not spawn more agents.
- **Do not run the full test suite.** Scoped test commands only (see above).
- **Batch independent tool calls** into one message.
- **Stop and report** if blocked after two attempts at the same failure, rather
  than looping.

## Step 5 — Completion contract

Every agent finishes by, in order:

1. Tests and docs in the **same commit** as the code change, per `CLAUDE.md`.
2. A changelog fragment at `changelog.d/<issue>.<type>.md`, unless the change is
   exempt (chore/ci/docs, matching the `changelog-check` job's exemptions).
3. Local scoped checks green: `cd frontend && npm run lint -- src/ --max-warnings 15`
   and `npx tsc -p tsconfig.app.json --noEmit` for frontend changes;
   `cd backend && ruff check . && python manage.py makemigrations --check --dry-run`
   for backend changes touching `models.py`.
4. Push the branch.
5. **Open the MR itself**, reproducing the `mr` skill's format by running
   `glab mr create` directly. `/mr` is `disable-model-invocation` — an agent
   cannot call it and must not try. `.claude/skills/mr/SKILL.md` is the
   canonical format for both paths.
6. Include `Closes #NNN` in the MR description, and a `## Gates` section with one
   `gate: <name> — <N> findings` line per gate run. `0 findings` is a real
   outcome; never omit a zero, and never conflate `n/a` with `skipped`.
7. **Never merge.** Hand back the MR URL and stop.

The agent reports back: MR URL, the gate ledger, the commit SHA, and anything it
deliberately left undone.

## Step 6 — Verify before you believe it

**An agent reporting "done" is not evidence.** Check every agent's actual output:

```bash
cd ../visiban-wt/<leaf> && git log origin/main..HEAD --oneline    # are there commits?
git status --porcelain                                            # anything uncommitted?
```

Then confirm the MR is real and points at the right code:

```bash
glab api "projects/:id/merge_requests/<iid>" \
  | jq -r '"sha=\(.sha) pipeline=\(.head_pipeline.status) closes=\(.description|test("Closes #"))"'
```

`HEAD == MR sha == pipeline sha`. A worktree is not private — another session can
commit and push from it mid-edit — so verify rather than assume the agent's
summary describes what landed.

An agent that produced no commit costs the same as one that shipped. Re-brief it
with what was missing, or take the issue over yourself; do not report it as done.

## Step 7 — Report

One table: issue, model used, MR, pipeline status, commits, gate findings. Then
state plainly:

- Which issues did **not** land, and why.
- Whether you raised the WIP cap, and whether any worktrees need cleanup
  (`scripts/wt remove <issue>` or `scripts/wt prune`).
- The wave's shape: how many agents, how many on Opus.

Do not merge anything. Do not start another wave without being asked.

## Cost rules, condensed

- **Sonnet unless escalation criteria are met**; read-only gates always Sonnet.
- **Cap the wave** (default 5, WIP cap 10). A wave much larger than that is past
  the point where the issues are genuinely independent.
- **Verify commits, don't trust summaries** — an empty agent is pure loss, and a
  wandering one costs many times a focused one.
- **Self-contained briefs.** Paste the issue body; name the files. Every fact the
  agent has to rediscover is re-read on every subsequent turn of that agent.
- **Scoped tests only.** Never the full suite inside an agent.
- **Pre-MR gates as one parallel batch**, never serially — see `CLAUDE.md`'s
  "Pre-MR gate batch" section.
- **Apply only the gates the diff earns** — `CLAUDE.md`'s fast-path table is
  authoritative. A bugfix with a known root cause does not need `architect`.
- **No re-delegation** from inside an agent.
- **Two-strike rule**: an agent stuck on the same failure twice stops and
  reports.
- **Long-running work goes to the background**, not to a polling loop.

## Rules

- **Never merge.** Not after a green pipeline, not for a docs-only branch.
- **Never infer a commitment label.** If the milestone uses `release::` labels
  and an issue's tier is ambiguous, ask which applies rather than guessing.
- **Never commit to `main`**, and always branch from latest `origin/main` —
  `scripts/wt new` handles this.
- **Never bare `git stash`** in a worktree. `scripts/wt stash`.
- If the user says skip a gate, skip it and record it as `skipped` with their
  reason — not as `n/a`.
