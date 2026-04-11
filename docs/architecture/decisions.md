# Technology Decisions

This page explains *why* each component of the Visiban stack was chosen, not just *what* was chosen. It is written for engineers evaluating self-hosting, potential contributors, and technical evaluators who want to understand the trade-offs behind the architecture.

---

## Guiding principle

The stack follows one rule: choose the simplest thing that could work correctly and securely, and resist adding complexity until it genuinely earns its place.

Visiban is a well-built monolith, containerised, with a clear upgrade path to Kubernetes when scale demands it. There are no microservices, no message queues, and no separate search index in the default deployment. Each of those patterns has a real cost — operational overhead, more failure modes, more moving parts for a self-hoster to manage. None of them was justified at the scale Visiban targets out of the box.

The upgrade path exists. Redis is already present for WebSocket channel messaging. The Helm chart deploys today what a Kubernetes migration would require. But the complexity is not paid upfront.

---

## Django + Django REST Framework

Django is a battle-tested Python framework with a large, stable ecosystem and a well-understood security model. The ORM eliminates raw SQL by default — parameterised queries are the path of least resistance, not something that has to be remembered. That is a security property built into the stack rather than bolted on.

Django REST Framework adds serialiser-level validation and permission enforcement from day one. The pattern encourages checking auth and input shape at the API boundary, before business logic runs.

From a hiring and contribution perspective, Django is one of the most widely understood Python frameworks. A contributor familiar with Django elsewhere can navigate Visiban's backend without a learning curve specific to this project.

`bandit` (security linting) and `ruff` (style and correctness) both integrate naturally into the CI pipeline for Django/Python projects — they were not added specially for Visiban.

---

## Django Channels + ASGI (daphne)

Real-time board updates required WebSocket support. The alternative would have been a separate Node.js service, which would have doubled the operational surface: a second language runtime, a second process to monitor, a second image to build and maintain.

Django Channels handles WebSockets inside the same Django codebase. The migration from gunicorn (WSGI) to daphne (ASGI) was the only infrastructure change required — all existing HTTP views, serialisers, and middleware continued working without modification.

Two design choices keep the WebSocket layer correct:

- Every board mutation broadcasts to connected clients only after `transaction.on_commit()`. This ensures that clients never receive a real-time event for a write that was later rolled back. Without this guard, a failed transaction could leave clients holding state that does not exist in the database.
- The server sends a keepalive ping every 30 seconds. NAT gateways and reverse proxies silently drop idle TCP connections on timescales that vary by environment. The ping prevents that; the frontend auto-reconnects on a missed ping.

---

## PostgreSQL 17

The audit trail is the defining feature of Visiban. A `CardMovement` record must commit atomically with the card position update — either both rows land or neither does. PostgreSQL's ACID guarantees make this straightforward. An eventually consistent store would require compensating logic to achieve the same correctness guarantee.

Three specific PostgreSQL capabilities are in active use:

**JSONB** stores flexible activity payloads. When a new event type is introduced, the payload shape changes without a schema migration. Structured queries against JSONB fields are still possible when needed.

**Functional indexes** enforce case-insensitive username uniqueness at the database layer. Application-level uniqueness checks have a race window; a unique index does not.

**PostgreSQL 17** was chosen to stay current with upstream. Patch releases are in-place upgrades. Major version upgrades (e.g. 16 → 17) are not in-place on a running container — they require a dump-and-restore or pg\_upgrade. The upgrade guide in the deployment docs covers the recommended export-first path.

!!! note "Major version upgrades"
    PostgreSQL major version upgrades are not in-place. Always export your data before upgrading the `postgres` image tag to a new major version. See [Upgrading](../administration/upgrade.md) for the step-by-step procedure.

---

## React 19 + TypeScript + Vite

TypeScript was chosen primarily for its ability to catch contract drift between backend serialisers and frontend interfaces at compile time. Without static types, a renamed serialiser field silently becomes `undefined` in the browser — an error that only surfaces at runtime, in a customer session. With TypeScript, the same mistake is a build failure.

The `Board`, `Card`, `User`, and related interfaces are defined to match backend serialiser fields exactly. This is enforced by convention and caught by the type system: when a backend field is added or renamed, the corresponding TypeScript interface must be updated in the same MR.

Vite's dev server keeps iteration fast. Hot module replacement works well with the component structure and avoids the multi-second rebuild cycles of older bundlers.

React 19's concurrent rendering keeps the board responsive during large drag operations across many swimlanes. The board can contain dozens of cards in a dense grid; synchronous rendering of large drag state updates would produce visible jank.

---

## @dnd-kit

react-beautiful-dnd was the default choice for Kanban-style boards for several years. It was deprecated in 2023 and is no longer maintained.

`@dnd-kit` is its modern successor. It is accessible by default, headless (no bundled styles), and designed specifically for complex multi-container layouts. The column × swimlane grid in Visiban is exactly the kind of layout where simpler drag libraries break down — each card can be dropped into any cell of a two-dimensional grid, not just reordered within a list.

Optimistic updates on drag mean the UI feels instant: the card moves visually before the API call completes. Rollback on API failure means the board stays correct: if the server rejects the move, the card returns to its original position. The headless approach means drag behaviour is fully controlled — there is no third-party drag style to fight or override.

---

## Tiptap (ProseMirror)

Card descriptions support rich text: formatting, inline code, mentions, and links. The editing experience needed to match what engineers and project managers expect from modern tools.

Tiptap wraps ProseMirror in an extension-based API. `@mention` autocomplete is just another extension — it plugs into the same system as bold or code formatting, rather than being wired specially into the editor. Adding a new inline extension does not require touching the core editor logic.

Card content is stored as Markdown server-side. This keeps the data portable: card descriptions are readable outside the UI, exportable, and not locked to a specific editor's internal format.

Tiptap was chosen over Slate and Quill for two reasons: first-class TypeScript support (no `@types/` shims required), and an active extension ecosystem that has been maintained through multiple ProseMirror major versions.

The headless approach means the editor inherits the design system's styles rather than overriding them with its own opinionated defaults.

---

## django-allauth headless

Authentication is one of the highest-risk areas in any application. The decision was to use one well-maintained library for all auth rather than building auth flows in-house or composing several smaller packages.

django-allauth covers email/password, Google/GitHub/GitLab OAuth, and generic OIDC (Keycloak, Authentik, Okta, Dex, and any OIDC-compliant IdP) from a single dependency. Generic OIDC is part of the OSS distribution — it uses the same `django-allauth` stack as the social providers and requires no enterprise tier.

Headless API mode separates the concerns cleanly: the React SPA controls what the login screen looks like and how it behaves, while allauth handles OAuth redirects, token exchange, and session management underneath. There is no Django-rendered login page to style or maintain.

Personal Access Tokens (`vbn_` prefix) are implemented on top of allauth's session model. Tokens are shown once at creation time, stored as a hash at rest, and revoked on password change. The prefix makes tokens easy to identify in logs and rotate tooling.

---

## Redis

Redis is in the stack because Django Channels requires a channel layer backend for WebSocket group messaging. When a card moves on one board, the event needs to be broadcast to all connected clients watching that board — Redis is the pub/sub intermediary that makes that possible across multiple daphne workers.

Redis also serves as the Django cache backend, using a separate database index from the channel layer so cache flushes do not disrupt active WebSocket connections.

The Bitnami Redis subchart in the Helm chart is pinned to a specific version (7.4.3) for reproducibility. Unversioned upstream chart dependencies have caused unexpected breakage in the past when charts are updated between deploys.

Persistence is intentionally disabled for the channel layer. A Redis restart drops in-flight WebSocket messages, but clients reconnect automatically and resync board state from the REST API. The alternative — persisting the channel layer — would complicate the operational model without meaningful benefit: board state is the source of truth in PostgreSQL, not Redis.

---

## Docker Compose + Helm

Self-hosting is a first-class requirement, not an afterthought. The deployment story needs to work for a single engineer on a $5 VPS and for a platform team running Kubernetes at scale.

`docker-compose.prod.yml` handles the former. It enforces mandatory credentials: `DB_PASSWORD` and `DOMAIN` fail fast with a descriptive error if unset. No insecure defaults ship in the production configuration — a missing secret is a loud error, not a silent fallback to an empty string.

The Helm chart handles the latter. It supports two secret management patterns:

- **Chart-managed secrets**: sensitive values go in a gitignored `values.secret.yaml` file. Simple to set up; appropriate for small teams.
- **`existingSecret` passthrough**: the chart references a Kubernetes Secret by name rather than creating one. This integrates cleanly with Vault, Sealed Secrets, External Secrets Operator, and any other external secrets manager — the chart does not need to know how the secret was created.

!!! tip "Choosing a secret management pattern"
    If you are running Visiban on a single cluster without an external secrets manager, the chart-managed pattern is simpler. If you have Vault or ESO already in your environment, use `existingSecret` so Helm never holds the plaintext values.

CI image builds use kaniko instead of Docker-in-Docker. kaniko does not require a privileged container and runs cleanly on Kubernetes-based CI runners. Docker-in-Docker requires either privileged mode or a `docker:dind` sidecar service, both of which introduce unnecessary attack surface and are incompatible with most locked-down Kubernetes runner configurations.

---

## CI pipeline design

The CI pipeline is a gate, not a suggestion. Every job that fails blocks the merge — there is no override path for a failing pipeline.

Key design decisions and the reasoning behind each:

**90% backend coverage floor.** The pipeline fails if coverage drops below 90%. The number was chosen to be high enough to catch regressions without requiring coverage of trivially untestable code (migrations, admin registrations). The threshold is enforced by the coverage job, not by convention.

**Ruff and ESLint.** Style and correctness are enforced before code review. Reviewers spend time on logic, not whitespace or import order. Both tools are fast enough to run on every commit without adding meaningful pipeline time.

**GPL license check.** The project is Apache 2.0. GPL-2.0 and GPL-3.0 dependencies are blocked. Including a GPL dependency in an Apache 2.0 project creates a license compatibility problem that cannot be resolved without removing the dependency. The license check job catches this at the point of introduction rather than at legal review.

**SAST (Semgrep, Bandit, SonarQube).** Static analysis runs on every MR. Bandit covers Python-specific security patterns (hardcoded secrets, `shell=True`, unsafe deserialization). Semgrep adds cross-language rules including custom rules for Visiban-specific patterns. SonarQube provides the persistent quality history.

**Migration safety job.** This job catches three dangerous patterns before they reach production: missing migrations (a model change with no corresponding migration file), destructive column operations (DROP COLUMN in a migration), and NOT NULL columns added without a default (which blocks zero-downtime deploys). These are the three most common sources of production migration incidents.

**Claude Code reviewer stage.** A dedicated CI stage runs the Claude Code reviewer on every MR. This catches patterns that static analysis misses — incorrect permission checks, missing `transaction.on_commit()` wrappers on broadcast calls, serialiser fields that expose data beyond what the endpoint should return.
