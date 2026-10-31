<a id="technology-decisions"></a>

# Why the stack is a boring monolith

Why each piece of the Visiban stack was chosen, not just what was chosen, for contributors, self-hosters, and anyone evaluating the trade-offs.

**Why it matters:** Each choice trades power for fewer moving parts. Check the reasoning before proposing a replacement.

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
