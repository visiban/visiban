# Changelog

All notable changes to Visiban are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added

- Filter bar moves inline onto the toolbar row; falls back to a second row when the viewport is too narrow (closes #58)
- Keyboard shortcuts on the board view — `f` toggles the filter bar, `/` opens the filter bar and focuses the search input, `?` shows a keyboard shortcuts cheat-sheet overlay (closes #52)
- Production deployment: `docker-compose.prod.yml` adds Nginx reverse proxy serving the built frontend and proxying API and WebSocket traffic to the backend (closes #50)
- Automatic TLS via Let's Encrypt — `init-letsencrypt.sh` obtains a certificate via certbot standalone and starts the full stack; the certbot container renews automatically every 12 hours (closes #59)
- `nginx/app.conf.template`: TLS 1.2/1.3, HSTS, gzip, WebSocket upgrade headers, 20 MB upload limit
- Comment timestamps show relative time for recent comments ("just now", "5m ago", "3h ago") and switch to absolute date + time ("Mar 7, 2026, 2:34 PM") for comments older than 24 hours; hovering shows the full timestamp in a tooltip (closes #60)
- GitLab CI pipeline — backend tests run against PostgreSQL + Redis services with `coverage` reporting; frontend lint and test jobs; coverage badge and pipeline badge in README (closes #36–39, #57)
- Column headers show hover-visible **+** buttons at their left and right edges to insert a new column in-place without having to drag-reorder afterward (closes #61)
- Backend test coverage expanded from 67% to 92%: new test suites for board actions (full, summary, analytics, members, move-group), column/swimlane/label CRUD, card CRUD and sub-resources (comments, checklist, attachments, movements, activities, move), group management (boards action, ancestor member resolution, site admin edge cases), invite links, and accounts views (password change, profile, `/api/auth/me/`)
- CI security stage: Bandit (Python SAST), pip-audit (Python CVE scanning), `npm audit` (frontend CVE scanning), detect-secrets (credential leak detection)
- CI code quality: ruff linter job for Python style/correctness (non-blocking); `backend-code-quality` job converts ruff output to CodeClimate format and uploads as a GitLab Code Quality artifact — issues appear as inline annotations on MR diffs
- CI pipeline restructured: `workflow: rules` suppresses duplicate branch+MR pipelines; security and Docker build jobs restricted to MR pipelines via `.on-mr` template; `frontend-typecheck` (`tsc -b --noEmit`) and `migration-check` (`makemigrations --check --dry-run`) added to the lint/test stages; coverage enforced at ≥90% via `--fail-under=90`; `backend-docker-build` and `frontend-docker-build` jobs verify images build on every MR
- Upgraded vulnerable dependencies: Django 5.1.4→5.1.15, django-allauth 65.3.0→65.14.1, requests 2.32.3→2.32.4, cryptography 44.0.2→46.0.5 (fixes 21 CVEs flagged by pip-audit)

### Fixed

- SAST findings: `getCookie` in `api/client.ts` now uses a hardcoded literal regex instead of `new RegExp(name)` (resolves `detect-non-literal-regexp`); mention regex in `CardDetail.tsx` corrected to escape the hyphen in `[\w.+\-]`, fixing an unintentional range that also matched commas (resolves `regex_dos`); `LoginPage.tsx` password-match check annotated with `nosemgrep` to document the false-positive timing-attack finding (client-side form validation with no secret)
- "Due today" filter matched nothing in non-UTC timezones — `due_date` (a YYYY-MM-DD string) was parsed by `new Date()` as UTC midnight, causing an off-by-one day error compared to the local-timezone midnight; filter now compares date strings directly (closes #62)

### Changed

- Cards redesigned as compact horizontal rows with a left-border priority accent — replaced square aspect-ratio thumbnails; cards now stack vertically full-width in each cell (closes #43)
- Card metadata row shows: label colour dots, checklist progress, attachment count, relative due date ("Today" / "Tomorrow" / "3d" / "2d late" in red), assignee initials avatar, weight (hidden when 1)
- Card detail panel widened to 540 px; sections reordered — Description first, then Assignee + Due date side-by-side, Priority, Labels, Weight, Checklist, Attachments, Comments
- Section headers use uppercase spaced labels for clear visual hierarchy; light dividers separate logical groups
- Comments thread redesigned with author initials avatars and inline name/date headers
- Delete card button demoted to a subtle footer link (reduces accidental deletion)

---

## [v0.2.0-beta.1] — 2026-03-07

UX polish release — @mention comments, notification deep-links, empty state prompts, collapsed column card counts, and minor fixes.

### Added

- @mention support in card comments — type `@` to open an inline autocomplete dropdown filtered by username and display name; keyboard navigation (↑↓ Enter Escape); mentions highlighted in blue in rendered comments; mentioned board members receive an in-app notification (author is never self-notified)
- Empty state prompts on board — centred message + "Add first column" button when no columns exist; "Add first swimlane" button when no swimlanes exist; dashed drop-target placeholder in empty cells during drag (closes #51)
- Collapsed columns now span the full board height and display per-swimlane card counts; column header continues to show the aggregate total (closes #55)

### Fixed

- Comment textarea submits on Enter; Shift+Enter inserts a newline (closes #49)
- Due date picker disables past dates — `min` set to today, graying out and preventing selection of dates before today (closes #41)

### Docs

- Updated `docs/features/notifications.md` with @mention notifications and corrected notification deep-link behaviour
- Updated `docs/features/board.md` with @mention in comments and due date past-date restriction
- Updated `docs/features/realtime.md` to document column and swimlane event types added in v0.1.0-beta.1

---

## [v0.1.0-beta.1] — 2026-03-07

First public beta release.

### Added

- Real-time board sync via Django Channels WebSockets — card moves, edits, additions, and deletions pushed to all connected clients instantly; no polling
- WebSocket broadcasting for column and swimlane structural changes (`column.created`, `column.updated`, `column.deleted`, `swimlane.created`, `swimlane.updated`, `swimlane.deleted`) — all open tabs reflect board structure changes without a refresh
- Redis 7 added to Docker Compose and Helm chart as the Django Channels backend
- Backend runs under daphne (ASGI) to support WebSocket connections
- Notifications — in-app alerts for card assignment; stale card detection and indicators for cards that haven't moved in a configurable number of days
- Analytics view — dwell-time heatmap per stage with outlier detection (7 / 30 / 90-day periods), stalled card list, and CSV export
- Summary view — swimlane card counts with 7-day and 30-day velocity
- Board member role management UI — admins can assign all four board roles (admin, member, collaborator, viewer) directly from the board toolbar
- Frontend `useBoardSocket` hook connects via `VITE_API_URL` instead of `window.location`, fixing WebSocket connectivity in local dev where the API runs on a separate port
- Root `README.md` rewritten with problem-first intro, table of contents, step-by-step getting started, and full feature and tech stack documentation
- `CONTRIBUTING.md` — bug report template, feature request guidance, dev setup, MR process, and code style guidelines
- `CHANGELOG.md` — this file
- MkDocs documentation site with feature pages, RBAC pages, API authentication guide, and architecture overview

### Fixed

- `card.created` WebSocket events now correctly add cards on other tabs instead of being silently dropped
- `broadcast_board_event` crashed with `TypeError: can not serialize 'datetime.datetime' object` when passing DRF serializer data to channels_redis — payload is now round-tripped through `JSONRenderer` before sending to Redis
- Duplicate columns, swimlanes, and cards on the creating user's tab when the WebSocket echo arrived after the API response — `addCard`, `addColumn`, and `addSwimlane` are now upserts
- Group-inherited members now included in the board full serializer so they appear correctly in the members panel and assignee lists
- OAuth callbacks now work correctly on first boot — the Django Sites domain is auto-synced from `SITE_DOMAIN` at startup
- Stray merge conflict marker removed from `BoardView.tsx`

---

## [v0.2.0-alpha.1] — 2026-03-06

### Added

- Groups — create top-level groups and nested subgroups (up to 6 levels deep)
- Collapsible org-chart tree on the dashboard with tree connectors; hover any row to add a subgroup inline
- Group detail page: subgroups, boards, members, and invite link management; toggle to show boards from subgroups
- Invite links — group admins can generate a shareable join link; unauthenticated users are redirected to login and auto-joined after auth via sessionStorage; links can be revoked at any time
- Boards can be moved between groups or back to personal from the dashboard and group detail page
- RBAC — four board roles (admin, member, collaborator, viewer) with full enforcement across all board endpoints; roles inherited through sub-group membership
- `site_admin` role — protected superuser that board admins cannot modify or remove
- Per-column card creation toggle (`allow_card_creation`) — first column defaults to enabled; API enforces the restriction server-side (HTTP 400)
- Email/password login and registration in addition to OAuth; unconfigured OAuth providers hidden on the login page
- Column deletion with confirmation modal (blocked when cards are present)
- Full React Router integration — proper URLs for every page (`/`, `/groups/:id`, `/boards/:id`, `/join/:token`)
- Breadcrumb navigation on board pages with a back button to the parent group or dashboard
- Column drag-and-drop reorder now persists to the backend
- Inline card rename on Enter with history entry

---

## [v0.1.0-alpha.1] — 2026-03-04

### Added

- Initial release — Phase 1 backend (Django 5, DRF, PostgreSQL) and Phase 3 React frontend
- Kanban board grid with columns (stages) and swimlane rows
- Drag-and-drop card movement using @dnd-kit; every cross-column or cross-swimlane move creates a `CardMovement` audit record
- Right-click any column to add a card inline into that stage and swimlane
- Card detail panel — fully editable title, description, priority, assignee, labels, due date, weight, checklist, and comments
- WIP limits and weight limits per column with visual header indicators (red / orange)
- Column and swimlane management UI (add, edit, delete)
- Compact card thumbnails with priority colour border, label chips, assignee avatar, due date, and weight
- Google, GitHub, and GitLab OAuth login via django-allauth
- Collapsible columns — click a column header to collapse it; column name shown vertically when collapsed
- File attachments — attach files up to 10 MB to any card; attachment count indicator on card thumbnail
- Client-side card filtering (search, assignee, labels, priority, due date); filter bar is collapsible
- Card activity log — full timeline of field changes (priority, weight, assignee, labels), comments, and attachment events in addition to movement history
- Helm chart — Kubernetes deployment via Helm with optional bundled Redis subchart and external Redis support
- User profile — editable display name accessible from the navbar
- Default columns (Backlog, To Do, Doing, Done) and "General" swimlane created automatically on new boards
- Swimlanes can be renamed, recoloured, and deleted
- Card checklists — add/check/delete items with progress bar; actions recorded in history
- Card creation recorded as first entry in movement history
- Apache 2.0 license

### Fixed

- Vertical scrolling for swimlane rows
- Labels are reusable across multiple cards on the same board
- Auth, CSRF, and routing issues for local development
