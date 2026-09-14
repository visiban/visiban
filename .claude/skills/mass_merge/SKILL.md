---
name: mass_merge
model: sonnet
disable-model-invocation: true
description: >
  Safely land a batch of already-green GitLab MRs onto main, one at a time,
  without breaking the post-merge main pipeline. Emulates a merge train
  client-side: stacks the MRs on a local integration branch, re-runs the
  repo-wide gates after each, and merges only the safe prefix serially —
  bringing every MR up to the latest main first. Use when landing several
  related MRs in one sitting.
---

# Mass Merge Skill

Land a list of merge requests onto `main` safely, in sequence, so that
individually-green MRs cannot combine into a red main.

## Invocation

```
/mass_merge !123 !124 !125
/mass_merge 123,124,125
/mass_merge !123 !124 --dry-run
```

Arguments: a list of MR IIDs, in the order you want them landed. Accepts `!123`,
`123`, space- or comma-separated. Flags:

- `--dry-run` — run Phase A (the simulation) only; never push or merge. Use this
  first when you are unsure the batch is composable.

### Who invokes this — user only

`/mass_merge` is **user-invoked only** (`disable-model-invocation: true`). It
**merges to `main`**, which `CLAUDE.md`'s git-workflow rules say an agent must
never do on its own initiative. This skill is the *sanctioned, user-triggered*
batch-merge path — the one place where merging is the explicit, deliberate ask.
The agent cannot call it through the Skill tool and must not reproduce Phase B
(the merge loop) as part of unattended work. It may reproduce **Phase A
(simulation)** at any time to *report* whether a batch is safe, but stops before
pushing or merging.

---

## Why this skill exists

Under parallel-worktree batches, main pipelines can go red **after** merge even
though every MR's own pipeline was green. Two causes, neither of which is a code
quality problem:

1. **Merged-tree checks don't compose.** `python manage.py makemigrations --check
   --dry-run` on each MR's own branch only sees that branch's migration graph.
   Two MRs that each add a leaf migration under the same app are fine alone —
   Django resolves each against its own single parent — but once both land, the
   app has two heads and every subsequent migration command fails until someone
   adds a merge migration. The `changelog-check` job has the same shape: two
   MRs each add a distinct fragment file, so neither collides on its own tree,
   but a shared file two MRs both edit (`frontend/CLAUDE.md`, a shared config)
   can still merge textually-clean and be semantically wrong.
2. **Stale merge base.** GitLab gates each MR against the main it *branched
   from*, not current main (no merged-results pipelines / merge trains are
   configured — `.gitlab-ci.yml` uses plain `merge_request_event` /
   `on-mr` rules, not `merge_train_event`). Auto-merges on shared files
   (`changelog.d/*`, `frontend/CLAUDE.md`, `docs/`, `backend/*/migrations/*`)
   apply cleanly as text but can break semantically.

This skill fixes both **before** merge by (A) stacking the MRs on a local
integration branch and re-running the relevant checks after each add, then
(B) landing only the safe prefix serially, bringing each MR up to the latest
main and waiting for a green pipeline before the next.

> **The durable fix is server-side merge trains.** This skill is a client-side
> emulation. If merged-results pipelines / merge trains are ever enabled in the
> GitLab project settings, GitLab does phase A+B for you and this skill becomes
> a convenience. Until then, use it for every multi-MR landing.

---

## Step 0 — Pre-flight

```bash
glab auth status                     # must be authenticated
git -C . rev-parse --abbrev-ref HEAD # note current branch to restore later
git status --porcelain               # working tree MUST be clean
git fetch origin --prune
```

Stop and tell the user if:

- `glab` is not authenticated → `glab auth login`.
- The working tree is dirty → this skill flips checkouts and pushes branches;
  it must run from a **clean** checkout with **no other in-flight work**
  (another agent's uncommitted changes or unpushed commits will be clobbered).
  Prefer a dedicated worktree — `scripts/wt new <any-issue>` — if parallel
  sessions are active.

> **The batch's own branches being checked out in worktrees is normal, not a
> blocker.** Under this project's parallel-worktree workflow, each MR you are
> landing was very likely built in its own worktree (`../visiban-wt/<leaf>` or
> a sibling `../visiban-<name>` checkout) — `git worktree list` showing them is
> expected, and Phase B handles it (it drives each branch via `git -C "$WT"`
> instead of `glab mr checkout`; see Step 3). What must be clean is *your own*
> checkout and any worktree you are about to update. Before updating a
> worktree-held branch, confirm `git -C "$WT" status --porcelain` is empty and
> its `HEAD` equals `origin/<branch>` (pushed) — an unpushed or dirty worktree
> means a session is still working that branch; skip it and tell the user.

Then validate every MR in the list, in parallel is fine:

```bash
glab mr view <iid> --output json
```

For each MR record: `source_branch`, `target_branch`, `state`, `draft`,
`detailed_merge_status` (or `merge_status`), and the head pipeline status. Stop
and report if any MR is:

- not `opened`, or is `draft`/WIP;
- targeting a branch other than `main` (unless the user said otherwise);
- has unresolved threads or is not approved, if the project requires it;
- whose own latest pipeline is **not** green — fix that MR first
  (`/fix-mr !<iid>`), it is not a mass-merge candidate yet.

Print the validated, ordered list back to the user before doing anything else.

### A competing session can land the whole batch out from under you

**Validation in Step 0 is a snapshot, not a lock.** Nothing in GitLab or in this
skill reserves the MRs, so another local Claude session — or a human in the UI —
can merge them while Phase A is still running. Check for other live sessions
before starting, and say so in the opening report:

```bash
ps aux | grep -c "[c]laude"          # >1 means another session may be active
git worktree list                    # worktrees you did not create
git reflog -5                        # a checkout/pull you did not issue = someone else drives this checkout
```

The tells that a competing session is acting on **your** batch, and what each
means:

- `git reflog` shows a `checkout:` or `pull` you did not issue → another
  session is driving the shared main checkout. Your sim branch can be yanked
  mid-gate-run (see Step 2 — run Phase A in its own worktree, which makes this
  harmless).
- A batch branch's local ref moved without you updating it → someone pushed to
  it.
- `scripts/wt prune` reports a batch branch as "merged to main, remote gone" →
  **that MR has already been merged by someone else.** Verify with
  `glab mr view <iid>` before trusting it.

**Re-verify state immediately before each act, never trust Step 0's snapshot.**
Before updating/pushing an MR and again before merging it, re-read its state; if
it is no longer `opened`, skip it and re-plan the remainder of the batch:

```bash
ST=$(glab mr view <iid> --output json | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')
[ "$ST" = opened ] || { echo "!<iid> is now $ST — merged elsewhere; skip and re-plan"; }
```

If a competing session lands part of the batch, **stop and report** rather than
racing it. Re-run Phase A from the new `origin/main` over whatever is genuinely
still open — the old simulation is void, because it was computed against a base
that no longer exists.

---

## Step 1 — Detect shared-file hotspots (ordering hint)

```bash
for iid in <order>; do
  echo "== !$iid =="
  git diff --name-only origin/main...origin/<source_branch>
done
```

Cross-reference the file lists. Call out any file touched by **two or more** MRs
in the batch — these are where the stale-base semantic conflicts land. Known
hotspots in this repo: `changelog.d/*`, `backend/*/migrations/*` (two MRs each
adding a migration under the same app produce two graph heads once both land —
`makemigrations --check --dry-run` on the merged tree is what catches this),
`frontend/CLAUDE.md`, `docs/`, `CLAUDE.md`, `.gitlab-ci.yml`. Serial landing
(Phase A/B) handles these correctly by construction, but tell the user which
MRs collide so the ordering is deliberate.

**Where a hotspot conflict is a migration graph collision, land whichever MR's
migration should be the parent first.** Reordering plus a merge migration
dissolves the conflict once rather than fighting it per branch — Phase A is how
you prove the reorder is safe before doing it.

### Screen each branch's update strategy now, not in Phase B

Phase B brings each branch up to the latest main. Record per branch which way,
so Phase B never has to decide under time pressure:

```bash
for iid in <order>; do
  BR=$(glab mr view "$iid" --output json | python3 -c 'import sys,json;print(json.load(sys.stdin)["source_branch"])')
  git fetch origin "$BR" --quiet
  if git merge-base --is-ancestor origin/main "origin/$BR"; then
    echo "!$iid $BR  → UP-TO-DATE (no update, no push, reuse its green pipeline)"
  elif [ "$(git log --merges --oneline "origin/main..origin/$BR" | wc -l)" -gt 0 ]; then
    echo "!$iid $BR  → MERGE ONLY (carries a merge commit; rebase conflicts spuriously)"
  else
    echo "!$iid $BR  → merge (default) — rebase only on request"
  fi
done
```

---

## Step 2 — Phase A: simulate the merge train (always runs)

Build a local integration branch off current main and stack the MRs onto it in
order, running the relevant checks after each add. This reproduces the exact
combined tree that would land on main — the thing each MR's own pipeline never
sees.

**Run Phase A in a dedicated throwaway worktree, never in the shared main
checkout.** Two failure modes make the shared checkout the wrong place:

1. **Another session's `git checkout main` yanks your sim branch mid-gate-run.**
   The branch survives (the checks just start running against `main` instead),
   so this fails *silently* — checks report PASS against the wrong tree.
   Verify `git rev-parse --short HEAD` after every check batch if you ignore
   this advice.
2. A shared checkout is where another session's own uncommitted work lives —
   running installs, migrations, or `scripts/wt prune` from it risks touching
   that work.

```bash
scripts/wt new chore/mass-merge-sim   # counts against WT_CAP like any other worktree
SIM=../visiban-wt/mass-merge-sim
cd "$SIM"
git reset --hard origin/main          # wt new branches off origin/main already; this is belt-and-suspenders
```

Using `scripts/wt new` here (rather than a bare `git worktree add`) gets the
symlinks (`.venv`, `node_modules`) and the isolated `backend/.env`/`WT_E2E_PORT`
for free — a bare `worktree add` gets none of them, and without the symlinks
`ruff`/`tsc`/`vitest` die looking for their installs.

For each `iid` in order (let `B` = its `source_branch`):

```bash
git fetch origin "$B"
# Rebase the MR's commits onto the current sim tip, then land them.
# Use merge --no-ff to mirror how GitLab lands the branch:
if ! git merge --no-ff --no-edit "origin/$B"; then
  git merge --abort
  echo "CONFLICT: !$iid does not merge cleanly onto the stack → STOP"
  # record as blocker; do not continue past this MR
fi
```

Then run the checks that only mean something on the **combined** tree (fast,
seconds, no CI):

```bash
# Backend — migration graph must still resolve to a single head per app.
cd backend && python manage.py makemigrations --check --dry-run --verbosity=1; cd ..
cd backend && ruff check .; cd ..

# Frontend — lint + typecheck the combined tree.
cd frontend && npm run lint -- src/ --max-warnings 15; cd ..
cd frontend && npx tsc -p tsconfig.app.json --noEmit && npx tsc -p tsconfig.e2e.json --noEmit; cd ..

# Changelog fragments: every MR's fragment file should still be unique and
# present on the combined tree (a naming collision is the one thing that
# silently overwrites cleanly on merge and nobody notices).
ls changelog.d/ | sort | uniq -d
```

**Then run the unit suites on the stacked tree when the batch touches them.**
The checks above cover migrations, lint and typecheck — they never run
`pytest`/`vitest`, so an aggregate conflict that is only expressible as a *test*
passes Phase A cleanly and detonates in Phase B after earlier MRs have landed
(e.g. MR A adds a coverage test asserting every nav entry has a settings page;
MR B adds a nav entry with no page. Neither fails alone; stacked they fail, and
because the two MRs touch *different files* the Step 1 hotspot scan is blind to
it — the coupling is a registry invariant, not a text overlap):

```bash
cd frontend && npx vitest run                                    # if the batch touches frontend/src
cd backend  && pytest -q                                         # if it touches backend/
```

`scripts/wt new` seeds the sim worktree's `backend/.env` with an isolated
SQLite database, so `pytest` here needs nothing running — it doesn't touch the
shared Postgres/Valkey stack at all. Only fall back to
`docker compose up -d postgres valkey` (sharing them via `COMPOSE_PROJECT_NAME`)
if the batch specifically touches code that requires Postgres/Valkey semantics
SQLite doesn't reproduce (e.g. a migration using Postgres-specific SQL, or
WebSocket/channels behavior backed by Valkey).

**Phase A still runs no Playwright e2e, and adding the unit suites does not
close that.** The full e2e suite is too slow to run per stack-add, so the
honest rule is: **e2e is the residual risk Phase A cannot certify** — budget
Phase B triage time for it rather than reading a red `playwright-e2e` job as
proof the batch is uncomposable. Note also that `playwright-e2e` in this
project's `.gitlab-ci.yml` currently runs as `allow_failure: true` during its
rollout period — a red e2e job may not even be gating the MR pipeline yet;
check the job's `allow_failure` status before treating it as a stop.

Two practical notes on running the checks:

- Wrap each check so one failure does not abort the sweep, and print PASS/FAIL
  per check rather than relying on the exit code of the last command.
- **If a batch MR changes `.gitlab-ci.yml` itself or adds a new check script**,
  run that too — it applies to the whole combined tree the moment it lands.

Record, per MR, which checks passed on the cumulative tree. **The first MR
whose add turns a check red is the one that breaks main** when combined with
the MRs before it — even though its own pipeline is green in isolation.

**Be precise about what a clean Phase A proves.** It answers "does this
combined tree pass the checks" — it does **not** answer "will Phase B update
each branch cleanly." Phase A merges the *original* branch tips in one shot;
Phase B updates each branch against a main that now contains the batch's
earlier MRs. A `--dry-run` table showing zero conflicts still means editing
contributors' branches, so get explicit approval for that up front rather than
presenting the batch as hands-off.

Clean up (from the main checkout, once Phase A is done). `scripts/wt remove`
would refuse — the sim branch is intentionally full of merge commits and
diverged state that isn't going anywhere — so remove it directly:

```bash
cd <main-checkout>
git worktree remove ../visiban-wt/mass-merge-sim --force
git branch -D chore/mass-merge-sim
```

**Report the simulation as a table** — for each MR: merges-clean? and check
status on the cumulative tree. Classify each MR:

- ✅ **safe** — merges clean, all checks green on the cumulative tree.
- 🔴 **breaks the batch** — first MR to fail a check or conflict. Name the
  exact check and what broke (e.g. "adds `backend/boards/migrations/0043_x.py`;
  !124 already added `0043_y.py` on the same app — two heads once stacked").
- ⏸️ **blocked-behind** — MRs after the first 🔴; not evaluated on a valid tree.

If `--dry-run`, **stop here** and hand the user the table plus the fix needed
for each 🔴 (the fix goes on that MR's branch — e.g. renumber the migration and
add a merge migration, resolve the changelog fragment collision).

---

## Step 3 — Phase B: land the safe prefix serially

Only the **contiguous ✅ prefix** from Phase A is landable. If MR #3 is 🔴, land
#1 and #2, then stop and report that #3 (and everything after) needs a fix
first. Never skip a 🔴 to land a later MR — that reorders the stack Phase A
validated.

For each MR in the safe prefix, **merged one at a time** — but the *update+push*
of the next MR may overlap the current merge's main-pipeline wait (see below).

> **Pipeline the updates to cut wall-clock.** A push lands nothing on main, so
> the moment MR N is merged and `origin/main` re-fetched, immediately update MR
> N+1 onto that new `origin/main` and push it — its MR pipeline then runs *in
> parallel* with the main(N) pipeline instead of waiting for it. When both the
> main(N) pipeline and the MR(N+1) pipeline are green, merge N+1. The only
> strict serialization is the **merge**: N+1 must not be merged until main(N) is
> green (at most one merge on a possibly-red main). If main(N) goes red, the
> pushed N+1 is simply not merged — the push cost nothing.

**First, locate the source branch's working copy.** A batch MR's source branch
is very often already checked out in a **parallel worktree** (that is how the
work was done). `glab mr checkout <iid>` then fails with `git: exit status 128`
("branch is already checked out at …") and silently leaves you on your current
branch — you'd update and push the *wrong* branch. Resolve the working copy
first and drive git there with `git -C "$WT"`:

```bash
BR=$(glab mr view <iid> --output json | python3 -c 'import sys,json;print(json.load(sys.stdin)["source_branch"])')
WT=$(git worktree list --porcelain | awk -v b="refs/heads/$BR" '
  /^worktree /{p=$2} $0=="branch "b{print p}')   # empty if not in a worktree
if [ -z "$WT" ]; then
  glab mr checkout <iid>; WT=.                     # not worktree-held → check out here
fi
test -z "$(git -C "$WT" status --porcelain)" || { echo "DIRTY $BR → STOP"; exit 1; }
```

Then bring that working copy up to the latest main and push.

**Merge is the default; rebase is the exception.** If this project's
`merge_method` is `merge` (check `glab api projects/:id | python3 -c
"import sys,json;print(json.load(sys.stdin)['merge_method'])"` if unsure),
GitLab lands every branch with a merge commit, and Phase A already simulates
exactly that with `merge --no-ff` (Step 2). A Phase B rebase then performs an
operation GitLab never performs, and costs on both ends:

- **A rebase replays each commit individually against a base that has moved**,
  so it conflicts once *per commit* where a merge resolves once, three-way,
  against a single common ancestor.
- **A branch that already contains a merge from `main` conflicts *spuriously*
  on rebase**, because the replayed pre-merge commits hit content they have
  already been reconciled to. The tell is a branch whose MR is `mergeable` on
  GitLab and whose Phase A `merge --no-ff` succeeded, yet
  `git rebase origin/main` conflicts.

Merging also means **no force-push**, which removes an entire class of push
failure and never rewrites a contributor's branch. The only cost is a merge
commit on a branch `remove_source_branch_after_merge` deletes seconds later.

```bash
git -C "$WT" fetch origin

# No-op guard: if the branch already contains origin/main there is nothing to
# do. Skipping matters — an unnecessary push prints "Everything up-to-date",
# creates NO new pipeline, and the poller below then waits forever on a sha
# whose pipeline will never exist.
if git -C "$WT" merge-base --is-ancestor origin/main "$BR"; then
  echo "!$iid already contains origin/main — no update, no push; reuse its green pipeline"
  SHA=$(git -C "$WT" rev-parse HEAD)      # its existing MR pipeline for this sha is the gate
else
  git -C "$WT" merge --no-edit origin/main   # lands the tree Phase A validated
  # conflict → git -C "$WT" merge --abort, stop, report: needs a manual resolution
  SHA=$(git -C "$WT" rev-parse HEAD)      # the EXACT sha we are about to push — poll on this, not the branch tip
  git -C "$WT" push --no-verify origin "$BR"     # fast-forward; no force needed
fi
```

- `--no-verify` skips the local pre-push hook (this project's runs `npm run
  lint` on frontend changes) — Phase A already ran the equivalent check on the
  combined tree, so re-running it on every push is pure latency, and the hook
  is what stalls on a credential prompt in some environments.
- **A merge push is a fast-forward — no `--force-with-lease` at all.** That is
  the point: the lease is only needed because a rebase rewrites history.

**If you do rebase anyway** (the user wants linear history, and
`git log --merges --oneline origin/main..origin/$BR` comes back empty so the
spurious-conflict case above cannot apply), the push needs a lease:

```bash
git -C "$WT" fetch origin
git -C "$WT" rev-parse "origin/$BR"     # assert BY HAND this is the sha you expect
git -C "$WT" rebase origin/main
git -C "$WT" push --no-verify --force-with-lease origin "$BR"   # BARE form only
```

- **Never `--force-with-lease="$BR:<sha>"`.** On some git versions (observed on
  git 2.50.1 / Apple Git-155) the explicit `<shortref>:<sha>` form silently
  fails to register the lease and the push degrades to a plain, *non-forced*
  push — which is then rejected as non-fast-forward, with no "stale info"
  message. It does not fail safe, it fails **closed**. Hand-verifying
  `origin/$BR` before a **bare** `--force-with-lease` gives the same guarantee
  the explicit form was meant to provide.
- Never fall back to plain `--force`.

Then wait for the freshly-pushed pipeline **for that exact sha** to go green,
and only then merge. **Poll by MR ref and match the full sha** — do not use the
`?sha=<short>` filter (GitLab's sha filter only matches the full 40-char sha and
returns `[]` for a short one, so a short-sha poll loops forever), and do not
trust the MR's `head_pipeline` (it goes stale right after a force-push):

```bash
# poll: the pipeline whose sha == $SHA on this MR's ref must reach `success`.
# Run this under Monitor / run_in_background — foreground `sleep` is blocked.
# NB: match on sha ALONE here. Pipelines on an MR ref carry
# source == 'merge_request_event', so the source=='push' filter used by the
# ref=main gate below would match NOTHING here and time out after an hour.
# NB: this loop is deliberately SILENT while waiting — do not add a per-
# iteration echo (see the note under "Run both polls under Monitor" below).
for i in $(seq 1 120); do                                   # bounded: 120 × 30s = 60 min
  ST=$(glab api "projects/:id/pipelines?ref=refs/merge-requests/<iid>/head&per_page=20" \
        | python3 -c "import sys,json;m=[p for p in json.load(sys.stdin) if p['sha']=='$SHA'];print(m[0]['status'] if m else 'none')")
  case "$ST" in
    success)                 echo "MR(<iid>) SUCCESS"; exit 0 ;;   # green → merge
    failed|canceled)         echo "PIPELINE $ST → STOP"; exit 1 ;;
    *)                       sleep 30 ;;                    # keep waiting (incl. 'none' = not created yet)
  esac
done
echo "MR(<iid>) TIMEOUT after 60m"; exit 1
```

If the no-op guard above skipped the push, `$SHA` is the branch's existing head
and this poll simply finds its already-green pipeline — no waiting, nothing new
to run.

Once green, merge and pull the result forward:

```bash
glab mr merge <iid> --yes
git fetch origin                        # pull the new main so the NEXT MR updates on top of this one
```

**After the merge, gate on the resulting `ref: main` pipeline before *merging*
the next MR — this is mandatory, not optional.** (You may already have
updated+pushed the next MR to run its pipeline in parallel — that overlap is
fine; it is the next *merge* that this gate blocks.) An MR-ref pipeline is
green *against the main it branched from*; it does not prove the merge
*commit* on main is green. A merge can turn main red in ways the MR pipeline
never saw — a `ref: main`-only job (security/dependency scans that only run on
`$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH`, per this project's
`.gitlab-ci.yml` rules), a migration-graph collision that only exists once two
MRs are both on main, or a freshly-published advisory the scanner picks up
mid-run. If you skip this gate and keep merging, every subsequent MR lands on
an already-red main and you discover it several merges too late. **The
invariant: at most ONE merge may land on a newly-red main — the first red
`ref: main` pipeline halts the entire run.**

**On `ref=main`, match `source == 'push'`, not the sha alone.** (This filter is
specific to the main gate — the MR-ref poll above must *not* use it, since its
pipelines are `merge_request_event`.) The API returns *every* pipeline on the
ref, and a scheduled pipeline can be running on the identical merge sha — a
poller that takes `m[0]` (newest first) can pick the scheduled one and either
wait on something unrelated to the merge or report the batch red over one of
its jobs.

```bash
git fetch origin main                                  # after the merge above
MAINSHA=$(git rev-parse origin/main)                   # the merge commit now on main
# NB: this loop is deliberately SILENT while waiting — do not add a per-
# iteration echo (see the note under "Run both polls under Monitor" below).
for i in $(seq 1 120); do                              # bounded: 120 × 30s = 60 min
  ST=$(glab api "projects/:id/pipelines?ref=main&per_page=20" \
        | python3 -c "import sys,json;m=[p for p in json.load(sys.stdin) if p['sha']=='$MAINSHA' and p.get('source')=='push'];print(m[0]['status'] if m else 'none')")
  case "$ST" in
    success)                 echo "MAIN($MAINSHA) SUCCESS"; exit 0 ;;   # green → proceed
    failed|canceled)         echo "MAIN PIPELINE $ST for $MAINSHA → STOP THE RUN"; exit 1 ;;
    *)                       sleep 30 ;;               # incl. 'none' = not created yet
  esac
done
echo "MAIN($MAINSHA) TIMEOUT after 60m"; exit 1
```

> **Run both polls under `Monitor` (or `run_in_background`), never as
> foreground Bash.** The agent harness **blocks foreground `sleep`**, so a
> `while :; … sleep 30; done` shape errors out immediately, and chaining
> shorter sleeps is blocked too. Wrap each poll as a bounded `for` loop that
> `exit 0`s on `success` and `exit 1`s on `failed|canceled`, and emit one
> self-describing line (`MAIN(<sha>) SUCCESS`) so the notification stands
> alone. When you overlap the gates (main(N) and the pushed MR(N+1)), prefer
> **one combined poller** that exits on `BOTH_GREEN` or either terminal state
> over two background tasks — long-lived pollers can be silently killed by the
> harness mid-flight, and fewer of them means less to lose. If one vanishes,
> re-query the API live rather than trusting its last printed line.
>
> **Do not add a per-iteration status echo when you instantiate these loops
> for Monitor — keep them silent while waiting.** The templates above only
> `echo` at the terminal branches (`success` / `failed`/`canceled`) or on final
> timeout; the `*)` branch is a bare `sleep 30` with no output. An
> unconditional per-iteration echo turns a short landing into dozens of
> near-duplicate notifications. If mid-wait visibility is genuinely useful for
> a long pipeline, gate a heartbeat behind a modulus
> (`[ $((i % 10)) -eq 0 ] && echo "..."`, i.e. once per ~5 min) — never an
> unconditional echo every 30s.
>
> **Do not manufacture filler tool calls while a Monitor task is pending.** A
> bare placeholder call issued once per turn while waiting for a notification
> produces a new conversation turn with zero information and no gating delay
> between calls. Once a Monitor poll is running, stop calling tools until its
> notification arrives.

When the post-merge main pipeline goes red, apply the **same triage as the
MR-ref poll** (below): if it is a known e2e flake, retry that one job once and
keep polling *this main pipeline*; anything else — including a `ref: main`-only
job — is a **hard stop**. Do NOT push or merge the next MR. Report which
merge's main pipeline failed and which job, so the user can decide whether to
revert it or fix forward. A red `ref: main`-only job that predates the batch is
still a stop: the batch cannot certify a green main on top of it, and stacking
more merges only buries the signal. Confirm whether the last-good main *before*
the batch was green (Step 0 should have recorded this) so you can tell the user
whether the batch caused the red or merely inherited it.

Cap the poll (e.g. 120 iterations × 30s = 60 min) and stop with a clear message
rather than looping forever if CI hangs. Terminal-failure states (`failed`,
`canceled`) stop the whole run — do not merge a red pipeline, and do not
silently wait through a crash.

**First, rule out a zero-job pipeline — a `failed` with no jobs never tested
anything.** Before reading any trace, check whether the pipeline actually ran.
A pipeline that reports `failed` with `jobs: 0`, `started_at: null`, and
`finished_at == created_at` (instant) **failed at creation** — it is not a code
failure:

```bash
glab api "projects/:id/pipelines/$PID" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('status',d['status'],'| started',d['started_at'],'| yaml_errors',d['yaml_errors'])"
glab api "projects/:id/pipelines/$PID/jobs?per_page=100" \
  | python3 -c "import sys,json;print('jobs:',len(json.load(sys.stdin)))"
```

With `jobs: 0` and `yaml_errors: null`, the cause is capacity, not code
(GitLab caps the number of jobs across a project's *active* pipelines on some
plans). Confirm it by asking GitLab to create one more pipeline — the API
returns the real reason where the pipeline record does not:

```bash
glab ci run -b main
# 400 {message: {base: [Project exceeded the allowed number of jobs in active pipelines. Retry later.]}}
```

**A fast batch can create this failure mode for itself** — several merges in
quick succession can put consecutive `ref: main` pipelines over such a cap,
which shows as `failed` while never running a single job, so the merged tip
was never actually tested. Two consequences:

- **Pace the merges.** The one-merge-at-a-time rule already spaces them out
  naturally; do not batch-merge to "catch up" after a slow stretch. If the
  post-merge poll reports `none` or a zero-job `failed`, treat it as *capacity
  backpressure* — wait for the active pipelines to drain, then re-trigger.
- **Re-trigger, don't conclude.** A zero-job failure is never evidence about
  the code. Wait for capacity, run `glab ci run -b main` against the current
  tip, and gate on the pipeline that actually runs jobs.

**Then, if the pipeline did run jobs, triage the failing job — a known flake is
retried once, not a stop.** A freshly-pushed branch re-runs the full suite,
including `playwright-e2e`, which currently runs `allow_failure: true` during
its rollout period per `.gitlab-ci.yml` — a red e2e job there is advisory, not
a hard stop, unless the user has since promoted it to required. Pull the
failed jobs and read the trace:

```bash
PID=<pipeline id for $SHA>
glab api "projects/:id/pipelines/$PID/jobs?per_page=100" \
  | python3 -c "import sys,json;[print(j['status'],j['name'],j['id']) for j in json.load(sys.stdin) if j['status']=='failed' and not j['allow_failure']]"
glab api "projects/:id/jobs/<job-id>/trace" | grep -iE "failed|✘|\.spec\.ts|Error:" | tail -40
```

- If the only failures are **known-flaky e2e specs** (hundreds passed,
  unrelated to this MR's diff), retry that job **once** and keep polling the
  same pipeline: `glab api -X POST "projects/:id/jobs/<job-id>/retry"`. If the
  retry also fails, treat it as a real stop.
- If the failure is a **real test/lint/type/build error**, or touches this
  MR's own changed surface, stop the run and hand it to the user — the update
  onto the MRs already landed this batch may have introduced a genuine
  semantic conflict (exactly the stale-base class this skill exists to catch).

Never blanket-retry a red pipeline to make it green — retry only a job you have
positively identified as a known flake.

Rules for Phase B:

- **Merges are serial; the next update+push may overlap.** Serializing the
  *merges* is the fix — never merge two MRs concurrently. But updating and
  pushing the next MR (and letting its MR pipeline run) while the current
  merge's `ref: main` pipeline is still going is the intended optimization: a
  push lands nothing on main, so it cannot make main red — only a merge can.
- **Never merge N+1 until BOTH gates are green.** Before `glab mr merge <N+1>`,
  confirm (a) MR N+1's own freshly-pushed pipeline is `success` for its exact
  sha, AND (b) the previous merge's `ref: main` pipeline is `success`.
- **Poll to green, then merge** — do not fire `--when-pipeline-succeeds` across
  the whole batch at once. That races merges and reintroduces exactly the
  parallel-merge problem this skill removes.
- **Gate on the post-merge `ref: main` pipeline after EVERY merge** — at most
  one merge may land on a red main.
- **Merge, don't rebase — and skip the update entirely when it is a no-op.**
  If `merge_method` is `merge`, a merge produces exactly the tree GitLab will
  land and exactly the tree Phase A validated. Rebase only on request and only
  after `git log --merges origin/main..origin/$BR` comes back empty.
- **Never `--force-with-lease="$BR:<sha>"`; use the bare form after verifying
  the sha by hand.**
- **Drive the branch where it actually lives.** If the source branch is
  checked out in a worktree, `glab mr checkout` fails (git 128) and dumps you
  on the wrong branch — resolve `$WT` from `git worktree list` and run every
  git command with `git -C "$WT"`.
- **Poll the exact pushed sha, by MR ref.**
- **A merge conflict in Phase B stops the run.** Phase A combined the
  *original* branch tips; a Phase B merge can still conflict once an earlier
  MR from this batch has actually landed. Hand it to the user, do not guess a
  resolution.
- **After any update to a branch touching `backend/*/models.py`, re-run
  `python manage.py makemigrations --check --dry-run`** before pushing — the
  merge with main may have introduced a graph conflict Phase A's snapshot
  didn't have.

---

## Step 3b — Clean up landed worktrees

Each merged MR's source branch is very often a `scripts/wt`-managed worktree —
that is the default parallel-work pattern this project uses (see Step 3's `$WT`
resolution). Once an MR merges, GitLab deletes its remote branch
(`remove_source_branch_after_merge`, if enabled on this project), and the local
worktree is left behind on a dead branch — pure debris. Left alone across
repeated `/mass_merge` runs these pile up silently and count against the
10-worktree WIP cap (`WT_CAP` in `scripts/wt`).

**Run this immediately after each MR merges, not batched at the end** — cheap,
and it means a run that stops partway through (a later 🔴, a red main pipeline)
still cleans up everything it actually landed:

```bash
scripts/wt remove <issue-number>
```

`wt remove` is safe to call unconditionally on every merged MR's issue number:
it is a no-op (with a clear message) if the branch was never a worktree
(checked out via `glab mr checkout` instead), and it will not remove a
worktree that still has unpushed or uncommitted work — which cannot be true
here since the branch was just merged from a pushed, clean state. It also
clears the branch's `status::wip` lock if one was applied when the worktree was
created.

**Do not remove a worktree for an MR that did not merge.** A 🔴-blocked or
still-open MR's worktree holds live work — leave it for its owner to fix and
re-run.

---

## Step 4 — Report

Emit a final summary:

```
Mass merge of !123 !124 !125 → main

  ✅ !123  merged   (merged main in, pipeline #NNN green, worktree removed)
  ✅ !124  merged   (already up to date, reused pipeline #NNN, worktree removed)
  🔴 !125  BLOCKED  — makemigrations --check: two heads on boards app once
                      stacked on !123/!124's migration. Fix on the branch:
                      run `manage.py makemigrations --merge`, then re-run
                      /mass_merge !125. Worktree left in place.

Landed 2 of 3. main pipeline: <URL of latest main pipeline — confirm green>.
```

Confirm the post-merge main pipeline is green after *every* merge, not just at
the end (see the Phase B post-merge gate) — that is the whole point of the
skill. If it is red despite Phase A being clean, a check exists that Phase A
does not reproduce (a `ref: main`-only job, or an externally-published
advisory): stop, report which job failed and whether the pre-batch main was
already green, and — if it is a check Phase A *could* reproduce — add it to
the Step 2 sweep so the next run catches it before merging rather than after.

---

## Rules

- **User-invoked only.** Never run Phase B as part of unattended agent work.
- **Clean tree, no parallel in-flight work** before starting — it flips
  checkouts and pushes branches. Use a dedicated worktree if other sessions
  are live.
- **Only the contiguous safe prefix lands.** A 🔴 stops the run; do not reorder
  to land later MRs.
- **Bring every MR up to the latest main immediately before pushing.** Do it
  with `git merge --no-edit origin/main`, not a rebase, when `merge_method` is
  `merge`: the merge yields the exact tree GitLab lands and Phase A validated,
  resolves once instead of once per replayed commit, and needs no force-push.
  Rebase only on request, and never on a branch where
  `git log --merges origin/main..origin/$BR` is non-empty. Skip the update
  entirely when `git merge-base --is-ancestor origin/main "$BR"` already holds.
- **Poll-to-green then merge; merges serial, next update+push may overlap.**
  No batch MWPS, no parallel *merges*. Merge N+1 only once **both**
  MR(N+1)'s pipeline and the main(N) pipeline are green.
- **Gate on the `ref: main` pipeline after every merge — at most one merge
  lands on a red main.**
- **Poll the exact pushed full sha by MR ref** — never the `?sha=<short>`
  filter and never `head_pipeline`. Cap the wait so CI hangs don't loop
  forever.
- **Triage a `failed` before stopping.** A freshly-pushed branch re-runs
  `playwright-e2e`, which is `allow_failure: true` in this project during its
  rollout — check that before treating an e2e failure as a stop. A real
  test/type/lint/build failure — or one on this MR's own diff — is a hard
  stop. Never blanket-retry to force green.
- **Drive worktree-held branches with `git -C "$WT"`.**
- **Push updated branches with `--no-verify`** — Phase A already ran the
  equivalent check on the combined tree.
- **Never `--force`. If a rebase forced you into a lease, use the BARE
  `--force-with-lease`** after asserting `git rev-parse origin/$BR` by hand.
- **Poll under `Monitor` or `run_in_background`, never foreground.** Use a
  bounded `for` loop that exits 0 on `success` and 1 on `failed|canceled`, and
  print one self-describing line. Prefer one combined poller for the
  overlapped gates.
- **Poll output stays silent except at transitions — never echo every tick,
  and never fill the wait with placeholder tool calls.**
- **Match `source == 'push'` in the `ref=main` poll, not the sha alone.** Do
  not carry that filter to the MR-ref poll — those pipelines are
  `merge_request_event` and it would hang the full wait.
- **Run `vitest`/`pytest` on the stacked tree in Phase A** when the batch
  touches `frontend/src` / `backend/`. The check scripts never do, so a
  registry-vs-coverage-test conflict passes simulation and detonates
  mid-batch. Playwright e2e stays the residual risk Phase A cannot certify.
- **Never resolve a merge/rebase conflict by guessing** — stop and hand it
  back.
- **A zero-job `failed` pipeline is capacity, not code — never conclude from
  it.** `jobs: 0` + `started_at: null` + instant finish + `yaml_errors: null`
  means the pipeline failed at *creation*. It tested nothing. Wait for the
  active pipelines to drain, re-trigger with `glab ci run -b main`, and gate
  on the pipeline that actually runs jobs. Merging fast is what causes this,
  so never batch-merge to catch up.
- **Step 0's validation is a snapshot, not a lock — re-verify before every
  act.** Another session (or a human) can merge the batch mid-run. Re-read
  `glab mr view <iid>` state immediately before updating and again before
  merging; if it is no longer `opened`, skip it and re-plan.
- **Run Phase A in a dedicated worktree, never the shared main checkout.**
  Symlink `.venv` and both `node_modules` into the worktree — a bare
  `git worktree add` does not, and the toolchain dies without them.
- **Restore the user's original branch** (Step 0) when the run ends, on
  success or failure.
- **Remove each MR's worktree (`scripts/wt remove <issue>`) right after it
  merges, not batched at the end.** Never remove a worktree for an MR that is
  still open or 🔴-blocked.
- If merged-results pipelines / merge trains get enabled in the project, tell
  the user this skill is now mostly redundant with the server doing it.
