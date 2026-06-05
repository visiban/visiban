# Visiban — Full Feature Reference

## What is Visiban?

Visiban is a self-hosted, open-core Kanban board built for small-to-medium teams. It runs on Django + PostgreSQL (backend) and React + TypeScript (frontend), deployable via Docker Compose. The core product is Apache 2.0 licensed. Enterprise features (SSO, audit logs, automation, integrations) are in a separate private repo.

---

## Tech stack

- **Backend:** Python 3.12, Django 5, Django REST Framework, PostgreSQL 17, django-allauth, gunicorn
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS 3, @dnd-kit, Tiptap (rich text), React Router v6, Axios
- **Real-time:** WebSockets (Django Channels)
- **Infra:** Docker Compose, Nginx, kaniko (CI builds)
- **Auth:** django-allauth headless/API mode, OAuth (Google, GitHub, GitLab), OIDC

---

## Board structure

### Core concepts

| Concept | Description |
|---|---|
| **Board** | A workspace containing columns and swimlanes. Boards belong to a user (owner) or a group. |
| **Column** | Represents a workflow stage (e.g. To Do, In Progress, Done). Boards can have up to 50 columns. |
| **Swimlane** | A horizontal row dividing the board by customer, team, priority, or any other dimension. Up to 100 swimlanes. |
| **Cell** | The intersection of a column and swimlane — a droppable zone for cards. |
| **Card** | A unit of work. Lives in one cell. Has title, description, priority, assignee, labels, due date, weight, checklist, comments, attachments, and movement history. |
| **Label** | A colored tag attached to cards for categorization. Board-scoped. |

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
| Stable UID | 16-char hex | Immutable external reference |

### Card actions

- Create inline (click "+ Add card", double-click empty cell, or right-click cell)
- Edit all fields in a card detail panel
- Move via drag-and-drop between cells (optimistic update + rollback on failure)
- Move via "Move to" button in the card detail panel (column + swimlane picker without closing the panel)
- Archive (soft-delete) — hidden from board, restorable from Archived panel; shows toast with direct link to Archived panel
- Delete (permanent, confirmation required)
- Bulk select + bulk archive / bulk assign / bulk priority / bulk delete

### Card detail panel

- Rich text description editor (Tiptap) — click to edit, Save/Cancel
- @mention autocomplete in descriptions — member picker on `@`, sends in-app notification
- Comment thread with avatars (distinct color per user)
- @mention in comments — notification on each comment (no re-notification guard — each comment is a new event)
- Checklist items (add, check/uncheck, delete) — collapsible section
- File attachments (up to 10 MB, allowlisted MIME types) — collapsible section
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

## Board UI

### Layout

- CSS Grid: columns (x-axis) × swimlane rows (y-axis)
- Swimlane label sidebar on the left (resizable by dragging right edge, persisted to localStorage)
- Column headers sticky on scroll, show WIP count
- Optional WIP limit enforcement (`enforce_wip_limits` board setting): moving a card into a full column returns an error; board admins can override; archived cards excluded from count
- Optional weight limit enforcement (`enforce_weight_limits` board setting): moving a card that would push a column over its weight budget is blocked; board admins can override; archived cards excluded from weight sum
- Hard WIP enforcement (`enforce_wip_hard` board setting): when enabled, WIP/weight limits block all roles including admins — no force override available
- Both WIP and weight enforcement default to **on** for newly created boards

### Board navigation

- Sub-nav tabs (Board / Summary / Analytics / History) are URL-addressable via `?view=` — tabs can be bookmarked and shared; Back button skips tab transitions
- Board-level History tab with filterable movement log — search by swimlane, column, user, and date range
- Space + drag panning — hold Space to enter pan mode (cursor changes to grab), then drag to scroll the board without activating card drag-and-drop

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
- Server-side card search (title + description, case-insensitive, debounced 300ms with AbortController cancellation); client-side filters intersected with server results
- Filter state persisted to localStorage per board
- "No cards match the active filters" banner when filters produce zero results

### Keyboard shortcuts

- `Escape` — closes the topmost open modal/popover/dialog, then clears selection, then navigates back (consistent across all pages and modals)
- `f` — opens filter panel (disabled when typing in editor/input)
- Enter in new-card input — configurable per-user (submit + close or just submit)

---

## Swimlane features

- Collapsible swimlane rows
- Contact email and notes fields
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
- Rate-limited to 120 requests/hour per IP

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
- Capped at 50 most recent per user

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

Server-side keepalive ping every 30 seconds prevents NATs and reverse proxies from dropping idle connections; frontend detects a missing ping within 45 seconds and auto-reconnects.

Live indicator is three-state: green "Live" when connected, amber "Reconnecting…" while attempting to reconnect, grey "Offline" when the connection has permanently failed. Evicted members have their WebSocket connection closed immediately on removal.

---

## Analytics

- **Dwell-time heatmap** — how long cards spend in each column; coloring is threshold-based: green (well under threshold), yellow (within the warning band), red (at or above threshold)
- `staleness_threshold_days` board setting — configurable stale threshold; used by both the heatmap and stall detection
- `stale_warning_pct` board setting (0–100, default 50) — controls the yellow warning band width in the heatmap
- **Stale card detection** — lists cards inactive beyond the board's stale threshold; stalled card rows are clickable and open the card detail panel
- **Period filter** (7d / 30d / 90d) — correctly scopes dwell times and velocity calculations to the selected window; shows "No card movements recorded in the last N days" when the window is empty
- Analytics export (CSV) — admin only
- Board summary endpoint

---

## Import / Export

### Export

- **JSON** (recommended) — full board state: columns, swimlanes, labels, cards, movements, activity log, assignees; includes `schema_version: 1`
- **CSV** — one row per card; card data only, no movement history

### Import

- JSON (Visiban export format) — restores full card history including movements, activities, and assignees
- CSV (flexible: accepts lowercase/snake_case headers; `due_date`, `duedate`, `Due Date` all work)
- Limits: 500 cards, 50 columns, 100 swimlanes per import
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
- File attachment MIME type + magic byte validation
- Text file polyglot XSS prevention (HTML/script markers rejected in first 4 KB)
- `Content-Disposition: attachment` enforced on all media downloads (no inline rendering)
- Invite link tokens hashed SHA-256 (raw token returned once at creation)
- CSV export formula injection protection
- User search rate-limited (30 req/min)
- Invite link redemption rate-limited (10/hr per IP)
- CORS validation prevents localhost origins in production
- Import size limits (500 cards, 50 columns, 100 swimlanes)
- SAST: bandit (backend) + eslint-plugin-security (frontend) in CI

---

## Deployment

### Docker Compose (production)

`docker-compose.prod.yml` — production-ready stack with TLS, health checks, and no default credentials:

- Services: `db` (Postgres 17 Alpine), `valkey` (Valkey 8 Alpine — the Redis-compatible, BSD-licensed fork), `backend` (daphne ASGI), `frontend-build` (init container that copies SPA assets into a shared volume), `nginx` (1.27 Alpine), `certbot` (auto-renewing Let's Encrypt every 12 hours)
- `DB_PASSWORD` is mandatory — the compose file fails fast with a descriptive error if unset; no insecure default
- `DOMAIN` is mandatory — nginx config is rendered at container startup via `envsubst` so the host never needs to run it manually
- `APP_VERSION` env var controls which image tag is pulled (defaults to `latest`)
- Backend health-checked at `/api/health/liveness/` before nginx starts
- `certbot` container auto-renews every 12 hours; nginx serves `/.well-known/acme-challenge/` for ACME verification

### Helm (Kubernetes)

Helm chart under `helm/visiban/`. Bundles a PostgreSQL 17 StatefulSet (using official `postgres:17` image by default) and a Bitnami Valkey subchart.

**Secret management — two supported patterns:**

| Pattern | How |
|---|---|
| **Chart-managed Secret** | Set `secret.djangoSecretKey` (and OAuth credentials) in a gitignored `values.secret.yaml` file; chart creates the Secret automatically |
| **External / pre-existing Secret** | Create the K8s Secret yourself (via Vault, Sealed Secrets, ESO, etc.) and set `secret.existingSecret: <name>`; the chart references it without creating its own |

The same `existingSecret` pattern applies to the PostgreSQL password (`postgresql.auth.existingSecret`), making the chart compatible with external secrets managers at every credential boundary.

- `values.secret.yaml.example` ships in the repo as a template for the gitignored secrets file approach
- `backend.oauth.*` block — per-provider `clientId`/`clientSecret` fields; leave empty to disable a provider
- `backend.oauth.oidc.*` — `serverUrl`, `clientId`, `clientSecret`, `providerName` for generic OIDC

---

## CI/CD

- GitLab CI pipeline: lint, SAST (Semgrep + Bandit), secret detection, migration check, backend tests (sharded across 3 parallel jobs via pytest-split), frontend tests, docker build, changelog check
- Docker image builds use kaniko (no Docker-in-Docker)
- Merge only allowed with green pipeline
- Cache policy split: pull on MR, pull-push on main via dedicated warm jobs
- Docs auto-deploy on version tags; Docker images tagged with version on release
- Scheduled seed-data refresh job for demo environment

---

## Seed / demo data

`python manage.py seed_demo_data` — creates a realistic demo board:
- 5 columns, 10 swimlanes, ~120 unique cards (8 archived)
- Cards with checklists, comments, movement history, archived cards, varied priorities and due dates
- All cards (including Backlog) have at least one creation movement so the History tab is never empty
- `--wipe`: removes the existing demo board first (refuses on production without `--force`)
- `--export`: regenerates seed JSON/CSV files

`python manage.py seed_template_boards` — seeds all 10 non-blank board templates with 10–11 swimlanes, 110–121 unique cards each, domain-specific content, movement history, activities, labels, checklists, and comments. Seed files exported to `sample-boards/<slug>.json`. All templates also ship as ready-to-import JSON and CSV files at the repo root.

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
- Default board — login redirects to this board
- Avatar color — distinct per user in comment threads
- Notification preferences — per-trigger toggles (card assigned, @mentioned, due date warning, card moved, comment added, board invites)
- Timezone, date format, time format, number locale

---

## 1.1 roadmap

### Foundation work (land first — unblocks multiple features)

These cross-cutting refactors are load-bearing dependencies for several 1.1 items. Shipping them first turns the feature MRs into near-trivial swaps.

| Item | Notes |
|---|---|
| Date utility unification | One `formatDate`/`parseDate` pair that reads `user.date_format` and `user.timezone`. Prerequisite for #243, #222, and email notification rendering (#225). |
| Accent color token | Extract a single `--accent` CSS variable in `index.css` and route Tailwind utilities (`accent-primary`, `accent-focus`) through it. Replaces scattered `blue-600`/`blue-500`/`blue-400` usage. Prerequisite for #251 and light mode. |
| Theme token layer | Split hard-coded `slate-*` backgrounds and `white`/`gray-*` text into semantic tokens (`--surface`, `--surface-muted`, `--text`, `--text-muted`, `--border`). Prerequisite for light mode. |

### Features

| Feature | Notes |
|---|---|
| Card watchers / subscriptions (#229) | Subscribe/eye toggle in `CardDetail` header next to Archive/Delete, with subscriber count tooltip. Passive "You're watching because you were @mentioned" hint so implicit watchers understand notification origin. |
| Global board activity feed (#232) | Extend the existing `BoardActivityDrawer` to an account-scoped feed opened from the navbar bell icon (combined feed + notifications pane). Group entries by board; collapse within-board bursts to keep Maya's at-a-glance view usable. |
| Styled date picker (#243) | One `DatePickerInput` component reading user prefs; swap all four native `<input type="date">` call sites (CardDetail, MovementHistoryView, SettingsPage, filters) in the same MR. Stored value stays ISO — backward compatible. |
| Archive organizer (#250) | Add title/description search, sort (archived date / title / column), column / swimlane / assignee filters, bulk-select with bulk restore + permanent delete. Show origin (column → swimlane) on each row. Distinguish "empty archive" vs "no matches" empty states. |
| Custom color scheme (#251) | User-selectable accent via the `--accent` token from foundation work. Restrict to 6–8 curated hues that meet AA contrast on the canvas background. |
| Light mode | System-wide light theme driven by the theme token layer. Per-user preference (`light` / `dark` / `system`) on the profile page; respects `prefers-color-scheme` by default. Every surface, modal, drawer, and badge must pass AA contrast in both modes. Audit swimlanes, over-WIP indicators, drag preview, and mention highlights — these are the common regression spots. |
| Site-level email invitations (#213) | "Invite people" action in Admin → Users emailing a signed, time-boxed link. Track redemption state; support revoke and bulk invite for Alex. |
| Site admin: change user email (#215) | Row-level action in the admin user list. |
| Site admin: view user's boards (#216) | Row-level action; links into the board with admin context. |
| Site admin: delete user account (#214) | Row-level action gated by a "type the username" danger-zone confirm, reusing the pattern from board deletion. |
| Auto-archive done cards (#222) | Toggle + paired numeric fields ("Archive cards in Done after N days" + warning threshold) in the existing `BoardSettingsModal` rules tab, following the paired-numeric convention in `frontend/CLAUDE.md`. |
| Cross-board card search (#224) | Navbar omnibox (⌘K) hitting a new cross-board endpoint; results grouped by board and filtered by per-board permissions. |
| Email notifications (#225) | Extend `NotificationsTab` with a per-preference channel split (in-app / email / both). Uses the unified date utility for timestamp rendering. |

### Admin row-level actions (#214/#215/#216 grouped)

All three admin actions share an overflow "⋯" menu per row in the user list to avoid cluttering the main columns. Ship them in one MR with a single menu component.

### UX polish (1.1 scope)

These surfaced during the 1.1 UI review. Group into one or two polish MRs rather than per-item issues.

- Keyboard-shortcut discoverability — add a muted "Keyboard shortcuts" link in the footer and a first-run indicator on the help icon
- Drag-and-drop screen-reader announcements — `role="status"` live region that reports "Moved <card> to <column> / <swimlane>"
- Modal focus-trap consistency — standardize on `useEscapeStack` across `CardDetail`, `BoardSettingsModal`, and any other modal
- Over-WIP collapsed-column indicator — add a ⚠ glyph; text-color alone disappears when the column is collapsed
- Auto-save confirmation — transient checkmark on RTE description, weight, and any other auto-saved field
- Tablet responsive pass — Dashboard and SettingsPage should degrade cleanly at `md:` breakpoints for Sam; board view remains desktop-first
- Empty-state unification — codify the canonical pattern in `frontend/CLAUDE.md` and refactor outliers (archived panel, empty board, no-results filter, etc.)

### Later / unscheduled

| Feature | Notes |
|---|---|
| Card templates | Reusable card scaffolds |
| Threaded comment replies | Nested comment threads |
| Board-level admin audit log | Track admin actions |
| PDF/print export | CSS print or headless renderer |
| Column archival | Soft-delete columns instead of hard delete |
| Migration squash to 1.0 baseline | Reduce startup time |
