# A nightly job fails the pipeline when an endpoint gets slower

`nightly-load-test` is a nightly, schedule-only CI job (`.gitlab-ci.yml`) that measures real
wall-clock p50/p95/p99 latency against a large seeded fixture and fails the pipeline if any
covered endpoint exceeds its committed budget.

**Why it matters:** A query-count guard is not a latency guard. `perf-check` (static N+1
review) and `perf-bench` (query counts on demand) both measure query *count*. A regression
from a missing index, a data-volume change, or a query-plan flip can leave the query count
and query text identical while making the same queries slower. Neither of those gates can
see that class of regression; this job can.

!!! info "Where this came from"
    Filed as #1082 from a TruePPM audit finding: a real p95 regression (`GET /tasks/` at
    3.3x baseline) was "fixed" by a query-count guard that its own description said could not
    detect that class of regression — the fix never touched the actual root cause, and the
    regression sat inside a budget loose enough to hide it. See the issue for the full
    postmortem.

## What it covers

| Endpoint | Path | Volume sensitivity |
|---|---|---|
| Board list | `GET /api/v1/boards/` | Run as the board owner (`demo1`) so the access query spans the 20-member board. Per-board member and card counts are independent correlated subqueries and the access filter no longer joins memberships (#1723). Budget 55ms ([#1767](https://gitlab.com/visiban/visiban/-/issues/1767)) |
| Board fetch | `GET /api/v1/boards/{id}/full/` | Serializes every card on the board, unpaginated — the single most volume-sensitive read in the product |
| Card search | `GET /api/v1/cards/?search=...` | The cross-board card query: access filter, a 51-row cursor page and a row-by-row substring filter. It does **not** use the `pg_trgm` GIN indexes from migration `0030_card_trigram_search_indexes`, because `icontains` renders as `UPPER(col) LIKE`, which they cannot serve ([#1809](https://gitlab.com/visiban/visiban/-/issues/1809)). The `card_search` scenario runs as a one-board user, so it measures only the single-board plan; `card_search_multi_board` runs the same request as `demo3`, who can access 200 boards ([#1810](https://gitlab.com/visiban/visiban/-/issues/1810); see [#1805](#the-october-2026-card_search-and-notifications_unread-drift-1805)) |
| Card search, many boards | `GET /api/v1/cards/?search=...` as `demo3` | The same query as above for a user with 200 accessible boards, which is expected to get PostgreSQL's scan-and-sort plan instead of the index walk (not confirmed on this fixture: no `EXPLAIN` was run). Budget 120ms, derived in [#1808](https://gitlab.com/visiban/visiban/-/issues/1808) |
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
python manage.py seed_demo_data --force --scale 20 --extra-boards 199 --with-notifications
```

- `--scale 20` replicates the demo board's 10-swimlane layout 20 times: **200 swimlanes,
  ~2,400 cards** (11-13 cards per swimlane, same distribution `seed_demo_data` always uses —
  see its docstring). The board is named **"Visiban Load Test Board"**, distinct from
  `"Visiban Demo Board"`, so this job can never collide with or overwrite the
  manual `seed-demo-data` job's data, in CI or on the shared demo environment.
- **20 members** on that board (the 5 demo users plus 15 `loadtest*` filler accounts with
  unusable passwords, `--scale > 1` only). Members x cards is the shape that made the board
  list's count annotations expensive (two multi-valued joins multiplying, #1723), and a
  5-member fixture could not expose it; with ~2,400 cards it now exercises that endpoint.
  `GET /api/v1/boards/` computes `member_count` / `card_count` / `archived_card_count` as
  independent correlated subqueries, and the access filter uses an `EXISTS` membership predicate
  rather than a join, so the members x cards row blow-up is gone. The job times that endpoint as
  the `board_list` scenario, as the board owner (`demo1`, via `--owner-token-file`) so the
  20 memberships are on the measured path; `card_search_multi_board` runs as `demo3`; every other scenario still runs as `demo2`. It has
  a committed budget in `backend/nightly-load-test-baseline.json` (added by
  [#1767](https://gitlab.com/visiban/visiban/-/issues/1767)).
- `--extra-boards 199` ([#1810](https://gitlab.com/visiban/visiban/-/issues/1810)) adds 199
  small boards ("Visiban Load Test Extra Board 001" and on; one swimlane and 8 cards each,
  1,592 cards) owned by `demo3`. With the load-test board, `demo3` can access **200 boards**,
  the many-board side of the card query's plan switch. The boards belong to `demo3` alone, so
  the `demo1` `board_list` scenario and every `demo2` scenario can see the same boards as before.
  The `cards` table does grow by about 67% (about 3,980 cards in total), so those scenarios are
  expected, not proven, to be unaffected; [#1808](https://gitlab.com/visiban/visiban/-/issues/1808)
  re-derived the whole file from the first NUC run with this fixture (job 17348200339).
  The job's `LOAD_TEST_EXTRA_BOARDS` variable sets the count, and the script fails before
  timing anything if `demo3` can access fewer than `--min-multi-boards` boards (default 50; the CI job
  passes `LOAD_TEST_EXTRA_BOARDS + 1`, so a seed that silently shrinks fails).
  The baseline's `fixture` block records `extra_board_count` and
  `multi_board_accessible_boards`.
- `--with-notifications` seeds 60 unread `Notification` rows for the `demo2` user — more than
  the 50-row cap `NotificationListView` / `NotificationUnreadCountView` apply, so the job
  exercises the same "more unread than the cap" path a busy real inbox hits.
- **A fixture size with no stated card/swimlane count is meaningless** — a p95 number is only
  interpretable next to the data volume it was measured against. `nightly-load-test-results.json`
  (the job's artifact) always records the fixture's actual card and swimlane count alongside
  the timings, and `backend/nightly-load-test-baseline.json` records what the committed budgets
  were derived against.

The large fixture is regenerated fresh in an ephemeral CI database on every run and is never
committed anywhere.

## Auth

The job reuses `manage.py provision_fuzz_token` (already used by `backend-schema-fuzz`) to mint
a scoped, non-admin Personal Access Token for `demo2` and writes it to a CI-only file
(`VISIBAN_LOAD_TEST_TOKEN_FILE`, mode `0600`, never logged). No credential is hardcoded anywhere
in the job or the script — this follows the same "no hardcoded credentials" rule as every other
backend job in `.gitlab-ci.yml`.

The job passes `--set-random-password`, the same flag the schema-fuzz jobs use
([#1607](https://gitlab.com/visiban/visiban/-/issues/1607)). `demo2` is seeded with no usable
password, and a password change revokes every token. The flag gives `demo2` a random password
that is never recorded, so the password-change routes require a current password and no request
can revoke the job's token mid-run. The flag is off by default, and the command is for throwaway
CI databases like this job's only.

The job provisions a third token for `demo3` (`VISIBAN_LOAD_TEST_MULTI_BOARD_TOKEN_FILE`) the
same way, used by `card_search_multi_board` alone. `--multi-board-token-file` has no default and
the script refuses to run without it, for the same reason as `--owner-token-file`: measured as
`demo2`, the scenario would time the one-board plan again and report a number that says
nothing about the many-board plan.

## Running it

```bash
python3 scripts/nightly_load_test.py \
    --base-url http://localhost:8000 \
    --token-file /tmp/visiban_load_test_token \
    --owner-token-file /tmp/visiban_load_test_owner_token \
    --multi-board-token-file /tmp/visiban_load_test_multi_board_token \
    --board-name "Visiban Load Test Board" \
    --budget-file backend/nightly-load-test-baseline.json \
    --iterations 40 --warmup 5 \
    --output nightly-load-test-results.json
```

The CI job provisions three tokens: `--token-file` (`demo2`, a plain member) for every scenario
except two, `--owner-token-file` (`demo1`, the board owner) for `board_list` alone, and
`--multi-board-token-file` (`demo3`, who can access 200 boards) for `card_search_multi_board`
alone. `--owner-token-file`
has no default and the script refuses to run without it: `board_list`'s 55ms budget was derived
as the owner, whose access query spans all 20 memberships, so measuring it as `demo2` would
compare a cheaper path against that budget and hide a regression. The other flags shown are the
script's defaults.

For each endpoint: 5 warmup requests (discarded), then 40 timed requests. Percentiles use
nearest-rank (no interpolation), so every reported number was an actually-observed latency, not
a synthetic average of two samples. The job fails (`sys.exit(1)`) if any endpoint's measured p95
exceeds its budget, and always writes the full per-endpoint results as a CI artifact
(`nightly-load-test-results.json`, kept 90 days) regardless of pass/fail.

The Django `runserver` output is not written to the job log (a noisy run could hit GitLab's
16 MB log cap). It goes to the `nightly-load-test-server.log` artifact, which shares the results
file's 90-day expiry and is restricted to developers. On failure the job log prints the last
200 lines of it.

Like every bespoke gate script in this repo, it ships a `--self-test` mode
(`python scripts/nightly_load_test.py --self-test`) that proves the percentile calculation and
budget-comparison logic still fire on a known-bad and known-good input, run in CI immediately
before the real invocation — see [CI gate self-tests](ci-gates.md). It also fails if any scenario
the script measures has no `budget_p95_ms` in the committed baseline, so a new scenario cannot
silently stay measure-only, unless the entry carries an explicit pending budget (below). The
`nightly-load-test-selftest` job runs it on merge requests that touch the script or the baseline.

### Pending budgets

A budget may only come from a NUC run, so a new scenario can land before its budget can.
For that case a baseline entry may set `"budget_p95_ms": null` together with
`"pending_budget": "#NNNN"`, the issue that will assign the budget. The script then:

- measures the scenario and records it in the results artifact, with `budget_pending` in its
  entry, so the NUC run needed to derive the budget produces its number;
- prints `PENDING BUDGET: <name> is measured but NOT gated until #NNNN assigns its budget.`
  next to the scenario, a `WARNING: PENDING BUDGET` line on stderr at the end, and says
  "(N pending, NOT gated: ...)" in its final line, every run;
- never fails the job on it.

It is not a silent default: the self-test fails a scenario whose budget is null without a valid
`#NNNN` reference, or with no baseline entry at all, and asserts that a pending scenario can
never produce a violation. When the issue assigns the budget, replace `budget_p95_ms` and delete
`pending_budget` in the same whole-file re-derivation. Nothing is pending now:
`card_search_multi_board` ([#1810](https://gitlab.com/visiban/visiban/-/issues/1810) added the
scenario) got its budget in [#1808](https://gitlab.com/visiban/visiban/-/issues/1808).
The `suppressions-check` CI job fails, naming the entry and the issue, if the cited issue
closes while the entry is still pending ([#1812](https://gitlab.com/visiban/visiban/-/issues/1812);
see [Suppression markers](suppressions.md#what-ci-enforces)).

## The schedule

Configure once in GitLab: **CI/CD → Schedules → New schedule**

- Target branch: `main`
- Cron: `0 0 * * *`, timezone `America/New_York` (daily at midnight Eastern, 04:00 UTC during daylight time and 05:00 UTC in winter; schedule 4463581)
- Variables: `LOAD_TEST_SCHEDULE=true`

The job can also be run manually at any time (advisory — `allow_failure: true` on the manual
path only; the scheduled run is blocking) via "Run pipeline" or the job's manual play button.

!!! warning "This step is easy to skip silently — #1213"
    This is GitLab project configuration, not a file in this repo, so nothing in a diff or a
    review catches it being missed. It *was* missed: the schedule above was never created
    after this job merged, and the gap sat undetected until #1213 found it — by which point a
    real ~40% p95 regression on `GET /boards/{id}/full/` had already shipped past it. The
    `schedule-config-check` job (`scripts/check-pipeline-schedules.sh`) now asserts this
    schedule (and every other `$CI_PIPELINE_SOURCE == "schedule" && $VAR == "true"` rule in
    `.gitlab-ci.yml`) has an active GitLab schedule actually setting its variable, on every
    scheduled pipeline run — see [CI gate self-tests](ci-gates.md).

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

!!! warning "Budgets are only valid on NUC runners"
    Budgets are absolute milliseconds, so they only hold on the hardware they were measured
    on. The current baseline (job 17304593759, #1767) ran on `runner-04-NUC`; the one before it (job 16796708105, #1233) ran on `gitlab-runner-nuc-2-visiban`, and the job is
    pinned with `tags: [nuc]` (see [CI Runners](../maintainers/ci-runners.md)). Before the
    pin, the 2026-10-08 scheduled run landed on `gitlab-runner-dell-01-visiban` and failed
    `card_timeline`, `notifications_list` and `notifications_unread` by 1.3-1.8x with no
    relevant code change, while every NUC run before it had passed. When re-deriving, take
    the artifact from a NUC run, and re-derive the whole file if the runner class ever
    changes.

### Re-deriving the baseline (do this at every release, and whenever the fixture size changes)

1. Trigger the `nightly-load-test` job (wait for the schedule, or run it manually).
2. Download its `nightly-load-test-results.json` artifact.
3. For each endpoint, recompute `budget_p95_ms` from that run's `p95_ms` using the formula
   above.
4. Update `backend/nightly-load-test-baseline.json`'s `measured_p95_ms`, `measured_p99_ms`, and
   `budget_p95_ms` fields (and, for an entry with a `pending_budget` key, delete that key once
   its budget is set), its top-level `measured_at`, and its `fixture` block if the fixture
   size changed. Recompute the whole file in one pass — never hand-adjust a single
   `budget_p95_ms` without also updating the `measured_p95_ms` it supposedly came from.
5. Flip `status` from `"provisional"` to `"ci-derived"` the first time this is done from a real
   scheduled pipeline run (see the note below).

!!! note "Re-derived from the first real CI run — #1233"
    The baseline committed alongside #1082 was measured locally (a development machine, not a
    GitLab CI runner) and stayed `"provisional"` until a real scheduled run existed to re-derive
    it from — see #1213. That run happened 2026-09-29T03:00 UTC; `backend/nightly-load-test-baseline.json`
    is now `"ci-derived"` from its artifact (job 16796708105), following the steps above. The very
    next scheduled run (2026-09-30T03:00 UTC) failed against the *old* provisional budgets on
    `board_full`/`card_timeline`/`notifications_unread` — its measured numbers pass comfortably
    against the re-derived budgets, confirming the stale provisional file was the cause, not a new
    regression. `board_full` is the most CPU-bound of the six endpoints (per-card DRF
    serialization across ~2,388 cards, #1212) and shows the widest run-to-run variance on a
    shared CI runner as a result — expect it to move more between runs than the lighter
    endpoints.

!!! note "Re-derived after the 20-member fixture and `board_list` — #1767"
    The seed fixture grew to 20 board members and the `board_list` scenario was added (#1723), so
    the whole file was re-derived on 2026-10-20 from the first scheduled run after both landed
    (job 17304593759, pipeline 2965970261, started about 04:08 UTC, on `runner-04-NUC`, tag `nuc`). `board_list`
    is new and got its first budget (p95 37.2ms, budget 55ms), measured as the board owner so
    the 20 memberships are on the path. The other budgets were recomputed from this run, not
    hand-adjusted, and all moved up: `board_full` 1430 to 1695ms, `card_search` 120 to 155ms,
    `card_timeline` 55 to 60ms, `notifications_list` 50 to 60ms, `notifications_unread` 40 to
    45ms. Those increases are **not** attributable to the fixture change: they predate #1723
    (`board_full` p95 was 981-1042ms on `gitlab-runner-nuc-2-visiban` on Oct 1-4 versus
    1172-1375ms on Oct 9-19). The new `board_full` budget leaves
    under 3% headroom over the worst past run (1650.7ms, the Oct 12 failure against the old
    1430ms budget). [#1800](https://gitlab.com/visiban/visiban/-/issues/1800) partly attributed
    the `board_full` rise to the psycopg 3 migration and mitigated it with a backport. See
    [The October 2026 `board_full` drift](#the-october-2026-board_full-drift-1800) below.
    [#1807](https://gitlab.com/visiban/visiban/-/issues/1807) attributed the remainder of that
    step. See [The remaining driver step](#the-remaining-driver-step-1807) below. The rises on `card_search`,
    `card_timeline`, `notifications_list` and `notifications_unread` were investigated in
    [#1805](https://gitlab.com/visiban/visiban/-/issues/1805). See
    [The October 2026 `card_search` and `notifications_unread` drift](#the-october-2026-card_search-and-notifications_unread-drift-1805)
    below. The previous derivation ran
    on `gitlab-runner-nuc-2-visiban`; both are NUC-class
    (`nuc`-tagged) runners, so the file was re-derived as a whole rather than patched.

!!! note "Re-derived after the #1800, #1805 and #1810 changes — #1808"
    The whole file was re-derived on 2026-10-21 from job 17348200339 (pipeline 2971900609, a
    manual run of the nightly schedule on `main` at `58a4299b5`, on
    `gitlab-runner-nuc-2-visiban`, tag `nuc`). It is the first NUC run with the #1800 backport,
    the #1805 card filter and the #1810 `card_search_multi_board` scenario with its 199 extra
    boards. Measured p95 and budget, in ms: `board_list` 38.3 / 55, `board_full` 1227.5 / 1720,
    `card_search` 73.1 / 105, `card_search_multi_board` 85.2 / 120 (its first budget),
    `card_timeline` 40.1 / 60, `notifications_list` 38.5 / 55, `notifications_unread` 27.6 / 40.
    `card_search` fell from 155 to 105ms and the three light endpoints fell by 0-5ms. **`board_full`
    went up from 1695 to 1720ms:** this sample's p95 (1227.5ms) is above the previous
    derivation's (1210.5ms), so the #1800 backport does not show as a lowering on it. This is
    one run, and the two derivations ran on different runners (`runner-04-NUC` before), so
    it is not a clean before/after of the code. `card_search_multi_board` p95 was 85.2ms against 73.1ms for the one-board
    `card_search`; no `EXPLAIN` was run on this fixture, so the plan is still unconfirmed.

## The October 2026 `board_full` drift — #1800

**Verdict: a real regression, partly attributed and mitigated in code.** The evidence for it
is the local experiment below, not the CI history. Two parts:

- In a local 2x2 run, switching from psycopg2 to psycopg 3
  ([#1252](https://gitlab.com/visiban/visiban/-/issues/1252), merged 2026-10-04 at 10:47 EDT)
  added 11-12% to the `board_full` mean. The endpoint ran the same 17 queries and returned
  byte-identical JSON.
- Django ticket [#36960](https://code.djangoproject.com/ticket/36960) is the mechanism for
  the largest identified part of that cost.

A backport mitigates the parser part. [#1807](https://gitlab.com/visiban/visiban/-/issues/1807)
attributed the remainder of the driver step and fixed nothing further in Visiban code. One
in-app option is untried and tracked in [#1813](https://gitlab.com/visiban/visiban/-/issues/1813).
See [The remaining driver step](#the-remaining-driver-step-1807).

### What the scheduled runs show

The CI history is consistent with a step after #1252 but does not establish one on its own.
The data before Oct 5 is too noisy.

There were 25 completed scheduled `nightly-load-test` jobs between 2026-09-29 and 2026-10-20,
including 3 retried jobs on Sep 29-30 that a default job listing hides. Card count was 2388 in
every one. The jobs ran on `gitlab-runner-nuc-2-visiban` (12), `Runner-03-NUC` (11),
`gitlab-runner-dell-01-visiban` (1, Oct 8, before the `nuc` pin) and `runner-04-NUC` (1,
Oct 20). This table uses `board_full` p50, which is less noisy than p95. It covers all 23
NUC jobs from Sep 29 to Oct 19, split at the first run that included #1252 (Oct 5). It
leaves out the dell-01 job (different hardware class) and the runner-04 job (a single run,
after the #1723 fixture change).

| Runner | Before (Sep 29 to Oct 4, without #1252) | After (Oct 5 to Oct 19, with #1252) |
|---|---|---|
| `gitlab-runner-nuc-2-visiban` | 6 jobs: 910-1144ms, median 980ms | 6 jobs: 1074-1200ms, median 1128ms |
| `Runner-03-NUC` | 3 jobs: 944-1231ms, median 1180ms | 8 jobs: 1050-1326ms, median 1154ms |

Per job, before Oct 5 (job id, p50):

- `gitlab-runner-nuc-2-visiban`: 16796278537 1143.7ms (Sep 29, retried, where the lighter
  endpoints were also slow), 16796708105 959.1ms (Sep 29), 16825562214 1124.0ms (Sep 30,
  retried), 16854145294 995.5ms, 16885874829 910.5ms, 16918108892 965.1ms (Oct 1-4).
- `Runner-03-NUC`: 16796417688 1230.8ms (Sep 29, retried), 16826298383 1179.5ms (Sep 30),
  16909453148 943.6ms (Oct 3).

Four of the 9 NUC jobs before Oct 5 fall inside the "after" range, all of them on Sep 29-30.
The other 5 (one on Sep 29 and the 4 from Oct 1-4) were 910-996ms. On `gitlab-runner-nuc-2-visiban` the medians moved
from 980ms to 1128ms (+15%). On `Runner-03-NUC` they did not move: 1180ms before, 1154ms
after. A reader who sets Sep 29-30 aside sees a clean step, and one who keeps it does not.
That is why the verdict rests on the local measurement.

Between the last job without #1252 (Oct 4, `7dee839ca`) and the first job with it (Oct 5,
`724fbdd4b`), the job used the same `python:3.12-slim` image and the same job definition,
and neither the load-test script nor `seed_demo_data` changed. Two direct dependency bumps in
`backend/requirements.lock` account for every lock change between them:

- `psycopg2-binary` 2.9.11 became `psycopg` 3.3.6 plus `psycopg-binary` 3.3.6 (#1252).
- `mcp` 1.30.0 became 2.3.0 (#1253). Its transitive set changed with it:
  - `httpx` and `httpcore` were replaced by `httpx2` and `httpcore2`, and `httpx2-jsfetch`
    was added.
  - `mcp-types`, `opentelemetry-api` and `truststore` were added.
  - `httpx-sse`, `pydantic-settings` and `python-dotenv` were dropped.

The MCP SDK and its dependencies are not on the request path (`MCP_SERVER_ENABLED` is off in
the job, so the SDK is never imported). The `board_full` serializer change in the same window (#1077) only adds schema
`help_text`.

The 2026-10-12 failure (job 17100891040, p95 1650.7ms against the then-1430ms budget) was a
tail outlier. Its p50 was 1304ms, inside the post-Oct-5 range. The next two runs, on a commit
with no change to the board serializer, view or requirements, measured p95 1228ms and 1155ms.

### Root cause, measured

Django 5.2 parses every `timestamptz` value through
`django.db.backends.postgresql.psycopg_any.BaseTzLoader`. That class subclasses psycopg's
**pure-Python** `TimestamptzLoader`, so each datetime is parsed by a regex in Python, even
with `psycopg[binary]` installed. The C loader that package ships is never used. This is
Django ticket [#36960](https://code.djangoproject.com/ticket/36960), fixed upstream only in
Django 6.1 (commit `994fa77`). psycopg2 parsed these values in C. One `board_full` response
on the load-test board loads about 44,000 `timestamptz` values (cards, movements and the
other prefetched rows).

The cause was measured locally on a scale-20 fixture against PostgreSQL 17. It was not
inferred from the dates.

- **Same SQL, same payload.** Under both drivers the endpoint runs 17 queries and returns
  byte-identical JSON. A query-count guard cannot see this regression.
- **The driver accounts for the step.** A 2x2 run crossed pre-drift code (`7dee839ca`) and
  current code with each driver: 4 interleaved rounds of 40 requests each, `DEBUG=True` as
  in CI. Changing the driver added about 11-12% to the mean on either code base:
  622ms to 696ms on the old code, 630ms to 700ms on the current code. Changing the code
  under psycopg2 added about 1% (622ms to 630ms). p95 rose more than the mean (about 667ms
  to 839ms on the old code), which matches the ~25% p95 rise CI saw.
- **The Python timestamptz parser is the largest single identified part.** A profile of 5
  requests showed about 44,000 calls per request to `psycopg/types/datetime.py` `_load_iso`.
  In a micro-benchmark that loads 14,014 `timestamptz` values from the fixture, the
  per-value cost was about 1.5µs under psycopg 3 and 0.47µs under psycopg2. At 44,000
  values that comes to about 45ms per request, out of a 74ms mean step on the old code.
  #1800 did not attribute the rest of the driver difference.
  [#1807](https://gitlab.com/visiban/visiban/-/issues/1807) did. See
  [The remaining driver step](#the-remaining-driver-step-1807).

### The mitigation

`backend/visiban/db_psycopg.py` backports Django 6.1's change onto 5.2's `BaseTzLoader`. It
wraps the loader psycopg registers by default (the C one with `psycopg[binary]`) and then
re-applies the connection timezone exactly as Django did before. `boards.apps.BoardsConfig.ready()`
applies it. Results are byte-identical to psycopg2's for the whole `board_full` response.
With the backport in place:

- In the micro-benchmark, per-value loading drops from about 1.5µs to about 0.69µs
  (psycopg2: 0.47µs). At 44,000 values per response that saves about 36ms per request. The
  remaining 0.22µs per value is the Python wrapper and `.replace(tzinfo=...)`, which upstream
  Django 6.1 keeps too.
- End to end, a 3-arm run on current code (psycopg2, psycopg 3, psycopg 3 with the
  backport) was too noisy to resolve the effect well. It used 6 interleaved rounds of 30
  requests each, `DEBUG=True`, on a development machine. The median of the per-round means
  was 649ms, 722ms and 701ms. The median per-round saving from the backport was 35ms, against
  a median driver step of 98ms. Several individual rounds had the opposite sign, so read this
  only as agreeing with the micro-benchmark.
- `boards/tests/test_db_psycopg.py` pins the backport:
  - Values, tzinfo and errors must match Django's original `load`, captured from the
    unpatched class, for three session TimeZones and three Django timezones. The inputs
    include the overflow fallback, `infinity`, `-infinity` and BC values.
  - A real query on PostgreSQL must never call the Python ISO parser. That check fails
    without the backport.
  - The backport turns itself off on a Django that already has the upstream fix, and on a
    `BaseTzLoader` whose source no longer matches the reviewed fingerprint (logged as a
    warning).
- **Delete the module once the `Django` pin reaches 6.1.**

The backport removes roughly a third to a half of the driver step, not all of it. The
remainder is attributed in [the next section](#the-remaining-driver-step-1807). Expect
`board_full` to settle above its level without psycopg 3, not back at it. The committed budget
(1695ms) was derived from a run before this fix. [#1808](https://gitlab.com/visiban/visiban/-/issues/1808)
re-derived it from a NUC run that includes the fix (job 17348200339): measured p95 was 1227.5ms
and the budget is now 1720ms, higher than before, so the backport does not show as a lowering
on that single sample. Never hand-edit it.

### The remaining driver step — #1807

**Verdict: the remaining step comes from psycopg 3, from Django's timestamptz loader and from
the garbage collector's response to psycopg 3. Nothing further was fixed in Visiban code. One
in-app option is untried and tracked in
[#1813](https://gitlab.com/visiban/visiban/-/issues/1813).** With the backport in place,
psycopg 3 still made the local `board_full` mean about 45ms slower (7%). That is the median of
the four per-round differences against psycopg2, measured in the same round. The medians of the
per-round means in the table at the end of this section give a slightly larger 52ms (668ms
against 720ms), because a median of differences is not the difference of two medians. Every
step and part in this section is such a paired per-round median, and every absolute time is a
median of per-round means.

With the collector on, which is how CI runs, the 45ms splits by phase of the request:

| Part | Effect on the step | Where it comes from |
|---|---|---|
| Garbage-collector pauses | +40ms | The collector's response to psycopg 3's allocations, inferred to come mostly from the binding below |
| Django's per-value timestamptz wrapper (fetch phase) | +26ms | Django: 6.1 keeps the same wrapper |
| Client-side binding of the six prefetch `IN` lists (execute phase) | +5ms | psycopg 3 |
| Row loading in C, which is faster than psycopg2's (fetch phase, without the wrapper) | -22ms | psycopg 3 |
| Everything else in the request | -4ms | Not attributed further |

The parts add up to 45ms. Each one is the median of its own per-round differences, so in
general they add up only to within a millisecond or two.

With the collector off, the step was +26ms. The same split gives +27ms for the wrapper, +10ms
for the binding, -15ms for row loading and +4ms for everything else. That view helps isolate
CPU costs, but do not combine it with the one above. Turning the collector off is not the same
as removing its pauses: no reference cycle is freed, so the heap grows from request to request
and the other phases change too. That is why the binding costs 10ms there and 5ms with the
collector on, and why the step with the collector off (+26ms) plus the pauses (+40ms) is more
than the step with it on (+45ms).

- **Garbage-collector pauses (+40ms).** `gc.callbacks` measured 204ms of collector pauses per
  request under psycopg 3 and 161ms under psycopg2. Most of that is in the three full
  collections each request runs under both drivers: 179ms against 137ms. The C-loader arm below
  had the same pauses as the shipped arm, 1ms apart, so the wrapper is not the cause. Python
  starts a collection after a set number of container allocations. psycopg 3 runs add about
  29,000 of them per request: 418 young-generation collections against 377, at the default
  threshold of 700. The likely mechanism is that more allocations move the request's full
  collections to later points, when more of the board is in memory. That the extra
  allocations come from the placeholder parsing below is **inferred**, not isolated. The
  parsing creates objects per placeholder, both psycopg 3 arms show the same 418 collections,
  and the import footprint is ruled out below. But no arm removes the parsing on its own. The
  collector is a large share of this endpoint under either driver: 161ms of psycopg2's 668ms
  mean. A step made of collector timing moves with allocation patterns, so expect it to vary
  more between runs and runners than plain CPU time does.
- **The timestamptz wrapper (+26ms).** The backport delegates to psycopg's C loader and then
  calls `.replace(tzinfo=self.timezone)` on each value, exactly as Django 6.1 does. That is a
  Python call per value, about 43,800 per response. A counterfactual arm registered psycopg's C
  loader directly, with no Python wrapper. Its fetch phase was 26ms shorter than the shipped
  arm's (24.3ms against 50.7ms), and its whole request was 23ms shorter (per round +24, +27,
  +22, +14). In the request, the wrapper costs about 0.6µs per value, more than the 0.22µs the
  #1800 micro-benchmark measured in isolation.
- **Client-side binding (+5ms).** `prefetch_related` renders as
  `WHERE card_id IN (%s, %s, ...)`, with one placeholder per card. Six of the request's
  queries carry 2,388 or 2,389 placeholders each, 14,329 in total. Django's psycopg 3 backend
  binds parameters client-side (`ClientCursor`). psycopg 3 splits the query text on its
  placeholders in Python (`psycopg/_queries.py`, `_split_query`). That creates a regex match,
  a tuple and a `QueryPart` for every placeholder. psycopg caches the split only for queries of
  at most 4,096 bytes and 50 parameters (`MAX_CACHED_STATEMENT_LENGTH`,
  `MAX_CACHED_STATEMENT_PARAMS`), so these six are split again on every request. psycopg2
  did this in C. Composing one of them took about 2.5ms under psycopg 3 and 1.1ms under
  psycopg2, about 8ms over the six.
- **Row loading (-22ms).** Without the wrapper, psycopg 3's fetch phase was 22ms shorter than
  psycopg2's (24.3ms against 45.6ms). psycopg 3's C row loading is faster, and it absorbs most
  of the wrapper's cost.

Ruled out, each by measurement or by reading the path:

- **psycopg 3's import footprint.** psycopg 3 adds about 8,100 GC-tracked objects at startup,
  so it looked like a cause of the slower collections. A psycopg2 arm with psycopg 3
  imported, but not used, measured the same as plain psycopg2: 8ms faster with the collector
  on and 3ms faster with it off, both within noise.
- **Network and server time.** Replaying the request's `SELECT`s with their SQL already
  composed took 103.7ms under psycopg2 and 101.7ms under psycopg 3.
- **Other Python-side loaders.** Every other column type in the response (varchar, text,
  bool, int2, int4, int8, uuid, date, jsonb) loads through psycopg's C loaders. Django
  registers psycopg's `TextLoader` for jsonb, inet and cidr, and psycopg substitutes its C
  version for it.
- **Row factory.** Django uses psycopg 3's default tuple rows, built in C. They are faster
  than psycopg2's (above).
- **Server-side cursors.** Not used on this path. Django opens a named cursor only for
  chunked `.iterator()` reads, and `board_full` makes none.
- **Server-side binding.** Django's `OPTIONS["server_side_binding"]` would not help. psycopg's
  server-side `PostgresQuery` splits the query with the same `_split_query`, behind the same
  4,096-byte and 50-parameter cache limits as the client-side `PostgresClientQuery`
  (`psycopg/_queries.py`, the two `convert` methods).
- **Pipeline mode.** Django does not use it. Each prefetch query also needs the ids returned
  by the query before it, so the round trips could not be pipelined anyway.
- **The previous response staying in memory.** Each request's first full collection frees
  about 207,000 objects from the previous `board_full` response. The `@extend_schema`
  decorator on the `full` action passes its schema class through the view's init kwargs, and
  DRF's schema descriptor then stores each new view instance on that class. So the last view,
  its response and the serialized board stay referenced until the next request to the same
  action. Removing that reference did not change latency: the objects are reference cycles
  that only the collector frees in either case. It is the same under both drivers and is not
  part of this step. This is recorded as an observation only. No work on it is planned.

Why the parts are not fixed here:

- **The wrapper.** Registering psycopg's C loader directly returns the same values when the
  session TimeZone is UTC, which Django sets. It does not return the same values for the
  overflow fallback values that `boards/tests/test_db_psycopg.py` pins: Django relabels a
  fixed-offset fallback value with its own timezone, and the C loader keeps the offset. Django's
  `create_cursor` also reads `.timezone` from the registered loader class, which the C class
  does not have, so this would need a second patch to Django. Django 6.1 keeps the wrapper,
  so the change would depart from upstream instead of backporting it.
- **The binding.** Raising psycopg's cache limits would keep a parsed copy of each large query
  in memory for each distinct board size. Those would be long-lived objects for the collector
  to walk, so the change would add to its work instead of removing it. The real fix is to not
  send thousands of placeholders. Inside Django, that would mean one array parameter with
  `= ANY(%s)`, a change to how Django builds `prefetch_related` lookups. Visiban could also do
  it without a Django change: `board_full` loads a single board, so it could fetch each child
  relation filtered by the board and attach the rows to the cards itself. That would remove
  the `IN` lists under psycopg2 too. It is untried. The experiment is tracked in
  [#1813](https://gitlab.com/visiban/visiban/-/issues/1813).
- **The collector.** Tuning it is a process-wide change to every endpoint, not a driver
  change. As a data point, calling `gc.freeze()` after startup made each arm faster than the
  same arm with default settings in the same round: by about 53ms under psycopg2 (668ms to
  616ms in the table) and about 77ms under psycopg 3 (720ms to 646ms). It also shrank the
  psycopg 3 step from about 45ms to about 24ms (30ms from the table's medians). This is
  recorded as an observation only. No work on collector tuning is planned.

How it was measured, so it can be repeated:

- **Setup.** A throwaway `postgres:17-alpine` container (PostgreSQL 17.11). The fixture was
  seeded with `manage.py seed_demo_data --force --scale 20 --with-notifications` (2,395
  cards). The run used Python 3.12.6, Django 5.2.17, psycopg 3.3.6 with `psycopg-binary`, and
  psycopg2-binary 2.9.11, on a development machine. The measurement predates
  [#1810](https://gitlab.com/visiban/visiban/-/issues/1810), which adds 199 small boards to the
  nightly fixture and makes the cards table about 67% larger. To repeat it on the current
  nightly fixture, seed with `manage.py seed_demo_data --force --scale 20 --extra-boards 199
  --with-notifications`. The extra boards belong to `demo3` and are separate from the
  `board_full` board, but this measurement was not repeated on that fixture.
- **Requests.** Each request ran in-process through Django's test `Client`, with `demo2`'s PAT
  from `manage.py provision_fuzz_token` and `DEBUG=True` as in CI. That is 19 queries per
  request: the 17 the endpoint runs, plus the two token queries.
- **Arms.** Each arm ran in a fresh process. The psycopg2 arm sets `sys.modules["psycopg"] =
  None` before Django loads, so `psycopg_any` falls back to psycopg2. The C-loader arm
  replaces `psycopg_any.register_tzloader` to register psycopg's default timestamptz loader
  for UTC, and skips the `.timezone` check in `create_cursor`. It is a timing counterfactual,
  not a candidate fix. Its responses were byte-identical to the other arms' on this fixture.
- **Phases.** Phase times come from wrapping `django.db.backends.utils.CursorWrapper._execute`
  and its `fetchone`, `fetchmany` and `fetchall`. Collector time comes from `gc.callbacks`.
  "Collector off" means `gc.disable()` in that process. "`gc.freeze()`" means `gc.collect()`
  then `gc.freeze()` after Django loads, before the warm-up requests.
- **Rounds.** Four interleaved rounds. Each round ran every arm under each collector setting
  once, with 3 warm-up requests and 15 timed requests. The table gives the median of the four
  per-round means. The step column gives the median of the four differences against
  psycopg2 under the same collector setting in the same round. Phase times in the text are
  medians of per-round means too.

| Arm | Collector on: mean | Collector on: step | Collector off: mean | Collector off: step | `gc.freeze()`: mean | `gc.freeze()`: step |
|---|---|---|---|---|---|---|
| psycopg2 | 668ms | — | 491ms | — | 616ms | — |
| psycopg2, with psycopg 3 imported but not used | 659ms | -8ms | 489ms | -3ms | 618ms | -3ms |
| psycopg 3 with the backport | 720ms | +45ms | 517ms | +26ms | 646ms | +24ms |
| psycopg 3, C timestamptz loader with no wrapper (counterfactual) | 700ms | +22ms | 483ms | -7ms | 614ms | -5ms |

Per round, the psycopg 3 step was +45, +78, +44 and +36ms with the collector on, and +25, +27,
+25 and +28ms with it off. This was measured on a development machine, not a NUC runner.
The `board_full` budget was re-derived from a NUC run that includes #1800 in
[#1808](https://gitlab.com/visiban/visiban/-/issues/1808); see the note under "Re-deriving the baseline".

### What #1800 did not explain

- `card_search` (p50 about 80ms to 84-90ms over the same period, and 100.7ms on
  `runner-04-NUC`) and `notifications_unread` show no driver effect locally: psycopg2,
  psycopg 3 and psycopg 3 with the backport measured within noise of each other. Their
  smaller rise is not the timestamptz loader. Locally, `card_search` was also about 14%
  slower on current code than on `7dee839ca`, with the same queries on both. (Measured with
  token auth, as in the load test, that is 10 queries. The token lookup and the token
  `last_used_at` update account for the extra two.) That comparison spans two separately
  seeded databases and was not taken further here. #1805 explains these two, and also the
  `card_timeline` and `notifications_list` rises that the #1767 re-derivation absorbed. See
  [the #1805 section](#the-october-2026-card_search-and-notifications_unread-drift-1805) below.
- The job installs `backend/requirements.txt`, not the hash-pinned `requirements.lock`, and
  its `python:3.12-slim` and `postgres:17-alpine` images are floating tags. Transitive
  dependency and base-image versions can therefore change between two runs on the same
  commit. Those unpinned versions are not visible in the lock diff above, and this
  investigation did not rule them out from the CI data. The local measurement reproduces a
  step of the observed size from the driver alone. When attributing a future drift, check
  them.

## The October 2026 `card_search` and `notifications_unread` drift — #1805

**Verdict: three separate effects. One was a code regression, now fixed. One was a runner
change. The third is unattributed, sits inside the budget headroom, and was not pursued.**

1. **`card_search` on Oct 20 was a regression in the code.**
   [#1723](https://gitlab.com/visiban/visiban/-/issues/1723) rewrote the board access
   filter (merged Oct 19) and made the cross-board card query slower to *plan*. The
   query count and the payload stayed the same. #1805 fixes it in
   `CardQueryViewSet.get_queryset()`.
2. **All four light endpoints on Oct 20 ran on a different runner.** That run was the first
   scheduled run on `runner-04-NUC`. On endpoints whose code did not change, it measured 6-10%
   slower than the other two NUC runners. This is one sample.
3. **All four light endpoints stepped up 2-6% at p50 at the Oct 4/5 boundary**, on both
   NUC runners. That is 0.8-2.1ms on the three lightest and 3.2-4.4ms on `card_search`. It is
   the same boundary as the `board_full` step above. A local driver A/B did not reproduce
   it, so it is **unattributed**. It sits inside the 1.4x budget headroom and was not
   pursued.

`card_timeline` and `notifications_list`, which the #1767 re-derivation also moved up, rose
only through effects 2 and 3. The budgets were **not** re-derived here, because no NUC run
had measured the fix yet. [#1808](https://gitlab.com/visiban/visiban/-/issues/1808) then re-derived
them from job 17348200339: the `card_search` budget fell from 155 to 105ms against a NUC p95 of
73.1ms (about 57ms locally).

### What the scheduled runs show

This uses the same 25 scheduled jobs and the same per-runner p50 method as #1800 above. The
dell-01 job is excluded, and so is job 16796278537 (Sep 29, retried), where
`notifications_unread`, `notifications_list` and `card_timeline` were 50-60% slower than in
every other job. Each cell gives the median p50 across that runner's jobs:

| Endpoint | `gitlab-runner-nuc-2-visiban` before / after Oct 5 (5 / 6 jobs) | `Runner-03-NUC` before / after Oct 5 (3 / 8 jobs) | `runner-04-NUC` Oct 20 (1 job) |
|---|---|---|---|
| `card_search` | 81.0 / 84.2ms (+4%) | 80.3 / 84.7ms (+5%) | 100.7ms |
| `notifications_unread` | 23.8 / 24.9ms (+4%) | 24.5 / 25.8ms (+5%) | 28.1ms |
| `notifications_list` | 32.3 / 33.5ms (+4%) | 32.9 / 35.0ms (+6%) | 36.3ms |
| `card_timeline` | 32.3 / 33.1ms (+2%) | 32.5 / 34.4ms (+6%) | 36.7ms |

On the Oct 20 run, the light endpoints were above both other runners' post-Oct-5 medians
(84.2, 25.5, 34.3 and 33.5ms): `card_search` by 20%, `notifications_unread` by 10%,
`card_timeline` by 9% and `notifications_list` by 6%. `board_full` was not: 1136ms against a
1151ms median. That run is also the first after #1723 and #1721 merged (`37ad2d8e0` to
`b1f1cf76b`), so the CI data alone cannot separate the runner from the code. The local A/B
below does.

### `card_search`: the access-filter rewrite (#1723)

Measured locally on one scale-20 database (PostgreSQL 17, `DEBUG=True` and no
`CONN_MAX_AGE`, as in CI). The method was 6 interleaved rounds of 40 timed requests per
endpoint, with the servers for both commits running against that same database. This
answers the open question #1800 left: its 14% difference spanned two separately seeded
databases.

- **Only `card_search` moved.** From `37ad2d8e0` (Oct 19 run) to `b1f1cf76b` (Oct 20 run),
  the median per-round p50 went from 69.1ms to 77.6ms, slower in every round, and p95 went
  from 72.9ms to 106.7ms. `notifications_unread`, `notifications_list` and `card_timeline`
  were unchanged within 1ms. All four returned byte-identical JSON on both commits.
- **Same queries, slower planning.** Both commits ran 10 queries with token auth (8 without
  the token lookup and its `last_used_at` update). Only the main card SELECT
  got slower, 25ms to 33ms. `EXPLAIN ANALYZE` on that statement:
  - Execution: unchanged (15.2ms and 15.1ms).
  - Planning: 11-15ms before, 19-23ms after, in fresh and warm sessions alike.
- **Mechanism.** The view filters cards with `board_id__in=get_accessible_boards_queryset(user)`.
  Before #1723 that subquery was `SELECT DISTINCT ... LEFT JOIN board_memberships`. #1723
  replaced it with `owner = ... OR EXISTS(...)`. PostgreSQL pulls the subquery up into the
  card SELECT's 7-table join (cards, board, column, swimlane, two users, external ref). With
  the `OR EXISTS` form, the planner spends longer on that join than the executor spends
  running it. #1723's `Exists()` alone accounts for the rise (planning 19-20ms).
  [#1721](https://gitlab.com/visiban/visiban/-/issues/1721)'s role filter added nothing
  measurable.

**The fix.** `get_queryset()` now evaluates the accessible board ids as a list (one small
extra query) and passes the literal list to `board_id__in`. The access rule itself is
untouched: the same `get_accessible_boards_queryset()` decides which ids are in the list.
On the same statement:

| Access filter in the card SELECT | Planning | Execution |
|---|---|---|
| Subquery, before #1723 | 11-15ms | 15ms |
| Subquery, after #1723 | 19-23ms | 15ms |
| Literal list, 1 board (this fixture) | 4.5ms | 0.65ms |
| Literal list, 200 ids | 5ms | 13.5ms |
| Literal list, 20,000 ids | 15-17ms | 14-15ms |

With this fixture's single board, the planner can also walk `card_board_updated_idx` in
cursor order and stop at the 51st row instead of sorting every match. With 200 ids it went
back to the old scan-and-sort, at the old execution time. Even 20,000 ids plan faster than
the subquery did after #1723.

End to end, with all three servers on one database (6 interleaved rounds, median per-round
p50 / p95):

| Code | `card_search` p50 | `card_search` p95 |
|---|---|---|
| `37ad2d8e0` (before #1723) | 67.9ms | 85.8ms |
| `b1f1cf76b` (Oct 20 run) | 74.3ms | 106.8ms |
| `b1f1cf76b` with the #1805 fix | 48.0ms | 57.2ms |

The other three endpoints were unchanged within noise in all three arms. The response
was byte-identical, and the request now runs 11 queries instead of 10.
`CardQueryCountTests.test_access_filter_is_a_literal_id_list` in
`boards/tests/test_card_query.py` pins the shape. It fails if the card SELECT's `WHERE`
contains a `boards` or `board_memberships` subquery, or if the inlined ids are not exactly
the caller's accessible boards. `test_access_filter_is_a_literal_id_list_for_site_admin`
pins the same shape for a `can_access_all_content` user, whose list holds every board. Like
the #1800 regression, this one left the query count unchanged, so a query-count guard would
not have caught it.

**What the `card_search` scenario now measures, and what it does not.**

- **It measures only the single-board plan.** The scenario runs as `demo2`, who can access
  one board, so after the fix it times the single-board index walk on
  `card_board_updated_idx`. The plan most multi-board users get (scan and sort, 13.5ms
  execution at 200 ids in the table above) is not measured by this scenario. A budget derived
  from it cannot see a regression on that path.
- **`card_search_multi_board` measures the many-board plan.**
  [#1810](https://gitlab.com/visiban/visiban/-/issues/1810) added it: the same request as
  `card_search`, run as `demo3`, who owns 199 small extra boards (`--extra-boards 199`) and is a
  member of the load-test board, so the card SELECT filters on a 200-id literal list. Its
  budget is 120ms ([#1808](https://gitlab.com/visiban/visiban/-/issues/1808), from NUC job
  17348200339, measured p95 85.2ms). Do not hand-edit it.
- **It never exercised the trigram indexes.** Django's `icontains` renders as
  `UPPER(col) LIKE UPPER('%term%')`. The `card_title_trgm_idx` and `card_desc_trgm_idx`
  indexes from migration 0030 are on the bare columns, so PostgreSQL cannot use them for
  that expression:
  - Before the fix the plan is a sequential scan on `cards`.
  - After the fix it is the index walk above.
  - With a selective term and `enable_seqscan=off`, the planner picks `cards_board_id_*`
    and filters, still without the trigram indexes. They are used only by `ILIKE`, which
    no card query issues.

  Neither search site (`boards/views/cards.py` or `boards/views/card_query.py`) can use the
  indexes, yet they still cost a GIN update on every card write. This defect is tracked in
  [#1809](https://gitlab.com/visiban/visiban/-/issues/1809).

  So the scenario measures the access filter, the per-card serialization of one 51-row page,
  and the substring filter applied row by row.

### `runner-04-NUC`: one slower run

Locally, the `37ad2d8e0` to `b1f1cf76b` change did not move `notifications_unread`,
`notifications_list` or `card_timeline`. So their Oct 20 rise (6-10% over the other NUC
runners' medians, above) is not the code. `runner-04-NUC` is `nuc`-tagged and was correctly
eligible, but this was its first scheduled `nightly-load-test` run, and there is no second
sample yet. `card_search`'s 20% on that run fits both causes together: about 10% from #1723
and about 10% from the runner.

Do not treat `runner-04-NUC` as interchangeable with the other two NUC runners until more
runs land on it. When a budget fails on that runner, first compare its p50 with the other
runners' recent runs, as above. The current baseline was derived from this run, so its light
endpoint budgets carry the runner's extra 6-10%.

### The Oct 4/5 step on the light endpoints

All four light endpoints rose 2-6% (0.8-2.1ms at p50, 3.2-4.4ms on `card_search`) between the
Oct 4 run on `7dee839ca` and the runs from Oct 5 on, on both NUC runners. That is the
boundary where #1800 found the `board_full` step. Per #1800, the only lock changes in that
window are psycopg 3 (#1252) and the MCP SDK, and the MCP SDK is not imported in the job. The
settings changes in the window add no per-request work.

The driver does not reproduce it locally. On `b1f1cf76b`, with one database and 8
interleaved rounds, psycopg 3 was not slower than psycopg2 on any of these endpoints. On the
three lightest it was 1.4-2.2ms faster at p50, and `card_search` measured 77.5ms against
77.9ms. That commit predates #1800's backport, so psycopg 3 was still parsing `timestamptz`
in Python and was still not slower. psycopg2 was forced by shadowing the `psycopg` import,
so Django fell back to psycopg2 2.9.11. A new
connection per request (`CONN_MAX_AGE` unset) is part of both arms. The development machine
is macOS on arm64, while CI is `python:3.12-slim` on x86_64. This test does not cover a
platform-specific driver cost, nor the unpinned transitive dependencies and floating images
#1800 lists.

This step is therefore **unattributed**. It is 0.8-2.1ms per request on the three lightest
endpoints and 3.2-4.4ms on `card_search`, which is 2-6% and well inside the 1.4x budget factor,
so it was not pursued. If it grows, run the same driver A/B on a NUC runner rather than on a
development machine.

## Failure notifications

The scheduled run is blocking (not `allow_failure`), so a budget violation fails the pipeline.
GitLab emails every project maintainer who has "Failed pipeline" notifications enabled
(**Profile → Notifications → Global notification level → "Watch"**, or per-project under
**Project → Notification settings**) — the same mechanism the nightly CVE scan
(`backend-dep-scan` / `frontend-dep-scan`, on the separate Nightly schedule) already relies
on. The load test keeps its own schedule rather than joining that one because its latency
budgets are noisy on a busy runner — see [Scheduled pipelines](ci-gates.md#scheduled-pipelines).
