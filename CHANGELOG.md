# Changelog

All notable changes to Visiban are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [1.1.0] — 2026-06-06

---

## [1.1.0-rc.3] — 2026-06-06

---


### Changed
- The group WebSocket channel's membership events were renamed from `membership.added` / `membership.updated` to `member.added` / `member.updated`, mirroring the board channel's `member.*` events so a single client socket layer handles both. This aligns the new-in-1.1 group real-time contract before it freezes at GA.
- Docker Compose host ports are now overridable via `.env` (`DB_PORT`, `BACKEND_PORT`, `FRONTEND_PORT`, `KEYCLOAK_PORT`, `REDIS_PORT`) and the project name via `COMPOSE_PROJECT_NAME`, so a second Visiban checkout (or another project sharing the same default ports) can run side-by-side on one host without colliding. Vite's HMR client port follows `FRONTEND_PORT` automatically when the host port is remapped, and the browser-facing backend URL is now configurable via `VITE_API_URL` so the frontend on the secondary stack can call the remapped backend.

### Fixed
- The Helm chart now deploys cleanly against v1.1: the OIDC env var name mismatch that silently broke OIDC SSO is corrected, the SMTP/email block is wired, the admin IP allowlist is exposed via `backend.settings.adminAllowedIPs`, and `secret.djangoSecretKey` rotations now take effect in the same `helm upgrade` invocation (a hook-managed bootstrap Secret lands before the migrate Job runs)
- The frontend pod no longer mounts the media PVC, so a default `ReadWriteOnce` storage class works in HA — Django streams attachment downloads via FileResponse when `USE_X_ACCEL_REDIRECT=false` (the new chart default)
- Render-time validation in the chart now fails fast with a friendly message when `secret.djangoSecretKey`, `backend.email.fromAddress`, `backend.settings.allowedHosts`, or `postgresql.auth.password` are still placeholders, instead of a hung migrate Job 90 seconds into the deploy
- Chart bumped to `0.2.0` / appVersion `1.1.0`
- Design-system compliance pass on the 1.1 UI: panel corners use `rounded-lg` instead of `rounded-xl` (error boundary, bulk-action toolbar, role-info tooltip), the "Sign out" menu item and card confirm/cancel buttons now carry a keyboard focus ring, admin danger buttons include `font-medium`, the selected export-format radio uses the theme-tracking `bg-primary-emphasis/10` fill, and inline-edit input borders use `border-primary-soft` so they track the active theme.
- Operators who still set the pre-1.1 environment aliases `OIDC_SECRET` or `ACCOUNT_EMAIL_VERIFICATION` now receive a deprecation warning at startup pointing them to the canonical names (`OIDC_CLIENT_SECRET`, `EMAIL_VERIFICATION`). Previously the warning helper existed but was never wired into settings load, so an unrenamed `OIDC_SECRET` silently deactivated SSO with no diagnostic.
- Group detail now updates in real time when a subgroup is created or deleted, a member joins or changes role, or a shared label is created, edited, or deleted — previously these required a page reload. Board deletions are now evicted by the canonical `board_uid`, so an outright delete (whose event payload is uid-only) removes the row live.
- Fixed low-contrast text on the card-delete and board-delete confirmation buttons (now `text-on-danger` instead of `text-fg`), and switched the admin add-user, column-edit, and activity-filter checkboxes from a hard-coded blue to the `accent-primary` token so they track the active theme in dark mode.
- The card checklist endpoint (`GET /api/boards/{id}/cards/{id}/checklist/`) no longer issues one extra query per checklist item to resolve each item's creator — the prefetch now carries `select_related("created_by")`, so the query count stays constant regardless of checklist length
- The unread-notification badge count (`GET /api/notifications/unread-count/`) is now capped at 50 to match the notification dropdown, so a large unread backlog no longer loads every unread row into memory and resolves board access per row on each poll
- Card creation now locks the target column row before computing the new card's position, so two simultaneous creates in the same column and swimlane can no longer be assigned the same position
- Restoring (unarchiving) a card no longer re-fetches and re-serializes the card a second time — the response reuses the data built while the restore is committed, cutting roughly five redundant queries per call
- Removing a member from a group now updates the members list in real time for other admins viewing the group page, instead of going stale until a manual reload
- Revoking a group invite link now updates the invite-links panel in real time for other admins, instead of continuing to show the link as active until a reload
- Keyboard focus rings now appear reliably on filter chips, the saved-filters and activity-filter dropdown triggers, and movement-history rows in Firefox and Safari, where they were previously skipped after a click
- Added missing keyboard focus rings to several icon and text buttons across the board members modal, group invite-links panel, and group detail page (including the delete-group dialog's Cancel button)
- Primary and danger buttons in the saved-filter save, card move, and column/swimlane delete controls now use the standard medium font weight for visual consistency
- Fixed flaky `backend-test-coverage` CI job failing with "No source for code" when the parallel test shards and the coverage combine step landed on runners with different build roots. A `[coverage:paths]` mapping now reconciles the shard data files against the combine runner's checkout.
- Fixed flaky `backend-test-coverage` CI job that failed with "No source for code" when the coverage-combine runner used a different build root than the test shards. Coverage data is now stored with relative file paths (`relative_files` in `.coveragerc`), making the combined data portable across runners. The earlier `[coverage:paths]` mapping in `setup.cfg` was inert because coverage.py reads `.coveragerc` and ignores `setup.cfg` when both exist.
- Focus is now correctly restored to the first remaining board on the group page when a board is removed by a live `board.deleted` event, instead of being stranded on `<body>` (#753)
- All sub-12px text in CardDetail (section labels, breadcrumb buttons, error messages, comment timestamps) and the ColumnHeader collapsed warning glyph now meet the 12px minimum for readability
- Focus rings on checklist delete, attachment delete, breadcrumb close, and comment confirm/cancel buttons corrected from `ring-1` to the required `ring-2`; "Bulk" and "Clear due date" buttons now show a visible focus ring; UserMenu items gain a compliant focus ring
- BoardView `ColumnTrashZone` now has an accessible `aria-label`; the no-match filter banner now carries `role="status"` for screen-reader announcements
- `CheckboxDropdown` ARIA attribute corrected from `aria-haspopup="true"` to `aria-haspopup="menu"` per ARIA 1.2
- CardDetail close button and bulk-add checklist dialog border radii aligned to the design-system token scale; bulk-add dialog gains a `border border-line` outline
- `CardChecklistSerializer` now exposes `created_by` on each checklist item and the underlying queryset is prefetched accordingly; the matching TypeScript interface is updated
- Checklist item delete affordance in CardDetail is now hidden from users who lack delete permission, matching the server-side ownership gate
- WebSocket `GroupDetail` handler now processes `group.star_changed` events so group star state stays in sync across open sessions
- Re-seeding demo boards after 2026-04-01 no longer produces an entirely past-dated set of card due dates — due dates are now anchored to today so upcoming and overdue cards appear correctly after any re-seed; the fixed anchor is preserved only for `--export` runs to keep committed sample-board snapshots git-stable

### Security
- Patched three high-severity frontend dependency advisories found in the 1.1 pre-release audit: `axios` 1.15.0 → 1.17.0 (prototype-pollution MitM/SSRF, credential leak, ReDoS), `react-router-dom` 7.13.x → 7.17.0 (turbo-stream deserialization RCE, XSS, DoS), and `vitest` / `@vitest/coverage-v8` 3.2 → 4.1 (arbitrary file read/execute when the Vitest UI server is running). Transitive `brace-expansion` and `ws` advisories were also resolved. `npm audit` now reports zero vulnerabilities.
- Hardened the card assignee field to fail closed: the assignee queryset now defaults to empty and is only widened to a board's assignable members when the board context is present, so a future code path that forgets to scope it can no longer expose all users as assignment candidates
- The authenticated media endpoint now applies the same `MEDIA_ROOT` containment check on the Nginx `X-Accel-Redirect` delivery path that the direct-streaming path already enforced, preventing a stored attachment path from escaping the media root
- The card, column, swimlane, and label viewsets now declare their authentication and permission chain explicitly (matching the board viewset), so an accidental change to the global default cannot silently drop the auth gate from these endpoints
- Patched backend dependency CVEs flagged by the `dep-scan-osv` job: bumped PyJWT 2.12.1 → 2.13.0 (PYSEC-2026-175/177/178/179) and added an explicit idna 3.18 pin to clear GHSA-65pc-fj4g-8rjx in the transitive dependency pulled via requests.
- Bumped Django minimum version to 5.2.15 to pull in the Django security release patching five advisories (PYSEC-2026-197 through -201): cache-poisoning via Vary/Cache-Control header handling in UpdateCacheMiddleware, a signed-cookie salt collision, and SMTP STARTTLS cleartext connection reuse.
## [1.1.0-rc.2] — 2026-05-03

---


### Added
- Added a "Focus ring consistency" section to `frontend/CLAUDE.md` documenting the `focus:` vs `focus-visible:` rule and the gate to grep before any interactive-element PR.
- `/api/v1/notifications/` now returns each notification with a slim `actor` user object (id, username, display_name, avatar_url) so clients can render avatars and group notifications by author without re-parsing the human-readable verb.
- `GroupInviteLinkSerializer` now exposes `created_by_username` so group admins can audit who created an invite link, matching the existing `AdminInviteLink.created_by_username` field.
- Added a WebSocket URL extension point to `visiban/asgi.py` mirroring the HTTP URL hook in `visiban/urls.py`. The enterprise package can register additional consumers by exposing `enterprise.routing.enterprise_websocket_urlpatterns`; OSS deployments are unaffected.
- Added a Command palette section to `docs/features/index.md` documenting the ⌘K behaviour across board, dashboard, group, settings, and admin surfaces.
- Added the `actor` field to all `Notification` mock fixtures, plus a stale-card (null actor) test case. `BoardSettingsModal` export-history rendering now has component-level coverage for entries with a known actor, the `(deactivated user)` fallback, and the failed-fetch error message.
- Add `CARD_MUTATION_HOOKS` extension point to `boards/hooks.py`; wire call sites in `CardViewSet` (create, update, move, delete, archive, restore) so enterprise audit-log integrations have a stable OSS hook.
- Added 1.1 upgrade-guide note covering pre-1.0 → 1.1 direct upgrades that need the `groups/0003_placeholder` reconciliation step before `migrate`, and an explicit irreversibility warning for `boards/0050` (`BoardExportLog` audit table — rollback drops audit rows).
- Added query-count scale tests for `GET /api/v1/boards/{id}/cards/archived/` and `GET /api/v1/notifications/` to catch future N+1 regressions on those endpoints.

### Changed
- Added `BoardRole` and `BoardOrSiteRole` type aliases in `frontend/src/types/index.ts` and replaced inline literal unions across `Board.role`, `BoardFull.current_user_role`, `Group.default_board_member_role`, `BoardMembership.role`, and `GroupInviteLink.role` so the four-role and five-role variants stay in lockstep.
- Synced `docs/api/websockets.md` to the current event surface — `board.deleted` payload, `group.updated` shape, the missing `board.star_changed` board-channel entry, and the eight group-channel events introduced by the 1.1 group-broadcast work.
- Updated `docs/api/notifications.md` (added the `actor` field) and `docs/api/groups.md` (added `created_by_username`, `single_use`, `used_at`, `status` to invite-link example and table) to match the 1.1 serializer shape.
- Updated `docs/features/board.md` to describe the 1.1 column over-limit visual (2 px top accent strip + single calm stat line) instead of the pre-1.1 `WIP N/M` red-text behaviour.
- Cards now scan to the *one thing* you're looking for: a new per-board **Card density** setting (Comfortable / Standard / Dense) replaces the previous wall of icons. New boards land on **Comfortable** — one worst-offender urgency badge (Overdue · Due soon · Stale · Just moved), one primary label, checklist, assignee — with weight, attachments, and last-moved time moved to the hover peek. Existing boards keep their pre-1.1 visual via the **Dense** tier; admins flip in Board Settings → Display. New endpoint field `card_density` on the Board API.
- The previous per-user per-field hide toggles (Labels / Due date / Assignee / Priority badge / Last moved) are removed. Density is now the single layout knob; localStorage values for the old keys are silently ignored.
- Empty board cells now read as a discoverable click target — a dashed inset border with **+ Add card** centered, hover wash, and keyboard activation: Tab into an empty cell and press Enter (or Space) to open the new-card input. The dashed treatment disappears the moment a card lives there, so populated cells keep the dense info-rich layout.
- Column headers now show a 2px top accent strip (red for over WIP, amber for over weight) so over-limit columns scan from the corner of the eye, and surface only the worst-offender stat line — calm columns simply read "N cards" without the redundant "WIP" / "Weight" label words.
- Column drag-to-trash is now opt-in: the destructive drop zone only appears when the user holds **⌥ (Alt)** during a column drag, and a `⌥ to delete` hint surfaces on the drag overlay so the gated gesture stays discoverable. A new column kebab menu (`⋮`) on every column header gives keyboard users a first-class path to Rename, Edit settings, and Delete; deleting a column with cards now requires typing the column name to confirm, matching the board-deletion pattern.
- On laptop-sized viewports below 1024 px — where Layout, Archived, Activity drawer, and Settings fold into the `⋮` overflow kebab — the kebab menu now auto-expands once on the first visit so occasional users discover the folded controls without having to read documentation. The static first-encounter dot remains as a quieter reminder for subsequent visits and is dismissed the first time the kebab is clicked.
- `board.deleted` WebSocket payload no longer carries the legacy `board_id` field; clients should key on `board_uid` like every other deletion event. The change ships before 1.1 tag so no released client depended on the old shape.
- Renamed the `BoardExportLog` audit-row API field from `role_at_export` to `actor_role_label`. The DB column name is unchanged. The new name disambiguates the 6-value audit string (which includes `owner` and `site_admin`) from `Board.export_min_role`'s 4-value setting enum.
- The deprecated snake_case `PATCH /set_collapsed/` swimlane route now responds with `Deprecation: true` and a `Link: <kebab-url>; rel="successor-version"` header (RFC 8594 / RFC 8288). The canonical kebab-case `set-collapsed` route is unchanged.
- `notify_on_card_moved` resolves the mover username via a targeted `User.objects.only("username")` lookup using `instance.moved_by_id`, eliminating one lazy FK query per card-move notification path. Finishes the perf-fix scope of !... that originally landed under issue #938.
- Members POST/PATCH endpoint threads the resolved role and board into `BoardMembershipSerializer` context so `to_representation` does not re-issue `get_board_role` to decide whether to strip `is_moderator`.
- Group `transfer_ownership` and `board_defaults` actions re-fetch the group through `get_queryset()` before serializing, so `_member_count` / `_board_count` / `_subgroup_count` / `_is_starred` annotations are populated and the serializer method fields don't fall through to live count subqueries (8 avoidable queries per transfer, 4 per board-defaults patch).
- Board JSON export prefetches `columns` and `swimlanes` once before iterating, removing two redundant ORDER BY queries per export. The `Meta.ordering` declarations on both models supply position order without a query-bypassing `.order_by()`.
- Checklist add endpoint computes the next position via `len(card.checklist_items.all())` instead of `.count()`, reading from the prefetch cache the action already paid for instead of issuing an extra `COUNT(*)`.
- Group write paths now broadcast on the group channel: `update_member` PATCH, group create/update/destroy, `board_defaults`, group label CRUD, star/unstar, and `JoinGroupView.post` (new-member arrival). GroupDetail and sidebar trees stay live without requiring a manual refresh.
- `card.unarchived` broadcast now serializes inside the atomic block and registers the on_commit lambda with a plain dict, matching every other broadcast site in the codebase. The previous closure carried an ORM `Board` instance that ran serializer logic post-commit.

### Fixed
- Replaced sub-12px text sizes with the design-system minimum (`text-xs`) in the navbar notification dropdown, board settings modal section headers and share URL, board view corner stats and Analytics "Beta" badge, filter bar `/` shortcut hint, swimlane column-insert affordance, and the `xs` Avatar variant.
- Added focus rings to `BoardSettingsModal` tab buttons and the inline confirm/cancel buttons in the member-removal and hard-WIP confirmation rows.
- Token-drift sweep: filter active-count badge uses `bg-primary-emphasis/20` (the canonical filter-active token), the "card not found" banner uses the standard amber tint (`bg-warning/10` + `border-warning/30`), the swimlane name hover uses `hover:text-fg` instead of the active-state-only `text-info`, and `CheckboxDropdown` uses `accent-primary` instead of the raw `accent-blue-600`.
- Archive-toast "View archived" link and dismiss button now carry the standard focus ring and `rounded`. The dismiss button also gained `aria-label="Dismiss notification"` so screen readers announce its purpose.
- `DELETE /api/v1/boards/<pk>/share/` now returns `{share_token: null, share_url: null, share_token_expires_at: null}` so the response shape matches the POST response. The TS `ShareActionResponse` interface is updated to nullable everywhere.
- Fix N+1 in notification endpoints: pre-load group ancestor chain so `_filter_to_accessible_boards` does not issue per-level FK queries on every page load.
- Fix card update action serializing from a partially-prefetched in-memory instance; now uses `_refetch_card_data` consistent with all other mutation actions, eliminating 3 extra queries per PATCH.
- Fix 8 accessibility and design-system blockers in 1.1 UI: OnboardingTour backdrop token and dialog semantics, missing focus rings on star/cancel buttons, BoardView sub-view nav landmark, ShareBoardPage sub-12px text, and focus-visible regression in BulkActionToolbar.
- Add missing `has_completed_tour` field to `AdminUser` TypeScript interface to match `AdminUserSerializer` response.
- Bump `SPECTACULAR_SETTINGS["VERSION"]` to `1.1.0` so the OpenAPI schema correctly advertises the 1.1 release.
- Fix WebSocket documentation: remove phantom plural reorder event aliases, add `board.created` to the board-channel event table, and correct `_id` key references to `_uid` throughout `realtime.md` and `websockets.md`.
- Correct `.env.example` comments for `ACCOUNT_EMAIL_VERIFICATION` and `OIDC_SECRET` to reflect that both aliases were removed in 1.1.
- Fix board import permission docs (any group member may import, not admin-only) and board create `group` field documentation.
- Fix `DELETE /api/v1/boards/{id}/share/` response example to include `share_url: null`.
- Document `GET /api/v1/version/` endpoint in `docs/api/version.md` and add it to the nav.
- Fix attachment `url` field description — the API returns an absolute URL, not a relative URL.
- Document group members endpoint `is_inherited`, `inherited_from` fields and nullable `id` in `docs/api/groups.md`.
- Fix real-time docs: replace stale pulsing-dot `LiveIndicator` description with accurate `ConnectionStatus` component description.
- Document group WebSocket channel (`ws/groups/<id>/`) in `docs/features/realtime.md`.
- Fix checklist delete permission matrix — collaborators can only delete items they created (enforced since 1.1).
- Fix stale "Board Settings → Card fields" reference in feature docs — replaced by Card density setting.
- Board selector now shows an error message with a "Try again" retry button when the board list fails to load (#914). The delete-board dialog now has correct ARIA semantics (`role="dialog"`, `aria-modal`, `aria-labelledby`) and closes on Escape (#915).
- Board import now validates `due_date`, `weight`, `position`, `wip_limit`, and `weight_limit` fields before entering the database transaction, returning a descriptive 400 instead of an unhandled 500 on malformed values (#916). Duplicate column, swimlane, or label names in the import payload are rejected with a 400 before reaching `bulk_create` (#917). Cards that reference a column or swimlane name not defined in the payload are now rejected with a 400 rather than being silently dropped, preventing hidden data loss on import (#918).
- `GET /api/boards/?expand=group` no longer triggers extra database queries for boards nested more than one group level deep; ancestor data is now loaded in a single query regardless of nesting depth (#919)
- Wave 4 pre-release audit fixes for 1.1: hide `is_moderator` from non-admin viewers in the board members payload (#920); reject malformed JSON imports where `cards`/`columns`/`swimlanes`/`labels` are not lists (#921); log a warning on attachment MIME rejections so probes can be distinguished from user errors during incident review (#923); add a dedicated `login` throttle scope (20/hour, IP-keyed) on top of the allauth gate (#924); per-email dedup on multi-use invite link redemption via the new `InviteLinkRedemption` table (#925); annotate `is_stale` at the SQL level on the public share-link card payload (#926); cache the full `GroupMembership` list on `BoardFullSerializer` so `get_members()` no longer issues a duplicate query (#927); add a `slim=True` mode to `get_board_for_user()` and use it for the summary and analytics endpoints (#928); merge the archived-cards count into the page query via a `Window(Count("id"))` annotation (#929); add a query-count regression test on the card axis for the analytics endpoint (#930); fan out `board.star_changed` to the group channel so GroupDetail updates without a refetch (#952).
- Sidebar navigation links, chevron toggles, and group-name buttons now show a visible keyboard focus ring, making keyboard navigation accessible (#931)
- "Skip tour" buttons in the onboarding tour now show a visible keyboard focus ring (#932)
- Keyboard focus rings are now consistent across the Navbar, UserMenu, and ConnectionStatus components; all interactive elements use the `focus:ring-2` style as required by the design system (#933)
- The "Keyboard shortcuts" item in the user menu now works correctly with keyboard-only navigation; roving focus no longer skips or traps on this item (#934)
- The active view tab (Board, Summary, History, Analytics) now displays with the correct weight and size as specified by the design system (#935)
- The ConnectionStatus badge correctly shows rounded corners in all degraded states (connecting, reconnecting, stale, and failed) (#936)
- Creating or deleting a saved filter preset now immediately updates the filter list in any other open tabs without requiring a page reload (#937)
- Fixed 4–5 extra database queries fired per card move by the `notify_on_card_moved` signal; the handler now re-fetches the card with `select_related` and uses the denormalized `to_column_name` field instead of lazy FK traversals (#938)
- Tightened the `set-collapsed` swimlane action to admin-only; the Member role could previously persist a board-structure field that changes the default view for all board members (#939)
- Added rate limiting (20/hour) to the board export endpoint to prevent programmatic hammering of a high-cost endpoint (#942)
- Scoped the `saved_filter.created` WebSocket broadcast to `{filter_id, user_id}` only; the previous payload included the full `state_json` contents, which were broadcast to all board members unnecessarily (#943)
- Added guard comments to `BoardSerializer`, `BoardFullSerializer`, and `GroupSerializer` fallback paths that issue live queries when called without the expected queryset annotations (#940, #941)
- Drop deprecated plural reorder event names (`columns.reordered`, `swimlanes.reordered`); only the canonical singular forms (`column.reordered`, `swimlane.reordered`) are now emitted (#944)
- Fix `board.star_changed` WebSocket payload to use `uid` instead of integer `board_id` for consistency with all other board events (#945)
- Normalize `group.updated` WebSocket payload to full `GroupSerializer` shape on ownership transfer (#946)
- Fix raw Tailwind color `border-b-red-500/50` on over-WIP column border; now uses semantic `border-b-danger-emphasis/50` token (#947)
- Wrap `saved_filter` POST/DELETE and swimlane collapse mutations in `transaction.atomic()` so `on_commit` broadcasts are correctly deferred (#948)
- Design system compliance sweep: replace `focus-visible:` with `focus:` on ColumnHeader, SelectDropdown, Toggle, FilterBar; replace `bg-white` on Toggle thumb with semantic `bg-fg`; fix `rounded-xl` → `rounded-lg` on invite suggestion dropdown; fix invite status message layout shift; replace `accent-blue-500` with `accent-primary` on Display tab checkboxes; add `type="button"` to notification bell; fix notification panel border to `border-line-strong` (#949)
- Widen `BoardFull.capabilities` TypeScript interface to allow unknown boolean capability flags without compile errors (#953)
- Wave 3 pre-release audit fixes for 1.1: bump vitest minimum to 3.2.0 to close CVE-2025-24964 floor (#954); add missing unit tests for auth API helpers, useNavbarSearchLabel, useShortcutsSeenPref, CollapsedFlyout, and RoleInfoTooltip (#955); correct API permission docs for board import, swimlane set-collapsed, and card ownership/moderator gates (#956); document undocumented 1.1 features — inline board rename, card peek, URL filter state, groups live board list, board.star_changed WS event, 5-state ConnectionStatus, board.deleted board_uid, expand=group, schema_version 2 (#957); update extension points table to mark MOVEMENT_EXPORT_BACKENDS and ANALYTICS_EXTENSIONS as implemented (#958); document must_change_password and must_change_username 403 codes in authentication API common errors (#959); fix stale test fixtures for group.updated event shape and star broadcast uid assertion (#960).
- Notification button in the navbar now exposes the unread count via `aria-label` and renders the count badge at the design-system minimum text size, so screen-reader users discover unread notifications and the badge stays legible.
- Swimlane edit affordance is now hidden from non-admins entirely instead of rendered as a disabled button, removing a dead keyboard-focusable element.
- Restored the focus ring on `SingleSelectDropdown`, `CheckboxDropdown`, and the FilterBar "Clear all" button — they were using `focus-visible:` which renders no indicator in Firefox and Safari for pointer-driven focus.
- `manage.py benchmark` `_bench_full` no longer crashes with `AttributeError: 'WSGIRequest' object has no attribute 'query_params'`. The benchmark drives the endpoint through `APIClient` instead of constructing a raw `WSGIRequest` and invoking the serializer directly.
- Fix double-deploy race and missing MAJOR.MINOR alias for docs.visiban.com on release tags — CI `docs-deploy` job is now the sole owner of mike deploys; `release.sh` no longer calls mike directly.

### Security
- Strip `is_moderator` from `member.added` / `member.updated` WebSocket broadcasts when the subscriber is below admin role. The REST surface already filtered the field per #920; the broadcast surface now matches at the consumer layer.
- Notification list and unread-count endpoints filter out entries referencing boards the recipient no longer has access to. Previously, leaving a board kept stale notifications visible — including the board name and card title — until the user marked them read.
- Added a per-token rate limit on the public board share endpoint (`240/hour` in production) on top of the existing per-IP cap, bounding abusive traffic against any single token regardless of source IP.
- `BoardViewSet` and `GroupViewSet` now declare `permission_classes` explicitly instead of relying on the global default chain by inheritance, so future per-action overrides cannot silently drop the `MustNotHavePendingPasswordChange` / `MustNotHavePendingUsernameChange` gates.
- `UnsupportedVersionView` (the catch-all that returns 406 for `/api/vN/` where N != 1) now requires authentication. Previously the view bypassed DRF's permission flow by overriding `dispatch`; refactored to use proper handlers so authentication is enforced consistently.
## [1.1.0-rc.1] — 2026-04-24

---


### Added
- Theming: added full Light theme support. Every frontend component has been migrated from raw slate utility classes to the semantic token layer (`bg-canvas`, `bg-surface`, `bg-sunken`, `bg-surface-hover`, `bg-surface-active`, `border-line`, `border-line-subtle`, `border-line-strong`, `border-line-emphasis`, `text-fg`, `text-fg-secondary`, `text-fg-tertiary`, `text-fg-muted`, `text-fg-faint`) plus themed semantic colours (`text-danger`, `text-warning`, `text-success`, `text-info`). Light-mode shades for the semantic colours pass WCAG AA on a white background. The **Light** option is now enabled by default in the profile Appearance picker; operators can hide it with `VITE_THEME_LIGHT_ENABLED=false` if needed. The **System** option follows the OS `prefers-color-scheme` signal live (tested on macOS System Settings → Appearance). Closes #183.
- Added keyboard shortcut overlay (`?` key) listing all board shortcuts, with a nav bar hint and first-encounter indicator on the keyboard icon button.
- The dashboard now shows a Favorite Boards section above My Boards, listing every board you have starred in alphabetical order (hidden when you have no favorites). Opening the command palette (⌘K / Ctrl+K) with no query now leads with your Favorite Boards, followed by recent visits, and matching favorites rank first on any search — making it faster to jump to the boards you use most. (#450)
- Site admin invite links now track a `use_count` — incremented on every successful registration (including multi-use links) and surfaced in the admin UI. Provides audit visibility when a multi-use link is leaked. Closes #470.
- UI: show a desktop-only notice on viewports narrower than 1024px instead of a broken layout. The Kanban grid, swimlane panel, and sidebar require horizontal space that phones and portrait-mode tablets can't provide, so the app now displays an accessible `alertdialog` card with a clear explanation and switches back to the full UI automatically when the viewport grows past the breakpoint. Closes #508.
- Mobile/tablet viewports (below 1024 px) now have a navigation affordance: a hamburger bar appears at the top of the content area and opens the sidebar as a full-height overlay drawer. Closes on backdrop click, Escape key, or the close button inside the drawer.
- Add Playwright E2E tests for critical user paths (login, board render, card creation, card drag-and-drop, card detail); tests run in CI as a separate `playwright-e2e` job using page-level API mocking via `page.route()`.
- CI: added `dep-scan-osv` job — weekly OSV-Scanner scan of `backend/requirements.txt` and `frontend/package-lock.json` using the OSV.dev advisory database (lower false-positive rate than NVD). Also runs on MRs when lockfiles change. JSON results uploaded as artifact. Closes #612.
- CI: added `dockerfile-lint` job using hadolint — enforces Dockerfile best practices on every MR touching a Dockerfile and on main. Added `.hadolint.yaml` ignoring DL3008 (apt version pinning). Fixed DL3045 in `backend/Dockerfile` builder stage (added `WORKDIR` before `COPY`). Closes #624.
- CI: added `shellcheck` lint job for `scripts/*.sh` — catches unquoted variables, missing `set -e`, and portability issues on every MR and main push. One pre-existing warning fixed (`for i` → `for _` in release.sh wait loop). Closes #625.
- Saved filters now include a `state_version` field so clients can dispatch to version-specific readers when the filter state shape changes non-additively (#698)
- The API now validates `state_json` structure on write, rejecting unknown top-level keys and wrong field types to protect the board-import flow (#698)
- Swimlane collapse: any board member can now collapse or expand swimlane rows, with the state persisted in localStorage per board. A "N lanes collapsed" strip appears in the board header with a one-click "Expand all lanes" button. Press `c` while hovering a swimlane to toggle its collapsed state from the keyboard. Board admins can set the default collapsed state on a swimlane via `PATCH /api/v1/boards/{board_pk}/swimlanes/{pk}/set_collapsed/`.
- Filter bar chips: active filters (assignee, label, priority, due date) are now shown as dismissible chips below the filter controls, with a "N cards hidden" counter when results are narrowed. Filter state is also serialized to URL params (`?f_assignees`, `?f_labels`, `?f_priorities`, `?f_due`, `?f_search`) so filter links are shareable. The `f` shortcut now focuses the filter bar on open, `Tab` moves between chips, and `Delete`/`Backspace` removes a focused chip.
- Card aging indicator: cards idle beyond the board's staleness threshold now show an amber tint overlay and reduced opacity on the board view. A warning tint appears earlier (controlled by the warning-percentage setting). Replaces the previous clock emoji and amber ring. The "Stale card settings" section in board settings is renamed to "Card aging settings" with updated help text.
- Added unified activity timeline to card detail — movements, field changes, comments, checklist events, and attachments appear in a single paginated feed with event-type filtering.
- Card peek: hovering a card for 600 ms now shows a read-only popover with the card's description, checklist progress, and last-activity timestamp — no click required to preview card content.
- Filter presets: saved filters now appear as one-click tab pills above the filter bar — load any saved preset instantly without opening the dropdown. The "All" tab clears all active filters.
- Add live activity drawer to the board view. A collapsible right-side panel shows a real-time feed of card moves, card creations, and member events sourced from the WebSocket stream. The feed can be filtered to All / Moves / Members tabs. Toggle with ⌘\ or the toolbar button.
- Add ⌘K command palette for fast in-board navigation. The palette searches current board cards by title, all accessible boards by name, and a set of static actions (filter by assignee, open settings, show shortcuts, go to history). Keyboard-navigable with ↑↓, ↵ to open, ⌘↵ to open in a new tab.
- Group boards list now auto-refreshes over WebSocket: boards created, renamed, deleted, or moved between groups by other users appear live in the `/groups/<id>` page without a reload. A new per-group channel (`ws/groups/<group_id>/`) emits `board.created`, `board.updated`, and `board.deleted` events, mirroring the existing per-board channel's envelope and auth semantics (`4001`/`4003` close codes). The page also surfaces a **Live / Reconnecting… / Offline** indicator and preserves keyboard focus across live list mutations. Closes #753.
- Added shared `Toggle` and `ToggleField` components; replaced bespoke checkboxes in InviteLinkPanel (Single-use) and BoardSettingsModal (WIP, hard WIP, weight, and share-link toggles) with the standard slider-style toggle.
- Add a unified `formatDate`/`formatDateTime` utility that reads each user's date format, time format, and timezone preferences; replace ad-hoc `toLocaleString` calls across the frontend.
- Added an ARIA live region (`role="status" aria-live="polite"`) at the board level that announces drag-and-drop card, column, and swimlane moves to screen readers. Announcements include pickup, hover-target (throttled to 300 ms), and drop/cancel outcomes.
- Added over-WIP warning glyph (⚠) to collapsed column headers when card count exceeds the WIP limit, with an accessible title tooltip showing the current count and limit.
- Added per-field autosave confirmation for card Description and Weight fields: a spinner while saving, a green "✓ Saved" indicator that auto-fades after 2 seconds, and a "! Couldn't save" message on failure.
- Sharing: added an optional TTL on board public share links. Admins can now choose **Never / 7 / 30 / 90 days** from the Sharing tab when enabling a share link. Past expiry, `GET /api/share/<token>/` returns **410 Gone** rather than serving stale board data — the token is not auto-rotated, only refused. The new `share_token_expires_at` field is exposed on `BoardFullSerializer` to admins (null for non-admins) and persisted in `Board.share_token_expires_at`. Closes #804.
- Kebab-case alias `PATCH /boards/<id>/swimlanes/<id>/set-collapsed/` for the swimlane collapse toggle. The existing `set_collapsed` snake_case path remains routable through all 1.x releases and will be removed in 2.0. `docs/api/index.md` now documents kebab-case as the canonical URL path style.
- Opt-in nested `group_detail` payload on `Board` and `BoardFull` responses via `?expand=group`. The existing `group` (FK id) and `group_name` fields are unchanged; `group_detail` defaults to `null` when the expand parameter is not passed. See `docs/api/index.md` for the URL convention.
- CI test that detects drift between DRF serializers and their corresponding `frontend/src/types/index.ts` interfaces. Missing or extraneous fields now fail the pipeline instead of surfacing as runtime `undefined` in the browser. Fixes one existing drift case: `CardChecklistItem` now declares `created_by_id: number | null` to match `CardChecklistSerializer`.
- Add `> **Added in 1.0**` version callout to feature pages that were missing one: card archiving, saved filters, personal access tokens, groups, feature toggles, and the onboarding tour getting-started page.
- Admin users API (`docs/api/admin.md`) now documents the 400/403/409 error responses for `PATCH /api/v1/admin/users/{id}/`, including the `owned_boards` conflict shape that directs callers to the deactivate endpoint.
- Board import API (`docs/api/boards.md`) now carries the permission, request-field, response, and error documentation that was missing from the previous one-line entry.
- Groups API (`docs/api/groups.md`) now carries a note that the list endpoint omits the `ancestors` field — callers that need the ancestor chain must fetch the single-group retrieve endpoint.
- Board exports are now audit-logged. Admins can view a paginated export history for each board under Board Settings → Data, capturing actor, role at export time, format, row count, and timestamp. Failed exports (permission denied, rate limited) are not logged. New endpoint: `GET /api/v1/boards/{id}/export-history/` (admin-only).
- Per-board export permission threshold. Admins can restrict board exports to a minimum role (viewer / collaborator / member / admin) under Board Settings → Data. Below-threshold users see the Export UI hidden; direct API calls return `403 export_restricted`. Owners and site admins always bypass the threshold. Default remains `viewer`, so existing boards keep current behavior.
- Board admins can now rename a board inline by clicking the board name in the top breadcrumb (or the hover-reveal pencil icon next to it). Press Enter or blur to save, Escape to cancel. Mirrors the existing group rename affordance. (#854)
- Keyboard shortcut coverage audit across the board chrome (#868):
- View tabs now respond to `b` (Board), `s` (Summary), `h` (History), `a` (Analytics).
- `e` toggles collapse-everything; `y` toggles the archived cards panel.
- `⌘⇧L` / `Ctrl+Shift+L` switches between compact and expanded card layouts.
- `/` is now a visible `kbd` chip inside the filter bar's search input so the shortcut is discoverable without opening the overlay.
- Shortcuts overlay regrouped into four labeled sections (Navigation · Board view · Board actions · Help) with imperative descriptions, a widened key column for longer chords, and platform-aware glyph rendering (⌘ on Mac, `Ctrl+` elsewhere).
- Every single-key and single-modifier binding is announced via `aria-keyshortcuts` so screen readers can surface them; two-modifier chords stay in the overlay and tooltip only.
- Bare-letter shortcuts continue to be suppressed while focus is inside an input, textarea, or rich-text editor.
- New doc: Features → Keyboard Shortcuts.
- Added light/dark mode toggle to documentation site.
- The guided onboarding tour now covers 8 steps (up from 4), adding walkthroughs for view tabs, swimlane collapse, the Live connection indicator, and Space+drag canvas panning (#770)
- A new full-screen tour step type introduces the Space+drag panning hint without requiring a spotlight anchor on a specific element (#770)
- Users can restart the onboarding tour at any time from Settings → Behavior or from the keyboard shortcuts overlay (#770)

### Changed
- Documented WebSocket close code `4001` (unauthenticated) alongside the existing `4003` (unauthorized) in the WebSocket API reference. Behavior is unchanged.
- Helm chart: prints a warning from `NOTES.txt` when `backend.image.tag` or `frontend.image.tag` is empty or `latest`, and the Kubernetes deploy guide now documents the pinning requirement. The default tags remain pinned to the current release.
- Removed deprecated `WipLimitError` type alias from `useBoard.ts`. Use `MoveBlockedError` (narrowed by `code: "wip_limit_exceeded"`) directly. The alias was internal-only and had no documented external consumers.
- Enforce Vitest frontend coverage thresholds in CI (lines 70 %, statements 70 %, functions 60 %, branches 60 %) so the pipeline fails when coverage drops below the established floor.
- Introduce factory_boy for backend test data generation; adds `UserFactory`, `BoardFactory`, `CardFactory`, and related factories in `backend/factories.py` so tests can build realistic object graphs with minimal boilerplate.
- Documented that `GET /api/v1/boards/{id}/cards/` returns a bare JSON array rather than the standard pagination envelope. Behavior is unchanged; this clarifies the contract for API consumers.
- Card detail Activity tab — filter now defaults to Column moves (the canonical "what happened to this card" view), and the dropdown gains an **All** toggle to select/clear every event type in one click plus a **Reset to default** control to return to the default lens.
- Board activity drawer now defaults to a 24-hour time window and exposes 1h/24h/7d window pills, so the feed focuses on recent activity by default. Use **Open full history →** for the unfiltered audit trail.
- Documented the bounded-depth BFS in `descendant_boards` so future readers understand the per-level query cost is capped by `_GROUP_TRAVERSAL_MAX_DEPTH` ([#793](https://gitlab.com/visiban/visiban/-/issues/793)).
- Documented the per-board broadcast fan-out in `transfer_ownership` so the constraint is explicit: one broadcast per board is required because each board has its own WebSocket channel group ([#795](https://gitlab.com/visiban/visiban/-/issues/795)).
- Movements endpoint and card timeline now fold the total count into the page query via a window function, saving one extra `COUNT(*)` round-trip per request on boards with long history ([#798](https://gitlab.com/visiban/visiban/-/issues/798)).
- Emit `column.reordered` and `swimlane.reordered` (singular) alongside the legacy plural `columns.reordered`/`swimlanes.reordered` WebSocket events. The plural forms are deprecated and will be removed in 2.0; new clients should subscribe to the singular names.
- Deprecation warnings for legacy env-var aliases (`OIDC_SECRET`, `ACCOUNT_EMAIL_VERIFICATION`) are now emitted only when the alias is actually set in the environment, instead of every worker start ([#819](https://gitlab.com/visiban/visiban/-/issues/819)).
- Documented the `MOVEMENT_EXPORT_BACKENDS` / `ANALYTICS_EXTENSIONS` extension-point contract: enterprise registers via `.append(...)`; the container type and rebinding semantics are part of the stability guarantee and cannot change without a major version bump ([#820](https://gitlab.com/visiban/visiban/-/issues/820)).
- Added a module-level docstring to the `groups/0003_placeholder.py` migration explaining why the slot is intentionally empty and what to do during rollback ([#823](https://gitlab.com/visiban/visiban/-/issues/823)).
- Every `RunPython(..., RunPython.noop)` data migration now carries an inline comment explaining why the reverse is a no-op and whether the forward is safe to re-run after a partial apply ([#824](https://gitlab.com/visiban/visiban/-/issues/824)).
- Documented the `filter(uid__isnull=True)` idempotency guard in the `0018_add_stable_uids` migration backfill so partial-apply re-runs do not silently rewrite previously assigned uids ([#825](https://gitlab.com/visiban/visiban/-/issues/825)).
- Document label pills as the single permitted exception to the "filled pill" rule (`frontend/CLAUDE.md`) — labels carry user-assigned hues where white-on-fill would fail contrast, so the tint + colored-text + colored-border combination is the canonical treatment.
- Port bulk-delete and delete-column confirmations to the shared `ModalWrapper`, restoring Escape-key handling, focus trap, and the canonical design-system panel radius.
- Replace hand-rolled toggle buttons in AdminPage (`Single-use` invite link, `File uploads`) and SettingsPage (notification prefs, `Close editor on Enter`) with the shared `Toggle` component for consistent styling and accessibility.
- Activity drawer event-type filter dots now pull their color from design tokens (`--primary-emphasis`, `--fg-muted`) instead of hardcoded hex values, so the palette tracks the active theme.
- Standardize docs version callouts on `1.0` / `1.1` rather than `1.0.0` / `1.1.0` — the marketing site and release notes already follow the shorter convention.
- Tests: added unit coverage for `BoardView.collectActivityEvent` covering all four event branches (`card.moved`, `card.created`, `member.added`, `member.removed`), payload fallbacks ("Someone" / "a card"), unique-id generation (regression guard for #787), and ignoring unrelated event types. Closes #839.
- Tests: added unit coverage for the `useFocusTrap` hook covering Tab forward-wrap, Shift+Tab backward-wrap, skipping `aria-hidden` subtrees, the empty-container no-op, and the `active=false` short-circuit. Closes #840.
- Tests: added unit coverage for the `useIsLargeViewport` hook covering the SSR/no-`matchMedia` fallback (`true`), initial match read at the 1024px breakpoint, live updates via the `change` listener, and listener teardown on unmount. Closes #841.
- Group detail page: when "Show subgroup boards" is toggled on, each board row now shows the full relative path from the current group down to the board's direct parent (e.g. "Alpha / Beta / Gamma" instead of just "Gamma"). Paths longer than three segments are collapsed with middle-ellipsis and the full path is revealed via tooltip and screen-reader label. `GroupBriefSerializer` now includes a root-first `ancestors` field so callers opting into `?expand=group` can render breadcrumbs without extra requests (#845).
- The top chrome now lands on a stable two-row skeleton (`h-14` app header + `h-10` board toolbar) with explicit ARIA landmarks — `<header role="banner">`, `<nav aria-label="Board toolbar">`, `role="search" aria-label="Card filters"`, and `<main role="main">` — so screen readers and keyboard users can jump between regions, and future top-bar MRs layer onto a consistent foundation (#848)
- The top-bar breadcrumb now shows the current group and board (or Settings / Administration) as a properly structured navigation landmark, with truncation, tooltips on hover, and correct accessibility markup. (#849)
- The top navbar's user controls are replaced by an avatar-triggered dropdown menu containing the user's name and email, links to Profile & preferences, Keyboard shortcuts, and Help & docs, and a Sign out action — removing the bare "Sign out" button that was easy to mis-click (#850)
- The WebSocket live indicator is replaced by a canonical `ConnectionStatus` component that stays quiet when healthy, surfaces an amber badge for connecting/reconnecting and when no events have arrived for over a minute, and surfaces a red badge when the real-time channel fails — each state opening a popover with per-state context and, where appropriate, a Refresh board or Reload page action (#851)
- A new global search entry now sits in the Row 1 chrome (🔍 Search ⌘K) as a single source of truth — the duplicate Row 2 command-palette icon button is removed. The board filter bar gains a scope toggle ("This board" / "Everywhere") to the left of the search input; selecting "Everywhere" opens the command palette and persists the choice via `?scope=all` for link-sharing. The board search input shows the exact copy `Search cards on this board…`, disables itself while scope is Everywhere, and reveals a `Searching across all your boards` helper line beneath. The `? for shortcuts` hint text is removed from the toolbar (the `?` hotkey and the keyboard-icon button remain). `SingleSelectDropdown` grows an optional `triggerPrefix` prop so callers can render an icon inside the trigger without forking the component (#852)
- Board toolbar Collapse is now a split button — clicking the primary label still toggles everything while the chevron opens a menu to hide or show only swimlanes, only columns, or everything. A new overflow kebab (`⋮`) at the right edge consolidates Export, Keyboard shortcuts, and Replay onboarding tour behind one entry point, reachable from anywhere with the `.` shortcut. On viewports below 1024 px the Layout toggle, Archived, Activity drawer, and Settings fold into the overflow menu so the toolbar degrades gracefully without hiding functionality; below 768 px the toolbar scrolls horizontally with the overflow kebab and connection status pinned to the right edge. Export now has a `⌘⇧E` / `Ctrl+Shift+E` shortcut.

### Fixed
- `SelectDropdown` now supports full keyboard navigation: Arrow Down/Up open and navigate the list, Enter/Space select, Escape closes. The trigger has `role="combobox"`, the panel `role="listbox"`, and each option `role="option"` with `aria-selected`. All surfaces using `SelectDropdown` (board member role picker, card assignee, and more) benefit automatically.
- Add ARIA roles, states, and keyboard navigation to `SingleSelectDropdown`, `CheckboxDropdown`, and `BulkActionToolbar` dropdowns. Trigger buttons now expose `aria-haspopup`, `aria-expanded`, and `aria-controls`; menus carry `role="menu"` or `role="group"`; items carry `role="menuitem"`. Arrow key, Home, and End navigation is fully wired for `SingleSelectDropdown` and all three `BulkActionToolbar` dropdowns (Move, Assign, Priority).
- Add `aria-label` and `aria-pressed` to color swatch buttons in AddSwimlaneModal and AddColumnModal for screen reader and keyboard accessibility.
- Board export (`GET /api/v1/boards/{id}/export/`) is now accessible to all board members, including viewers and collaborators. Previously the endpoint was restricted to members and admins, which was inconsistent with the read access those roles already have via the movements and cards endpoints.
- Expand InviteLinkPanel tests: revoke flow, error state, MAX_LINKS limit, copy, role/expiry dropdowns, expired link display.
- Expand BoardMembersModal tests: remove member confirmation, role change, non-admin viewer restrictions.
- Fill boardsApi test gaps: 11 untested functions and error paths for patchBoard and sharing endpoints.
- Add SelectDropdown and SingleSelectDropdown unit tests: keyboard nav, open/close, disabled state, size variants.
- Add useDropdownEscape hook tests: Escape handling, nested stack priority, cleanup on unmount.
- Consolidate duplicate vi.mock in rbacRendering.test.tsx so createLabel mock is no longer silently ignored.
- Replace deprecated asyncio.get_event_loop().run_until_complete() with asyncio.run() in broadcast tests.
- Add accessibility assertions across frontend tests: aria-expanded, aria-pressed, accessible names, keyboard nav, focus visibility.
- Group rows in the sidebar tree are now rendered as `<button>` elements, making them reachable by Tab and giving them a visible focus ring (#481)
- The AppSidebar collapse toggle now shows a visible focus ring when navigated by keyboard (#481)
- The "New board" and "New group" buttons in the AppSidebar footer now show visible focus rings (#481)
- The template selector in the Create Board modal is now a proper radio group (`<fieldset>` + `<legend>` with `<label>` and visually hidden `<input type="radio">` elements), so screen readers announce the group name and currently selected template, and arrow-key navigation between options works natively. Previously the options were plain buttons with no ARIA group semantics. (#482)
- Replace plain-text loading states with the canonical animated spinner component; normalize spinner color token across all loading states.
- The Create Board modal now displays a submission error message in a reserved-height footer slot when board creation fails (network error, duplicate name, or server error), so users receive clear feedback instead of the form silently resetting. (#486)
- Add composite indexes on `CardActivity(card, created_at)` and `CardComment(card, created_at)` to speed up per-card activity feed and comment list queries.
- ModalWrapper now traps keyboard focus inside the dialog panel (Tab and Shift+Tab wrap within focusable descendants), satisfying WCAG 2.1 AA Success Criterion 2.4.3. All 12+ modals using ModalWrapper benefit automatically.
- WebSocket `column.deleted` and `swimlane.deleted` event handlers now use state-only eviction (`evictColumn` / `evictSwimlane`) instead of the API-calling `removeColumn` / `removeSwimlane`, eliminating the redundant `404`-returning `DELETE` request that previously triggered a full board reload.
- Group tree sidebar rows are now rendered as `<div role="button">` elements to avoid an invalid button-in-button nesting when the expand chevron is a `<button>` child, resolving a browser warning and screen-reader inconsistency (#524).
- Board import child objects (comments, checklist items, movements, activities) are now inserted with `bulk_create`, eliminating up to thousands of individual round trips on large imports.
- Cache the `can_access_all_content` user lookup in `BoardFullSerializer` context so it runs at most once per `/full/` request instead of once per call to `get_members()`.
- Throttle PAT `last_used_at` DB writes to at most once per 60 seconds per token, eliminating a hot-path UPDATE on every authenticated request for high-frequency API callers.
- Helm chart: `python manage.py migrate` now runs in a dedicated Helm pre-install / pre-upgrade Job (`templates/migrate-job.yaml`) instead of a per-pod init container. This prevents the race where every backend replica attempts concurrent migrations when `backendReplicaCount > 1`, which could cause PostgreSQL lock deadlocks and partial schema application in HA deployments. The Job auto-cleans after 10 minutes and is re-created on each release.
- Added a contract test suite for `GET /api/v1/boards/{id}/full/` that locks in the presence and shape of every field the frontend `BoardFull` TypeScript interface depends on — including `owner`, which was silently missing in an earlier release. Prevents recurrence of #543.
- Create shared pytest fixtures in boards/tests/conftest.py; migrate test_card_move, test_rbac, and test_wip_enforcement to use them.
- Add dedicated tests for notify_stale_cards management command: happy path, empty case, threshold override, no-members, idempotency, and stdout output.
- Read-only share view swimlane names now wrap instead of truncating, making long names (customer or project names) fully readable without interaction.
- The Moderator checkbox in Board Settings → Members tab now correctly reflects role constraints: admin members show a checked and disabled checkbox (admins implicitly hold all moderator rights), collaborator and viewer members show an unchecked and disabled checkbox, and member-role users continue to see an editable checkbox as before.
- Add value-correctness unit tests for `CardSerializer` computed fields: `is_stale`, `last_moved_at`, `checklist_done`.
- Add value-correctness unit tests for `PublicCardSerializer` computed fields and sensitive field exclusion.
- Add tests for weight-limit force-override 403 for non-admins and `BoardSerializer.validate_stale_warning_pct` boundary conditions.
- Add tests for archived card exclusion from stale scan and analytics endpoint query-count budget.
- Fix stale frontend test issues: add missing patchBoard/reorderSwimlanes mocks in useBoard.test.ts; replace invalid 'critical' priority fixture with 'urgent' in boardView.test.tsx.
- Re-fetch boards through `get_queryset()` in `perform_update`, `share`, and `move_group` so mutation responses include annotated `member_count`, `card_count`, and `is_starred` instead of triggering per-field subqueries from the bare post-save instance.
- Add a select_related guard in `BoardFullSerializer.get_members()` so cold-cache callers that fetch a board without the full group ancestor chain do not silently issue up to 6 live FK queries during parent traversal.
- Write the site-admin user list back to context on a cold-cache call in `BoardFullSerializer.get_members()` so it is shared with other methods and the `can_access_all_content` query runs at most once per request.
- Add production warning for `ALLOWED_HOSTS` default in installation and deploy guides.
- Annotate `is_stale` at the queryset level in `_card_queryset` when a `stale_cutoff` is provided, eliminating a `timezone.now()` call per card in `CardSerializer.get_is_stale()` and replacing it with a single SQL `CASE` expression.
- Add `prefetch_related("cards__labels", "cards__assignee")` to `BoardViewSet.get_queryset()` so card-label and assignee lookups are covered by prefetches when board-level card data is accessed.
- Admin Users tab now renders pagination controls correctly when the total user count exceeds the server's page size. The page offset is derived from the server-returned `page_size` field rather than a hardcoded client-side constant.
- AnalyticsView no longer spins indefinitely when the API returns null heatmap data or a null swimlanes list — a proper empty state (icon and descriptive message) is shown instead. The heatmap loading indicator has been updated to the standard animated spinner for visual consistency. (#672)
- Django admin mutations on `Card` and `Column` now broadcast the same `card.created`/`card.updated`/`card.deleted` and `column.*` WebSocket events as the REST API, deferred via `transaction.on_commit()`. Clients viewing a board no longer need a full reload to see admin edits.
- Fix first-run Docker command to use `docker compose up --build` with explanation of when the flag is required.
- Add test asserting `/api/v2/` returns 406 Not Acceptable for unsupported API version.
- Add test asserting `OffsetCountPagination` envelope shape and defaults on boards list endpoint.
- Card descriptions and comments now have enforced maximum lengths (50,000 and 10,000 characters respectively), preventing unbounded input from reaching the database (#688)
- Group invite links can now be created in single-use mode — once a recipient joins, the link is automatically consumed and any subsequent attempt to reuse it returns a clear "already used" error, closing the unlimited-use security gap (#689)
- The invite link list now shows consumed single-use links with a status badge and consumed-at timestamp for audit visibility (#689)
- Checklist items now record which user created them (`created_by`). Collaborators can only edit or delete items they created; admins and moderators retain full access. Pre-existing items with no `created_by` remain unrestricted for backward compatibility.
- Group board list (`GET /api/v1/groups/{id}/boards/`) now correctly excludes archived cards from the `card_count` annotation; previously archived cards inflated the count shown in the group navigator (#693).
- Group ownership transfer now broadcasts a `group.updated` WebSocket event to all boards in the group after the transaction commits, so connected clients reflect the new owner without a page reload (#694).
- Pre-compute group member IDs once in `BoardFullSerializer.to_representation()` and cache them on the board instance so `_get_effective_member_ids()` does not re-query `GroupMembership` when both `get_cards()` and `get_members()` run in the same request.
- The `board.deleted` WebSocket event now includes a `board_uid` field in its payload, making it consistent with all other delete events (`card.archived`, `column.deleted`, `swimlane.deleted`); the existing `board_id` field is retained for backward compatibility with pre-1.1 clients. (#696)
- Added negative RBAC regression tests confirming non-members receive `403 Forbidden` on `/analytics/`, `/summary/`, and `/movements/` board endpoints.
- Added regression tests verifying that deleting a column or swimlane does not break serialization of existing `CardMovement` records — denormalized `*_name` and `*_uid` fields are preserved and null FK fields do not cause errors.
- LoginPage OAuth buttons now have consistent focus rings for keyboard accessibility. The Google OAuth button uses Google's brand-required white background with dark text rather than the site's slate palette.
- CardActivity rows are now automatically created for field-level changes (assignee, priority, title, labels, due date, weight) when a card is updated. Actor is always the requesting user. Added tests for each field type (#708).
- Fixed two intermittently-failing frontend tests that caused spurious CI failures: the login page "Create account" test now waits for async site-config to settle before interacting, and the board 404 navigation test correctly flushes the rejected promise before asserting. (#718)
- Remove non-existent Light theme option from feature docs; theme switcher only offers System and Dark.
- Re-fetch `CardMovement` with full `select_related` (`moved_by`, `card`, `from_column`, `to_column`, `from_swimlane`, `to_swimlane`) before serializing in the card move response, eliminating up to 4 extra queries per card move.
- Re-fetch the group with annotations (`_member_count`, `_board_count`, `_subgroup_count`, `_is_starred`) in `JoinGroupView.post` before serializing, so `GroupSerializer` reads from annotation fast-paths instead of issuing up to 4 subqueries against the bare instance.
- Board creation via the group boards endpoint is now fully atomic — a failure during swimlane creation or label copy rolls back the board, membership records, and columns instead of leaving orphaned rows. (#723)
- Creating a board via a group now emits the same live `board.created` WebSocket event as the direct board creation endpoint, so group dashboards and sidebars refresh without a manual reload. (#723)
- Added missing test coverage for five code paths identified in the pre-1.0 audit: MIME-type upload validation, card archive-status action, board template list view, CSV field sanitization, and group ancestor traversal (#724)
- Apply IP-based rate limiting to password reset regardless of authentication state, and add throttling to the confirm endpoint.
- `scripts/close-milestone-issues.sh` now validates that the specified milestone exists before iterating, and prints a clear error with available milestone titles when it does not. Also fixes a silent exit caused by `grep` returning exit code 1 on an empty page under `set -o pipefail` (#738).
- Fixed broken anchor `#generic-oidc` in `docs/features/index.md`; updated to `#generic-oidc-beta` to match the anchor MkDocs generates from the heading including its Beta badge span (#739).
- Revoking a consumed single-use invite link now returns `400 Bad Request` instead of silently setting `is_active=False` alongside `used_at`, which would have caused the link to report as "revoked" rather than "used" in the admin audit list (#751).
- Added a database CHECK constraint on `GroupInviteLink` enforcing that `used_at` may only be non-null when `single_use=True`, preventing data-integrity issues from future migrations or management commands (#752).
- Fix `ImproperlyConfigured` error on the allauth `accounts/confirm-email/` URL by redirecting to the SPA instead of rendering a missing template.
- Docker Compose dev startup now logs the active `CORS_ALLOWED_ORIGINS` value so misconfigured origins are visible in `docker compose logs backend`. Added a CORS troubleshooting entry to the installation docs.
- Card detail Activity tab — the event-type filter dropdown no longer clips off the right edge of the drawer; option labels ("Column moves", "Attachments", "System events", etc.) are now fully legible.
- **Command palette (⌘K) — wiring** — The `CommandPalette` component shipped in 1.1 but could not be opened. Added the ⌘K / Ctrl+K global shortcut (fires even from focused inputs) and a magnifying-glass trigger button in the board toolbar's utilities zone. Web-standard binding matches Linear, Slack, Notion, GitHub, and VS Code. (#763)
- **Saved-filter tab pills a11y** — Add missing focus rings to saved-filter pills and drop the partial `role="tab"` ARIA pattern in favor of plain toggle buttons with `aria-pressed`. Keyboard users now see focus state on pills, and screen readers no longer interpret the row as a broken tabs container. (#764)
- Fixed black text on the "Create my first board" primary button on the empty-state dashboard — the button now correctly uses white (`text-on-primary`) instead of the dark foreground color (#775).
- CI smoke test scripts no longer contain hardcoded credentials: Keycloak admin credentials in `oidc_provision.py` are now read from environment variables, and `oidc_smoke_test.py` defaults SSL verification to enabled with an explicit `--no-verify` flag for local development use (#786)
- Fix SonarQube reliability bugs: dead conditional in `ColumnTrashZone` (trash zone hover text now transitions from `text-fg-secondary` to `text-danger` on drag-over) and dead conditional in `ToggleField` description (description text now scales to `text-sm` when `labelSize` is not `"xs"`, matching sibling label behaviour).
- Cap `/api/boards/<id>/cards/` responses at 200 rows for all query shapes (previously the cap only applied to `?search=`). Unbounded card fetches are available via `/full/`.
- Cache effective/assignable member IDs and the board labels queryset per request in `CardViewSet` so card mutation responses no longer fire 2–4 extra queries each.
- Add a composite `(card, position)` index to `CardChecklist` so listing checklist items on cards with many items skips a filesort.
- Remove unused `cards__labels` and `cards__assignee` prefetches from `BoardViewSet.get_queryset`; `BoardSerializer` never read the prefetched card data.
- Re-fetch the annotated board row before broadcasting `board.created` so `BoardSerializer.get_is_starred` hits the annotation instead of a live EXISTS query.
- Align `AdminUserPagination` with the project-wide `OffsetCountPagination` envelope so `/api/v1/admin/users/` returns `{count, offset, page_size, results}` like every other paginated endpoint.
- Fix `Toggle` component's checked-state track to use the `bg-primary` design token instead of the raw `bg-indigo-600` Tailwind class.
- Replace forbidden `text-gray-900` / `hover:bg-gray-100` Tailwind classes on the Google OAuth sign-in button with slate tokens to match the design system's slate-only palette rule.
- Fix illegible priority badge text in `CardPeekPopover` — use white text on the priority color background to match the priority badge spec used elsewhere.
- Standardize modal footer gap to `gap-3` in `ProfileModal`, `MoveBoardModal`, `AddColumnModal`, and `AddSwimlaneModal` to match the design system spec.
- Add missing `font-medium` to primary buttons in `ProfileModal` ("Save changes") and `AdminPage` ("Create link") to match the design system's primary button spec.
- Replace `rounded-xl` with `rounded` and add a keyboard focus ring on the subgroup board buttons in `GroupDetail` so keyboard users can see where they are when tabbing through the group hierarchy.
- `POST`/`DELETE /api/v1/boards/{id}/star/` now broadcasts a `board.star_changed` WebSocket event so multiple open tabs for the same user stay in sync without a full refetch. Clients filter on `user_id === me` because star state is per-user.
- Moved `transaction.on_commit(broadcast_board_event(...))` calls for the JSON and CSV board-import paths inside the enclosing `transaction.atomic()` block. Outside the block, `on_commit` executes the callback immediately when no transaction is active, so under `ATOMIC_REQUESTS` or test fixtures a rollback could fire a phantom `board.created` event for a board that never committed.
- Backfill residual `Notification.action_type=""` rows to `card_moved` (new migration 0049). Migration 0040 left unclassifiable rows as `""` and 0041 then set `blank=False`, which would reject any re-save of those rows through ModelForm / serializer code paths.
- Personal access token one-time reveal panel now uses `bg-sunken` with a `border-warning/50` outline, matching the design-system spec for one-time token reveal rows.
- Dashboard group tree container now uses `rounded-lg` instead of `rounded-xl` (reserved for elevated modals/dialogs per the design system).
- `MoveBoardModal` picker row buttons now use `rounded` (not `rounded-lg`) and expose a keyboard focus ring, per the design-system button rule.
- Group detail page: users added as members of a parent group now correctly see its subgroups and their boards. Previously the `/api/groups/{id}/subgroups/` endpoint filtered to direct-membership subgroups only, so an invited parent-group member saw "0 boards" and no "Show subgroup boards" toggle even though `descendant-boards`, the sidebar tree, and `get_accessible_group_ids` all granted them access. The endpoint now matches the documented RBAC inheritance model and aligns with those other surfaces. This reverses the narrow filter introduced in commit 7ca7b6c9 ("Finding 4") from the pre-1.0 RBAC audit — subgroup names and metadata are now visible to parent-group members, which is a subset of what `descendant-boards` already exposed. If you relied on subgroup-name opacity as a privacy boundary, move those subgroups to a separate top-level group instead (#846).
- Primary buttons in light mode now use a darker blue that meets WCAG AAA contrast (10:1+), and a group of buttons that displayed dark text on a blue background — failing contrast entirely — have been corrected to white text throughout.
- ⌘K / Ctrl+K command palette now works on every authenticated route — Dashboard, Groups, Settings, Admin, and every Board sub-tab (Summary, History, Analytics) — instead of only the main Board view. Placeholder copy adapts per surface: board cards on board routes, a boards-only jump on Dashboard/Group, a general nav list on Settings/Admin. Fixes the "ghost dialog" where pressing ⌘K on a sub-tab left the palette visible after navigation. (#869)
- Fix a `frontend-test` CI flake where transient-state timers (copy-to-clipboard feedback, banner auto-dismiss, fade-out animations, save confirmations) could fire after a component unmounted, producing an unhandled `ReferenceError: window is not defined` during test teardown. Timers across Settings, Invite link panel, Share URL copy, Card-not-found banner, Card highlight, Group detail board-added animation, and Group default-role save are now held in refs and cleared both on unmount and before scheduling a new one. No change to user-visible behavior.
- Improve contrast of the active tab in the Site Administration sidebar — the label now uses the on-primary text color instead of the default foreground, matching the board navigation bar convention.
- Fix a stale `waitFor` in the AppSidebar test suite that caused the Recent-boards assertion to race against data load; test now waits on the spinner's accessible name instead of a literal string that no longer exists.
- Fixed `docs-deploy` CI job failure when a stale `gh-pages` branch exists on the runner from a previous job.
- Stabilized backend coverage gate by omitting test files from measurement and removing duplicate CI variable blocks (#656)
- Email confirmation links now point to the frontend SPA (`/confirm-email/<key>`) instead of the backend API URL, fixing the `ImproperlyConfigured: TemplateResponseMixin requires template_name` crash that occurred when a user clicked a confirmation link received via invite+OAuth flow.
- Collaborators and viewers can now export a board to JSON or CSV using a new "Export board" button in the board header — board export no longer requires admin access to board settings
- The board toolbar (tabs and action icons) now scrolls horizontally on narrow mobile viewports instead of compressing controls off-screen
- The card detail panel no longer overflows the right edge of the screen on mobile; it fills the full viewport width on screens narrower than 640px and returns to its fixed width on larger screens
- The "Move card" popover no longer clips off the left edge of the screen on narrow mobile viewports when the trigger button is near center.
- Removing a user from a group now fetches all affected board contexts in a single query instead of one query per board, eliminating an O(n) database stall on large groups
- Membership role checks during card/comment mutations now reuse the prefetched membership cache instead of issuing a redundant live query per request
- Comment @mention resolution reuses the board context already loaded for the request rather than re-querying effective member IDs
- Board full-serializer now shares the group ancestor map cache with nested group serializers, removing duplicate ancestry lookups on board load
- Share-token serializer now resolves the caller's board role once and reuses it across both token fields instead of calling the role helper twice
- Raw user primary keys are no longer included in checklist item responses; items now surface only the display-name context object as intended
- Swimlane collapse/expand is now restricted to board members, admins, and site admins; collaborators (viewer-level) can no longer mutate board structure
- Production startup now raises a configuration error when the default from-address still contains `example.com`, preventing silent password-reset delivery failures
- Danger buttons now use the `text-on-danger` color token for correct contrast on destructive actions (#885)
- Primary buttons render with `font-medium` weight and `opacity-40` disabled state to match the design system (#886)
- Focus rings and border-radius corrected to `rounded-lg` across interactive controls; modal footer spacing standardized to `gap-3` (#887)
- Dashboard landmark sections now carry `aria-labelledby` attributes for screen-reader compatibility (#888)
- Replaced hand-rolled toggle in GroupDetail with the shared `Toggle` component (#889)
- Removed deprecated `OIDC_SECRET` and `ACCOUNT_EMAIL_VERIFICATION` environment variable aliases; the removal window introduced in 1.0 is now complete (#890)
- WIP hard-blocked API response now includes the `"detail"` key that clients expect (#891)
- `ping` WebSocket message now uses the standard `{"event": "ping", "data": {}}` envelope instead of a bare flat object (#892)
- Group membership PATCH endpoint now returns `{"detail": "..."}` error bodies instead of `{"role": "..."}` (#893)
- `set-collapsed` board action now broadcasts a `swimlane.updated` event so connected clients update immediately without a reload (#894)
- `group.updated` broadcast is now sent on the group channel via `broadcast_group_event` instead of being fan-fanned per board (#895)
- Added `ShareActionResponse` type and marked `share_token` / `share_token_expires_at` as non-optional on the `BoardFull` TypeScript interface (#896)
- Analytics extension hooks are now wrapped in a defensive try/except so a faulty hook cannot crash the request (#897)
- Zero-downtime co-deploy safety comments added to migrations `0041` and `0050` to document deployment ordering requirements (#885)
- Onboarding tour documentation now reflects 1.1 release, covers all 8 tour steps, and documents the self-service tour reset path via PATCH /api/v1/auth/me/ (#908)
- Analytics extension panel documentation now carries the correct "Added in 1.1" version callout for the ANALYTICS_EXTENSIONS hook (#910)
- Admin users API docs corrected to match the actual OffsetCountPagination response shape (offset/page_size params, next/previous removed from envelope) (#911)
- Cards API docs now document the 200-card cap on the board cards endpoint (#912)
- Django minimum version raised to 5.2.13, resolving four moderate CVEs covering header spoofing, memory exhaustion, and admin permission bypasses (#899)
- Analytics extension hooks are now invoked individually so a single faulty hook logs a warning and is skipped rather than aborting the entire extension chain (#904)
- Recent boards sidebar — prune stale entries from localStorage on load so boards deleted, with revoked membership, or inherited from a prior instance no longer appear as phantom recents.
- Removed the desktop-only `ViewportGate` blocker screen — the mobile navigation bar introduced in #524 already handles sub-1024 px viewports with a proper responsive layout, making the "use a larger screen" alert unnecessary.
- Boards where the user is a direct member but not a group member were invisible in the sidebar — they now appear correctly in the Personal section or group tree regardless of group membership
- Boards in nested groups where the user holds no group membership were similarly invisible and are now shown
- The Recent Boards section failed to record a visit when navigating directly to a board URL due to a race condition between the visit recorder and the initial board list fetch; the ordering is now enforced so every direct-load visit is captured

### Security
- Broadcast `member.removed` to active board WebSocket connections when a user's group membership is revoked, closing stale connections that were inherited solely through that group.
- Sanitize attachment filenames using `get_valid_filename()` and strip CR/LF/null bytes before storing in `Content-Disposition` headers.
- Add Redis `requirepass` authentication to `docker-compose.prod.yml`; update broker and cache URLs to include credentials.
- Rate-limit Django admin login at nginx level (5 req/min, burst 2) as defense-in-depth alongside existing IP restriction.
- Add `Content-Security-Policy` header to nginx config templates; upgrade `X-Frame-Options` from `SAMEORIGIN` to `DENY`; extract inline theme-init script to static file to enable strict `script-src 'self'`.
- Rate-limited the email-confirm safety-net redirect endpoint (`GET /api/v1/auth/registration/account-confirm-email/<key>/`). The view was a plain Django `View`, which bypassed DRF's throttle pipeline and left the path unbounded. It is now a DRF `APIView` with `EmailConfirmRedirectThrottle` (scope `email_confirm_redirect`, 60/hour per IP in production). Mitigates log flooding and cache-layer exhaustion on this unauthenticated endpoint.
- Replace `Math.random()` with `crypto.randomUUID()` for activity-feed entry key generation in BoardView to resolve SAST findings (#787)
- Pinned vulnerable transitive dependencies to patched versions: `zipp` (PyPI) upgraded from 3.9.1 to 3.19.1 (GHSA-jfmj-5v4g-7637), `follow-redirects` (npm) upgraded from 1.15.11 to 1.16.0 (GHSA-r4q5-vmmm-2653), and `@tootallnate/once` (npm dev) upgraded from 2.0.0 to 3.0.1 (GHSA-vpq2-c234-7xj6) (#788)
- Restrict `set_collapsed` on swimlanes to non-viewer board members. Viewers previously could toggle the default collapsed state for every member.
- Confirmed and documented the board-export role policy. Any board member — including Viewers and Collaborators — can bulk-export a board as CSV or JSON; a role that can read every card through the paginated API can already reconstruct the board, so a separate gate on bulk export would be inconsistent. This decision was re-affirmed by the Voice-of-Customer panel on 2026-04-21 and is paired with two planned controls: an export audit log ([#806](https://gitlab.com/visiban/visiban/-/issues/806)) and a per-board `export_min_role` override ([#807](https://gitlab.com/visiban/visiban/-/issues/807)).
- Documented the intentional pre-authentication preview exposed by `GET /api/groups/join/<token>/`. The endpoint returns `group_id`, `group_name`, and `role` to anyone holding a raw invite token so invitees can confirm what they are joining before signing up. Invite tokens carry 160 bits of entropy (`secrets.token_hex(20)`) and are rate-limited to 10 requests/hour per IP, so the group name is treated as public-via-this-path. Code comment updated to make the contract explicit.
- Add a defense-in-depth path-containment check on the dev-mode media serve branch so a future regression in upload sanitization cannot be combined with `DEBUG=True` into an arbitrary-file-read primitive.
- Bumped `PyJWT` from 2.12.0 to 2.12.1 to pick up the fix for CVE-2026-32597 — the earlier version accepted unknown `crit` header extensions (RFC 7515 §4.1.11 violation), allowing tokens to bypass security controls.
- Board import endpoint now enforces a rate limit of 10 imports per hour per authenticated user, preventing database flooding via rapid repeated imports (#690)
- CSV and JSON board export responses now include `Cache-Control: no-store`, preventing board data from being cached by browsers or intermediate proxies (#506)
- JSON import errors no longer echo raw exception messages to the client, preventing internal detail leakage; the full exception is logged server-side only (#528)
- HSTS subdomain coverage is now enabled in production to prevent protocol-downgrade cookie theft on subdomains (#697)
- Updated vite from 7.3.1 to 7.3.2 to fix three high-severity dev-server CVEs (GHSA-4w7w-66w2-5vf9, GHSA-v2wj-q39q-566r, GHSA-p9ff-h696-f583).
## [1.0.0] — 2026-04-12

---

## [1.0.0-rc.12] — 2026-04-12

---


### Added
- Add OIDC end-to-end smoke test and clarify callback URL slug (#725, #726).
- `docker-compose.oidc.yml`: new Docker Compose overlay that spins up Keycloak 24
  with the `visiban-test` realm, client, and test user for local OIDC development.
- `oidc/keycloak-realm.json`: pre-seeded realm config for `--import-realm` import.
- `scripts/oidc_provision.py`: idempotent Keycloak provisioning via Admin REST API
  (used by the CI smoke test job, no file mounts required).
- `scripts/oidc_smoke_test.py`: drives the full authorization code flow using
  `requests.Session` — discovery, login form, code exchange, callback, identity check.
- CI job `oidc-smoke`: runs the smoke test in every pipeline against a real Keycloak
  service; removes the Tech Preview limitation.
- `docs/administration/authentication.md`: removed Tech Preview warning, added
  explanation of the `oidc/oidc` double-slug in the callback URL (first segment is
  allauth's `OPENID_CONNECT_URL_PREFIX`; second is the `provider_id`).
- OAuth registration now works in invite-only mode. Users following a group invite link can sign up via Google, GitHub, GitLab, or OIDC — the invite token is carried through the IdP redirect and consumed automatically on successful signup. Previously, OAuth signups were blocked entirely in invite-only mode.
- Add self-service forgot password flow: "Forgot password?" link on the login page, `ForgotPasswordPage` (`/forgot-password`) with enumeration-safe confirmation, and `ResetPasswordPage` (`/reset-password/:uid/:token`) with expired-token recovery CTA. Backend wires a custom `VisibanPasswordResetSerializer` and `VisibanPasswordResetForm` to point reset-email links at the frontend SPA and send an alternate email to OAuth-only accounts rather than silently enabling password auth on them. Rate-limited at 5 reset requests/hour/IP in production.
- Added `docs/architecture/decisions.md` explaining the reasoning behind each technology choice. Tagged Generic OIDC, Analytics, and Staleness notifications as Beta in the documentation.
- Add `TLS_MODE` env var for Docker production deployments with three modes: `letsencrypt` (default), `selfsigned` (self-signed cert for staging), and `none` (plain HTTP for air-gapped/internal networks). Add `FORCE_INSECURE_COOKIES` env var to allow Django secure cookie flags to be disabled for plain-HTTP deployments. Rename `init-letsencrypt.sh` to `init-prod.sh` (old script remains as a deprecation shim). Add Helm `backend.settings.forceInsecureCookies` value and document self-signed and no-TLS Kubernetes deployments. **Upgrade note:** the certbot service now requires `--profile letsencrypt` — existing deployments using `docker compose up -d` directly (not via `init-prod.sh`) must add the profile flag to maintain certificate auto-renewal.

### Changed
- Documented the confirmed OSS/enterprise authentication boundary: generic OIDC (Keycloak, Okta, Authentik) is OSS; SAML 2.0 and SCIM directory sync are enterprise. Updated CLAUDE.md, authentication docs, and the open-core boundary reference accordingly.
- Documentation corrections for the movements API and analytics view: added `assignee_id` and `moved_by_id` filter parameters to all movement history references, updated stalled cards description to reflect the paginated table (25 rows/page), and corrected the date-range default from "last 30 days" to "full history returned when no range is specified".
- CI pipeline: cache test dependencies across shards, single-pass bandit scan, liveness poll in OIDC smoke test, schema-validate always runs on main, changelog depth bump, ghcr manual jobs share push template.
- Hardened Docker Compose and Helm deployment: multi-stage backend Dockerfile (removes gcc from final image), read-only containers with no-new-privileges, separate init service for migrations, PodDisruptionBudgets, pod anti-affinity, NetworkPolicy templates, default ingress annotations for WebSocket timeouts and upload limits. Added Kubernetes quickstart guide, health check endpoint docs, SMTP configuration reference, and ingress annotation documentation.
- API documentation corrections across authentication, boards, cards, and groups endpoints — fields, permissions, and response examples updated to match current implementation.

### Fixed
- Bumped `cryptography` from 46.0.6 to 46.0.7 to resolve CVE-2026-39892 (buffer overflow affecting Python 3.11+). Added enterprise URL extension point in `visiban/urls.py` and enterprise settings include hook in `visiban/settings.py` so the enterprise package can register additional routes and override settings without modifying OSS files.
- Wire `EMAIL_*` environment variables into Django settings so SMTP configuration is actually respected. Add `EMAIL_BACKEND`, `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `EMAIL_USE_TLS`, and `DEFAULT_FROM_EMAIL`; default to the console backend in development and SMTP in production. Change `ACCOUNT_EMAIL_VERIFICATION` default from `"none"` to `"optional"` and introduce `EMAIL_VERIFICATION` as the canonical env var name (`ACCOUNT_EMAIL_VERIFICATION` kept as a deprecated alias for one release).
- Harden Docker production and Helm chart configurations: fix Redis subchart crash (loadmodule for missing modules), add collectstatic init container, add media PVC, move PostgreSQL password to Secret, add securityContext to PostgreSQL StatefulSet, pin Redis image tag, add security headers/gzip/client_max_body_size to Helm nginx, add /media/ and /admin/ proxy locations, add OIDC/FRONTEND_URL/SITE_DOMAIN env vars, add healthchecks in docker-compose.prod, align nginx versions, and fix npm ci double-run in Dockerfile.prod
- Helm chart now runs `ensure_site_admin` automatically as a `bootstrap` init container on every deploy; the one-time admin password is written to `/run/visiban/admin_password` on a shared volume accessible from the running backend pod — no manual `kubectl exec` bootstrap step required after install.
- Disabled form submit buttons now use the correct reduced opacity (40%) matching the design spec, replacing the previous value across all forms.
- ViewToggle inactive tab hover background corrected to match the dark toolbar design token, preventing the tab from appearing lighter than intended on hover.
- AdminPage AddUserModal and OffboardingModal now use the shared ModalWrapper component, ensuring consistent focus trapping, overlay behavior, and keyboard dismissal across all admin modals.
- Analytics stalled-cards endpoint now includes a `uid` field on each entry alongside the existing `id`, allowing clients to reference cards by their public identifier without a secondary lookup.
- Columns now enforce a unique name per board at the database level, preventing duplicate column names that would silently corrupt analytics responses.
- Fix N+1 queries in card move and board member add responses: re-fetch `CardMovement` with `select_related("moved_by", "card")` before serializing, and assign `membership.user` from the already-loaded `target_user` instance instead of triggering a lazy FK load.
- Fixed 30+ buttons across 13 frontend files using `rounded-lg`/`rounded-xl`/`rounded-md` to use `rounded` per design system; added missing `focus:ring-2` focus states and `font-medium` on primary/danger buttons (B8)
- Added `board.created` WebSocket broadcast in import/export JSON and CSV import paths so new boards created via import are observable by future dashboard subscribers (B1)
- Added `avatar_url` sentinel contract comments to `types/index.ts` (`""` = no avatar, never `null`) to guard against post-1.0 breakage (B5)
- Fixed keyboard-inaccessible "Move board" button in GroupDetail (added `focus:opacity-100` and focus ring)
- Fixed `rounded-lg`/`rounded-xl` on `<button>` elements in BulkActionToolbar, BoardSettingsModal, CreateBoardModal, and GroupDetail — design system requires `rounded` on all buttons
- Fixed subgroup cards in GroupDetail using off-design indigo color family — now uses standard slate tokens
- Renamed `OIDC_SECRET` env var to `OIDC_CLIENT_SECRET` for consistency with all other OAuth provider env vars; `OIDC_SECRET` kept as a deprecated alias (will be removed in 1.1)
- Documented `collaborator` role permissions in `BoardMembership` model docstring to lock the public API contract
- Updated `groups/0003_placeholder` migration comment with instructions for fixing `InconsistentMigrationHistory` on databases set up before the placeholder was added
- Fix pre-release audit blockers: align button border radius to `rounded` across auth/settings/dashboard pages, add missing keyboard focus rings to all OAuth and onboarding buttons, fix JoinPage Google OAuth using light-mode colors in dark-only app, change priority badges from outline to filled style per design system, nest `Card.created_by` as a `BoardUser` object (consistent with `assignee`), add `"site_admin"` to the `BoardMembership.role` TypeScript union type, enforce viewer read-only semantics by excluding viewer-role users from the card assignee queryset and hiding checklist mutation controls and the attachment upload button for viewers, and add a `clear_viewer_assignees` management command to clean up any pre-existing viewer assignees.
- Fix N+1 lazy parent traversal in `_require_group_admin` when creating subgroups — re-fetch parent with full ancestor `select_related` chain before permission check (#658)
- Document `/api/v1/` versioning prefix and 406 behaviour explicitly in API reference (#604)
- Upgrade axios to 1.15.0 (critical CVE fix, post-supply-chain-incident safe version)
- Wire MOVEMENT_EXPORT_BACKENDS enterprise extension point call site in analytics movements view
- Rename `OIDC_SECRET` env var to `OIDC_CLIENT_SECRET` with deprecated alias for one release cycle (#733)
- Fix API docs: boards.md star endpoint response, stale staleness_threshold_days field, cards.md patchable fields warning for column/swimlane, notifications.md action_type values (#734)
- Add missing feature documentation: analytics Age/Throughput view modes, compact card layout toggle, My cards quick filter, Move to in card detail, Recent Boards sidebar section, forgot password self-service flow (#735 #736 #737)
## [1.0.0-rc.11] — 2026-04-07

---


### Added
- Enforce case-insensitive username uniqueness — a PostgreSQL functional index now prevents `Kelly` and `kelly` from coexisting. Existing collisions are resolved automatically by the migration (winner keeps username, losers pick a new one via a non-dismissable modal on next login). A new `POST /api/auth/choose-username/` endpoint lets affected users (and API/PAT clients) set a new username.
- Board invite notifications now display a "View board" link and navigate directly to the board when clicked.
- Added backend test coverage for group labels and board defaults endpoints.
- Added operator upgrade guide (`docs/administration/upgrade.md`) covering standard Docker Compose upgrade steps, zero-downtime migration rules, multi-replica deployment safety, rollback guidance, and migration status checks.
- A compact/expanded card layout toggle in the board toolbar lets users reduce card height and hide secondary metadata (labels, checklist, due date, attachments) while keeping the priority badge and assignee visible. The preference is saved per-user in localStorage and applies across all boards.
- Add `GET /api/groups/{id}/descendant-boards/` endpoint that returns all boards in a group and its full descendant subtree, fixing deeply nested boards being invisible in GroupDetail and the sidebar. Add "Recent boards" section to the sidebar showing the last 5 visited boards with group breadcrumb, persisted to localStorage. Auto-expand ancestor groups in the sidebar on direct navigation to a board URL.
- Analytics heatmap now has Age and Throughput view modes. Age mode shows how long cards have been sitting in each column right now. Throughput mode shows average dwell for cards that exited each column within the selected period (7, 30, or 90 days), with a per-column card count tooltip. The selected mode is remembered per board in localStorage.
- Added GitLab issue templates (Bug, Feature) and a "Finding your first issue" section to CONTRIBUTING.md to improve first-time contributor experience. Added a version compatibility quick-reference table to the upgrade guide.
- The Analytics tab now displays an amber "Beta" badge and a notice strip at the top of the Analytics view to communicate that the feature is still evolving and results may change.
- Stalled cards section in the Analytics view is now a proper table with Swimlane, Card, and Days Stalled columns, pagination (25 per page), and visual styling consistent with the Age/Throughput heatmap above it.
- Operators can now configure the maximum card attachment upload size via the `MAX_UPLOAD_SIZE_BYTES` environment variable (default: 10 MB).
- Users now receive a notification when they are added to a board — the notification appears in the bell dropdown and respects a new "Board invites" preference in Settings → Notifications (default: on)
- Added "My cards" one-click filter button to the board filter bar, extracted card-filter logic to a shared `filterCards` utility, and documented the server/client search split with an inline architectural comment.
- Add granular React error boundaries around the board grid, card detail panel, analytics, summary, and movement history views — a crash in one section no longer takes down the entire application.
- Add optimistic concurrency control (OCC) for card moves — concurrent edits to the same card are detected and rejected with a 409 Conflict response instead of silently overwriting.
- Add tab-focus board reconciliation — the board automatically re-fetches its full state when the browser tab regains focus, recovering from any WebSocket events missed during tab suspension or sleep.
- Release pipelines now publish pre-built Docker images to GHCR (`ghcr.io/visiban/visiban/*`), so self-hosters can pull images directly instead of building from source
- Version tag pipelines automatically create a GitHub Release with changelog notes and GHCR image references
- A new GitHub Actions workflow bridges GitHub issues to GitLab, so contributors can file issues on either platform
- Container images published to GHCR and the GitLab registry are now multi-arch manifests covering `linux/amd64` and `linux/arm64` — users on Apple Silicon Macs and Linux ARM64 servers pull the correct native slice automatically. Built using `docker buildx` with QEMU emulation on AMD64 runner VMs; no ARM64 runner required.
- In-app notification bell in the navbar shows unread count badge, lists recent notifications, and navigates to the relevant board or card on click. Board-invite notifications are sent when a member is added. Archived-card deep-links from notifications now show a contextual "This card has been archived" message instead of a generic "Card not found" banner.
- Add `sonar-project.properties` to suppress confirmed false positives (test passwords, CI credentials, seed data PRNG, migration complexity).

### Changed
- Upgrade Django 5.1 → 5.2 LTS and bump djangorestframework, channels, channels-redis, django-cors-headers, django-filter, and django-environ to their latest compatible releases.
- CI: `backend-test-coverage` now combines shard artifacts instead of re-running the full test suite, reducing the job from ~10 minutes to ~30 seconds.
- Changelog workflow now uses fragment files in changelog.d/ instead of direct CHANGELOG.md edits — eliminates merge conflicts between concurrent branches
- Redesign group creation modal: close by default after creation, show inline subgroup creation for top-level groups, and close immediately for subgroup creation.
- Reorganized the board toolbar into three semantic zones (view navigation, board controls, utilities/status), reducing visual clutter from 5 dividers to 2. Converted keyboard shortcuts and settings buttons to icon-only with tooltips, moved Archived toggle next to Filters, and removed the permanent "Space + drag to pan" hint (now in the keyboard shortcuts overlay). Added a reusable Tooltip component.

### Fixed
- Invite link join flow no longer requires a second click — authenticated users are joined automatically on arrival; OAuth users are joined immediately after provider redirect without landing on the Dashboard first; password login/register users are joined automatically when returned to the join page (#433)
- JSON and CSV importers now create weight change activity records for cards with non-default weights.
- Fixed OAuth callback URLs returning 404 in production — added Nginx proxy for /accounts/ allauth routes.
- Fixed N+1 query in CardSerializer — member ID and label lookups are now computed once per request instead of once per card.
- Fixed broadcast deferral in 6 card mutation actions — comments, attachments, and checklist writes now correctly use transaction.atomic() so WebSocket events only fire after commit.
- Fixed critical API reference errors — corrected wrong field names, added missing fields, and documented WebSocket event protocol.
- Fixed 5 documentation blockers — corrected version references, added security audit page to navigation, updated APP_VERSION example, and added SECURITY.md vulnerability reporting policy.
- Changed card update and move permission checks from block-list to allow-list pattern — new roles now default to denied rather than allowed.
- Replace bare `except Exception` with `except IntegrityError` in saved filter creation so programming errors are no longer swallowed as misleading duplicate-name responses.
- Added `ANALYTICS_EXTENSIONS` hook to `boards/hooks.py`. The `/summary/` endpoint now reads enterprise analytics panel extensions from this list instead of returning a hardcoded empty array, allowing enterprise to register additional panels without modifying OSS files.
- Fixed CardDetail panel accessibility: changed role from complementary to dialog with proper ARIA attributes and focus management.
- Fixed WebSocket event handlers firing redundant API calls on receiving clients for column delete, swimlane delete, and board update events.
- Fixed 4 API documentation inaccuracies: removed stale share_token and card_id fields, corrected due_before query param name, removed ghost must_change_username from admin docs.
- Added explicit permission classes to 7 views that previously relied on the global default.
- Fixed redundant board fetch in swimlane viewset, added select_related for archive/unarchive, and batched group membership queries to eliminate N+1.
- Fixed text-blue-400 color token misuse on Dashboard and GroupDetail action buttons, and migrated hand-rolled modals to ModalWrapper.
- Fixed ArchivedCardsPanel accessibility: added dialog role, ARIA attributes, focus management, and focus rings on interactive elements.
- Fixed spoofable client IP extraction in group invite audit logging and added missing username-change gate on group join endpoint.
- Introduced `BoardUserSerializer` with only `id`, `username`, `display_name`, and `avatar_url` to prevent private user fields (notification preferences, UI preferences, `can_access_all_content`) from leaking to other board members via board API payloads.
- Fix `card_count` annotation on the board list endpoint to exclude archived cards, so the count matches the number of cards actually visible on the board.
- Convert checklist item RBAC write checks from block-list to allow-list, consistent with the card update/move pattern fixed in #495, so future roles do not silently inherit write access.
- Added release-specific upgrade note to `docs/administration/upgrade.md` documenting the required pre-deploy SQL step for instances upgrading from any pre-1.0 release to 1.0.0, where `groups/0003_placeholder` must be manually inserted into `django_migrations` before running `manage.py migrate`.
- Wrap all broadcast `on_commit` calls in explicit `transaction.atomic()` blocks across `columns`, `swimlanes`, `labels`, `boards`, and `cards` views so broadcasts are always deferred and never fire synchronously when `ATOMIC_REQUESTS=False`.
- WebSocket deletion events (`card.deleted`, `column.deleted`, `swimlane.deleted`, `label.deleted`) now broadcast stable UIDs instead of integer PKs, locking in a consistent event schema before the 1.0 public contract.
- `Notification.action_type` no longer allows blank strings: a data migration backfills existing empty rows from verb content, the field constraint is tightened, and the TypeScript type is narrowed to a union of valid values.
- Document that `boards/0005` (Customer → Swimlane rename) requires a maintenance window (stop → migrate → start) when upgrading from any pre-1.0 release. Added a `!!! warning` callout to the "Upgrading to 1.0.0" section of the upgrade guide.
- Fix three N+1 query patterns: add `prefetch_related('labels')` to `GroupViewSet.get_queryset()` (#579); add the same prefetch plus annotations to the `subgroups` action queryset so each subgroup doesn't issue count and label queries separately (#580); add `select_related('column', 'swimlane')` to the card fetch in `CardViewSet.move` so `card.column.name/uid` and `card.swimlane.name/uid` don't each trigger a separate query when building the `CardMovement` record (#581). `SwimlaneViewSet._board_and_role()` double-call is already resolved by per-request caching (#382).
- Fix `PRIORITY_COLORS` mapping to match the design spec: low=blue-500 (#3B82F6), medium=orange-500 (#F97316), high=red-500 (#EF4444), urgent=red-700 (#B91C1C). Previous mapping had low=gray and medium=blue, causing inverted card borders and priority pills.
- Add focus-on-open to `OffboardingModal` so the close button receives focus when the modal appears, improving keyboard accessibility. Add `htmlFor`/`id` associations to `ForceChangePasswordModal` inputs for screen reader accessibility. Add 7 unit tests covering `ForceChangePasswordModal` happy path, validation, server errors, and fallback error handling.
- Fix permissions matrix: "Delete attachments" now correctly shows `Own` for Collaborator (not `✓`), matching the API enforcement that collaborators and members may only delete their own attachments unless they hold the moderator entitlement.
- Fixed `card.archived` WebSocket event to broadcast `card_uid` (string) instead of `card_id` (integer), consistent with all other removal events (#595)
- Fixed N+1 query in `GroupViewSet.members` — ancestor memberships now loaded in a single batched query (#602)
- Removed legacy plaintext `token` column from `group_invite_links` — all tokens now stored as SHA-256 hashes (#605)
- Fixed false Helm/gunicorn WebSocket warning in deployment docs — daphne is the default (#596)
- Added Invite Links tab documentation to admin panel reference (#597)
- Fixed board template count in feature index: eleven templates, not six (#598)
- Documented API versioning decision: no /v1/ prefix, explicit deprecation policy (#604)
- Fixed `BoardCell` background to `bg-slate-950`, restoring the three-level board depth (#599)
- Fixed `BoardCell` card layout from multi-column CSS grid to single-column vertical flex (#600)
- Fixed focus trap in `OffboardingModal` and `ConfirmDialog` — keyboard users can no longer Tab out of open modals (#601)
- Refactored JSON board import to use `bulk_create` — imports near the 500-card ceiling are now 10–20× faster (#603)
- Fix latent N+1 in `_card_queryset` by adding `column` and `swimlane` to `select_related`, and replace per-row `Card.objects.create()` loop in CSV import with `bulk_create` to reduce up to ~1,500 individual INSERTs to three bulk operations.
- Fix five pre-release performance blockers: analytics endpoint now filters cards to the analysis window instead of loading all-time history; archived cards endpoint is paginated (50/page with offset); CardViewSet caches board+role per request (eliminates 2–3 redundant board fetches per mutation); BoardFullSerializer.get_cards() reuses the prefetched labels queryset; SwimlaneViewSet.reorder acquires a row lock to prevent concurrent reorder races.
- Fixed share link URL generated by the `POST /api/boards/{id}/share/` endpoint — was missing the `/api` prefix, producing an unreachable URL.
- Added missing `notif_board_invite` field to the `User` TypeScript interface and `updateCurrentUser` API call.
- Collapsed column headers in the board view are now keyboard-accessible: focusable via Tab, activatable with Enter/Space.
- Theme and registration-mode radio groups now use native `<input type="radio">` inputs (sr-only) inside `<label>` containers, preserving arrow-key navigation for keyboard users.
- Added upgrade guide notes for `groups/0012` (plaintext token column drop) covering the required maintenance window.
- Fixed N+1 query on `GET /api/admin/users/` — owned boards are now loaded in a single query across the full page instead of one query per user.
- Unified dashboard modal patterns (CreateGroup, Join Group, Delete Board) — consistent label styling, button variants, focus rings, Enter key behavior, and footer layout.
- Re-raise `asyncio.CancelledError` in WebSocket ping loop for proper task cancellation propagation; use `[[` in shell scripts for safer conditional tests.
- Reduce cognitive complexity in admin views and permissions; extract duplicated event name and permission message constants in card and board views.
- Fixed analytics heatmap Age and Throughput modes showing identical values — throughput now counts only cards that exited a column during the period, not cards currently dwelling in it (#641)
- Fixed analytics heatmap showing a blank gap above the table in Age mode caused by an empty description line rendered between the toggle and the data (#641)
- Added tooltip and title text to the Age/Throughput toggle buttons and column headers in the analytics heatmap, explaining what each metric measures (#641)
- Expanded the "Template: Sales Pipeline" seed board from 5 swimlanes and 14 cards to 11 swimlanes and 99 cards, restoring the richness lost in a prior regeneration (#641)
- Increased movement history time spread in seed data (7–25 days per stage, up from 5–15) so the 90-day throughput analytics view shows data across all pipeline columns (#641)
- Fix two N+1 query regressions: `notify_new_mentions` now fetches `card.board` via `select_related` instead of a deferred FK hit, and `CardViewSet.update` scopes `refresh_from_db` to `fields=["version"]` to preserve the labels prefetch cache.
- Group write actions: extend `select_related` ancestor chain to all actions (not just `retrieve`) so `_require_group_admin` / `_require_group_member` avoid lazy parent FK queries on nested groups.
- Board import/create responses: re-fetch board with `_member_count`, `_card_count`, and `_is_starred` annotations before serializing, eliminating 3–4 fallback queries per response.
- Group board creation: replaced `group.labels.exists()` + iteration (2 queries) with `list(group.labels.all())` (1 query).
- `BoardFullSerializer`: site-admin users are now fetched once per `/full/` request and threaded through context, eliminating a duplicate `can_access_all_content` query.
- `CardMovementTimeline` now surfaces a visible error message instead of silently showing "No activity yet." when the card history API call fails; card-level movements endpoint now consistently passes request context to the serializer.
- Uploading a file whose name contains a double-quote character no longer causes HTTP 500 errors for all subsequent downloads of that attachment; the filename is now sanitized at upload time and again when the file is served (#682)
- Server-side enum validation added to `Board.allowed_priorities` — PATCH requests with invalid priority strings now return 400 instead of silently storing arbitrary values.
- Bumped `psycopg2-binary` to 2.9.11 and `django-allauth` to 65.14.3; verified `axios@1.14.0` lockfile is clean (no 1.14.1 supply-chain artefacts) (#687)
- Fixed redundant `card.refresh_from_db()` call in attachment upload that unnecessarily cleared the prefetch cache before `_refetched_card_data()`.
- Fixed `_card_count` annotation in group boards listing and descendant-boards endpoint including archived cards in the count, diverging from the board list view which correctly excludes them.
- Switch README pipeline and coverage badges to native GitLab SVG endpoints; batch notification action_type backfill migration with `iterator(chunk_size=500)` + `bulk_update` to avoid long table locks on large production instances.
- Fix analytics endpoint issuing a live swimlane query on every request — swimlanes are now loaded into a list before the loop, consistent with how columns and the summary endpoint already handle it.
- Assigning a card to a board member now requires Moderator or Admin access; members without this role see the assignee dropdown disabled with an explanatory tooltip, and receive a clear 403 message if they reach the API directly.
- The Moderator tooltip in Board Settings → Members now lists all three entitlements: assign, edit, and delete/archive cards created by other members.
- The `SelectDropdown` component gained a `disabledReason` prop so any disabled dropdown can surface a contextual explanation, and its disabled opacity was corrected to match the design system.
- Eliminate two redundant queries per board request: board memberships are now prefetched alongside the board load so get_members() reads from cache; is_starred on mutation responses now uses the already-prefetched favorites list instead of issuing a live EXISTS query.
- Add partial DB index on User.can_access_all_content — reduces the site-admin lookup on every board page load from a full user table scan to an index scan covering only the tiny set of users with that flag set.
- Fixed Escape key not closing the card detail panel. The root cause was that `ModalWrapper` (used for the delete/archive confirmation dialog embedded inside the panel) registered its `useEscapeStack` handler at priority 40 even when `open=false` — silently consuming every Escape and preventing the panel-close handler at priority 30 from firing. The handler now returns `false` when the modal is not open, allowing the event to pass through. Additionally fixed Escape not working when the description rich-text editor is in edit mode: the editor's `onKeyDown` handler was calling `stopPropagation()` for all keys including Escape, which prevented the event from reaching the document-level listener. Pressing Escape while editing now exits edit mode first; a second press closes the panel.
- Fixed the `benchmark.py` management command's `_bench_summary` function to call the real `BoardViewSet.summary()` view via `APIClient.force_authenticate()` instead of reimplementing a partial subset of the summary logic. The old implementation only exercised 2 of the ~7 queries the actual endpoint runs, so N+1 regressions in the summary endpoint went undetected. The per-benchmark query budget has also been corrected from 6 to 10 to match `SummaryQueryCountTests.BUDGET`.
- Fixed `frontend/.env.local` leaking into Docker builds when images are built locally, causing `VITE_API_URL=http://localhost:8000` to be baked into the bundle and breaking WebSocket connections for all non-localhost clients. Added explicit `.env.local` exclusions to `.dockerignore` and `.gitignore`, created `frontend/.env.local.example` documenting all three deployment scenarios, and added the missing `/accounts/` OAuth callback location to the Helm nginx ConfigMap.
- ---
- Fixed label and checklist items not appearing in card history on imported boards. Both JSON and CSV import paths now emit `LABEL_CHANGE` and `CHECKLIST_ITEM_ADDED` activity records, consistent with the live card update path.
- JSON board export now includes `archived_at` per card and `schema_version: 2`. Import restores archived card state, movement `movement_type` and `notes`, and comment timestamps — achieving full round-trip fidelity for JSON. CSV import/export remains intentionally limited.
- Fix N+1 query pattern on the archived cards endpoint and the group boards listing endpoint.
- Fix member card edit ownership gate and optimize bulk_update for column/swimlane reorder, `.only()` on site-admin user query, and prefetch-cache usage in stale card notifications.
- Fixed N+1 on label write endpoints — `LabelViewSet` now caches the board/role lookup per request, matching the pattern used by `ColumnViewSet` and `SwimlaneViewSet`.
- Fixed N+1 in `AdminUserDeactivateView` transfer validation — transfer target users and boards are now bulk-fetched in two queries before the validation loop instead of one query per entry.
- Fix card search 500 regression (slice after OrderingFilter), archive/unarchive deferred board FK hit, redundant Label query in card serializer context, Notification.action_type TypeScript type (removed stale empty-string member), and API docs gaps (moved_by_id filter, analytics age/throughput fields, card status endpoint, archived cards pagination, move OCC version field, swimlane fields, groups descendant-boards endpoint).
- Fixed group members endpoint exposing full user PII (email, notification preferences, admin flags) to all group members — now returns the same narrow `BoardUser` shape used by board membership endpoints (#549)
- Fixed `_require_group_admin` and `_require_group_member` issuing one database query per ancestor group level — now batches into a single query (#545)
- Fixed missing `groups/migrations/0003` sequence gap with a documented placeholder migration (#550)
- Pinned `drf-spectacular==0.29.0` in `backend/requirements.txt` for reproducible builds (#555)
- Introduce `/api/v1/` URL path versioning across all endpoints; add `OffsetCountPagination` with a unified `{count, offset, page_size, results}` envelope; add `owner` field to `BoardFullSerializer`; fix unbatched migration backfill in `0040`; pin axios to `1.14.0` and add override to block malicious `1.14.1`; update all docs, tests, and frontend API clients to reflect the new paths and pagination shape.
- Fixed `board.md` incorrectly documenting `exclude_type=archived,restored` — correct value is `archived,unarchived` (#553)
- Fixed invite-only registration mode described as admin-created accounts in two admin pages (#554)
- Fixed `GET /api/auth/providers/` docs missing `oidc` and `oidc_name` fields (#526)
- Fixed `GET /api/boards/{id}/summary/` docs missing `active_cards`, `done_30d`, `avg_cycle_days`, and `extension_panels` fields (#526)
- Fixed card list filter docs: added 5 undocumented params, removed non-existent `?label=` param (#526)
- Fixed admin users list response docs missing `can_access_all_content`, `has_completed_tour`, and `owned_boards` fields (#551)
- Fixed admin deactivate endpoint docs incorrectly stating transfer recipients must be direct board members — group-inherited membership is also accepted (#552)
- Fixed CardDetail delete/archive confirmation overlay missing dialog accessibility semantics — now uses `ModalWrapper` with proper `role="dialog"`, focus trapping, and Escape handling (#546)
- Fixed GroupDetail transfer ownership and delete group modals missing dialog accessibility semantics (#483)
- Fixed CardItem recently-moved dot violating three design system rules: corrected size (`w-2`), color token (`bg-blue-500`), and visibility behavior (#547)
- Removed phantom `BoardMovement` TypeScript interface and consolidated to `CardMovement`; removed non-existent `card_id` field from movement types (#548)
- Security, performance, and correctness fixes from the pre-release Wave 1 audit:
- Use `can_access_all_content` (not `is_site_admin`) in `get_accessible_group_ids()` to match the documented privilege model
- Gate OpenAPI schema endpoints (`/api/schema/`) to authenticated users
- Add 64 KB size limit on `state_json` in saved filters to prevent unbounded storage growth
- Create `BoardMembership` row for owner when a board is created inside a group
- Use `_prefetched_memberships` cache in `get_board_role()` and `_get_effective_member_ids()` to eliminate redundant membership queries per request
- Pass `_member_ids` and `_board_labels_qs` context in `_refetched_card_data()` to avoid 2–4 extra queries per card mutation response
- Use label prefetch cache for label-name lookups in `CardViewSet.update()` (eliminates 2 live DB queries per card edit)
- Use `bulk_create` for columns, swimlanes, and labels in both JSON and CSV board imports (was one INSERT per object)
- Add `prefetch_related("checklist_items")` to checklist GET card fetch
- Add structured `logger.warning()` on board access denial for security observability
- The "Member + Moderator" entry in the role permissions popup is now labeled "Member (moderator flag)" to make clear it is a flag on the Member role rather than a separate role, and its description now includes "— ask an admin to enable" so occasional users know how to request the permission.
- Fixed the Analytics view showing all dashes in the 7-day and 30-day Throughput windows after a board had been seeded more than 30 days ago. Movement timestamps in `seed_demo_data.py` and `seed_template_boards.py` were anchored to a hardcoded date; they are now generated relative to today so re-seeding always produces data within the active analytics windows. The static anchor is retained only on the `--export` path used by CI to keep fixture files stable.
- Fixed SonarCloud scan error caused by `**` wildcards in `sonar.tests` — moved glob filtering to `sonar.test.inclusions` which supports wildcards; `sonar.tests` is now a plain directory list.
- WebSocket connections in the production Docker Compose stack are now reliable — nginx renders its config from a template at startup (no pre-generated host file required) and uses a proper `connection_upgrade` map, so real-time board updates are delivered correctly without manual setup steps.
- Real-time board updates (card moves, column changes) are now delivered correctly to all connected users in production Docker deployments — the WebSocket no longer falls back to `localhost` when the app is served from a non-localhost origin.

### Security
- Harden auth surface: reject PATs for deactivated users, enforce Django password validators on password change and admin user creation, fix X-Forwarded-For trust model in admin IP middleware, add explicit login brute-force rate limits.
- Tighten Django lower bound to `>=5.2.12` (CVE-2025-64459, CVSS 9.1) and pin axios to exact version `1.13.6` (removes `^` caret to prevent automatic upgrade to the compromised `1.14.x` line).
- Confirm `_validate_upload_mime` rejects `text/plain`/`text/csv` files containing HTML or script markers; add regression tests and Content-Disposition assertion for media downloads.
- Replace `CurrentUserSerializer` denylist test with an allowlist test so any new field added to the serializer requires an explicit writable/read-only decision.
- Fix stored XSS in card description view mode by composing `rehype-sanitize` after `rehypeRaw` in `RichTextEditor`. Raw HTML is now sanitized against an allowlist that preserves only the `color:` style values written by the Tiptap Color extension.
- Resolved SAST/SonarQube security findings: removed hardcoded DATABASE_URL from docker-compose.yml, stopped logging the generated admin password via logger.warning (now written to stdout only), replaced hardcoded benchmark password with secrets.token_urlsafe, fixed ReDoS-vulnerable regex in join token extraction, corrected /app/media ownership in Dockerfile.prod, and tightened .dockerignore. Updated SonarQube suppression rule keys for CI YAML findings (#639).
- Fixed a TOCTOU race in `ensure_site_admin` where the password file was briefly world-readable between creation and `chmod`; the file is now created with `0o600` permissions atomically via `os.open`.
- UserSearchView: removed `email__icontains` filter to prevent silent email-existence oracle for authenticated callers.
- Added HTTP security headers: `SECURE_HSTS_SECONDS`, `SECURE_CONTENT_TYPE_NOSNIFF`, `X_FRAME_OPTIONS`, and `SECURE_REFERRER_POLICY`. HSTS is configurable via env var for operators who need a staged rollout.
- Removed `staleness_threshold_days` from `PublicBoardSerializer` — this internal config value was visible to anonymous share-link visitors and is not needed client-side.
- Add `O_NOFOLLOW` flag to `ensure_site_admin` password-file write to prevent symlink attacks in world-writable `/tmp`.
- Bumped `requests` 2.32.4 to 2.33.0 (CVE-2026-25645) and `cryptography` 46.0.5 to 46.0.6 (CVE-2026-34073).
- Add `.dockerignore` files and non-root user to backend Dockerfiles to prevent sensitive files from being copied into images and reduce container attack surface.
- Fix stored XSS in RichTextEditor: sanitize HTML output via rehype-sanitize, blocking script injection through card descriptions and comments. Also bump picomatch and brace-expansion to patch CVEs GHSA-3v7f-55p6-f55p, GHSA-c2c7-rcm5-vvqj, and GHSA-f886-m6hf-6m8v.
## [1.0.0-rc.10] — 2026-03-29

### Added
- Functional test coverage for group board defaults, invite link expiry/limit, cascade deletion of attachments and group invite links, management commands (ensure_site_admin/set_site_admin), token hash backfill, board movements and templates endpoints, and query count budgets for group members and notifications (#404, #405, #407, #408, #409, #410)
- Getting-started onboarding tour for new users — a 4-step contextual tooltip walkthrough that triggers the first time a user opens a board, introducing swimlanes, card movement, the audit trail, and the filter bar; dismissing or completing the tour sets a persistent server-side flag so the user is never interrupted again; admins can reset the flag from the admin panel (#337)
- Moderator entitlement — board admins can grant any member the "moderator" flag from Board Settings → Members, allowing them to delete and archive content created by other users without full admin access; the flag is automatically revoked when a member is demoted to collaborator or viewer (#362)
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
- Board deletion now emits a structured `INFO` log (`board.deleted board_id=… board_name=… deleted_by=… deleted_by_username=…`) before the row is removed, providing an application-level audit trail for irreversible operations (#426)
- Security test coverage: cross-board IDOR tests for cards, comments, and attachments (#399); unauthenticated access rejection tests for all core endpoints (#401); file size limit enforcement tests for the attachment upload endpoint (#400)
- Tests for group ownership transfer endpoint covering success, non-member, non-owner, self-transfer, and wrong confirmation paths (#402)
- Tests asserting `raw_token`, `token`, and `token_hash` are absent from group invite link list responses (#403)
- Tests for ChangePasswordView PAT revocation — password change deletes all tokens, revoked tokens cannot authenticate, other users' tokens are unaffected (#406)
- Tests for ServeMediaView non-member access (404, not 403) and path traversal rejection (#411)
- Functional rate limit test verifying 429 response after exceeding throttle limit, plus throttle wiring assertions (#412)
- Enforce case-insensitive username uniqueness — a PostgreSQL functional index now prevents `Kelly` and `kelly` from coexisting. Existing collisions are resolved automatically by the migration (winner keeps username, losers pick a new one via a non-dismissable modal on next login). A new `POST /api/auth/choose-username/` endpoint lets affected users (and API/PAT clients) set a new username.
- Users now receive a notification when they are added to a board — the notification appears in the bell dropdown and respects a new "Board invites" preference in Settings → Notifications (default: on)

### Changed
- CI default job setting changed from `interruptible: true` to `interruptible: false` — main-branch pipelines were being silently canceled when two MRs landed in quick succession; `workflow: auto_cancel: on_new_commit: interruptible` preserves the optimisation on feature branches for any job that opts in
- `boards/views.py` split into a `boards/views/` package with 14 focused modules — backward-compatible re-exports in `__init__.py` keep all existing imports working (#423)
- `CardItem` and `BoardCell` components are now wrapped in `React.memo` to skip re-renders when props are unchanged — `CardItem` uses a custom comparator that checks card fields by value rather than reference; `moveCard`, `forceMoveCard`, `reorderColumns`, `reorderSwimlanes`, and `updateBoardSettings` callbacks in `useBoard` are stabilized via `useRef` so their identity no longer changes on every board state update (#422)
- Card delete, archive/unarchive, and comment delete are now ownership-gated — members can only perform these actions on content they created; admins, site admins, and members with the moderator entitlement can act on any content; cards with a null creator (deleted users) can only be managed by admins or moderators (#362)
- Board export (`GET /api/boards/{id}/export/`) now requires member or admin access — viewers and collaborators receive `403 Forbidden` with a descriptive error message (#362)
- Sample board files relocated from `backend/boards/seed_data/` to a top-level `sample-boards/` directory for discoverability — all 11 templates (10 domain-specific + 1 demo board) now ship as ready-to-import JSON and CSV files at the repo root with a README documenting the import flow
- All 10 template boards expanded from 5 swimlanes / ~12 cards to 10–11 swimlanes / 110–121 unique cards with theme-appropriate content, movement history, activities, labels, checklists, and comments; demo board expanded from ~80 to ~120 unique cards with no duplicate titles
- Clicking the crosshair (focus) button on an already-focused swimlane now toggles focus mode off; Escape key and the banner "Exit focus" button remain as alternative exit paths; the button now carries `aria-pressed` for screen reader accessibility (#363)
- Comprehensive documentation review: rewrote 17 doc files to match current codebase — corrected analytics color-coding table (was using old 2× median heuristic), fixed `card.archived` WebSocket payload (was showing full card, code sends `card_id` only), added 12 missing event types to realtime docs, added 15+ missing fields/entities to data model docs, documented `is_site_admin` vs `can_access_all_content` split in RBAC docs, added missing feature docs for saved filters, board templates, hard WIP enforcement, text color picker, @mentions in descriptions, collapsed rail flyouts, and more
- Board sub-nav tabs (Board / Summary / Analytics) are now URL-addressable — switching tabs updates the `?view=` search param with `{ replace: true }` so the browser Back button skips tab transitions and tab views can be bookmarked and shared (#332)
- Analytics heatmap column headers no longer show per-column median values; coloring is now driven by the board-level stale threshold.
- Board Settings stale card section renamed from "Stale card threshold" to "Stale card settings" with a second input for the warning percentage.
- Card mutation endpoints (create, comment, checklist, attachment, label, archive) now re-fetch the card through the prefetch pipeline before serializing — eliminates N+1 queries for labels, attachments, checklist items, and movements on 8 response paths (#379)
- `_can_modify_others_content` now uses a cached membership from `get_board_role()` instead of issuing a separate database query on every ownership check (#381)
- `notify_stale_cards` management command rewritten to batch queries — user opt-in lookup, idempotency check, and notification creation are now O(boards) instead of O(cards x users); uses `bulk_create` for notifications and prefetch-aware movement access (#380)
- CI pipeline hardened for 1.0: `interruptible: true` cancels redundant pipelines; cache policy split (pull on MR, pull-push on main via dedicated warm jobs); Ruff uses native `--output-format=gitlab` instead of a custom Python converter; trivy and SAST component versions pinned; GitLab Secret Detection catalog component added; backend tests sharded across 3 parallel jobs via pytest-split; docs auto-deploy on version tags; Docker images tagged with version on release; release script uses `--notes-file` for reliable release note formatting; demo seed job declares `deployment_tier: staging` for environment protection (#390)
- Personal Access Tokens settings page now displays "Never" instead of a dash for tokens with no expiry date, making the non-expiring state immediately legible; expiry field now shows inline helper text ("Leave expiry blank for a non-expiring token (max 1 year if set)") so users understand the optional nature of the field without visiting docs
- 13 checklist-style Claude Code agents (changelog, rbac-check, broadcast-check, migration-check, perf-check, perf-bench, dependency, duplicate-check, enterprise-check, test-scaffold, api-docs, docs, ux-review) now run on Sonnet; architect, security-review, and `/mr` remain on Opus and delegate parallel research phases to Sonnet sub-agents before synthesizing results
- New `ux-design` agent proposes concrete UI layout, component composition, interaction flow, and state handling before implementation — runs on Opus with 3 parallel Sonnet sub-agents for research; workflow order is now `architect` → `ux-design` → implement → `ux-review`
- Changelog workflow now uses fragment files in changelog.d/ instead of direct CHANGELOG.md edits — eliminates merge conflicts between concurrent branches

### Fixed
- Site-wide invite links (`vbnl_…`) now correctly route through registration — `JoinPage` detects the `vbnl_` prefix, stores the token in `sessionStorage`, and redirects to the register page; `LoginPage` reads and submits it on registration then clears it from storage
- `get_accessible_group_ids()` now walks up the group hierarchy as well as down — a member of a subgroup can now see and navigate to ancestor groups in the sidebar
- Group membership now implies access to all boards in that group — a separate `BoardMembership` record is no longer required for boards that belong to a group the user is a member of
- `useViewPrefs` now prunes stale column and swimlane IDs from `localStorage` on load — deleted columns or swimlanes no longer leave phantom hidden/collapsed state
- Entering swimlane focus mode now also expands all columns and snapshots column collapse state for restoration on exit; switching focus to a different swimlane no longer overwrites the original pre-focus snapshot
- Collapse/Expand toolbar button now toggles both columns and swimlanes together; clicking it while in focus mode first exits focus
- Site Admin sidebar link changed from `<a href>` (full reload) to React Router `<Link>` (SPA navigation)
- JSON board export now includes `movements` and `activities` arrays in each card object — previously export → import round-trips silently dropped all movement history and activity log entries, causing weight changes and other field-change events to disappear from the card timeline (#434)
- Board sub-nav toolbar no longer jumps when switching between Board / Summary / History / Analytics views — the Board toolbar had `h-10 mt-2` (40px + 8px margin) while the other views used `py-1.5`; all views now use the same `py-1.5` padding (#432)
- Avatar color palette unified to `-600` tones across the entire frontend — `Avatar.tsx` updated from `-500`, `CardDetail.tsx` inline `AVATAR_PALETTE` (`-700` tones) removed in favor of the shared `Avatar` component, and `BoardSettingsModal.tsx` hardcoded `bg-blue-700` circles replaced with `<Avatar>` (#428)
- Admin invite link panel now displays and copies the full join URL (`/join/<token>`) instead of the raw token — the raw token alone was unusable as a shareable link
- Standardized form input styling across the entire frontend to match the design system spec — replaced ad-hoc `rounded-lg`, `py-2`, `text-white`, `bg-slate-900`, `focus:border-*` variants with consistent `rounded`, `py-1.5`, `text-slate-300`, `bg-slate-800`, `focus:ring-2 focus:ring-blue-500` across Settings, Login, modals, card detail, filter bar, and admin pages (#429)
- `RegistrationEndpointToggleTests` now invalidates the registration-mode cache in `setUp()` — previously a stale LocMemCache entry from `test_registration_blocked_when_closed` survived the transaction rollback, causing `test_registration_allowed_when_open` to see "closed" mode and fail with 403
- `CardSerializer` now scopes `label_ids` and `assignee_id` querysets to the current board — previously both used unscoped querysets (`Label.objects.all()` / `User.objects.all()`), allowing cross-board label assignment and assignment of non-member users (#416)
- JSON board import now resolves assignee, moved_by, and actor usernames via a single bulk query instead of one query per card — eliminates N+1 queries that scaled linearly with card count (#420)
- WebSocket connections now include a server-side keepalive ping every 30 seconds — NATs and reverse proxies can no longer silently drop idle connections; the frontend detects a missing ping within 45 seconds and automatically reconnects, so the "Live" indicator accurately reflects connection state (#425)
- Added missing `focus:outline-none focus:ring-2 focus:ring-blue-500` focus rings to ViewToggle buttons, color swatch buttons in AddColumnModal and AddSwimlaneModal, BoardSettingsModal close button, MoveBlockedToast dismiss and override buttons, and notification items in the bell dropdown; added missing `accent-blue-600` to CheckboxDropdown checkboxes (#430)
- All 11 seed data JSON export files now include `is_done` on terminal columns — previously the field was omitted from exports, causing imported boards to lose done-column marking and breaking analytics dwell-time exclusion and stalled-card detection
- Demo board seed data no longer produces duplicate card titles — expanded title pool from 82 to 129 entries and replaced modulo-wrap index with a break guard that stops card generation when titles are exhausted
- Public share endpoint now enforces rate limiting (120 req/hour per IP via `ShareLinkThrottle`) — previously `throttle_classes` was empty, leaving the unauthenticated endpoint unprotected against scraping (#348)
- Public board serializer now includes `staleness_threshold_days`, `is_stale`, and `last_moved_at` on each public card using prefetched movement history — previously all three fields were missing from the share endpoint response (#348)
- Toggling a board's share link now broadcasts a `board.updated` event to connected clients so the share token state updates in real time without a page refresh (#348)
- `CardMovementSerializer` now exposes `card_uid` and `card_title` so the board-level history view can identify cards without secondary API calls (#342)
- `ShareBoardPage` swimlane rows now use `<Fragment key={...}>` instead of shorthand `<>` — the shorthand syntax cannot carry a `key` prop, causing React key warnings on multi-swimlane boards (#348)
- Board templates now correctly mark terminal columns as `is_done=true` (e.g. "Approved" in Legal & Compliance) and set `allow_card_creation=true` on the single intake column only — previously `is_done` was missing from seed data and multiple columns had card creation enabled
- Legal & Compliance template "Archived" column renamed to "Closed" to avoid confusion with the card archive function; Project Delivery template now ends with a "Done" column marked `is_done=true` instead of "Retro"
- Sub-resource permission checks (comments, attachments, checklists) now include inline comments explaining that collaborators are intentionally allowed — resolves ambiguity between the viewer-only block pattern used on sub-resources and the allow-list pattern used on card endpoints (#418)
- `movement_type` value `"restored"` renamed to `"unarchived"` to match the rest of the codebase (`/unarchive/` endpoint, `unarchiveCard` API call, "Unarchive" button); the Archived cards panel button label updated from "Restore" to "Unarchive" accordingly
- Pressing Escape on the Analytics view now returns directly to the Board view — previously it navigated to Summary first, requiring a second Escape press (#360)
- Added targeted regression test asserting heatmap column headers and cell values always render in `AnalyticsView`, preventing the recurring silent regression where the table disappears without failing the test suite (#361)
- Login page and join-invite page now render an SSO button for OIDC-only installs — the OAuth section gate previously excluded OIDC from its visibility condition, so the button was never shown even when OIDC was the only configured provider; the button label uses the configured `oidc_name` value (falls back to "SSO")
- Checking or unchecking a checklist item now immediately updates the `✓ done/total` count on the card tile in the board view — previously the count was calculated from a stale delta that could produce a wrong value or revert on rapid successive checks (#330)
- Board JSON export now omits swimlane `contact_email` and `notes` for non-admin roles — previously the export endpoint included PII regardless of the requesting user's role, inconsistent with the `SwimlaneSerializer` vs `SwimlaneAdminSerializer` split used elsewhere (#417)
- `removeColumn` in `useBoard` now rolls back optimistic state on API failure — previously a failed `deleteColumn` call left the column permanently removed from the UI until page reload (#413)
- Board columns are now expanded by default on every initial view — including imported boards, template-created boards, and newly-added columns — eliminating cases where columns appeared collapsed until a user interaction or page effect fired
- Space+drag board panning re-attaches event listeners after switching between Board, Summary, and Analytics views — previously the hook captured a stale DOM reference on first mount and lost pan mode whenever the scroll container remounted
- "Move to" popover in the card detail panel now renders as a fixed-position overlay so it is no longer clipped by the panel's `overflow-hidden` container
- Board template seed data no longer produces duplicate cards when the generator script is run multiple times — `extra_cards` is now the sole source of truth and the output is idempotent; Sales Pipeline swimlanes renamed from company names to sales regions (North America, APAC, EMEA, LATAM, ANZ)
- Collapsed sidebar no longer renders an unbounded list of board icons — starred boards, starred groups, and personal boards are now accessible via two flyout panels (Favorites ★ and Personal boards) that open on click, cap at a scrollable max height, and show board names; active-board state is reflected on the trigger icon
- Creating a board inside a group now respects the `template` field from the request — previously the group board creation endpoint ignored the chosen template and always applied the default Backlog/To Do/Doing/Done columns
- Groups flyout panel in the collapsed sidebar now shows subgroups indented under their parent at the correct nesting depth — previously all groups appeared at the same visual level because the flyout read from the flat groups array instead of the sidebar tree
- BoardView layout containers now use flex wrappers instead of fragments, eliminating layout shifts when transitioning between empty, loading, and ready states
- `board.updated` and `board.deleted` WebSocket events are now handled in `handleSocketEvent` — previously both were silently ignored, so board setting changes and deletions by other users were invisible until a page refresh (#415)
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
- `MustNotHavePendingPasswordChange` permission was silently dropped by every viewset that declared explicit `permission_classes = [IsAuthenticated]`, allowing users with a forced password-change flag to access the full API — views now inherit `DEFAULT_PERMISSION_CLASSES` instead of overriding them; `ChangePasswordView` is the only endpoint that intentionally omits the gate (#414)
- `BoardViewSet.perform_create` now wraps board, membership, column, and swimlane creation in `transaction.atomic()` — previously a failure during swimlane creation left orphaned board and column records in the database (#419)
- Invite link join flow no longer requires a second click — authenticated users are joined automatically on arrival; OAuth users are joined immediately after provider redirect without landing on the Dashboard first; password login/register users are joined automatically when returned to the join page (#433)

### Security
- `delete_attachment` now enforces the same ownership gate as `delete_comment` — members can only delete their own attachments unless they have the moderator entitlement; previously any member-role user could delete attachments uploaded by other members (#378)
- `CurrentUserView`, `PersonalAccessTokenListCreateView`, and `PersonalAccessTokenDeleteView` now declare explicit `permission_classes = [IsAuthenticated]` instead of relying on the global default — prevents accidental exposure if default permissions are changed (#376)
- `GroupViewSet.boards` now filters returned boards by the requesting user's board-level membership — previously any group member could see metadata for all boards in the group regardless of their per-board access (#377)
- Text file uploads (CSV, plain text) are now rejected if the first 4 KB contains HTML/script markers (`<script>`, `<svg>`, `<html>`, `<iframe>`, `<!DOCTYPE>`) — prevents stored XSS via polyglot files (#372)
- `ServeMediaView` now sets explicit `Content-Type` from the stored filename and forces `Content-Disposition: attachment` for all non-image file types — prevents browsers from rendering uploaded PDFs, CSVs, or text files inline as HTML (#372)
- Group invite link tokens are now hashed (SHA-256) before storage — plaintext tokens are never persisted; the raw token is returned exactly once at creation time. Existing tokens were backfilled via data migration. The deprecated `token` column is retained for one release cycle (#373)
- Removed `static()` media URL fallback from urlconf — the fallback bypassed `ServeMediaView` authentication, allowing unauthenticated access to uploaded files via the development server (#374)
- Auth failure logging (401/403) is no longer suppressed — `django.request` WARNING entries now include failed authentication attempts so operators can detect brute-force patterns (#374)
- `PATAuthentication` now updates `last_used_at` on every successful authentication, enabling operators to identify unused tokens for rotation (#375)
- Analytics `days` query param is now capped at 365 and `stalled_days` at 90 — prevents unbounded date-range queries that could degrade database performance (#375)

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
