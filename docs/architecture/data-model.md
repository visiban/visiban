# Data Model

## Core entities

```
User
 ├── is_site_admin (bool — grants access to the admin panel)
 ├── can_access_all_content (bool — read/write access to all boards and groups, independent of is_site_admin)
 ├── must_change_password (bool)
 ├── must_change_username (bool — set when a CI collision renames the account)
 ├── close_editor_on_enter (bool — submit new-card input on Enter; default true)
 ├── default_board → Board (nullable — post-login redirect target)
 ├── timezone (str)
 ├── date_format (str)
 ├── time_format (str)
 ├── number_locale (str)
 ├── notif_card_assigned (bool, default true — notify when a card is assigned to this user)
 ├── notif_mentioned (bool, default true — notify on @mention in card description)
 ├── notif_due_soon (bool, default false — notify when a card's due date is approaching)
 ├── notif_card_moved (bool, default false — notify when a card is moved)
 ├── notif_comment_added (bool, default false — notify when a comment is added to an assigned card)
 ├── notif_board_invite (bool, default true — notify when added to a board)
 └── has_completed_tour (bool, default false — whether the user has completed the onboarding tour)

Group
 ├── owner → User
 ├── parent → Group (nullable — null = top-level)
 ├── GroupMembership → User  (role: admin | member | collaborator | viewer)
 ├── GroupInviteLink  (name, token, role, expires_at)
 └── GroupFavorite → User  (unique per user+group)

Board
 ├── uid  (16-char hex, unique, read-only)
 ├── owner → User
 ├── group → Group (nullable — null = personal board)
 ├── enforce_wip_limits (bool — block moves into over-limit columns; default true)
 ├── enforce_wip_hard (bool — hard-block mode with no admin override; default false)
 ├── enforce_weight_limits (bool — block moves that exceed column weight budget; default true)
 ├── description (text, optional — board description; blank = no description)
 ├── staleness_threshold_days (int, default 7 — number of days without card movement before a card is considered stale)
 ├── stale_warning_pct (int 0–100 — yellow threshold for analytics heatmap; default 50)
 ├── allowed_priorities (JSON — restricts available card priorities; empty = all allowed)
 ├── share_token (UUID, nullable — public read-only share link; null = sharing disabled)
 ├── BoardMembership → User  (role: admin | member | collaborator | viewer)
 ├── BoardFavorite → User  (unique per user+board)
 ├── Column  (uid, position, color, wip_limit, weight_limit, allow_card_creation, is_done)
 ├── Swimlane  (uid, position, color, is_collapsed)
 └── Label  (uid, name, color)

Card
 ├── uid  (16-char hex, unique, read-only)
 ├── board → Board
 ├── column → Column
 ├── swimlane → Swimlane
 ├── title (str, max 500 chars)
 ├── description (text, optional)
 ├── priority (str — low | medium | high | urgent; default medium)
 ├── due_date (date, nullable)
 ├── weight (int, default 1 — used for column weight budget enforcement)
 ├── position (int — sort order within the cell)
 ├── created_by (→ User, nullable — set to null if the creator account is deleted)
 ├── version (int, default 1 — optimistic concurrency control; incremented on every mutation; clients send the version they have; 409 returned if the card has been modified in the meantime)
 ├── assignee → User (nullable)
 ├── labels → Label (M2M)
 ├── archived_at (datetime, nullable — soft-delete timestamp; null = active)
 ├── mentioned_user_ids (JSON — dedup guard for @mention notifications)
 ├── CardMovement  (from/to column + swimlane FKs + UIDs + names, moved_by, moved_at, movement_type)
 ├── CardComment  (author, body)
 ├── CardActivity  (event_type, from_value, to_value, actor)
 ├── CardChecklist  (text, is_checked, position)
 └── CardAttachment  (file, filename, size, uploaded_by)

BoardTemplate
 ├── id (UUID)
 ├── name (str)
 ├── slug (str, unique)
 ├── description (str)
 ├── icon (str)
 ├── lane_label (str — e.g. "Account", "Project")
 ├── lane_placeholder (str — placeholder for the first-swimlane name input)
 ├── columns_json (JSON — ordered list of column dicts)
 ├── sort_order (int)
 └── is_active (bool)

SavedFilter
 ├── user → User
 ├── board → Board
 ├── name (str)
 ├── state_json (JSON — serialized FilterState: search, assigneeIds, labelIds, priorities, dueDate)
 └── unique_together: (user, board, name)

Notification
 ├── recipient → User
 ├── actor → User (nullable — the user who triggered the notification)
 ├── action_type (str — assigned | mentioned | card_moved | stale | board_invite)
 ├── verb (str — human-readable summary)
 ├── card → Card (nullable)
 ├── board → Board (nullable)
 └── read (bool)

InviteLink  (accounts app — site-level registration invites)
 ├── token_hash (str, unique — SHA-256 hash; raw token shown once at creation)
 ├── prefix (str — first 8 chars of raw token, safe for display)
 ├── created_by → User (nullable)
 ├── expires_at (datetime, nullable — null = never expires)
 ├── single_use (bool)
 ├── used_at (datetime, nullable)
 ├── revoked_at (datetime, nullable)
 └── use_count (int, default 0 — incremented on every successful registration, preserved after revocation)
```

## Entity details

### User

The `is_site_admin` flag grants access to the Visiban admin panel (user management, site settings). It does **not** grant access to boards or groups. The separate `can_access_all_content` flag grants read/write access to every board and group on the instance regardless of membership. The two flags are independent and can be combined.

`default_board` is a foreign key to `Board` with `on_delete=SET_NULL`. After login, the frontend redirects to this board if set. The frontend verifies access before redirecting to prevent an IDOR leak via a stale FK.

`close_editor_on_enter` controls whether pressing Enter in the new-card inline editor submits and closes the editor (default true). Shift+Enter always inserts a newline regardless of this setting.

The `notif_*` boolean fields store per-user notification preferences. Each flag maps to one `action_type` on the `Notification` model. Defaults follow the principle of least surprise: events directly targeting the user (`card_assigned`, `mentioned`, `board_invite`) are on by default; ambient events (`due_soon`, `card_moved`, `comment_added`) are off by default to avoid noise. Users can change preferences from their profile settings page.

`has_completed_tour` is set to true the first time the onboarding tour completes. The frontend reads this field on login and skips the tour for returning users.

### Board

`enforce_wip_limits` (default true) blocks card moves into a column that is at or over its WIP limit with a 409 response. Board admins can override with `?force=true`. When `enforce_wip_hard` is also true, the limit becomes a hard stop for all roles including admins — no override is possible.

`enforce_weight_limits` (default true) blocks card moves into a column that would exceed its weight budget. Like WIP limits, board admins can override unless hard mode is active.

`stale_warning_pct` (default 50, range 0--100) controls the yellow warning band in the analytics heatmap. At this percentage of `staleness_threshold_days` the heatmap cell turns yellow; at 100% it turns red.

`allowed_priorities` is a JSON list. When non-empty, it restricts which priority values are available for cards on this board. An empty list means all priorities (`low`, `medium`, `high`, `urgent`) are allowed.

`share_token` is a UUID generated when a board admin enables public sharing. When set, the board is accessible at `/share/:token` as a read-only view with no login required. Setting the token to null disables sharing immediately.

### Column

`is_done` marks a column as a terminal/completion column (e.g. "Done", "Closed Won"). Columns marked as done are excluded from analytics dwell-time calculations — a card's clock stops when it enters a done column. Multiple done columns per board are supported.

### Card

`archived_at` is a nullable datetime used for soft-delete. When set, the card is hidden from the board view and drag-and-drop but can be restored from the Archived panel. Analytics uses `archived_at` as the terminal timestamp so dwell time reflects only the active period. Archived cards are excluded from WIP and weight counts.

`mentioned_user_ids` is a JSON list of user PKs. It serves as a re-notification guard for `@mention` references in the card description — when the description is edited, only newly mentioned users receive a notification. This prevents duplicate notifications when an existing mention is left in place.

### CardMovement

`movement_type` distinguishes regular workflow moves from system events:

- `move` — a user moved the card between columns or swimlanes
- `archived` — the card was archived
- `unarchived` — the card was restored from the archive

History consumers can filter out system events to focus on workflow transitions.

### BoardTemplate

Templates are pre-configured board layouts seeded via a data migration. They are not user-editable. When a user creates a board and selects a template, the template's columns are created and the user is prompted to name the first swimlane using the template's `lane_label` and `lane_placeholder`.

### SavedFilter

Saved filters are private to the owning user — there is no sharing across board members. Each filter stores the full frontend `FilterState` object as JSON. The schema is intentionally unvalidated at the model layer; the frontend validates on load.

### Notification

Notifications are created by the backend when a relevant event occurs (card assignment, @mention, card move, stale card detection, board invite). The `verb` field stores a human-readable summary. The `actor` and `action_type` fields provide structured data for grouping, filtering, and future i18n. Clicking a notification navigates to the relevant board and opens the card detail panel when the notification is tied to a card.

The `board_invite` action type is created when a user is added to a board via invite link or directly by an admin. The notification links to the board rather than a card; the `card` FK is null for this action type.

### InviteLink

Site-level registration invite links live in the accounts app and are distinct from `GroupInviteLink` (which controls group membership). The raw token value is generated once and never stored — only a SHA-256 hash is persisted. The raw value is returned exactly once at creation.

Single-use links are consumed atomically via `select_for_update()` at registration time to prevent race-condition double-use. A soft cap of 50 active links per instance prevents token flood from a compromised admin account.

## Key design decisions

**CardMovement is append-only.** Every time a card changes column or swimlane a new `CardMovement` row is created. Records are never updated or deleted, providing a full audit trail.

**BoardMembership is explicit per board.** A user can have different roles on different boards. Group membership is inherited automatically (see [Group Inheritance](../features/rbac/inheritance.md)) but can be overridden by an explicit `BoardMembership` row.

**Column positions use a two-pass update.** To avoid `unique_together(board, position)` conflicts when reordering, columns are first shifted to high temporary positions, then assigned final positions.

**Card positions are per-cell.** Position is scoped to `(board, column, swimlane)`. When a card moves cells, siblings in both source and target cells are renumbered.

**UIDs are stable external identifiers.** Boards, columns, swimlanes, labels, and cards each carry a `uid` field — a 16-character random hex string assigned at creation and never changed or reused. UIDs survive renames and are preserved in `CardMovement` records even after the referenced column or swimlane is deleted. They are intended as the canonical key for integrations and webhooks that need to reference Visiban objects durably. See [Stable UIDs](../features/stable-uids.md).

**Soft-delete via `archived_at`.** Cards are never hard-deleted from the board view. Archiving sets `archived_at` and hides the card; restoring clears it. Both operations create a `CardMovement` record with the appropriate `movement_type` so the archive/restore event appears in the card's history.

**Denormalized names and UIDs on CardMovement.** The `from_column_name`, `to_column_name`, `from_swimlane_name`, `to_swimlane_name` fields (and their `*_uid` counterparts) are written at move time. This preserves human-readable and machine-readable history even after the referenced column or swimlane is deleted (`on_delete=SET_NULL` on the FK).

**InviteLink is hash-only.** Both `InviteLink` (site-level) and `PersonalAccessToken` store only a SHA-256 hash of the raw token. The raw value is returned exactly once at creation and never persisted, following the same pattern as GitHub PATs.
