# Find the CI gates that have stopped finding anything
<a id="kaizen-yield-watch"></a>

A scheduled job counts consecutive `0 findings` runs per gate and diff shape, and reports gates that hit 10 in a row (the yield watch, #1144).

**Why it matters:** `/kaizen` (#1094) reads the MR `## Gates` ledger and computes per-gate yield, but only when someone remembers to run it. This is the same problem the memory-discipline rules describe: a signal that only has value if someone remembers to read it. The watch makes it continuous.

**Watch out:** It changes nothing on its own. It never edits `CLAUDE.md` or the fast-path table; that stays a reviewed change.

**Go deeper:** [Kaizen fast-path proposal](kaizen-fastpath-proposal.md) (#1145) turns this state into a proposed table diff with cited evidence for that review.

<a id="running-it"></a>

```bash
python3 scripts/kaizen_yield_watch.py                              # report only
python3 scripts/kaizen_yield_watch.py --write-state /tmp/s.json   # also emit new state
python3 scripts/kaizen_yield_watch.py --input mrs.json            # offline
python3 scripts/kaizen_yield_watch.py --self-test                 # gate self-test (#1093)
```

## What it counts

For each **gate** and **diff shape** it tracks the current streak of consecutive runs that reported `0 findings`.

| Ledger outcome | Effect |
|---|---|
| `N findings`, N > 0 | run; resets the streak |
| `0 findings` | run; streak + 1 |
| `n/a (...)` | gate didn't apply; ignored |
| `skipped (...)` | compliance signal; ignored (never conflated with `0 findings`) |
| prose / deliverable outcome | no yield information; ignored |

- **Never tracked:** `changelog`, `docs-writer`, and `test-scaffold` are deliverable gates. The ledger grammar is the one in `scripts/kaizen_gate_ledger.py`, which this script imports.
- **Threshold: 10 consecutive 0-finding runs.** This reuses `/kaizen`'s `MIN_RUNS_FOR_VERDICT`. `/kaizen` states no *consecutive* rule and has no diff-shape dimension (it computes per-gate totals over a window), so "consecutive" and "shape" are defined here.
- **Diff shape** is the MR source-branch prefix: `feat`, `fix`, `docs`, `chore`, or `other`. These mirror the rows of the fast-path table and come from the API without fetching diffs. Zeros are never pooled across shapes.

## Where the count lives

`.claude/kaizen-yield-state.json`, committed, like `backend/schemathesis-baseline.json`. CI cache and artifacts expire; a committed file is reviewable and survives.

- Each run folds in only MRs merged after the file's `(last_merged_at, last_iid)` watermark, so re-running against an unchanged file never double counts.
- The job uses the file as its baseline and uploads the updated state as an artifact. Commit it in a chore MR to advance the baseline.
- If nobody does, the next run re-derives the same result.

## Argument validation

The kaizen scripts reject malformed arguments up front (#1377):

- `--window` must be an integer from 1 to 100 (GitLab's `per_page` cap).
- `--project` must be a plain `group/project` path (letters, digits, `_`, `.`, `-`; no leading `-`, no `.`/`..` segments); argparse rejects a malformed value (exit 2). `kaizen_gate_ledger.py` is stricter: when it fetches from GitLab (not with `--input`), it accepts only `visiban/visiban` (the default) or `visiban/visiban-enterprise` and exits 1 for anything else.
- File-path arguments (`--input`, `--state`, `--declined`, `--write-state`) must resolve under the repository, the current directory, or the temp directory, through `scripts/_paths.py`. A path that escapes (via `..` or a symlink) exits non-zero. A bad `--declined` path is never treated as "nothing declined".

See [CI gate scripts and path containment](ci-gates.md#path-containment-for-cli-arguments) for the shared helper.

## Scheduled job

`kaizen-yield-watch` runs only in scheduled pipelines that set `KAIZEN_YIELD_WATCH=true`, which the consolidated Nightly schedule does (#1383; see [Scheduled pipelines](ci-gates.md#scheduled-pipelines)).

- **Why daily:** it's more often than needed, but it's one small job in a pipeline that runs anyway. A separate weekly schedule would spawn a whole extra full pipeline just for this report.
- **No double counting:** each run folds only MRs past the committed watermark.
- **Fails open:** the job is `allow_failure: true`, and an inconclusive GitLab API lookup is a warning and exit 0, matching `scripts/check-suppression-issues.sh`.

## Auto-filing issues (opt-in)

Default is a dry run that prints what would be filed. To enable filing, set `KAIZEN_FILE_ISSUES=true` and a `KAIZEN_API_TOKEN` variable (project token, `api` scope) on the schedule.

- Each new candidate becomes one issue titled ``harness: narrow `<gate>` trigger on <shape> diffs (N consecutive 0-finding runs)``, with the evidence (streak, lifetime runs, recent MRs) attached.
- Filing is deduplicated against open issues with the same title.
- It skips gates recorded in `.claude/kaizen-declined.json`.
- A pair isn't re-raised until its streak breaks.
- Proposals narrow a gate's trigger; they never delete a gate.

## Tests

`bash scripts/tests/kaizen_yield_watch.test.sh` (no network). CI runs `--self-test` immediately before the real invocation.
