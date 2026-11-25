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

**License check.** The project is Apache 2.0, so GPL, AGPL, SSPL and BUSL dependencies are blocked (LGPL and MPL are allowed): such a dependency creates a compatibility problem only removal resolves. An empty or unknown license is blocked too. The check is a blocklist, not an allowlist: another license string it does not recognize, such as `Commercial`, passes. The job catches it when introduced, not at legal review.

**SAST (Semgrep, Bandit, SonarQube).** Static analysis runs on every MR. Bandit covers Python-specific security patterns (hardcoded secrets, `shell=True`, unsafe deserialization). Semgrep adds cross-language rules, including custom rules for Visiban-specific patterns. SonarQube keeps the persistent quality history.

**Migration safety job.** The job catches the three most common sources of production migration incidents before they ship: missing migrations (a model change with no migration file), destructive column operations (DROP COLUMN in a migration), and NOT NULL columns added without a default (which blocks zero-downtime deploys).

**Claude Code reviewer stage.** A dedicated CI stage runs the Claude Code reviewer on every MR. It catches patterns static analysis misses: incorrect permission checks, missing `transaction.on_commit()` wrappers on broadcast calls, serializer fields that expose more than the endpoint should.

---

## API pagination shapes

> **Note (2026-10-23, #1869):** The change feed (`GET /boards/{id}/events/`) returns `next_cursor` (an integer event id, passed back as `after`) and keeps `next` as a deprecated duplicate with the same value through 1.x, because 1.2.0-beta.1 shipped `next` as a documented public key. The other non-standard list shapes stay as they are: `GET /cards/` uses an opaque string `next_cursor`, and the card timeline (1.1) uses `limit`/`offset` with `next`/`previous` URLs and is frozen. Renaming the feed cursor before GA is additive; after GA it would be a breaking change. Details and rationale: [Pagination shapes](../api/events.md#pagination-shapes).

---

## Flow metric definitions

**Status:** Accepted (2026-11-01, #1532). A later change of mind is recorded as a dated note below the record, as the django-allauth entry above does, and never as a silent rewrite. Consumers: #448 (metrics dashboard), #458 (per-swimlane cycle time), #459 (bottleneck overlay), #1100 (forecasting), #1151 (MCP flow tools).

**Decision:** every flow metric is computed from `CardMovement` by one service module (`boards/services/flow_metrics.py`, built by #448), using the definitions below. REST, MCP and the Summary and Analytics views call that service. There is one exception: #459's live overlay (see [Bottleneck overlay](#bottleneck-overlay-459)) computes its medians in the browser, from a value the server derives by these rules. A card's time in its current column is not its lead time, and without one written definition the charts would disagree with each other.

**Why it matters:** the same card must give the same number on every chart, in every API response, and in every agent answer. The definitions also say what each number leaves out, so nobody has to reverse-engineer it from a chart.

**Not decided here:** whether these metrics, or the charts built on them, are OSS or Enterprise. That was ruled separately on 2026-11-02 (#1750): the #448 charts are OSS, as recorded in [Analytics (split)](open-core-boundary.md#analytics-split). This record only fixes what the numbers mean, wherever they ship.

### Terms

- **Movement order.** A card's movements are ordered by `moved_at`, with ties broken by `id`. "Earliest", "first", "next" and "latest" all refer to this order. Native rows are written in the same transaction as the change they record, so their `id` and `moved_at` orders agree. A JSON import inserts rows in file order and then writes the file's `moved_at`, so a hand-edited file can give a different `id` order; the `moved_at` order still wins.
- **Column key.** The identity of a column in a movement row. It is the uid snapshot (`from_column_uid` / `to_column_uid`) when that is not empty. Otherwise it is the uid of the column the foreign key still points to. Otherwise it is the name snapshot, marked as a name. If all three are empty, the column is **unknown**. Every rule below identifies columns by this key: transitions, done columns, visits, response shapes and cumulative flow.
- **Current column.** A column key matches a current column only when it equals that column's uid. A name never matches a current column, so a column that was deleted and then recreated under the same name is a different column.
- **Done column.** A current column with `Column.is_done = true`. A movement enters a done column only when its destination key matches one. Every done column is terminal, whatever its position: "Closed Won" and "Closed Lost" both end a card's flow. Flags are read as they are at query time, so marking a column done applies to its past too. A deleted column is never a done column, because its flag is gone with it. *Rejected:* recording the flag on each movement, which needs a schema change for a flag that rarely changes. *Rejected:* separate "succeeded" and "abandoned" done kinds, which needs a new column flag nobody has asked for yet.
- **Transition.** A movement with `movement_type = move` whose source and destination columns are both known and have different column keys. A swimlane-only move is not a transition. Archive and restore events (`archived`, `unarchived`) are not transitions.
- **Creation movement.** The card's earliest movement, if its source column is empty (no uid and no name) and its destination column is known. `create_card` writes it, and a JSON import with card history copies it from the file.
- **Unattributable movement.** A movement whose destination column is unknown, or whose source column is unknown when it is not the creation movement. Native rows rarely have one, because they keep their snapshots when a column is deleted. They come from JSON imports of pre-1.3 exports: those wrote column names from the foreign key, not from the snapshot, so a column deleted before the export arrived as an empty name (#2052; exports made since 1.3 write the snapshot name). That includes a creation movement whose column was deleted, which then does not count as a creation movement.
- **Continuity.** A card's history is continuous when each transition's source column key equals the destination key of the transition, or creation movement, before it. In addition, the latest destination must match the card's `Card.column`, and the card's archive state must agree with its latest archive or restore event: `archived_at` is set exactly when that event is `archived`. Continuity breaks when something changed the card without writing a movement: an edit of the column or `archived_at` in the Django admin (`CardAdmin` writes no `CardMovement`), an import that sets `archived_at` without an `archived` row, or a `purge_card_history` window (`--since` / `--before`) that removed rows in the middle of a live card's history.
- **Complete history.** A card has complete history when it has a creation movement, has no unattributable movement, and its history is continuous. Cards without complete history: cards created by a Trello or CSV import, by a JSON import without card history, or before a creation movement was recorded; imported cards whose history names a deleted column (pre-1.3 exports); and cards whose continuity is broken.
- **Completion.** The card's first entry into a done column: the creation movement, if the card was created in a done column, or else its first transition into one. Moving between two done columns is not a new completion.
- **Reopen.** A transition from a done column to a column that is not done.
- **Cycle start.** For a card created in a column that is not done, its first transition out of that column, if that transition goes to a column that is not done. A card created in a done column, or whose first transition goes to a done column, has no cycle start.
- **In progress.** A card is in progress when it is not archived, its current column is not done, it has complete history, and it has a cycle start or a reopen.
- **Visit.** One stay of a card in one column, keyed by column key. A visit opens at a transition into the column, at the creation movement, or at an `unarchived` event. It closes at the next transition, at an `archived` event, or, for an archived card with no `archived` event, at `Card.archived_at`. A visit with no closing event is open: the card is still there. A visit is not measured when its column is unknown, when the movement that closes it leaves from a different column key (continuity broke inside it), or when it is open but its column does not match `Card.column`.

### The metrics

| Metric | Start | End | Measured for |
|---|---|---|---|
| **Lead time** | The creation movement's `moved_at`, or `Card.created_at` for a card without one | Completion | Completed cards, except cards created in a done column |
| **Cycle time** | Cycle start | Completion | Completed cards with complete history and a cycle start |
| **Dwell time** | Visit opens | Visit closes, or now for an open visit | Measured visits to columns that are not done |
| **Age** (WIP age) | The cycle start or the latest reopen, whichever is later | Now | Cards in progress |
| **Throughput** | — | Completion | Every completed card, once, in the period of its completion |
| **WIP** | — | Now | Cards not archived, per current column that is not done, read from `Card.column` |

Definition strings, quoted verbatim by the docs and returned in each metric response's `definition` field:

- **Lead time:** the time from when a card was created to its first entry into a done column. A card created in a done column has no lead time.
- **Cycle time:** the time from a card's first move out of the column it was created in, to a column that is not done, until its first entry into a done column. A card created in a done column, or moved straight from its first column to done, has no cycle time.
- **Dwell time:** how long a card stayed in one column, from entering it to leaving it, or until now if it is still there. Moving to another swimlane does not end a stay. Archiving ends it, and restoring starts a new one.
- **Age:** how long an in-progress card has been in progress: the time since it first moved out of the column it was created in, or since it last left a done column, whichever is later.
- **Throughput:** the number of cards whose first entry into a done column falls in a period.
- **WIP:** the number of cards, not archived, currently in each column that is not done.
- **Cumulative flow:** for each day, the number of cards in each column at the end of that day.

Rationale and rejected alternatives:

- **Lead time starts at the card's creation, read from the creation movement when there is one.** For a native card, the creation movement and `Card.created_at` are the same transaction. For a JSON import with history, the creation movement keeps the file's time, but `Card.created_at` falls back to the import time when the file's `created_at` is missing, in the future, or later than the card's own history (#1906). Reading the movement first keeps those cards correct. A card without a creation movement uses `Card.created_at`, which the Trello import restores from the Trello object id. *Known limitation:* a CSV-imported card, or a JSON-imported card without a creation movement whose file has no usable `created_at`, is dated to the import, so its lead time starts there.
- **No duration is ever negative, and no history is dated in the future.** The import accepts any parseable `moved_at`, including one in the future. A card with a movement dated after the moment of the request has incomplete history, and that movement and the ones after it are ignored. A lead time, cycle time, dwell time or age whose end is before its start is dropped and counted in `excluded_incomplete_history`. This can happen when a card's start is `Card.created_at` and that date is later than its imported completion. It is never clamped to zero, which would invent a duration.
- **Cycle time starts at the first pull, not at the first movement.** The first movement of a native card is its creation movement, so "first movement to done" (the definition in `summary` today and in #448's body) measures lead time under another name. Starting at the first transition out of the creation column needs no new configuration. It matches the templates, where only the first column allows card creation. *Rejected for now:* a per-column "commitment point" flag. It is more precise, but it needs a schema and UI change, and it is tracked as #2050 (an opt-in per-board commitment column was added on 2026-11-17; see the dated note at the end of this record). *Known limitation:* a card created directly in a working column starts its cycle when it first leaves that column.
- **A card that goes from its creation column straight to done has a lead time but no cycle time.** It still counts toward throughput. A card created in a done column counts toward throughput and has neither. A zero-length cycle is bookkeeping, not flow, and would drag the percentiles toward zero. *Rejected:* counting it as zero.
- **Dwell time is measured per visit and never in a done column.** This confirms what `analytics.py` does today: time in a done column is post-completion idle time. Two statistics come from it: **completed dwell** (visits that closed, assigned to the window their visit closed in, at their full length) and **current dwell** (open visits, measured now). The old analytics field `age_avg_days_per_column` is current dwell, not age.
- **Age means WIP age, compared with cycle-time percentiles.** That is the aging chart #448's spec draws ("15.4 days in progress, beyond 85th percentile"). Time in the current column is current dwell, compared with the completed-dwell percentiles of the same column. That is what #1151's `aging_cards` describes. It returns current-dwell samples (`value_days` in the current-dwell shape below), never a field called `age`. #448's test-plan line "WIP age = days since entering current non-done column" is superseded.
- **WIP comes from the board, not from movements.** A card counts in its current column whatever its history. A board imported without history therefore does not show zero WIP. WIP includes cards that are not yet in progress, such as cards still in a backlog column: it counts what sits in each column, and the consumer chooses which columns to show.
- **Lead time, cycle time and age are elapsed time, including any archived period.** Only a visit ends at an archive, because a visit is a stay in a column on the live board.

### Reopened cards

**Decision:** the first completion is the anchor. A reopened card keeps the lead time, cycle time and throughput period of its first completion. A second completion does not add to throughput or move the card into another period. A card with no cycle start before its first completion (created in a done column, or moved straight to done) gets no cycle time from a later round of work either. While the card is open again, it is in progress: its age runs from the reopen, and its visits count toward dwell time like any other.

This confirms the decision recorded in #448 ("backward moves do not reset cycle — the first completion is the anchor"). History stays stable: reopening a card from six months ago does not rewrite that period's throughput or a published p85. *Rejected:* restarting the clock at the final completion, which rewrites past charts. *Rejected:* adding the rework time to the original cycle, which turns one card into a forecast outlier. *Rejected:* excluding reopened cards, which hides rework. Each sample in a drill-down carries `reopened: true` when the card was reopened later, so rework stays visible without changing the numbers.

### Edge cases

C is the creation column. C is "work" when it is not done. Every case below has complete history unless the row says otherwise. A card without complete history follows the same row, and then has no cycle time and no age (see [Missing history](#missing-history)).

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
| work C → Doing; the admin then edits the column to Done (no movement) | none (no recorded completion) | none (broken continuity) | none | none (done column) | C; the Doing visit is not measured |
| work C → Doing; the admin then sets `archived_at` | none | none | none | none (archived) | C, and Doing until `archived_at` |
| work C → Old Review → Done, then Old Review is deleted and a new "Old Review" is created | created → Done | Old Review → Done | once | none | C and the old column, never credited to the new column |

Every value with an end has a start before it in movement order: a cycle start comes before the first done entry, because it leaves a column that is not done for another one that is not done. Only a start that does not come from movement order (`Card.created_at`) or a future-dated row can produce a negative value, and the no-negative rule drops those.

### Missing history

| Case | Lead time | Cycle time | Age | Dwell time | Throughput |
|---|---|---|---|---|---|
| No creation movement (Trello or CSV import, JSON import without history, cards created before the creation movement was recorded) | From `Card.created_at`, once it completes | Excluded | Excluded | Measured visits only | At its first recorded completion |
| JSON import with card history, every column still present at export | From the imported creation movement | Yes | Yes | Yes | Yes |
| JSON import of a pre-1.3 export whose history names a deleted column (#2052) | From the imported creation movement, or from `Card.created_at` if the creation row lost its column | Excluded | Excluded | Measured visits only | At its first recorded completion |
| Broken continuity (admin column or archive edit, imported `archived_at` without an event, a partial purge window) | From its start, once a recorded completion exists | Excluded | Excluded | Measured visits only | At its first recorded completion |
| A movement dated in the future, or a value whose end is before its start | Excluded if it is the value affected | Excluded | Excluded | That visit excluded | Unaffected unless the completion row is future-dated |
| Hard-deleted card (movements kept since #1469, `card` is NULL) | Excluded | Excluded | Excluded | Excluded | Excluded |
| Card deleted before 1.2 (movements cascade-deleted) | Gone | Gone | Gone | Gone | Gone |

- **Imported history counts like native history,** except where the file has lost a column name. Imported rows keep the file's timestamps, and `imported_from_username` records only who the source named. Export writes the creation movement, so a re-imported board has complete history unless a column had been deleted before the export. Export now writes a movement's column name from its name snapshot when the column has been deleted, so such rows keep their column on re-import (#2052, fixed in 1.3). Exports made before 1.3 still lack those names.
- **Deleted cards stay out of the metrics,** as `card-history.md` already promises. A drill-down must open a card, and deleting a card says it should not have existed. *Rejected:* counting them through `CardMovement.board`, which would show numbers no drill-down can explain.
- **No exclusion is silent.** Every duration response reports `sample_size` and `excluded_incomplete_history`. The second counts cards, or visits for dwell, that were left out only for missing, broken or misdated history.
- **Deleted columns.** A transition into a deleted column still counts as a cycle start, because its key differs from the column it left. Visits to a deleted column count toward a card's cycle and lead time, but no per-column output reports them, because per-column outputs list current columns only. Cumulative flow puts them in one `column_uid: null` band.

### Blocked time

**Decision:** lead time, cycle time, dwell time and age are elapsed time, and blocked time is inside them. Blocked time is reported as its own metric from the `CardBlock` rows of #1149: total, per column and per reason. It is never subtracted. Block events are never written to `CardMovement`, so they cannot open or close a visit (the #1149 architect review, 2026-11-01). A customer waits whether the card is blocked or not, and subtracting blocked time would make flow look better than it is. A flow-efficiency ratio (unblocked ÷ elapsed) can be added later from the same rows without changing any definition here.

### Percentiles and sample size

**Decision:** every flow output uses the same three percentiles: **p50, p85 and p95**. #1151's `aging_cards` also accepts any whole-number percentile from 1 to 99. #1100's forecast ranges are the same 50/85/95. #458 asked for P50 and P90. It uses p50 and p85 instead, so the dashboard, the forecast and agents share one vocabulary. *Rejected:* adding p90 for #458, which puts a fourth line next to p85 that people would compare without a reason.

**Decision:** percentiles use the **nearest-rank** method. Sort the sample ascending (ties in any order) and take the value at the 1-based rank `(p × n + 99) // 100`, computed in integer arithmetic with p a whole number. That is ⌈p × n / 100⌉ without floating point. The result is always a real card's duration, so a drill-down can point at the card. For p50, p85 and p95, this rank equals PostgreSQL's `percentile_disc(p / 100.0)`, which computes in `float8`. That was checked for every n from 1 to 1,000,000. For other percentiles the float can round up (for p = 55 and n = 100, `float8` gives rank 56 and the integer rank is 55), so the service always uses the integer rank, never `percentile_disc`. *Rejected:* linear interpolation (`percentile_cont`, NumPy's default, `statistics.quantiles`), which reports durations no card had and differs between libraries at small n. The median is p50 by the same rank, so for an even n it is the lower of the two middle values. The old field `board_medians` keeps `statistics.median`, as the 1.x contract requires.

**Decision:** a percentile in a metric response is returned only when the sample has **at least 5** values **and** the percentile's rank is below n, so that it is not just the largest value. With this rank, p50 needs n ≥ 5, p85 needs n ≥ 7, and p95 needs n ≥ 20. An arbitrary percentile follows the same rule. Below that, the API returns `null` for that percentile, next to `sample_size`. The minimum lives in one backend constant, so the API and the UI cannot disagree. Five is the threshold #448's design spec draws. The rank rule stops a p95 drawn from six cards claiming to be a tail. It also refines the spec's sparse state (`metrics-few`): the UI hides each percentile line, and each aging zone, when its own value is `null`, not all three at once below five samples. With five or six samples only P50 is drawn, P85 appears at seven, and P95 at twenty. #458's "insufficient data" state uses the same floor. *Rejected:* one flat threshold, which either hides p50 for small teams or presents the maximum as a p95. *Rejected:* #458's threshold of 3, which is too few for a median that people compare between swimlanes.

Durations are computed in seconds and reported in days (seconds ÷ 86,400). Percentiles are taken before rounding, and values are rounded to one decimal only for display.

### Bottleneck overlay (#459)

**Decision:** #459's overlay shows each cell's **current dwell**: how long the cards now in that column and swimlane have been in their open visit. It does not show completed dwell. Under the #459 architect review (2026-11-01), the value is live and filter-aware, so the browser computes it from the cards it has loaded, not from a board-wide endpoint.

- **The definition stays on the server.** The board payload gains one additive, nullable field, `column_entered_at`: the start of the card's open visit, by the visit rules above. It is a field of the card body, so it also travels in the `card.*` WebSocket events, which send the same body as REST. The design recomputes the overlay on every move and socket event, so a move updates the cell without a refetch. A swimlane-only move does not reset it. A restore opens a new visit and so does reset it, and so does a reopen. It is `null` for an archived card (including one archived in the admin), for a card in a done column, and for a card whose open visit is not measured (no recorded movement, unknown column, or a column that does not match `Card.column`). The browser computes only `now − column_entered_at` and the cell's nearest-rank median.
- **The sample-size floor does not apply to the overlay.** A cell with one to four cards shows its median, on the same badge as any other cell (`4.0d` in #459's design). The overlay describes the cards on screen; it does not estimate a distribution. On a small team, the floor would blank most cells. Done cells and empty cells stay `null`. *Rejected:* applying the n ≥ 5 floor to cells.

> **Note (2026-11-03, #459):** `column_entered_at` shipped before `flow_metrics.py` exists, as `_annotate_column_entered_at` in `boards/serializers.py`: a card read needs it as a subquery in the main `SELECT`, the same reason `_annotate_last_move` is one (#1883). It implements the visit rules above and nothing else. So the card-field half of item 9 of [Changes handed to #448](#changes-handed-to-448) is done here. A service that computes visits from loaded rows and this expression are then two implementations of one rule, so whichever lands second adds a test that pins them to the same value. The browser treats a time ahead of its own clock as just arrived (0), because the server has already dropped misdated rows and what is left is clock skew. That is not the clamp rejected under "no duration is ever negative", which is about durations the server computes.

### Time zones, windows and business days

- **Elapsed calendar time, in UTC.** Durations are the difference between two UTC timestamps (`TIME_ZONE = "UTC"`, `USE_TZ = True`). Weekends and holidays count. *Rejected:* business days, which need a working calendar and holiday set per board that Visiban does not have. The customer waits on calendar time. If a business-day view is requested, it becomes its own option, and the definitions above do not change.
- **Bucketing in UTC.** Daily buckets (throughput per day for #1100, CFD days for #448) are UTC dates. Weeks are ISO 8601 weeks, starting Monday in UTC. *Rejected for now:* the viewer's `timezone` preference, which would give two viewers, or a viewer and an MCP agent, different numbers for the same board. A board-level time zone is tracked as #2051. The cost meanwhile is that a completion late on a Friday in UTC−8 lands in Saturday's bucket.
- **Windows.** For samples (lead time, cycle time, completed dwell), `days=N` is a rolling window `[now − N × 24h, now)`, as `analytics.py` uses today. A sample belongs to the window its completion falls in, or for completed dwell, the window its visit closed in. Age, current dwell and WIP are snapshots at the moment of the request and take no window. On #448's dashboard, the date range therefore moves the aging chart's P85 and P95 zones (its `cycle_time_percentiles` are cycle times completed in the range) but not its dots. The swimlane and label filters apply to both.
- **Whole days for buckets.** For bucketed outputs (throughput, cumulative flow), `days=N` covers the N whole UTC days that end at today's 00:00Z. Today, which is still running, is never a bucket. Weekly throughput reports only ISO weeks that lie wholly inside the window. #1100 samples daily throughput, and a partial first or last day would enter its simulation as a slow day and bias every forecast toward later dates. *Rejected:* partial edge buckets with a `partial` flag, which every consumer would have to remember to drop.
- **Date ranges.** A date-range filter (`from_date`, `to_date`) takes UTC dates, inclusive at both ends: `[from_date 00:00Z, to_date + 1 day 00:00Z)`. It is whole days by construction.
- **Filters.** The swimlane filter uses the card's current swimlane, as the board movements endpoint's `swimlane_id` filter does. The label filter uses the card's current labels. *Rejected:* the swimlane at completion time, which needs a per-movement lookup, and cards rarely change swimlane.
    - **Superseded in part (2026-11-20, #2334)** for the swimlane *breakdown* and the *swimlane comparison* only. "Rarely" was never measured, and on entity-row boards, where a swimlane is a customer or project, a card's whole history moving with it misstates both swimlanes. The lookup costs no query: `CardMovement.to_swimlane_id` is read on the movement query the flow snapshot already runs. Rule: counts and samples dated by an instant follow the swimlane the card was in at that instant, and blocked share is split by time across the swimlanes the card sat in, and a column stay (dwell) counts whole under the swimlane the card was in when it left the column. Cycle time and throughput use the swimlane at first completion, and so do the Swimlanes view's `finished`, median, 85th percentile and rolling median; WIP age, an open visit and `in_progress` use the current swimlane. A completed dwell visit uses the swimlane the card was in when it left the column: the one in effect just before the move that ended the visit, even when that one move also changed swimlane (a drag into another column in another swimlane). Blocked share splits each in-progress second across the swimlanes the card was in. So a card dragged from one swimlane straight into a done column in another counts as finished in the second, while its blocked time and its last stay count in the first. Lead time has no breakdown and no swimlane. A movement whose swimlane was deleted, or an imported one whose swimlane name matched nothing, belongs to no current swimlane and is counted as `excluded`, never moved to the current swimlane. When the history's last swimlane is not the card's (a change that wrote no movement), the current swimlane stands for the whole history. **The filter stays on the current swimlane**, as above, by owner decision: `swimlane_id` still selects the cards now in that swimlane. The Summary rollup (`velocity_*`, `avg_cycle_days`), the dwell heatmap and `cards[].swimlane` also stay current, so they can disagree with the Swimlanes view for a card that changed swimlane. Labels and custom fields stay current: their history is not recorded (#1909).

### Cumulative flow

**Decision:** each card is counted at the end of each UTC day in the column of its latest transition up to that moment, or of its creation movement, by column key. A card without a creation movement is placed from `Card.created_at` in the source column of its earliest movement, or in its current column if it has none. A card archived in a column that is not done leaves the diagram from the day of the archive (its `archived` event, or `Card.archived_at` if it has none). A card in a done column stays counted after it is archived, because finished work is cumulative and archiving it must not shrink the done band. Columns that have since been deleted share one `column_uid: null` band. Hard-deleted cards are left out.

**Decision:** the **bottleneck** that #448's design hatches in the diagram is the current column that is not done whose count grew the most from the first day of the window to the last. When two columns grew by the same amount, the one earlier in position order wins. When no such column grew, there is no bottleneck and nothing is hatched. The service returns it, so the dashboard and an agent name the same column. *Rejected:* letting the browser pick it from the bands, which would be a second implementation. This fixes only what the bottleneck means. The CFD bottleneck highlight is OSS, per [Analytics (split)](open-core-boundary.md#analytics-split) (#1750, 2026-11-02).

> **Note (2026-11-15, #2290):** the board's first not-done column, its intake (Backlog, To Do), is never the bottleneck. New work arriving there grows it without any queue failing to drain, so the pick runs over the other not-done columns only. A board whose only not-done column is the first has no bottleneck (`bottleneck_column_uid: null`). The tie rule is unchanged: the earlier position wins.

### Response shapes (for #448, #458, #1100 and #1151)

Every metric response carries `definition` (the string above). Percentile objects are `{p50, p85, p95}`, each a number of days or `null` under the sample-size rule. Every duration value is `value_days`. The samples are the drill-down: the 2026-10-08 criteria ask for cards, transitions and owners, and the client gets transitions from the existing card movements endpoint and owners from the card. There is no separate drill-down endpoint. *Rejected:* card-id lists without values, which force a second request to explain a dot on the scatter.

The throughput `median` is the median line in #448's weekly run chart. Zero weeks count, so a quiet week lowers it. The same floor applies: a weekly median needs five whole ISO weeks, and a 30-day window holds at most four. #448's dashboard therefore defaults to a **90-day** range: twelve whole ISO weeks for the median, and enough completions for P85 and P95 on a team that finishes three to five cards a week, where 30 days would leave them `null` on most boards. *Rejected:* exempting the throughput median from the floor, which only the overlay's describe-the-screen role justifies.

| Metric | Top-level fields | One sample |
|---|---|---|
| Lead time, cycle time | `definition`, `sample_size`, `excluded_incomplete_history`, `percentiles` | one per card: `card_uid`, `value_days`, `start`, `end`, `reopened` |
| Completed dwell | the same, per current column: `columns: [{column_uid, column_name, sample_size, percentiles}]` | one per visit: `card_uid`, `column_uid`, `value_days`, `start`, `end`, `reopened` |
| Current dwell | the same as completed dwell | one per open visit: `card_uid`, `column_uid`, `value_days`, `start`, `end: null` |
| Age | `definition`, `sample_size`, `excluded_incomplete_history`, and `cycle_time_percentiles` over the same filters, for the aging zones | one per in-progress card: `card_uid`, `column_uid`, `value_days`, `start`, `dwell_by_column` (the card's measured visits summed per column key, `[{column_uid, value_days}]` in order of first entry, deleted columns as `column_uid: null`: the drawer's per-column dwell bars; since 2026-11-15 (#2292) each visit is clipped to the age clock, `[age_start, now]`, so the per-column values sum to `value_days`) |
| WIP | `definition`, `columns: [{column_uid, column_name, count}]` for current columns that are not done, in position order | `card_uids` on each column entry |
| Throughput | `definition`, `period` (`day` or `week`), `total`, `median` (the nearest-rank p50 of the period counts, zero-count periods included, `null` under the sample-size rule) | one per whole period: `start` (UTC date), `count`, `card_uids` |
| Cumulative flow | `definition`, `columns: [{column_uid, column_name, is_done}]` in position order, plus the `null` band; `days: [{date, counts: {column_uid: n}}]`; `completed`, `completed_per_week` (#2307); `bottleneck_column_uid` (or `null`) | the same endpoint with `date=YYYY-MM-DD` returns `{date, columns: [{column_uid, card_uids}]}`, the cards behind that day's counts |

### Column flow, starts, blocked range and needs attention (#2260)

> **Note (2026-11-14, #2260):** the Analytics redesign (#2257, `docs/development/analytics-redesign.md`) needs four numbers the record above did not define. They are defined here first, as the module docstring of `flow_metrics.py` asks.

- **Started.** A card is *started* on its cycle start: its first move out of the column it was created in, to a column that is not done. Throughput's per-period `started` counts the cards whose cycle start falls in the period, archived ones included, as `count` does. A reopen is not a start, because the first completion is the anchor (see [Reopened cards](#reopened-cards)). A card with no creation movement (an import without its history) can finish but never starts, so `started` under-reports on imported boards.
- **Column flow.** For each cumulative-flow band, `start_count` and `end_count` are its counts at the end of the first and the last whole day. `entered` and `left` count the times a card's band changed at a moment whose UTC date is after the first day and no later than the last, so `end_count − start_count = entered − left` exactly, for every band, the done bands and the `null` band included. A same-day bounce counts both ways, and nets to zero. A move between two deleted columns stays in the `null` band and is not counted. Archiving a card outside a done column leaves its band, and restoring it enters one; archiving in a done column does not leave. The weekly rates are `entered × 7 ÷ (days − 1)` and `left × 7 ÷ (days − 1)`, unrounded, and `null` under two whole days. *Rejected:* a window that includes the first day, which breaks the identity and would move the bottleneck, which already reads the first and last day.
- **Blocked time:** the time cards spent blocked, reported as its own metric: total, per column and per reason. It is never subtracted from lead time, cycle time, dwell time or age. This is the [Blocked time](#blocked-time) decision as the API's `definition` string. In a range, a block counts for its part inside the range, and every end is clipped to the range's end and never past now. Before this, ends were clipped only to now, so a date range that ended in the past counted block time after it. A rolling range ends at now, so the analytics endpoint and the MCP tools are unaffected.
- **Needs attention:** the cards, not archived and not in a done column, that are blocked, have been in progress longer than the 85th percentile of cycle time, or have not moved for longer than the board's stalled threshold.
    - The base is every live card outside a done column, the old stalled-cards table's base, not only cards in progress, so a backlog card that has not moved is stalled whether or not it has started.
    - The three reasons, in this fixed order: `blocked` (manually or by an active relation, the same union as everywhere else), `past_p85` (the card is in progress and its age is strictly greater than the cycle-time p85 over the same range and filters; never when p85 is `null` under the sample-size rule, and never for a card with incomplete history, which has no age), and `stalled` (the time since its latest movement of any kind, swimlane moves included, is strictly greater than the board's `staleness_threshold_days`; a card with no movement counts from its creation date).
    - Each card is listed once, with all its reasons, ordered by age (oldest first, no age last), then by time unmoved (longest first; always present, since a card with no movement counts from its creation date), then by card id.
    - It differs from the analytics endpoint's `stalled_cards` in two ways: a movement dated after the request is ignored, as everywhere in these definitions, and a card is judged by its current column, so a card whose latest movement went into a done column but that is no longer there is still listed. A card with no movement is judged the same way in both, from its creation date.

> **Note (2026-11-24, #2554):** the stalled rule above now excludes planned children, and measures a released one from the later of its last movement and its release. The Needs attention list, the heatmap's stalled cards and the stale digest share it.

> **Note (2026-11-15, #2307):** the done-side rate on the flow row needs a count that sums the done bands' `entered` without double counting, so the cumulative-flow payload adds `completed` and `completed_per_week`. `completed` counts first completions only, in the window `first_day < date <= last_day`, on the same `completion_at` definition as throughput. A card moving Done A to Done B counts once, and a finish after a reopen is not counted again. `completed_per_week` is `completed × 7 ÷ (days − 1)`, unrounded, and `null` under two whole days.

### Swimlane comparison (#2266)

The Swimlanes tab of Analytics compares each swimlane with the board. A lane's cycle time is the board's cycle time, restricted to the cards now in that lane, so its median and p85 follow the same definition and sample-size rule (p50 needs 5 cards, p85 needs 7). The board median is the median over every swimlane for the same filters (label, period). A lane with no cards still gets a row.

- **Blocked share.** The lane's blocked seconds over its in-progress seconds, rounded to four decimals, `null` when no card of the lane has in-progress time. A card is in progress from its cycle start to its first completion, and again from each reopen to its next completion (or archive, or now), clipped to the period and never past now. Both sides count only those windows, so a block opened in the backlog or while the card sat in a done column adds to neither. Overlapping blocks on one card count once. A card with neither a measured cycle start nor a reopen has no window. *Superseded (#2297, 2026-11-15):* the window used to end at the first completion, so a reopened card's time and blocks after the reopen were not counted even while it was in progress again and counted in `in_progress`; that disagreed with [Reopened cards](#reopened-cards) ("while the card is open again, it is in progress: its age runs from the reopen"), so blocked share now covers the same in-progress time as age.
- **Rolling median.** Eight points per lane (`SWIMLANE_TREND_POINTS`). Each is the median cycle time of the lane's cards finished in a window half as long as the period. Window `i` (0 to 7) ends at the period start + half the period + `i` × half the period ÷ 7, so the first window ends mid-period and the last at the end of the period, and every window is full width and inside the period. *Superseded (#2297, 2026-11-15):* the windows now end at `min(range end, now)` and are spread over that clipped span, so a range that reaches into the future no longer yields trailing windows with no data. A window with under 5 cards has a `null` median.
- **Status** (`SWIMLANE_STATUS_THRESHOLD_PCT` = 20, `SWIMLANE_STATUS_MIN_FINISHED` = 10). `slower` when the lane's median is strictly more than 20% above the board median, `faster` when strictly more than 20% below, `in_line` otherwise (exactly 20% is `in_line`). `null` when the lane has fewer than 10 finished cards or either median is withheld. A median over a handful of cards moves a lot on one card, and a gap under 20% is ordinary week-to-week wobble.
- **Trend.** The first rolling median against the last, by the same 20% rule (`slower`, `faster` or `steady`), with both values. There is no 10-card floor. Each end window needs its own 5 cards, so a lane with under 5 finished cards has no trend, and in practice a lane needs about 10 for both end windows to be filled. `null` when either end point is withheld. Only the selected period is used; the cross-period comparison is Enterprise.

### Where current code disagrees

None of these change in this ADR. #448 changes each one when it builds the service, with a `changed` changelog fragment and no field removed or retyped (1.x contract).

| Code today | Disagreement | Change |
|---|---|---|
| `summary` `avg_cycle_days` (`analytics.py`, query 3) | Starts at the first movement of any kind (for native cards, the creation movement, so it measures lead time). Ends at the earliest done entry *inside the last 30 days*, not the first completion. Leaves out archived cards. | Recompute as the mean cycle time of cards whose completion falls in the last 30 days. The field stays a mean, because its documented name says average. |
| `summary` `velocity_7d`, `velocity_30d`, `done_30d` (query 2) | Counts movement rows into done columns, so a card that bounces or moves Done → Released counts twice. Leaves out completed cards that were archived later. | Count cards by completion, archived or not. |
| `analytics` done-column and column matching (`done_col_names`, the `to_column_name` fallback) | Matches by name when the foreign key no longer resolves, so a deleted column's visits go to a recreated column of the same name, and that column's done flag applies to the old column. | Match by column key only, never by name. |
| `analytics` throughput dwell (`throughput_avg_days_per_column`) | A swimlane-only move splits a visit. The `archived` row opens a near-zero visit, and for a restored card the archived period counts as dwell. The 2× prefetch buffer drops visits that began before it, so the longest visits are lost. | Visits per this ADR, opened at their true start whatever the window. |
| `analytics` current dwell (`age_avg_days_per_column`, `_last_col_entry_at`) | A swimlane-only move resets the entry time, because the subquery takes the latest row of any kind into the current column. | Use the start of the open visit, the same value as `column_entered_at`. |
| `analytics` `avg_days_per_column` (clamped) and `deal_velocity_days` | Neither is a flow metric in this ADR. `deal_velocity_days` is the span from a card's first movement ever to its most recent movement, for cards whose most recent movement falls in the window, whether or not the card finished. | Frozen as old fields. No new consumer reads them, and the docs must not call them cycle time. |
| Heatmap statistic (mean) | #459 uses the median. | The overlay uses the nearest-rank median of current dwell. The heatmap's existing mean fields stay as they are. |
| `notify_stale_cards`, `last_moved_at`, stalled cards | Time since the last movement of any kind. | None: staleness is a separate signal, not a flow metric. |

### Changes handed to #448

Written to be copied into #448 as they stand:

1. Build `boards/services/flow_metrics.py` as the only implementation of lead time, cycle time, dwell time (completed and current), age, WIP, throughput and cumulative flow, using the terms and rules of the *Flow metric definitions* record in `docs/architecture/decisions.md`: movement order by `(moved_at, id)`, columns identified by column key and never by name, and complete history including continuity. The REST endpoints, the #1151 MCP tools, #458 and the `summary` and `analytics` views call it.
2. Return the response shapes the record pins: `definition`, `sample_size`, `excluded_incomplete_history`, `percentiles` (`p50`/`p85`/`p95`, nearest rank by the integer formula `(p × n + 99) // 100`, `null` under the n ≥ 5 and rank-below-n rule), per-card or per-visit `samples` with `value_days`, the age sample's `dwell_by_column`, and the WIP, throughput (with `median`) and cumulative-flow (with `bottleneck_column_uid`) shapes. Keep the sample-size minimum in one backend constant. Buckets are whole UTC days and whole ISO weeks.
3. Recompute `summary.avg_cycle_days` as the mean cycle time of cards whose first completion falls in the last 30 days, including cards archived since. Add a `changed` fragment.
4. Recompute `summary.velocity_7d`, `velocity_30d` and `done_30d` as counts of cards by first completion, archived or not, and no longer as counts of movement rows. Add a `changed` fragment.
5. Stop matching columns by name in `analytics` (`done_col_names` and the `to_column_name` fallback). A recreated column of the same name no longer inherits the old column's visits or done flag. Add a `changed` fragment.
6. Recompute `analytics.throughput_avg_days_per_column` from visits: a swimlane-only move does not split a visit, an `archived` event (or `archived_at` for a card archived without one) closes it, an `unarchived` event opens a new one, and a visit's true start is used even when it began before the 2× prefetch buffer.
7. Recompute `analytics.age_avg_days_per_column` from the start of each card's open visit, so that a swimlane-only move no longer resets it. A restore still starts a new visit and so resets it, as the visit rule says. Its docs say it is current dwell, not age.
8. Leave `avg_days_per_column`, `deal_velocity_days` and `board_medians` as frozen legacy fields. Do not read them from new code.
9. Add the additive, nullable `column_entered_at` card field (the start of the open visit, `null` for archived cards, cards in done columns and unmeasured visits) for #459, computed by the same service. It is part of the card body, so the `card.*` WebSocket events carry it too.
10. Supersede the body's "cycle time = first movement → first done-column entry" and the test-plan line "WIP age = days since entering current non-done column". Cycle time starts at the first pull out of the creation column, and WIP age at the cycle start or the latest reopen.
11. Quote the record's definition strings verbatim on each metric's docs page.

**Yes, but:** the first-pull cycle start and the UTC buckets are the two choices most likely to be revisited. Both have filed follow-ups, a commitment-point column flag (#2050) and a board time zone (#2051), that would add an option without changing what the existing numbers mean.


> **Note (2026-11-03, #448):** built as specified, in `boards/services/flow_metrics.py`. Choices this record left open: the REST responses add a `cards` directory (`uid`, `id`, `title`, `archived`, `assignee`), because a drill-down must name an archived card and an archived card is not on the board payload. The age response adds `columns` (the chart's x-axis) and, per sample, `is_blocked` and `blocked_days`, since #1149 shipped first; blocked time stays beside age, never subtracted. The endpoints accept this record's `days=N` next to `from_date`/`to_date`, cap a range at 366 days, and take `to_date` as today when only `from_date` is given. A card whose first done entry is dated in the future counts in `excluded_incomplete_history` for lead and cycle time in every range, since no period holds it. Read strictly, a done entry whose source column is unknown is not a transition and so not a completion, which leaves a #2052 card with a lost source column out of throughput until a re-import of a pre-1.3 export is repaired (#2052 fixed new exports in 1.3). The architect review's index on `CardMovement(to_column_id, moved_at)` was not built: a cumulative-flow day needs each card's latest transition, so the replay reads a board's movements by card and never filters on `to_column_id`, and nothing would use that index. No existing index serves the read either: on PostgreSQL 17 with 37,500 of 187,500 rows on the board, the plan was a parallel sequential scan, a hash join to the board's cards, and an explicit sort on `(card_id, moved_at, id)`, 35 ms in all. `movement_card_moved_idx` is `(card, -moved_at)`, which cannot supply that ascending order. `summary` and `analytics` load only the cards that can change their answer, each with its whole history; the four metric endpoints load the board. **Superseded in part (2026-11-20, #2425):** the metric endpoints now also load only the cards that can change their range: every live card, and any card archived, created or moved at or after the earlier of the range's start and the midnight that opens its first bucketed day. A card outside that set has every moment a metric dates (a completion, a cycle start, a visit's end, a placement, `archived_at`) before the range, so it can be no sample, exclusion or count in it. Each card loaded still carries its whole history. Cumulative flow is the exception that needs the rest: a finished card stays in the done band for ever, so the older cards' movements are still read, but each is folded to the one band it rests in and discarded, never held as a snapshot. The day drill-down (`cumulative-flow?date=`) still loads the board. **Superseded in part (2026-11-23, #2444):** the two sentences above no longer hold for how much is read. For every older card, cumulative flow now reads only the rows its placement depends on (its first row, its last transition, its last archive-type row), and the day drill-down still loads every card of the board, since each one rests in some band that day, but with at most four such rows each (the fourth, the last archive-type row after the day, decides whether an admin-set `archived_at` counts), not its whole history. The rows are chosen in SQL with two `ROW_NUMBER()` windows. The fold to one band, the replay and every response are unchanged (`test_cumulative_flow_bounded_2444.py`). Both requests still place every older card, so their cost still grows with the number of archived cards: on the aged nightly fixture they measured about 6x (range) and 14x (drill-down, not like-for-like: the load-test board's drill-down day is empty) the load-test board, so #2425's 1.5x acceptance is not met (docs/development/nightly-load-test.md, the #2444 section). Definitions and numbers are unchanged; `test_flow_range_narrowing_2425.py` compares every endpoint against the whole-history load on a board with three years of archived history. The blocked-time metric moved from the Analytics view to this service as `blocked_time`, with the swimlane and label filters #1151 needs and a `total`, its by-name fallback for a recreated column removed, and current-dwell samples carry `is_blocked`. `analytics.avg_days_per_column`, which this record freezes, also stops matching by name, because item 5 removes the fallback it shared.

> **Note (2026-11-22, #2451):** the analytics heatmap now reads its stays off the flow load, in `(moved_at, id)` order, rather than from its own query. When two of a card's movements share a `moved_at` (a bulk move or an import), the movement id now decides which column is credited with the stay in the frozen `avg_days_per_column`; before, the database decided. The `board_medians` and `is_outlier` built from those stays follow. Cards tied on swimlane and position list in `stalled_cards` in card-id order. No field was added, removed or retyped.

> **Note (2026-11-17, #2050) — proposed, pending owner confirmation in review:** a board may set a **commitment point**, `Board.commitment_column_uid` (nullable; `null` is the default and keeps every definition above word for word). When it is set, the *Cycle start* term reads: the card's first arrival at the commitment column or any column after it by current position that is not done. That is the creation movement when the card was created there, or else its first transition into such a column. A card that enters a done column before reaching one has no cycle start (it counts toward throughput, and like a card moved straight to done it is not an exclusion); a card created in a done column has none, as before. A backward move to a column before the commitment point does not restart the clock: the first arrival anchors, as the first completion does. Every rule built on the cycle start follows without a change of its own: cycle time, *In progress* and therefore age and needs attention, and throughput's `started`. A reopen still starts a new round of age wherever it lands. The column is stored by uid, the column key this record already uses, not as a foreign key: a commitment column that is deleted or later marked done stops matching and the board reads as unset, rather than needing `SET NULL`; the API accepts only a not-done column of the board. The responses' `definition` strings for cycle time and age switch on such a board to:
>
> - **Cycle time (commitment point):** the time from a card's first entry into the board's commitment column, or a column after it that is not done, until its first entry into a done column. A card that reaches a done column first has no cycle time.
> - **Age (commitment point):** how long an in-progress card has been in progress: the time since it first entered the board's commitment column or a column after it, or since it last left a done column, whichever is later.
>
> This removes the *known limitation* under "Cycle time starts at the first pull" for opted-in boards: a card created directly in a working column now starts there. *Rejected:* a boolean flag on every column, which allows two commitment points and needs a rule for which wins; *rejected:* starting at entry to the commitment column only, which drops a card that skips it. The definitions are computed at query time, so setting or moving the commitment point re-states the board's history, the same way marking a column done does.

---

## Charting approach for the flow-metrics dashboard

**Status:** Accepted (2026-11-02, #2028). Follows the #448 architect review of 2026-11-01. Consumers: #448 (flow-metrics dashboard) and #1774 (a `series` panel type for `extension_panels`). A later change of mind is recorded as a dated note below the record, never as a silent rewrite.

**Decision:** charts are **hand-rolled SVG React components built on one shared chart primitive**, with no chart library. The frontend has none today (`frontend/package.json` lists no charting dependency, and the analytics heatmap is a table). #448 needs four charts: a cycle-time scatter with p50/p85/p95 lines, a weekly throughput run chart, a cumulative flow diagram and an aging-WIP chart. They are axes, marks, lines and areas over data the server has already computed, which is small enough to own. The primitive supplies the scales, axes, direct labels, hit targets and the data-table fallback once, so each chart supplies only its marks.

**Why it matters:** the charts must follow the color tokens in `frontend/CLAUDE.md` in light and dark themes and read without color alone. Owning the SVG makes those two requirements ordinary code in our own components. With a library they are overrides of its styling and its accessibility output.

**Rejected:** a small charting dependency, which would be faster to build. It adds a runtime dependency and its bundle weight as a new charting dependency, needs the `dependency` review (license, CVEs, transitive packages and bundle size), and would have to be themed from CSS custom properties to match the slate tokens in both themes. No `dependency` review was run, because no dependency is added. *What would change this:* a chart type the primitive cannot reasonably draw, for example zoom or brushing, or interactive behavior that costs more to own than a dependency costs to carry. That is a new record, with the `dependency` review attached.

### Requirements on the shared primitive

These bind #448 and #1774 alike. They are requirements, not a component design: layout and interaction belong to #448's `ux-design` pass.

- **Color is never the only carrier of meaning.** Each series or band is also identified by a direct label at the line or area, not only a legend. Adjacent bands, as in the cumulative flow diagram's one-hue alpha steps, are told apart by 1px separators plus those direct labels, and that counts as the non-color carrier for bands. Where series overlap and cannot be told apart that way (lines, points), add a second encoding: line dash, a fill pattern or a mark shape. The CFD bottleneck column keeps the hatched fill in #448's design. A reader who cannot tell the colors apart can still tell the series apart.
- **Every chart has a text alternative.** The `<svg>` is `role="img"` with an `aria-label` that states the headline reading, and the same data is available as a table (`<table>` with real headers) that the user can toggle into view, so sighted keyboard users get it too, not only screen reader users. Interactive drill-down marks (a card, a day's cards) are real buttons or links with an accessible name and are not nested inside a `role="img"` element, because `img` has presentational children and assistive technology may not reach them. How they are laid out alongside the image is left to #448's `ux-design`.
- **Theming uses the existing tokens.** Strokes, fills, axes and text come from the `frontend/CLAUDE.md` tokens (`text-fg*`, `border-line*`, `bg-surface`, `bg-canvas`, `primary-emphasis`, the status tokens) through `currentColor` or the CSS custom properties. Those properties hold bare color triples, so they are used as `rgb(var(--…))`, as existing code does (for example `ActivityTabPanel.tsx`). No hex values and no `gray`. Both themes are checked against the contrast notes in `frontend/CLAUDE.md`, including its warning that `fg-muted` and `fg-faint` fall below AA as text, so axis ticks and labels use a token that passes. Lines, points and separators need at least 3:1 against `bg-surface` in both themes. Alpha band fills are exempt from that figure, and their exact values are left to #448's `ux-design`.
- **Motion respects the reduced-motion rule.** Any transition on a chart carries `motion-reduce:` fallbacks, as the other decorative animation does.
- **Percentiles come from the server.** In percentile responses the primitive draws what the API returns and never recomputes a percentile. A `null` percentile is drawn as an absent line with a visible note that there are too few cards, not as zero, and the note names no number. `sample_size` is shown on the chart where the response has one. This applies to the percentile responses defined in [Percentiles and sample size](#percentiles-and-sample-size); the other charts' data handling is left to #448. This section changes no text of that record.
- **Cycle time is a scatter with p50/p85/p95 lines.** One point is one completed card. A bucket histogram hides the tail that p85 and p95 exist to show. A histogram can be added later over the same endpoint without a new decision.

### The #1774 series panel

**In scope.** The shared primitive is built so that #1774's `series` panel type renders through it, next to the existing `stats` and `table` types in `frontend/src/components/Board/parseExtensionPanels.ts` and `ExtensionPanels.tsx`. #1774 adds the panel type and its parser validation. This record fixes only that the renderer is the shared primitive, so an extension's chart gets the same labels, text alternative, tokens and theme behavior as the dashboard. Payloads stay data-only, as `ExtensionPanels.tsx` already requires (no class, color, style or link comes from the payload), so the OSS renderer owns patterns, labels and drill-down. #1774 decides the panel's payload shape. Extension payloads are untrusted input, so that parser validates them the way it does for `table`.

### Not decided here

- **Edition of the flow charts (resolved).** The owner ruled on 2026-11-02 (#1750) that the cumulative flow diagram, the CFD bottleneck highlight and the other #448 charts are OSS; see [Analytics (split)](open-core-boundary.md#analytics-split). Extension panels still render in the Summary tab (see `docs/api/boards.md`), not in #448's Analytics grid. This record does not change the open-core boundary.
- **The chart components' layout and interaction.** That is #448's `ux-design` pass, bound by the requirements above.

---

<a id="default-card-density"></a>

## Default card density after the board redesign

**Status:** Proposed, owner decision pending (#2433). This record proposes and decides nothing. Until the owner rules, new boards keep `comfortable`. The ruling is recorded as a dated note under this record, never as a silent rewrite.

**The question:** the board redesign (#2259, #2272) made the Comfortable card taller than it was in 1.2. Should new boards default to Standard instead, and should more reach the Comfortable face?

**Where the question came from:** a simulated persona panel (`/voc-audit`), not user research. No user was asked and no user has reported it. The panel's pixel figures were estimated from Tailwind classes. The figures below were measured.

### What the code does today

- **The default lives on the server.** `Board.card_density` is a `CharField` with `default="comfortable"` and no `db_default` (`backend/boards/models.py:212`). Migration `0051_board_card_density` set every board that existed at 1.1 to `dense` and new boards to `comfortable`. A board created over the API without `card_density` gets the model default (`docs/api/boards.md:78`).
- **Every board stores a value, so no board is "unset".** The column is `NOT NULL`. A board that took the default and a board whose admin chose Comfortable hold the same value and cannot be told apart. "All boards without an explicit density" therefore does not exist as a set the server could select.
- **Three layers already sit on top of the board value.** A board admin sets the tier (`BoardSettingsModal.tsx:2518`). The board default preset can override it: the **Default** preset sets Standard (`frontend/src/boardPresets/registry.ts:86`, the #871 ruling of 2026-11-01). A member can set a personal override stored in the browser (`board:{id}:card-density-override`, `useCardDensityOverride.ts`). The precedence is resolved once, in `useBoardPreset`.
- **The frontend fallback is not the default.** `CardItem`'s `density = "comfortable"` (`CardItem.tsx:255`) applies only when a caller passes no density, such as a drag overlay with no board context.
- **Demo data:** `seed_demo_data` creates boards at `comfortable` unless a spec says otherwise (`seed_demo_data.py:1093`). The demo site's Software Team board is `dense` (`_demo_site_data.py:102`).

### Measured card heights

Measured with Playwright and Chromium at 1440×900 on the seeded redesign sample board (`e2e/fixtures/redesign-board.ts`, 8 columns, cards 158px wide), with each density forced on the board and `getBoundingClientRect` read for every card. The measurement was made for this record and is not committed. Heights include the 1px border.

| Tier | Typical card | Row by row | Gap | Cards per 569px lane area |
|---|---|---|---|---|
| Comfortable | 125px (103–125) | padding 16, title 2 lines 38.5, subtitle 2+16.5, metadata row 6+22, status row 6+16, border 2 | 6px | about 4 |
| Standard | 65px | padding 16, title 1 line 19.3, metadata row (status inline) 6+22, border 2 | 6px | about 8 |
| Dense | 40px | padding 16, one row 22, border 2 | 6px | about 12 |

The 569px is the space below the board chrome in the first lane on a 900px window (the first card's top edge is at 331px). 8 of the 29 cards carry an extra block (+48px at Comfortable and Standard, +26px at Dense). They are left out of the typical figure because they are taller at every tier.

**Method.** Chromium via Playwright at 1440×900, on the seeded redesign sample board (`e2e/fixtures/redesign-board.ts`): 29 cards across 8 leaf columns, every card 158px wide. One run per tier (`comfortable`, `standard`, `dense`); how each tier was forced was not recorded. Each run read `getBoundingClientRect` for every card, and a second pass read the row heights inside a sample card. The script was throwaway: it was a temporary spec, it is not committed, and the numbers are reproducible only by repeating the setup above.

The persona panel estimated "about 5-6 cards per column" at Comfortable. That was an estimate from Tailwind classes, and the measured figure of about 4 in the table above supersedes it.

**Where Comfortable's extra 60px comes from:** the second title line (19.3px, because Comfortable clamps the title to 2 lines and Standard to 1, `CardItem.tsx:988`), the subtitle row (18.5px, `CardItem.tsx:1005`; since !1976 it is one line, not two as #2433's body says), and the status line on its own row (22px, `CardItem.tsx:1427`; Standard puts it inline). Padding and margins add 30px in total. The shipped 8px vertical padding and 6px row gaps are already tighter than the canvas's 10px card padding and 7px row gap (`docs/development/board-redesign.md` § Design tokens).

**1.2, estimated, not measured:** the v1.2.0 Comfortable card was padding, a 1- or 2-line title and one metadata row with the urgency badge inline (v1.2.0 `CardItem.tsx:563–577`), so about 63–83px. That is close to the 1.3 **Standard** card, which keeps the same rows. 1.3 Comfortable is the 1.2 card plus a subtitle row and a status row.

### Options

**A. Keep Comfortable as the default for new boards.** No code change.
- *For:* the redesign draws the card face at Comfortable (`docs/development/board-redesign.md` § Cards, "Rows, top to bottom, at Comfortable density"), and the owner ruled on 2026-11-14 that the design is the standard. The subtitle is the canvas's second identifier (the company name in the sample), and Comfortable is the only tier that shows it: Standard and Dense draw only the text before ` -- ` and keep the rest in the tooltip (`CardItem.tsx:988–1001`). The taller card is the cost of the calm face, not an accident. Admins, presets and members can each move to Standard in one step.
- *Against:* about half as many cards fit in view as at Standard, and roughly 1.5 to 2 times taller than the 1.2 Comfortable card (estimated). A team that never opens the View menu gets the least dense board.
- *Backward compatibility:* none affected.

**B. Default new boards to Standard.** Change `default="comfortable"` to `"standard"` in `models.py:214`, with an `AlterField` migration. A default-only change on a field with no `db_default` is expected to emit no SQL, which `sqlmigrate` and `migration-check` confirm at implementation. Existing boards keep their stored value.
- *For:* restores the 1.2 Comfortable card's height for new boards. Agrees with the **Default** preset's Standard ruling (#871). Shows the due date, a second label, weight and attachments on the face.
- *Against:* new boards lose the subtitle on the face, the redesign's most visible card element. Departs from the reference face. Moves the board default away from the tier the redesign was drawn, reviewed and screenshot-tested at (`e2e/board-redesign.spec.ts` captures Comfortable).
- *Backward compatibility:* a changed default for an API field. Clients that create boards without `card_density` get Standard. That is not a breaking change under the rules in `CLAUDE.md` (no field removed or retyped), but it changes behavior for existing installs, so it needs a `changed` changelog fragment and a note in `docs/administration/upgrade.md`.

**B2. Also move existing Comfortable boards to Standard.** Rejected. The server cannot tell a defaulted board from one an admin set to Comfortable (see above), so a data migration would overwrite deliberate choices on every install. That breaks the rule against changing behavior for existing installs, and no evidence asks for it.

**C. An instance-wide default density (a new setting or environment variable).** Per-board admin control already exists, as do the board default preset and the personal override. A fourth knob adds configuration surface, docs and tests for a need nobody has reported. Not recommended now. It stays available, as a new optional setting, if self-hosting admins ask for it.

**D. Tighten Comfortable's spacing.** Changing `py-2` to `py-1.5` and the `mt-1.5` row gaps to `mt-1` saves about 8px (6%) and moves the card further below the canvas's padding and gaps. Closing the gap would take removing rows: the subtitle, the second title line or the separate status row, which turns Comfortable into Standard. The separate status row is a #2272 decision. Not recommended.

**Separate sub-question: more on the Comfortable face, such as a high or urgent priority cue.** This reopens the calm-face rule (#2272, #2393). Priority is in the card's accessible name and the peek at every non-compact density (`frontend/CLAUDE.md` § Cards). It is independent of the default, so this record proposes no change. If the owner wants a cue, it should be its own issue with a `ux-design` pass.

### Recommendation

> **RECOMMENDATION (implementer proposal, not a decision): option A.** Keep Comfortable as the default for new boards in 1.3 and change no code. Record the measured heights above so the trade-off is explicit, and revisit when there is real evidence: the usability baseline (#1590) or a first real user report about scrolling.

Why A over B:

1. The extra height comes from the subtitle and the status row, which are the redesign's intent. The face was approved at Comfortable, and Standard hides the subtitle.
2. Every escape is already one step away: the board setting, the Default preset and the personal override.
3. The choice is cheap to reverse. Changing the default later affects only boards created after the change, and needs no data migration. The owner ruled on 2026-11-14 that there are no users yet, so deferring locks in almost no boards.
4. The only evidence for B is a simulated panel, and the issue's own falsification line asks for a real report.

*What would change this to B:* the #1590 baseline or real users showing that teams switch new boards to Standard or Dense soon after creating them, or report scrolling more than in 1.2.

### If the owner approves

- **Either option:** update or delete the "Open for the owner: the default card density for new boards (#2433)" line in `docs/development/board-redesign.md` § Decisions so it does not go stale. The A line below replaces it; under B, replace it with the B outcome.
- **A:** add a dated note under this record ("Decided <date>: Comfortable stays the default; see #2433"), change **Status** to Accepted, and add one line to `docs/development/board-redesign.md` § Decisions: "Decided in #2433: Comfortable stays the default card density for new boards; measured heights are in Technology Decisions." No code, changelog or upgrade note.
- **B:** a separate implementation MR with: `models.py:214` default and `help_text`, and the migration; `seed_demo_data.py:1093`; `frontend/CLAUDE.md` § Card density table ("Default for") and the blocked-indicator note at line 697 ("`comfortable` is the default for every board created since 1.1"); `docs/features/board.md:376–378`; `docs/features/index.md:383`; `docs/architecture/data-model.md:110` and `:267`; `docs/api/boards.md:78`; a `changed` fragment in `changelog.d/`; a 1.3 note in `docs/administration/upgrade.md`; and the `e2e/board-redesign.spec.ts` captures if the sample board stops naming its density. Gates: `migration-check`, `regression-check`, `api-docs`.

**Aside, true under either option:** the `card_density` `help_text` (`models.py:215–225`) still describes the 1.1 tiers ("``dense`` shows everything"), which the redesign no longer matches. It is a source change, so it is out of scope for this docs-only record.

---

<a id="csv-deleted-card-history"></a>

## Deleted-card history in the CSV export

**Status:** Proposed, owner decision pending (#2414). This record proposes and decides nothing. Until the owner rules, the CSV export stays as it is today: it carries no deleted-card history. The ruling is recorded as a dated note under this record, never as a silent rewrite.

**The question:** since 1.3 (#1796) the JSON export carries the retained history of hard-deleted cards in `deleted_card_history`. The CSV export does not. Should it, and if so in what form?

**Where the question came from:** the #1796 branch, which shipped the JSON half and left CSV out on purpose. No user has asked for it. No persona panel was run for this record.

### What the code does today

Each claim below was read in the code. The ones marked *verified* were also checked with a throwaway test against the SQLite test database (not committed).

- **A deleted card's records stay on the board.** `CardMovement.card` is nullable and uses `set_null_keeping_board` (`backend/boards/models.py:1194`). `CardActivity.card` uses the same helper (`models.py:1593`, #1799). `CardBlock.card` and `CardGateTransition.card` use plain `models.SET_NULL` (`models.py:1724`, `:3332`, #2413), because every row of those tables carries its `board` from the first write. All three keep the row, with `board`, `card_uid` and `card_title`.
- **The CSV export is one row per live card.** The export reads `Card.objects.filter(board=board)` (`backend/boards/views/import_export.py:4098–4099`) and writes one row per card (`:4529–4602`). A deleted card has no `Card` row, so it has no CSV row, and its movements are in no live card's `Movement History` cell. *Verified:* a board with one live and one deleted card, both moved, exports one data row (`Live`), and the deleted card's title appears nowhere in the file.
- **The "one row per card" rule is documented.** The column list is in `docs/api/boards.md:1038`, and `docs/api/boards.md:1044` says the swimlane field columns repeat per card "so the CSV stays one row per card". The audit log's `row_count` counts cards (`import_export.py:4607–4613`).
- **The CSV writer uses CRLF line endings.** `csv.writer(buf)` takes the default `lineterminator` of `"\r\n"` (`import_export.py:4504`). *Verified:* the body contains `\r\n`. The repository's `.gitattributes` sets `* text=auto eol=lf`, so a CSV committed as a byte-for-byte fixture would be rewritten to LF on checkout.
- **The CSV importer makes a card of every row.** It requires the `Title`, `Column` and `Swimlane` headers (`import_export.py:3568`), rejects the whole file if any row has one of them blank (`:3613–3619`), and appends one `Card` per remaining row (`:3847–3880`). Headers it does not know are ignored. It caps a file at 500 rows (`:3559`) and does not read `Movement History` at all. *Verified:* a file with an extra `Row Type` column and a row marked `deleted_card_movement`:
  - with that row's `Column` blank, the import fails with `400` "Row 3 is missing required field: Column";
  - with `Column` filled in, the import succeeds and creates the marked row as a card (`A` and `Old`).
- **The JSON export carries all four kinds of record.** `_deleted_card_history_export` (`import_export.py:359`) reads the board's movements, activities, blocks and gate transitions with `card IS NULL`, groups them by `card_uid`, and drops any uid that is also exported as a live card. Its docstring (`:374–376`) says why CSV is left out and points to #2414. JSON import restores the entries as retained rows when the `history` option is on (`docs/api/boards.md:1073`).
- **Board members already read deleted cards' movements.** `GET /boards/{id}/movements/` selects by the movement's own `board`, so retained rows are included and serialize from their snapshot (`backend/boards/views/analytics.py:2143–2195`). *Verified:* the History response lists the deleted card's title next to the live card's. Activities, blocks and gate transitions of a deleted card are on no per-card surface. They leave the board only in the JSON export (`models.py:1511–1514`, `docs/administration/card-history-retention.md:31`).
- **A flat movement export is an enterprise extension point.** `?export=<format>` on the movements endpoint calls the first `MOVEMENT_EXPORT_BACKENDS` callable (`analytics.py:2274–2327`, `backend/boards/hooks.py:19–49`). Since #1796 a backend that sets `accepts_deleted_cards = True` also receives deleted cards' rows (`analytics.py:2310–2313`). OSS registers no backend, and the History view shows an export button only when one is registered (`frontend/src/components/Board/MovementHistoryView.tsx:425`). The open-core boundary classifies the "movement history delivery report export (CSV/PDF)" as enterprise (`docs/architecture/open-core-boundary.md:38`, `:169–175`).
- **Downloaded files are beyond the purge.** `purge_card_history` deletes rows in the database (the `DELETE`s are at `backend/boards/management/commands/purge_card_history.py:476–489`; `:332–336` only select which rows). Board exports downloaded before a purge, and copies of them, are out of its reach (`docs/administration/card-history-retention.md:44`; its wording said "before the card was deleted", which was stale since #1796, and is corrected on this branch).

**Not verified:** whether the enterprise repository's movement export backend exists, what format it writes, or whether it sets `accepts_deleted_cards`; this record reads only the OSS repository. The probe ran on SQLite, not PostgreSQL. Nothing here depends on database-specific behavior.

### Options

**A. Keep the CSV without deleted-card history, and say so as a decision.** No code change. The CSV stays a file of the board's cards. The JSON export is the complete, lossless format, including deleted cards' history. Board History and the movements API cover reading it.
- *For:* matches what a CSV row means to the importer and to every consumer today. Nothing can bring a deleted card back by accident. Keeps a flat movement report out of OSS, which sits close to the enterprise "structured delivery report export (CSV/PDF)" (`open-core-boundary.md:38`, `:173`) and would need an `enterprise-check` ruling. OSS already exports each live card's movement history in the `Movement History` column (`import_export.py:4533`, `:4548–4566`). Adds no new copy of deleted cards' titles and notes in the format most often opened in a spreadsheet and passed around.
- *Against:* an auditor who wants deleted cards' moves in a spreadsheet has to page through the movements API or convert the JSON. Nobody has reported that need.
- *Backward compatibility:* none affected.

**B. A separate history CSV, served by a new optional query parameter.** For example `GET /boards/{id}/export/?format=csv&section=deleted_card_history`, returning a second file with one row per retained movement of a deleted card: `Card UID`, `Card Title`, `Moved At`, `From Column`, `To Column`, `From Swimlane`, `To Swimlane`, `Moved By`, `Movement Type`, `Notes`, `Imported From`.
- *For:* additive. The board CSV is unchanged, and a new optional parameter is allowed by the backward-compatibility rules in `CLAUDE.md`. The importer already refuses such a file (it has no `Title`, `Column` or `Swimlane` header), so it cannot bring cards back. Opens in a spreadsheet directly.
- *Against:*
  - It covers movements only. Activities, blocks and gate transitions have three more shapes. Either the file is incomplete and looks complete, or it needs three more files or a column union that is mostly empty cells.
  - It is close to the enterprise "delivery report export (CSV)" and needs an `enterprise-check` before design.
  - It adds a public contract to keep stable from 1.3 on: columns, order and sanitization, plus importer behavior for the file (either a clear error naming it or a documented refusal).
  - It is one more copy of deleted cards' titles and notes that `purge_card_history` cannot reach once downloaded. `Notes` and `Imported From` are free text and need the same formula sanitization as every other cell (`_sanitize_csv_field`, `import_export.py:1116`).
  - Line endings: the new file should use the board CSV's CRLF, so the two exports agree. Tests should compare parsed rows. A byte-for-byte fixture committed to the repository needs `lineterminator="\n"` when generated, or `.gitattributes` (`eol=lf`) will rewrite it and the comparison fails only in CI.
- *Backward compatibility:* additive if it is a new optional parameter. Changing what `?format=csv` alone returns, for example a zip of two files, would break every existing consumer and is not part of this option.

**C. Deleted-card rows in the existing CSV, marked by a new row-type column.** Not recommended.
- Appending a column is additive. Adding rows that are not cards is not: it breaks the documented one-row-per-card contract (`docs/api/boards.md:1044`) for every consumer that counts rows, pivots on them or reads `Movement Count`.
- Every importer that predates the marker either fails the whole file or creates a card from the marked row. The verified probe above shows this importer does both, depending on whether the row's `Column` is blank. That includes a 1.2 instance importing a newer file.
- The marked rows would also count toward the 500-row import cap and the audit log's `row_count`.

**D. Defer: leave the docs pointing at an open #2414.** No change. This leaves the docs saying the question is open in #2414, with no date for an answer. Not recommended. Option A costs the same and closes the question.

### Recommendation

> **RECOMMENDATION (implementer proposal, not a decision): option A.** Keep the CSV export a file of the board's cards, with no deleted-card history, and record it as decided. JSON remains the export for a complete audit trail, deleted cards included.

Why A over B:

1. The JSON export already carries all four kinds of deleted-card record and round-trips them, so no data is unreachable. B would add a second, partial route to a subset of it.
2. A flat movement-history CSV sits close to the enterprise "structured delivery report export (CSV/PDF)" (`open-core-boundary.md:38`, `:173`); nobody has classified it, and it would need an `enterprise-check` ruling first. OSS already exports movements per live card in the `Movement History` column. Nothing has asked for the new file.
3. B is cheap to add later. It is a new optional parameter, so it can ship in any minor release without breaking anything. Choosing A now locks in nothing. Choosing B now locks in a column contract.
4. A keeps deleted cards' free text out of the format most likely to be copied around.

*What would change this to B:* a real user or customer report that they need deleted cards' moves in a spreadsheet and cannot use the JSON export or the History view, together with an `enterprise-check` ruling that a plain movement CSV is OSS.

### If the owner approves

- **A:** add a dated note under this record ("Decided <date>: the CSV export carries no deleted-card history; see #2414"), change **Status** to Accepted, and replace the "open for the owner in #2414" sentences with the decided wording below. The docstring in `import_export.py:374–376` ("whether the CSV should carry it in another form: #2414") is a source comment: update it in the same MR, or leave it to the next MR that touches the file. Changelog: the plan edits `changelog.d/1796.added.md` (below), which satisfies `changelog-check` even if the `.py` docstring is also edited, so no new fragment is needed.
  - `changelog.d/1796.added.md:2` ("whether it should is tracked in #2414"): reword to the decided wording. 1.3 is `[Unreleased]`, so the fragment is assembled into `CHANGELOG.md` and would otherwise carry the claim.
  - The two export-format pickers that state what CSV carries: both read "Card data only, no history" (`frontend/src/components/Board/BoardExportModal.tsx:76` and `frontend/src/components/Board/BoardSettingsModal.tsx:2298`). That copy is already inaccurate, because the CSV has a `Movement History` column (`import_export.py:4533`, `:4548-4566`). Reword both in a frontend MR to say the CSV carries each live card's own movement history and no deleted-card history. Update any test that asserts the string (a grep of `frontend/src` and `frontend/e2e` found none at the time of writing, so re-grep first). That frontend change needs a `fixed` changelog fragment. This branch does not edit those files.
  - `docs/features/card-history.md:112`, replace the sentence "CSV export does not carry any of it, because a CSV row is a card; whether it should carry the movement history is open for the owner in #2414 (…)." with: "CSV export does not carry any of it, by decision (#2414): a CSV row is a card, and the CSV importer creates a card from every row. Use the JSON export, or the board's **History** view for movements."
  - `docs/api/boards.md:1071`, replace the sentence "The CSV export does not carry it, because a CSV row is a card and the CSV importer would create a card from it; whether the CSV should carry the retained movement history in another form is open for the owner in #2414 (…)." with: "The CSV export does not carry it, by decision (#2414; see [Technology Decisions](../architecture/decisions.md#csv-deleted-card-history)): a CSV row is a card and the CSV importer would create a card from it. JSON is the export for the complete history."
- **B:** a separate implementation MR, after an `enterprise-check`, with the new parameter on `export` and its OpenAPI entry; the column contract in `docs/api/boards.md`; importer behavior for the file (a named `400` rather than the generic missing-headers message); the `BoardExportLog` format value; formula sanitization of every free-text cell; tests for the absent and present parameter, an empty history, `export_min_role`, and the importer's refusal; an `added` fragment in `changelog.d/`; and the docs lines above reworded for B. Gates: `architect`, `security-review`, `rbac-check`, `perf-check`, `regression-check`, `api-docs`.

**Aside, true under either option:** `docs/administration/card-history-retention.md:44` said board exports were downloaded "before the card was deleted". Since #1796 a JSON export made after the delete also carries the deleted card's history, so the true wording is "before a purge". That docs-only fix is already on this branch.

---

<a id="archived-card-annotations"></a>

## Writes to an archived card's comments, attachments, checklist and relations

**Status:** Proposed, owner decision pending (#1957). This record proposes and decides nothing. Until the owner rules, the endpoints keep today's behavior, described below. The ruling is recorded as a dated note under this record, never as a silent rewrite.

**The question:** editing, deleting and blocking an archived card are refused, but adding and changing its comments, attachments, checklist items and relations still work. Is that the rule, or a gap?

**Where the question came from:** the `/pre-release full` audit of 2026-10-26 (`rbac-check`), not a user report. The audit rated it a decision, not a vulnerability: no role gets more than it has on an active card.

### What the code does today

Measured on SQLite with a throwaway API test (not committed) on a board with one archived card, as owner (admin), member, collaborator and viewer; "not run" cells were read from code only. Line numbers are at `main` of 2026-11-25.

| Write on an archived card | Admin and member | Collaborator | Viewer | Where |
|---|---|---|---|---|
| Edit fields (`PATCH`) | 404 | 403 | 403 | `get_queryset` filters `archived_at__isnull=True` (`backend/boards/views/cards.py:936`); `update_card` guard (`backend/boards/services/cards.py:1289`) |
| Delete | 404 (code read, not run) | not run | not run | `delete_card` guard (`services/cards.py:2957`, rechecked under the lock at `:2984`) |
| Block (unblock read from code) | 404 | 403 | 403 | `services/cards.py:2796` and `:2850`, `:2909` |
| Archive again (`POST .../archive/`) | 200, a no-op: no movement row, broadcast or hook (code read, not run; a member needs to have created the card) | 403 (code read) | 403 (code read) | `archive_card` fetches archived cards on purpose (`_fetch_for_archive`, `services/cards.py:2571`) and writes only when `archived_at` is unset, rechecked under the lock (`:2650`) |
| Move | **200** | 403 | 403 | deliberate exemption, `services/cards.py:1573–1579`, pinned by `test_archived_cards_can_still_be_moved` (`backend/boards/tests/test_card_services.py:1223`) |
| Add a child | 400 `parent_archived` (code read, not run) | not run | not run | `backend/boards/services/card_links.py:591` (#2447) |
| New relation **to** an archived card | 400 `archived_card` | 403 | 403 | `CardRelationCreateSerializer.validate` (`backend/boards/serializers.py:3185`), pinned at `test_card_relations.py:327` |
| Add a comment; delete your own | **201; 204** | **201; 204** | 403 | no archived check: `views/cards.py:2120`, `:2234` |
| Upload an attachment; delete your own | **201; 204** | **201; 204** | 403 | no archived check: `views/cards.py:2305`, `:2398` |
| Add, edit, reorder, delete a checklist item | **201, 200, 200, 204** | **201, 200, 200, 204** | 403 | no archived check: `views/cards.py:2450`, `:2525`, `:2623` |
| New relation **from** an archived card; delete a relation through it | **201; 204** | 403 | 403 | no archived check on the URL card: `views/cards.py:2744`, `:2878` |
| Link an archived card to a parent; remove its parent link (`POST`, `DELETE .../parent/`) | **201; 204** (code read, not run; linking needs Member on both boards) | 403 | 403 | `views/cards.py:2948`; `create_link` checks only the **parent** for `archived_at` (`services/card_links.py:591`), `remove_link` (`:943`) checks neither end |
| Change an archived child's Needed (`POST .../needed/`) | **200** (code read, not run; the other Needed rules still apply) | 403 | 403 | `views/cards.py:2989`; no `archived` check anywhere in `services/planned_children.py` |
| Unlink a child from an archived parent (`DELETE .../children/{child_id}/`) | **204** (code read, not run; needs a role on the child's board too) | 403 | 403 | `views/cards.py:3329`; no archived check on the URL card |

Each of the unguarded handlers looks the card up with `get_object_or_404(..., pk=pk, board=board)`, which has no `archived_at` filter. The locks they take do not read `archived_at` either. Adding a comment, uploading an attachment, and adding or editing a checklist item lock the card with `lock_card_for_write` (`services/cards.py:2149`), which returns the locked row (`:2181–2184`), but the handlers discard it and never read its `archived_at`. Reordering the checklist (`views/cards.py:2613`) takes no card lock at all: it runs one `bulk_update` of the item positions in a transaction. A new relation locks the URL card and the target with its own `select_for_update()...values_list("pk")` (`views/cards.py:2817`), which reads only their ids. The parent link writes lock both cards through `_lock_endpoints` (`services/card_links.py:305`), which returns only each card's board. `set_needed` holds `lock_card_row` (`services/cards.py:1834`), which does return `archived_at`, but nothing reads it.

Two details of #1957's body need correcting: the line numbers above replace the ones it gives, and its claim that a relation can **target** an archived `to_card` was already untrue when the issue was filed on 2026-10-26. `CardRelationCreateSerializer` has refused one with `archived_card` since e5538134d (2026-09-16, first tagged in v1.2.0-alpha.1), and `CHANGELOG.md` lists the code among the relation create errors under 1.2.0-beta.2. A relation can still be drawn **from** one.

**What the app shows.** Nothing in the web app reaches these writes. Every path that opens the card detail panel takes the card from `board.cards`, which holds only unarchived cards, and an open panel closes when its card is archived (`frontend/src/components/Board/BoardView.tsx:1812–1843`). The Archived tab offers only **Unarchive** (`ArchivedCardsPanel.tsx`), and a `?card=` link to an archived card says "This card has been archived." (`BoardView.tsx:1484–1489`). The MCP server writes no comments, attachments, checklist items or relations. These writes are therefore reachable only by a direct API client.

**Side effects of such a write.** A comment on an archived card writes a `COMMENT_ADDED` row to the card's activity history (`views/cards.py:2146`), records and broadcasts `card.updated` with the card's payload (`:2150–2152`), and sends notifications: to anyone it @mentions, and to the card's implicit watchers, its creator and assignee, while they are still board members (`:2191–2198`). Web clients ignore the frame because the card is not in their `board.cards` (`replaceCardUnlessStale`, `frontend/src/hooks/useBoard.ts:232–234`), so the card does not reappear on anyone's board. Other consumers do get it: `record_board_event` also persists the event to the board's change feed (`backend/boards/broadcast.py:465`), `card.updated` is a subscribable webhook event type (`SUBSCRIBABLE_EVENT_TYPES`, `backend/webhooks/models.py:53`), and neither the feed query (`services/feed.py:71`) nor webhook dispatch (`backend/webhooks/dispatch.py`) filters out archived cards. Feed readers and webhook subscribers therefore receive `card.updated` for the archived card (code read, not run). An attachment counts against the per-card quotas (`ATTACHMENT_MAX_PER_CARD`, `ATTACHMENT_MAX_BYTES_PER_CARD`, `views/cards.py:181`), the same as on an active card.

**Getting back in costs more than it looks.** Restoring needs Member, and a member who did not create the card gets `403` unless they are a board admin or hold the `is_moderator` entitlement. A restore is then checked like a move into the card's column: `409` (`wip_limit_exceeded`, `wip_hard_blocked` or `weight_limit_exceeded`) when the column's WIP or weight limit is full. Only a board admin, or the card's assignee when the board enables the assignee override, can override a soft limit with `?force=true`; a hard WIP limit has no override (`docs/api/cards.md` § Unarchive; `unarchive_card`, `services/cards.py:2676`). A collaborator cannot restore a card at all.

**Not verified:** behavior on PostgreSQL (the run was on SQLite, where the row lock is a no-op; the guards above do not depend on it); and whether any enterprise code or outside API client relies on these writes.

### Options

**A. Keep today's behavior and document it.** Archived means "off the board", not "frozen". Add a test that pins each 2xx in the table and a sentence in the docs.
- *For:* no behavior change. Matches the move exemption's reasoning ("tidying archived history is a legitimate operation").
- *Against:* the rule is hard to state: you cannot fix a typo in an archived card's title, but you can add a comment, a checklist item or a 10 MB file to it, and draw a relation from it that no one can draw to it. Writes no one on the board can see still notify the card's creator and assignee and anyone @mentioned, add to the card's activity history, broadcast and count against quotas, and their `card.updated` events reach feed readers and webhook subscribers, which do not drop them the way web clients do.
- *Backward compatibility:* none affected.

**B. Refuse every write listed above on an archived card with `404`**, as `update_card`, `delete_card` and block do. Removals included.
- *For:* one rule, "archived is read-only except move and restore". Same answer as the other card writes.
- *Against:* removing anything from an archived card means restoring it first. A collaborator who attached the wrong file cannot remove it at all, and a member cannot when the restore is refused: another member's card without the moderator entitlement, a full hard WIP limit, or a full soft limit they may not override. That matters most for a file that should not have been uploaded. A relation through an archived card can still be removed from its active end, which `docs/api/cards.md` already describes.
- *Backward compatibility:* calls that succeed today (201/200/204) start answering 404. No field or endpoint is removed or retyped, and the REST rules in `CLAUDE.md` do not say whether a behavior-only tightening counts as a breaking change. The relations view says it does: tightening a permission "is a breaking change for anyone who had come to rely on it", and "the reverse would need a major version" (`views/cards.py:2765–2769`). This record does not settle which reading applies; that is the owner's call. Either way the change needs a `changed` changelog fragment and an upgrade note. What is already shipped: the comment, attachment, checklist and relation writes are in GA releases (relations since v1.2.0); only the parent link and Needed writes are new in 1.3 and unreleased.

**C. Refuse additions and changes, keep removals.** `404` for adding a comment, uploading an attachment, adding, editing or reordering a checklist item, drawing a new relation from an archived card, linking it to a parent, and changing its Needed. Deleting a comment, an attachment, a checklist item or a relation, and unlinking its parent or a child, stays allowed, under the ownership rules it has today.
- *For:* an archived card takes no new content, which is what the existing guards already say about edits, blocks, children and relation targets. Removal stays possible without a restore, which is the case B breaks: a collaborator removing their own file, or an admin removing one from a card a hard WIP limit will not take back. Matches the relation rule already in the docs: existing relations to a card archived later "are kept and flagged, but a new one is refused" (`docs/api/cards.md:1068`), which the serializer explains as "listed and flagged so they can be removed" (`serializers.py:3186–3187`).
- *Against:* two rules instead of one. Deleting a comment from an archived card still changes its history, as it does on an active card today.
- *Backward compatibility:* as B, for the additions and changes only, including the open question of whether a behavior-only tightening is a breaking change. Every removal that works today keeps working.

**D. Answer `400` or `409` with `code: "card_archived"` instead of `404`** (a variant of B or C). It tells a client "archived" from "gone", which `404` does not, and matches `parent_archived` and `archived_card`. Against: the other archived-card writes (edit, delete, block) answer `404`, and changing those is out of scope. Not recommended unless the owner wants to move all of them in one release. *Backward compatibility:* as B or C, with the same open question of whether the tightening is breaking, which is left to the owner.

### Recommendation

> **RECOMMENDATION (implementer proposal, not a decision): option C**, with `404`, in 1.3.

Why C:

1. It extends the rule the code already follows: no new edits, blocks, children or relation targets on an archived card. Today's exceptions are the inconsistency the audit found.
2. It keeps removal possible without a restore, which B takes away from collaborators entirely and from members whenever a restore is refused (another member's card, or a full limit they cannot override).
3. The behavior change lands only on calls the web app never makes. Whether it is a breaking change does not depend on 1.3: the comment, attachment, checklist and relation writes already shipped in GA releases (relations in v1.2.0). Under the strict reading in the relations view (`views/cards.py:2765–2769`), tightening them is breaking now, so C needs the owner to accept that in a minor release or hold it for a major one. Under the loose reading it is not breaking, before 1.3 or after. Which reading applies is the owner's call (see B). The parent link and Needed writes are new in 1.3; guarding them before 1.3 ships means they never ship unguarded, under either reading.
4. `404` matches the other archived-card writes, so clients have one answer to handle. D is better as a separate decision covering all of them.

*What would change this to A:* a real report of a team commenting on, or attaching to, archived cards as part of its workflow (for example, a post-incident note on a closed card). *To B:* the owner preferring one rule over removal without a restore.

### If the owner approves

- **Any option:** add a dated note under this record ("Decided <date>: option X; see #1957") and change **Status** to Accepted. Close #1957 from the implementation MR.
- **A:** a test that pins every 2xx in the table above, and the A sentence below in `docs/features/card-archiving.md`. No changelog fragment.
- **C (and B, removals included):** one implementation MR with:
  - The guard in each handler, checked on the card row read under a lock, not on the earlier lookup, so an archive that commits between the lookup and the lock is still refused (the pattern `delete_card` uses at `services/cards.py:2984`). What that takes differs by handler (see the paragraph under the table): comment create, attachment upload, and checklist create and edit already hold `lock_card_for_write`, which returns the locked row (`services/cards.py:2181–2184`); each needs to keep that row and check its `archived_at`. The helper itself should not change: it has 11 callers outside tests (5 in `views/cards.py`, 5 in `services/cards.py`, 1 in `admin.py`), and some lock archived cards on purpose (`unarchive_card`, and `archive_card`'s no-op on an already-archived card); checklist reorder takes no card lock today and needs one added before its `bulk_update`; relation create's own `select_for_update()...values_list("pk")` reads only ids and needs to read `archived_at` for the URL card, and it runs only when `connection.features.has_select_for_update` (`views/cards.py:2802`), so the other branch's existence check (`:2829`) needs the guard too; the parent link create's `_lock_endpoints` returns only board ids and needs the same; `set_needed` already holds `lock_card_row`, which returns `archived_at`, so it needs only the check. Under B, each removal handler needs the same treatment. The guard denies when it cannot read the card (#1075): a missing row stays `404`.
  - A test per endpoint and role (the table above as the test plan), next to the active-card case, and one that a removal still works (C).
  - The text below in `docs/features/card-archiving.md` and `docs/api/cards.md`: the five POST and PATCH sections (comment create, attachment upload, relation create, checklist create and checklist edit), plus the reorder section, and the parent link `POST` and Needed sections.
  - A `changed` fragment in `changelog.d/` and a 1.3 note in `docs/administration/upgrade.md`.
  - Gates: `regression-check`, `rbac-check`, `security-review`, `api-docs`.

**Docs text pending the ruling (option C).** Not published; true only once the implementation MR lands. For `docs/features/card-archiving.md`, after the **Permission** line:

> **An archived card takes no new content.** You cannot add comments, attachments, checklist items or relations to an archived card, edit its checklist, link it to a parent or change its Needed; restore it first. You can still remove them: delete a comment, an attachment, a checklist item or a relation, or unlink its parent or a child, with the same permissions as on an active card. *Changed in 1.3 (#1957).*

For each refused endpoint in `docs/api/cards.md`, after its role line:

> Returns `404 Not Found` if the card is archived (*since 1.3*, #1957); nothing is saved.

Under A, the `card-archiving.md` sentence would instead read: "Comments, attachments, checklist items and relations on an archived card can still be added and changed over the API; the web app does not offer it."

---

<a id="group-membership-board-frames"></a>

## Board-channel frames for a group join or group role change

**Status:** Proposed, owner decision pending (#1743). This record proposes and decides nothing. Until the owner rules, a group join and a group role change send no frame on the board channel, as described below. The ruling is recorded as a dated note under this record, never as a silent rewrite.

**The question:** removing a user from a group sends `member.removed` on the board channel of every board where they lost access. Joining a group, or a role change on one, sends nothing on the board channel, only on the group channel. Should a join and a role change also reach the board channel, or is that a documented limitation?

**Where the question came from:** the 1.2 `/pre-release` audit (`broadcast-check`, wave 2), not a user report. The audit said it might be a design decision. No persona panel was run for this record.

### What the code does today

Read in the code at `main` of 2026-11-25 (`d81ef031b`). Nothing was run for this record. The line numbers in #1743's body are approximate; the ones below replace them. Line numbers in `docs/api/websockets.md` are on this branch, which adds one note to it.

- **Group removal fans out to boards.** `update_member`'s `DELETE` branch (`backend/groups/views.py:1053–1196`) walks the group's subtree (`:1073–1084`), drops the boards where the user has a direct `BoardMembership` (`:1088–1092`), and keeps the rest as `candidate_board_ids` (`:1093–1097`). After commit, `_evict_stale_ws` (`:1125–1169`) loads those boards in one query, re-checks `get_board_role` on each, and calls `record_board_event(bid, "member.removed", {"user_id": uid})` for each board where the role is now `None` (`:1159–1169`). The group channel gets its own `member.removed` (`:1183–1194`).
- **A role change does not.** The `PATCH` branch (`:1197–1257`) locks and writes the role (`:1226–1234`), then sends group-channel `member.updated` and the subgroups' inherited rows (`:1247–1256`). No board-channel `member.*` frame.
- **A join does not.** `JoinGroupView` (`views.py:2482`) creates the membership with `get_or_create` (`:2730`) and, on a fresh join, sends group-channel `member.added` plus the subgroups' inherited rows (`:2758–2765`). Registration with an invite takes the same path through `_grant_membership` (`backend/groups/invite_registration.py:277–308`). No board-channel `member.*` frame on either (a join that lowers a role can still send board-channel `board.updated` and `share_link.updated`, below).
- **Board-channel frames that do go out.** A demotion, or a join that lowers a role below admin, calls `revoke_lapsed_share_links` (`backend/groups/views.py:1236–1240`, `:2740–2745`; `backend/groups/invite_registration.py:285–292`). For each public share link the user enabled through the lapsed admin role, it sends board-channel `board.updated` and `share_link.updated` (`backend/boards/services/share_links.py:98–126`, `:226–227`). Those frames report the link, not the roster, so they do not answer the question.
- **An ownership transfer does not either.** `transfer_group_ownership` (`backend/groups/services.py:184`) can promote the new owner to admin (`:249–251`) and keeps the previous owner as admin (`:253–257`). Only the group channel is told (`docs/api/websockets.md:678`).
- **The board roster includes group members.** `/full/`'s `members` is the effective roster: direct rows, then group-inherited members from the nearest ancestor group, then the owner and site admins (`BoardFullSerializer.get_members`, `backend/boards/serializers.py:5912`). An inherited row has `id: null`, because it has no `BoardMembership` row (`EffectiveBoardMemberSerializer`, `:5576–5596`). A direct membership outranks any group role (`get_board_role`, `backend/boards/permissions.py:407`).
- **Board-channel `member.added` and `member.updated` carry a real membership row.** The members endpoint sends a `BoardMembershipSerializer` row (`backend/boards/views/boards.py:1852–1868`), board invite redemption sends the same row plus `invite` (`backend/boards/invites.py:258–264`), and the docs promise exactly that (`docs/api/websockets.md:502–503`). Every such row is a real `BoardMembership`, so its `id` is never `null`.
- **What the web app does with these frames.** `member.added` and `member.updated` upsert the row by `user.id`, not by `id` (`frontend/src/hooks/useBoard.ts:1484–1495`). A `member.updated` about the viewer also sets `current_user_role` and refetches `/full/` (`frontend/src/components/Board/BoardView.tsx:1079–1097`); the comment there says that without the frame the viewer "retains the wrong UI affordances until they reload the page". `member.added` also adds a "joined the board" entry to the live activity panel (`BoardView.tsx:1186–1195`).
- **Access and field filtering do not depend on these frames.** Before forwarding any frame, the board consumer re-checks the subscriber's role from the database, cached for 5 seconds plus 0 to 2 seconds (`backend/boards/consumers.py:54`, `:65`, `:309–320`; #1477). A `member.added` or `member.updated` about the subscriber skips the cache (`:309–310`, `MODERATOR_BEARING_EVENTS` at `permissions.py:40`). REST enforces the role on every write. `docs/api/websockets.md:513` and `:719` already say that a group role change publishes no board-channel frame and takes effect at the re-check.

**What goes stale, then.** On every open board in the group's subtree, other viewers' rosters do not show a user who joined, or show their old role after a change: the members panel, the assignee picker and @mention autocomplete. The user's own open board keeps its old `current_user_role`, so it shows editing controls they lost, or hides ones they gained, until a refetch. Their server-side access and the fields the socket sends them follow the new role within about 7 seconds. The web app refetches `/full/` on reconnect, on tab focus (at most every 30 seconds) and on **Refresh board** (`docs/api/websockets.md:762–767`), so the staleness lasts until the viewer next does one of those. API clients that follow the board channel or the change feed get nothing and keep the old roster until they re-read `/full/`.

**The same class, out of scope here:** a board moved to another group, a group moved under another parent, and a group delete (boards' `group` is `SET_NULL`, `backend/boards/models.py:86–88`) also change who can open a board without a board-channel `member.*` frame. `docs/api/websockets.md:513` names the board move only. Tracked as #2625, open; this record does not decide it.

**The race named in #1743.** `candidate_board_ids` is read before `transaction.atomic()` and before the lock at `views.py:1106–1108`. The code comment at `views.py:1059–1061` says the IDs are collected "inside the transaction", but `ATOMIC_REQUESTS` is not set (Django's default is `False`), so the read happens before any transaction opens; #2624 corrects the comment (no code is edited on this branch). Moving the read inside the block would not close the race by itself: the removal locks the group row `FOR NO KEY UPDATE` (`services.py:314`, step 2), and placing a board in a group takes only `FOR KEY SHARE` on the destination group (`lock_group_for_board_placement`, `services.py:96`), which does not conflict with it. A board moved into the subtree after the snapshot and before the delete commits is not in the list, so its `member.removed` is not sent. The consumer's re-check still closes the removed user's socket there within the window above. Other viewers' rosters on that board keep the user until a refetch. Reading the subtree's boards again in the `on_commit` callback, and evicting from the union of both reads, would close it.

**The fan-out cost.** Each evicted board costs one change-feed `INSERT` in its own short transaction and one channel-layer publish (`record_board_event`, `backend/boards/broadcast.py:465`), run one after another in the request that made the change. The role check before it is `get_board_role` in a loop (`views.py:1159–1163`), the N+1 that `get_board_roles` (`permissions.py:469`, a fixed two queries) exists to replace. Unlike the subgroup fan-out (500 subgroups at most, `websockets.md:678`), the board fan-out has no cap. A join or role change mirrored the same way would cost the same per board, and on every join rather than only on removal.

**Not verified:** behavior on PostgreSQL, the cost of the fan-out on a group with many boards, and whether any API client or enterprise code reads board-channel `member.*` frames and relies on `id` being a number. The enterprise repository is not checked out here: it may also write group memberships (SCIM or directory sync) and read `member.*` frames. Whoever implements option C or A must check those writers and readers too.

### Options

**A. Mirror the removal pattern: send board-channel `member.added` / `member.updated` on a join or role change.** After commit, resolve the user's effective role on each board in the subtree that has no direct membership for them, and send `member.added` where they had no access before, `member.updated` where the role changed, and nothing where it did not (a nearer group, or another path, can leave it unchanged).
- *For:* the web app needs no change: it upserts by `user.id` and already handles the self-role case (`BoardView.tsx:1079–1097`), and the consumer already re-checks the subject's role on these two events. Rosters and the viewer's own controls update live.
- *Against:*
  - The payload. No `BoardMembership` row exists, so the row would be the effective one, with `id: null`. Board-channel `member.added` and `member.updated` are documented as a `BoardMembershipSerializer` object and have always had an integer `id`. A client that splices rows by `id` breaks. `CLAUDE.md` § Backward compatibility reserves a change of a field's type for a major version; its example is nullable to required, and this is the reverse. Whether the reverse counts is the owner's call, but a client that splices by `id` breaks either way. The group channel already did the same thing on a shipped event: group-channel `member.updated` has been in GA since 1.1, documented as a full `GroupMembershipSerializer` object (`git show v1.2.0:docs/api/websockets.md`, emitted at `v1.2.0:backend/groups/views.py:923`), and 1.3's #2235 now sends it with `id: null` for inherited rows (`backend/groups/broadcast.py:254–263`, `websockets.md:678`). That change is not released yet, but it is the same integer-to-nullable change on a GA event that A would make on the board channel. So the project has already made, and not yet shipped, the choice A asks the owner to make; it is a precedent for A, not a reason to rule A out. Whether #2235's own change is acceptable under `CLAUDE.md` § Backward compatibility is an open question the owner may want to rule on (an observation here, not a new decision).
  - The "before" role. A join needs it to choose `member.added` over `member.updated` or nothing, so it has to be resolved before the write, for every board in the subtree, in the request.
  - The cost above, on every join, without a cap.
  - The live activity panel would show "joined the board" on every board in the subtree.
- *Backward compatibility:* breaking for any consumer that relies on a non-null `id` (above), by the strict reading of `CLAUDE.md`. #2235 already made the same change on the group channel's GA `member.updated`, so A is consistent with that precedent; if the owner accepts #2235, A's compatibility cost is the same one already accepted, and if not, both need revisiting together. Sending existing event types in more cases is otherwise allowed.

**B. Keep today's behavior and document it.** No code change. Say in `docs/api/websockets.md` that a join and a role change on a group send nothing on the board channel, what goes stale, and how a client recovers.
- *For:* no cost and no contract change. Access and field filtering already follow the new role within about 7 seconds, and REST enforces it, so nothing here is a security gap. Half of it is already documented (`websockets.md:513`, `:719`).
- *Against:* a board open all day keeps the old roster, and the user's own tab keeps the old controls, until a refetch. API clients have no signal at all.
- *Backward compatibility:* none affected.

**C. A new board-channel event for effective-roster changes.** For example `member.access_changed`, sent on a group join, a group role change and an ownership transfer, to each board where the user's effective role changed. Payload: the row exactly as `/full/` `members` lists it (`id: null` for an inherited row), filtered per subscriber like `member.updated` (`is_moderator`, `is_site_admin`).
- *For:* additive. New event types are allowed (`CLAUDE.md` § WebSocket event schema), clients must already ignore unknown ones (`websockets.md:179`), and the `member.added` and `member.updated` contract keeps its integer `id`. The web app can reuse its upsert and self-role handling. The same event can later cover the out-of-scope cases (board moved, group re-parented).
- *Against:* the cost and the "before" role are the same as A. One more event type to keep stable. It must be added to the emitted-event registry in `boards/broadcast.py`, the docs and a frontend handler, or the `ws-event-reachability` CI job fails (`.gitlab-ci.yml:3936`), and to `MODERATOR_BEARING_EVENTS` so the subscriber filter and the forced self re-check apply. An API client gains nothing until it handles the new event.
- *Backward compatibility:* none affected.

**D. A refetch signal only.** A new board-channel event such as `roster.changed` with `{}` or `{"user_id": <int>}`, on which clients refetch `/full/`. Not recommended: the board's only roster read is `/full/`, so every open tab on every board in the subtree would refetch the whole board on every join. `/boards/{id}/members/` lists direct rows only and cannot replace it.

### Recommendation

> **RECOMMENDATION (implementer proposal, not a decision; moderate strength): option B for 1.3, with C (or A, if the owner accepts the `id: null` precedent from #2235) as the route if a real need shows up.** Document the limitation now. The case against A rests mainly on cost and absence of a report, not on contract compatibility.

Why:

1. Nothing here is a security gap. The socket's access and the fields it sends follow the new role within about 7 seconds (#1477), and REST enforces it. What goes stale is the roster and the viewer's own controls, until the next reconnect, tab focus or refresh.
2. A changes a shipped payload contract (`id: null` on board-channel `member.added` and `member.updated`). That is arguable in a minor release, and it is less decisive than it first looks: #2235 made the same change on the GA group-channel `member.updated` (see A), so the compatibility argument does not separate A from what 1.3 already does. It still favors C slightly, which gets the same result additively and keeps the board channel's integer `id`, but this reason is weak and this recommendation rests on reasons 1, 3 and 4. If the owner accepts #2235's change and wants live rosters, A is a defensible choice at the cost in reason 3.
3. C costs a per-board fan-out with no cap on every join, plus a "before" role read for every board in the subtree in the request. Nobody has reported the stale roster. That is a lot to add to a `release::stretch` slot without a report.
4. B is half written already (`websockets.md:513`, `:719`) and closes the gap in the docs: today they do not say that a join sends nothing on the board channel, or that other viewers' rosters go stale.

**Under either option:** the removal path's race and its N+1 (above) are worth fixing on their own: read the subtree's boards again in the `on_commit` callback and evict from the union, and resolve roles with `get_board_roles`. That is a runtime change, so it is not on this branch. It is tracked as #2624, together with the per-board `get_board_role` N+1, the uncapped fan-out and the misleading comment. A per-change cap on the board fan-out, like the subgroup one, belongs in the same change.

*What would change this to C:* a real report of a team working from a stale roster (an assignee who cannot be picked, or a promoted member who cannot edit until a reload), or an API client that needs to follow the effective roster live.

### If the owner approves

- **Any option:** add a dated note under this record ("Decided <date>: option X; see #1743") and change **Status** to Accepted. Replace the "Open for the owner" note in `docs/api/websockets.md` § Member events with the outcome.
- **B:** a docs-only MR with the text below in `docs/api/websockets.md`. No changelog fragment. The race and N+1 fix above is #2624, a separate runtime change; the same-class cases are #2625. Then close #1743.
- **C:** an `architect` pass first (the "before" role read, the cap, the event name), then one implementation MR with: the emit in the join, registration, role change and ownership transfer paths, after commit (pending check: the enterprise repository's SCIM or directory-sync code may write group memberships too, and it is not checked out here, so its writers need the same emit); the new name in the `boards/broadcast.py` registry and `MODERATOR_BEARING_EVENTS`; a handler in `BoardView.tsx` that reuses the upsert and self-role code; the row in `websockets.md` § Member events, and `:513`, `:719` updated; tests for a join, a promotion, a demotion, a change that leaves the effective role unchanged (a nearer group, a direct membership), the subscriber filter, and the cap; an `added` fragment in `changelog.d/`. Gates: `architect`, `broadcast-check`, `perf-check`, `security-review`, `regression-check`, `api-docs`.

**Docs text pending the ruling (option B).** Not published; it states as decided what is today only undecided. For `docs/api/websockets.md` § Member events, after the table:

> **Watch out:** a change to a user's **group** membership sends no `member.*` frame on the board channel except removal. Joining a group, by invite link or at registration, a role change on a group, and a group ownership transfer are sent only on the [group channel](#group-channel-since-11). Every board in that group and its subgroups lists the user, with a role taken from the nearest group they belong to, but no `member.added` or `member.updated` frame announces it. Until a client re-reads `GET /api/v1/boards/{id}/full/`, its roster lacks a user who joined, or shows their old role. A user whose own role changed this way keeps the old `current_user_role` until that re-read, although the server enforces the new role at once and the socket applies it within the [access re-check](#access-re-check-and-eviction) window. The Visiban web app re-reads on reconnect, on tab focus and on **Refresh board** (see [Missed frames](#missed-frames)). This is by decision (#1743; see [Technology Decisions](../architecture/decisions.md#group-membership-board-frames)): it is not a security gap, because access is re-checked within about 7 seconds; sending these frames would add a per-board fan-out on every group join; and no one has reported a stale roster. The payload shape is a secondary consideration: `member.added` and `member.updated` carry a board membership row with a numeric `id`, and a group-inherited member has no such row.

And in `:513` and `:719`, the list of changes that publish no board-channel frame becomes "joining a group, a group-membership role change or ownership transfer, a board moved to another group, or a change to the user's all-content access".
