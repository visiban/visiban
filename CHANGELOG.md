# Changelog

All notable changes to Visiban are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are date-based (`YYYY-MM-DD`) until a formal release scheme is adopted.

---

## [Unreleased]

---

## [v0.1.0-beta] — 2026-03-07

First public beta release.

### Added

- WebSocket broadcasting for column and swimlane structural changes (`column.created`, `column.updated`, `column.deleted`, `swimlane.created`, `swimlane.updated`, `swimlane.deleted`) — all open tabs now reflect board structure changes in real time without a refresh
- Frontend `useBoardSocket` hook connects via `VITE_API_URL` instead of `window.location`, fixing WebSocket connectivity in local dev where the API runs on a separate port
- Root `README.md` rewritten with problem-first intro, table of contents, step-by-step getting started, and full feature and tech stack documentation
- `CONTRIBUTING.md` — bug report template, feature request guidance, dev setup, MR process, and code style guidelines
- `CHANGELOG.md` — this file

### Fixed

- `card.created` WebSocket events now correctly add cards on other tabs instead of being silently dropped (were routed to `onCardUpdated` which is a no-op for new cards)
- `broadcast_board_event` crashed with `TypeError: can not serialize 'datetime.datetime' object` when passing DRF serializer data to channels_redis — payload is now round-tripped through `JSONRenderer` before sending to Redis
- Duplicate columns, swimlanes, and cards on the creating user's tab when the WebSocket echo arrived after the API response — `addCard`, `addColumn`, and `addSwimlane` are now upserts

---

## [2026-03-07]

### Added

- Board member role management UI — admins can assign all four board roles (admin, member, collaborator, viewer) directly from the board toolbar

### Fixed

- Group-inherited members now included in the board full serializer so they appear correctly in the members panel and assignee lists
- OAuth callbacks now work correctly on first boot — the Django Sites domain is auto-synced from `SITE_DOMAIN` at startup
- Stray merge conflict marker removed from `BoardView.tsx`

### Docs

- MkDocs documentation site expanded with feature pages (board & cards, analytics, notifications, real-time updates, card history, groups), RBAC pages, and API authentication guide
- Architecture overview updated with Redis / WebSocket system diagram
- Added `README.md` index files to every docs subdirectory

---

## [2026-03-06]

### Added

- **Real-time board sync** via Django Channels WebSockets — card moves, edits, additions, and deletions are pushed to all connected clients instantly; no polling
- **Redis channel layer** — Redis 7 added to Docker Compose and Helm chart as the Django Channels backend
- Backend runs under **daphne** (ASGI) to support WebSocket connections
- **Notifications** — in-app alerts for card assignment; stale card detection and indicators for cards that haven't moved in a configurable number of days
- **Analytics view** — dwell-time heatmap per stage with outlier detection (7 / 30 / 90-day periods), stalled card list, and CSV export
- **Summary view** — swimlane card counts with 7-day and 30-day velocity

---

## [2026-03-05]

### Added

- **Collapsible columns** — click a column header to collapse it; column name shown vertically when collapsed
- **File attachments** — attach files up to 10 MB to any card; attachment count indicator on card thumbnail
- **Card filtering** — client-side filters for search, assignee, labels, priority, and due date; filter bar is collapsible
- **Card activity log** — full timeline of field changes (priority, weight, assignee, labels), comments, and attachment events in addition to movement history
- **Helm chart** — Kubernetes deployment via Helm with optional bundled Redis subchart and external Redis support
- **User profile** — editable display name accessible from the navbar
- Default columns (Backlog, To Do, Doing, Done) created automatically on new boards
- Default "General" swimlane created automatically on new boards
- Swimlanes can be renamed, recoloured, and deleted

### Fixed

- Restored vertical scrolling for swimlane rows
- Labels are now reusable across multiple cards on the same board
- Resolved duplicate `REST_AUTH` config and uncontrolled input warning in profile form

---

## [2026-03-04]

### Added

- **Initial release** — Phase 1 backend (Django 5, DRF, PostgreSQL) and Phase 3 React frontend scaffolded
- Kanban board grid with columns (stages) and swimlane rows
- Drag-and-drop card movement using @dnd-kit; every cross-column or cross-swimlane move creates a `CardMovement` audit record
- Drag column headers to reorder stages
- Right-click any column to add a card inline into that stage and swimlane
- Card detail panel — fully editable title, description, priority, assignee, labels, due date, weight, checklist, and comments
- WIP limits and weight limits per column with visual header indicators (red / orange)
- Column and swimlane management UI (add, edit, delete)
- Compact card thumbnails with priority colour border, label chips, assignee avatar, due date, and weight
- Google, GitHub, and GitLab OAuth login via django-allauth
- Renamed "Customer" to "Swimlane" throughout the UI
- Apache 2.0 license

### Fixed

- Auth, CSRF, and routing issues for local development
- Missing migrations and serializer fixes
