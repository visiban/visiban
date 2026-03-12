# Changelog

All notable changes to Visiban are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Fixed

- Collapsed sidebar now shows a folder icon for groups and a home icon for the Personal section instead of single-letter initials; full names remain accessible via hover tooltip
- Board settings controls (column edit, swimlane edit, Settings button) are now rendered but visually disabled (`opacity-50`, `cursor-not-allowed`) for non-admins instead of being hidden; hovering shows "You need admin access to change board settings"
- Board Settings Invite typeahead suggestions now appear correctly; the dropdown was previously clipped by the modal's `overflow-y-auto` scroll container — fixed by rendering it with `position: fixed` outside the overflow boundary
- Assignee and due date filters now use the same custom dropdown style as priority and label: consistent button appearance, blue active state when a filter is selected, and a styled dropdown panel instead of native `<select>` elements

### Added

- JUnit XML test reports published as CI artifacts for both `backend-test` and `frontend-test` jobs; the Tests tab on every MR pipeline now shows per-test results, pass/fail counts, and timing
- Frontend test coverage raised from 72% to 85%+: new test suites for `SettingsPage`, `ThemeContext`, `ErrorBoundary`, and `BoardSettingsModal`; expanded suites for `App`, `CardItem`, `Avatar`, `BulkActionToolbar`, `GroupTree`, and the boards API client

- **Theme switcher** in Settings → Appearance: choose System (follows OS preference), Dark, or Light; preference is persisted in `localStorage` and applied immediately without a page reload; a FOUC-prevention inline script in `index.html` applies the saved class before first paint
- `GroupMembership` now supports a `viewer` role; group viewers get read-only access to all boards in the group — mapped directly to the existing `BoardMembership` viewer access model
- Swimlanes can be reordered by dragging their label (⠿ handle, admin only); each swimlane sidebar shows `+` insert-above and insert-below buttons on hover for positional insertion without rearranging existing rows
- Persistent collapsible left sidebar showing the full group/board hierarchy; collapses to icon-only rail (48px); expanded and per-group collapse states persist in `localStorage`; active board highlighted via route match
- Group owners can transfer ownership to any existing admin via the group settings danger zone; previous owner retains admin membership; transfer requires typing the group name as confirmation
- Cards now have a layered 3D raised shadow: a bottom-offset shadow simulates physical thickness, hover lifts the card with a deeper shadow, and the drag overlay uses an exaggerated lift for clear feedback
- `GroupDetail` now has **Boards** and **Settings** tabs; member management, invite link panel, and the danger zone (group deletion) are consolidated under Settings, which is hidden from non-admins
- **Board Settings** modal extended with three tabs: **Members** (view members and manage roles; inline remove confirmation; role descriptions on hover — admin only for edits), **Invite** (typeahead user search, staged invite list with per-user role picker — admin only), and **Data** (existing CSV/JSON export); the separate Members button is replaced by a unified Settings button visible to all roles
- `GET /api/users/?search=<query>` endpoint for authenticated user search (name/email/username), used by the Invite tab typeahead

### Fixed

- Board Settings Invite typeahead suggestions now appear correctly; the dropdown was previously clipped by the modal's `overflow-y-auto` scroll container — fixed by rendering it with `position: fixed` outside the overflow boundary
- Social-only accounts (OAuth/GitLab/GitHub/Google) can now set a password from the Security settings tab without supplying a current password — previously the request always failed with "Current password is incorrect" because Django sets an unusable password for social-only accounts
- Security tab now adapts its UI for social accounts: the "Current password" field is hidden and the button label reflects first-time password creation
- Password minimum length validation in the Security tab frontend aligned to 12 characters, matching the backend requirement
- Column headers now use `min-w-[200px]` (matching board cells), fixing horizontal misalignment between headers and card columns
- Column headers are taller with a two-row layout: name on the first row, labeled `WIP` and `Weight` stats on the second row; limits display `∞` when unset rather than hiding the stat
- Label creation button (`+ New label`) in `CardDetail` is now hidden from non-admins — previously shown to all members, triggering a silent 403 on submit
- Label API failures in `CardDetail` now surface an inline error message; optimistic toggle updates are rolled back on failure
- `Avatar` initials fallback now renders with a `title` attribute set to the user's display name, restoring tooltip and accessibility querying
- Board scroll area now has a dark background (`slate-900`), eliminating the white void below swimlane rows
- Navbar logo switched to light variant (`visiban_lockup_light.png`) so it is visible on the dark navbar
- Version badge in navbar styled as a subtle pill instead of bare floating text
- View toggle (Board / Summary / Analytics) now uses dark theme colors, removing the jarring light-gray pill on the dark controls bar
- Stray `gray-200` separator in the board controls bar replaced with consistent `slate-600`
- All modals and overlay panels converted to dark theme (`slate-800` panels, `slate-900` inputs, `slate-600` borders) — covers InviteLinkPanel, AddColumnModal, EditColumnModal, EditSwimlaneModal, AddSwimlaneModal, KeyboardShortcutsOverlay, ProfileModal, BoardMembersModal, CreateGroupModal, MoveBoardModal, FilterBar, and CardDetail

---

## [v1.0.0-rc.2] — 2026-03-10

### Added

- `CLA.md` — individual contributor license agreement; all external MRs require CLA acknowledgment via the default MR template
- `NOTICE` file added to OSS repo for Apache 2.0 attribution compliance
- Default MR template (`.gitlab/merge_request_templates/Default.md`) with CLA checkbox and standard checklist
- Summary view stage distribution bars now display two-letter column initials inside each segment (hidden on segments narrower than 8% to avoid overflow)
- `FRONTEND_URL` env var controls the allauth post-login/logout redirect URL (previously hardcoded to `http://localhost:5173`, breaking production OAuth flows)
- `REDIS_CACHE_URL` env var separates the Django cache Redis database (default db 1) from the Channels WebSocket layer (db 0), preventing key-space collisions when `REDIS_URL` is set
- `CSRF_TRUSTED_ORIGINS` env var allows CSRF trusted origins to be set independently of `CORS_ALLOWED_ORIGINS`; defaults to `CORS_ALLOWED_ORIGINS` so no change is needed for existing deployments
- Health check endpoints: `GET /api/health/liveness/` (process alive) and `GET /api/health/readiness/` (checks DB + Redis) — no auth required, suitable for K8s probes (closes #84)
- Health check API documentation (`docs/api/health.md`) with liveness/readiness endpoint reference and Kubernetes probe example
- API filtering for cards via `django-filter`: filter by `priority`, `assignee`, `column`, `swimlane`, `due_before`, `due_after`, `overdue`, `unassigned`; ordering by `position`, `due_date`, `created_at`, `priority` (closes #78)
- API pagination: `PageNumberPagination` with `page_size=50` applied globally to all list endpoints (closes #79)
- API rate limiting: `AnonRateThrottle` (60/hour) and `UserRateThrottle` (1000/hour) via DRF throttling; Redis cache configured for multi-process correctness (closes #80)
- Static file serving via whitenoise: `WhiteNoiseMiddleware` added, `CompressedManifestStaticFilesStorage` configured, `collectstatic` runs on container startup (closes #85)
- Full board export: `GET /api/boards/{id}/export/` returns a CSV file with all cards, metadata, and movement history; `?format=json` returns a structured JSON export including columns, swimlanes, labels, cards, comments, and checklists; available to all board members (closes #54)
- Import board from Visiban JSON or CSV export — `POST /api/boards/import/` accepts a file upload and atomically creates a new board with columns, swimlanes, labels, cards (including comments and checklist items); dashboard "Import" button with file picker modal (closes #66)
- Import board directly into a group from the group detail page — admin-only; backend import endpoint accepts optional `group_id` to place the imported board into the target group
- Export dropdown button in the board toolbar with CSV and JSON options
- Bulk card operations: select multiple cards via checkbox, then move to column, assign, set priority, or delete in batch; toolbar appears at the bottom when cards are selected; Escape clears selection (closes #53)
- Brand logo assets committed to `frontend/public/brand/` (10 PNG variants: primary, lockup, wordmark, icon-only, badge/canvas/fullbleed pulse — dark and light) (closes #90)
- Favicon and PWA icons: `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png` (180×180), `android-chrome-192x192.png`, `android-chrome-512x512.png`, and `site.webmanifest`; page title updated from "frontend" to "Visiban" (closes #89)
- Frontend test coverage increased from 55% to 80%+: BoardView, CardDetail, CardMovementTimeline, MentionTextarea, SwimlaneRow, BoardCell, FilterBar, App routing, and API clients (auth, notifications); 422 tests across 39 test files
- Frontend test coverage expanded from 3% to 54%+: hooks (useAuth, useBoard, useBoardSocket), API modules (cards, groups, notifications), component rendering tests for pages and key UI components including LoginPage, Navbar, ProfileModal, Dashboard, GroupDetail, JoinPage, modals, BulkActionToolbar, SummaryView, AnalyticsView, GroupTree, InviteLinkPanel, BoardMembersModal, and BoardSelector (closes #87)
- High-priority frontend tests: API client interceptors, board API wrappers, RBAC conditional rendering (closes #75)
- Medium-priority frontend tests: notification dropdown behavior, filter logic, import/export modals (closes #76)
- Low-priority frontend tests: component rendering (CardItem, ColumnHeader), WebSocket hook (useBoardSocket), utility functions (userDisplayName, color constants), and expanded keyboard shortcuts overlay tests (closes #77)
- Frontend test coverage reporting in CI with Cobertura artifact
- Changelog update check on MR pipelines (non-blocking)
- License compliance checks for backend (pip-licenses) and frontend (license-checker) on MR pipelines
- CI: replaced Docker-in-Docker with kaniko for image build verification — no privileged mode needed, works out of the box on Kubernetes runners
- CI: pipeline speed optimizations — collapsed build stage into test stage so they run in parallel, merged frontend-lint + frontend-typecheck into one job, merged backend-lint + backend-code-quality into one job, added auto-retry on runner system failures
- Docs: health check endpoint reference and Kubernetes probe example (`docs/api/health.md`)
- Docs: testing and CI pipeline documentation added to CONTRIBUTING.md, architecture overview, and docs index
- Docs: documented that WIP and weight column limits are soft warnings — the API never blocks card creation or moves when limits are exceeded
- Docs: documented that card assignees are not preserved on board import — cards are imported as unassigned
- Docs: documented swimlane name uniqueness constraint per board (`400` on duplicate name)
- Docs: documented `allow_card_creation=false` column behavior — returns `400 Bad Request` when a card is posted to a restricted column
- Docs: updated README with export/import, bulk operations, and column trash zone features
- Docs: updated feature docs (board.md) with bulk card operations, export/import, column trash zone, and Escape key improvements
- Docs: updated API docs (boards.md) with export and import endpoints, including `group_id` parameter for group-targeted imports
- Docs: updated RBAC permission table with export, import, bulk operations, and analytics CSV export permissions

### Changed

- Brand color system applied: Tailwind config extended with `primary` (#5B5FC7) and `accent` (#2DD4BF) tokens; page backgrounds migrated from gray-900 to slate-900, surfaces from gray-800 to slate-800; buttons, focus rings, and links updated to use brand tokens (closes #88)
- Navbar: replaced text wordmark with `visiban_lockup_dark.png` horizontal logo lockup (closes #90)
- Login page: replaced text heading with `visiban_wordmark_dark.png` logo; all brand color tokens applied (closes #90)
- Move online presence indicator from the center of the board toolbar to the top-right corner for a cleaner layout
- Analytics CSV export button restricted to admin and site_admin roles (closes #68)
- CI pipeline optimized: path-based job skipping (backend/frontend changes only trigger relevant jobs), DAG scheduling with `needs: []` for parallel stage execution, `node_modules/` cached alongside npm download cache

### Fixed

- Docs: `architecture/overview.md` listed React 18 — updated to React 19 to match `package.json`
- Docs: `architecture/deployment.md` described `Dockerfile.prod` as using gunicorn without noting that `docker-compose.prod.yml` overrides this with daphne (ASGI) for WebSocket support — added a callout clarifying the distinction and the correct command for standalone image use
- `LOGIN_REDIRECT_URL` and `ACCOUNT_LOGOUT_REDIRECT_URL` hardcoded to `http://localhost:5173` — production OAuth flows now redirect to `FRONTEND_URL`
- Django cache and Channels WebSocket layer both reading from `REDIS_URL`, placing both on Redis db 0 — cache now uses `REDIS_CACHE_URL` (Docker Compose sets this to db 1 automatically; no `.env` change needed for dev)
- `APP_VERSION` hardcoded in `docker-compose.yml` environment block overriding the value from `.env` — removed; version is now sourced exclusively from `.env` via `env_file`
- `backend-test` CI job missing `REDIS_CACHE_URL` — throttling cache backend connected to `localhost:6379` instead of the Redis service, causing 248 test errors
- `CSRF_TRUSTED_ORIGINS` silently reading from the `CORS_ALLOWED_ORIGINS` env var with no way to override — now has its own `CSRF_TRUSTED_ORIGINS` env var (behavior unchanged for existing deployments)
- `tsc -b` failing with `'test' does not exist in type 'UserConfigExport'` — vitest 2.x bundles its own copy of vite whose `declare module 'vite'` augmentation does not reach the top-level vite 7 types; split into a separate `vitest.config.ts` (imports `defineConfig` from `vitest/config`) so each config file is typed against the correct vite version
- Board view regression: column headers, swimlane rows, and the board toolbar rendered with a white/light background after the brand color migration; migrated `bg-white`/`bg-gray-50` and `border-gray-200` to `bg-slate-800`/`border-slate-700` across `BoardView`, `ColumnHeader`, and `SwimlaneRow`
- White screen after OAuth redirect — added a React `ErrorBoundary` around the app root so render-phase errors display a fallback UI with the error message instead of a blank page
- `listBoards` and `listGroups` API functions not unwrapping paginated responses — both now access `.data.results` after the global `PageNumberPagination` was applied to list endpoints
- `loginPage` and `navbar` tests failing after wordmark image replaced the "Visiban" text — assertions updated to use `getByAltText`
- `changelog-check` CI job failing with "no merge base" on shallow clones — fetch target branch with `--depth=20` and use `git merge-base` instead of three-dot diff syntax
- Docs: `inheritance.md` opening sentence incorrectly implied boards only carry group-level roles (admin/member); clarified that boards support four roles and that collaborator/viewer are board-only and never inherited (closes #91)
- Docs: fixed duplicate "Export & import" section in README
- Read notifications reappear after page refresh — notification list endpoint now returns only unread notifications; clicking a notification removes it from the dropdown (closes #71)
- Board import failing with "Method POST not allowed" due to manually set Content-Type header stripping the multipart boundary
- Board Members dialog can now be closed by pressing Escape (closes #70)
- Database deadlock on bulk card move — concurrent position-reorder transactions now acquire row locks in consistent order via `select_for_update`; bulk move requests serialized on the frontend
- Escape key now consistently closes all dialogs: ProfileModal, MoveBoardModal, BulkActionToolbar delete confirmation, and KeyboardShortcutsOverlay (closes #72)
- Codebase consistency cleanup: consolidated inline imports to module level, standardized permission error handling, extracted shared color constants, fixed British spellings in docs, updated stale registry paths in Helm chart and mkdocs.yml, registered missing models in Django admin (closes #73)

---

## [v1.0.0-rc.1] — 2026-03-08

### Added

- Column trash zone: dragging a column to the right edge reveals a red "Delete" drop target; dropping shows a confirmation dialog with the card count before deleting (closes #23)
- Self-hosting docs: backup/restore guide and upgrade instructions for production deployments (closes #67)

### Fixed

- Updated all GitLab URLs from `kellyhair/visiban` to `visiban/visiban` after group migration (README, CONTRIBUTING, installation docs)
- Added `SITE_DOMAIN` to `.env.example` with documentation comment (was referenced in docs but missing from the example file)

---

## [v0.3.0-beta.1] — 2026-03-08

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
- CI security stage: Semgrep SAST via the GitLab catalog component (covers Python and TypeScript; replaced Bandit), pip-audit (Python CVE scanning), `npm audit` (frontend CVE scanning), detect-secrets (credential leak detection)
- CI code quality: ruff linter job for Python style/correctness (non-blocking); `backend-code-quality` job converts ruff output to CodeClimate format and uploads as a GitLab Code Quality artifact — issues appear as inline annotations on MR diffs
- CI pipeline restructured: `workflow: rules` suppresses duplicate branch+MR pipelines; security and Docker build jobs restricted to MR pipelines via `.on-mr` template; `frontend-typecheck` (`tsc -p tsconfig.app.json --noEmit`) and `migration-check` (`makemigrations --check --dry-run`) added to the lint/test stages; coverage enforced at ≥90% via `--fail-under=90`; `backend-docker-build` and `frontend-docker-build` jobs verify images build on every MR
- CI dependency caching: `.npm-cache` template (keyed on `package-lock.json`) applied to all four frontend jobs; `.pip-cache` template (keyed on `requirements.txt`) applied to all four backend jobs — eliminates redundant downloads on warm runs
- Upgraded vulnerable dependencies: Django 5.1.4→5.1.15, django-allauth 65.3.0→65.14.1, requests 2.32.3→2.32.4, cryptography 44.0.2→46.0.5 (fixes 21 CVEs flagged by pip-audit)

### Fixed

- SAST findings: `getCookie` in `api/client.ts` inlined as a literal regex (removes `new RegExp(name)` dynamic construction, resolves `detect-non-literal-regexp`); `CardDetail.tsx` mention regex and `LoginPage.tsx` password comparison annotated with `// nosemgrep` — both are false positives (hyphen at end of character class is literal, not a range; client-side form validation has no timing-attack surface)
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
