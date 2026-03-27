# Visiban — Full Feature Reference

## What is Visiban?

Visiban is a self-hosted, open-core Kanban board built for small-to-medium teams. It runs on Django + PostgreSQL (backend) and React + TypeScript (frontend), deployable via Docker Compose. The core product is Apache 2.0 licensed. Enterprise features (SSO, audit logs, automation, integrations) are in a separate private repo.

---

## Tech stack

- **Backend:** Python 3.12, Django 5, Django REST Framework, PostgreSQL 16, django-allauth, gunicorn
- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS 3, @dnd-kit, Tiptap (rich text), React Router v6, Axios
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
- Both WIP and weight enforcement default to **on** for newly created boards

### Board navigation

- Sub-nav tabs (Board / Summary / Analytics) are URL-addressable via `?view=` — tabs can be bookmarked and shared; Back button skips tab transitions
- Space + drag panning — hold Space to enter pan mode (cursor changes to grab), then drag to scroll the board without activating card drag-and-drop

### Resizing

- Column widths: drag right-edge separator — persisted per-column per-board in localStorage
- Swimlane row heights: drag bottom edge — persisted per-swimlane per-board in localStorage
- Swimlane sidebar width: drag right edge — persisted per-board in localStorage

### Column / swimlane management

- Rename inline: click the name, Enter to confirm, Escape to cancel
- Full settings modal: double-click header / label, or ✎ icon
- Column settings modal includes an admin-only "Delete column" danger button (alternative to the drag-to-trash gesture)
- `is_done` flag per column — marks columns as completion targets for cycle-time and throughput metrics; set automatically on terminal columns (e.g. Done, Closed Won) when using a template
- Add column/swimlane via "+" on the separator handles
- Reorder by dragging (collapsed columns can also be dragged)
- Collapse columns (click to toggle); collapsed columns with filter matches pulse with a count badge

### Filters and search

- Filter by: priority, label, assignee, due date (overdue, upcoming)
- Active filter count badge on the filter bar
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

---

## Board sharing

Boards can be shared as a public read-only link with no login required.

- Board admins generate or revoke a share token from Board Settings
- Share link serves a static read-only board view at `/share/:token` — full grid with column headers, swimlane labels, and card tiles (title, labels, checklist progress, due date, weight, assignee)
- Revoking the token immediately invalidates the link; visitors see a "This board is no longer shared" page
- Share links expose only non-sensitive card fields — no comments, attachments, or movement history

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
| Delete any comment | ❌ | ❌ | ✅ | ✅ |
| Upload attachments | ❌ | ✅ | ✅ | ✅ |
| Delete own attachment | ❌ | ✅ | ✅ | ✅ |
| Delete any attachment | ❌ | ❌ | ✅ | ✅ |
| Add / edit / delete checklist items | ❌ | ✅ | ✅ | ✅ |
| Create / edit / move / delete cards | ❌ | ❌ | ✅ | ✅ |
| Archive / unarchive cards | ❌ | ❌ | ✅ | ✅ |
| Manage columns / swimlanes / labels | ❌ | ❌ | ❌ | ✅ |
| Manage board members | ❌ | ❌ | ❌ | ✅ |
| Generate / revoke share link | ❌ | ❌ | ❌ | ✅ |
| Export board | ✅ | ✅ | ✅ | ✅ |

### Site admin

- `is_site_admin` boolean on User — gates `/api/admin/*` endpoints and the Admin Panel
- `can_access_all_content` boolean — separately controls omniscient board/group access (existing site admins are automatically migrated to `can_access_all_content=True`)

### Site admin panel (`/admin`)

- Registration mode: Open / Invite-only / Closed
- User management: list, create, deactivate, promote to site admin, force password reset
- File uploads toggle — enable or disable attachment uploads instance-wide; existing attachments remain accessible when uploads are disabled

---

## Authentication

- Email + password
- OAuth: Google, GitHub, GitLab (via django-allauth)
- Generic OIDC — configurable via `OIDC_CLIENT_ID`, `OIDC_SECRET`, `OIDC_SERVER_URL`; optional `OIDC_PROVIDER_NAME` controls the login button label (default "SSO"); provider only registered when all three required vars are set
- Personal Access Tokens (PATs) — create from Settings → Access Tokens; carry a `vbn_` prefix; shown only once at creation; optional expiry up to one year; max 10 per user; all tokens revoked on password change
- Invite-only and closed registration modes
- Force-password-reset on first login (admin-assignable)
- Default board redirect on login

---

## Notifications

- In-app notification bell
- Triggers: @mention in description, @mention in comment, card assigned to you
- Re-notification guard on description edits (won't re-notify the same user for the same mention)
- Deep-link from notification to the card
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

- No raw SQL — ORM only
- Input validation at serializer boundary
- Object-level authorization (IDOR prevention)
- Admin panel restricted to loopback IP in production
- `SECRET_KEY` validation at startup
- No default DB password in production compose
- File attachment MIME type + magic byte validation
- CSV export formula injection protection
- User search rate-limited (30 req/min)
- Invite link redemption rate-limited (10/hr per IP)
- CORS validation prevents localhost origins in production
- Import size limits (500 cards, 50 columns, 100 swimlanes)
- SAST: bandit (backend) + eslint-plugin-security (frontend) in CI

---

## CI/CD

- GitLab CI pipeline: lint, SAST, migration check, backend tests, frontend tests, docker build, changelog check
- Docker image builds use kaniko (no Docker-in-Docker)
- Merge only allowed with green pipeline
- Scheduled seed-data refresh job for demo environment

---

## Seed / demo data

`python manage.py seed_demo_data` — creates a realistic demo board:
- 5 columns, 10 swimlanes, ~83 cards (8 archived)
- Cards with checklists, comments, movement history, archived cards, varied priorities and due dates
- All cards (including Backlog) have at least one creation movement so the History tab is never empty
- `--wipe`: removes the existing demo board first (refuses on production without `--force`)
- `--export`: regenerates seed JSON/CSV files

`python manage.py seed_template_boards` — seeds all 10 non-blank board templates with domain-specific swimlanes, cards, labels, checklists, comments, and full CardMovement + CardActivity history. Seed files exported to `backend/boards/seed_data/<slug>.json`.

---

## User preferences

- "Close editor on Enter" — per-user, controls whether Enter in the new-card input submits and closes (defaults to on for new accounts)
- "Show full history" — per-user, controls whether the card activity panel shows all activity or just movements; persists across sessions via localStorage
- Default board — login redirects to this board
- Avatar color — distinct per user in comment threads

---

## Post-1.0 roadmap (not yet implemented)

| Feature | Notes |
|---|---|
| Card watchers / subscriptions | Watch a card without being assignee (#229) |
| Global board activity feed | Chronological stream of all board events (#232) |
| Styled date picker | Replace native `<input type="date">` (#243) |
| Archive organizer | Search, filter, sort, bulk actions, permanent delete (#250) |
| Custom color scheme | User-selectable accent color (#251) |
| Site admin: change user email | Update email address from admin panel (#215) |
| Site admin: delete user account | Permanent deletion with data-cleanup (#214) |
| Site admin: view user's boards | See all boards a user belongs to (#216) |
| Site-level email invitations | Invite by email before account exists (#213) |
| Auto-archive done cards | Configurable auto-archive after N days in Done column (#222) |
| Cross-board card search | Search across all boards the user can access (#224) |
| Email notifications | Transactional email channel (#225) |
| Card templates | Reusable card scaffolds |
| Saved filter presets | Persist filter combinations |
| Threaded comment replies | Nested comment threads |
| Board-level admin audit log | Track admin actions |
| PDF/print export | CSS print or headless renderer |
| Column archival | Soft-delete columns instead of hard delete |
| Migration squash to 1.0 baseline | Reduce startup time |
