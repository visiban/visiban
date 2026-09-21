# Nightly load test

A query-count guard is not a latency guard. `perf-check` (static N+1 review) and `perf-bench`
(query counts on demand) both measure query *count* — a regression from a missing index, a
data-volume change, or a query-plan flip can leave the query count and query text identical
while making the same queries slower. Neither of those gates can see that class of regression.
This page describes the job that can: a nightly, schedule-only CI job (`nightly-load-test` in
`.gitlab-ci.yml`) that measures real wall-clock p50/p95/p99 latency against a large seeded
fixture and fails the pipeline if any covered endpoint exceeds its committed budget.

!!! info "Where this came from"
    Filed as #1082 from a TruePPM audit finding: a real p95 regression (`GET /tasks/` at
    3.3x baseline) was "fixed" by a query-count guard that its own description said could not
    detect that class of regression — the fix never touched the actual root cause, and the
    regression sat inside a budget loose enough to hide it. See the issue for the full
    postmortem.

## What it covers

| Endpoint | Path | Volume sensitivity |
|---|---|---|
| Board fetch | `GET /api/v1/boards/{id}/full/` | Serializes every card on the board, unpaginated — the single most volume-sensitive read in the product |
| Card search | `GET /api/v1/cards/?search=...` | Exercises the `pg_trgm` GIN indexes added in migration `0030_card_trigram_search_indexes` |
| Card timeline | `GET /api/v1/boards/{board_id}/cards/{id}/timeline/` | Exercises the composite indexes added in migration `0045_add_activity_comment_composite_indexes` |
| Notifications list | `GET /api/v1/notifications/` | The highest-QPS authenticated endpoint in the product — the frontend polls it every 15-30s |
| Notifications unread count | `GET /api/v1/notifications/unread-count/` | Same polling cadence as the list endpoint |

`perf-check` and `perf-bench` are unchanged and still run where they already did — this job is
additive, not a replacement. `perf-check`'s own description
([`.claude/agents/perf-check.md`](https://gitlab.com/visiban/visiban/-/blob/main/.claude/agents/perf-check.md))
now states this division of labor explicitly: a query-count guard does not satisfy a latency
budget.

## The fixture

The job seeds a dedicated, larger board — never the real demo board — with:

```bash
cd backend
python manage.py seed_demo_data --force --scale 20 --with-notifications
```

- `--scale 20` replicates the demo board's 10-swimlane layout 20 times: **200 swimlanes,
  ~2,400 cards** (11-13 cards per swimlane, same distribution `seed_demo_data` always uses —
  see its docstring). The board is named **"Visiban Load Test Board"**, distinct from
  `"Visiban Demo Board"`, so this job can never collide with or overwrite the weekly
  `seed-demo-data` refresh job's data, in CI or on the shared demo environment.
- `--with-notifications` seeds 60 unread `Notification` rows for the `demo2` user — more than
  the 50-row cap `NotificationListView` / `NotificationUnreadCountView` apply, so the job
  exercises the same "more unread than the cap" path a busy real inbox hits.
- **A fixture size with no stated card/swimlane count is meaningless** — a p95 number is only
  interpretable next to the data volume it was measured against. `nightly-load-test-results.json`
  (the job's artifact) always records the fixture's actual card and swimlane count alongside
  the timings, and `backend/nightly-load-test-baseline.json` records what the committed budgets
  were derived against.

`--scale > 1` never combines with `--export` — the large fixture is regenerated fresh in an
ephemeral CI database on every run and is never meant to be committed to `sample-boards/`.

## Auth

The job reuses `manage.py provision_fuzz_token` (already used by `backend-schema-fuzz`) to mint
a scoped, non-admin Personal Access Token for `demo2` and writes it to a CI-only file
(`VISIBAN_LOAD_TEST_TOKEN_FILE`, mode `0600`, never logged). No credential is hardcoded anywhere
in the job or the script — this follows the same "no hardcoded credentials" rule as every other
backend job in `.gitlab-ci.yml`.

## Running it

```bash
python scripts/nightly_load_test.py \
    --base-url http://localhost:8000 \
    --token-file /tmp/visiban_load_test_token \
    --budget-file backend/nightly-load-test-baseline.json \
    --iterations 40 --warmup 5 \
    --output nightly-load-test-results.json
```

For each endpoint: 5 warmup requests (discarded), then 40 timed requests. Percentiles use
nearest-rank (no interpolation), so every reported number was an actually-observed latency, not
a synthetic average of two samples. The job fails (`sys.exit(1)`) if any endpoint's measured p95
exceeds its budget, and always writes the full per-endpoint results as a CI artifact
(`nightly-load-test-results.json`, kept 90 days) regardless of pass/fail.

Like every bespoke gate script in this repo, it ships a `--self-test` mode
(`python scripts/nightly_load_test.py --self-test`) that proves the percentile calculation and
budget-comparison logic still fire on a known-bad and known-good input, run in CI immediately
before the real invocation — see [CI gate self-tests](ci-gates.md).

## The schedule

Configure once in GitLab: **CI/CD → Schedules → New schedule**

- Target branch: `main`
- Cron: `0 3 * * *` (daily at 03:00 UTC)
- Variables: `LOAD_TEST_SCHEDULE=true`

The job can also be run manually at any time (advisory — `allow_failure: true` on the manual
path only; the scheduled run is blocking) via "Run pipeline" or the job's manual play button.

## Budget derivation — the rule

**Budgets are committed to the repo, in `backend/nightly-load-test-baseline.json`, and every
`budget_p95_ms` must trace to a `measured_p95_ms` via a stated formula — never a round number
picked because it looked reasonable.** TruePPM's postmortem is explicit about why: its 2000ms
budget was loose enough that a 2x regression (683-851ms baseline &rarr; 1330ms) sat inside it
without ever firing.

The formula this repo uses:

```
budget_p95_ms = ceil(measured_p95_ms * 1.4 / 5) * 5
```

- **1.4x** is the midpoint of the 1.3-1.5x range #1082 specifies — tight enough that a
  meaningful regression still trips the budget, loose enough to absorb ordinary CI-runner
  noise between runs.
- Rounding up to the nearest **5ms** gives the comparison a small amount of headroom for
  measurement jitter without the number itself being arbitrary — it is still fully determined
  by the measured baseline, just not reported to sub-millisecond precision.

### Re-deriving the baseline (do this at every release, and whenever the fixture size changes)

1. Trigger the `nightly-load-test` job (wait for the schedule, or run it manually).
2. Download its `nightly-load-test-results.json` artifact.
3. For each endpoint, recompute `budget_p95_ms` from that run's `p95_ms` using the formula
   above.
4. Update `backend/nightly-load-test-baseline.json`'s `measured_p95_ms`, `measured_p99_ms`, and
   `budget_p95_ms` fields, its top-level `measured_at`, and its `fixture` block if the fixture
   size changed. Recompute the whole file in one pass — never hand-adjust a single
   `budget_p95_ms` without also updating the `measured_p95_ms` it supposedly came from.
5. Flip `status` from `"provisional"` to `"ci-derived"` the first time this is done from a real
   scheduled pipeline run (see the note below).

!!! warning "The baseline committed alongside #1082 is provisional"
    `backend/nightly-load-test-baseline.json`'s numbers were measured locally — against a real
    PostgreSQL 17 instance with the `pg_trgm` indexes active, using the same seed command and
    the same `scripts/nightly_load_test.py` the CI job runs, so they are genuine measurements,
    not invented — but on a development machine, not a GitLab CI runner. **A number measured on
    a laptop is not a CI baseline**: runner CPU/IO characteristics differ, and this is exactly
    the distinction the issue this job implements is about. Re-derive from the first real
    scheduled `nightly-load-test` run after this lands, following the steps above, and flip
    `status` to `"ci-derived"` at that point. Until then, treat every budget in that file as a
    reasonable starting point, not a proven-tight one.

## Failure notifications

The scheduled run is blocking (not `allow_failure`), so a budget violation fails the pipeline.
GitLab emails every project maintainer who has "Failed pipeline" notifications enabled
(**Profile → Notifications → Global notification level → "Watch"**, or per-project under
**Project → Notification settings**) — the same mechanism the weekly CVE scan
(`backend-dep-scan` / `frontend-dep-scan`) already relies on.
