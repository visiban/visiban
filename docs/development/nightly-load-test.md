# A nightly job fails the pipeline when an endpoint gets slower
<a id="nightly-load-test"></a>

`nightly-load-test` is a nightly, schedule-only CI job (`.gitlab-ci.yml`). It measures real wall-clock p50/p95/p99 latency against a large seeded fixture and fails the pipeline if any covered endpoint exceeds its committed budget.

**Why it matters:** A query-count guard isn't a latency guard. `perf-check` (static N+1 review) and `perf-bench` (query counts on demand) both measure query *count*. A missing index, a data-volume change, or a query-plan flip can leave the query count and query text identical while making the same queries slower. Neither of those gates can see that class of regression; this job can.

**The default:** 40 timed requests per endpoint (after 5 warmup), p95 against a budget derived as `ceil(measured_p95_ms * 1.4 / 5) * 5`, on a `nuc`-tagged runner. See [Running it](#running-it) and [Budget derivation](#budget-derivation-the-rule).

**Watch out:** The schedule is GitLab configuration, not a file in this repo, and it was once silently missing (#1213). See [The schedule](#the-schedule).

!!! info "Where this came from"
    Filed as #1082 from a TruePPM audit finding: a real p95 regression (`GET /tasks/` at 3.3x baseline) was "fixed" by a query-count guard that its own description said couldn't detect that class of regression. The fix never touched the actual root cause, and the regression sat inside a budget loose enough to hide it. See the issue for the full postmortem.

## What it covers

| Endpoint | Path | Volume sensitivity |
|---|---|---|
| Board list | `GET /api/v1/boards/` | Run as the board owner (`demo1`) so the access query spans the 20-member board. Per-board member and card counts are independent correlated subqueries and the access filter no longer joins memberships (#1723). Budget 60ms ([#1767](https://gitlab.com/visiban/visiban/-/issues/1767)) |
| Board fetch | `GET /api/v1/boards/{id}/full/` | Serializes every card on the board, unpaginated — the single most volume-sensitive read in the product |
| Card search | `GET /api/v1/cards/?search=...` | The cross-board card query: access filter, a 51-row cursor page and a row-by-row substring filter. The substring filter uses the `ci_contains` lookup (`boards/lookups.py`), which renders `col ILIKE ...` on PostgreSQL so the `pg_trgm` GIN indexes from migration `0030_card_trigram_search_indexes` can serve it ([#1809](https://gitlab.com/visiban/visiban/-/issues/1809)); before that fix `icontains` rendered `UPPER(col) LIKE`, which they could not. On PostgreSQL 17 with 60k cards over 20 boards, the real query (`board_id IN (...)`, `ORDER BY updated_at DESC, id DESC`, `LIMIT 51`) plans a BitmapOr over both trigram indexes for a selective term (one run, laptop). The budget was re-derived from a NUC run and the broad and short terms re-measured in [#2063](https://gitlab.com/visiban/visiban/-/issues/2063); see [Card search plans](#card-search-plans-2063). The `card_search` scenario runs as a one-board user, so it measures only the single-board plan; `card_search_multi_board` runs the same request as `demo3`, who can access 200 boards ([#1810](https://gitlab.com/visiban/visiban/-/issues/1810); see [#1805](#the-october-2026-card_search-and-notifications_unread-drift-1805)) |
| Card search, many boards | `GET /api/v1/cards/?search=...` as `demo3` | The same query as above for a user with 200 accessible boards, which is expected to get PostgreSQL's scan-and-sort plan instead of the index walk (not confirmed on this fixture: no `EXPLAIN` was run). Budget 125ms, derived in [#1808](https://gitlab.com/visiban/visiban/-/issues/1808) |
| Card timeline | `GET /api/v1/boards/{board_id}/cards/{id}/timeline/` | Exercises the composite indexes added in migration `0045_add_activity_comment_composite_indexes`, and since [#2405](https://gitlab.com/visiban/visiban/-/issues/2405) the gate transitions the timeline merges in (a third source, [#2365](https://gitlab.com/visiban/visiban/-/issues/2365)). The load-test board's "Doing" stage has three sub-columns (two gates) and about two thirds of its active cards each have gate rows, some linked to the card's move and some not; the timeline returns only the unlinked ones as gate entries, so the script reads a card that passed at least two gates (every such card has an unlinked second-gate row) and fails when none did, so the scenario cannot quietly time the no-gate path. The committed `card_timeline` budget predates this: re-derive it from the next NUC run |
| Card timeline with counts | `GET /api/v1/boards/{board_id}/cards/{id}/timeline/?include_counts=true` (`card_timeline_counts`) | What the card detail sheet requests on every card open and every `card.version` change ([#967](https://gitlab.com/visiban/visiban/-/issues/967)): the same page plus the per-group count queries. Measured but not gated until a NUC run assigns its budget ([#2195](https://gitlab.com/visiban/visiban/-/issues/2195)) |
| Board movements history | `GET /api/v1/boards/{id}/movements/` (`board_movements`, `board_movements_deep`, `board_movements_dated`) | Board History: the first page, an offset three quarters into the history (derived from the first page's `count` at run time, so it stays deep when the fixture changes) and a page with `moved_after` set 30 days back. #1961 removed the window count and turned the date filter into a half-open datetime range; the query count stays 2 either way, so only latency can see it. Plans are in [Movements history plans](#movements-history-plans-2237). Measured but not gated until a NUC run assigns their budgets ([#2237](https://gitlab.com/visiban/visiban/-/issues/2237)) |
| Notifications list | `GET /api/v1/notifications/` | The highest-QPS authenticated endpoint in the product — the frontend polls it every 15-30s |
| Notifications unread count | `GET /api/v1/notifications/unread-count/` | Same polling cadence as the list endpoint |
| Summary and Analytics | `GET /api/v1/boards/{id}/summary/`, `GET /api/v1/boards/{id}/analytics/` | Both replay movement history in Python since [#448](https://gitlab.com/visiban/visiban/-/issues/448), for the cards relevant to their window: a query-count guard cannot see that cost. Gated since [#2110](https://gitlab.com/visiban/visiban/-/issues/2110) assigned their budgets from NUC job 18170442650 |
| Flow metrics | `GET /api/v1/boards/{id}/metrics/{cycle-time,throughput,cumulative-flow,wip-age,dwell,blocked,attention,swimlanes}/` | Each replays movement history in Python ([#448](https://gitlab.com/visiban/visiban/-/issues/448)). Since [#2425](https://gitlab.com/visiban/visiban/-/issues/2425) only the cards that can change the requested range are replayed (every live card, plus any card archived, created or moved since the range opened), so cost follows the board's live and recent work, not its age. `cumulative-flow` still places every older card, because finished work stays in the done band for ever, but since [#2444](https://gitlab.com/visiban/visiban/-/issues/2444) it reads only the at most three rows per card that decide where the card rests (the first row, the last transition, the last archive-type row), chosen in SQL, not the card's whole history. It still places every older card, so its cost grows with the number of archived cards: it is not bounded by the board's age. See [the #2444 section](#cumulative-flows-whole-history-read-2444). Gated since [#2110](https://gitlab.com/visiban/visiban/-/issues/2110) assigned their budgets from NUC job 18170442650 |
| Single-request overview | `GET /api/v1/boards/{id}/metrics/overview/?days=90&limit=300` (`flow_overview`, `aged_flow_overview`) | The one request the Analytics overview makes for its seven flow charts since [#2426](https://gitlab.com/visiban/visiban/-/issues/2426): one history load serves them all, where the seven `metrics/*` reads above each loaded their own copy. Sent with `?days=90&limit=300`, the overview's default range and its cap on each per-card list (`OVERVIEW_LIST_LIMIT`, `frontend/src/api/analyticsLimits.ts`, [#2429](https://gitlab.com/visiban/visiban/-/issues/2429); the self-test fails if the script's copy drifts). Measured but not gated until a NUC run assigns its budgets ([#2430](https://gitlab.com/visiban/visiban/-/issues/2430)); the merged #2426 notes pin its query count (12, flat in history), not a latency or memory figure, so none is quoted here |
| Aged-board reads | The summary, `analytics/?days=90&limit=300`, `analytics/?days=365` (uncapped), the eight `metrics/*` reads (uncapped) and `metrics/overview/?days=90&limit=300` on the aged board (`aged_board_summary`, `aged_board_analytics`, `aged_board_analytics_365`, `aged_flow_*`) | The same active cards as the load-test board plus years of archived history ([#2430](https://gitlab.com/visiban/visiban/-/issues/2430)). Analytics breaks on board *age*, not on the shape of the active board: in the 2026-11-20 stress run the same 2.4k active cards cost 8-10x more per `metrics/*` request with three years of archived cards behind them. `aged_flow_cumulative_flow` and `aged_flow_cumulative_flow_day` (`metrics/cumulative-flow/?date=`, a day 540 days back, the drill-down the overview does not send) measure the [#2444](https://gitlab.com/visiban/visiban/-/issues/2444) bound: both read at most three rows per card (four for a drill-down day), not its whole history, but both still place every card older than the range, so both grow with the archived card count. The MCP `board_flow_metrics` tool is not timed here; since [#2445](https://gitlab.com/visiban/visiban/-/issues/2445) it uses the same range-bounded load as `metrics/*`, pinned by `BoardFlowMetricsAgedTests` in `mcp_server/tests/test_mcp_flow.py`. Run as `loadtest_analytics`, 10 timed requests each (an aged request costs seconds), so its p95 is the slowest sample |
| Overview fan-out | Two reads fired together (the web app now sends them one after the other, #2428, so this is a stricter shape than the page), the set `useAnalyticsOverviewData` fires since [#2426](https://gitlab.com/visiban/visiban/-/issues/2426): `GET /api/v1/boards/{id}/metrics/overview/?days=90&limit=300` (`getFlowOverview`, `frontend/src/api/flowMetrics.ts`) and `GET /api/v1/boards/{id}/analytics/?days=90&limit=300` (`getBoardAnalytics`, `frontend/src/api/boards.ts`; never `summary`), `days=90` being the overview's default range (`DEFAULT_DAYS`; `analytics/` would otherwise default to 30 server side) and `limit=300` its cap on each per-card list (`OVERVIEW_LIST_LIMIT`, [#2429](https://gitlab.com/visiban/visiban/-/issues/2429)). `analytics_overview` on the load-test board and `aged_analytics_overview` on the aged board | What opening the analytics overview does to one server process. Before #2426 this was eight reads, each loading the board's history into the same process at once; the two-read set is what the page asks for now, and the standalone `metrics/*` scenarios still measure the individual endpoints. The sample is the wall time to the LAST response, never the sum, and the peak RSS is of the one process, where the per-request figures add up |
| Children view | `GET /api/v1/boards/{id}/children-view/` on the parent board (`children_view`) | Children mode's first page ([#2370](https://gitlab.com/visiban/visiban/-/issues/2370)): 500 parents over 5 lanes with 100 children each (the per-parent cap), 50,000 links, on "Visiban Load Test Children View Board" and its child board ([#2538](https://gitlab.com/visiban/visiban/-/issues/2538)). The endpoint recomputes every live link on the board per page with correlated subqueries, so a request is O(parents x children) and scrolling the board is that cost times the page count; the query-count tests cannot see it. p95 and peak RSS are measured with the aged iteration count. Measured but not gated until a NUC run assigns its budgets ([#2538](https://gitlab.com/visiban/visiban/-/issues/2538)); whether the per-page recompute should become per-lane or cached is that issue's open decision |
| Linked child board | `GET /api/v1/boards/{id}/full/` and `GET /api/v1/boards/{id}/cards/` on the linked board (`linked_board_full`, `linked_card_list`) | 500 cards, every one linked to a parent on one of 5 parent boards ([#2424](https://gitlab.com/visiban/visiban/-/issues/2424)), so `Card.parent`'s parent-board role batch runs. Query count and p95 are correlated, not equivalent; the query counts are in `perf-bench` (`FULL_LINKED_BUDGET`, `CARD_LIST_LINKED_BUDGET`), the latency is here |

This job is additive. `perf-check` and `perf-bench` are unchanged and still run where they already did. `perf-check`'s own description ([`.claude/agents/perf-check.md`](https://gitlab.com/visiban/visiban/-/blob/main/.claude/agents/perf-check.md)) now states the division of labor: a query-count guard doesn't satisfy a latency budget.

## Running it

```bash
python3 scripts/nightly_load_test.py \
    --base-url http://localhost:8000 \
    --token-file /tmp/visiban_load_test_token \
    --owner-token-file /tmp/visiban_load_test_owner_token \
    --multi-board-token-file /tmp/visiban_load_test_multi_board_token \
    --analytics-token-file /tmp/visiban_load_test_analytics_token \
    --server-pid-file /tmp/visiban_load_test_server.pid \
    --board-name "Visiban Load Test Board" \
    --budget-file backend/nightly-load-test-baseline.json \
    --iterations 40 --warmup 5 \
    --output nightly-load-test-results.json
```

The other flags shown are the script's defaults. The CI job provisions four tokens:

| Flag | User | Used for |
|---|---|---|
| `--token-file` | `demo2` (a plain member) | every scenario except `board_list`, `card_search_multi_board` and the 17 `--analytics-token-file` scenarios (`linked_*`, `children_view`, `aged_*`, `aged_analytics_overview`) |
| `--owner-token-file` | `demo1` (the board owner) | `board_list` alone |
| `--multi-board-token-file` | `demo3` (can access 200 boards) | `card_search_multi_board` alone |
| `--analytics-token-file` | `loadtest_analytics` (sole member of the aged, linked, parent and children-view boards) | the `aged_*`, `linked_*`, `children_view` and `aged_analytics_overview` scenarios ([#2430](https://gitlab.com/visiban/visiban/-/issues/2430), [#2424](https://gitlab.com/visiban/visiban/-/issues/2424)) |

`--analytics-token-file` is optional: without it the aged and linked scenarios are skipped, with a `NOTE` line, so a local run against a plain fixture still works. Once any of those 17 scenarios has a committed budget (p95 or peak memory) in the baseline, skipping them fails the run instead: a gate that measured nothing must not pass. While every such budget is pending, it stays a `NOTE`. CI always passes it, and the script fails before timing anything if the aged board has fewer than `--min-aged-archived` archived cards (default 1,000) or the linked board has fewer than `--min-linked-cards` cards (default 500) or any without a parent, or the children-view board's first page has no parent rows.

`--owner-token-file` and `--multi-board-token-file` have no default, and the script refuses to run without them. `board_list`'s 60ms budget was derived as the owner, whose access query spans all 20 memberships, so measuring it as `demo2` would compare a cheaper path against that budget and hide a regression. Measured as `demo2`, `card_search_multi_board` would time the one-board plan again and report a number that says nothing about the many-board plan.

**How it measures.**

- Per endpoint: 5 warmup requests (discarded), then 40 timed requests.
- Percentiles use nearest-rank (no interpolation), so every reported number was an actually-observed latency.
- The job fails (`sys.exit(1)`) if any endpoint's measured p95 exceeds its budget.
- It always writes the full per-endpoint results as a CI artifact (`nightly-load-test-results.json`, kept 90 days), pass or fail.
- The Django `runserver` output isn't written to the job log (a noisy run could hit GitLab's 16 MB log cap). It goes to the `nightly-load-test-server.log` artifact, which shares the results file's 90-day expiry and is restricted to developers. On failure the job log prints the last 200 lines of it.

**Self-test.** Like every bespoke gate script here, it ships `python scripts/nightly_load_test.py --self-test`. It proves the percentile calculation and budget-comparison logic still fire on a known-bad and known-good input, and CI runs it immediately before the real invocation (see [CI gate self-tests](ci-gates.md)). It fails if any scenario the script measures has no `budget_p95_ms` in the committed baseline, so a new scenario can't silently stay measure-only, unless the entry carries an explicit pending budget (below). The `nightly-load-test-selftest` member of `lint-selftests-python` runs it on merge requests that touch the script or the baseline.

### Peak memory

> **Added in 1.3** ([#2430](https://gitlab.com/visiban/visiban/-/issues/2430), which [#2110](https://gitlab.com/visiban/visiban/-/issues/2110) had also asked for).

Memory is what breaks first on the analytics endpoints: 186-691 MB for one request against a 512Mi pod, and 1.1-2.0 GB for one overview open. Latency alone cannot see it.

With `--server-pid-file`, the script reads the server process's peak resident set size around every scenario: it writes `5` to `/proc/<pid>/clear_refs` (which restarts `VmHWM` at the current RSS) before the scenario, and reads `VmHWM` and `VmRSS` after it. Each result carries `peak_rss_mb` (the high-water mark) and `rss_growth_mb` (that mark minus the RSS before the scenario). Linux only, same host as the server. On another platform, or when the script cannot write `/proc/<pid>/clear_refs` (unprivileged or read-only `/proc`), it prints a NOTE and skips memory measurement (`peak_rss_mb` and `rss_growth_mb` are left out of the results entirely, not written as null). Once any scenario has a committed `budget_peak_rss_mb`, memory measurement being off fails the run; with only pending memory budgets it stays a NOTE. If the file is given on Linux and the PID cannot be read, the run fails at startup rather than silently dropping the measurement.

- **The gated number is the absolute peak** (`budget_peak_rss_mb`), not the growth. It includes the server's baseline and what the scenarios before it left allocated, so the scenario order is part of the fixture: do not reorder `run()` without re-deriving. Python rarely hands heap back to the OS, so a delta would read near zero once an earlier scenario had grown the heap.
- **CI starts `runserver --noreload`** so `$!` is the server and not the reloader parent, and writes it to `VISIBAN_LOAD_TEST_SERVER_PID_FILE`. The job runs with `DEBUG=True`, which keeps every query in memory, so these numbers are higher than a production pod's; the budget is derived on the same setting, so it still moves with the code.
- **The budget rule is the p95 one**: `budget_peak_rss_mb = ceil(measured_peak_rss_mb * 1.4 / 5) * 5`, from a NUC run, never by hand.
- **A memory budget can be pending on its own**: `"budget_peak_rss_mb": null` with `"pending_memory_budget": "#NNNN"`. It behaves like a pending p95 budget (measured, loud, never a failure), and the self-test requires one or the other for every scenario in `_MEMORY_GATED`.

### Pending budgets

A budget may only come from a NUC run, so a new scenario can land before its budget can. For that case a baseline entry may set `"budget_p95_ms": null` together with `"pending_budget": "#NNNN"`, the issue that will assign the budget. The script then:

- measures the scenario and records it in the results artifact, with `budget_pending` in its entry, so the NUC run needed to derive the budget produces its number;
- prints `PENDING BUDGET: <name> is measured but NOT gated until #NNNN assigns its budget.` next to the scenario, a `WARNING: PENDING BUDGET` line on stderr at the end, and says "(N pending, NOT gated: ...)" in its final line, every run;
- never fails the job on it.

It isn't a silent default. The self-test fails a scenario whose budget is null without a valid `#NNNN` reference, or with no baseline entry at all, and asserts that a pending scenario can never produce a violation.

- When the issue assigns the budget, replace `budget_p95_ms` and delete `pending_budget` in the same whole-file re-derivation.
- Pending now, from [#2430](https://gitlab.com/visiban/visiban/-/issues/2430) and [#2424](https://gitlab.com/visiban/visiban/-/issues/2424): every new scenario (`aged_*`, `linked_*`, `flow_overview`, `analytics_overview`, `aged_analytics_overview`) has no p95 budget, and every flow, summary, analytics and aged scenario has no memory budget, because none has been measured on a NUC runner. They all cite #2430, which therefore stays open until the NUC run derives them; the `suppressions-check` job fails the day it is closed with any new scenario still pending a p95 budget. It scans `pending_memory_budget` as well (on entries whose `budget_peak_rss_mb` is null), so the memory-only entries on the existing flow scenarios are tracked too and fail the day #2430 closes.
- Pending from [#2538](https://gitlab.com/visiban/visiban/-/issues/2538): `children_view` (p95 and peak RSS). The `card_timeline` and `card_timeline_counts` numbers predate the gate rows ([#2405](https://gitlab.com/visiban/visiban/-/issues/2405)); `card_timeline_counts` is still pending under #2195 and both are re-derived from the next NUC run.
- Pending before that: `card_timeline_counts` until [#2195](https://gitlab.com/visiban/visiban/-/issues/2195), and `board_movements`, `board_movements_deep` and `board_movements_dated` until [#2237](https://gitlab.com/visiban/visiban/-/issues/2237). All four were added after the last NUC run, so the next NUC run on `main` produces their numbers; re-derive the whole file from it.
- The flow, summary and analytics scenarios ([#2110](https://gitlab.com/visiban/visiban/-/issues/2110)) and `card_list` and `cards_archived` ([#2237](https://gitlab.com/visiban/visiban/-/issues/2237)) got their budgets from NUC job 18170442650 (the 2026-11-19 scheduled run on `main`). That derivation records p95 latency only: peak replay memory for the flow scenarios, also asked for in #2110, was not recorded then; the script now measures it (see above) and those memory budgets are pending.
- The first scenario to use this was `card_search_multi_board` ([#1810](https://gitlab.com/visiban/visiban/-/issues/1810) added the scenario), which got its budget in [#1808](https://gitlab.com/visiban/visiban/-/issues/1808).
- The `suppressions-check` CI job fails, naming the entry and the issue, if the cited issue closes while the entry is still pending ([#1812](https://gitlab.com/visiban/visiban/-/issues/1812); see [Suppression markers](suppressions.md#what-ci-enforces)).

## Exit run: absolute bars for the Analytics beta exit — #2588

The Analytics beta exit needs a one-off stress run that checks **absolute bars**, not ratios to a baseline (decision on [#2559](https://gitlab.com/visiban/visiban/-/issues/2559): no stored placements; the 1.5x ratio is replaced by absolute bars). The scheduled nightly cannot do that: it serves with `runserver` and `DEBUG=True`, which keeps a query log in memory and inflates RSS, and no budget run times `unread-count` while overviews open. The exit run is a manual mode of the same job; **the scheduled nightly is unchanged** (runserver, `DEBUG=True`, the committed budgets), and the exit-run bars are never added to `backend/nightly-load-test-baseline.json` and use no `pending_budget`.

Start it from CI/CD → Run pipeline (or the job's manual button) with these variables:

| Variable | Value for the exit run | Meaning |
|---|---|---|
| `LOAD_TEST_EXIT_RUN` | `true` | Serves with `daphne -b 0.0.0.0 -p 8000 visiban.asgi:application` and `DEBUG=False`, as production does, then runs `scripts/nightly_load_test.py --exit-run` instead of the budget run and the email-login plan check. Default `false`. |
| `LOAD_TEST_SERVER` | leave at `runserver`, or `daphne` | Exit-run only. `daphne` is accepted only together with `LOAD_TEST_EXIT_RUN=true`, which serves with daphne anyway; `LOAD_TEST_SERVER=daphne` without it fails the job at once, before the seed (see below). Default `runserver`. |
| `LOAD_TEST_AGED_GENERATIONS` | `12` | 3 years of history. Set by whoever starts the run; the job's default (`4`) is not changed. The run fails its fixture check below 12. |
| `LOAD_TEST_SCALE` | `100` | About 12k active cards ([#2451](https://gitlab.com/visiban/visiban/-/issues/2451)'s fixture). Set by whoever starts the run; the default stays `20`. The run fails its fixture check below 11,000 active cards. |
| `LOAD_TEST_EXIT_MAX_CONCURRENT` | `1` (default) | The server's `ANALYTICS_MAX_CONCURRENT` during the exit run: the shipped default, not the nightly's `2`, because the over-cap bar is about the real cap ([#2428](https://gitlab.com/visiban/visiban/-/issues/2428)). |
| `LOAD_TEST_EXIT_CONCURRENT_OPENS` | `8` (default) | N: how many `metrics/overview/` opens are fired together on the aged board, one per distinct user. Must exceed the cap plus the server's 4 waiters (5 at the default cap), or the over-cap check fails. |
| `LOAD_TEST_EXIT_ROUNDS` | `3` (default) | How many times that burst is repeated. |

The server is started as a plain `daphne` command with `DEBUG` and `ANALYTICS_MAX_CONCURRENT` as per-command variables (no `sh -c`, no subshell), so `$!` written to `--server-pid-file` is the daphne process itself and the VmHWM the script reads is the server's, not a wrapper's. With `DEBUG=False`, `settings.py` refuses a localhost `CORS_ALLOWED_ORIGINS` (its default is `http://localhost:5173`), so the job passes `CORS_ALLOWED_ORIGINS=https://loadtest.invalid` to daphne; the load test sends no `Origin`. Settings were loaded under the job's environment with `DEBUG=False` and nothing else raised (only a `DEFAULT_FROM_EMAIL` placeholder warning). If daphne does not answer liveness within 30 seconds, the job fails at once and prints the server log tail. `DEBUG=False` also lowers the DRF throttles (`user` 5000/hour, `card_query` 120/min instead of 9999), so the concurrent scenario polls `unread-count` about 4 times a second, and a 429 there is recorded as that check's failure. **The budget run is never run under daphne**: it would go through those throttles and likely get 429s, and its budgets are derived on runserver with `DEBUG=True`. That is why `LOAD_TEST_SERVER=daphne` without `LOAD_TEST_EXIT_RUN=true` fails the job. Reading RSS needs Linux `/proc` on the same host, as for the budget run.

**Burst users.** The server admits analytics requests through two limits (`backend/boards/services/analytics_admission.py`): each user may have 2 requests running or waiting (`PER_USER_MAX_IN_FLIGHT`), and the process runs `ANALYTICS_MAX_CONCURRENT` at once with up to 4 more waiting up to 8 seconds (`MAX_WAITERS`, `REST_WAIT_SECONDS`). The per-user limit is checked first, so N opens from one user are refused by it whatever the cap is. In exit-run mode the job therefore creates `LOAD_TEST_EXIT_CONCURRENT_OPENS` plain members of the aged board (`loadtest_exit_01`, `loadtest_exit_02`, ..., unusable passwords, created after the seed so no budget scenario's data changes), mints one token for each into `VISIBAN_LOAD_TEST_EXIT_BURST_TOKEN_DIR`, and the script fires each open as a different one of them, after confirming through `auth/user/` that the tokens belong to that many distinct users. The script mirrors the two server limits as constants, and `--self-test` fails if `analytics_admission.py` changes either.

### The bars

`--exit-run` records pass/fail for each check, prints them, writes `nightly-load-test-exit-run.json` (a job artifact), and exits 1 if any fails. A check whose request is refused or fails (for example `analytics_too_large` on `analytics/?days=365`, which can legitimately happen at `LOAD_TEST_SCALE=100` with 12 generations) is recorded as failed with that reason, the other checks still run, and the artifact is always written. The run needs `--token-file` (demo2) as well as the analytics token: `unread-count` is timed as demo2, the only seeded user with notifications (loadtest_analytics has none, so it would time a near-empty query), while the single-request checks run as loadtest_analytics and the burst as the burst users. The `unread-count` p95 bar needs at least 20 samples (`EXIT_MIN_UNREAD_SAMPLES`) and fails below that. The container memory limit is the named constant `CONTAINER_MEMORY_LIMIT_MB` (512) in the script; change it there. The artifact records the fixture (the declared `LOAD_TEST_SCALE` and `LOAD_TEST_AGED_GENERATIONS`, and the active and archived card counts read off the board), the burst's user count, and the count of each response kind.

| Check | Bar | Source |
|---|---|---|
| The fixture: active cards (`boards/{id}/full/`) and generations (archived cards from `cards/archived/`, divided by active cards: each generation copies every active card once) | at least 11,000 active cards and at least 12 generations | [#2588](https://gitlab.com/visiban/visiban/-/issues/2588), [#2451](https://gitlab.com/visiban/visiban/-/issues/2451) |
| `metrics/cumulative-flow/` p95 on the aged board | under 3 s | [#2425](https://gitlab.com/visiban/visiban/-/issues/2425), [#2444](https://gitlab.com/visiban/visiban/-/issues/2444) |
| `metrics/cumulative-flow/?date=` drill-down, peak RSS | under 512 MB (the container limit) | [#2444](https://gitlab.com/visiban/visiban/-/issues/2444) |
| One `metrics/overview/` open, peak RSS | under 512 MB | [#2426](https://gitlab.com/visiban/visiban/-/issues/2426) |
| `analytics/?days=365`, RSS growth and time | under 150 MB and under 3 s | [#2451](https://gitlab.com/visiban/visiban/-/issues/2451) |
| Overview payload | under 1 MB | |
| `notifications/unread-count/` p95 while N overview opens run (as demo2, at least 20 samples) | under 100 ms | [#2428](https://gitlab.com/visiban/visiban/-/issues/2428) |
| Peak RSS during those concurrent opens | under 512 MB | [#2428](https://gitlab.com/visiban/visiban/-/issues/2428) |
| Over-cap requests | N exceeds the cap plus 4 waiters and every open is a distinct user; each response is 200, `503 analytics_busy` with `Retry-After`, or `422 analytics_too_large`; none stalls (60 s); at least one was refused; no round admitted more than the cap plus 4 (5 at the default cap); the server still answers afterward (no OOM) | [#2428](https://gitlab.com/visiban/visiban/-/issues/2428) |

The fixture floor is 11,000 active cards, not 12,000: `seed_demo_data` gives each of `LOAD_TEST_SCALE` x 10 swimlanes 11 to 13 cards at random, so `LOAD_TEST_SCALE=100` is 11,000 to 13,000 active cards, about 12,000 on average, and a 12,000 floor could fail the fixture #2451 names. 11,000 is what scale 100 guarantees; the scheduled nightly's fixture (about 2,400 active cards, 4 generations) fails it, so a run started with only `LOAD_TEST_EXIT_RUN=true` can never report every bar met.

**What the over-cap check proves, and what it does not.** With one open per distinct user, the per-user limit cannot refuse anything, so a refusal comes from the process-wide admission: the cap and its waiting room. With N above the cap plus 4 waiters, a refusal is forced on every round if the cap is applied, and the check fails if no open is refused (the cap was never exercised) or if a round admitted more than the cap plus 4 (the cap was not applied). The bound assumes a round's opens all reach the server while its first admitted open is still running; on the aged board one overview open takes far longer than starting N threads, but if opens were fast enough to finish before the rest arrived, a correct server could admit more and fail the check. It does not prove the cap is exactly `ANALYTICS_MAX_CONCURRENT=1` rather than a slightly higher value: when an open takes longer than the 8 s wait, the waiters time out, so a cap of 1 admits 1 open a round and a cap of 2 admits 2, and both are inside the bound of 5. In the concurrent scenario a `503 analytics_busy` or `422 analytics_too_large` is an **expected** response, counted in the artifact's `responses`, never an error; any other status is `unexpected` and fails the over-cap check. The `unread-count` p95 and RSS are reported either way. A value that could not be measured fails its bar.

The script's `--self-test` (run first by the job) covers the pass/fail logic: each bar failing at its boundary, a missing value, the fixture check (the scheduled nightly's fixture, one card short and one generation short each fail; the floor passes), the response classification, each over-cap failure mode (including a one-user burst, whose per-user refusals are not accepted as proof of the cap, an every-open-admitted burst, a round admitting more than the cap plus 4, and a burst too narrow to force a refusal), the sample-count guard, a refused measurement recorded as a failed check with the others still running, and the mirrored admission limits against `analytics_admission.py`. It also runs the real measurement class (`_ExitOps`) against recording stubs and asserts which endpoint each measurement requests (`metrics/cumulative-flow/`, the `?date=` drill-down, `metrics/overview/`, `analytics/?days=365`, the two fixture reads) and which figure it returns: the peak RSS for the drill-down, the overview open and the burst, the RSS growth for `analytics/?days=365`. It starts no server, so the HTTP, `/proc` and CI wiring around those classes is not covered by it. **Neither the daphne path, the burst-user setup, nor any figure here has been run yet; nothing is verified until the first run on the NUC runner.**

Out of scope here: re-deriving the budgets ([#2430](https://gitlab.com/visiban/visiban/-/issues/2430)) and any change to flow-metric semantics (ADR [#1532](https://gitlab.com/visiban/visiban/-/issues/1532)).

## Email login: a plan check, not a latency scenario

> **Added in 1.3** (#1298).

`user_email_upper_idx` (#1222) serves the `email__iexact` lookup that `resolve_login_user` runs on every email login. #1222's own test uses a 1-row table with `enable_seqscan = off`, which proves the index is usable, not that the planner picks it at a real size. A latency scenario can't cover it: a successful login is two password hashes (hundreds of ms), which hide the 2-3 ms a sequential scan costs at 20k users.

So the `nightly-load-test` job ends with `scripts/check_email_login_plan.py --users 20000`. It tops the users table up to 20,000 rows and runs `ANALYZE` (after every latency scenario, so the extra users cannot move a budget), runs the real `resolve_login_user` with an email whose case differs from the stored one, captures the SQL it issues, and `EXPLAIN`s that statement with default planner settings. It fails unless the plan names `user_email_upper_idx` and has no sequential scan on `users`. A lookup rewritten to `LOWER` or `icontains` is what gets planned, because the SQL is captured, not copied. `--self-test` (run in the `nightly-load-test-selftest` member of `lint-selftests-python` and before the real run) proves the verdict fires on a seq-scan plan and passes an index plan.

Verified locally on PostgreSQL 17.11 with 20,000 users: with the index the plan is `Index Scan using user_email_upper_idx` (`resolve_login_user` p50 0.74ms, p95 1.41ms over 100 calls); with the index dropped it is `Seq Scan on users` (p50 4.27ms, p95 5.32ms) and the script exits 1.

## Movements history plans — #2237

Local run, PostgreSQL 17.11, the nightly fixture (`seed_demo_data --force --scale 20 --extra-boards 199 --with-notifications`): 24,919 movements on the load-test board, dated 2026-08-25 to 2026-11-16, 7,265 of them in the last 30 days. `EXPLAIN (ANALYZE, BUFFERS)` on the statements the endpoint issues. The index these plans name, `movement_board_moved_idx`, was `(board_id, moved_at DESC)`, the `(board, -moved_at)` index #1961 refers to. Migration 0117 dropped it (#2408); see the tie-break section below.

| Request | Page query | Bare `COUNT` |
|---|---|---|
| First page | `Index Scan using movement_board_moved_idx`, `Index Cond: (board_id = 1)`, stops at 50 rows: 0.55ms execution, 380 buffer hits | `Seq Scan` on `card_movements`, `Filter: board_id = 1`, 24,919 rows: 2.5ms |
| Deep offset (18,650) | Same index scan, but it walks 18,700 index entries and joins each to the card and the other tables, then discards 18,650: 30.7ms execution, 26,088 buffer hits | Same seq scan: 2.7ms |
| `moved_after` 30 days back | Same index scan with `Index Cond: ((board_id = 1) AND (moved_at >= '2026-10-20 00:00:00+00'))`, stops at 50 rows: 0.42ms | `Bitmap Heap Scan` through `card_movements_moved_at_ad79ac03` (`moved_at >= ...`), 7,885 rows: 1.5ms |

- **The index serves the datetime-range filter.** The range sits in the `Index Cond` together with `board_id`, which is what the old `moved_at__date__gte` cast could not do (#1961).
- **Offset cost is linear in the offset.** Deep pages cost 55 times the first page (30.7ms against 0.55ms) because the joins run before the offset is discarded. A page 18,650 rows in is unusual for a person, but a client that pages through everything pays it for every page.
- **The bare `COUNT` is a full scan of the board's movements.** With one board in the table the planner is right to seq scan (every row matches); on a table of many boards it would use the index. It grows with the board's history, not with the filter, except when a date range is set.
- **The probe for rows with no `board`** (`board IS NULL AND card IS NOT NULL`, kept for rolling upgrades) is an index scan on the same index and takes 0.02ms.
- The ordering in this table is `moved_at` alone, as it was when it was measured. [#2400](https://gitlab.com/visiban/visiban/-/issues/2400) changed it; see the next section.

### Tie-break ordering — #2400

The seed writes many movements at the same instant, and so do bulk moves and imports. With `moved_at` as the only sort key, rows that tie have no defined order, so two page reads can return one row twice and skip another. The endpoint now orders by `moved_at DESC, id DESC`, and the card `/timeline/` breaks its ties on `id` the same way.

`movement_board_moved_idx` ends at `moved_at`, so it cannot hand rows back in the new order by itself. Local run, PostgreSQL 17.11, the dev stack's largest board copied 50 times inside a transaction that was rolled back (24,225 movements, copies landing in groups that share one instant), the endpoint's page query with its six `LEFT JOIN`s:

| Request | `(board_id, moved_at DESC)` only | With `movement_board_moved_id_idx` `(board_id, moved_at DESC, id DESC)` |
|---|---|---|
| First page | `Index Scan using movement_board_moved_idx`, then `Incremental Sort` (`Presorted Key: m.moved_at`) above the joins, stops after 70 rows: 0.51ms | `Index Scan using movement_board_moved_id_idx`, no sort, stops at 50 rows: 0.56ms |
| Deep offset (18,650) | Same, but the `Incremental Sort` sorts 276 groups of joined rows: 60.7ms, against 20.9ms for the old `moved_at`-only order on the same data | Plain index scan over 18,700 entries: 22.3ms |
| `moved_after` 30 days back | `Incremental Sort` above the index scan: 0.39ms | Plain index scan with the range in the `Index Cond`: 0.29ms |

- **The tie-break needs its own index.** Without it the first page stays cheap, because the sort stops at the first full group, but a deep page costs about three times the old order. Migration 0116 builds `movement_board_moved_id_idx` concurrently, and the plan is a plain index scan again with no sort node.
- **`movement_board_moved_idx` was a prefix of the new index, and migration 0117 drops it** (#2408). The plans above that name it were measured before the drop. The new index has `board_id` first and `moved_at DESC` second, so it covers every access path the old one served. A spot check on the dev database (PostgreSQL, 475 movements on the largest board, so plan shape only, not timings) created the new index and dropped the old one in a transaction that was rolled back: the first-page query, the `moved_after` range query and `DELETE ... WHERE board_id IN (...)` (with sequential and bitmap scans disabled for the delete, since the table is tiny) all chose `Index Scan using movement_board_moved_id_idx` with `board_id` in the `Index Cond`.
- The table above is a one-off probe on synthetic ties, not the nightly fixture, so its absolute numbers are not comparable with the #2237 table. The `board_movements*` scenarios are still `pending_budget`, so the next NUC re-derivation measures the new order.

These are laptop numbers. They show the plans, not budgets: the budgets come from a NUC run.

## Card search plans — #2063

Local run, PostgreSQL 17.11, the nightly fixture (3,987 cards on 200 boards, not the 60k rows #2063 quotes). The statement is the endpoint's own (`board_id IN (...)`, `ORDER BY updated_at DESC, id DESC`, `LIMIT 51`), captured from the view.

| Viewer and term | Plan | Execution |
|---|---|---|
| `demo2` (one board), `the` or `a` | `Index Scan using card_board_updated_idx`, `Index Cond: (board_id = 1)`, `Filter: ... ~~* '%the%'`; stops after 52 rows, then an `Incremental Sort` | 0.9ms |
| `demo2`, `zq` (no match) | `Index Scan using cards_board_id_e67672f3`, filter on both `ILIKE`s, `Rows Removed by Filter: 2395` | 5.0ms |
| `demo2`, `Q3 roadmap` (selective, no match) | `BitmapOr` of `card_title_trgm_idx` and `card_desc_trgm_idx`, then `Bitmap Heap Scan` | 0.18ms |
| `demo3` (200 boards), `the` or `a` | `Seq Scan on cards` (3,980 rows, `board_id = ANY (...)`), top-N heapsort | scans every row |
| `demo3`, `zq` | `Seq Scan on cards`, 3,987 rows removed | scans every row |
| `demo3`, `Q3 roadmap` | `BitmapOr` of both trigram indexes | index lookup only |

- **A broad term is not slower for the one-board viewer.** The index walk in `updated_at` order finds 51 matches in 52 rows. The only slow case there is a term that matches nothing and isn't selective enough for the trigram indexes (`zq`, two characters, 5ms).
- **The many-board viewer scans the table for any broad term.** This is the scan-and-sort plan #1805 expected for that viewer, and the `card_search_multi_board` scenario times it. This run did not compare it with a pre-#1809 build.
- **`ILIKE` against `UPPER(col) LIKE UPPER('%term%')`, per row.** Forcing a sequential scan (`enable_indexscan` and `enable_bitmapscan` off) over all 3,987 cards for `the`: median execution 7.3ms for `ILIKE`, 6.7ms for the old form, 7 runs each, about 8% more per row. That does not reproduce the 184ms against 112ms #2063 saw on 60k rows (64% more). The fixture here is 15 times smaller, so a per-row cost that shows only at scale, or at 60k's cache behavior, is not ruled out by this run. The 60k-row broad-term question is still open in [#2063](https://gitlab.com/visiban/visiban/-/issues/2063).
- **The `card_search` budget is unchanged at 105ms.** It was re-derived from NUC job 18170442650 (measured p95 73.2ms against 73.1ms before), so `ILIKE` and the trigram indexes did not move the one-board number.

## Pooled connections

> **Added in 1.3** (#1958).

The nightly job runs unpooled: `DATABASE_POOL` is unset and so is `CONN_MAX_AGE`, so every request opens its own PostgreSQL connection. The latency budgets therefore do not exercise the [connection pool](../administration/configuration.md#database-connection-pool). To measure the pooled path, run the load test against a backend started with `DATABASE_POOL=true` (and, if needed, `DATABASE_POOL_MAX_SIZE`) in its environment. No pooled run has been recorded yet (tracked in #2035, along with a saturation check, pgBouncer and the default decision), so the budgets make no claim about it.

## The fixture

The job seeds a dedicated, larger board, never the real demo board:

```bash
cd backend
python manage.py seed_demo_data --force --scale 20 --extra-boards 199 --with-notifications \
    --aged-generations 4 --linked-boards
```

The large fixture is regenerated fresh in an ephemeral CI database on every run and is never committed anywhere.

- **`--scale 20`** replicates the demo board's 10-swimlane layout 20 times: **200 swimlanes, ~2,400 cards** (11-13 cards per swimlane, same distribution `seed_demo_data` always uses; see its docstring). The board is named **"Visiban Load Test Board"**, distinct from `"Visiban Demo Board"`, so this job can never collide with or overwrite the manual `seed-demo-data` job's data, in CI or on the shared demo environment.
- **20 members** on that board: the 5 demo users plus 15 `loadtest*` filler accounts with unusable passwords (`--scale > 1` only). Members x cards made the board list's count annotations expensive (two multi-valued joins multiplying, #1723), and a 5-member fixture couldn't expose it.
    - `GET /api/v1/boards/` now computes `member_count` / `card_count` / `archived_card_count` as independent correlated subqueries, and the access filter uses an `EXISTS` membership predicate rather than a join, so the members x cards row blow-up is gone.
    - The job times that endpoint as the `board_list` scenario, as the board owner (`demo1`, via `--owner-token-file`) so the 20 memberships are on the measured path. `card_search_multi_board` runs as `demo3`; every other scenario still runs as `demo2`.
    - It has a committed budget in `backend/nightly-load-test-baseline.json` (added by [#1767](https://gitlab.com/visiban/visiban/-/issues/1767)).
- **`--extra-boards 199`** ([#1810](https://gitlab.com/visiban/visiban/-/issues/1810)) adds 199 small boards ("Visiban Load Test Extra Board 001" and on; one swimlane and 8 cards each, 1,592 cards) owned by `demo3`. With the load-test board, `demo3` can access **200 boards**, the many-board side of the card query's plan switch.
    - The boards belong to `demo3` alone, so the `demo1` `board_list` scenario and every `demo2` scenario can see the same boards as before.
    - The `cards` table does grow by about 67% (about 3,980 cards in total), so those scenarios are expected, not proven, to be unaffected. [#1808](https://gitlab.com/visiban/visiban/-/issues/1808) re-derived the whole file from the first NUC run with this fixture (job 17348200339).
    - The job's `LOAD_TEST_EXTRA_BOARDS` variable sets the count. The script fails before timing anything if `demo3` can access fewer than `--min-multi-boards` boards (default 50). The CI job passes `LOAD_TEST_EXTRA_BOARDS + 1`, so a seed that silently shrinks fails.
    - The baseline's `fixture` block records `extra_board_count` and `multi_board_accessible_boards`.
- **`--aged-generations N`** ([#2430](https://gitlab.com/visiban/visiban/-/issues/2430)) seeds a SEPARATE board, "Visiban Load Test Aged Board": the same shape as the load-test board (about 2,400 active cards) plus `N` archived generations. Generation `g` is every active card copied with its movements shifted `90 * g` days back and archived at that point, so 4 is about a year of history (about 12k cards, 125k movements) and 12 is about three years (the stress run's size, 31k cards, 323k movements). `LOAD_TEST_AGED_GENERATIONS` sets it in CI (4, to keep the job short; raise it in a manual run to see the cliff). A separate board, because adding history to the load-test board would silently change every committed budget derived without it. Requires `--scale > 1`. Seeding takes about as long as the load-test board itself, since the copies are bulk-inserted.
- **`--linked-boards`** ([#2424](https://gitlab.com/visiban/visiban/-/issues/2424)) seeds 5 parent boards (`cards_can_have_children` on, 5 cards each) and "Visiban Load Test Linked Board", a 500-card child board where every card has a parent: 20 children per parent, spread across the 5 parent boards. The links are bulk-written but only between boards that satisfy `link_allowed` and under `CHILDREN_PER_PARENT_LIMIT`. Requires `--scale > 1`.
- **`--linked-boards` also seeds the children-view fixture** ([#2538](https://gitlab.com/visiban/visiban/-/issues/2538)): "Visiban Load Test Children View Board" (parent tier, 500 parents over 5 lanes) and "Visiban Load Test Children View Child Board" (50,000 children, 100 per parent, spread across the five columns). That adds about 50,000 cards, so the existing gated scenarios' budgets may move for the same reason as the aged fixture, expected and not proven.
- **Gate rows** ([#2405](https://gitlab.com/visiban/visiban/-/issues/2405)) are seeded on the load-test board itself when `--scale > 1`: sub-columns "Build", "Test" and "Ready" on the "Doing" stage, `gates_passed` 0, 1 or 2 in rotation across its active cards, `pass` rows (the first linked to the card's move into the stage, the rest not) and a `reopen` row on some two-gate cards. Deterministic and bulk-written, so the seeded random stream is untouched. The aged and linked boards have none. The sub-columns make `flow_metrics._gate_last_index` non-empty on this board, which turns on the gate-history query and the work/wait split (`_attach_wait`) for every scenario that loads the board's flow: `board_summary` (when its 30-day completion load selects a card), `board_analytics` (the heatmap's dwell load) and the committed-budget `flow_cycle_time`, `flow_throughput`, `flow_cumulative_flow`, `flow_wip_age`, `flow_dwell`, `flow_blocked`, `flow_attention` and `flow_swimlanes`, plus the pending `flow_overview` and `analytics_overview`; `card_timeline` also runs its own gate query. Those committed budgets were derived without gate rows and may be re-derived from the first NUC run that includes them. The sub-columns also change the `/full/` payload (`columns__sub_columns` is prefetched, and about two thirds of the "Doing" cards carry a nonzero `gates_passed`), so the `board_full` and `card_list` budgets predate that too.
- **The aged, linked and parent boards belong to `loadtest_analytics`, and to nobody else.** `card_search` filters on the viewer's accessible board ids, so giving `demo2` or `demo3` access would change a gated plan. One account with its own token leaves what viewers can see unchanged. Row counts still grow when the aged fixture is on (`cards` from about 4k to about 16.5k, movements about 5x; the linked fixture adds about 525 more cards and the children-view fixture about 50,500 (500 parents plus 500 x 100 children), so about 67.5k with `--linked-boards`), which can shift query plans and timings for the existing gated scenarios, so their budgets may move: expected, not proven (as with [#1810](https://gitlab.com/visiban/visiban/-/issues/1810)). The isolation is about board *access* (memberships and ownership), not authorship: `demo1`-`demo5` are still the assignees and creators of the aged board's cards, and archived copies inherit the assignee. No scenario filters by assignee or author, and a test pins this so a change is deliberate. **Known limit:** the aged copy carries movements only. Block history (`CardBlock`, read by `metrics/blocked/`) is not copied and `blocked_at` / `due_date` on copies are not shifted, so `aged_flow_blocked` is not an aged-history measurement. The user has an unusable password, like the filler accounts.
- **Deep movement history.** With `--scale > 1`, every card that has moved off the first column also gets 10 extra back-and-forth moves right after creation, so cards carry ~12-16 lifetime movements. Card-serving reads must not scale with that history ([#1883](https://gitlab.com/visiban/visiban/-/issues/1883)); a regression to loading every movement per card is invisible to query-count guards but shows up here as latency. The extra moves predate the real stage transitions, so each card's current column and `last_moved_at` are unchanged.
- **`--with-notifications`** seeds 60 unread `Notification` rows for the `demo2` user. That is more than the 50-row cap `NotificationListView` applies (`NotificationUnreadCountView` is uncapped and counts all 60), so the job exercises the same "more unread than the cap" path a busy real inbox hits.
- **A fixture size with no stated card/swimlane count is meaningless**: a p95 is only interpretable next to its data volume. `nightly-load-test-results.json` (the job's artifact) records the actual card and swimlane count with the timings, and `backend/nightly-load-test-baseline.json` records what the committed budgets were derived against.

### VACUUM ANALYZE after the seed

After the seed and token provisioning, and before the server starts, the job runs `VACUUM ANALYZE` once ([#2518](https://gitlab.com/visiban/visiban/-/issues/2518)). Since [#2430](https://gitlab.com/visiban/visiban/-/issues/2430) the seed bulk-inserts about 100k more movements (the aged board) immediately before measuring. On a freshly built CI Postgres, nothing guarantees autovacuum has caught up, so the measurement can overlap autovacuum, run on stale planner statistics, and run without a visibility map (no index-only scans). All eight `flow_*` p95 budgets went red on `main` after that change. Production databases are autovacuumed, so measuring after a vacuum is more representative and deterministic, not more lenient. No budget changed. The step fails the job if it fails. Whether this fully explains the regression is unproven until the manual `nightly-load-test` job comes back green on it.

## Auth

The job reuses `manage.py provision_fuzz_token` (already used by `backend-schema-fuzz`) to mint a scoped, non-admin Personal Access Token for `demo2`. It writes the token to a CI-only file (`VISIBAN_LOAD_TEST_TOKEN_FILE`, mode `0600`, never logged). No credential is hardcoded anywhere in the job or the script, following the same "no hardcoded credentials" rule as every other backend job in `.gitlab-ci.yml`.

- **`--set-random-password`** is the same flag the schema-fuzz jobs use ([#1607](https://gitlab.com/visiban/visiban/-/issues/1607)). `demo2` is seeded with no usable password, and a password change revokes every token. The flag gives `demo2` a random password that's never recorded, so the password-change routes require a current password and no request can revoke the job's token mid-run. The flag is off by default, and the command is for throwaway CI databases like this job's only.
- **Third token:** the job provisions one for `demo3` (`VISIBAN_LOAD_TEST_MULTI_BOARD_TOKEN_FILE`) the same way, used by `card_search_multi_board` alone.

## The schedule

Configure once in GitLab: **CI/CD → Schedules → New schedule**

- Target branch: `main`
- Cron: `0 0 * * *`, timezone `America/New_York` (daily at midnight Eastern, 04:00 UTC during daylight time and 05:00 UTC in winter; schedule 4463581)
- Variables: `LOAD_TEST_SCHEDULE=true`

The job can be run manually at any time, via "Run pipeline" or the job's manual play button. The manual path is advisory (`allow_failure: true`); the scheduled run is blocking.

!!! warning "This step is easy to skip silently — #1213"
    This is GitLab project configuration, not a file in this repo, so nothing in a diff or a
    review catches it being missed. It *was* missed: the schedule above was never created
    after this job merged, and the gap sat undetected until #1213 found it, by which point a
    real ~40% p95 regression on `GET /boards/{id}/full/` had already shipped past it. The
    `schedule-config-check` job (`scripts/check-pipeline-schedules.sh`) now asserts this
    schedule (and every other `$CI_PIPELINE_SOURCE == "schedule" && $VAR == "true"` rule in
    `.gitlab-ci.yml`) has an active GitLab schedule setting its variable, on every
    scheduled pipeline run. See [CI gate self-tests](ci-gates.md).

## Failure notifications

The scheduled run is blocking (not `allow_failure`), so a budget violation fails the pipeline. GitLab emails every project maintainer who has "Failed pipeline" notifications enabled (**Profile → Notifications → Global notification level → "Watch"**, or per-project under **Project → Notification settings**). The nightly CVE scan (`backend-dep-scan` / `frontend-dep-scan`, on the separate Nightly schedule) relies on the same mechanism.

The load test keeps its own schedule rather than joining that one because its latency budgets are noisy on a busy runner. See [Scheduled pipelines](ci-gates.md#scheduled-pipelines).

## Budget derivation — the rule

**Budgets are committed to the repo, in `backend/nightly-load-test-baseline.json`, and every `budget_p95_ms` must trace to a `measured_p95_ms` via a stated formula — never a round number picked because it looked reasonable.** TruePPM's postmortem is explicit about why: its 2000ms budget was loose enough that a 2x regression (683-851ms baseline &rarr; 1330ms) sat inside it without ever firing.

The formula this repo uses:

```
budget_p95_ms = ceil(measured_p95_ms * 1.4 / 5) * 5
```

- **1.4x** is the midpoint of the 1.3-1.5x range #1082 specifies. It's tight enough that a meaningful regression still trips the budget, and loose enough to absorb ordinary CI-runner noise between runs.
- **Rounding up to the nearest 5ms** gives the comparison a small amount of headroom for measurement jitter. The number is still fully determined by the measured baseline, just not reported to sub-millisecond precision.

!!! warning "Budgets are only valid on NUC runners"
    Budgets are absolute milliseconds, so they only hold on the hardware they were measured
    on. The current baseline (job 18170442650, main @ f863f39ff, 2026-11-19) ran on `gitlab-runner-nuc-2-visiban`; earlier ones ran on `runner-04-NUC` (job 17304593759, #1767) and `gitlab-runner-nuc-2-visiban` (job 16796708105, #1233), and the job is
    pinned with `tags: [nuc]` (see [CI Runners](../maintainers/ci-runners.md)). Before the
    pin, the 2026-10-08 scheduled run landed on `gitlab-runner-dell-01-visiban` and failed
    `card_timeline`, `notifications_list` and `notifications_unread` by 1.3-1.8x with no
    relevant code change, while every NUC run before it had passed. When re-deriving, take
    the artifact from a NUC run, and re-derive the whole file if the runner class ever
    changes.

### Re-deriving the baseline (do this at every release, and whenever the fixture size changes)

1. Trigger the `nightly-load-test` job (wait for the schedule, or run it manually).
2. Download its `nightly-load-test-results.json` artifact.
3. For each endpoint, recompute `budget_p95_ms` from that run's `p95_ms` using the formula above.
4. Update `backend/nightly-load-test-baseline.json`'s `measured_p95_ms`, `measured_p99_ms`, and `budget_p95_ms` fields (and, for an entry with a `pending_budget` key, delete that key once its budget is set), its top-level `measured_at`, and its `fixture` block if the fixture size changed. Recompute the whole file in one pass. Never hand-adjust a single `budget_p95_ms` without also updating the `measured_p95_ms` it supposedly came from.
5. For every scenario with a `pending_memory_budget` key, set `budget_peak_rss_mb = ceil(peak_rss_mb * 1.4 / 5) * 5` from the same artifact and delete that key. The first NUC run with the aged and linked boards ([#2430](https://gitlab.com/visiban/visiban/-/issues/2430), [#2424](https://gitlab.com/visiban/visiban/-/issues/2424)) is also what assigns the new scenarios' first p95 budgets; a budget that would fail today because of an open fix ([#2444](https://gitlab.com/visiban/visiban/-/issues/2444), [#2426](https://gitlab.com/visiban/visiban/-/issues/2426), [#2427](https://gitlab.com/visiban/visiban/-/issues/2427)) stays pending against that issue rather than being loosened. Only then close #2430. The `suppressions-check` job now scans `pending_memory_budget` too, so a leftover key blocks the day #2430 closes; this step is still the one that clears it.
6. Flip `status` from `"provisional"` to `"ci-derived"` the first time this is done from a real scheduled pipeline run (see the note below).

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
    the `board_full` rise to the psycopg 3 migration and mitigated it with a backport
    ([drift](#the-october-2026-board_full-drift-1800)); [#1807](https://gitlab.com/visiban/visiban/-/issues/1807)
    attributed the rest ([remaining step](#the-remaining-driver-step-1807)). The other rises
    were investigated in [#1805](https://gitlab.com/visiban/visiban/-/issues/1805)
    ([drift](#the-october-2026-card_search-and-notifications_unread-drift-1805)). The previous derivation ran
    on `gitlab-runner-nuc-2-visiban`; both are NUC-class (`nuc`-tagged) runners, so the file was re-derived as a whole rather than patched.

!!! note "Re-derived after the #1800, #1805 and #1810 changes — #1808"
    The whole file was re-derived on 2026-10-21 from job 17348200339 (pipeline 2971900609, a
    manual run of the nightly schedule on `main` at `58a4299b5`, on
    `gitlab-runner-nuc-2-visiban`, tag `nuc`). It's the first NUC run with the #1800 backport,
    the #1805 card filter and the #1810 `card_search_multi_board` scenario with its 199 extra
    boards. Measured p95 and budget, in ms: `board_list` 38.3 / 55, `board_full` 1227.5 / 1720,
    `card_search` 73.1 / 105, `card_search_multi_board` 85.2 / 120 (its first budget),
    `card_timeline` 40.1 / 60, `notifications_list` 38.5 / 55, `notifications_unread` 27.6 / 40.
    `card_search` fell from 155 to 105ms and the three light endpoints fell by 0-5ms. **`board_full`
    went up from 1695 to 1720ms:** this sample's p95 (1227.5ms) is above the previous
    derivation's (1210.5ms), so the #1800 backport doesn't show as a lowering on it. This is
    one run, and the two derivations ran on different runners (`runner-04-NUC` before), so
    it isn't a clean before/after of the code. `card_search_multi_board` p95 was 85.2ms against 73.1ms for the one-board
    `card_search`; no `EXPLAIN` was run on this fixture, so the plan is still unconfirmed.

!!! note "Whole file re-derived on 2026-11-19 — #2195, #2237, #1298, #2110, #2063"
    The whole file was re-derived on 2026-11-19 from job 18170442650 (the scheduled run on
    `main` at `f863f39ff`, on `gitlab-runner-nuc-2-visiban`, tag `nuc`). The flow, summary and
    analytics scenarios (#2110) and `card_list`/`cards_archived` (#2237) got their first
    budgets. `board_full` measured 824.5ms against 1227.5ms in the previous derivation, so its
    budget fell from 1720 to 1155ms; `card_search_multi_board` measured 89.1ms and went from 120
    to 125ms. The two derivations differ in commit and date, so the change is not attributed.
    `card_timeline_counts` (#2195) and the three `board_movements` scenarios (#2237) postdate the
    run and stay ungated (`pending_budget`) until the next re-derivation. The email login plan
    check (#1298) is not a latency scenario and has no budget.

## The October 2026 `board_full` drift — #1800

**Verdict: a real regression, partly attributed and mitigated in code.** The evidence is the local experiment below, not the CI history. Two parts:

- In a local 2x2 run, switching from psycopg2 to psycopg 3 ([#1252](https://gitlab.com/visiban/visiban/-/issues/1252), merged 2026-10-04 at 10:47 EDT) added 11-12% to the `board_full` mean. The endpoint ran the same 17 queries and returned byte-identical JSON.
- Django ticket [#36960](https://code.djangoproject.com/ticket/36960) is the mechanism for the largest identified part of that cost.

A backport mitigates the parser part. [#1807](https://gitlab.com/visiban/visiban/-/issues/1807) attributed the rest and fixed nothing further in Visiban code; one in-app option is untried ([#1813](https://gitlab.com/visiban/visiban/-/issues/1813)). See [The remaining driver step](#the-remaining-driver-step-1807).

### What the scheduled runs show

The CI history is consistent with a step after #1252 but doesn't establish one on its own. The data before Oct 5 is too noisy.

There were 25 completed scheduled `nightly-load-test` jobs between 2026-09-29 and 2026-10-20, including 3 retried jobs on Sep 29-30 that a default job listing hides. Card count was 2388 in every one. The jobs ran on:

- `gitlab-runner-nuc-2-visiban` (12),
- `Runner-03-NUC` (11),
- `gitlab-runner-dell-01-visiban` (1, Oct 8, before the `nuc` pin),
- `runner-04-NUC` (1, Oct 20).

The table uses `board_full` p50, which is less noisy than p95. It covers all 23 NUC jobs from Sep 29 to Oct 19, split at the first run that included #1252 (Oct 5). It leaves out the dell-01 job (different hardware class) and the runner-04 job (a single run, after the #1723 fixture change).

| Runner | Before (Sep 29 to Oct 4, without #1252) | After (Oct 5 to Oct 19, with #1252) |
|---|---|---|
| `gitlab-runner-nuc-2-visiban` | 6 jobs: 910-1144ms, median 980ms | 6 jobs: 1074-1200ms, median 1128ms |
| `Runner-03-NUC` | 3 jobs: 944-1231ms, median 1180ms | 8 jobs: 1050-1326ms, median 1154ms |

Per job, before Oct 5 (job id, p50):

- `gitlab-runner-nuc-2-visiban`: 16796278537 1143.7ms (Sep 29, retried, where the lighter endpoints were slow), 16796708105 959.1ms (Sep 29), 16825562214 1124.0ms (Sep 30, retried), 16854145294 995.5ms, 16885874829 910.5ms, 16918108892 965.1ms (Oct 1-4).
- `Runner-03-NUC`: 16796417688 1230.8ms (Sep 29, retried), 16826298383 1179.5ms (Sep 30), 16909453148 943.6ms (Oct 3).

Four of the 9 NUC jobs before Oct 5 fall inside the "after" range, all of them on Sep 29-30. The other 5 (one on Sep 29 and the 4 from Oct 1-4) were 910-996ms.

- On `gitlab-runner-nuc-2-visiban` the medians moved from 980ms to 1128ms (+15%).
- On `Runner-03-NUC` they didn't move: 1180ms before, 1154ms after.
- A reader who sets Sep 29-30 aside sees a clean step, and one who keeps it doesn't. That is why the verdict rests on the local measurement.

Between the last job without #1252 (Oct 4, `7dee839ca`) and the first job with it (Oct 5, `724fbdd4b`), the job used the same `python:3.12-slim` image and the same job definition, and neither the load-test script nor `seed_demo_data` changed. Two direct dependency bumps in `backend/requirements.lock` account for every lock change between them:

- `psycopg2-binary` 2.9.11 became `psycopg` 3.3.6 plus `psycopg-binary` 3.3.6 (#1252).
- `mcp` 1.30.0 became 2.3.0 (#1253). Its transitive set changed with it:
  - `httpx` and `httpcore` were replaced by `httpx2` and `httpcore2`, and `httpx2-jsfetch` was added.
  - `mcp-types`, `opentelemetry-api` and `truststore` were added.
  - `httpx-sse`, `pydantic-settings` and `python-dotenv` were dropped.

The MCP SDK and its dependencies aren't on the request path (`MCP_SERVER_ENABLED` is off in the job, so the SDK is never imported). The `board_full` serializer change in the same window (#1077) only adds schema `help_text`.

The 2026-10-12 failure (job 17100891040, p95 1650.7ms against the then-1430ms budget) was a tail outlier. Its p50 was 1304ms, inside the post-Oct-5 range. The next two runs, on a commit with no change to the board serializer, view or requirements, measured p95 1228ms and 1155ms.

### Root cause, measured

Django 5.2 parses every `timestamptz` value through `django.db.backends.postgresql.psycopg_any.BaseTzLoader`. That class subclasses psycopg's **pure-Python** `TimestamptzLoader`, so each datetime is parsed by a regex in Python, even with `psycopg[binary]` installed. The C loader that package ships is never used.

- This is Django ticket [#36960](https://code.djangoproject.com/ticket/36960), fixed upstream only in Django 6.1 (commit `994fa77`).
- psycopg2 parsed these values in C.
- One `board_full` response on the load-test board loads about 44,000 `timestamptz` values (cards, movements and the other prefetched rows). *(Measured before #1883, when every card's full movement history was loaded; `board_full` no longer loads movement rows, so the current figure is lower. The full re-measure is tracked in #2039.)*

The cause was measured locally on a scale-20 fixture against PostgreSQL 17, not inferred from the dates.

- **Same SQL, same payload.** Under both drivers the endpoint runs 17 queries and returns byte-identical JSON. A query-count guard can't see this regression.
- **The driver accounts for the step.** A 2x2 run crossed pre-drift code (`7dee839ca`) and current code with each driver: 4 interleaved rounds of 40 requests each, `DEBUG=True` as in CI. Changing the driver added about 11-12% to the mean on either code base: 622ms to 696ms on the old code, 630ms to 700ms on the current code. Changing the code under psycopg2 added about 1% (622ms to 630ms). p95 rose more than the mean (about 667ms to 839ms on the old code), which matches the ~25% p95 rise CI saw.
- **The Python timestamptz parser is the largest single identified part.** A profile of 5 requests showed about 44,000 calls per request to `psycopg/types/datetime.py` `_load_iso`. In a micro-benchmark that loads 14,014 `timestamptz` values from the fixture, the per-value cost was about 1.5µs under psycopg 3 and 0.47µs under psycopg2. At 44,000 values that comes to about 45ms per request, out of a 74ms mean step on the old code. #1800 didn't attribute the rest of the driver difference. [#1807](https://gitlab.com/visiban/visiban/-/issues/1807) did. See [The remaining driver step](#the-remaining-driver-step-1807).

### The mitigation

`backend/visiban/db_psycopg.py` backports Django 6.1's change onto 5.2's `BaseTzLoader`. It wraps the loader psycopg registers by default (the C one with `psycopg[binary]`) and then re-applies the connection timezone exactly as Django did before. `boards.apps.BoardsConfig.ready()` applies it. Results are byte-identical to psycopg2's for the whole `board_full` response. With the backport in place:

- In the micro-benchmark, per-value loading drops from about 1.5µs to about 0.69µs (psycopg2: 0.47µs). At 44,000 values per response that saves about 36ms per request. The remaining 0.22µs per value is the Python wrapper and `.replace(tzinfo=...)`, which upstream Django 6.1 keeps too.
- End to end, a 3-arm run on current code (psycopg2, psycopg 3, psycopg 3 with the backport) was too noisy to resolve the effect well. It used 6 interleaved rounds of 30 requests each, `DEBUG=True`, on a development machine. The median of the per-round means was 649ms, 722ms and 701ms. The median per-round saving from the backport was 35ms, against a median driver step of 98ms. Several individual rounds had the opposite sign, so read this only as agreeing with the micro-benchmark.
- `boards/tests/test_db_psycopg.py` pins the backport:
  - Values, tzinfo and errors must match Django's original `load`, captured from the unpatched class, for three session TimeZones and three Django timezones. The inputs include the overflow fallback, `infinity`, `-infinity` and BC values.
  - A real query on PostgreSQL must never call the Python ISO parser. That check fails without the backport.
  - The backport turns itself off on a Django that already has the upstream fix, and on a `BaseTzLoader` whose source no longer matches the reviewed fingerprint (logged as a warning).
- **Delete the module once the `Django` pin reaches 6.1.**

The backport removes roughly a third to a half of the driver step, not all of it. The remainder is attributed in [the next section](#the-remaining-driver-step-1807). Expect `board_full` to settle above its level without psycopg 3, not back at it.

The committed budget (1695ms) was derived from a run before this fix. [#1808](https://gitlab.com/visiban/visiban/-/issues/1808) re-derived it from a NUC run that includes the fix (job 17348200339): measured p95 was 1227.5ms and the budget was then 1720ms, higher than before, so the backport doesn't show as a lowering on that single sample. The 2026-11-19 re-derivation (job 18170442650) measured 824.5ms and set it to 1155ms. Never hand-edit it.

### The remaining driver step — #1807

**Verdict: the remaining step comes from psycopg 3, from Django's timestamptz loader and from the garbage collector's response to psycopg 3. Nothing further was fixed in Visiban code. One in-app option is untried and tracked in [#1813](https://gitlab.com/visiban/visiban/-/issues/1813).**

With the backport in place, psycopg 3 still made the local `board_full` mean about 45ms slower (7%): the median of the four per-round differences against psycopg2. The medians of the per-round means in the table at the end of this section give a larger 52ms (668ms against 720ms), because a median of differences isn't the difference of two medians. Every step and part here is a paired per-round median; every absolute time is a median of per-round means.

With the collector on, which is how CI runs, the 45ms splits by phase of the request:

| Part | Effect on the step | Where it comes from |
|---|---|---|
| Garbage-collector pauses | +40ms | The collector's response to psycopg 3's allocations, inferred to come mostly from the binding below |
| Django's per-value timestamptz wrapper (fetch phase) | +26ms | Django: 6.1 keeps the same wrapper |
| Client-side binding of the six prefetch `IN` lists (execute phase) | +5ms | psycopg 3 |
| Row loading in C, which is faster than psycopg2's (fetch phase, without the wrapper) | -22ms | psycopg 3 |
| Everything else in the request | -4ms | Not attributed further |

The parts add up to 45ms. Each one is the median of its own per-round differences, so in general they add up only to within a millisecond or two.

With the collector off, the step was +26ms. The same split gives +27ms for the wrapper, +10ms for the binding, -15ms for row loading and +4ms for everything else.

**Watch out:** Don't combine the collector-off view with the one above. Turning the collector off isn't the same as removing its pauses: no reference cycle is freed, so the heap grows from request to request and the other phases change too. That is why the binding costs 10ms there and 5ms with the collector on, and why the step with the collector off (+26ms) plus the pauses (+40ms) is more than the step with it on (+45ms). The off view only helps isolate CPU costs.

- **Garbage-collector pauses (+40ms).** `gc.callbacks` measured 204ms of collector pauses per request under psycopg 3 and 161ms under psycopg2. Most of that's in the three full collections each request runs under both drivers: 179ms against 137ms.
  - The C-loader arm below had the same pauses as the shipped arm, 1ms apart, so the wrapper isn't the cause.
  - Python starts a collection after a set number of container allocations. psycopg 3 adds about 29,000 per request: 418 young-generation collections against 377, at the default threshold of 700. More allocations likely move the full collections to later points, when more of the board is in memory.
  - That the extra allocations come from the placeholder parsing below is **inferred**, not isolated: the parsing creates objects per placeholder, both psycopg 3 arms show the same 418 collections, and the import footprint is ruled out below. But no arm removes the parsing on its own.
  - The collector is 161ms of psycopg2's 668ms mean. A step made of collector timing varies more between runs and runners than plain CPU time does.
- **The timestamptz wrapper (+26ms).** The backport delegates to psycopg's C loader and then calls `.replace(tzinfo=self.timezone)` on each value, exactly as Django 6.1 does. That is a Python call per value, about 43,800 per response. A counterfactual arm registered psycopg's C loader directly, with no Python wrapper. Its fetch phase was 26ms shorter than the shipped arm's (24.3ms against 50.7ms), and its whole request was 23ms shorter (per round +24, +27, +22, +14). In the request, the wrapper costs about 0.6µs per value, more than the 0.22µs the #1800 micro-benchmark measured in isolation.
- **Client-side binding (+5ms).** `prefetch_related` renders as `WHERE card_id IN (%s, %s, ...)`, with one placeholder per card. Six of the request's queries carry 2,388 or 2,389 placeholders each, 14,329 in total.
  - Django's psycopg 3 backend binds parameters client-side (`ClientCursor`).
  - psycopg 3 splits the query text on its placeholders in Python (`psycopg/_queries.py`, `_split_query`). That creates a regex match, a tuple and a `QueryPart` for every placeholder.
  - psycopg caches the split only for queries of at most 4,096 bytes and 50 parameters (`MAX_CACHED_STATEMENT_LENGTH`, `MAX_CACHED_STATEMENT_PARAMS`), so these six are split again on every request. psycopg2 did this in C.
  - Composing one of them took about 2.5ms under psycopg 3 and 1.1ms under psycopg2, about 8ms over the six.
- **Row loading (-22ms).** Without the wrapper, psycopg 3's fetch phase was 22ms shorter than psycopg2's (24.3ms against 45.6ms). psycopg 3's C row loading is faster, and it absorbs most of the wrapper's cost.

Ruled out, each by measurement or by reading the path:

- **psycopg 3's import footprint.** psycopg 3 adds about 8,100 GC-tracked objects at startup, so it looked like a cause of the slower collections. A psycopg2 arm with psycopg 3 imported, but not used, measured the same as plain psycopg2: 8ms faster with the collector on and 3ms faster with it off, both within noise.
- **Network and server time.** Replaying the request's `SELECT`s with their SQL already composed took 103.7ms under psycopg2 and 101.7ms under psycopg 3.
- **Other Python-side loaders.** Every other column type in the response (varchar, text, bool, int2, int4, int8, uuid, date, jsonb) loads through psycopg's C loaders. Django registers psycopg's `TextLoader` for jsonb, inet and cidr, and psycopg substitutes its C version for it.
- **Row factory.** Django uses psycopg 3's default tuple rows, built in C. They are faster than psycopg2's (above).
- **Server-side cursors.** Not used on this path. Django opens a named cursor only for chunked `.iterator()` reads, and `board_full` makes none.
- **Server-side binding.** Django's `OPTIONS["server_side_binding"]` wouldn't help. psycopg's server-side `PostgresQuery` splits the query with the same `_split_query`, behind the same 4,096-byte and 50-parameter cache limits as the client-side `PostgresClientQuery` (`psycopg/_queries.py`, the two `convert` methods).
- **Pipeline mode.** Django doesn't use it. Each prefetch query also needs the ids returned by the query before it, so the round trips couldn't be pipelined anyway.
- **The previous response staying in memory.** Each request's first full collection frees about 207,000 objects from the previous `board_full` response.
  - The `@extend_schema` decorator on the `full` action passes its schema class through the view's init kwargs, and DRF's schema descriptor then stores each new view instance on that class. So the last view, its response and the serialized board stay referenced until the next request to the same action.
  - Removing that reference didn't change latency: the objects are reference cycles that only the collector frees in either case.
  - It's the same under both drivers and isn't part of this step. Observation only; no work on it is planned.

Why the parts aren't fixed here:

- **The wrapper.** Registering psycopg's C loader directly returns the same values when the session TimeZone is UTC, which Django sets. It doesn't return the same values for the overflow fallback values that `boards/tests/test_db_psycopg.py` pins: Django relabels a fixed-offset fallback value with its own timezone, and the C loader keeps the offset. Django's `create_cursor` also reads `.timezone` from the registered loader class, which the C class doesn't have, so this would need a second patch to Django. Django 6.1 keeps the wrapper, so the change would depart from upstream instead of backporting it.
- **The binding.** Raising psycopg's cache limits would keep a parsed copy of each large query in memory for each distinct board size. Those would be long-lived objects for the collector to walk, so the change would add to its work instead of removing it. The real fix is to not send thousands of placeholders.
  - Inside Django, that would mean one array parameter with `= ANY(%s)`, a change to how Django builds `prefetch_related` lookups.
  - Visiban could also do it without a Django change: `board_full` loads a single board, so it could fetch each child relation filtered by the board and attach the rows to the cards itself. That would remove the `IN` lists under psycopg2 too.
  - It's untried. The experiment is tracked in [#1813](https://gitlab.com/visiban/visiban/-/issues/1813).
- **The collector.** Tuning it is a process-wide change to every endpoint, not a driver change. As a data point, calling `gc.freeze()` after startup made each arm faster than the same arm with default settings in the same round: by about 53ms under psycopg2 (668ms to 616ms in the table) and about 77ms under psycopg 3 (720ms to 646ms). It shrank the psycopg 3 step from about 45ms to about 24ms (30ms from the table's medians). This is recorded as an observation only. No work on collector tuning is planned.

How it was measured, so it can be repeated:

- **Setup.** A throwaway `postgres:17-alpine` container (PostgreSQL 17.11). The fixture was seeded with `manage.py seed_demo_data --force --scale 20 --with-notifications` (2,395 cards). The run used Python 3.12.6, Django 5.2.17, psycopg 3.3.6 with `psycopg-binary`, and psycopg2-binary 2.9.11, on a development machine.
  - The measurement predates [#1810](https://gitlab.com/visiban/visiban/-/issues/1810), which adds 199 small boards to the nightly fixture and makes the cards table about 67% larger.
  - To repeat it on the current nightly fixture, seed with `manage.py seed_demo_data --force --scale 20 --extra-boards 199 --with-notifications`. The extra boards belong to `demo3` and are separate from the `board_full` board, but this measurement wasn't repeated on that fixture.
- **Requests.** Each request ran in-process through Django's test `Client`, with `demo2`'s PAT from `manage.py provision_fuzz_token` and `DEBUG=True` as in CI. That is 19 queries per request: the 17 the endpoint runs, plus the two token queries.
- **Arms.** Each arm ran in a fresh process. The psycopg2 arm sets `sys.modules["psycopg"] = None` before Django loads, so `psycopg_any` falls back to psycopg2. The C-loader arm replaces `psycopg_any.register_tzloader` to register psycopg's default timestamptz loader for UTC, and skips the `.timezone` check in `create_cursor`. It's a timing counterfactual, not a candidate fix. Its responses were byte-identical to the other arms' on this fixture.
- **Phases.** Phase times come from wrapping `django.db.backends.utils.CursorWrapper._execute` and its `fetchone`, `fetchmany` and `fetchall`. Collector time comes from `gc.callbacks`. "Collector off" means `gc.disable()` in that process. "`gc.freeze()`" means `gc.collect()` then `gc.freeze()` after Django loads, before the warm-up requests.
- **Rounds.** Four interleaved rounds. Each round ran every arm under each collector setting once, with 3 warm-up requests and 15 timed requests. The table gives the median of the four per-round means. The step column gives the median of the four differences against psycopg2 under the same collector setting in the same round. Phase times in the text are medians of per-round means too.

| Arm | Collector on: mean | Collector on: step | Collector off: mean | Collector off: step | `gc.freeze()`: mean | `gc.freeze()`: step |
|---|---|---|---|---|---|---|
| psycopg2 | 668ms | — | 491ms | — | 616ms | — |
| psycopg2, with psycopg 3 imported but not used | 659ms | -8ms | 489ms | -3ms | 618ms | -3ms |
| psycopg 3 with the backport | 720ms | +45ms | 517ms | +26ms | 646ms | +24ms |
| psycopg 3, C timestamptz loader with no wrapper (counterfactual) | 700ms | +22ms | 483ms | -7ms | 614ms | -5ms |

Per round, the psycopg 3 step was +45, +78, +44 and +36ms with the collector on, and +25, +27, +25 and +28ms with it off. This was measured on a development machine, not a NUC runner. The `board_full` budget was re-derived from a NUC run that includes #1800 in [#1808](https://gitlab.com/visiban/visiban/-/issues/1808); see the note under "Re-deriving the baseline".

### What #1800 did not explain

- **`card_search` and `notifications_unread`** show no driver effect locally: psycopg2, psycopg 3 and psycopg 3 with the backport measured within noise of each other. Their smaller rise (`card_search` p50 about 80ms to 84-90ms over the same period, and 100.7ms on `runner-04-NUC`) isn't the timestamptz loader.
  - Locally, `card_search` was about 14% slower on current code than on `7dee839ca`, with the same queries on both. (Measured with token auth, as in the load test, that's 10 queries. The token lookup and the token `last_used_at` update account for the extra two.) (Since #1964 the token `last_used_at` update runs at most about once a minute per token, so steady-state token-auth requests run one query fewer than these measurements.)
  - That comparison spans two separately seeded databases and wasn't taken further here.
  - #1805 explains these two, and also the `card_timeline` and `notifications_list` rises that the #1767 re-derivation absorbed. See [the #1805 section](#the-october-2026-card_search-and-notifications_unread-drift-1805) below.
- **Unpinned inputs.** The job installs `backend/requirements.txt`, not the hash-pinned `requirements.lock`, and its `python:3.12-slim` and `postgres:17-alpine` images are floating tags. Transitive dependency and base-image versions can therefore change between two runs on the same commit. Those unpinned versions aren't visible in the lock diff above, and this investigation didn't rule them out from the CI data. The local measurement reproduces a step of the observed size from the driver alone. When attributing a future drift, check them.

## The October 2026 `card_search` and `notifications_unread` drift — #1805

**Verdict: three separate effects. One was a code regression, now fixed. One was a runner change. The third is unattributed, sits inside the budget headroom, and wasn't pursued.**

1. **`card_search` on Oct 20 was a regression in the code.** [#1723](https://gitlab.com/visiban/visiban/-/issues/1723) rewrote the board access filter (merged Oct 19) and made the cross-board card query slower to *plan*. The query count and the payload stayed the same. #1805 fixes it in `CardQueryViewSet.get_queryset()`.
2. **All four light endpoints on Oct 20 ran on a different runner.** That run was the first scheduled run on `runner-04-NUC`. On endpoints whose code didn't change, it measured 6-10% slower than the other two NUC runners. This is one sample.
3. **All four light endpoints stepped up 2-6% at p50 at the Oct 4/5 boundary**, on both NUC runners. That is 0.8-2.1ms on the three lightest and 3.2-4.4ms on `card_search`. It's the same boundary as the `board_full` step above. A local driver A/B didn't reproduce it, so it's **unattributed**. It sits inside the 1.4x budget headroom and wasn't pursued.

`card_timeline` and `notifications_list`, which the #1767 re-derivation also moved up, rose only through effects 2 and 3. The budgets were **not** re-derived here, because no NUC run had measured the fix yet. [#1808](https://gitlab.com/visiban/visiban/-/issues/1808) then re-derived them from job 17348200339: the `card_search` budget fell from 155 to 105ms against a NUC p95 of 73.1ms (about 57ms locally).

### What the scheduled runs show

This uses the same 25 scheduled jobs and the same per-runner p50 method as #1800 above. The dell-01 job is excluded, and so is job 16796278537 (Sep 29, retried), where `notifications_unread`, `notifications_list` and `card_timeline` were 50-60% slower than in every other job. Each cell gives the median p50 across that runner's jobs:

| Endpoint | `gitlab-runner-nuc-2-visiban` before / after Oct 5 (5 / 6 jobs) | `Runner-03-NUC` before / after Oct 5 (3 / 8 jobs) | `runner-04-NUC` Oct 20 (1 job) |
|---|---|---|---|
| `card_search` | 81.0 / 84.2ms (+4%) | 80.3 / 84.7ms (+5%) | 100.7ms |
| `notifications_unread` | 23.8 / 24.9ms (+4%) | 24.5 / 25.8ms (+5%) | 28.1ms |
| `notifications_list` | 32.3 / 33.5ms (+4%) | 32.9 / 35.0ms (+6%) | 36.3ms |
| `card_timeline` | 32.3 / 33.1ms (+2%) | 32.5 / 34.4ms (+6%) | 36.7ms |

On the Oct 20 run, the light endpoints were above both other runners' post-Oct-5 medians (84.2, 25.5, 34.3 and 33.5ms): `card_search` by 20%, `notifications_unread` by 10%, `card_timeline` by 9% and `notifications_list` by 6%. `board_full` wasn't: 1136ms against a 1151ms median. That run is the first after #1723 and #1721 merged (`37ad2d8e0` to `b1f1cf76b`), so the CI data alone can't separate the runner from the code. The local A/B below does.

### `card_search`: the access-filter rewrite (#1723)

Measured locally on one scale-20 database (PostgreSQL 17, `DEBUG=True` and no `CONN_MAX_AGE`, as in CI). The method was 6 interleaved rounds of 40 timed requests per endpoint, with the servers for both commits running against that same database. This answers #1800's open question: its 14% difference spanned two separately seeded databases.

- **Only `card_search` moved.** From `37ad2d8e0` (Oct 19 run) to `b1f1cf76b` (Oct 20 run), the median per-round p50 went from 69.1ms to 77.6ms, slower in every round, and p95 went from 72.9ms to 106.7ms. `notifications_unread`, `notifications_list` and `card_timeline` were unchanged within 1ms. All four returned byte-identical JSON on both commits.
- **Same queries, slower planning.** Both commits ran 10 queries with token auth (8 without the token lookup and its `last_used_at` update). Only the main card SELECT got slower, 25ms to 33ms. `EXPLAIN ANALYZE` on that statement:
  - Execution: unchanged (15.2ms and 15.1ms).
  - Planning: 11-15ms before, 19-23ms after, in fresh and warm sessions alike.
- **Mechanism.** The view filters cards with `board_id__in=get_accessible_boards_queryset(user)`. Before #1723 that subquery was `SELECT DISTINCT ... LEFT JOIN board_memberships`. #1723 replaced it with `owner = ... OR EXISTS(...)`.
  - PostgreSQL pulls the subquery up into the card SELECT's 7-table join (cards, board, column, swimlane, two users, external ref). With the `OR EXISTS` form, the planner spends longer on that join than the executor spends running it.
  - #1723's `Exists()` alone accounts for the rise (planning 19-20ms). [#1721](https://gitlab.com/visiban/visiban/-/issues/1721)'s role filter added nothing measurable.

**The fix.** `get_queryset()` now evaluates the accessible board ids as a list (one small extra query) and passes the literal list to `board_id__in`. The access rule itself is untouched: the same `get_accessible_boards_queryset()` decides which ids are in the list. On the same statement:

| Access filter in the card SELECT | Planning | Execution |
|---|---|---|
| Subquery, before #1723 | 11-15ms | 15ms |
| Subquery, after #1723 | 19-23ms | 15ms |
| Literal list, 1 board (this fixture) | 4.5ms | 0.65ms |
| Literal list, 200 ids | 5ms | 13.5ms |
| Literal list, 20,000 ids | 15-17ms | 14-15ms |

With this fixture's single board, the planner can walk `card_board_updated_idx` in cursor order and stop at the 51st row instead of sorting every match. With 200 ids it went back to the old scan-and-sort, at the old execution time. Even 20,000 ids plan faster than the subquery did after #1723.

End to end, with all three servers on one database (6 interleaved rounds, median per-round p50 / p95):

| Code | `card_search` p50 | `card_search` p95 |
|---|---|---|
| `37ad2d8e0` (before #1723) | 67.9ms | 85.8ms |
| `b1f1cf76b` (Oct 20 run) | 74.3ms | 106.8ms |
| `b1f1cf76b` with the #1805 fix | 48.0ms | 57.2ms |

The other three endpoints were unchanged within noise in all three arms. The response was byte-identical, and the request now runs 11 queries instead of 10.

- `CardQueryCountTests.test_access_filter_is_a_literal_id_list` in `boards/tests/test_card_query.py` pins the shape. It fails if the card SELECT's `WHERE` contains a `boards` or `board_memberships` subquery, or if the inlined ids aren't exactly the caller's accessible boards.
- `test_access_filter_is_a_literal_id_list_for_site_admin` pins the same shape for a `can_access_all_content` user, whose list holds every board.
- Like the #1800 regression, this one left the query count unchanged, so a query-count guard wouldn't have caught it.

**What the `card_search` scenario now measures, and what it doesn't.**

- **It measures only the single-board plan.** The scenario runs as `demo2`, who can access one board, so after the fix it times the single-board index walk on `card_board_updated_idx`. The plan most multi-board users get (scan and sort, 13.5ms execution at 200 ids in the table above) isn't measured by this scenario. A budget derived from it can't see a regression on that path.
- **`card_search_multi_board` measures the many-board plan.** [#1810](https://gitlab.com/visiban/visiban/-/issues/1810) added it: the same request as `card_search`, run as `demo3`, who owns 199 small extra boards (`--extra-boards 199`) and is a member of the load-test board, so the card SELECT filters on a 200-id literal list. Its budget is 125ms (re-derived 2026-11-19 from NUC job 18170442650, measured p95 89.1ms; first set to 120ms in [#1808](https://gitlab.com/visiban/visiban/-/issues/1808)). Don't hand-edit it.
- **It never exercised the trigram indexes.** Django's `icontains` renders as `UPPER(col) LIKE UPPER('%term%')`. The `card_title_trgm_idx` and `card_desc_trgm_idx` indexes from migration 0030 are on the bare columns, so PostgreSQL can't use them for that expression:
  - Before the fix the plan is a sequential scan on `cards`.
  - After the fix it's the index walk above.
  - With a selective term and `enable_seqscan=off`, the planner picks `cards_board_id_*` and filters, still without the trigram indexes. They are used only by `ILIKE`, which no card query issued at the time.

  Neither search site (`boards/views/cards.py` or `boards/views/card_query.py`) could use the indexes, yet they still cost a GIN update on every card write. Fixed in [#1809](https://gitlab.com/visiban/visiban/-/issues/1809): both sites now use the `ci_contains` lookup, which renders `ILIKE`.

  So the scenario measures the access filter, the per-card serialization of one 51-row page, and the substring filter applied row by row.

### `runner-04-NUC`: one slower run

Locally, the `37ad2d8e0` to `b1f1cf76b` change didn't move `notifications_unread`, `notifications_list` or `card_timeline`. So their Oct 20 rise (6-10% over the other NUC runners' medians, above) isn't the code. `runner-04-NUC` is `nuc`-tagged and was correctly eligible, but this was its first scheduled `nightly-load-test` run, and there's no second sample yet. `card_search`'s 20% on that run fits both causes together: about 10% from #1723 and about 10% from the runner.

**Watch out:** Don't treat `runner-04-NUC` as interchangeable with the other two NUC runners until more runs land on it. When a budget fails on that runner, first compare its p50 with the other runners' recent runs, as above. The current baseline was derived from this run, so its light endpoint budgets carry the runner's extra 6-10%.

### The Oct 4/5 step on the light endpoints

All four light endpoints rose 2-6% (0.8-2.1ms at p50, 3.2-4.4ms on `card_search`) between the Oct 4 run on `7dee839ca` and the runs from Oct 5 on, on both NUC runners. That is the boundary where #1800 found the `board_full` step. Per #1800, the only lock changes in that window are psycopg 3 (#1252) and the MCP SDK, and the MCP SDK isn't imported in the job. The settings changes in the window add no per-request work.

The driver doesn't reproduce it locally. On `b1f1cf76b`, with one database and 8 interleaved rounds, psycopg 3 wasn't slower than psycopg2 on any of these endpoints. On the three lightest it was 1.4-2.2ms faster at p50, and `card_search` measured 77.5ms against 77.9ms.

- That commit predates #1800's backport, so psycopg 3 was still parsing `timestamptz` in Python and was still not slower.
- psycopg2 was forced by shadowing the `psycopg` import, so Django fell back to psycopg2 2.9.11.
- A new connection per request (`CONN_MAX_AGE` unset, `DATABASE_POOL` off) is part of both arms.
- The development machine is macOS on arm64, while CI is `python:3.12-slim` on x86_64. This test doesn't cover a platform-specific driver cost, nor the unpinned transitive dependencies and floating images #1800 lists.

This step is therefore **unattributed**. It's 0.8-2.1ms per request on the three lightest endpoints and 3.2-4.4ms on `card_search`, which is 2-6% and well inside the 1.4x budget factor, so it wasn't pursued. If it grows, run the same driver A/B on a NUC runner rather than on a development machine.

## The November 2026 flow-metric regression — #2502

The 2026-11-21 scheduled run failed on `flow_wip_age` (p95 577.4 ms against a 510 ms budget). Every range metric moved with it: from 2026-11-16 to 11-20 `flow_wip_age` sat at 360-375 ms, then the first run at `cafd0ad9e` measured 530.7 ms. The non-flow endpoints stayed within the run-to-run noise. `flow_blocked` did not: its nightly p95 went 282.2 ms (11-20) to 316.8 ms (11-21) to 361.6 ms (the retry), +12% and +28%, about the size of the rise on `throughput` (302.0 to 372.9 ms) and `cycle_time` (306.8 to 377.0 ms). The range-loader predicate change below can't explain that rise on `flow_blocked`, because it reads through `load_live_wip` and never touches the range loader. This section has no local measurement of `flow_blocked`, so the cause of its nightly rise is not attributed. It is the same unattributed residual described at the end of this section.

### Root cause, measured

Commit `c49825214` (#2425) narrowed every range metric to the cards `flow_metrics.can_affect_range` keeps. Its movement term was a correlated `EXISTS (SELECT … FROM card_movements WHERE card_id = cards.id AND moved_at >= boundary)` inside an `OR`. PostgreSQL can't turn a correlated `EXISTS` under an `OR` into a semi-join, so it stays a per-row filter on `cards`. With that filter in place, the planner stopped driving the history read from the board's cards. It walked the whole `card_movements_card_id` index instead, every board's movements, and probed `cards` once per row.

`EXPLAIN (ANALYZE, BUFFERS)` on the history statement, local PostgreSQL, the current nightly fixture (151,674 movements in the database, 24,919 on the load-test board):

| | Driven from | Rows read | Buffers | Time |
|---|---|---|---|---|
| Correlated `EXISTS` (`c49825214`) | `card_movements_card_id`, all boards | 151,674 | 51,811 | 56.6 ms |
| Uncorrelated `IN` (#2502) | the board's 2,395 cards | 24,919 | 10,085 | 20.1 ms |

On the load-test board the narrowing can't prune anything, because every card is live. So that board paid the instance-wide read and got nothing back for it. Migration 0117 (#2408, dropping `movement_board_moved_idx`) is ruled out: neither plan uses a `board_id` movement index.

### The fix

The movement term is now `pk IN (SELECT card_id FROM card_movements JOIN cards … WHERE cards.board_id = <board> AND cards.archived_at < boundary AND cards.created_at < boundary AND moved_at >= boundary)`. It's uncorrelated, so it runs as a hashed SubPlan, at most once per statement and only when a row reaches it (a live card never does). It names the same cards: the term only matters for a card that's archived and was created before the boundary. `RangeNarrowingEquivalenceTests` still holds, and `test_flow_range_plan_2502.py` fails on any range-load statement that correlates `card_movements` to the card, or on a movement subquery without the board bound.

DRF client, local, warm, 20 requests per arm, p50 / p95 in ms:

| Endpoint (load-test board) | `2655a9f81` | `c49825214` predicate | #2502 |
|---|---|---|---|
| `wip-age` | 148.1 / 168.2 | 185.9 / 198.1 | 159.7 / 178.9 |
| `attention` | 137.0 / 160.0 | 162.8 / 185.7 | 140.5 / 161.0 |
| `cycle-time` | 129.5 / 137.2 | 154.3 / 173.4 | 129.6 / 148.9 |
| `cumulative-flow` | 135.5 / 150.9 | 161.2 / 182.1 | 138.1 / 161.8 |

The aged board keeps the #2425 win. Its `wip-age` was 324 ms p50 with either predicate, against 756 ms for the whole-history load. No budget changed. The residual of about 5-8% over `2655a9f81` on the load-test board wasn't attributed. It's inside the 1.4x budget factor.

The closing check is the manual `nightly-load-test` job on the NUC: its p95 for all eight flow scenarios (`cycle-time`, `throughput`, `cumulative-flow`, `wip-age`, `dwell`, `blocked`, `attention`, `swimlanes`) must come back under their budgets. The local DRF-client table above covers only four of the eight (`wip-age`, `attention`, `cycle-time`, `cumulative-flow`); `throughput`, `dwell`, `blocked` and `swimlanes` were not measured locally.

### The dwell loader's movement term — #2506, #2567

`flow_metrics.load_recent_dwell` (the analytics heatmap and the MCP aging tool, not `summary`) had the same correlated `EXISTS` inside an `OR`. #2506 made it an uncorrelated `IN`, but bounded only by `card__board`, so its subquery still read every board's movements in the range from `card_movements_moved_at`. #2567 narrows it to the cards the other two terms skip: this board's cards archived before the range, or live in a done column (named by id from the `columns` argument). That is the exact complement of the other terms, so the kept set is unchanged; `RecentDwellNarrowedMovementTests` in `test_flow_range_plan_2502.py` pins it against the old correlated rule with another board's cards moving inside the range.

`EXPLAIN (ANALYZE, BUFFERS)`, local PostgreSQL 17.11, the nightly fixture (`seed_demo_data --force --scale 20 --extra-boards 199 --with-notifications --aged-generations 4`, then `VACUUM ANALYZE`; 151,674 movements in the database). Buffers summed over every statement the loader issues that reads `card_movements` (the cards load, the history read, and on the load-test board the gate history read), with the heatmap's `also_matching` term, as `analytics/` sends it:

| Board, range | Kept cards | Before (#2506) | After (#2567) |
|---|---|---|---|
| Load-test (2,395 cards), 30 days | 2,395 / 2,395 | 90,043 | 13,726 |
| Load-test, 90 days | 2,395 / 2,395 | 26,011 | 8,740 |
| Aged (12,050 cards), 30 days | 2,410 / 2,410 | 64,752 | 64,752 |
| Aged, 90 days | 2,410 / 2,410 | 17,542 | 17,546 |

On the load-test board the subquery now drives from the board's 479 narrowed cards with index-only probes of `movement_card_moved_idx` (2,883 buffers) instead of reading 29,428 rows over 2 loops from `card_movements_moved_at` (28,534 buffers); the cards load goes 28,984 -> 3,545 buffers. On the aged board the plans do not change (the 4-buffer difference at 90 days is the narrowed predicate's extra filter on the same plan): 10,150 of its cards are narrowed-in (9,640 archived, 510 live done), and at 30 days the planner still prefers the instance-wide `moved_at` range scan to that many probes. That residual is the planner's choice of driver, not a wider bound. One variant was measured and rejected: reading `is_done` through a join to `columns` inside the subquery flipped the aged board's 90-day plan to one probe per narrowed card, 17,542 -> 131,712 buffers. Execution times were too noisy at this size (median of 3, 2-40 ms per statement) to quote as a gain.

## Cumulative flow's whole-history read — #2444

After [#2425](https://gitlab.com/visiban/visiban/-/issues/2425), `metrics/cumulative-flow` still streamed every skipped card's whole movement history to find the band it rests in. The `?date=` drill-down still loaded the board's whole history through `load_board_flow`.

Both now go through `flow_metrics._deciding_rows`, which reads per card only the rows `_replay_placements` can depend on:

- the first row;
- the last transition;
- the last archive-type row;
- for a drill-down day only, the last archive-type row after that day. That row decides whether an admin-set `archived_at` counts.

The rows are chosen in one uncorrelated statement with two `ROW_NUMBER()` windows, and the replay is unchanged, so every response is byte-identical. `load_cumulative_day` serves the drill-down.

### Measured (local, not the NUC)

Setup:

- The numbers are in-process service calls (load plus payload, the drill-down's card directory included) on local PostgreSQL. No HTTP request was timed.
- The fixture is `seed_demo_data --force --scale 20 --aged-generations 12` followed by `VACUUM ANALYZE`. The aged board has 31,330 cards and 329,563 movements. The load-test board has 2,395 cards and 24,919 movements, and it stands in for the "80 days" row.
- The drill-down day is 540 days back.
- Each figure is the median of 7 runs, in ms.
- "py-peak" is the `tracemalloc` peak, not RSS: `/proc` is not available on macOS.

| Request | Board | main | #2444 | py-peak main → #2444 |
|---|---|---|---|---|
| `cumulative-flow` (90 days) | aged | 1,083 | 772 | 31.6 → 31.4 MiB |
| `cumulative-flow` (90 days) | load-test | 130 | 128 | 11.7 → 11.7 MiB |
| `cumulative-flow?date=` | aged | 1,488 | 653 | 150.0 → 43.3 MiB |
| `cumulative-flow?date=` | load-test | 120 | 45 | 11.7 → 3.3 MiB |
| `wip-age`, for reference | aged / load-test | — | 295 / 137 (2.15x) | — |

`EXPLAIN (ANALYZE, BUFFERS)` on the deciding-rows statement:

| | Rows read by the windows | Rows returned | Time |
|---|---|---|---|
| Range (skipped cards) | 278,861 | 46,750 | 398 ms |
| Drill-down (all cards) | 329,563 | 44,212 | 500 ms |

Both windows are fed by an incremental sort presorted on `card_id` from `card_movements_card_id`. That sort is an in-memory quicksort with a 31 kB peak per group and no spill. An index on `(card, moved_at, id)` would not remove it, because the second window partitions on the computed `kind`. No index was added.

**The #2425 1.5x acceptance is not met, for latency or for memory.**

| Request | Latency, aged / load-test | `tracemalloc` peak, aged / load-test |
|---|---|---|
| `cumulative-flow` | 6.0x (772 / 128 ms) | 2.7x (31.4 / 11.7 MiB) |
| `cumulative-flow?date=` | 14.5x (653 / 45 ms) | 13.1x (43.3 / 3.3 MiB) |

Caveat: the load-test board has no history 540 days back, so its drill-down day is empty and the drill-down ratio (14.5x here, 11.4x for the probes) is not a like-for-like comparison. The range ratio (about 6x) is the meaningful one. The "not met" verdict stands either way.

The remaining cost is server-side: the windows still read every row of the selected cards (about 400-500 ms), although only three or four per card reach Python. Both requests also place every card older than the range, so the rows that reach Python grow with the archived card count.

Per-card `LIMIT 1` probes through a new `(card, moved_at, id)` index were also tried. In a same-run A/B of the deciding read alone (same rows), the window statement took 575 ms for the range and 708 ms for the drill-down, and the probes 610 ms and 861 ms, so the probes were slightly slower and were not kept. The 6.4x and 11.4x ratios above come from a different run than the 6.0x and 14.5x, on a machine about 40% slower in the second, so the two sets are not comparable with each other. Only a stored placement per settled card (or per day) could reach 1.5x.

`aged_flow_cumulative_flow_day` is pending under #2430 with its siblings until a NUC run measures it.

Follow-up: #2559 (stored per-card resting placements).
