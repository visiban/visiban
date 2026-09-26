# Kaizen yield watch

`/kaizen` (#1094) reads the MR `## Gates` ledger and computes per-gate yield, but only when
someone remembers to run it. The yield watch (#1144) makes that signal continuous: a scheduled
job keeps a running count and reports gates that have stopped finding anything. It is the same
problem the memory-discipline rules describe: a signal that only has value if someone
remembers to read it.

It changes nothing on its own. It never edits `CLAUDE.md` or the fast-path table; that stays a
reviewed change (deriving the table from this data is #1145).

## What it counts

For each **gate** and **diff shape** it tracks the current streak of consecutive runs that
reported `0 findings`.

| Ledger outcome | Effect |
|---|---|
| `N findings`, N > 0 | run; resets the streak |
| `0 findings` | run; streak + 1 |
| `n/a (...)` | gate did not apply; ignored |
| `skipped (...)` | compliance signal; ignored (never conflated with `0 findings`) |
| prose / deliverable outcome | no yield information; ignored |

`changelog`, `docs-writer`, and `test-scaffold` are deliverable gates and are never tracked.
The ledger grammar is the one in `scripts/kaizen_gate_ledger.py`, which this script imports.

**Threshold: 10 consecutive 0-finding runs.** This reuses `/kaizen`'s `MIN_RUNS_FOR_VERDICT`.
`/kaizen` states no *consecutive* rule and has no diff-shape dimension (it computes
per-gate totals over a window), so "consecutive" and "shape" are defined here.

**Diff shape** is the MR source-branch prefix: `feat`, `fix`, `docs`, `chore`, or `other`.
These mirror the rows of the fast-path table and are available from the API without fetching
diffs. Zeros are never pooled across shapes.

## Where the count lives

`.claude/kaizen-yield-state.json`, committed, like `backend/schemathesis-baseline.json`.
CI cache and artifacts expire; a committed file is reviewable and survives. Each run folds in
only MRs merged after the file's `(last_merged_at, last_iid)` watermark, so re-running against
an unchanged file never double counts. The job runs with the file as its baseline and uploads
the updated state as an artifact; commit it in a chore MR to advance the baseline. Even if
nobody does, the next run re-derives the same result.

## Running it

```bash
python3 scripts/kaizen_yield_watch.py                              # report only
python3 scripts/kaizen_yield_watch.py --write-state /tmp/s.json   # also emit new state
python3 scripts/kaizen_yield_watch.py --input mrs.json            # offline
python3 scripts/kaizen_yield_watch.py --self-test                 # gate self-test (#1093)
```

## Scheduled job

`kaizen-yield-watch` runs only in scheduled pipelines that set `KAIZEN_YIELD_WATCH=true`
(CI/CD, Schedules; suggested weekly). It is `allow_failure: true` and **fails open**: an
inconclusive GitLab API lookup is a warning and exit 0, matching
`scripts/check-suppression-issues.sh`.

## Auto-filing issues (opt-in)

Default is a dry run that prints what would be filed. To enable filing, set
`KAIZEN_FILE_ISSUES=true` and a `KAIZEN_API_TOKEN` variable (project token, `api` scope) on the
schedule. Each new candidate becomes one issue titled
``harness: narrow `<gate>` trigger on <shape> diffs (N consecutive 0-finding runs)``, with the
evidence (streak, lifetime runs, recent MRs) attached. Filing is deduplicated against open issues
with the same title, skips gates recorded in `.claude/kaizen-declined.json`, and a pair is not
re-raised until its streak breaks. Proposals narrow a gate's trigger; they never delete a gate.

## Tests

`bash scripts/tests/kaizen_yield_watch.test.sh` (no network). CI runs
`--self-test` immediately before the real invocation.
