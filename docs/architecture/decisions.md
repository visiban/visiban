<a id="technology-decisions"></a>

# Why the stack is a boring monolith

Why each piece of the Visiban stack was chosen, not just what was chosen, for contributors, self-hosters, and anyone evaluating the trade-offs.

**Why it matters:** the stack follows one rule: the simplest thing that could work correctly and securely.

**The big picture:** one containerized monolith, with an upgrade path to Kubernetes.

---

## Guiding principle

**The rule:** choose the simplest thing that could work correctly and securely, and add complexity only when it earns its place.

Visiban is a containerized monolith with a clear upgrade path to Kubernetes. The default deployment has no microservices, no message queues, and no separate search index. Each has a real cost (operational overhead, more failure modes, more moving parts for a self-hoster), and none was justified at Visiban's out-of-the-box scale.

**Yes, but:** the upgrade path exists. Valkey is already present for WebSocket channel messaging, and the Helm chart deploys today what a Kubernetes migration would need. The complexity is just not paid upfront.

---

## Django + Django REST Framework

**Decision:** Django is a battle-tested framework with a large, stable ecosystem and a well-understood security model.

- **Security built in.** The ORM avoids raw SQL by default: parameterized queries are the path of least resistance, not something to remember.
- **Validation at the boundary.** Django REST Framework adds serializer-level validation and permission enforcement from day one, so auth and input shape are checked before business logic runs.
- **Contribution.** Django is one of the most widely understood Python frameworks, so a contributor can navigate the backend with no project-specific learning curve.
- **Tooling.** `bandit` (security linting) and `ruff` (style and correctness) integrate naturally into CI for Django/Python projects; they weren't added specially for Visiban.

---

## Django Channels + ASGI (daphne)

**Decision:** Django Channels handles WebSockets inside the same Django codebase. The alternative, a separate Node.js service, would have doubled the operational surface: a second language runtime, process to monitor, and image to maintain.

Moving from gunicorn (WSGI) to daphne (ASGI) was the only infrastructure change. All existing HTTP views, serializers, and middleware kept working unmodified.

Two design choices keep the WebSocket layer correct:

- **Broadcast after commit.** Every board mutation broadcasts only after `transaction.on_commit()`, so clients never get an event for a write that was rolled back. Without the guard, a failed transaction could leave clients holding state that is not in the database.
- **Keepalive.** The server pings every 30 seconds. NAT gateways and reverse proxies silently drop idle TCP connections on environment-dependent timescales; the frontend auto-reconnects on a missed ping.

---

## MCP server (in-process, not a REST client)

**Decision:** the MCP server is mounted inside the same ASGI app as Django, at `/mcp`. It is not a separate package that calls the REST API.

An earlier decision (#511, 2026-09-14) went the other way, to keep a single surface and avoid duplicated authorization logic. It was superseded on 2026-09-27, once in-process handling addressed those reasons:

- **One permission path.** MCP tools resolve access with the same `get_board_role()` / `get_board_roles()` helpers the REST views use. There is no second copy of the role precedence ladder to audit or let drift.
- **One write path.** MCP writes go through the card-mutation service layer and validate with `CardSerializer`, exactly like REST writes, so validation and side effects (movement records, broadcasts) cannot diverge.
- **No extra process.** A separate package would be one more thing for a self-hoster to deploy, version, and keep in step with the API, the operational cost the guiding principle avoids.

Token scopes and the instance switch (`MCP_SERVER_ENABLED`, off by default) are enforced server-side, so they apply however the server is transported.

**Yes, but:** the **read shape** deliberately differs. MCP returns an agent-friendly card (assignee username and display name, label names, nested column and swimlane names) rather than the REST payload. Because it is hand-written, a parity test ensures a new `CardSerializer` field is either exposed to agents or explicitly excluded, never silently missing (#1176).

---

## PostgreSQL 17

**Decision:** the audit trail is Visiban's defining feature, so a `CardMovement` record must commit atomically with the card position update: both rows land or neither does. PostgreSQL's ACID guarantees make that straightforward. An eventually consistent store would need compensating logic.

Three PostgreSQL capabilities are in active use:

- **JSONB** stores flexible activity payloads. A new event type changes the payload shape without a schema migration, and structured queries stay possible.
- **Functional indexes** enforce case-insensitive username uniqueness in the database. Application-level checks have a race window; a unique index does not.
- **PostgreSQL 17** was chosen to stay current with upstream. Patch releases are in-place upgrades. Major version upgrades (e.g. 16 → 17) are not in-place on a running container: they require a dump-and-restore or pg\_upgrade. The upgrade guide in the deployment docs covers the recommended export-first path.

!!! note "Major version upgrades"
    PostgreSQL major version upgrades are not in-place. Always export your data before upgrading the `postgres` image tag to a new major version. See [Upgrading](../administration/upgrade.md) for the step-by-step procedure.

---

## React 19 + TypeScript + Vite

- **TypeScript** catches contract drift between backend serializers and frontend interfaces at compile time. Without static types, a renamed serializer field silently becomes `undefined` in the browser, an error that surfaces only at runtime in a customer session. With TypeScript it is a build failure.
- **Matching interfaces.** `Board`, `Card`, `User`, and related interfaces match backend serializer fields exactly, by convention and the type system: when a backend field is added or renamed, the TypeScript interface is updated in the same MR.
- **Vite** keeps iteration fast. Hot module replacement suits the component structure and avoids the multi-second rebuilds of older bundlers.
- **React 19** concurrent rendering keeps the board responsive during large drag operations across many swimlanes. A dense grid of dozens of cards would visibly jank under synchronous rendering of large drag state updates.

---

## @dnd-kit

react-beautiful-dnd was the long-time default for Kanban boards; it was deprecated in 2023 and is no longer maintained. `@dnd-kit` is its modern successor: accessible by default, headless (no bundled styles), and built for complex multi-container layouts.

The column × swimlane grid is where simpler drag libraries break down: each card can be dropped into any cell of a two-dimensional grid, not just reordered within a list.

- **Optimistic updates** make the UI feel instant: the card moves visually before the API call completes.
- **Rollback on failure** keeps the board correct: if the server rejects the move, the card returns to its original position.
- **Headless** means drag behavior is fully controlled, with no third-party drag style to fight or override.

---

## Tiptap (ProseMirror)

Card descriptions support rich text (formatting, inline code, mentions, links) matching what engineers and project managers expect from modern tools.

- **Extensions.** Tiptap wraps ProseMirror in an extension-based API. `@mention` autocomplete plugs into the same system as bold or code formatting, so a new inline extension never touches the core editor logic.
- **Markdown storage.** Card content is stored as Markdown server-side, so descriptions are readable outside the UI, exportable, and not locked to an editor's internal format.
- **Why not Slate or Quill:** first-class TypeScript support (no `@types/` shims) and an active extension ecosystem maintained through multiple ProseMirror major versions.
- **Headless.** The editor inherits the design system's styles instead of overriding them with opinionated defaults.

---

## django-allauth headless

Authentication is among the highest-risk areas of any application, so the decision was one well-maintained library for all auth, not in-house flows or several smaller packages.

- django-allauth covers email/password, Google/GitHub/GitLab OAuth, and generic OIDC (Keycloak, Authentik, Okta, Dex, and any OIDC-compliant IdP) from a single dependency. Generic OIDC is part of the OSS distribution: it uses the same `django-allauth` stack as the social providers and needs no enterprise tier.
- Headless API mode separates concerns: the React SPA controls the login screen's look and behavior, while allauth handles OAuth redirects, token exchange, and session management. There is no Django-rendered login page to style or maintain.
- Personal Access Tokens (`vbn_` prefix) sit on top of allauth's session model. Tokens are shown once at creation, stored as a hash at rest, and revoked on password change. The prefix makes them easy to identify in logs and rotate tooling.

> **Note (2026-09-29, #1281):** Headless API mode described above was never actually adopted — `allauth.headless` is not installed, and `backend/visiban/urls.py` mounts no `/_allauth/` route. OAuth/OIDC runs through allauth's browser-based `/accounts/` flow instead. The dead `/_allauth/` nginx proxy blocks (present in both nginx templates and the Helm frontend configmap, but never backed by a route) were removed in #1281. This note corrects the record without rewriting the decision above; a future move to real headless mode would need its own ADR entry.

---

## Valkey (replacing Redis)

**Decision:** the deployed service is **Valkey**, not Redis.

**Why a pub/sub store:** Django Channels needs a channel layer backend for WebSocket group messaging. When a card moves, the event must reach every client watching that board across multiple daphne workers; the channel layer is the pub/sub intermediary. It also serves as the Django cache backend, on a separate database index so cache flushes don't disrupt active WebSocket connections.

**Why Valkey instead of Redis:**

- Redis 7.4 changed its license from BSD-3 to the Redis Source Available License v2 (RSALv2) and SSPL. Neither is approved by the Open Source Initiative (OSI). Visiban is Apache-2.0, an OSI-approved license, and bundling a non-OSI default service creates license friction and contradicts the project's open-source intent.
- Valkey is a BSD-3-licensed fork of Redis created by contributors from AWS, Google, Snap, and others under the Linux Foundation. It is wire-compatible with Redis 7+ (same RESP protocol and command set), so the switch is a drop-in at the infrastructure layer. No code changes to `channels_redis`, the `redis-py` client, the Django `RedisCache` backend, or any other dependency. `REDIS_URL`, `REDIS_CACHE_URL`, and the `redis://` scheme are unchanged.

**Helm:** the chart runs Valkey as its own StatefulSet on the official `valkey/valkey:8-alpine` image, the same major as `docker-compose.prod.yml`. It first used the Bitnami `valkey` subchart, but pinning the subchart did not pin the image: its default was the floating `bitnami/valkey:latest` (Bitnami no longer publishes versioned tags), so a Helm install could change Valkey major on any pod reschedule (#1200). `scripts/helm-structure-check.sh` now fails any rendered image that is untagged or tagged `latest`.

**Yes, but:** persistence is intentionally disabled for the channel layer. A Valkey restart drops in-flight WebSocket messages, but clients reconnect and resync board state from the REST API. Persisting it would complicate operations for no real benefit: board state is the source of truth in PostgreSQL, not Valkey.

---

## Docker Compose + Helm

Self-hosting is a first-class requirement. Deployment must work for a single engineer on a $5 VPS and for a platform team running Kubernetes at scale.

`docker-compose.prod.yml` handles the former. `DB_PASSWORD` and `DOMAIN` fail fast with a descriptive error if unset: no insecure defaults ship in production configuration, and a missing secret is a loud error, not a silent fallback to an empty string.

The Helm chart handles the latter, with two secret management patterns:

- **Chart-managed secrets**: sensitive values go in a gitignored `values.secret.yaml` file. Simple to set up; appropriate for small teams.
- **`existingSecret` passthrough**: the chart references a Kubernetes Secret by name rather than creating one. This works with Vault, Sealed Secrets, External Secrets Operator, and any other external secrets manager; the chart needn't know how the secret was created.

!!! tip "Choosing a secret management pattern"
    If you are running Visiban on a single cluster without an external secrets manager, the chart-managed pattern is simpler. If you have Vault or ESO already in your environment, use `existingSecret` so Helm never holds the plaintext values.

CI image builds use kaniko instead of Docker-in-Docker. kaniko needs no privileged container and runs cleanly on Kubernetes-based CI runners. Docker-in-Docker needs privileged mode or a `docker:dind` sidecar, which add attack surface and don't fit most locked-down Kubernetes runners.

---

## CI pipeline design

The CI pipeline is a gate, not a suggestion: every failing job blocks the merge, with no override path. Key decisions:

**90% backend coverage floor.** The pipeline fails below 90%. The number is high enough to catch regressions without requiring coverage of trivially untestable code (migrations, admin registrations), and the coverage job enforces it, not convention.

**Ruff and ESLint.** Style and correctness are enforced before review, so reviewers spend time on logic, not whitespace or import order. Both tools run on every commit without adding meaningful pipeline time.

**GPL license check.** The project is Apache 2.0, so GPL-2.0 and GPL-3.0 dependencies are blocked: a GPL dependency in an Apache 2.0 project creates a compatibility problem only removal resolves. The job catches it when introduced, not at legal review.

**SAST (Semgrep, Bandit, SonarQube).** Static analysis runs on every MR. Bandit covers Python-specific security patterns (hardcoded secrets, `shell=True`, unsafe deserialization). Semgrep adds cross-language rules, including custom rules for Visiban-specific patterns. SonarQube keeps the persistent quality history.

**Migration safety job.** The job catches the three most common sources of production migration incidents before they ship: missing migrations (a model change with no migration file), destructive column operations (DROP COLUMN in a migration), and NOT NULL columns added without a default (which blocks zero-downtime deploys).

**Claude Code reviewer stage.** A dedicated CI stage runs the Claude Code reviewer on every MR. It catches patterns static analysis misses: incorrect permission checks, missing `transaction.on_commit()` wrappers on broadcast calls, serializer fields that expose more than the endpoint should.

---

## API pagination shapes

> **Note (2026-10-23, #1869):** The change feed (`GET /boards/{id}/events/`) returns `next_cursor` (an integer event id, passed back as `after`) and keeps `next` as a deprecated duplicate with the same value through 1.x, because 1.2.0-beta.1 shipped `next` as a documented public key. The other non-standard list shapes stay as they are: `GET /cards/` uses an opaque string `next_cursor`, and the card timeline (1.1) uses `limit`/`offset` with `next`/`previous` URLs and is frozen. Renaming the feed cursor before GA is additive; after GA it would be a breaking change. Details and rationale: [Pagination shapes](../api/events.md#pagination-shapes).

---

## Flow metric definitions

**Status:** Proposed (2026-11-01, #1532). The owner ratifies it at merge review. Consumers: #448 (metrics dashboard), #458 (per-swimlane cycle time), #459 (bottleneck overlay), #1100 (forecasting), #1151 (MCP flow tools).

**Decision:** every flow metric is computed from `CardMovement` by one service module (`boards/services/flow_metrics.py`, built by #448), using the definitions below. REST, MCP and the Summary and Analytics views call that service. There is one exception: #459's live overlay (see [Bottleneck overlay](#bottleneck-overlay-459)) computes its medians in the browser, from a value the server derives by these rules. A card's time in its current column is not its lead time, and without one written definition the charts would disagree with each other.

**Why it matters:** the same card must give the same number on every chart, in every API response, and in every agent answer. The definitions also say what each number leaves out, so nobody has to reverse-engineer it from a chart.

**Not decided here:** whether these metrics, or the charts built on them, are OSS or Enterprise. [The open-core boundary](open-core-boundary.md) lists "Advanced analytics (cycle time dists, CFD)" as Enterprise. That classification belongs to #448 (open) and its enterprise-check ruling. This record only fixes what the numbers mean, wherever they ship.

### Terms

- **Done column.** A column with `Column.is_done = true`. Every done column is terminal, whatever its position: "Closed Won" and "Closed Lost" both end a card's flow. Flags are read as they are at query time, so marking a column done applies to its past too. *Rejected:* recording the flag on each movement, which needs a schema change for a flag that rarely changes. *Rejected:* separate "succeeded" and "abandoned" done kinds, which needs a new column flag nobody has asked for yet.
- **Known column.** A movement's source or destination column is known when its uid snapshot (`from_column_uid` / `to_column_uid`) or its name snapshot is not empty. A column that was deleted after the move is still known, through its snapshots.
- **Transition.** A movement with `movement_type = move` whose source and destination columns are both known and differ, compared by uid snapshot, or by name snapshot on rows that have no uid. A swimlane-only move is not a transition. Archive and restore events (`archived`, `unarchived`) are not transitions.
- **Creation movement.** The card's earliest movement, if its source column is empty (no uid and no name) and its destination column is known. `create_card` writes it, and a JSON import with card history copies it from the file.
- **Unattributable movement.** Any later movement with an empty source or destination column. Native rows rarely have one, because they keep their snapshots when a column is deleted. They come from JSON imports: export writes column names from the foreign key, not the snapshot, so a column that had been deleted before the export arrives as an empty name.
- **Complete history.** A card has complete history when it has a creation movement and no unattributable movement. Cards without complete history: cards created by a Trello or CSV import, by a JSON import without card history, or before a creation movement was recorded, and imported cards whose history names a deleted column.
- **Completion.** The card's first entry into a done column: the creation movement, if the card was created in a done column, or else its first transition into one. Moving between two done columns is not a new completion.
- **Reopen.** A transition from a done column to a column that is not done.
- **Cycle start.** For a card created in a column that is not done, its first transition out of that column, if that transition goes to a column that is not done. A card created in a done column, or whose first transition goes to a done column, has no cycle start.
- **In progress.** A card is in progress when it is not archived, its current column is not done, it has complete history, and it has a cycle start or a reopen.
- **Visit.** One stay of a card in one column. A visit opens at a transition into the column, at the creation movement, or at an `unarchived` event. It closes at the next transition, at an `archived` event, or at an unattributable movement. A visit with no later closing event is open: the card is still there. A visit opened by an unattributable movement has no column and is not measured.

### The four metrics

| Metric | Start | End | Measured for |
|---|---|---|---|
| **Lead time** | The creation movement's `moved_at`, or `Card.created_at` for a card without one | Completion | Completed cards, except cards created in a done column |
| **Cycle time** | Cycle start | Completion | Completed cards with complete history and a cycle start |
| **Dwell time** | Visit opens | Visit closes, or now for an open visit | Visits to columns that are not done |
| **Age** (WIP age) | The cycle start or the latest reopen, whichever is later | Now | Cards in progress |

Definition strings, quoted verbatim by the docs and returned in each metric response's `definition` field:

- **Lead time:** the time from when a card was created to its first entry into a done column.
- **Cycle time:** the time from a card's first move out of the column it was created in, to a column that is not done, until its first entry into a done column. A card created in a done column, or moved straight from its first column to done, has no cycle time.
- **Dwell time:** how long a card stayed in one column, from entering it to leaving it, or until now if it is still there. Moving to another swimlane does not end a stay. Archiving ends it, and restoring starts a new one.
- **Age:** how long an in-progress card has been in progress: the time since it first moved out of the column it was created in, or since it last left a done column, whichever is later.
- **Throughput:** the number of cards whose first entry into a done column falls in a period.
- **Cumulative flow:** for each day, the number of cards in each column at the end of that day.

Rationale and rejected alternatives:

- **Lead time starts at the card's creation, read from the creation movement when there is one.** For a native card, the creation movement and `Card.created_at` are the same transaction. For a JSON import with history, the creation movement keeps the file's time, but `Card.created_at` falls back to the import time when the file's `created_at` is missing, in the future, or later than the card's own history (#1906). Reading the movement first keeps those cards correct. A card without a creation movement uses `Card.created_at`, which the Trello import restores from the Trello object id. *Known limitation:* a CSV-imported card, or a JSON import without history whose file has no usable `created_at`, is dated to the import, so its lead time starts there.
- **No duration is ever negative.** An imported row can carry a timestamp out of order with the rest of the card's history. A lead, cycle or dwell value whose end is before its start is dropped and counted in `excluded_incomplete_history`. It is never clamped to zero, which would invent a duration.
- **Cycle time starts at the first pull, not at the first movement.** The first movement of a native card is its creation movement, so "first movement to done" (the definition in `summary` today and in #448's body) measures lead time under another name. Starting at the first transition out of the creation column needs no new configuration. It matches the templates, where only the first column allows card creation. *Rejected:* a per-column "commitment point" flag. It is more precise, but it needs a schema and UI change. It is the follow-up if users report that the first-pull rule picks the wrong start. *Known limitation:* a card created directly in a working column starts its cycle when it first leaves that column.
- **A card that goes from its creation column straight to done has a lead time but no cycle time.** It still counts toward throughput. The same goes for a card created in a done column, which also has no lead time. A zero-length cycle is bookkeeping, not flow, and would drag the percentiles toward zero. *Rejected:* counting it as zero.
- **Dwell time is measured per visit and never in a done column.** This confirms what `analytics.py` does today: time in a done column is post-completion idle time. Two statistics come from it: **completed dwell** (visits that closed, assigned to the window their visit closed in, at their full length) and **current dwell** (open visits, measured now). The old analytics field `age_avg_days_per_column` is current dwell, not age.
- **Age means WIP age, compared with cycle-time percentiles.** That is the aging chart #448's spec draws ("15.4 days in progress, beyond 85th percentile"). Time in the current column is current dwell, compared with the completed-dwell percentiles of the same column. That is what #1151's `aging_cards` describes. Its payload calls the value `current_dwell_days`, not `age`. #448's test-plan line "WIP age = days since entering current non-done column" is superseded.
- **Lead time, cycle time and age are elapsed time, including any archived period.** Only a visit ends at an archive, because a visit is a stay in a column on the live board.

### Reopened cards

**Decision:** the first completion is the anchor. A reopened card keeps the lead time, cycle time and throughput period of its first completion. A second completion does not add to throughput or move the card into another period. A card with no cycle start before its first completion (created in a done column, or moved straight to done) gets no cycle time from a later round of work either. While the card is open again, it is in progress: its age runs from the reopen, and its visits count toward dwell time like any other.

This confirms the decision recorded in #448 ("backward moves do not reset cycle — the first completion is the anchor"). History stays stable: reopening a card from six months ago does not rewrite that period's throughput or a published p85. *Rejected:* restarting the clock at the final completion, which rewrites past charts. *Rejected:* adding the rework time to the original cycle, which turns one card into a forecast outlier. *Rejected:* excluding reopened cards, which hides rework. Each sample in a drill-down carries `reopened: true` when the card was reopened later, so rework stays visible without changing the numbers.

### Edge cases

C is the creation column. C is "work" when it is not done. Every case has complete history. A case without complete history follows the same row and then drops cycle time and age (see [Missing history](#missing-history)).

| Path | Lead time | Cycle time | Throughput | Age while open | Dwell time |
|---|---|---|---|---|---|
| work C → Doing → Done | created → Done | Doing → Done | once, at Done | from Doing, until Done | each visit to C and Doing |
| work C → Done | created → Done | none | once | none (never in progress) | the visit to C |
| work C → Done → reopen to Doing → Done | created → first Done | none | once, at first Done | from the reopen | C, then Doing |
| work C → Doing → Done → reopen to Review → Done | created → first Done | Doing → first Done | once, at first Done | from Doing, then from the reopen | C, Doing, Review |
| done C, stays | none | none | once, at creation | none | none (done column) |
| done C → reopen to Doing → Done | none | none | once, at creation | from the reopen | the visit to Doing |
| work C, never moved | none | none | none | none (no cycle start) | open visit to C |
| work C → Doing → back to C | none yet | none yet | none yet | from Doing, still running | C, Doing, C |
| work C → Doing → archived | none | none | none | none (archived) | C, and Doing until the archive |
| work C → Done → archived | created → Done | none | once | none | the visit to C |

Every value with an end has a start before it in the order of events: a cycle start comes before the first done entry, because it leaves a column that is not done for another one that is not done. Only out-of-order timestamps can produce a negative value, and the no-negative rule drops those.

### Missing history

| Case | Lead time | Cycle time | Age | Dwell time | Throughput |
|---|---|---|---|---|---|
| No creation movement (Trello or CSV import, JSON import without history, cards created before the creation movement was recorded) | From `Card.created_at`, once it completes | Excluded | Excluded | Only visits that a recorded movement opened | At its first recorded completion |
| JSON import with card history | From the imported creation movement | Yes | Yes | Yes | Yes |
| JSON import whose history names a deleted column (unattributable movements) | From the imported creation movement | Excluded | Excluded | Visits with a known column only | At its first recorded completion |
| Any value whose end is before its start (out-of-order imported timestamps) | Excluded | Excluded | Excluded | That visit excluded | Unaffected |
| Hard-deleted card (movements kept since #1469, `card` is NULL) | Excluded | Excluded | Excluded | Excluded | Excluded |
| Movements removed by `purge_card_history` (#1797) | Follows from what is left | Follows from what is left | Follows from what is left | Follows from what is left | Follows from what is left |
| Card deleted before 1.2 (movements cascade-deleted) | Gone | Gone | Gone | Gone | Gone |

- **Imported history counts like native history,** except where the file has lost a column name. Imported rows keep the file's timestamps, and `imported_from_username` records only who the source named. Export writes the creation movement, so a re-imported board has complete history unless a column had been deleted before the export. *Known limitation:* export writes column names from the foreign key (`mv.from_column.name`), not from the name snapshot, so such rows arrive with an empty column. These rules do not depend on that being fixed. A fix in export would simply turn those cards back into complete history.
- **Deleted cards stay out of the metrics,** as `card-history.md` already promises. A drill-down must open a card, and deleting a card says it should not have existed. *Rejected:* counting them through `CardMovement.board`, which would show numbers no drill-down can explain.
- **No exclusion is silent.** Every duration response reports `sample_size` and `excluded_incomplete_history`. The second counts cards, or visits for dwell, that were left out only for missing or out-of-order history.
- **A column that has since been deleted is never a done column,** because its flag is gone with it. A transition into it still counts as a cycle start. A movement whose column foreign key no longer resolves falls back to the column name, as `analytics.py` does today, so a column deleted and recreated under the same name keeps its dwell.

### Blocked time

**Decision:** lead time, cycle time, dwell time and age are elapsed time, and blocked time is inside them. Blocked time is reported as its own metric from the `CardBlock` rows of #1149: total, per column and per reason. It is never subtracted. Block events are never written to `CardMovement`, so they cannot open or close a visit (the #1149 architect review, 2026-11-01). A customer waits whether the card is blocked or not, and subtracting blocked time would make flow look better than it is. A flow-efficiency ratio (unblocked ÷ elapsed) can be added later from the same rows without changing any definition here.

### Percentiles and sample size

**Decision:** every flow output uses the same three percentiles: **p50, p85 and p95**. #1151's `aging_cards` also accepts any percentile. #1100's forecast ranges are the same 50/85/95. #458 asked for P50 and P90. It uses p50 and p85 instead, so the dashboard, the forecast and agents share one vocabulary. *Rejected:* adding p90 for #458, which puts a fourth line next to p85 that people would compare without a reason.

**Decision:** percentiles use the **nearest-rank** method: sort the sample ascending and take the value at rank ⌈p/100 × n⌉. That is PostgreSQL's `percentile_disc`. The result is always a real card's duration, so a drill-down can point at the card, and the same answer comes from SQL, Python, JavaScript and a hand count. *Rejected:* linear interpolation (`percentile_cont`, NumPy's default, `statistics.quantiles`), which reports durations no card had and differs between libraries at small n. The median is p50 by the same method, so for an even n it is the lower of the two middle values. The old field `board_medians` keeps `statistics.median`, as the 1.x contract requires.

**Decision:** a percentile in a metric response is returned only when the sample has **at least 5** values **and** the percentile's rank is below n, so that it is not just the largest value. With nearest rank, that means p50 needs n ≥ 5, p85 needs n ≥ 7, and p95 needs n ≥ 20. An arbitrary percentile follows the same rule. Below that, the API returns `null` for that percentile, next to `sample_size`. The minimum lives in one backend constant, so the API and the UI cannot disagree. Five matches #448's design spec. The rank rule stops a p95 drawn from six cards claiming to be a tail. #458's "insufficient data" state uses the same floor. *Rejected:* one flat threshold, which either hides p50 for small teams or presents the maximum as a p95. *Rejected:* #458's threshold of 3, which is too few for a median that people compare between swimlanes.

Durations are computed in seconds and reported in days (seconds ÷ 86,400). Percentiles are taken before rounding, and values are rounded to one decimal only for display.

### Bottleneck overlay (#459)

**Decision:** #459's overlay shows each cell's **current dwell**: how long the cards now in that column and swimlane have been in their open visit. It does not show completed dwell. Under the #459 architect review (2026-11-01), the value is live and filter-aware, so the browser computes it from the cards it has loaded, not from a board-wide endpoint.

- **The definition stays on the server.** The board payload gains one additive, nullable field, `column_entered_at`: the start of the card's open visit, computed by the visit rules above (a swimlane-only move does not reset it, a restore does, and a reopen opens a new visit). It is `null` for a card in a done column or one with no recorded movement. The browser computes only `now − column_entered_at` and the cell's nearest-rank median.
- **The sample-size floor does not apply to the overlay.** A cell with one to four cards shows its median, with the card count on the badge. The overlay describes the cards on screen; it does not estimate a distribution. On a small team, the floor would blank most cells. Done cells and empty cells stay `null`. *Rejected:* applying the n ≥ 5 floor to cells.

### Time zones, windows and business days

- **Elapsed calendar time, in UTC.** Durations are the difference between two UTC timestamps (`TIME_ZONE = "UTC"`, `USE_TZ = True`). Weekends and holidays count. *Rejected:* business days, which need a working calendar and holiday set per board that Visiban does not have. The customer waits on calendar time. If a business-day view is requested, it becomes its own option, and the definitions above do not change.
- **Bucketing in UTC.** Daily buckets (throughput per day for #1100, CFD days for #448) are UTC dates. Weeks are ISO 8601 weeks, starting Monday in UTC. *Rejected:* the viewer's `timezone` preference, which would give two viewers, or a viewer and an MCP agent, different numbers for the same board. The cost is that a completion late on a Friday in UTC−8 lands in Saturday's bucket.
- **Windows.** `days=N` is a rolling window `[now − N × 24h, now)`, as `analytics.py` uses today. A date-range filter (`from_date`, `to_date`) takes UTC dates, inclusive at both ends: `[from_date 00:00Z, to_date + 1 day 00:00Z)`. Lead time, cycle time and throughput samples belong to the window their completion falls in. A completed-dwell sample belongs to the window its visit closed in. Age and current dwell are snapshots at the moment of the request and take no window.
- **Filters.** The swimlane filter uses the card's current swimlane, as the board movements endpoint's `swimlane_id` filter does. The label filter uses the card's current labels. *Rejected:* the swimlane at completion time, which needs a per-movement lookup, and cards rarely change swimlane.

### Cumulative flow

**Decision:** each card is counted at the end of each UTC day in the column of its latest transition up to that moment, or of its creation movement. A card without a creation movement is placed from `Card.created_at` in the source column of its earliest movement, or in its current column if it has none. A card archived in a column that is not done leaves the diagram from the day of the archive. A card in a done column stays counted after it is archived, because finished work is cumulative and archiving it must not shrink the done band. Hard-deleted cards are left out.

### Response shapes (for #448, #458, #1100 and #1151)

Every metric response carries `definition` (the string above). Percentile objects are `{p50, p85, p95}`, each a number of days or `null` under the sample-size rule. The samples are the drill-down: the 2026-10-08 criteria ask for cards, transitions and owners, and the client gets transitions from the existing card movements endpoint and owners from the card. There is no separate drill-down endpoint. *Rejected:* card-id lists without values, which force a second request to explain a dot on the scatter.

| Metric | Top-level fields | One sample |
|---|---|---|
| Lead time, cycle time | `definition`, `sample_size`, `excluded_incomplete_history`, `percentiles` | one per card: `card_uid`, `value_days`, `start`, `end`, `reopened` |
| Completed dwell | the same, per column: `columns: [{column_uid, column_name, sample_size, percentiles}]` | one per visit: `card_uid`, `column_uid`, `value_days`, `start`, `end`, `reopened` |
| Current dwell | the same as completed dwell | one per open visit: `card_uid`, `column_uid`, `value_days`, `start`, `end: null` |
| Age | `definition`, `sample_size`, `excluded_incomplete_history`, and `cycle_time_percentiles` over the same filters, for the aging zones | one per in-progress card: `card_uid`, `column_uid`, `value_days`, `start` |
| Throughput | `definition`, `period` (`day` or `week`), `total` | one per period: `start` (UTC date), `count`, `card_uids` |
| Cumulative flow | `definition`, `columns: [{column_uid, column_name, is_done}]` in position order, `days: [{date, counts: {column_uid: n}}]` | the same endpoint with `date=YYYY-MM-DD` returns `{date, columns: [{column_uid, card_uids}]}`, the cards behind that day's counts |

### Where current code disagrees

None of these change in this ADR. #448 changes each one when it builds the service, with a `changed` changelog fragment and no field removed or retyped (1.x contract).

| Code today | Disagreement | Change |
|---|---|---|
| `summary` `avg_cycle_days` (`analytics.py`, query 3) | Starts at the first movement of any kind (for native cards, the creation movement, so it measures lead time). Ends at the earliest done entry *inside the last 30 days*, not the first completion. Leaves out archived cards. | Recompute as the mean cycle time of cards whose completion falls in the last 30 days. The field stays a mean, because its documented name says average. |
| `summary` `velocity_7d`, `velocity_30d`, `done_30d` (query 2) | Counts movement rows into done columns, so a card that bounces or moves Done → Released counts twice. Leaves out completed cards that were archived later. | Count cards by completion, archived or not. |
| `analytics` throughput dwell (`throughput_avg_days_per_column`) | A swimlane-only move splits a visit. The `archived` row opens a near-zero visit, and for a restored card the archived period counts as dwell. The 2× prefetch buffer drops visits that began before it, so the longest visits are lost. | Visits per this ADR, opened at their true start whatever the window. |
| `analytics` current dwell (`age_avg_days_per_column`, `_last_col_entry_at`) | A swimlane-only move or an archive event resets the entry time. | Use the start of the open visit, the same value as `column_entered_at`. |
| `analytics` `avg_days_per_column` (clamped) and `deal_velocity_days` | Neither is a flow metric in this ADR. `deal_velocity_days` is the span from a card's first movement ever to its most recent movement, for cards whose most recent movement falls in the window, whether or not the card finished. | Frozen as old fields. No new consumer reads them, and the docs must not call them cycle time. |
| Heatmap statistic (mean) | #459 uses the median. | The overlay uses the nearest-rank median of current dwell. The heatmap's existing mean fields stay as they are. |
| `notify_stale_cards`, `last_moved_at`, stalled cards | Time since the last movement of any kind. | None: staleness is a separate signal, not a flow metric. |

### Changes handed to #448

Written to be copied into #448 as they stand:

1. Build `boards/services/flow_metrics.py` as the only implementation of lead time, cycle time, dwell time (completed and current), age, throughput and cumulative flow, using the terms and rules of the *Flow metric definitions* record in `docs/architecture/decisions.md`. The REST endpoints, the #1151 MCP tools, #458 and the `summary` and `analytics` views call it.
2. Return the response shapes the record pins: `definition`, `sample_size`, `excluded_incomplete_history`, `percentiles` (`p50`/`p85`/`p95`, nearest rank, `null` under the n ≥ 5 and rank-below-n rule) and per-card or per-visit `samples`, plus the throughput and cumulative-flow shapes. Keep the sample-size minimum in one backend constant.
3. Recompute `summary.avg_cycle_days` as the mean cycle time of cards whose first completion falls in the last 30 days, including cards archived since. Add a `changed` fragment.
4. Recompute `summary.velocity_7d`, `velocity_30d` and `done_30d` as counts of cards by first completion, archived or not, and no longer as counts of movement rows. Add a `changed` fragment.
5. Recompute `analytics.throughput_avg_days_per_column` from visits: a swimlane-only move does not split a visit, an `archived` event closes it, an `unarchived` event opens a new one, and a visit's true start is used even when it began before the 2× prefetch buffer.
6. Recompute `analytics.age_avg_days_per_column` from the start of each card's open visit, so that swimlane-only moves and archive events no longer reset it. Its docs say it is current dwell, not age.
7. Leave `avg_days_per_column`, `deal_velocity_days` and `board_medians` as frozen legacy fields. Do not read them from new code.
8. Add the additive, nullable `column_entered_at` card field (the start of the open visit) for #459, computed by the same service.
9. Supersede the body's "cycle time = first movement → first done-column entry" and the test-plan line "WIP age = days since entering current non-done column". Cycle time starts at the first pull out of the creation column, and WIP age at the cycle start or the latest reopen.
10. Quote the record's definition strings verbatim on each metric's docs page.

**Yes, but:** the first-pull cycle start and the UTC buckets are the two choices most likely to be revisited. Both have named follow-ups (a commitment-point flag, a board time zone) that would add an option without changing what the existing numbers mean.
