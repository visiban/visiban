---
name: fix-mr
description: Get a blocked GitLab MR to green AND mergeable. Reads both axes of readiness (pipeline status and mergeability), resolves conflicts with `main`, diagnoses pipeline failures with parallel sub-agents, applies fixes, commits, pushes, and re-checks (max 3 iterations).
disable-model-invocation: true
argument-hint: "[MR number ...]"
---

# Fix MR

Get a blocked GitLab MR to green **and** mergeable.

**An MR is blocked on two independent axes.** The pipeline can be green while the
branch conflicts with `main`, and the branch can be mergeable while the
pipeline is red. GitLab tracks them separately — `head_pipeline.status` versus
`detailed_merge_status` / `has_conflicts` — and this skill covers both. Reading only
the pipeline is how a conflicted MR gets reported "ready to merge": MR !1235 was in
exactly that state: green pipeline, merge conflict.

Usage:
```
/fix-mr            # uses the current branch's MR
/fix-mr 42         # targets MR !42
/fix-mr 42 43 47   # several: read both axes for all of them, then work them one at a time
```

---

## Step 1 — Read BOTH axes: pipeline status and mergeability

If `$ARGUMENTS` holds MR numbers, use them. Otherwise find the MR for the current
branch. Bare `glab mr list` means open — there is no `--state` flag — and its text
table parenthesizes the branch, so read JSON rather than scraping the table:

```bash
glab mr list --source-branch "$(git branch --show-current)" -F json | jq -r '.[].iid'
```

If no open MR exists, stop and tell the user. Then, for **every** MR, one call returns
everything:

```bash
glab api "projects/:id/merge_requests/<MR>" | jq -r '
  "source:         \(.source_branch)",
  "state:          \(.state)",
  "pipeline:       \(.head_pipeline.status // "none") (\(.head_pipeline.id // "-"))",
  "merge_status:   \(.detailed_merge_status // .merge_status)",
  "has_conflicts:  \(.has_conflicts)"'
```

With several MRs, report the two-axis state of each **before** working any of them — a
batch where one MR is conflicted and another is red needs different treatment per MR,
and this table is what tells them apart.

Route on the pair. The axes are independent, so check both even when one of them is
already an answer:

| pipeline | `detailed_merge_status` | Go to |
|---|---|---|
| `failed` | `mergeable` | Step 2 (pipeline only) |
| `success` | `conflict` | **Step 3b** (conflict only) |
| `failed` | `conflict` | **Step 3b first** — merging `main` often clears the red too |
| `success` | `mergeable` | Step 6 — genuinely done |
| `running` / `pending` | either | Step 5, then re-read both |

**Read the pipeline from the MR, never from the branch ref.** Once an MR exists, the
`workflow:` rules suppress branch pipelines, so a branch-scoped status can show a
*frozen pre-MR* result that ran almost no jobs. `head_pipeline` is the real one:

```bash
PIPELINE_ID=$(glab api "projects/:id/merge_requests/<MR>" | jq -r '.head_pipeline.id')
```

**A `success` can hide a failure.** A pipeline reports `success` while an
`allow_failure: true` job failed. If the MR is green but something still looks wrong,
query the jobs, not the pipeline summary.

---

## Step 2 — Diagnose failures (parallel sub-agents)

**First, rule out a pipeline that tested nothing.** A `failed` pipeline with **0 jobs**,
no `started_at`, and no YAML errors failed at *creation*. Two causes, neither of which
is a code defect: job-quota exhaustion ("exceeded the allowed number of jobs in active
pipelines" — wait for active pipelines to drain, then re-trigger), or a stale merge base
(Step 3b clears it). Do not diagnose code against it.

Otherwise, launch **2 sub-agents in parallel** (both with `model: "sonnet"`). Wait for
both.

**Sub-agent 1 — Fetch failed job logs:**
> List the failed jobs of pipeline `$PIPELINE_ID` with
> `glab api "projects/:id/pipelines/$PIPELINE_ID/jobs?scope[]=failed"`. For each, fetch
> its log with `glab ci trace <job-id>`. Return the job name, stage, and the log tail
> that contains the failure — not the whole log.

**Sub-agent 2 — Gather context:**
> Run `git log --oneline -5` and `git diff origin/main...HEAD --stat` to understand the
> branch's changes. Read `.gitlab-ci.yml` and any `ci/*.yml` files defining the failed
> jobs.
>
> Return: recent commits, changed files, and the relevant CI job definitions.

---

## Step 3 — Fix the root cause

Using the sub-agent results:

1. Identify the root cause of each failure
2. **A gate that reds while naming your files is often a stale base, not your diff.**
   The `main` may already have deleted the marker, renamed the symbol, or
   shipped the cap the spec asserts. Fetch and diff against it before editing the file
   the gate names.
3. Apply the fix (edit files, run formatters, update tests, etc.)
4. Verify locally:
   ```bash
   cd packages/api && pytest <test_file> -q   # backend test failures
   cd packages/web && npx tsc --noEmit        # frontend type errors
   ```
   (Run the linter named in the failing job for lint failures.)

### Step 3b — Merge conflict (`detailed_merge_status: conflict`)

Not a pipeline failure — the branch cannot merge into `main`. It has its own
procedure because two things reliably go wrong here.

**First: check the worktree before resolving anything.** The resolution is often already
on disk, unpushed, leaving no trace on the forge. In the issue's worktree
(`scripts/wt list`):

```bash
git status --porcelain                                    # must be clean
git rev-list --left-right --count HEAD...origin/<branch>  # LEFT=ahead RIGHT=behind
```

| ahead / behind | meaning | action |
|---|---|---|
| `N / 0` | local is strictly ahead | a plain **non-force** push clears it — done |
| `0 / N` | another session pushed | do not build on this HEAD; sync first |
| `N / M` | diverged — usually an unpushed **amend** | compare `git rev-parse HEAD^` with `git rev-parse origin/<branch>^`; identical parents mean the local commit *replaces* the remote one, and landing it needs a force-push — confirm with the user first |

**Then resolve, if there is genuinely something to resolve:**

```bash
git fetch origin
git merge origin/main
```

Prefer **merge over rebase** — it needs no force-push, so the no-force-push rule below
stays satisfied without a round trip.

**Resolve in place, between the conflict markers.** Never rebuild a conflicted file from
`git show :2:<path>`. Stage 2 is the branch's *pre-merge* blob, so copying it over the
working-tree file silently discards every hunk the merge already auto-settled elsewhere
in that same file — and `git status` still reports the file resolved. The tell is a test
failing on a symbol your change never mentions, in a block the *other* branch
contributed.

**After merging, check what a merge commonly breaks:**
- `ls changelog.d/` — a merge can leave a **duplicate** fragment
- Sequence-numbered files (migrations, ADRs, numbered rules in `frontend/CLAUDE.md`) — these collide only on the
  *merged* tree, so both sides were green alone

Then re-run the scoped tests for the files the merge touched and push. A merge commit's default message is fine.

---

## Step 4 — Commit and push

Commit the fix with a descriptive message:

```bash
git add <fixed files>
git commit -m "fix(ci): <what was fixed>"
git push origin "$(git branch --show-current)"
```

---

## Step 5 — Wait and re-check

After pushing, read both axes again (the Step 1 call). If the pipeline is still running,
tell the user and stop — do not poll in a foreground loop. If you must wait, run a
bounded poll in the background and make no other tool calls until it reports.

If the pipeline has completed:
- **Green**: go to Step 6
- **Red with new failures**: go back to Step 2 (max 3 iterations)

---

## Step 6 — Confirm green AND mergeable

Re-read both axes. A fix for one axis can change the other: merging `main`
re-runs the pipeline, and a new commit re-evaluates mergeability.

**Only report ready to merge when `head_pipeline.status == "success"` AND
`detailed_merge_status == "mergeable"`.** Both, every time:

```
Pipeline is green and the branch is mergeable. MR !<N> is ready to merge.
```

When they disagree, say so rather than reporting the good half:

```
MR !<N>: pipeline green, but the branch CONFLICTS with main — not mergeable.
```

`detailed_merge_status` also reports blockers this skill does not fix —
`not_approved`, `discussions_not_resolved`, `draft_status`, `blocked_status`. Report
those verbatim rather than calling the MR ready; they need a human.

---

## Rules

- **Check both axes before reporting anything** — a green pipeline is half the answer; `detailed_merge_status` is the other half
- **Never force-push** without user confirmation — create new commits for fixes, and merge (not rebase) to resolve conflicts
- **Max 3 fix iterations** — if the pipeline still fails after 3 rounds, report the remaining failures and stop. The user needs to investigate.
- **Never merge the MR** — hand back the URL and stop. The user merges manually.
- **Do not retry without a code change** unless the failure is clearly infrastructure-related (runner timeout, network error, OOM, a zero-job pipeline)
- **Verify locally before pushing** — do not use CI as a debugger
- If `glab` is not authenticated, tell the user to run `glab auth login` and stop
