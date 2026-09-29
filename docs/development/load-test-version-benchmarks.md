# Load-test version benchmarks

A point-in-time comparison of API read-path latency across Visiban 1.0, 1.1, and current
`main` (pre-alpha, tracked here as "1.2-dev"), plus a search for the card/swimlane count at
which the board stops feeling responsive. This is a one-off benchmarking pass, not a CI gate —
for the gate that gets its numbers from a controlled fixture on every scheduled pipeline run,
see [Nightly Load Test](nightly-load-test.md). Don't substitute these numbers for that job's
committed budget file.

!!! warning "Read the caveats before quoting a number from this page"
    Every measurement here was taken on a shared development machine with other active Claude
    Code sessions running concurrently — not a dedicated, isolated benchmark host. It is the
    same "measured on a laptop, not a CI runner" caveat `nightly-load-test-baseline.json`
    already carries for its own provisional numbers, applied to a wider comparison. See
    [Methodology and caveats](#methodology-and-caveats) before treating any figure below as
    more precise than it is.

## Summary

- On an identical ~115-card/10-swimlane fixture, Visiban 1.0.0, 1.1.0, and current `main`
  perform within noise of each other (`board_full` p95 77-89ms) — no read-path latency
  regression across two major releases on this endpoint set.
- On `main`, `board_full` p95 at the existing 2,395-card (2,388 active, 7 archived)
  nightly-load-test fixture is **580ms**, comfortably under the 955ms committed budget and
  better than the 681ms pre-regression baseline — consistent with !981 (#1212) having just
  merged into `main`.
- `board_full` latency scales worse than linearly with card count: doubling the card count
  roughly tripled p95 in our measurements. The point where it crosses 3x its own committed
  budget lands in the neighborhood of 8,500-14,500 cards (700-1,200 swimlanes) — see
  [Finding the ceiling](#finding-the-ceiling-max-cards-and-swimlanes) for why that range isn't
  tighter.
- The backend never hard-failed (no 500s, no timeouts) even at 24,000 cards — it degrades
  gracefully into "too slow to use," not into errors.
- Ten concurrent users against a single dev-mode `daphne` process degrades badly (p95 jumps
  from 275ms to 1,860ms on the same 592-card fixture) — this measures single-process capacity,
  not a claim about a properly scaled production deployment. See the caveat below.
- Frontend render/scroll behavior was **not measured** in this pass — see
  [Open follow-ups](#open-follow-ups).

## Methodology and caveats

**Environment.** All three versions ran as separate, disposable stacks (Postgres 17 +
Valkey/Redis + a single `daphne` process each) on one shared development machine that had
roughly a dozen other Claude Code sessions active throughout — CPU idle hovered 83-89% with a
1-minute load average of 2-7 on an 18-core machine, not a dedicated benchmark host. This adds
run-to-run noise (visible directly in the [ceiling escalation](#finding-the-ceiling-max-cards-and-swimlanes)
data below) but does not explain away the two clear signals in this doc — the near-3x latency
jump from doubling card count, and the concurrency degradation — both of which are far larger
than the noise band.

**Deployment shape.** Each backend ran as one `daphne` process in dev settings (`DEBUG=true`),
the same way [`nightly-load-test.md`](nightly-load-test.md)'s job runs it — not behind multiple
workers/processes the way a production deployment would be. This matters most for the
10-concurrent-user result: it measures one process's capacity to interleave concurrent I/O-bound
requests, not Visiban's ceiling under a horizontally-scaled deployment. Re-measuring behind a
multi-worker ASGI setup is listed as an open follow-up.

**Fixtures.** `manage.py seed_demo_data` at `main` supports `--scale N` (introduced for #1082,
after 1.1.0): `--scale 1` (default) seeds the ~115-card "Visiban Demo Board"; `--scale 5`
and `--scale 20` seed a separate "Visiban Load Test Board" at roughly 600 and 2,400 cards
respectively. **`--scale` does not exist at the `v1.0.0` or `v1.1.0` tags** — those versions
can only seed the ~115-card default board, so the apples-to-apples comparison across all three
versions is limited to that one fixture size. The medium (~600-card), large (~2,400-card), and
ceiling-escalation fixtures are `main`-only for that reason, not because 1.0/1.1 were found to
perform worse at scale — they were never tested at scale.

**Endpoint availability at older tags.** `v1.0.0` and `v1.1.0` predate the flat
`/api/v1/cards/` route (added after 1.1) — card search there used the board-nested
`/api/v1/boards/{id}/cards/?search=` route instead, which exercises the same search code path.
`v1.0.0` additionally predates the `card_timeline` endpoint (added with migration `0045`,
post-1.0), so that endpoint has no 1.0.0 number at all — reported as N/A, not zero. These
substitutions were made in unmodified-logic copies of `scripts/nightly_load_test.py` kept
outside the repo (this was a one-off comparison, not a tool worth maintaining three URL-shape
branches of); the production job at `main` needs no such patching.

**Concurrency harness.** `scripts/nightly_load_test.py` only measures sequential single-client
latency by design. The 10-concurrent-user numbers came from a separate ad hoc script
(`ThreadPoolExecutor`-based, one `requests.Session` per worker) written for this pass and not
added to `scripts/` — it was not reviewed or wired into any committed budget, and promoting it
would need its own pass.

## Version comparison — identical fixture

~115 cards, 10 swimlanes, single user, 40 timed requests per endpoint (5 warmup, discarded):

| Endpoint | 1.0.0 p95 | 1.1.0 p95 | main (1.2-dev) p95 |
|---|---|---|---|
| `board_full` | 78.3ms | 89.2ms | 77.0ms |
| `card_search` | 73.3ms | 79.5ms | 75.7ms |
| `card_timeline` | N/A — endpoint added post-1.0 | 26.4ms | 21.1ms |
| `notifications_list` | 13.2ms | 18.0ms | 24.7ms |
| `notifications_unread` | 12.5ms | 17.3ms | 17.0ms |

No endpoint shows a trend across versions distinguishable from the run-to-run noise on this
fixture size. This is the only scenario where all three versions are directly comparable.

## `main`-only: larger fixtures and concurrency

Single user, 40 timed requests per endpoint (5 warmup) unless noted. "Large" here is the same
`--scale 20` fixture as the ceiling table's scale-20 row below (2,395 cards seeded, 2,388
active — `board_full` only returns active cards, so its own `card_count` reads 2,388; the
ceiling table reports the seed command's total for consistency across all its rows instead —
same fixture, two counting bases, not a discrepancy):

| Endpoint | Large (2,395 seeded / 2,388 active cards, 200 lanes) p95 | Medium (592 cards / 50 lanes) p95 |
|---|---|---|
| `board_full` | 580.0ms | 275.2ms |
| `card_search` | 57.5ms | 127.1ms |
| `card_timeline` | 23.8ms | 35.1ms |
| `notifications_list` | 23.9ms | 39.0ms |
| `notifications_unread` | 19.7ms | 29.3ms |

**10 concurrent users, medium fixture (592 cards), 15 requests/worker (150 total, 0 errors):**

| Endpoint | p50 | p95 | p99 | Throughput |
|---|---|---|---|---|
| `board_full` | 1,560ms | 1,860ms | 2,214ms | 6.4 req/s |
| `card_search` | 224ms | 287ms | 385ms | 44.1 req/s |

Compare `board_full`'s single-user medium-fixture p95 (275ms) against its 10-concurrent-user
p95 on the same fixture (1,860ms) — a ~6.8x jump. Per the deployment-shape caveat above, this
says more about one `daphne` process's concurrency ceiling than about Visiban's architecture;
it's the clearest reason a production deployment shouldn't run a single ASGI worker.

## Finding the ceiling: max cards and swimlanes

"Unusable" is defined here as `board_full` p95 crossing **3x its committed budget**
(955ms × 3 = 2,865ms) — the point where a board fetch that should feel instant instead has a
visible, multi-second stall. This was decided as the backend-only half of the question; see
[Open follow-ups](#open-follow-ups) for why frontend render/scroll time isn't measured here.
Single user, `board_full` only, `--scale N` escalating (10 swimlanes and ~12 cards/swimlane per
scale unit, both axes moving together — see the caveat below):

| Scale | Swimlanes | Cards | `board_full` p95 | vs. 3x budget (2,865ms) |
|---|---|---|---|---|
| 20 | 200 | 2,395 | 580ms | — |
| 40 | 400 | 4,851 | 1,693ms | under |
| 60 | 600 | 7,253 | 2,467ms | under |
| 70 | 700 | 8,461 | 2,608ms | under |
| 80 | 800 | 9,653 | 2,176ms | under *(see note)* |
| 120 | 1,200 | 14,454 | 3,395ms | **over** |
| 200 | 2,000 | 24,052 | 5,535ms | over |

**Scale 80's reading is out of trend** (lower than scale 70's, when it should be higher) —
each row above is a single 15-iteration sample on a shared, noisy machine, not an average of
repeated runs. Take the crossing point as **"somewhere between ~8,500 and ~14,500 cards / 700
and 1,200 swimlanes,"** not as a specific number — tightening it would mean repeated samples
per scale step on a quieter or dedicated machine.

**Cards and swimlanes were not varied independently.** `--scale N` multiplies both together
(10N swimlanes, ~12N cards); this table cannot say whether a 10,000-card board in 50 swimlanes
degrades the same, worse, or better than one in 1,000 swimlanes. That would need a fixture tool
that can hold one axis fixed — not built for this pass.

**No hard failure was observed at any scale tested**, up to 24,052 cards — no 500s, no
timeouts (30s client timeout, never hit). The endpoint gets progressively slower, not broken;
"unusable" here is a UX judgment call (the 3x-budget line), not a crash point.

## Comparison with other OSS and commercial boards

**This is not a benchmark.** Visiban's numbers above were measured directly, under our own
conditions, against our own fixtures. Nothing below was — it's what's publicly documented or
publicly reported about other tools' scale limits, gathered by web search on 2026-09-28, with a
source link on every line. Where a product's own team has published an official number, it's
labeled **official**; a GitHub issue, forum thread, or community report is labeled
**anecdotal**. Do not read any figure below as measured under equivalent conditions to
Visiban's own numbers, and do not read a product's silence on this table as a performance
finding — several rows below are "nothing credible found," which is itself the result, not an
absence of research.

### Self-hosted / OSS

| Product | What's documented | Label | Source |
|---|---|---|---|
| Wekan | Boards of ~467-865 cards reported causing multi-second load times, 100% CPU pins, and browser RAM >4GB in some reports | Anecdotal | [#4061](https://github.com/wekan/wekan/issues/4061), [#5208](https://github.com/wekan/wekan/issues/5208) |
| Wekan | v10.04 added lazy/windowed card loading past a 500-card default threshold and fixed an N+1 board-publication query — the maintainers' own acknowledgment that large unoptimized boards were a known problem | Official | [v10.04 release notes](https://github.com/wekan/wekan/releases/tag/v10.04) |
| Wekan | Production sizing guidance: 4GB+ RAM recommended; "thousands of users" scale needs 3 frontend servers (2 CPU, 2 app containers each) plus a dedicated MongoDB host; largest known deployment ~30k users | Official | [Requirements wiki](https://github.com/wekan/wekan/wiki/Requirements) |
| Kanboard | ~500 open tasks in one project reported causing 3-4s drag-and-drop delays; a separate report on SQLite specifically named single-writer file locking as the multi-user bottleneck, resolved by switching to MySQL/PostgreSQL | Anecdotal | [#3822](https://github.com/kanboard/kanboard/issues/3822), [community thread](https://kanboard.discourse.group/t/kanboard-performance-2024/3133) |
| Kanboard | No official max-tasks-per-board or hardware-sizing guidance found | — | — |
| Focalboard | One report of general sluggishness on the Mattermost-plugin build (not the personal-server build) — no card count given | Anecdotal | [#560](https://github.com/mattermost/focalboard/issues/560) |
| Focalboard | Personal-server setup docs default to SQLite; no stated scale limits at all | Official (silent on scale) | [setup guide](https://docs.mattermost.com/developers/contribute/more-info/focalboard/personal-server-setup-guide) |
| Planka | No specific card-count performance report found; one feature request cites "reduce lag on boards with many items" as motivation, with no count given | Anecdotal (weak signal) | [#774](https://github.com/plankanban/planka/issues/774) |
| Taiga | Minimum sizing (1GB RAM, 20GB disk) explicitly scoped to "small/medium production, low traffic"; no story/task-count ceiling stated | Official | [production setup](https://docs.taiga.io/setup-production.html) |

### Commercial / hosted

| Product | What's documented | Label | Source |
|---|---|---|---|
| Trello | Hard limits: 5,000 open cards/board (warns at 4,500), 2,000,000 total cards/board, 475 open lists/board | Official | [object limits](https://developer.atlassian.com/cloud/trello/guides/rest-api/limits/) |
| Trello | Community consensus that boards feel sluggish well before the hard cap — ~1,000 active cards cited informally as a practical comfort ceiling, with "split into multiple boards" as the standard workaround | Anecdotal | [community thread](https://community.atlassian.com/forums/Trello-questions/Maximum-cards-in-a-list/qaq-p/674918) |
| Jira Software (Cloud) | Board/backlog/timeline views cap at 5,000 work items (Premium "Plans" raises this to 30,000); not configurable on standard plans | Official | [issue limits](https://support.atlassian.com/jira-software-cloud/docs/issue-limits-in-company-managed-projects/) |
| Jira Software (Cloud) | Multiple community threads describe teams hitting the 5,000-item cap in practice and being told to split boards/filters | Anecdotal (corroborates the official cap) | [community thread](https://community.atlassian.com/forums/Jira-questions/Need-suggestion-over-5k-Issue-limit-in-JIRA-Board/qaq-p/2489053) |
| monday.com | 10,000 items/board (no tier breakdown stated on this page); separately, 100,000 linked items/board and a 20,000-item cap across boards feeding one dashboard widget | Official | [developer limits](https://developer.monday.com/apps/docs/limits) |
| monday.com | A separate support article reportedly states tiered item limits (10k standard / 100k Enterprise / up to 1M CRM Enterprise, beta) — direct fetch of this page returned a 403, so this is via search-engine synopsis, not a page read directly, and disagrees with the developer-limits page above without reconciling | Official, unverified by direct read | [support article](https://support.monday.com/hc/en-us/articles/4404058746642-Item-and-subitem-limits-per-board) |
| Linear | Only rate limits are documented (2,500-5,000 req/hour depending on auth); no published item-count ceiling and no anecdotal degradation report found | Official (rate limits only) / gap on scale ceiling | [rate limiting](https://linear.app/developers/rate-limiting) |
| Asana | Only rate limits are documented (150-1,500 req/minute by plan); no specific task-count-to-slowdown threshold found in official docs or community threads | Official (rate limits only) / gap on scale ceiling | [rate limits](https://developers.asana.com/docs/rate-limits) |

### Reading this against Visiban's own numbers

Visiban's `board_full` has no hard cap and never errored at any scale tested (up to 24,052
cards) — it just gets slow, crossing a self-imposed 3x-budget line somewhere around 8,500-14,500
cards. That compares favorably, in scale terms, to Trello's hard 5,000-card wall and Jira's
5,000-item view cap: Visiban remains functional (if slow) well past where those products stop
serving a board at all. That comparison has real limits, though — it's a single-user,
single-process backend number against hosted multi-tenant products under real concurrent load,
which is the harder problem (see the 10-concurrent-user finding above). Nothing here should be
read as "Visiban outperforms Trello" — it should be read as "Visiban's failure mode at scale is
graceful degradation rather than a hard wall, and that's worth knowing," full stop.

## Open follow-ups

- **Frontend render/scroll time was not measured.** This pass only measured backend API
  latency. A board that returns in 2 seconds from the API can still feel broken (or fine) for
  reasons the API number can't see — virtualization, re-render cost, WebSocket event volume on
  a large board. Tracked as a gap, not a finding — see the [`unusable` threshold decision](#finding-the-ceiling-max-cards-and-swimlanes) above.
- **Cards and swimlanes were not varied independently** — see the ceiling section. A fixture
  tool that can hold one axis fixed would let a future pass answer "is it cards or lanes that
  drives the cost" rather than "cards-and-lanes-together."
- **The 10-concurrent-user number is for one `daphne` process**, not a production topology.
  Re-running behind multiple workers (or a proper ASGI process manager) would give a more
  representative concurrency ceiling.
- **The ceiling escalation used 15-sample runs on a noisy shared machine** (see the scale-80
  anomaly). Tightening the crossing-point estimate needs repeated runs on a quieter or
  dedicated host.
- **No calibration entry exists yet** linking these numbers to what real users report once 1.2
  ships. `/voc-audit --calibrate` scores Voice-of-Customer persona-panel predictions against
  real reports (see `.claude/persona-calibration.md`) but is scoped to user-facing feature
  predictions, not backend latency numbers — there's no equivalent mechanism for this page's
  claims today. A future pass should check these numbers against real 1.2 performance reports
  rather than treating them as settled once written down.
