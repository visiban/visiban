# Changelog

All notable changes to Visiban are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- Boards can now be shared as a public read-only link with no login required — board admins generate or revoke a share token from Board Settings; the link serves a static board view at `/share/:token` showing the full grid (columns, swimlanes, cards) without comments, attachments, or movement history; revoking the token immediately invalidates the link (#348)
- Board-level movement history view — new "History" tab on any board shows all card movements across the board with filters by swimlane, column, user, and date range; clicking a row opens a read-only card detail slide-in panel; paginated 50 per page (#344)
- Swimlane focus mode — clicking the crosshair icon on any swimlane row collapses all other rows and locks the URL to `?focus=<id>`; the blue banner at the top provides a single-click exit; Escape also exits focus mode (#340)
- Column `is_done` property — board admins can mark any column as "Count as completed (for cycle-time metrics)" in Edit Column; multiple terminal columns are supported (e.g. Closed Won + Closed Lost); the Summary view now shows Active cards, Done (30d), and Avg cycle (days) columns per swimlane (#342)
- New `docs/administration/authentication.md` page documents all supported authentication methods (OAuth providers, Generic OIDC, SAML) with a **Tech Preview** callout on the OIDC section — configuration plumbing is shipped but end-to-end login against a real identity provider is unvalidated
- New `docs/architecture/open-core-boundary.md` page records the canonical OSS vs enterprise classification for every feature area decided through pre-1.0 planning, including the full extension point registry for enterprise integrations
- Generic OIDC authentication is now configurable via three environment variables (`OIDC_CLIENT_ID`, `OIDC_SECRET`, `OIDC_SERVER_URL`); the provider is only registered when all three are set, preventing startup errors on partial configuration; an optional `OIDC_PROVIDER_NAME` variable controls the login button label (default "SSO") (#349)
- Users can now save named filter combinations per board and restore them in one click from a "Saved" dropdown in the filter bar — saved filters are stored server-side so they persist across devices and browsers; any board member including viewer-role can manage their own private saved filters (#343)
- Expanded sidebar now renders groups and their boards as a recursive tree — subgroups appear nested under their parent with indented chevron expand/collapse controls, and boards belonging to subgroups are shown inline under their group; the collapsed rail continues to show only top-level group icons
- Card detail panel now includes a "Move to" button in the breadcrumb row; clicking it opens a popover to move the card to a different column and/or swimlane without closing the panel
- Pressing Escape on the Analytics or Summary view returns directly to the Board view
- Analytics heatmap now uses absolute threshold-based coloring: green (well under threshold), yellow (within warning %), red (at or above threshold). Both the stale threshold and warning percentage are configurable per board in Board Settings → Stale card settings.
- New `stale_warning_pct` board setting (0–100, default 50) controls the yellow warning band in the analytics heatmap.
- Users can now create Personal Access Tokens (PATs) from Settings → Access Tokens to authenticate API requests without a session cookie — tokens carry a `vbn_` prefix, are shown only once at creation, support an optional expiry up to one year, and are limited to 10 per user; all tokens are automatically revoked when the user changes their password.
- The "Show full history" toggle in the card activity panel now persists across card opens, page refreshes, and sessions via `localStorage` — users who prefer the full history no longer need to re-enable it on each card (#333)
- Card weight is now shown in the card metadata row when weight is above 1 — teams using column weight limits can scan card weights from the board view without opening the card detail panel (#266)
- Card face now shows a relative "last moved" label (e.g. "moved yesterday", "moved 3 days ago") for cards not moved within the last 24 hours; cards moved within 24 hours continue to show the existing blue dot indicator on hover; the label can be hidden per-board via Board Settings → Card fields → Last moved (#338)
- Hard WIP enforcement mode: board setting that blocks all card moves into over-limit columns for all roles with no admin bypass (#341)
- The "Move to" button in the card detail breadcrumb row now shows a first-encounter dot indicator for users who have not yet clicked it, improving discoverability; the dot is dismissed on first click and the dismissed state persists across sessions via `localStorage` (#339)
- Analytics API response now includes a `done_columns` list of column names that are excluded from dwell-time calculations, so callers can surface which columns are omitted
- A footer note below the analytics heatmap now shows how many done columns are not included in the heatmap, making the exclusion visible to the user at a glance
- Admins can now create invite links with an optional TTL (1 day / 7 days / 30 days) and a single-use flag from the Admin panel — generated tokens can be shared directly with new users
- When `INVITE_ONLY` registration mode is enabled, account creation requires a valid invite token; attempts without a token are rejected at `/api/auth/registration/`
- Deactivating a user now triggers an offboarding flow: board ownership on any boards the user owns is transferred to an eligible member before the account is deactivated; deactivation is blocked when no eligible transfer target exists on any owned board (`POST /api/admin/users/{id}/deactivate/`)
- Admin panel includes a new "Invite Links" tab showing each token's status badge and a one-time reveal of the token value; links can be revoked inline

### Changed
- Sample board files relocated from `backend/boards/seed_data/` to a top-level `sample-boards/` directory for discoverability — all 11 templates (10 domain-specific + 1 demo board) now ship as ready-to-import JSON and CSV files at the repo root with a README documenting the import flow
- All 10 template boards expanded from 5 swimlanes / ~12 cards to 10–11 swimlanes / 110–121 unique cards with theme-appropriate content, movement history, activities, labels, checklists, and comments; demo board expanded from ~80 to ~120 unique cards with no duplicate titles
- Clicking the crosshair (focus) button on an already-focused swimlane now toggles focus mode off; Escape key and the banner "Exit focus" button remain as alternative exit paths; the button now carries `aria-pressed` for screen reader accessibility (#363)
- Comprehensive documentation review: rewrote 17 doc files to match current codebase — corrected analytics color-coding table (was using old 2× median heuristic), fixed `card.archived` WebSocket payload (was showing full card, code sends `card_id` only), added 12 missing event types to realtime docs, added 15+ missing fields/entities to data model docs, documented `is_site_admin` vs `can_access_all_content` split in RBAC docs, added missing feature docs for saved filters, board templates, hard WIP enforcement, text color picker, @mentions in descriptions, collapsed rail flyouts, and more
- Board sub-nav tabs (Board / Summary / Analytics) are now URL-addressable — switching tabs updates the `?view=` search param with `{ replace: true }` so the browser Back button skips tab transitions and tab views can be bookmarked and shared (#332)
- Analytics heatmap column headers no longer show per-column median values; coloring is now driven by the board-level stale threshold.
- Board Settings stale card section renamed from "Stale card threshold" to "Stale card settings" with a second input for the warning percentage.
- Personal Access Tokens settings page now displays "Never" instead of a dash for tokens with no expiry date, making the non-expiring state immediately legible; expiry field now shows inline helper text ("Leave expiry blank for a non-expiring token (max 1 year if set)") so users understand the optional nature of the field without visiting docs

### Fixed
- All 11 seed data JSON export files now include `is_done` on terminal columns — previously the field was omitted from exports, causing imported boards to lose done-column marking and breaking analytics dwell-time exclusion and stalled-card detection
- Demo board seed data no longer produces duplicate card titles — expanded title pool from 82 to 129 entries and replaced modulo-wrap index with a break guard that stops card generation when titles are exhausted
- Public share endpoint now enforces rate limiting (120 req/hour per IP via `ShareLinkThrottle`) — previously `throttle_classes` was empty, leaving the unauthenticated endpoint unprotected against scraping (#348)
- Public board serializer now includes `staleness_threshold_days`, `is_stale`, and `last_moved_at` on each public card using prefetched movement history — previously all three fields were missing from the share endpoint response (#348)
- Toggling a board's share link now broadcasts a `board.updated` event to connected clients so the share token state updates in real time without a page refresh (#348)
- `CardMovementSerializer` now exposes `card_uid` and `card_title` so the board-level history view can identify cards without secondary API calls (#342)
- `ShareBoardPage` swimlane rows now use `<Fragment key={...}>` instead of shorthand `<>` — the shorthand syntax cannot carry a `key` prop, causing React key warnings on multi-swimlane boards (#348)
- Board templates now correctly mark terminal columns as `is_done=true` (e.g. "Approved" in Legal & Compliance) and set `allow_card_creation=true` on the single intake column only — previously `is_done` was missing from seed data and multiple columns had card creation enabled
- Legal & Compliance template "Archived" column renamed to "Closed" to avoid confusion with the card archive function; Project Delivery template now ends with a "Done" column marked `is_done=true` instead of "Retro"
- `movement_type` value `"restored"` renamed to `"unarchived"` to match the rest of the codebase (`/unarchive/` endpoint, `unarchiveCard` API call, "Unarchive" button); the Archived cards panel button label updated from "Restore" to "Unarchive" accordingly
- Pressing Escape on the Analytics view now returns directly to the Board view — previously it navigated to Summary first, requiring a second Escape press (#360)
- Added targeted regression test asserting heatmap column headers and cell values always render in `AnalyticsView`, preventing the recurring silent regression where the table disappears without failing the test suite (#361)
- Login page and join-invite page now render an SSO button for OIDC-only installs — the OAuth section gate previously excluded OIDC from its visibility condition, so the button was never shown even when OIDC was the only configured provider; the button label uses the configured `oidc_name` value (falls back to "SSO")
- Checking or unchecking a checklist item now immediately updates the `✓ done/total` count on the card tile in the board view — previously the count was calculated from a stale delta that could produce a wrong value or revert on rapid successive checks (#330)
- Board columns are now expanded by default on every initial view — including imported boards, template-created boards, and newly-added columns — eliminating cases where columns appeared collapsed until a user interaction or page effect fired
- Space+drag board panning re-attaches event listeners after switching between Board, Summary, and Analytics views — previously the hook captured a stale DOM reference on first mount and lost pan mode whenever the scroll container remounted
- "Move to" popover in the card detail panel now renders as a fixed-position overlay so it is no longer clipped by the panel's `overflow-hidden` container
- Board template seed data no longer produces duplicate cards when the generator script is run multiple times — `extra_cards` is now the sole source of truth and the output is idempotent; Sales Pipeline swimlanes renamed from company names to sales regions (North America, APAC, EMEA, LATAM, ANZ)
- Collapsed sidebar no longer renders an unbounded list of board icons — starred boards, starred groups, and personal boards are now accessible via two flyout panels (Favorites ★ and Personal boards) that open on click, cap at a scrollable max height, and show board names; active-board state is reflected on the trigger icon
- Creating a board inside a group now respects the `template` field from the request — previously the group board creation endpoint ignored the chosen template and always applied the default Backlog/To Do/Doing/Done columns
- Groups flyout panel in the collapsed sidebar now shows subgroups indented under their parent at the correct nesting depth — previously all groups appeared at the same visual level because the flyout read from the flat groups array instead of the sidebar tree
- BoardView layout containers now use flex wrappers instead of fragments, eliminating layout shifts when transitioning between empty, loading, and ready states
- The release script now bumps `frontend/package.json` version as part of each release commit, so the Settings → About page always shows the correct version number after a release
- `frontend/package.json` version corrected from `1.0.0-rc.8` to `1.0.0-rc.9` to match the current release tag
- Escape key is now consistent across the whole app — pressing Escape always closes the topmost open modal, popover, or confirm dialog before falling through to page-level back navigation; addressed surfaces: `ForceChangePasswordModal` (no longer falls through to page nav), `AdminPage` confirm and add-user dialogs, `GroupDetail` transfer-ownership and delete-group overlays, `CollapsedFlyout` (migrated to the priority stack), and the FilterBar search input (Escape clears search and blurs the field) (closes #331, #334)
- Board settings modal no longer resizes when switching between Members, Display, Rules, and Data tabs — panel now uses a fixed height (`h-[85vh] max-h-[640px] min-h-0`) so content scrolls within a stable container (#328)
- Analytics heatmap now shows dwell-time data in 7-day and 30-day views — previously, cards whose last column entry was older than the selected period showed no data even if they were still sitting in that column; dwell time is now clamped to the period boundary so all active cards contribute to the heatmap (#327)
- Analytics stalled-card detection now always uses the board-configured staleness threshold (`staleness_threshold_days`) regardless of which period is selected, rather than defaulting to 7 days from the query param (#327)
- Analytics heatmap now renders data correctly for 7d, 30d, and 90d period views — period-cutoff math fixed so cards that entered a column before the selected window no longer show zero dwell time
- Analytics stall detection now defaults to the board's configured staleness threshold instead of the period window length; `stalled_days` query param still accepted as an explicit override
- Analytics heatmap layout is now pinned so the heatmap is always visible at the top; the stalled cards list below it scrolls independently instead of sharing a single scroll container
- Analytics heatmap dwell-time calculations now exclude columns marked as done (`is_done=True`) — a card's clock stops when it enters a done column, and cards sitting in done columns are no longer flagged as stalled
- Race-condition test for single-use invite tokens now explicitly closes thread-local database connections after each worker thread exits, preventing `destroy_test_db` from failing with "database is being accessed by other users" on PostgreSQL CI runners
- Rich text editor color picker now correctly activates the toolbar "A" indicator when White is selected — previously White was excluded from the active-color check by an overly narrow condition
- Analytics heatmap `is_outlier` cell coloring now correctly uses the board's configured staleness threshold in all cases — a backend test was added to confirm the board threshold is used even when the `stalled_days` query param overrides the stalled-card list

---

## [1.0.0-rc.9] — 2026-03-24

### Added

- Space + drag board panning — hold Space to enter pan mode (cursor changes to grab), then drag to scroll the board horizontally and vertically without activating card drag-and-drop (#311). Panning is suppressed on column headers, swimlane labels, and card surfaces so those interactions remain unaffected.

- Groups now have an optional `description` field — visible below the heading on the Group detail page, inline-editable by admins, and settable at creation time in the Create Group modal (#324)
- Group detail page shows a full ancestor breadcrumb chain above the `<h1>` heading for subgroups, enabling navigation up through nested group hierarchies; the Navbar breadcrumb is also updated to reflect the full chain (#324)
- `GET /api/groups/<id>/` now returns an `ancestors` array (`[{id, name}]`, root-first) via `GroupDetailSerializer`; the list endpoint is unchanged to avoid N+1 queries (#324)
- Create Group modal now accepts an optional description with a character counter (warns at 450 chars, hard limit 500); name field Enter moves focus to description rather than submitting (#324)
- Create Group modal styling corrected to match the design system: `bg-slate-800` inputs, `rounded` corners, full `focus:ring-2 focus:ring-blue-500` focus ring, `bg-black/60` backdrop (#324)

- Site admins can now enable or disable file uploads instance-wide via **Admin Panel → Settings → Features**. When uploads are disabled, all attachment upload attempts return `403 feature_disabled`; existing attachments remain accessible. The toggle is reflected in `GET /api/auth/me/` as `uploads_enabled` and in `GET /api/admin/settings/` (issue #312).
- API reference documentation for the notifications endpoints (`GET /api/notifications/`, `POST /api/notifications/mark-read/`, `GET /api/notifications/unread-count/`) — these endpoints existed but had no API docs
- `seed_template_boards` management command seeds all six board templates (`sales_pipeline`, `customer_support`, `customer_success`, `simple_kanban`, `product_roadmap`, `project_delivery`) with domain-specific swimlanes, cards, labels, checklists, comments, and full CardMovement history (#254). Seed files are exported to `backend/boards/seed_data/<slug>/seed.{json,csv}`.
- Four new board templates are available: Content Production, Hiring & Recruiting, Legal & Compliance, and Infrastructure & DevOps — each with domain-specific swimlanes, cards, labels, and column structures
- Card JSON exports from `seed_template_boards --export` now include a `movements` array per card, enabling imported boards to display realistic History tab data
- Icons added for the four new board templates (Content Production, Hiring & Recruiting, Legal & Compliance, Infrastructure & DevOps) in the Create Board modal template picker
- Demo seed data richly expanded: all 10 board templates now have 30–54 cards each (up from 11–14), with varied movement histories (stage skipping and occasional backtracks), full card content (descriptions, checklists, comments, labels, due dates, weights, assignees), and a standalone `generate_seed_data.py` script to regenerate all JSON files without requiring a Django environment

### Fixed

- Board Settings modal no longer resizes when switching between tabs — the panel now uses a fixed height (`h-[85vh] max-h-[640px]`) so Members, Display, Rules, and Data tabs all occupy the same frame; content scrolls within the panel (#328)
- Analytics view now opens the card detail panel when a stalled card row is clicked — the `CardDetail` was missing from the analytics view's render branch so clicking never produced a visible result (#326)
- Analytics period selector (7d/30d/90d) now shows a "No card movements recorded in the last N days" message when the selected window contains no movement data, making it clear the filter is active and the board simply has no recent activity (#326)
- `is_site_admin` no longer implicitly grants access to all boards and groups — a new `can_access_all_content` flag controls omniscient board/group access; existing site admins are automatically migrated to `can_access_all_content=True` so no access is lost on upgrade (#247)
- Removed-member WebSocket connections now closed immediately when a `member.removed` broadcast is received, preventing the evicted user from continuing to see board events (#318)
- Board update and delete mutations now broadcast `board.updated` and `board.deleted` events so connected clients reflect changes in real time (#318)
- Attachment upload is now wrapped in `transaction.atomic()` so the file record and its broadcast are rolled back together on error (#318)
- N+1 queries eliminated on `GET /api/boards/<id>/full/`: board now loaded with `select_related` over the full group ancestor chain; favorites resolved via `Prefetch(to_attr="_user_favorites")` instead of a per-request subquery; `_card_queryset` adds `select_related("created_by")` and prefetches movement `moved_by`/column/swimlane FKs (#313 #315 #317)
- `get_board_role` group ancestor lookup consolidated from one `GroupMembership` query per ancestor level into a single `filter(group_id__in=ancestor_ids)` query (#314)
- Card move endpoint (`POST /api/boards/<id>/cards/<id>/move/`) no longer issues a redundant `SELECT FOR UPDATE` when only WIP or only weight enforcement is active; source-cell sibling reorder uses a single bulk `UPDATE` instead of N individual saves (#317)
- Viewer and collaborator role members can no longer update board settings, columns, swimlanes, labels, or card fields that require at least member-level access — the missing write-permission gate is now enforced at the viewset level (#316)
- Attachment deletion now requires the requesting user to own the attachment or hold a member-or-higher role on the board; collaborators can only delete their own attachments (#316)
- Subgroups list (`GET /api/groups/<id>/subgroups/`) now filters to subgroups the requesting user is directly a member of, instead of returning all subgroups that descend from accessible groups (#316)
- Board filter bar now shows a "No cards match the active filters" banner when the active filters produce zero results, instead of silently rendering an empty grid (#263 #319)
- Column trash zone "Delete" label now uses `text-red-200` when active (dragging over), replacing the illegible `text-red-700` on a dark red background (#319)
- Hover-reveal board action buttons (move-to-group, delete board) on the Dashboard now include `focus-within:opacity-100` and individual focus rings so keyboard users can reach them (#319)
- Checklist item and attachment delete buttons in the card detail panel now include `focus:opacity-100` and a focus ring, making them reachable without a mouse (#319)
- Board load error now shows a Retry button alongside the error message (#319)
- Dashboard modal dialogs (Join Group, Delete Board) updated to `rounded-lg` + `border border-slate-700` to match the design system (#319)
- `ErrorBoundary` Reload button corrected from the undefined `bg-primary` token to `bg-blue-600` (#319)
- Onboarding empty state heading corrected from `text-2xl font-bold` to `text-xl font-semibold` to match typography scale (#319)
- `+ Add card` affordance in board cells corrected from `text-[11px]` to `text-xs` to use the standard Tailwind scale (#319)
- `flatted` npm dependency bumped past 3.4.1 to resolve GHSA-rf6f-7fwh-wjgh (prototype pollution, high severity)
- Board JSON import now restores full card history: `assignee`, `movements` (CardMovement records with correct timestamps), and `activities` (CardActivity records for assignee, label, priority, due-date, checklist, and comment events) are all applied from the imported file (#321)
- Board JSON export (`seed_template_boards --export`) now includes `schema_version: 1`, `assignee`, and per-card `activities` arrays so exported files round-trip cleanly through import (#321)
- Seed data JSON files enriched to include `schema_version: 1`, demo user assignees, complete column movement chains (col0 → … → current), and full activity histories (#321)
- Migration 0030 (trigram search indexes) rewritten to be SQLite-safe: PostgreSQL-specific `CREATE EXTENSION` and `GIN` index SQL is vendor-guarded, keeping the local SQLite test database working (#321)
- Board Settings → Data tab now shows a format selector (JSON pre-selected) with descriptions — "Full history: movements, activity log, and assignees" for JSON and "Card data only, no history" for CSV — and a single "Export JSON / CSV" button that reflects the selection; `docs/features/board.md` updated to match
- API docs corrected: archive/unarchive/archived card endpoints documented; `weight_limit_exceeded` error response now includes `card_weight` field; attachment download via authenticated `/media/` route documented; summary endpoint response shape expanded with `stage_distribution` and `color`; CSV/JSON export formats fully described; writable fields listed for column, swimlane, and label `PUT`; `display_name` added to `PATCH /api/auth/me/` writable fields
- Scheduled `cleanup-merged-branches` CI job no longer fails when all merged branches have already been deleted — `grep -v` returning exit 1 on an empty result set was propagated as a job failure under `pipefail`; fixed with `|| true`
- Analytics period filter (7d / 30d / 90d) now correctly scopes dwell times and velocity calculations to movements within the selected window — previously all three periods returned identical results because the `days` parameter was parsed but never applied to the movement query
- Stalled card rows in the Analytics view are now clickable and open the card detail panel directly on the board — previously the rows were non-interactive `<div>` elements with no navigation
- Column settings modal now includes a "Delete column" danger button (admin-only), routing through the existing confirmation dialog — previously the only way to delete a column was the undiscoverable drag-to-trash gesture (#267)
- Group admins can now rename a group inline by clicking the group name heading on the Group detail page — non-admins see a plain, non-editable heading (#323)
- `PATCH /api/groups/<id>/` and `PUT /api/groups/<id>/` now require group admin role; previously any group member could rename or re-parent a group (#323)
- Analytics heatmap now shows dwell-time data across all period views (7d, 30d, 90d) — cards that entered a column before the selected window were previously excluded entirely, causing those periods to show dashes; entry time is now capped at the window start so active cards always contribute
- Analytics stall detection now uses the board's `staleness_threshold_days` setting to decide when a card is stalled, instead of the selected period length — previously 7d incorrectly flagged every unmoved card as stalled regardless of the configured threshold

### Changed

- `simple_kanban` template revised to the classic 5-column layout: Backlog → To Do → Doing → Review → Done
- Seed command now generates `CardActivity` records (assignee, labels, due date, priority escalations, checklist events, comments) for each card so the History tab shows rich activity alongside column movements
- Seed data files flattened from `seed_data/<slug>/seed.json` to `seed_data/<slug>.json` (one directory, one file per template)
- JSON export recommended over CSV: JSON includes the full CardMovement history; CSV contains column-level data only and is noted as such in the export output
- The first-boot and installation getting-started pages now include a "Password file not found?" note explaining that a missing `/tmp/visiban_admin_password` means the admin account was already bootstrapped on a previous boot, and giving the `python manage.py changepassword admin` command to reset it
- Board view scrollbar is now 10 px wide and higher-contrast (slate-500 at rest, slate-400 on hover) for better discoverability on macOS and Windows
- Hover-reveal controls (add-subgroup button, swimlane drag handle, card checkbox) now gain `focus:opacity-100` and a focus ring so keyboard users can reach and activate them without a mouse
- All form inputs now use a consistent `focus:ring-2 focus:ring-blue-500` focus ring and `placeholder-slate-500` placeholder color, replacing the previous inconsistent `focus:border-blue-500` treatment
- Removed the disabled "Light (Coming soon)" theme placeholder from Settings → Appearance to reduce visual noise
- Added a Settings → About tab showing the running app version string
- GroupDetail label and transfer inputs corrected to `bg-slate-800` background and updated focus ring to match the design system
- CardItem description no longer expands on hover, eliminating layout shift; a small indicator icon in the metadata row signals that a description exists, and the full description remains accessible in the card detail panel
- Restored button in the Archived Cards panel changed to the secondary variant to comply with the design system — `text-blue-400` is reserved for active filter and selection states
- Demo seed export files relocated from `scripts/seed/` to `backend/boards/seed_data/` to co-locate them with the boards app and its management commands; `seed_demo_data --export` and the CI `seed-export-check` job updated accordingly
- `sales_pipeline` template expanded from 6 to 8 columns: Prospect → Qualified → Discovery → Demo → Proposal Sent → Negotiation → Closed Won → Closed Lost
- `customer_support` template expanded to 7 columns with a new Escalated stage between In Progress and Resolved
- `simple_kanban` template expanded from 5 to 7 columns: Backlog → Refined → Sprint Ready → In Dev → In Review → QA/Testing → Done
- `product_roadmap` template redesigned from 6 to 8 columns: Idea → Validated → Scoped → Prioritized → In Build → Beta → Launched → Monitoring
- Seed data cards now each represent the primary tracked item for their workflow (deals in sales, tickets in support, accounts in customer success, features in roadmap, candidates in recruiting, etc.) rather than individual sub-tasks
- Create Board modal: loading state now shows a spinner instead of plain text, template cards have keyboard focus rings (`focus-visible:ring-2`), API failure shows an inline error instead of silently hiding templates, input focus ring updated to `focus:ring-2 focus:ring-blue-500 focus:border-transparent`, hint text color standardized to `text-slate-500`, and an X close button added to the header

---

## [1.0.0-rc.8] — 2026-03-21

### Added

- Pressing Escape while a dropdown is open (filter bar, column settings, bulk action toolbar) now closes the dropdown and returns keyboard focus to the trigger button (#270)
- All modals (Board Settings, Edit Column, Edit Swimlane, Bulk Delete confirm, Join Group, Delete Board) now carry `role="dialog"`, `aria-modal`, and `aria-labelledby` so screen readers announce the dialog title on open (#296)
- Card detail side panel now carries `role="complementary"` for landmark navigation (#296)
- Interactive elements across the board UI (cards, column collapse/edit buttons, swimlane collapse/edit buttons, navbar bell/user/sign-out, bulk action toolbar buttons) now show a `focus-visible` ring on keyboard focus and suppress the ring on mouse interaction (#269, #298)

### Changed

- Board Settings now has a dedicated Rules tab that groups WIP/weight enforcement toggles and the staleness threshold together, separating board rules from display preferences (#264)
- WebSocket live indicator is now three-state: green "Live" when connected, amber "Reconnecting…" while attempting to reconnect, and grey "Offline" when the connection has permanently failed (#308)
- "Close editor on Enter" now defaults to on for new accounts — users who prefer multi-line entry can disable it in Settings → Behavior (#309)
- User editor preference ("Close editor on Enter") is now in its own Settings → Behavior tab, separating behavioral preferences from visual appearance settings (#309)
- WIP and weight limit enforcement is now **on by default** for newly created boards — existing boards are unchanged; only boards created after this release will have enforcement enabled automatically (#307)
- Column header WIP over-limit stat now uses text color only (`text-red-400 font-semibold`), matching the weight over-limit treatment — removes the inconsistent filled background that appeared when both stats were shown simultaneously (#268)

### Fixed

- Collapsed swimlane rows now show card counts as full-width pill badges aligned with their column headers — previously cells were 40 px stubs misaligned with the column grid; filter matches are highlighted in blue to match the collapsed-column behavior
- Board scroll container now shows always-visible styled scrollbars (8 px, slate-600 thumb) so users on macOS with "show scrollbars when scrolling" do not encounter an apparently non-scrollable board
- Running `manage.py test` locally no longer requires a running Redis instance — the test suite now automatically uses `InMemoryChannelLayer` and `LocMemCache` when invoked via `manage.py test`, eliminating false failures caused by Redis connection errors in environments without a local Redis server
- Site admin "Make admin" now requires a confirmation step before granting site admin privileges — previously a single click was sufficient, with no undo prompt
- Site admin confirm dialog and Add User modal now carry `role="dialog"` and `aria-modal` so screen readers announce them correctly on open
- Site admin Settings tab status messages ("Settings saved." / error) no longer cause layout shift when they appear or disappear
- Site admin Users tab now always shows the total user count, not only when there is more than one page of results
- Attaching to a media file path you are not a board member of now returns 404 instead of 403, preventing an attacker from confirming whether a file path is valid (#310)
- `CardViewSet.update()` now runs inside a single `transaction.atomic()` block — previously a failure in activity or notification creation after the card save would leave the card updated but with a missing audit trail (#310)
- Deleting a swimlane now reloads board state on API failure instead of leaving the UI permanently desynchronized with the server (#310)
- Forcing a blocked card move now surfaces a structured error to the user when the override itself fails, rather than silently reverting (#310)
- `DJANGO_ADMIN_ALLOWED_IPS` and `ACCOUNT_EMAIL_VERIFICATION` are now documented in `.env.example` so operators are aware of these production-relevant settings (#310)
- Login page inputs now use correct mid-level background (`bg-slate-800`) with visible border and placeholder color, matching the design system depth tokens (#302)
- Settings page (Profile and Security tabs) now reserves fixed vertical space for inline status messages so surrounding buttons no longer shift when save/error text appears (#301)
- Board Settings button is now hidden entirely for non-admin users instead of being greyed out — removing the misleading disabled affordance (#299)
- GroupDetail page: replaced all `gray-*` Tailwind tokens with `slate-*` to match the project's dark theme color system (#294)
- Helm chart `backend-deployment.yaml` now runs daphne (ASGI) instead of gunicorn (WSGI) — Kubernetes deployments via the Helm chart previously used gunicorn which cannot serve WebSocket connections, causing real-time board updates to silently fail (#276)
- Removed gunicorn from `requirements.txt` — daphne is the ASGI server used in all deployments; gunicorn was a leftover from before the ASGI migration (#276)
- Card detail `save()` now catches API errors, rolls back to the pre-save state, and shows an inline error message — previously any failure was silently swallowed and the UI was left in an inconsistent state (#300)
- Bulk move now shows an inline amber warning when one or more cards could not be moved (e.g. blocked by a WIP or weight limit) and keeps the selection active so the user knows which cards were affected; previously partial failures were silently discarded (#303)
- All 8 `window.confirm()` calls replaced with inline confirmation UI consistent with the design system — affects: card delete, card archive, column delete, board member remove, group member remove, group delete, shared label remove, invite link revoke (#295)
- Board list endpoint now fetches owner and group in a single JOIN instead of issuing one additional query per board — previously `owner` and `group_name` were not covered by `select_related`, causing extra queries per board on large board lists
- Analytics endpoint no longer issues one card+movement query per swimlane — all cards and movements are now loaded in two queries and grouped in Python, eliminating O(swimlanes) extra database round-trips
- Export endpoint (CSV and JSON) no longer re-queries movements, comments, and checklist items per card — `.order_by()` calls replaced with Python sorting over the existing prefetch cache
- Comments list and attachments list endpoints now use `select_related("author")` and `select_related("uploaded_by")` respectively to avoid one extra JOIN per item
- Groups list endpoint now annotates member, board, and subgroup counts plus the starred flag in a single query instead of issuing 4 additional queries per group
- Google OAuth button on the login page no longer uses light-mode colors (`bg-white text-slate-900`) — now correctly uses `bg-slate-700 text-white` matching the dark theme
- `text-gray-400` token in AnalyticsView column header replaced with `text-slate-400` to match the project color system
- Hover-reveal edit and delete buttons in the card description editor and board selector now include `focus:opacity-100` and a visible focus ring so keyboard users can reach and activate them
- Card creation in board cells now shows an inline error message when the API call fails instead of silently dropping the user's input
- Swimlane contact email is now hidden from non-admin board members in the sidebar, matching the server-side field gating already in place on the API

---

## [1.0.0-rc.7] — 2026-03-21

### Added

- Opt-in WIP limit enforcement (`enforce_wip_limits` board setting): when enabled, moving a card into a column at or over its WIP limit returns a 409 with a structured error payload; board admins can override with `?force=true`; non-admins get 403 on force attempts; archived cards are excluded from the count; a composite index on `(board_id, column_id, archived_at)` keeps WIP count queries fast (#231)
- Server-side per-board card search: the search input in the filter bar now queries `GET /api/boards/{id}/cards/?search=<q>` (title and description, case-insensitive) debounced at 300ms with `AbortController` cancellation of stale requests; a small spinner appears inside the input while the request is in-flight; errors fall back silently to showing all cards; client-side filters (assignee, label, priority, due date) continue to run locally and are intersected with server results (#233)
- Due date changes (set, update, clear) now appear in the card activity history with human-readable labels (e.g. "Due date: (none) → Apr 14, 2026"); rapid-fire weight and field changes from ± buttons are debounced at 600ms so only the net change is recorded rather than every intermediate step (#259)
- Opt-in weight limit enforcement (`enforce_weight_limits` board setting): when enabled, moving a card into a column that would exceed its weight budget returns a 409 showing current weight, card weight, and limit; board admins can override with `?force=true`; archived cards excluded from weight sum; WIP check runs first when both limits are enabled (#260)
- OpenAPI 3.0 spec exposed at `/api/schema/` via drf-spectacular with Swagger UI (`/api/schema/swagger-ui/`) and ReDoc (`/api/schema/redoc/`); CI validates the schema on every backend change (#258)
- Board filter state (text search, assignee, priority, labels, due date) is now persisted to `localStorage` keyed by `board:{boardId}:filters` — navigating away from a board and returning restores the previous filters; corrupt or missing storage falls back to empty filters without error (#252)
- Comment delete button added to card detail — two-stage confirmation, RBAC-gated to comment author and board admins (#257)
- CreateGroupModal: after a group is created the modal now shows a brief `✓ "Name" created` confirmation in green below the input, clears it after 2 seconds, and returns focus to the name field so the user can immediately type the next group name (#253)
- Docs: new `docs/api/admin.md` — complete reference for the Admin REST API (`GET/PATCH /api/admin/settings/`, `GET/POST /api/admin/users/`, `PATCH /api/admin/users/{id}/`)
- Docs: `docs/api/authentication.md` — new sections for user search (`GET /api/users/`), OAuth providers (`GET /api/auth/providers/`), and change password (`POST /api/auth/change-password/`)
- Docs: `docs/api/boards.md` — board star/favorite endpoints and board templates endpoint with full response schema and template list
- Docs: `docs/api/groups.md` — transfer ownership, group shared labels, and board defaults endpoints
- Docs: `docs/api/health.md` — version endpoint (`GET /api/version/`)
- Docs: `docs/features/groups.md` — board move-between-groups, group shared labels, board defaults, and ownership transfer sections
- Docs: `docs/features/realtime.md` — `card.archived` and `card.unarchived` WebSocket events; WebSocket event envelope (`{event, data}`) and full `card.moved` payload (`{card, movement}`) documented (#256)
- Docs: `docs/api/cards.md` — documents that `GET /api/boards/{id}/cards/` returns all cards without pagination; `docs/api/authentication.md` documents `GET /api/auth/me/`, `PATCH /api/auth/me/`, and `GET /api/auth/site-config/`; `docs/api/boards.md` documents `staleness_threshold_days` and `allowed_priorities` fields (#256)
- Docs: Card Archiving, Demo Data, and Secret Rotation pages now appear in the docs sidebar — they existed but were missing from the mkdocs nav; fix broken `../administration/` link in the features index

### Changed

- WebSocket event schema now uses `{event, data}` keys instead of `{type, ...spread}` — prevents payload collision when a serializer field is also named `type`; `BoardEvent` TypeScript type updated to match (#256)
- `card.moved` WebSocket broadcast now includes the full movement record (`{card, movement}`) — consistent with the REST response so clients can update movement history without re-polling `/movements/` (#256)
- `CardViewSet` no longer paginates — cards are always board-scoped so `PAGE_SIZE: 50` would silently truncate busy boards (#256)
- Board Settings: merged the Invite tab into the Members tab — add-member search now appears at the bottom of the Members tab for admins, removing the need to switch tabs; `staleness_threshold_days` is now editable by admins (and read-only for non-admins) in the Display tab (#245)
- `BoardFullSerializer.get_members()` now uses `UserSerializer` for each member entry so inherited/implicit members stay in sync with direct members when new `User` fields are added (#256)
- `Board` TypeScript interface now includes `staleness_threshold_days` and `allowed_priorities` — both are returned by `BoardSerializer` but were missing from the frontend type contract (#256)
- `getSiteConfig` return type now includes `registration_mode` — the field was returned by the API but omitted from the TypeScript return type (#256)
- Removed `NotificationPrefs` TypeScript interface and `DEFAULT_NOTIFICATION_PREFS` constant — field names did not match the backend (`card_assigned` vs `notif_card_assigned`), and `notification_prefs` was never a User field on the API (#256)

### Fixed

- Board Settings "Enforce WIP limits" toggle now saves correctly — the handler was using `PUT` with only the changed field, causing a 400; switched to `PATCH`
- Board list (`GET /api/boards/`) now uses a single annotated query for member count, card count, and starred status — previously issued 3 subqueries per board, causing noticeable latency on accounts with many boards (#283)
- Email verification mode is now configurable via the `ACCOUNT_EMAIL_VERIFICATION` environment variable — set to `mandatory` or `optional` to enable; defaults to `none` (no behavior change for existing installs) (#304)
- Due date field now opens the calendar picker on macOS Safari — Safari does not show the native date picker for `opacity: 0` inputs, so the container now explicitly calls `showPicker()` (Safari 16+) or `focus()` (older Safari) on click; Chrome and Firefox continue to open the picker natively via the transparent overlay input (#249)
- Fixed regression in due date field where the calendar only opened on the calendar icon — replaced `showPicker()` approach with a transparent `cursor-pointer` input that receives clicks directly, which works in all browsers (#249)
- `default_board_id` on `PATCH /api/auth/me/` now validates against only the requesting user's boards, preventing IDOR enumeration of foreign board IDs (#256)
- Restrict card drag-and-drop targets to cell zones only — prevents column/swimlane headers resolving as drop targets and sending `swimlane_id=null` to the move endpoint (#272)
- Concurrent column or swimlane creation on the same board no longer causes a database integrity error — requests now serialize correctly via a row-level lock (#281)
- Analytics endpoint now returns a clear 400 error when `days` or `stalled_days` query parameters are non-integer or non-positive, instead of crashing with a 500 (#282)
- Production Docker image now uses Daphne (ASGI) instead of Gunicorn (WSGI) — WebSocket connections were silently failing in all production deployments (#275)
- `docker-compose.prod.yml` now declares a named `mediafiles` volume — uploaded attachments were permanently deleted on every container restart (#274)
- API docs: WIP and weight limit 409 enforcement is now correctly documented — previous docs incorrectly stated limits were informational only (#285)
- API docs: user search query parameter (`?search=`), rate limit (30 req/min), OAuth providers response shape, and change-password request body corrected to match the live API (#286, #279)
- `seed_demo_data` production guard (`DEBUG=False` → `CommandError`) is verified correct and covered by tests

### Security

- Notification preference toggles (`notif_card_assigned`, `notif_card_moved`, `notif_mentioned`, `notif_due_soon`) are now enforced server-side — previously the backend ignored them and sent all notifications regardless of user preference (#273)
- Users with `must_change_password` set are now blocked from all API endpoints until the password is changed — previously only the frontend modal enforced this, leaving the full API accessible (#277)
- Attachment files are now served through an authenticated endpoint with board-membership checks; unauthenticated direct access to `/media/` URLs is no longer possible (#278)
- User search (`GET /api/users/`) now returns only `id`, `username`, `display_name`, and `avatar_url` — email addresses are no longer exposed to other authenticated users (#279)
- Swimlane contact email and notes fields are now restricted to board admin and site admin roles — viewer and member roles no longer receive this data via the REST API or WebSocket events (#280)
- Bumped PyJWT from 2.10.1 to 2.12.0 to fix CVE-2026-32597 (CVSS 7.5 High): PyJWT previously accepted JWS tokens with unrecognized `crit` header extensions instead of rejecting them per RFC 7515; 2.12.0 enforces the spec

---

## [1.0.0-rc.6] — 2026-03-19

### Added

- Documentation: added Hardware requirements section to `docs/getting-started/installation.md` — minimum (2 vCPU / 4 GB RAM / 40 GB SSD), recommended (4 vCPU / 8 GB RAM / 80 GB SSD), and development tiers with a note on the OOM risk at 1 GB and the attachment storage caveat
- Documentation: board role permissions matrix (Admin, Member, Collaborator, Viewer) in `docs/features/permissions.md`, covering all card, collaboration, board-structure, and membership actions; includes a note on the Viewer read-only boundary enforced since 1.0 (#248)
- Board creation modal now fetches templates from a new `GET /api/boards/templates/` endpoint; the template set has been replaced with six purposeful templates (Sales Pipeline, Customer Support, Customer Success, Simple Kanban, Product Roadmap, Project Delivery) plus a Blank Board option — each with the correct columns, a lane label, and a swimlane placeholder; deferred/placeholder templates have been removed (#159)
- Board creation now includes a **First Swimlane** step: after choosing a template the user is prompted for a swimlane name using the template's lane label (e.g. "Account") and placeholder; the field is optional and blank boards skip it gracefully (#159)
- New **Set as my default board** checkbox in the board creation modal; when checked, the newly created board is saved as the user's login destination; a tip is shown to users who have not yet set a default (#159)
- `User.default_board_id` field — users can set a preferred board via `PATCH /api/auth/me/`; after login the frontend redirects directly to that board instead of the board picker (#159)
- `BoardTemplate` database model with a data migration seeding all 7 templates; slug, lane_label, lane_placeholder, columns_json, sort_order, and is_active fields allow future in-app template management without code changes (#159)
- Site admins can now restrict self-registration to invite-only via a toggle in the admin panel; the login page shows a clear message when registration is closed (#173)
- `seed_demo_data` management command generates a realistic "Visiban Demo Board" (5 columns, 10 swimlanes, 87 cards with checklists, comments, movement history, and varied priorities/due dates) for demos and integration testing; supports `--wipe` (board-scoped, refuses on non-debug environments without `--force`) and `--export` to regenerate `scripts/seed/demo_board.json` and `scripts/seed/demo_board.csv`; a GitLab CI scheduled job refreshes the demo environment weekly (#230)
- Boards, columns, swimlanes, labels, and cards now each carry a stable 16-character hex UID (`uid`) that is unique, read-only, and never reused — providing a reliable external reference for integrations and webhooks that remains valid across renames and deletions; card movement history also records the UID of the source and destination column and swimlane (#202)
- Cards can now be archived instead of deleted — archived cards are hidden from the board view and drag-and-drop but can be restored at any time from the new **Archived** panel in the board toolbar; analytics dwell-time uses `archived_at` as the terminal timestamp so only the active period is counted, and archived cards are excluded from stalled-card detection (#226)
- Added `docs/administration/demo-data.md` covering `seed_demo_data` usage, production risks, cleanup procedures, and how imported test data behaves; corrected `docs/features/stable-uids.md` (exports do not include UIDs) and added a "UIDs on import" section explaining that all imported objects receive fresh UIDs regardless of the source file
- Card descriptions now support rich text formatting via a Tiptap-based markdown editor — click to edit with a minimal toolbar (bold, italic, code, lists, heading, blockquote, text color); click **Save** to commit or **Cancel** to discard; descriptions render formatted markdown in view mode and are stored as markdown in the existing plain-text field with no migration required (#239)
- Typing `@username` in the card description editor now shows a member picker; selecting a member inserts the mention and sends that board member a notification — a re-notification guard ensures editing an existing mention does not send duplicate notifications (#228)
- Site admin infrastructure: `IsSiteAdmin` permission class, `GET/PATCH /api/admin/settings/` endpoint, and `SiteSetting.registration_mode` TextChoices field (open / invite_only / closed) replacing the previous boolean toggle; registration adapter uses a 60 s cached DB lookup for performance (#211)
- Site admin user management: `GET /api/admin/users/` (paginated, searchable), `POST /api/admin/users/` (create account with optional force-password-reset), and `PATCH /api/admin/users/{id}/` (toggle active/site_admin/must_change_password) — self-deactivation and last-admin demotion are rejected (#212)
- `/admin` page accessible to site admins: Settings tab with registration mode radio group wired to the API, and Users tab with searchable table, Add User modal, per-row deactivate/reactivate/promote/demote/force-reset actions, and confirm dialogs for destructive actions (#211, #212)
- Superuser bootstrap signal: creating a superuser via `createsuperuser` or management commands automatically sets `is_site_admin=True` so the admin UI is accessible from first login (#211)
- Selecting multiple cards now shows an **Archive** option in the bulk action toolbar — archived cards are removed from the board view and can be restored at any time from the Archived panel
- Site admins now see a **Site Admin** link in the sidebar navigation that opens the admin panel directly — the link is hidden entirely for non-admin users (#246)
- Role picker descriptions updated for accuracy: Collaborator is now clearly described as "can comment and upload files — cannot create or move cards"; Viewer is now "read-only — cannot comment or upload"; these descriptions appear in board settings and the board members panel (#246)
- Group Admin role now shows a contextual tooltip explaining that Group Admin automatically grants board-admin rights on all boards in the group — helping team leads understand the recommended role to assign (#246)

### Changed

- Creating a group or subgroup no longer navigates to the newly created group — the modal stays open so multiple groups can be created back-to-back; close the modal manually when done
- "Close editor on Enter" is now a personal preference in **Settings → Appearance** rather than a per-board setting — each user controls whether pressing Enter in the new-card input submits the card and closes the card panel; the setting defaults to off
- Pressing Escape now navigates back to the referring page: from a board to whatever page you came from, from a group page to whatever you came from; falls back to the semantic parent (board → group → dashboard) when no history entry exists. Within the board the key remains layered — it closes the card detail panel or any open modal first, then clears a multi-card selection, and only navigates when nothing else is open. All modals now consistently close on Escape regardless of where focus is within them.
- Saving profile settings now returns you to the page you were on before opening Settings; opening Settings via a direct link falls back to the dashboard (#241)
- Comment author avatars now each display a distinct color per user, making it easy to tell multiple participants apart at a glance
- Demo board seeded by `seed_demo_data` now includes pre-archived cards so the **Archived** panel shows populated content on a fresh seed, showcasing the card archiving feature without manual setup
- Removed obsolete `version:` attribute from `docker-compose.yml` and `docker-compose.prod.yml`; the field has been ignored since Docker Compose v2 and produced a deprecation warning on every invocation
- Added docstrings to complex, non-obvious backend and frontend logic: `get_board_role()` permission precedence, `CardMovement` denormalized field rationale, `BoardFullSerializer.get_members()` member resolution, `BoardViewSet` import (JSON/CSV) and analytics endpoints, `CardViewSet.update()` field-change tracking, and `useBoardSocket` WebSocket reconnection behaviour
- CI: added `backend-sast` (bandit, medium+ severity) and `frontend-sast` (eslint-plugin-security) jobs to the security stage; both run on MR pipelines and on `main` when relevant files change
- `CLAUDE.md`: added secure coding guidelines covering ORM-only queries, boundary validation, secret generation, IDOR prevention, and `dangerouslySetInnerHTML` restrictions

### Fixed

- Board creation via groups now correctly names the first swimlane from the value entered in the creation modal; previously `swimlane_name` was ignored and the lane was always named "General" (#159)
- `CardViewSet.get_queryset()` now uses `select_related("board", "assignee")` and `prefetch_related("labels", "movements", "attachments", "checklist_items")` — eliminates the 4 extra queries per card that the serializer's attachment count, checklist count, and stale-card checks previously issued
- `WHITENOISE_USE_FINDERS` is now only enabled in `DEBUG` mode; it was previously unconditionally `True`, which caused WhiteNoise to serve un-collected files in production
- Archived cards now show a toast notification on the board with a link to the Archived panel so users can immediately access what they just archived
- CSV import roundtrip: exporting a board and re-importing the CSV now preserves `due_date` values correctly
- CSV import now accepts lowercase and snake_case headers (e.g. `title`, `column`, `swimlane`, `due_date`) in addition to the canonical title-case form — external tools and the seed `demo_board.csv` use these variants and previously triggered a false "missing required headers" error
- The Import Board modal now displays the size limits (500 cards, 50 columns, 100 swimlanes) as an informational notice so users know before they attempt a large import; `docs/features/board.md` updated with a full limits table and a note on splitting oversized boards
- Typing `@username` (with the `@` prefix) in the Board Settings invite search field now returns matching users — previously the leading `@` was passed to the search API verbatim, silently returning no results (#244)
- UI token audit: replaced all remaining `gray-*` Tailwind tokens with `slate-*` equivalents across ImportBoardModal, ForceChangePasswordModal, OnboardingEmptyState, BoardSelector, GroupTree, and SummaryView — `gray` is not part of the design system and produced subtly wrong shades in the dark theme
- LoginPage and Navbar no longer reference undefined `focus:ring-primary` and `text-accent` tokens; all interactive elements now use the documented `focus:ring-blue-500` / `text-blue-400` tokens
- Version badge removed from the Navbar — app version is surfaced exclusively in Settings → About; the badge was appearing in the wrong surface
- ImportBoardModal and ForceChangePasswordModal now include `role="dialog"` and `aria-labelledby` attributes, and all action buttons carry consistent focus rings, bringing both modals in line with the rest of the modal system
- Card descriptions now render with correct light text in view mode — the previous release showed black text on a dark background; color overrides now use explicit arbitrary variant selectors that are reliably detected by the Tailwind JIT scanner
- Text colors applied in the description editor (red, blue, green, etc.) are now correctly saved and restored — the previous release stripped color spans from the serialized markdown output
- Typing in the description editor no longer triggers board keyboard shortcuts such as `f` for filter
- `seed_demo_data` card History tab no longer shows "No activity yet" — every seeded card now gets a "Created in Backlog" movement record; cards further along the pipeline also get backdated stage-transition records with UIDs populated
- `seed_demo_data` now refuses to run (with or without `--wipe`) when `DEBUG` is `False` and `--force` is not passed, preventing accidental demo board creation on production servers
- `ensure_site_admin` now writes the one-time password to `/tmp/visiban_admin_password` with a trailing newline so `cat` output is not run together with the shell prompt (zsh users no longer see a spurious `%` that could be mistaken for part of the password)
- Collapsed columns can now be dragged to reorder — previously the drag listeners were on the full column div alongside the click-to-expand handler, so initiating a drag would immediately re-expand the column after dropping
- First Boot docs now include explicit `cat` and `rm` commands for Kubernetes/Helm, and a tip callout clarifying that the `%` shown by zsh after `cat` is a shell artifact not part of the password
- Local backend development server and management commands (`manage.py`) no longer crash on startup with a URL converter registration conflict when running outside Docker
- WebSocket broadcasts for card creation and card moves now fire only after the database transaction commits, preventing connected clients from receiving stale state if the transaction rolls back (#204)
- Real-time board updates now broadcast for all remaining mutation operations: adding a comment, adding or deleting an attachment, adding, updating, or deleting a checklist item, creating, updating, or deleting a label, adding, updating, or removing a board member, and reordering columns or swimlanes — other users' boards now reflect these changes instantly without a page refresh (#203)
- Card delete and card field-update broadcasts are now also deferred to transaction commit (fixing two previously-bare calls that matched the pattern of #204)
- Navigating to a board URL that no longer exists (e.g. after a database reset or after losing board access) now redirects to the dashboard instead of showing a blank "Failed to load board" error
- **Security [High]**: removed insecure `:-visiban` default fallback from `DB_PASSWORD` in `docker-compose.prod.yml` — Docker Compose now fails loudly if the variable is unset (#218)
- **Security [High]**: Django raises `ImproperlyConfigured` at startup when `DJANGO_SECRET_KEY` is left as `change-me-in-production` or empty in production (`DEBUG=False`) (#218)
- **Security [High]**: added `AdminIPRestrictionMiddleware` to restrict `/admin/` to loopback addresses (or `DJANGO_ADMIN_ALLOWED_IPS`) in production; Nginx config now also blocks external access to `/admin/` at the network layer (#218)
- **Security [High]**: `ensure_site_admin` no longer prints the one-time admin password to stdout (visible in container log aggregators); password is now written to `/tmp/visiban_admin_password` (mode 0600) instead (#218)
- Inserting a swimlane at a specific position no longer produces a duplicate entry when the real-time event arrives before the API response; a failed reorder API call no longer silently drops a newly-created swimlane from the board (#223)
- **Security [Medium] #219** — User search endpoint is now rate-limited to 30 requests/minute per user to prevent account enumeration at high speed
- **Security [Medium] #219** — File attachment uploads now validate both the declared MIME type and the file's magic bytes against an allowlist (images, PDF, Office documents, ZIP, plain text); mismatched or disallowed types are rejected before any bytes reach storage
- **Security [Medium] #219** — Board import endpoints (JSON and CSV) now reject payloads exceeding 500 cards, 50 columns, or 100 swimlanes with HTTP 400
- **Security [Medium] #219** — Visiban now refuses to start with `DEBUG=False` if `CORS_ALLOWED_ORIGINS` contains a `localhost` or `127.0.0.1` origin, preventing a common deployment misconfiguration
- **Security [Medium] #219** — Invite-link redemption is now rate-limited to 10 attempts/hour per IP; all redemption attempts (success and failure) are logged with a truncated token, IP, and outcome
- **Security [Low] #220** — CSV exports now strip leading `=`, `+`, `-`, `@`, tab, and carriage-return characters from all string fields to neutralize spreadsheet formula injection
- **Security [Low] #220** — `Notification` model gains structured `actor` (FK) and `action_type` (choice field) columns; notification links in the frontend use `.textContent` rendering, never `innerHTML`
- **Security [Low] #220** — Group and board permission traversals now emit a `logger.warning()` when the 6-level depth cap is hit, surfacing overly deep trees to operators
- **Security [Low] #220** — Version endpoint (`GET /api/version/`) now requires authentication
- Switching templates in the board creation modal no longer causes layout shifts — the column preview strip stays visible for all templates (Blank Board shows a "No preset columns" note), the swimlane name is preserved when changing templates, and the default-board checkbox hint text no longer shifts surrounding content (#159)
- Blank Board in the board creation modal now appears as a full-width row below a separator line, visually distinct from the named template grid — the previous layout left an orphan cell and the card appeared visually thin without column color dots (#159)
- Creating a new label from the card detail panel no longer shows it twice — the label was being added to the board immediately from the API response and again when the real-time broadcast arrived
- Seed CSV export now uses comma-separated labels (was semicolon) so `demo_board.csv` imports cleanly via the board import flow without triggering a "missing required headers" error
- Seed movement history is now spread across a 30–90 day window (was 1–5 days per stage) so the analytics endpoint shows realistic dwell times, stalled cards, and a meaningful 30-day velocity window on a fresh seed
- Regenerated `scripts/seed/demo_board.json` and `scripts/seed/demo_board.csv` with the corrected label separator and wider movement date spread
- `CardViewSet.get_queryset()` now uses `select_related("board", "assignee")` and `prefetch_related("attachments", "checklist_items")` — eliminates 4–5 N+1 queries per card that the serializer previously issued via `.count()` and `.filter(is_checked=True).count()`; a new `assertNumQueries` test asserts the card list endpoint for a 10-card board completes in ≤ 12 queries (#252)
- `WHITENOISE_USE_FINDERS` is now `DEBUG` rather than hard-coded `True` — prevents WhiteNoise from scanning the source tree with `FINDERS` backend in production builds (#252)
- Single-card archive from the card detail panel and bulk archive from the bulk action toolbar now both show a toast notification: "Card archived — view in Archived panel"; clicking the link in the toast opens the Archived panel directly (#252)
- CSV import `_import_csv` docstring updated to say `Due Date (YYYY-MM-DD)` instead of `DueDate (YYYY-MM-DD)` to match the actual normalized header key (#252)
- CSV import `_HEADER_MAP` now includes a defensive `"due date": "Due Date"` entry handling the key with a space and lowercase, ensuring the roundtrip (export → import) preserves `due_date` without manual header correction; a new roundtrip test exercises this path (#252)
- Viewer role is now strictly read-only: posting comments, uploading/deleting attachments, and adding/patching/deleting checklist items now return 403 for viewer-role members — these write operations require Collaborator role or above (#248)
- Collaborators may delete only their own comments; attempting to delete another user's comment returns 403 (#248)

---

## [1.0.0-rc.5] — 2026-03-15

### Added

- Double-clicking a column header now opens the Edit Column modal (admin only); double-clicking a swimlane label now opens the Edit Swimlane modal (admin only)
- Card priority badge is now always visible for medium priority and above — styled as a colored pill matching the border color; low priority remains unmarked (#196)
- Card labels now show truncated full names (up to 7 characters) instead of 2-character abbreviations, making them readable without hovering (#196)
- Card count badge appears in the top-right corner of any cell containing 2 or more cards — faint and non-intrusive, helps spot dense columns at a glance (#198)
- Overdue card due dates now render in `text-red-400` to match the design token convention (#198)
- Card detail panel now shows a scroll gradient at the bottom of the content area so users can see when more content is below the visible area (#188)
- Checklist and Attachments sections in the card detail panel are now collapsible via a chevron toggle; each section auto-collapses when empty on load (#188)
- Movement history now highlights deleted column names in italic red with a "Deleted —" prefix and a tooltip, so users can distinguish live columns from removed ones in a card's move history (#139)
- Swimlane label sidebar is now resizable by dragging its right edge; minimum width is ~56 px (≈4 characters) and maximum is 400 px; width is persisted per-board in localStorage
- Column names can now be renamed inline: click the name to edit, Enter to confirm, Escape to cancel; the ✎ icon still opens the full column settings modal
- Swimlane names can now be renamed inline: click the name to edit, Enter to confirm, Escape to cancel; the ✎ icon still opens the full swimlane settings modal
- Column and row separators redesigned as unified interactive handles: two parallel lines with a "+" that appears on hover; clicking inserts a column or swimlane inline; dragging a column separator left/right resizes the column to its left
- The far-left separator (between the swimlane label column and the first board column) follows the same design and resizes the label column on drag
- Board columns are now individually resizable by dragging the right edge separator; width is persisted per-column per-board in localStorage; cards reflow automatically as column width changes and row height adjusts to the tallest cell
- Swimlane row height is now resizable: drag the bottom edge of any swimlane row to set a minimum height; height is persisted per-swimlane per-board in localStorage
- Double-clicking an empty area in a cell now opens the inline new-card form (same as right-click and the "+ Add card" button)
- Collapsed column cells now pulse with a blue highlight and show the filter match count when a search or filter is active and matching cards are hidden inside — so results are visible without expanding every column
- Empty board cells (no cards, not adding) now show a dashed border to visually communicate the drop zone; `+ Add card` button uses a lighter style in empty cells vs. non-empty cells (#200)

### Changed

- Replaced all `gray-*` Tailwind tokens with `slate-*` equivalents across Dashboard, Settings, BoardView, SwimlaneRow, BoardCell, and BulkActionToolbar to eliminate the warm/cool color mismatch on adjacent surfaces (#184, #158)
- All card color tokens migrated from `gray-*` to `slate-*` for consistency with the rest of the dark theme (#196)
- Filter active-count badge changed from light-mode `bg-blue-100 text-blue-700` to dark-theme `bg-blue-500/20 text-blue-400` (#184)
- Filters toolbar button now uses `text-slate-300 hover:text-white` instead of `text-blue-600 hover:text-blue-800` (#184)
- Column header shows a red bottom border accent (`border-b-2 border-b-red-500/50`) when the WIP limit is exceeded, making violations visible without reading the stats row (#198)
- Collapsed columns now show a unique 3-character abbreviation (e.g. BAC, TOD, DOI) instead of the full rotated name; duplicates are suffixed with a digit (#195)
- Columns now default to collapsed (compact) on every board; an Expand / Collapse button in the toolbar expands or collapses all columns at once, and individual columns can still be toggled by clicking; expanded state is persisted per-board in localStorage
- Star/unstar button moved from the board toolbar to the breadcrumb in the Navbar, immediately after the board name — star is now always visible regardless of which view (Board/Summary/Analytics) is active
- Board toolbar now has a small top margin so it breathes away from the Navbar
- Column separator "+" indicator simplified to a single centered sign (matching the row separator style) — three stacked signs were visually noisy in the narrow 16 px column
- Column and row separators redesigned to single hairline (from double-line): barely visible at rest, highlights blue on hover — cleaner in dense kanban layouts
- Clicking a column separator now opens the Add Column modal (same flow as swimlane separators) rather than an inline input; drag still resizes the column to the left
- Row separator now shows a "+" at each column's center X when hovered, mirroring how column separators show "+" at each swimlane row — the insert affordance is now symmetric in both axes
- Collapsed swimlane rows are now compact: each cell renders as a narrow `w-10` box showing only the card count (no "N hidden" text), the label panel shrinks to a single line, and the stored row min-height is suppressed so the row collapses to its natural minimum
- Swimlane label panel left border increased from 3 px to 4 px (`border-l-4`) for a stronger color identity signal (#197)
- Swimlane name font weight increased from `font-semibold` to `font-bold` so lanes read as navigation landmarks (#197)
- Swimlane collapse chevron increased from 3.5 to 4 px icon to improve interactivity affordance (#197)
- Swimlane drag handle is now hidden at rest and visible on row hover (`opacity-0 → opacity-100`) — reduces visual noise without hiding the reorder affordance (#197)
- Swimlane label panel now renders the swimlane color as a 3 px left border instead of a narrow interior stripe, making color identity visible at a glance (#190)
- Swimlane collapse/expand control replaced text arrows (`▶`/`▼`) with an SVG chevron that rotates on state change (#190)
- Swimlane edit button (✎) is now dimly visible at rest (`opacity-30`) and fully visible on row hover, instead of fully hidden until hover (#190)
- Board sub-nav toolbar restructured to a fixed `h-10` row so it no longer compresses when filters are open; FilterBar moved to its own collapsible row below the toolbar (#187, #199)
- Live connection indicator dot now pulses (`animate-pulse`) when connected and uses `bg-green-400` (#199)
- Column WIP and Weight stats are now shown conditionally: WIP row only appears when a WIP limit is set; Weight row only appears when total weight is non-zero (#187)
- Docker Compose stacks (`docker-compose.yml` and `docker-compose.prod.yml`) now use `postgres:17-alpine`, matching the Kubernetes/Helm deployment; previously Docker Compose used Postgres 16 while Helm used Postgres 17
- Frontend UI conventions moved from the root `CLAUDE.md` into `frontend/CLAUDE.md` alongside the code they govern
- `docs-deploy` CI job no longer fires automatically on version tag pushes — docs are deployed by `scripts/release.sh` directly via `mike deploy`; the CI job is retained as a manual recovery tool only

### Fixed

- Creating a new column or swimlane after a deletion no longer raises `IntegrityError` on the `(board_id, position)` unique constraint; position is now derived from `MAX(position) + 1` rather than `count()`, which produces incorrect values when positions have gaps
- Card movement history now correctly shows deleted column names in italic red even after the column has been deleted; previously the name disappeared because it was derived from the live FK at serialization time — names are now stored as denormalized fields on `CardMovement` at write time (#139)
- Sidebar "New board" and "New group" footer links now open their respective creation modals directly instead of navigating to the Dashboard (#185)
- Invalid or expired invite link page now auto-redirects to the dashboard after a 5-second countdown instead of requiring a manual button click (#172)
- Version badge in Navbar is now hidden for all versioned builds (stable and pre-release); only shown when `APP_VERSION` is `dev` (#192)
- Invite link URLs in Group Settings are now truncated in the display field with the full URL available on hover; copy behaviour is unchanged (#193)
- Swimlane rows can now be reordered by dragging; `closestCenter` was resolving to cell droppables (which cover more area than the swimlane sidebar) and the drop was silently discarded — the cell ID is now mapped back to its swimlane before the sort index lookup, matching the existing fix for column reordering (#195)
- Cell drop-target highlight no longer activates when dragging a swimlane or column (#195)
- Newly created columns are now automatically expanded (no longer start collapsed); boards with no stored view preferences (e.g. freshly created boards) also start with all columns expanded
- Header row z-index raised so swimlane rows scroll behind it correctly when the board is scrolled vertically
- Trailing separator added to SwimlaneRow so the last column aligns correctly with the header in collapsed board view
- `release.sh` now calls `mike set-default --push next` for pre-releases so docs.visiban.com has a root redirect and doesn't 404
- Broken doc anchor links corrected: `board.md#export--import` → `#export-import`, `deployment.md#kubernetes--helm` → `#kubernetes-helm`, `first-boot.md#kubernetes--helm` → `#kubernetes-helm`
- `features/navigation.md` (sidebar navigation docs) added to the mkdocs.yml nav so it appears in the docs site
- Escape key to close the profile/user-settings dialog was already implemented — issue #144 closed as resolved

---

## [1.0.0-rc.4] — 2026-03-14

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

## [1.0.0-rc.3] — 2026-03-13

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

## [1.0.0-rc.2] — 2026-03-10

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

## [1.0.0-rc.1] — 2026-03-08

### Added

- Column trash zone: dragging a column to the right edge reveals a red "Delete" drop target; dropping shows a confirmation dialog with the card count before deleting (closes #23)
- Self-hosting docs: backup/restore guide and upgrade instructions for production deployments (closes #67)

### Fixed

- Updated all GitLab URLs from `kellyhair/visiban` to `visiban/visiban` after group migration (README, CONTRIBUTING, installation docs)
- Added `SITE_DOMAIN` to `.env.example` with documentation comment (was referenced in docs but missing from the example file)

---

## [0.3.0-beta.1] — 2026-03-08

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

## [0.2.0-beta.1] — 2026-03-07

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
- Updated `docs/features/realtime.md` to document column and swimlane event types added in 0.1.0-beta.1

---

## [0.1.0-beta.1] — 2026-03-07

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

## [0.2.0-alpha.1] — 2026-03-06

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

## [0.1.0-alpha.1] — 2026-03-04

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
