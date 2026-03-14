# Changelog

All notable changes to Visiban are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Changed

- `docs-deploy` CI job no longer fires automatically on version tag pushes — docs are deployed by `scripts/release.sh` directly via `mike deploy`; the CI job is retained as a manual recovery tool only

---

## [v1.0.0-rc.4] — 2026-03-14

### Fixed

- Registration form no longer shows a username field; the backend auto-generates a username from the email address (`ACCOUNT_SIGNUP_FIELDS` and `ACCOUNT_USERNAME_REQUIRED = False` were already set, but the frontend form still sent a username and showed a conflict error UI) (#179)
- `LivenessView` and `ReadinessView` now set `throttle_classes = []` to exempt Kubernetes health probes from rate limiting; previously the global throttle caused probes to return 429, which caused Kubernetes to kill and restart the backend pod in a CrashLoopBackOff
- `nginx/app.conf.template` (production Docker Compose) was missing the `/_allauth/` proxy block; OAuth login and logout callbacks would return 404 in production; the block is now present and matches the Helm nginx configmap
- `docker-compose.prod.yml` was missing `REDIS_CACHE_URL`; Django defaulted to `redis://localhost:6379/1` which is unreachable inside the container, causing the health check to fail with a 500 on startup

### Changed

- Docker push CI jobs now run on every merge to `main` unconditionally (previously path-scoped to `backend/` and `frontend/` changes, which prevented the initial image push)
- Helm chart dependencies bumped: PostgreSQL `15.x` → `16.x` (PostgreSQL 17) and Redis `19.x` → `25.x` (Redis 8); removes broken `oci.bitnami.com` image registry override (Docker Hub images for old chart versions were removed upstream)
- Helm chart now deploys PostgreSQL via a built-in StatefulSet using the official `postgres:17` image (bitnami subchart disabled by default — Bitnami no longer publishes versioned tags to Docker Hub); `postgresql.subchartEnabled: true` restores the previous bitnami subchart behavior
- `frontend/Dockerfile` restructured: production nginx stage is now the last (default) stage; dev Vite stage is an explicit `target: dev` used by `docker-compose.yml`; previously the dev stage was last so kaniko pushed the node image instead of nginx
- Helm backend liveness and readiness probes corrected to use `/api/health/liveness/` and `/api/health/readiness/` (previously used `/api/auth/user/` which returns 401 and caused gunicorn to be killed by Kubernetes)
- Helm chart `imagePullPolicy` changed from `IfNotPresent` to `Always` for both backend and frontend; required because both images use the `:latest` tag — `IfNotPresent` caused pods to run stale cached images after a new push
- Docs site (docs.visiban.com) now publishes a versioned snapshot per release tag using `mike`; stable releases are aliased as `latest`, pre-releases as `next`; a version picker in the docs header lets users switch between releases; `CHANGELOG.md` is included in the docs site and frozen per release
- Documentation updated to reflect recent features: collaborator role at group level (#169), group starring and sidebar Favorites sections (#166, #167, #168), per-trigger notification preferences (#95), invite link improvements (#99), locale preferences (#161, #162, #163), and Settings page; architecture and data-model docs updated to match current state
- Added docstrings to all backend model classes for improved code navigability (#121)

### Added

- Invite link landing page now guides unauthenticated visitors: shows the group name and a clear explanation that a Visiban account is required; presents "Create an account" and "Sign in" paths with a visual separator, plus social login buttons (Google / GitHub / GitLab) when those providers are configured; sets `sessionStorage.returnTo` before any redirect so the invite is accepted automatically after authentication (#182)
- `LoginPage` now reads `location.state.authMode` on mount and opens in register mode when the join page redirects with `{ authMode: 'register' }`, so the user lands directly on the registration form without an extra click (#182)
- CI pipeline now builds and pushes backend and frontend Docker images to the GitLab container registry on every merge to `main` (path-scoped — only triggers when `backend/` or `frontend/` files change); images are tagged `latest` and the short commit SHA for rollback; kaniko is used for all builds (no Docker-in-Docker)
- First Boot docs now cover Kubernetes/Helm: how to run `ensure_site_admin` after the first deploy and how to reset the admin password with `changepassword` if the pod restarted before the password was retrieved
- `helm-lint` CI job added to the lint stage: runs `helm lint` and `helm template` against `values.yaml` on every change to `helm/` and on every `main` pipeline
- Removed `*.tgz` from `.helmignore` so Helm dependency tarballs in `charts/` are correctly included during install
- Deployment docs updated: Kubernetes/Helm install command now includes required `allowedHosts` and `corsAllowedOrigins` values; TLS/cert-manager install example added; pre-built image registry paths documented; post-install admin bootstrap step added; corrected incorrect claim that Helm uses daphne (it uses gunicorn)
- Docs updated post-!252 and !253: `docs/features/groups.md` describes the unauthenticated invite link auth flow; `docs/api/authentication.md` notes that login accepts username or email and that new accounts have auto-generated usernames; `docs/getting-started/oauth.md` notes the `/_allauth/` nginx proxy requirement for production; `docs/architecture/deployment.md` corrects Kubernetes/Helm PostgreSQL section — built-in StatefulSet with `postgres:17` is the default (Bitnami subchart disabled due to Docker Hub tag removal), documents `postgresql.subchartEnabled` value; `docs/features/notifications.md` corrects notification default states (due date warning, card moved, and comment added default to Off not On); `docs/architecture/overview.md` updates React Router version to v7 and CI/CD pipeline diagram to include the deploy stage (Docker image push and docs-deploy)
- `docs-deploy` CI job now supports a manual trigger from `main` with a `DOCS_VERSION` variable, allowing a specific version to be (re)deployed to docs.visiban.com without cutting a new release tag

---

## [v1.0.0-rc.3] — 2026-03-13

### Added

- Users can now set their preferred **date format** (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD), **time format** (12-hour or 24-hour), and **number format** (US, European, French, Indian) in Settings → Profile → Locale; preferences are persisted and applied to due-date labels on cards, card movement timestamps, attachment dates, and across the board (#161, #162, #163)
- Groups can now be starred from the group detail page header; starred groups appear in a **Favorite Groups** section at the top of the sidebar, above other groups and Personal boards (#167)
- Sidebar sections now appear in a consistent order — **Favorite Boards**, **Favorite Groups**, **Personal** — with empty sections omitted and 3D engraved separators between visible sections (#168)
- Collapsed sidebar icons now show immediate tooltips on hover for every item (Dashboard, Favorite Boards, Favorite Groups, groups, boards, Personal); the Favorites section headers are visually distinct (outlined star ☆ at smaller size) from individual starred items (filled star ★) (#166)
- Joining a group via invite link now redirects to the group page and shows a dismissible confirmation banner: _”You've joined [Group Name]. Welcome!”_ (#104)
- **Collaborator role for group memberships** (#169): `GroupMembership` and `GroupInviteLink` now support all four non-admin roles — Admin, Member, Collaborator, and Viewer — consistent with board membership roles; member role dropdowns in group settings and the invite link creation form updated accordingly; backend tests enumerate every valid role for both models to prevent future regressions
- **Subgroup member inheritance** (#138): members of a parent group are now surfaced as inherited members in all descendant subgroups; the members list endpoint returns both direct and inherited entries, each tagged with `is_inherited` and `inherited_from`; inherited members are shown with a muted row and an ancestor badge in the UI and cannot be removed or edited at the subgroup level; an ancestor admin can now perform admin actions (manage members, invite links, boards) on any descendant subgroup without a redundant direct membership
- **Default appearance: System** (#157): new user accounts now have their appearance preference explicitly initialized to `”system”` (follows OS preference) on first visit rather than relying on an implicit fallback; existing users are unaffected
- **Board starring / favorites** (#154): users can star any board they have access to; starred boards appear in a Favorites section at the top of the sidebar for quick access; the star button (☆/★) sits in the board toolbar and updates optimistically with rollback on failure; the `?starred=true` query parameter on `/api/boards/` filters to starred boards only; backed by a new `BoardFavorite` model (unique per user+board)
- **Board delete confirmation** (#140): deleting a board that has cards now requires typing the board name exactly before the delete button activates; boards with no cards can still be deleted with a single click confirm; `card_count` is now included in the board list API response
- **Onboarding empty state** (#103): new users with no boards or groups see a welcome screen with a Visiban board illustration, a short description, and two CTAs — “Create my first board” and “Join a group with an invite link”
- **Notification deep-linking** (#105): clicking a notification navigates to the relevant board and, when the notification is tied to a card, automatically opens the card detail modal; board-only notifications (e.g. membership events) navigate to the board without opening a card; if the card cannot be found in the board data (archived or deleted) a transient “Card not found” banner is shown and dismissed after 4 seconds
- **Invite link improvements** (#99): group invite links now support a customizable name, per-link role (member/viewer), and expiry (1/7/30 days or Never); groups can have up to 5 active links; expired links show a clear visual state and cannot be used to join; each link can be revoked independently
- New card inline editor now submits on Enter (default on); Shift+Enter always inserts a newline; configurable per board via Board Settings → General → “Close editor on Enter” toggle; setting stored as `close_editor_on_enter` on the `Board` model (default `True`)
- Per-trigger notification preferences in Settings → Notifications: toggle on/off card-assigned, @mention, due-date warning, card-moved, and comment-added events; preferences saved immediately on toggle and persisted per user (#95)
- **User timezone setting** (#96): users can select their timezone in Settings → Profile; defaults to browser-detected timezone on first save; due date labels (“Today”, “Overdue”) and the due date filter evaluate against the stored timezone instead of the system locale
- **Group-level board defaults** (#102): group admins can configure a default member role (admin/member/collaborator/viewer), allowed priorities (low/medium/high/urgent), and a shared label library per group; new boards created in the group inherit these defaults — labels are copied to the board on creation, and allowed priorities are applied if a non-default subset is configured; settings are managed in the group Settings tab under a new “Board defaults” section
- **Board Display preferences** (all roles): a new Display tab in Board Settings lets every user personalise their own view — hide individual columns, hide individual swimlanes, and toggle card-level fields (labels, due date, assignee, priority badge); preferences are stored in `localStorage` keyed by `board:{id}:view-prefs` with no backend required; changes apply immediately without a page reload and never affect the underlying data or other users' views (#111)
- JUnit XML test reports published as CI artifacts for both `backend-test` and `frontend-test` jobs; the Tests tab on every MR pipeline now shows per-test results, pass/fail counts, and timing
- Frontend test coverage raised from 72% to 85%+: new test suites for `SettingsPage`, `ThemeContext`, `ErrorBoundary`, and `BoardSettingsModal`; expanded suites for `App`, `CardItem`, `Avatar`, `BulkActionToolbar`, `GroupTree`, and the boards API client
- `GroupDetail` subgroup discoverability improvements: subgroups now appear in their own clearly labeled section with a dedicated “Create subgroup” button in the section header; an empty state message explains the purpose of subgroups (“Subgroups let you organize boards and members into nested workspaces.”) for both admins and non-admins; boards and subgroups are visually distinguished with different card styles (indigo tint for subgroups, gray for boards) and icons (#101)
- **Theme switcher** in Settings → Appearance: choose System (follows OS preference), Dark, or Light; preference is persisted in `localStorage` and applied immediately without a page reload; a FOUC-prevention inline script in `index.html` applies the saved class before first paint
- `GroupMembership` now supports a `viewer` role; group viewers get read-only access to all boards in the group — mapped directly to the existing `BoardMembership` viewer access model
- Swimlanes can be reordered by dragging their label (⠿ handle, admin only); each swimlane sidebar shows `+` insert-above and insert-below buttons on hover for positional insertion without rearranging existing rows
- Persistent collapsible left sidebar showing the full group/board hierarchy; collapses to icon-only rail (48px); expanded and per-group collapse states persist in `localStorage`; active board highlighted via route match; clicking a board or group in the sidebar navigates and auto-collapses the sidebar; collapsed group icons are now links that navigate directly to the group (#131, #143)
- Group owners can transfer ownership to any existing admin via the group settings danger zone; previous owner retains admin membership; transfer requires typing the group name as confirmation
- Cards now have a layered 3D raised shadow: a bottom-offset shadow simulates physical thickness, hover lifts the card with a deeper shadow, and the drag overlay uses an exaggerated lift for clear feedback
- `GroupDetail` now has **Boards** and **Settings** tabs; member management, invite link panel, and the danger zone (group deletion) are consolidated under Settings, which is hidden from non-admins
- **Board Settings** modal extended with three tabs: **Members** (view members and manage roles; inline remove confirmation; role descriptions on hover — admin only for edits), **Invite** (typeahead user search, staged invite list with per-user role picker — admin only), and **Data** (existing CSV/JSON export); the separate Members button is replaced by a unified Settings button visible to all roles
- `GET /api/users/?search=<query>` endpoint for authenticated user search (name/email/username), used by the Invite tab typeahead

### Changed

- Navbar header height increased from 48 px to 64 px; logo switched to `visiban_fullbleed_pulse_light.png` (white background, black **VISIBAN** lettering, original brand-color chart lines) at 48 px; breadcrumb and action button colors updated for the light header
- Removed the `← Dashboard` / `← Group` back-navigation bar from board, group, and settings pages; the sidebar provides equivalent navigation (#137)
- Added docstrings to all backend model classes (`Board`, `BoardMembership`, `BoardFavorite`, `Column`, `Swimlane`, `Label`, `Card`, `CardComment`, `CardActivity`, `CardChecklist`, `CardAttachment`, `Notification`, `Group`, `GroupMembership`, `GroupInviteLink`, `GroupFavorite`) for improved code navigability (#121)
- Added docstrings to all backend view classes and action methods across `accounts`, `boards`, and `groups` for improved code navigability (#122)
- Documentation updated to reflect recent features: collaborator role at group level (#169), group starring and sidebar Favorites sections (#166, #167, #168), per-trigger notification preferences (#95), invite link improvements (#99), locale preferences (#161, #162, #163), and Settings page; architecture and data-model docs updated to match current state
- Added JSDoc to all exported frontend API client functions across `auth.ts`, `boards.ts`, `cards.ts`, `groups.ts`, and `notifications.ts`; non-obvious parameters and return values include `@param`/`@returns` annotations (#123)
- Added JSDoc to exported frontend hooks (`useAuth`, `useBoard`, `useBoardSocket`, `useViewPrefs`) and non-trivial components (`Avatar`, `ErrorBoundary`, `CardItem`); non-obvious props on `CardItem` annotated inline (#124)
- GitLab project now requires a passing pipeline before any MR can be merged (`only_allow_merge_if_pipeline_succeeds`); documented in `CLAUDE.md`
- All native `<select>` dropdowns replaced with a consistent custom `SelectDropdown` component matching the board filter bar style: dark `bg-slate-800` trigger with chevron, `bg-slate-800 border-slate-600 rounded-lg` menu panel, hover-highlighted items, and 3D engraved separators between every adjacent item; separators are automatic — no per-option config needed; board filter bar dropdowns (`SingleSelectDropdown`, `CheckboxDropdown`) updated to match; Label filter shows “No labels on this board” when the board has none; separator style and pattern documented in `CLAUDE.md` for future dropdowns; affects board member role selects, group member role selects, default board member role, invite link role/expiry, card assignee, and the timezone setting (#156)

### Fixed

- Collapsed sidebar no longer shows a redundant ☆ section header above starred boards and groups; the filled ★ icon on each individual item (with its hover tooltip) is sufficient, and the outline header was causing one starred item to appear as two icons (#174, #178)
- Registration no longer fails with “This field is required.” on a fresh install; `ACCOUNT_USERNAME_REQUIRED = False` added to settings so allauth skips username validation and auto-generates one from the email address (#171)
- Registration form now includes an optional **Username** field; leaving it blank auto-generates a username from the email address; entering a taken username shows an inline error with a clickable suggestion (e.g. _”try **kelly42**”_) that populates the field on click (#171)
- Starring or unstarring a group from the group detail page now immediately refreshes the sidebar's Favorite Groups section; previously the sidebar only updated on board-star actions, so group stars appeared to have no effect (#170)
- Collapsed sidebar now shows a person icon (user silhouette) for the Personal boards section instead of the same house icon used by the Dashboard link, eliminating the duplicate icon confusion (#165)
- Invite link role dropdown now includes **Admin** as a selectable role in addition to Member and Viewer (#164)
- Navigating to a group the user cannot access (404/403) now redirects silently to the dashboard instead of showing a “Failed to load group” error; genuine network errors still surface with a “Return to dashboard” link
- Registration now requires email (not username); `ACCOUNT_SIGNUP_FIELDS` updated to `[“email*”, “password1*”, “password2*”]` — allauth auto-generates a username from the email; register form placeholder updated to “Email address”; login still accepts username or email
- Due date input in card detail: lightened background to `bg-slate-700`, brightened border to `border-slate-500`, set text to `text-slate-100`, and added explicit webkit date-field pseudo-element styles so the `mm/dd/yyyy` placeholder segments are clearly legible against the dark UI; calendar icon opacity increased to 70% at rest (#160)
- Role `?` tooltip in Board Settings Members tab no longer clips outside the modal; rebuilt as a portal-rendered tooltip anchored via `getBoundingClientRect()` at `position: fixed` with `z-index: 9999`, right-aligned to the button so it always stays within the viewport (#150)
- Changing a password via the forced-change modal no longer invalidates the session: `ChangePasswordView` now calls `update_session_auth_hash()` so the user stays logged in and subsequent API calls succeed (#148)
- Session-expiry interceptor now correctly detects 401 (Unauthenticated) responses from DRF instead of checking for a 403 with a message DRF never produces; stale-session detection now fires reliably after a password rotation or server-side session expiry (#148)
- Startup 401/403 responses from unauthenticated session-check requests no longer appear as `WARNING Forbidden:` in Django logs; a `django.request` logging filter suppresses expected auth noise while preserving WARNING logs for 4xx errors that warrant attention (#148)
- Page content now scrolls correctly on Dashboard, Settings, and GroupDetail: outer wrappers changed from `min-h-screen` to `h-full` to stay within the app's `h-screen` shell, and `overflow-y-auto` moved to the `<main>` content area; the board page already scrolled correctly (#147)
- Site admin (`ensure_site_admin`) now also sets `is_staff` and `is_superuser` so the bootstrapped admin account has full Django admin panel access in addition to Visiban site-admin privileges
- `GroupDetail` page now correctly treats site admins as group admins: `is_site_admin` users see the “New board”, “Create subgroup”, and settings controls without needing an explicit group membership
- `GroupDetail` Settings tab (and any other long-form content) is now scrollable; the `<main>` flex child was missing `overflow-y-auto`, causing content to be clipped by the `h-screen overflow-hidden` root layout
- Session expiry now redirects to the login page automatically; previously, if the backend session expired while the app was open, all API calls would silently fail with 403 and the UI would remain stuck in a “logged in” state with cryptic error messages
- “Failed to create group” modal now surfaces the actual server-side error message instead of a generic fallback
- Duplicate Timezone dropdown in Settings → Profile removed; only the #96 version (with “Detect automatically” option and helper text) remains
- Notification preference toggles in Settings → Notifications now save correctly; the `notif_*` fields were missing from the `updateCurrentUser` API type so the PATCH body was silently dropping them
- Profile settings: flash “Changes saved.” message then redirect to dashboard after save
- Summary and Analytics board views now render with the correct dark background (`bg-slate-900`); previously they inherited a light background from the page root (#129)
- Collapsed sidebar now shows a folder icon for groups and a home icon for the Personal section instead of single-letter initials; full names remain accessible via hover tooltip
- Board settings controls (column edit, swimlane edit, Settings button) are now rendered but visually disabled (`opacity-50`, `cursor-not-allowed`) for non-admins instead of being hidden; hovering shows “You need admin access to change board settings”
- Board Settings Invite typeahead suggestions now appear correctly; the dropdown was previously clipped by the modal's `overflow-y-auto` scroll container — fixed by rendering it with `position: fixed` outside the overflow boundary
- Assignee and due date filters now use the same custom dropdown style as priority and label: consistent button appearance, blue active state when a filter is selected, and a styled dropdown panel instead of native `<select>` elements
- Accepting a group invite via `/join/:token` now redirects to `/groups/:id` (the joined group's page) and shows a “You've joined [Group Name]” confirmation banner; unauthenticated users are redirected to login with the token preserved and the join completes automatically after authentication (#104)
- Social-only accounts (OAuth/GitLab/GitHub/Google) can now set a password from the Security settings tab without supplying a current password — previously the request always failed with “Current password is incorrect” because Django sets an unusable password for social-only accounts
- Security tab now adapts its UI for social accounts: the “Current password” field is hidden and the button label reflects first-time password creation
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
