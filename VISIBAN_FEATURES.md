# Visiban — Full Feature Reference

## What is Visiban?

Visiban is a self-hosted, open-core Kanban board for teams of any size — from a single squad to a large organization. It runs on Django + PostgreSQL (backend) and React + TypeScript (frontend), deployable via Docker Compose or Helm. The core product is Apache 2.0 licensed with unlimited users and boards, so cost doesn't scale with headcount the way a per-seat SaaS tool does. Enterprise features (SSO, audit logs, automation, integrations) are in a separate private repo — as of this writing, **SAML SSO and SCIM directory sync are still in development there, not yet shipped**, which matters if a rollout depends on centralized identity provisioning at scale.

---

## Tech stack

- **Backend:** Python 3.12, Django 5, Django REST Framework, PostgreSQL 17, django-allauth, Daphne (ASGI)
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS 3, @dnd-kit, Tiptap (rich text, 3.x), React Router v7, Axios
- **Real-time:** WebSockets (Django Channels)
- **Infra:** Docker Compose, Helm (Kubernetes), Nginx, kaniko (CI builds)
- **Auth:** django-allauth headless/API mode, OAuth (Google, GitHub, GitLab), OIDC

---

## Board structure

### Core concepts

| Concept | Description |
|---|---|
| **Board** | A workspace containing columns and swimlanes. Boards belong to a user (owner) or a group. |
| **Column** | Represents a workflow stage (e.g. To Do, In Progress, Done). No fixed per-board limit. |
| **Swimlane** | A horizontal row dividing the board by customer, team, priority, or any other dimension. No fixed per-board limit. |
| **Cell** | The intersection of a column and swimlane — a droppable zone for cards. |
| **Card** | A unit of work. Lives in one cell. Has title, description, priority, assignee, labels, due date, weight, checklist, comments, attachments, custom fields, relations, and movement history. |
| **Label** | A colored tag attached to cards for categorization. Board-scoped. |

*Column/swimlane counts are unbounded on the board itself; only bulk **import** operations are capped (50 columns / 100 swimlanes per file — see Import/Export).*

### Board templates

11 built-in templates seed columns and a lane label on creation:
- Sales Pipeline
- Customer Support
- Customer Success
- Simple Kanban
- Product Roadmap
- Project Delivery
- Content Production
- Hiring & Recruiting
- Legal & Compliance
- Infrastructure & DevOps
- Blank Board

### Board creation flow

1. Pick a template (or Blank Board)
2. Name the first swimlane (using the template's lane label, e.g. "Account")
3. Set board name
4. Optionally mark as your default board (login redirects there)

---

## Cards

### Fields

| Field | Type | Notes |
|---|---|---|
| Title | text | Required |
| Description | rich text (Tiptap/markdown) | Stored as markdown; renders with bold, italic, code, lists, heading, blockquote, text color |
| Priority | enum | urgent / high / medium / low |
| Assignee | user FK | Board member |
| Labels | many-to-many | Board-scoped |
| Due date | date | Overdue dates shown in red |
| Weight | integer | Story points / effort estimate |
| Custom fields | board-defined | See Custom fields section |
| Stable UID | 16-char hex | Immutable external reference |

### Card actions

- Create inline (click "+ Add card", double-click empty cell, or right-click cell)
- Edit all fields in a card detail panel
- Move via drag-and-drop between cells (optimistic update + rollback on failure)
- Move via "Move to" button in the card detail panel (column + swimlane picker without closing the panel)
- Archive (soft-delete) — hidden from board, restorable from Archived panel; shows toast with direct link to Archived panel
- Delete (permanent, confirmation required)
- Bulk select + bulk archive / bulk assign / bulk priority / bulk delete

### Card relations

- Link cards as **blocks** / **blocked by** / **relates to**
- Card face and detail panel show a `blocker_count` so blocked work is visible without opening the card

### Card detail panel

- Rich text description editor (Tiptap) — click to edit, Save/Cancel
- @mention autocomplete in descriptions — member picker on `@`, sends in-app notification
- Comment thread with avatars (distinct color per user)
- @mention in comments — notification on each comment (no re-notification guard — each comment is a new event)
- Checklist items (add, check/uncheck, delete) — collapsible section
- File attachments (up to 10 MB by default, operator-adjustable via `MAX_UPLOAD_SIZE_BYTES`; allowlisted MIME types) — collapsible section
- Custom field values (see Custom fields section) — up to 2 pinned to the card face
- Movement history (which columns/swimlanes the card moved through, and when)
- Field-change activity log (who changed what and when) — tracks title, description, priority, weight, assignee, labels, due date, checklist items, comments, attachments; rapid-fire changes to the same field are debounced and collapsed into a single net entry
- "Show full history" toggle persists across sessions via `localStorage`
- Scroll gradient when content overflows

### Card face metadata

- Priority border color (full border, all sides)
- Label chips (up to 3, truncated)
- Checklist progress (`✓ done/total`)
- Due date (overdue shown in red)
- Weight — shown when weight > 1
- External reference badge — a linked PR/MR (`external_ref`) shown on the card face when set
- Pinned custom field values (up to 2 per board)
- Last-moved label — relative text (e.g. "moved yesterday", "moved 3 days ago") for cards not moved within the last 24 hours; cards moved within 24 hours show a blue dot indicator on hover; togglable per-board via Board Settings → Card fields

### Card movement audit trail

Every column or swimlane change creates a `CardMovement` record:
- `from_column` / `to_column`
- `from_swimlane` / `to_swimlane`
- `moved_by` (user)
- `moved_at` (timestamp)
- `movement_type` — one of `move`, `archived`, `unarchived`

Card creation also produces a movement record with `from_column=None` so the History tab always has at least one entry, even for cards that have never left the Backlog.

Pure reorders (same cell, different position) do not create movement records.

---

## Custom fields

- **Cards** — up to 30 custom field definitions per board; up to 2 can be pinned to the card face
- **Swimlane rows** — up to 15 custom field definitions per board; up to 3 can be pinned
- Definitions are board-scoped; values attach per-card or per-swimlane respectively

---

## Board UI

### Layout

- CSS Grid: columns (x-axis) × swimlane rows (y-axis)
- Swimlane label sidebar on the left (resizable by dragging right edge, persisted to localStorage)
- Column headers sticky on scroll, show WIP count
- Optional grid overlay per cell: none, or a card-count badge
- Optional WIP limit enforcement (`enforce_wip_limits` board setting): moving a card into a full column returns an error; board admins can override; archived cards excluded from count
- "At-limit" indicator — visually distinct state when a column is exactly at its WIP limit, ahead of actually going over; off by default (`show_wip_at_limit` board setting), admin-toggled
- Optional weight limit enforcement (`enforce_weight_limits` board setting): moving a card that would push a column over its weight budget is blocked; board admins can override; archived cards excluded from weight sum
- Hard WIP enforcement (`enforce_wip_hard` board setting): when enabled, WIP/weight limits block all roles including admins — no force override available
- Both WIP and weight enforcement default to **on** for newly created boards

### Board navigation

- Sub-nav tabs (Board / Summary / Analytics / History) are URL-addressable via `?view=` — tabs can be bookmarked and shared; Back button skips tab transitions
- Board-level History tab with filterable movement log — search by swimlane, column, user, and date range
- Space + drag panning — hold Space to enter pan mode (cursor changes to grab), then drag to scroll the board without activating card drag-and-drop
- Drag-and-drop is announced via an `aria-live="polite"` status region ("Moved `<card>` to `<column>` / `<swimlane>`") for screen-reader users

### Resizing

- Column widths: drag right-edge separator — persisted per-column per-board in localStorage
- Swimlane row heights: drag bottom edge — persisted per-swimlane per-board in localStorage
- Swimlane sidebar width: drag right edge — persisted per-board in localStorage

### Column / swimlane management

- Rename inline: click the name, Enter to confirm, Escape to cancel
- Full settings modal: double-click header / label, or ✎ icon
- Column settings modal includes an admin-only "Delete column" danger button (alternative to the drag-to-trash gesture)
- `is_done` flag per column — marks columns as completion targets for cycle-time and throughput metrics; done columns are excluded from the dwell-time heatmap; set automatically on terminal columns (e.g. Done, Closed Won) when using a template
- Add column/swimlane via "+" on the separator handles
- Reorder by dragging (collapsed columns can also be dragged)
- Collapse columns (click to toggle); collapsed columns with filter matches pulse with a count badge

### Filters and search

- Filter by: priority, label, assignee, due date (overdue, upcoming)
- Active filter count badge on the filter bar
- Saved filter presets — save and restore named filter combinations per board; user-private, stored server-side; any board member (including viewers) can save presets
- Server-side card search (title + description, case-insensitive, debounced 300ms with AbortController cancellation) — scoped to the current board; client-side filters intersected with server results
- Command Palette (⌘K) — quick card search and board-jump while on a board; off a board it jumps between boards only. True cross-board card search isn't wired up yet (see Known gaps)
- Filter state persisted to localStorage per board
- "No cards match the active filters" banner when filters produce zero results

### Keyboard shortcuts

- `Escape` — closes the topmost open modal/popover/dialog, then clears selection, then navigates back (consistent across all pages and modals)
- `f` — opens filter panel (disabled when typing in editor/input)
- Enter in new-card input — configurable per-user (submit + close or just submit)

---

## Appearance

- Theme preference — system / dark / light, per user; respects `prefers-color-scheme` when set to "system"
- A semantic design-token layer (surface, foreground, border, primary tones) backs every surface, modal, drawer, and badge in both modes

---

## Swimlane features

- Collapsible swimlane rows
- Contact email and notes fields
- Custom field values (see Custom fields section)
- Color picker
- Position reorder
- Focus mode — crosshair button dims all other swimlanes; URL-addressable via `?focus=<swimlane_id>`; toggles off on second click

---

## Board sharing

Boards can be shared as a public read-only link with no login required.

- Board admins generate or revoke a share token from Board Settings
- Share link serves a static read-only board view at `/share/:token` — full grid with column headers, swimlane labels, and card tiles (title, labels, checklist progress, due date, weight, assignee)
- Revoking the token immediately invalidates the link; visitors see a "This board is no longer shared" page
- Share links expose only non-sensitive card fields — no comments, attachments, or movement history
- Rate-limited to 120 requests/hour per IP, and 240 requests/hour per token

---

## Groups

Groups are workspaces that contain boards and users. Groups support nested subgroups (up to 6 levels deep).

### Group roles

| Role | Can do |
|---|---|
| Admin | Full group management: members, subgroups, settings, invite links, board creation |
| Member | View group and its boards |
| Collaborator | View group and its boards |
| Viewer | View group and its boards |

Group admin role cascades to board-admin on all boards in the group (handled by `get_board_role()` which walks the ancestor tree).

### Group features

- Optional description field — visible on the group detail page, inline-editable by admins, settable at creation
- Ancestor breadcrumb chain on the group detail page for subgroups, linking up through the hierarchy
- Inline group rename by clicking the group name heading (admin only)
- Invite links (shareable URL granting a specified role on redemption)
- Transfer group ownership
- Default board member role setting (controls what role new board members get)
- Allowed card priorities setting
- Sidebar shows groups and boards as a recursive tree in expanded mode; collapsed rail shows a Groups flyout with subgroups nested at correct depth

---

## Roles and permissions

### Board roles

| Action | viewer | collaborator | member | admin |
|---|:---:|:---:|:---:|:---:|
| View board, cards, columns, swimlanes | ✅ | ✅ | ✅ | ✅ |
| View movements & activities | ✅ | ✅ | ✅ | ✅ |
| View archived cards | ✅ | ✅ | ✅ | ✅ |
| Post comments | ❌ | ✅ | ✅ | ✅ |
| Delete own comment | ❌ | ✅ | ✅ | ✅ |
| Delete any comment | ❌ | ❌ | moderator or admin | ✅ |
| Upload attachments | ❌ | ✅ | ✅ | ✅ |
| Delete own attachment | ❌ | ✅ | ✅ | ✅ |
| Delete any attachment | ❌ | ❌ | moderator or admin | ✅ |
| Add / edit / delete checklist items | ❌ | ✅ | ✅ | ✅ |
| Create / edit / move / delete cards | ❌ | ❌ | ✅ | ✅ |
| Archive / unarchive cards | ❌ | ❌ | ✅ | ✅ |
| Manage columns / swimlanes / labels | ❌ | ❌ | ❌ | ✅ |
| Manage board members | ❌ | ❌ | ❌ | ✅ |
| Generate / revoke share link | ❌ | ❌ | ❌ | ✅ |
| Export board | ❌ | ❌ | ✅ | ✅ |

### Moderator entitlement

- `is_moderator` boolean on `BoardMembership` — grants content-moderation rights (delete/archive other users' cards, delete others' comments and attachments)
- Only valid for `member` and `admin` roles — collaborators and viewers cannot be moderators
- Automatically cleared when demoting to collaborator or viewer

### Site admin

- `is_site_admin` boolean on User — gates `/api/admin/*` endpoints and the Admin Panel
- `can_access_all_content` boolean — separately controls omniscient board/group access (existing site admins are automatically migrated to `can_access_all_content=True`)

### Site admin panel (`/admin`)

- Registration mode: Open / Invite-only / Closed
- User management: list, create, deactivate, promote to site admin, force password reset
- User deactivation triggers offboarding flow — board ownership is transferred to an eligible member before the account is deactivated; blocked when no eligible transfer target exists
- File uploads toggle — enable or disable attachment uploads instance-wide; existing attachments remain accessible when uploads are disabled
- Invite links — admins can create site-wide invite links with optional TTL (1d / 7d / 30d) and single-use flag; "Invite Links" tab shows status badges and supports inline revocation
- Invite link auto-join — authenticated users are joined automatically on arrival; OAuth users are joined immediately after provider redirect; invite-token registration works even when registration is globally closed
- **Maintenance mode** — a read-only instance toggle; non-admin writes get a `503` with a `maintenance_mode` error code while it's on, admins are exempt
- **Admin-configurable SMTP** — Admin → Settings → Email lets an admin set SMTP credentials from the UI (encrypted at rest) with a test-send action, instead of env vars only
- **Site-wide admin action log** — records who changed maintenance mode, registration mode, or the file-uploads toggle, and when (distinct from the per-card field-change activity log, and from the board-level admin audit log, which is not yet implemented — see Known gaps)

---

## Authentication

- Email + password
- OAuth: Google, GitHub, GitLab (via django-allauth)
- Generic OIDC — configurable via `OIDC_CLIENT_ID`, `OIDC_SECRET`, `OIDC_SERVER_URL`; optional `OIDC_PROVIDER_NAME` controls the login button label (default "SSO"); provider only registered when all three required vars are set
- Personal Access Tokens (PATs) — create from Settings → Access Tokens; carry a `vbn_` prefix; shown only once at creation; optional expiry up to one year; max 10 per user; all tokens revoked on password change
- Invite-only and closed registration modes
- Force-password-reset on first login (admin-assignable)
- Force-username-change — case-insensitive username uniqueness enforced via PostgreSQL functional index; existing collisions resolved automatically by migration (winner keeps username, losers pick a new one via a non-dismissable modal on next login); `POST /api/auth/choose-username/` endpoint for API/PAT clients
- Default board redirect on login

---

## Notifications

- In-app notification bell
- Triggers: @mention in description, @mention in comment, card assigned to you, board invite (added to a board), card moved, comment added, due date warning
- Re-notification guard on description edits (won't re-notify the same user for the same mention)
- Deep-link from notification to the card
- Per-user notification preferences in Settings → Notifications (each trigger toggleable; board invites default on)
- Email delivery — per-trigger channel split (in-app / email / both); gated by `NOTIFICATION_EMAIL_ENABLED` (instance default **on** — configuring SMTP is the only step needed to enable it), with a configurable send timeout; per-user email preferences default to **off**, so nothing sends until a user opts in
- Capped at 50 most recent per user in-app; independently, notifications older than `NOTIFICATION_RETENTION_DAYS` are pruned by a background job

---

## Real-time (WebSockets)

All board mutations broadcast to connected clients after `transaction.on_commit()`:

- Card created, updated, moved, deleted, archived
- Comment added
- Attachment added / deleted
- Checklist item added / updated / deleted
- Label created / updated / deleted
- Member added / updated / removed
- Column / swimlane reordered
- Board updated / deleted

Each WebSocket frame carries an `event_id`. A polling-friendly alternative — a board change-feed endpoint — is also available for clients that can't hold a persistent connection.

Server-side keepalive ping every 30 seconds prevents NATs and reverse proxies from dropping idle connections; frontend detects a missing ping within 45 seconds and auto-reconnects.

Live indicator is three-state: green "Live" when connected, amber "Reconnecting…" while attempting to reconnect, grey "Offline" when the connection has permanently failed. Evicted members have their WebSocket connection closed immediately on removal.

**WebSocket ticket auth** — token/PAT/CLI clients (anything that can't rely on a session cookie) call `POST /api/v1/auth/ws-ticket/` with any supported credential and pass the returned value as `?ticket=` on the upgrade, instead of being closed with `4001`. Tickets are single-use, expire after 30 seconds, and are stored hashed. Board and group membership is still enforced on every connection; the browser SPA's session-cookie handshake is unchanged.

---

## Issue Board Lens (Git-backed boards)

*OSS core — not gated behind the enterprise edition.*

An optional, read-only board view that mirrors a public GitHub or GitLab repository's issues and merge/pull requests into a Visiban-style pipeline board, so a team doesn't have to manually recreate status that already lives in the forge.

- Off by default — enabled instance-wide via `GIT_LENS_ENABLED`
- Columns derive from issue/PR state; swimlanes and the label panel are user-configurable, and both are resizable (mirrors the native board's resize gesture, sizes remembered per board)
- Pivot by status, milestone, label, or assignee
- Filters: state, milestone (including an explicit "no milestone" option), label (AND-combined, up to 5 at once), and free text — applied server-side so they reach issues beyond the fetch cap, not just the already-loaded page
- Current-milestone highlighting — sorts to the top of the board and is marked "Current"; detected automatically (nearest active milestone by due date, falling back to the one with the most in-progress work)
- Admin-only outbound-call observability — `GET /api/v1/admin/git-lens/usage/` reports the last 24 hours of provider API call counts (per provider, resource kind, and outcome), cache hit/miss rates, and the fixed limits that bound the traffic; each call is also logged as one structured `git_lens.outbound` line with no tokens or query values

---

## MCP server (AI agent integration)

*OSS core — not gated behind the enterprise edition.*

Visiban exposes a Model Context Protocol server (`/mcp`) so an MCP-compatible AI agent can read and act on boards under the same role-based permissions as a human user — no bypass of board membership or role checks.

- Tools: `list_boards`, `list_columns`, `list_swimlanes`, `list_cards`, `create_card`, `move_card`, `update_card`, `archive_card`
- Every token needs `mcp:read` just to open a session; write tools (create/move/update/archive) additionally require the `mcp:write` scope

---

## Analytics

- **Dwell-time heatmap** — how long cards spend in each column; coloring is threshold-based: green (well under threshold), yellow (within the warning band), red (at or above threshold)
- `staleness_threshold_days` board setting — configurable stale threshold; used by both the heatmap and stall detection
- `stale_warning_pct` board setting (0–100, default 50) — controls the yellow warning band width in the heatmap
- **Stale card detection** — lists cards inactive beyond the board's stale threshold; stalled card rows are clickable and open the card detail panel
- **Period filter** (7d / 30d / 90d) — correctly scopes dwell times and velocity calculations to the selected window; shows "No card movements recorded in the last N days" when the window is empty
- Analytics export (CSV) — admin only
- Board summary endpoint

*Cross-board portfolio analytics (cumulative flow diagrams, cross-board cycle-time reporting) are not part of OSS core — see the enterprise repo's roadmap.*

---

## Import / Export

### Export

- **JSON** (recommended) — full board state: columns, swimlanes, labels, cards, movements, activity log, assignees; includes `schema_version: 1`
- **CSV** — one row per card; card data only, no movement history

### Import

- JSON (Visiban export format) — restores full card history including movements, activities, and assignees
- CSV (flexible: accepts lowercase/snake_case headers; `due_date`, `duedate`, `Due Date` all work)
- **Trello board import** — imports a Trello board export directly, in addition to the native JSON/CSV formats; has its own, higher limits (5,000 cards / 50 lists / 1,000 members / 50,000 actions)
- Limits for native JSON/CSV import: 500 cards, 50 columns, 100 swimlanes per import
- Auto-creates columns, swimlanes, labels from values seen in the file
- Creates importer as board admin

---

## Stable UIDs

Every board, column, swimlane, label, and card carries a 16-character hex `uid` that is:
- Unique across the instance
- Read-only (never changes on rename/move)
- Never reused after deletion
- Suitable for external integrations and webhooks

---

## Security

- Global permission gates — `MustNotHavePendingPasswordChange` and `MustNotHavePendingUsernameChange` are enforced on all viewsets via `DEFAULT_PERMISSION_CLASSES`; users with a forced password or username change are locked out of the full API until they comply
- No raw SQL — ORM only
- Input validation at serializer boundary
- Object-level authorization (IDOR prevention)
- Admin panel restricted to loopback IP in production
- `SECRET_KEY` validation at startup
- No default DB password in production compose
- File attachment MIME type + magic byte validation; size capped at 10 MB by default (operator-adjustable via `MAX_UPLOAD_SIZE_BYTES`)
- Text file polyglot XSS prevention (HTML/script markers rejected in first 4 KB)
- `Content-Disposition: attachment` enforced on all media downloads (no inline rendering)
- Invite link tokens hashed SHA-256 (raw token returned once at creation)
- CSV export formula injection protection
- User search rate-limited (30 req/min)
- Invite link redemption rate-limited (10/hr per IP)
- CORS validation prevents localhost origins in production
- Import size limits (500 cards, 50 columns, 100 swimlanes)
- SAST: Semgrep + Bandit (backend), eslint-plugin-security (frontend); secret scanning via `gitleaks-scan`; dependency/license/image scanning in CI (see CI/CD)

---

## Deployment

### Docker Compose (production)

`docker-compose.prod.yml` — production-ready stack with TLS, health checks, and no default credentials:

- Services: `db` (Postgres 17 Alpine), `valkey` (Valkey 8 Alpine — the Redis-compatible, BSD-licensed fork), `backend` (daphne ASGI), `frontend-build` (init container that copies SPA assets into a shared volume), `nginx` (1.27 Alpine), `certbot` (auto-renewing Let's Encrypt every 12 hours)
- `scheduler` profile — background jobs for due-date/staleness scans and notification pruning (`NOTIFICATION_RETENTION_DAYS`)
- `DB_PASSWORD` is mandatory — the compose file fails fast with a descriptive error if unset; no insecure default
- `DOMAIN` is mandatory — nginx config is rendered at container startup via `envsubst` so the host never needs to run it manually
- `APP_VERSION` env var controls which image tag is pulled — required; the compose file fails fast if unset rather than resolving to the mutable `latest` tag
- Backend health-checked at `/api/health/liveness/` before nginx starts
- `certbot` container auto-renews every 12 hours; nginx serves `/.well-known/acme-challenge/` for ACME verification

### Helm (Kubernetes)

Helm chart under `helm/visiban/`. Bundles a PostgreSQL 17 StatefulSet (using official `postgres:17` image by default) and a Valkey StatefulSet (official `valkey/valkey:8-alpine` image, pinned to the same major as Compose).

**Secret management — two supported patterns:**

| Pattern | How |
|---|---|
| **Chart-managed Secret** | Set `secret.djangoSecretKey` (and OAuth credentials) in a gitignored `values.secret.yaml` file; chart creates the Secret automatically |
| **External / pre-existing Secret** | Create the K8s Secret yourself (via Vault, Sealed Secrets, ESO, etc.) and set `secret.existingSecret: <name>`; the chart references it without creating its own |

The same `existingSecret` pattern applies to the PostgreSQL password (`postgresql.auth.existingSecret`), making the chart compatible with external secrets managers at every credential boundary.

- `values.secret.yaml.example` ships in the repo as a template for the gitignored secrets file approach
- `backend.oauth.*` block — per-provider `clientId`/`clientSecret` fields; leave empty to disable a provider
- `backend.oauth.oidc.*` — `serverUrl`, `clientId`, `clientSecret`, `providerName` for generic OIDC
- `scheduledJobs` — CronJobs mirroring the Compose `scheduler` profile (staleness scans, notification pruning)
- `demo.enabled` — hosted-demo mode: egress `NetworkPolicy`, a reset `CronJob`, and a write-fence `helm test` (see Seed / demo data)

---

## CI/CD

GitLab CI pipeline, grouped by what each gate protects:

- **Correctness & tests** — lint, backend tests (sharded across 3 parallel jobs via pytest-split), frontend tests, migration check, migration-numbering check, diff-coverage gates on backend and frontend (80% of changed lines)
- **Contract & drift** — serializer↔TypeScript parity (`frontend/src/types/index.ts` vs. the OpenAPI schema), WebSocket event reachability (every event name reconciled across emit/doc/handler), schema fuzzing (schemathesis against the declared OpenAPI schema), RBAC and broadcast-wiring static checks
- **Security** — SAST (Semgrep via the GitLab catalog component + Bandit), secret detection (gitleaks), dependency/license scanning (OSV + per-ecosystem checks), container image scanning, a live OIDC (Keycloak) smoke test every pipeline
- **Performance** — a schedule-only job asserting p50/p95/p99 latency budgets against a large seeded fixture
- **Infra** — Docker builds via kaniko (no Docker-in-Docker) for amd64; arm64 images build natively on a dedicated Apple Silicon runner instead, since kaniko can't cross-build; Compose/Dockerfile/shell linting; Helm chart lint/template/network-policy/install/publish jobs
- **Harness meta-gates** — a suppressions check (every temporary `SUPPRESSED-UNTIL(#NNNN)` marker's cited issue must still be open), a gate-self-test-parity check, a kaizen yield-watch, and a docs-version-accuracy check (fails a stale "Coming in X" claim or a version mismatch — the same gate this document is expected to pass)
- Merge only allowed with a green pipeline; cache policy split (pull on MR, pull-push on main via dedicated warm jobs); docs auto-deploy and Docker images tagged with version on release tags; scheduled seed-data refresh for the demo environment

---

## Seed / demo data

`python manage.py seed_demo_data` — creates a realistic demo board:
- 5 columns, 10 swimlanes, ~120 unique cards (8 archived)
- Cards with checklists, comments, movement history, archived cards, varied priorities and due dates
- All cards (including Backlog) have at least one creation movement so the History tab is never empty
- `--wipe`: removes the existing demo board first (refuses on production without `--force`)
- `--export`: regenerates seed JSON/CSV files
- `--demo-site`: seeds six showcase boards (Software Team, Property Management, Construction, Sales Territory, Content Moderation, Logistics Exceptions), each with a different swimlane entity and pinned row fields, plus an admin and two member accounts, for hosted-demo deployments

`python manage.py seed_template_boards` — seeds all 10 non-blank board templates with 10–11 swimlanes, 110–121 unique cards each, domain-specific content, movement history, activities, labels, checklists, and comments. Seed files exported to `sample-boards/<slug>.json`. All templates also ship as ready-to-import JSON and CSV files at the repo root.

### Hosted demo mode

An opt-in, public-facing demo deployment mode, off by default:

- `DEMO_MODE` shows a live-demo banner with credentials on the login page
- Pairs with `seed_demo_data --demo-site` for content
- Helm's `demo.enabled` adds an egress `NetworkPolicy`, a scheduled reset `CronJob`, and a write-fence `helm test` so a public demo can't be used to pivot into the rest of the cluster or accumulate unbounded state

---

## Onboarding

- Getting-started tour for new users — a 4-step contextual tooltip walkthrough that triggers the first time a user opens a board
- Tour covers: swimlanes, card movement, the audit trail, and the filter bar
- Dismissing or completing the tour sets a persistent server-side flag (`has_completed_tour`) so the user is never interrupted again
- Admins can reset the flag from the admin panel

---

## User preferences

- "Close editor on Enter" — per-user, controls whether Enter in the new-card input submits and closes (defaults to on for new accounts)
- "Show full history" — per-user, controls whether the card activity panel shows all activity or just movements; persists across sessions via localStorage
- Theme — system / dark / light (see Appearance)
- Card density — personal override for card-face density
- Default board — login redirects to this board
- Avatar color — distinct per user in comment threads
- Notification preferences — per-trigger toggles and channel (in-app / email / both) (card assigned, @mentioned, due date warning, card moved, comment added, board invites)
- Timezone, date format, time format, number locale — applied consistently across due dates, movement/activity timestamps, and notifications

---

## Known gaps (not yet implemented)

Tracked backlog, not a committed roadmap for any specific release — check GitLab milestones for current scheduling.

- Cross-board card search — a backend cursor-paginated endpoint (`GET /api/v1/cards/`, permission-scoped) exists but isn't wired to any UI yet; the ⌘K Command Palette currently does board-scoped search plus a board-list jump, not cross-board card content (#191, open, milestone 1.4)
- Card watchers / subscriptions — no per-card "notify me" toggle; notifications currently rely on @mentions and assignment
- Global, account-scoped activity feed — the activity drawer is still per-board; no combined cross-board feed from the navbar bell
- Styled, preference-aware date picker — due-date and filter inputs are still native `<input type="date">`
- Archive organizer search/sort/filters/bulk actions — the Archived panel shows origin and supports pagination/unarchive, but has no title search, sort control, column/swimlane/assignee filters, or bulk restore/delete yet
- User-selectable accent color — theming is currently limited to the system/dark/light preference, not a per-user hue picker
- Site-level email invitations — admin invite links generate a shareable URL only; nothing emails a specific recipient directly yet
- Site admin row-level actions to edit a user's email, view a user's boards, or delete a user account — only deactivate (with the offboarding/ownership-transfer flow) exists today
- Keyboard-shortcut discoverability polish — no footer link or first-run indicator pointing at the shortcuts overlay
- Tablet-responsive layout pass for the Dashboard and Settings pages
- Card templates (reusable card scaffolds)
- Threaded comment replies (comments are flat)
- Board-level admin audit log (distinct from the site-wide admin action log, which does exist — see Site admin panel)
- PDF/print export
- Column archival (soft-delete) — columns are hard-deleted today
- A migration squash to a fresh 1.0 baseline (currently 60+ sequential migration files)
