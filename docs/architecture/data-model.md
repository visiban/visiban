<a id="data-model"></a>

# Data model: who owns which tables

Three Django apps own the schema:

- `accounts`: users, tokens, site settings, admin audit
- `boards`: boards, cards, and everything on them
- `groups`: the folder hierarchy boards sit in

A fourth, `git_lens`, adds one model but is off by default (see [Issue Board Lens](#git_lens-app-off-by-default) at the bottom of this page).

**Why it matters:** `CardMovement` is the audit trail, and it is append-only. See [Key design decisions](#key-design-decisions).

**Go deeper:** [Core entities](#core-entities) is the field-by-field tree; [Entity details](#entity-details) explains the non-obvious ones.

## Core entities

```
User
 ├── avatar_url (str, blank — external avatar URL)
 ├── display_name (str, blank)
 ├── theme (str — system | dark | light; default system)
 ├── is_site_admin (bool — grants access to the admin panel)
 ├── can_access_all_content (bool — read/write access to all boards and groups, independent of is_site_admin for non-superusers; always true for a superuser)
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
 ├── notif_comment_added (bool, default false — notify when someone else comments on a card you created or are assigned to)
 ├── notif_board_invite (bool, default true — notify when added to a board)
 ├── notif_stale (bool, default false — notify when an owned card has gone stale; split from notif_due_soon in 1.2)
 ├── email_notif_card_assigned (bool, default false — also email the assignment notification)
 ├── email_notif_mentioned (bool, default false — also email the @mention notification)
 ├── email_notif_due_soon (bool, default false — also email the due-date notification)
 ├── email_notif_card_moved (bool, default false — also email the card-moved notification)
 ├── email_notif_comment_added (bool, default false — also email the comment-on-a-watched-card notification)
 ├── has_completed_tour (bool, default false — whether the user has completed the onboarding tour)
 ├── PersonalAccessToken  (name, prefix, token_hash, expires_at, scopes, last_used_scope)
 └── InviteLink created_by / redemptions, GroupInviteLink created_by (see below)

SiteSetting  (accounts app — singleton, pk=1)
 ├── registration_mode (str — open | invite_only | closed; default open)
 ├── uploads_enabled (bool, default true)
 ├── maintenance_mode (bool, default false)
 └── maintenance_message (text, max 1000 chars)

SiteEmailSetting  (accounts app — singleton, pk=1)
 ├── config_source (str — env | database; default env)
 ├── host, port, username, from_email, timeout
 ├── password_ciphertext (text — encrypted at rest, never returned by the API)
 └── use_tls / use_ssl (mutually exclusive)

AdminActionLog  (accounts app — append-only)
 ├── action (str — "<subject>.<verb>", e.g. maintenance_mode.enabled)
 ├── actor_id / actor_username (plain columns, not a FK — see Entity details)
 ├── source (str — admin_api | django_admin | cli)
 ├── metadata (JSON — action-specific detail)
 └── created_at

InviteLink  (accounts app — site-level registration invites)
 ├── token_hash (str, unique — SHA-256 hash; raw token shown once at creation)
 ├── prefix (str — first 8 chars of raw token, safe for display)
 ├── created_by → User (nullable)
 ├── expires_at (datetime, nullable — null = never expires)
 ├── single_use (bool)
 ├── used_at (datetime, nullable)
 ├── revoked_at (datetime, nullable)
 ├── use_count (int, default 0 — incremented on every successful registration, preserved after revocation)
 ├── delivery (str — link | email; default link — how the link reached its recipient; the address is never stored), recipient_hash (nullable keyed hash of an emailed invite's address; 1.2+)
 └── InviteLinkRedemption  (email_hash, redeemed_at — one per email, multi-use links only)

Group
 ├── owner → User
 ├── parent → Group (nullable — null = top-level)
 ├── default_board_member_role (str — admin | member | collaborator | viewer; default member; deprecated #1430, no effect)
 ├── allowed_priorities (JSON — empty = all; deprecated #1429, not enforced)
 ├── GroupLabel  (name, color — shared label library copied to new boards)
 ├── GroupMembership → User  (role: admin | member | collaborator | viewer)
 ├── GroupInviteLink  (name, token, role, expires_at, single_use, used_at, delivery — link | email, recipient_hash — nullable keyed hash of an emailed invite's address; reserved_for — nullable account awaiting confirmation of the invited address; 1.2+)
 └── GroupFavorite → User  (unique per user+group)

Board
 ├── uid  (16-char hex, unique, read-only)
 ├── owner → User
 ├── group → Group (nullable — null = personal board)
 ├── enforce_wip_limits (bool — block card placement into over-limit columns; default true)
 ├── enforce_wip_hard (bool — hard-block mode with no admin override; default false)
 ├── enforce_weight_limits (bool — block placement or weight increases that exceed column weight budget; default true)
 ├── description (text, optional — board description; blank = no description)
 ├── staleness_threshold_days (int, default 7 — number of days without card movement before a card is considered stale)
 ├── stale_warning_pct (int 0–100 — % of the threshold used before the warning step, for the heatmap and card tint; default 50)
 ├── allowed_priorities (JSON — intended card priorities; deprecated #1429, not enforced, see field-enforcement.md)
 ├── share_token (UUID, nullable — public read-only share link; null = sharing disabled)
 ├── share_token_hash (str, nullable, unique — SHA-256 of share_token; the share endpoint resolves links by it; never serialized)
 ├── share_token_expires_at (datetime, nullable — null = never expires; past this the share endpoint returns 410)
 ├── share_enabled_by → User (nullable, SET_NULL — the admin who enabled the current share link; never serialized)
 ├── export_min_role (str, default viewer — minimum BoardMembership.Role required to export)
 ├── card_density (str — comfortable | standard | dense; default comfortable for new boards)
 ├── show_wip_at_limit (bool, default false — ambient "WIP n/n" indicator at exactly the limit)
 ├── show_row_chip_field_names (bool, default true — label pinned swimlane row chips with their field name)
 ├── BoardMembership → User  (role: admin | member | collaborator | viewer)
 ├── BoardFavorite → User  (unique per user+board)
 ├── Column  (uid, position, color, wip_limit, weight_limit, allow_card_creation, is_done)
 ├── Swimlane  (uid, position, color, is_collapsed)
 ├── Label  (uid, name, color)
 ├── CustomFieldDefinition  (uid, name, field_type, choices_json, show_on_card, is_required — max 30/board)
 ├── SwimlaneCustomFieldDefinition  (same shape, one level up — max 15/board)
 ├── BoardExportLog  (actor, role_at_export, export_format, row_count)
 └── BoardInviteLink  (token_hash, prefix, role — member | collaborator | viewer, expires_at, single_use, used_at, revoked_at/revoked_by, use_count, delivery — link | email, recipient_hash — nullable keyed hash of an emailed invite's address; reserved_for — nullable account awaiting confirmation of the invited address; 1.2+)
      └── BoardInviteRedemption → User  (role_granted, membership_created, via — join | registration; unique per invite+user)

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
 ├── version (int, default 1 — optimistic concurrency control; incremented by a field update (`update_card`), a move (`move_card`) or a Django admin change save (`CardAdmin.save_model`, since 1.3) only — archive/unarchive, comments, attachments, checklists and relations leave it unchanged, and it never decreases; clients send the version they have; 409 returned if the card has been modified in the meantime)
 ├── assignee → User (nullable)
 ├── labels → Label (M2M)
 ├── archived_at (datetime, nullable — soft-delete timestamp; null = active)
 ├── mentioned_user_ids (JSON — dedup guard for @mention notifications)
 ├── CardMovement  (from/to column + swimlane FKs + UIDs + names, moved_by, moved_at, movement_type)
 ├── CardComment  (author, body)
 ├── CardActivity  (event_type, from_value, to_value, actor)
 ├── CardChecklist  (text, is_checked, position)
 ├── CardAttachment  (file, filename, size, uploaded_by)
 ├── CustomFieldValue  (field_definition, value — one row per set field, unique per card+definition)
 ├── CardExternalRef  (1:1 — provider, ref, url; a card's link to a PR/MR on an external forge)
 └── CardRelation  (outgoing_relations / incoming_relations — blocks | relates_to, between two cards on the same board)

BoardEvent  (append-only feed of every committed board mutation, #1114)
 ├── board_id (plain int, not a FK — see Entity details)
 ├── event (str — the WebSocket event type, e.g. "card.moved")
 ├── data (JSON — the broadcast payload, verbatim)
 ├── actor_id (plain int, nullable)
 └── created_at

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
 ├── action_type (str — assigned | mentioned | card_moved | stale | board_invite | due_soon | comment_added)
 ├── verb (str — human-readable summary)
 ├── card → Card (nullable)
 ├── board → Board (nullable)
 └── read (bool)
```

## Entity details

### User

- **`is_site_admin`** grants access to the Visiban admin panel (user management, site settings). It does **not** grant access to boards or groups.
- **`can_access_all_content`** grants read/write access to every board and group regardless of membership.

For accounts that are not superusers the two flags are independent and can be combined. Superuser status implies both.

`theme` (`system` / `dark` / `light`, default `system`) is the per-user dark-mode preference. `avatar_url` and `display_name` are optional and blank by default. `avatar_url` uses `""` rather than `null` as its "no avatar" sentinel, a 1.0 API contract that cannot change without a major version bump.

`default_board` is a foreign key to `Board` with `on_delete=SET_NULL`. After login the frontend redirects to it if set, verifying access first to prevent an IDOR leak via a stale FK.

`close_editor_on_enter` (default true) makes Enter submit and close the new-card inline editor. Shift+Enter always inserts a newline.

The `notif_*` booleans store per-user notification preferences; each maps to one `action_type` on `Notification`. Events that directly target the user (`card_assigned`, `mentioned`, `board_invite`) default on. Ambient events (`due_soon`, `card_moved`, `comment_added`) default off to avoid noise. Users change them from their profile settings page.

`has_completed_tour` is set to true when the onboarding tour first completes. The frontend reads it on login and skips the tour for returning users.

### PersonalAccessToken

Named, revocable API tokens (`vbn_` prefix), capped at 10 per user. Only a SHA-256 hash of the raw value is stored; the plaintext is shown exactly once, at creation. All of a user's tokens are deleted when their password changes.

Since 1.2 (#1110) a token also carries `scopes`: a JSON list drawn from `read`, `write`, `admin`, `mcp:read`, `mcp:write`. Scopes are non-hierarchical (holding `admin` does not imply `read`).

- `scopes=None`: a legacy pre-1.2 token. It carries its owner's full REST authority but can never satisfy an `mcp:*` requirement.
- `scopes=[]`: an explicit grant of nothing.
- A new token always gets an explicit list: `read` + `write` by default when the caller omits `scopes`.

### SiteSetting / SiteEmailSetting

Two accounts-app singletons (always `pk=1`, fetched via `.get()`), split so a value that must never reach the audit log (the SMTP password) cannot live next to values that always do.

- `SiteSetting` holds `registration_mode` (open / invite_only / closed), `uploads_enabled`, and instance-wide `maintenance_mode` plus its notice. Both are read on nearly every request through a 60-second cache invalidated on write.
- `SiteEmailSetting` holds outbound SMTP configuration, gated by `config_source` (`env` or `database`). The sources are never merged field-by-field, only switched wholesale, so a half-filled database row cannot silently blend with environment variables.

### AdminActionLog

Append-only record of a fixed set of instance-wide admin actions (#1126):

- maintenance mode toggled, the maintenance notice changed
- registration mode changed, uploads toggled
- outbound-email configuration changes
- password events: set or disabled for another account in the Django admin, and passwords set by the `ensure_site_admin`, `changepassword` and `provision_fuzz_token` management commands (source `cli`)
- card-history purges (`card_history.purged`, written by the `purge_card_history` management command with the `--actor` superuser as actor; #1797)

`actor_id` and `actor_username` are plain columns, not a foreign key. A FK's `on_delete=SET_NULL` would let deleting a user erase who performed a privileged action, the one thing this table exists to answer. There is deliberately no retention pruner; volume is a handful of rows a month. See [Open-core boundary § Audit log](open-core-boundary.md#audit-log-split) for why this stays in OSS rather than the enterprise compliance audit log.

### Board

- **`enforce_wip_limits`** (default true) blocks moving, creating, or restoring a card into a column at or over its WIP limit with a 409 (board import is exempt). Board admins can override with `?force=true`. When `enforce_wip_hard` is also true, the limit is a hard stop for all roles including admins, with no override.
- **`enforce_weight_limits`** (default true) blocks moving, creating, or restoring a card into a column that would exceed its weight budget, and raising a card's weight past it. Board admins can override unless hard mode is active.

`stale_warning_pct` (default 50, range 0--100) is the percentage of `staleness_threshold_days` a card has used before it is flagged as approaching stale. It drives the yellow warning band in the analytics heatmap (yellow at this percentage, red at 100%) and the yellow step of the card [aging tint](../features/card-history.md#card-aging-tint). `0` turns the warning step off. The tint's further steps at 2× and 3× the threshold are fixed in the frontend and not stored.

`allowed_priorities` is a JSON list of intended priority values; an empty list means all (`low`, `medium`, `high`, `urgent`). It is a deprecated **scaffold** (#1429): stored and returned for API compatibility, but card create and update accept any priority. See [Field Enforcement](field-enforcement.md) (#1429).

**Public sharing:**

- `share_token` is a UUID generated when a board admin enables public sharing. While set, the board is readable at `/share/:token` with no login. Setting it to null disables sharing immediately.
- The share endpoint resolves a presented token by `share_token_hash`, the SHA-256 of the token (the scheme invite links use), never by the stored token, which is kept for the admin-only `share_token` API field. The two are always set and cleared together (#1880). Links enabled before the column existed get their hash from migration `0088`.
- **Deprecated since 1.2 (#1935):** the `share_token` API field on `GET /boards/{id}/full/`. Clients read the token from the share action's response, once, and `share_link_active` tells an admin whether a link is set. The field, and then the stored column in a separate migration after the code stops referencing it, are removed in 2.0 (#1936).
- `share_token_expires_at` (nullable) optionally bounds the link: past the timestamp the share endpoint returns `410 Gone` rather than auto-rotating the token.
- `share_enabled_by` (nullable, since 1.2) records the admin who enabled the current link. The link is cleared when that account is deactivated or deleted, or is no longer a board admin or site admin on the board (#1865). It is never returned by the API.
- **Yes, but:** `share_enabled_by` is null for links enabled before the enabler was recorded (for example under 1.1, or 1.2.0-beta.3 and earlier). Such a link does not resolve, reads as no link in the admin share fields of `/full/`, and is cleared when opened, until a board admin enables sharing again (#1939).

- `export_min_role` (default `viewer`) sets the minimum `BoardMembership.Role` required to export the board; owners and site admins always bypass it. It limits only the export action and file formats, not ordinary reads.
- `card_density` (`comfortable` / `standard` / `dense`, default `comfortable` for new boards) controls how much metadata renders on the card face.
- `show_wip_at_limit` is purely ambient: it swaps a column's card count for a "WIP n/n" indicator once the count exactly equals the limit, and does not affect move enforcement.
- `show_row_chip_field_names` (default `true`, with a database default too) is display-only: when off, pinned swimlane row chips drop their visible `{name}:` label (checkbox fields excepted). Card-face chips are unaffected.

### Column

`is_done` marks a terminal/completion column (e.g. "Done", "Closed Won"). Done columns are excluded from analytics dwell-time calculations: a card's clock stops when it enters one. Multiple done columns per board are supported.

### Card

`archived_at` is a nullable datetime used for soft-delete. When set, the card is hidden from the board view and drag-and-drop but can be restored from the Archived panel. Analytics uses it as the terminal timestamp, so dwell time reflects only the active period. Archived cards are excluded from WIP and weight counts.

`mentioned_user_ids` is a JSON list of user PKs that guards against re-notification for `@mention` references in the description: when the description is edited, only newly mentioned users are notified. The list holds only users who actually received a notification, so a user skipped at the time is still notified by a later mention.

### CardMovement

`movement_type` distinguishes regular workflow moves from system events:

- `move` — a user moved the card between columns or swimlanes
- `archived` — the card was archived
- `unarchived` — the card was restored from the archive

History consumers can filter out system events to focus on workflow transitions.

### CustomFieldDefinition / CustomFieldValue

Per-board typed metadata on cards (#371); a `Label` is an untyped tag. A `CustomFieldDefinition` is the board-scoped schema: a name, a `field_type` of `text` / `number` / `date` / `dropdown` / `checkbox` / `url` / `multi_select`, and for dropdowns and multi-selects a `choices_json` list. A `CustomFieldValue` is one card's value for one definition, unique per `(card, field_definition)`.

Three decisions worth knowing before changing either model:

- **One untyped `value` text column, not a column per type.** Typed columns mean sparse
  nulls and a schema migration every time a type is added. Casting and validation live at
  the serializer boundary instead, and every value is normalized to a canonical string
  (ISO dates, `"true"` / `"false"`) so equality comparisons need not know the type.
  The `url` type (#1390) is the proof: it added a validation branch, not a column, and so
  did `multi_select` (#1391), which stores a canonical JSON array *string* (deduplicated,
  in choice order — `boards/custom_field_types.py`) in the same column. Typed
  columns are deferred to the enterprise analytics work that would actually need SUM/AVG.
- **EAV with a cap of 30 definitions per board** (and 2 pinned to the card face). The
  `/full/` endpoint reads every card and every value, so an uncapped field count is a
  Cartesian blow-up; 500 cards × 30 fields is 15,000 value rows, which the prefetch loads
  in one query. Neither cap is expressible as a database constraint — both are counts over
  a board's rows — so they are enforced in the serializer, under a board row lock on write.
- **Clearing a field deletes its row** rather than storing `""`, so "unset" has exactly one
  representation.

`is_required` exists as a column but is **not enforced**; turning it on would make
previously valid card writes fail, so it needs a release note, not a quiet change.

Both definition models also carry three display-only number-format columns (#1391): `number_prefix` and `number_suffix` (`varchar(10)`, default `""`) and `number_decimals` (`smallint` with a `>= 0` check, nullable; `NULL` = "as typed", the API caps it at 10).

- They live on the *definition*, not the value. The value stays the plain number string, so exports, filtering and the value index are unaffected.
- They mean something only when `field_type` is `number`. The serializer rejects them on any other type and resets them when a definition is retyped away from `number` (migration `0065`).

Both definition models also carry `choice_colors` (`jsonb`, `NOT NULL`, default `'{}'`, #1391, migration `0066`): a `{choice text: palette key}` map giving dropdown and multi-select choices an optional display color.

- It is a separate column rather than objects inside `choices_json`, so `choices` stays the plain string list every client, export and template already reads.
- Values are palette *keys* (`slate`, `blue`, `green`, `amber`, `red`, `violet`, `pink`, `teal`; `CHOICE_COLOR_KEYS` in `boards/custom_field_types.py`), never hex, so the frontend owns light/dark rendering and contrast.
- The serializer prunes keys that are no longer choices on every write (renaming a choice drops its color) and clears the map when a definition is retyped away from a choice type.

The same shape exists for swimlanes: `SwimlaneCustomFieldDefinition` / `SwimlaneCustomFieldValue` (#1140), capped at 15 definitions and 3 pinned per board. A swimlane typically represents an account or project, so it carries fewer, richer fields than a card. It is a separate pair of tables rather than a `target_type` discriminator, so existing 1.0 response shapes (`BoardFullSerializer`, the CSV export header, the per-board cap count) never filter for scope. `is_admin_only` (default `true`) restricts a row field's values to board admins, reusing the `SwimlaneSerializer` / `SwimlaneAdminSerializer` split.

### CardRelation

A typed, directional link between two cards on the same board (#449): `blocks` or `relates_to`.

- One row per pair: `outgoing_relations` reads it forwards ("blocks"), `incoming_relations` backwards ("blocked by"). Two mirrored rows could drift out of sync.
- `relates_to` is symmetric and normalized at write time (lower card id becomes `from_card`) so `unique_together` dedupes it.
- Same-board-only is enforced in the view, not the database (a `CheckConstraint` cannot span a join). A database `CheckConstraint` does block self-relations.
- Longer cycles (A→B→C→A) are deliberately not detected: nothing in v1 walks the graph as an ordering.

### CardExternalRef

A card's one-to-one link to a merge request or pull request on an external forge (#352): `provider` (`gitlab` / `github` / `other`), a freeform `ref` (e.g. `group/proj!45`), and a validated `url`. The API shape `external_ref: {provider, ref, url} | null` is a stable public contract from 1.2; the enterprise auto-link integration reads and writes it. `url` accepts only absolute `http`/`https` URLs with no embedded credentials and no backslashes (browsers treat `\` as `/` while Python's parser does not, which would let one host be stored and a different one rendered).

### BoardEvent

An append-only, cursor-resumable feed of every committed board mutation (#1114), read via `GET /api/v1/boards/{id}/events/`.

- A row is written in the same transaction as its mutation, so a rolled-back write produces no event.
- `data` is the WebSocket broadcast payload verbatim, so a consumer can switch between polling and holding a socket open without reconciling two representations.
- `board_id` and `actor_id` are plain columns, not foreign keys, so deleting a board or user cannot rewrite history a consumer is mid-read of. `board.deleted` is itself an event this table must persist.

This is the delivery source for OSS webhooks — see [Open-core boundary § Outgoing webhooks](open-core-boundary.md#outgoing-webhooks-oss-vs-webhook-operations-enterprise).

### BoardExportLog

Records a successful board export (#842): actor, the role they held at export time, format, and row count. Only successful exports are logged; a denied attempt never reached the data. `actor` is `SET_NULL` so the row survives the user's later deactivation, and `role_at_export` is captured verbatim so a later role change doesn't rewrite history.

### BoardTemplate

Pre-configured board layouts seeded via a data migration; not user-editable. Selecting one at board creation creates its columns and prompts the user to name the first swimlane using the template's `lane_label` and `lane_placeholder`.

### SavedFilter

Saved filters are private to the owning user; there is no sharing across board members. Each stores the full frontend `FilterState` object as JSON. The schema is intentionally unvalidated at the model layer; the frontend validates on load.

### Notification

The backend creates notifications on card assignment, @mention, card move, stale card detection, board invite, due date approaching, and comment added. `verb` stores a human-readable summary; `actor` and `action_type` give structured data for grouping, filtering, and future i18n. Clicking one opens the relevant board, and the card detail panel when it is tied to a card.

The `board_invite` action type is created only when a board admin adds a user directly through `POST /api/v1/boards/{id}/members/`, and only for a new membership, not a role change. Joining through an invite link creates no notification, neither a group invite nor *(1.2+)* a board invite redemption; the joiner is the one acting. It links to the board rather than a card, so the `card` FK is null for this action type.

Every notification is created through `boards.services.notifications.create_notifications`. After the transaction commits it delivers OSS email for the five events that support it, then sends the `post_notification_created` signal once per row. The funnel exists because three creation sites use `bulk_create`, which sends no `post_save`, so a per-model signal would have missed half the events. It also skips inactive recipients, so no row is created for them. See
[Open core boundary](open-core-boundary.md#oss-extension-points-implementation-status).

### InviteLink

Site-level registration invite links live in the accounts app and are distinct from `GroupInviteLink` (group membership). The raw token is generated once, returned exactly once at creation, and never stored; only a SHA-256 hash is persisted.

**By the numbers:**

- Single-use links are consumed atomically via `select_for_update()` at registration time, preventing double-use races.
- A soft cap of 50 active shareable links (`delivery = link`) per instance limits token flood from a compromised admin account.
- Emailed links (`delivery = email`, #731) are single-use, always expire, and are capped at 200 pending per instance. The group equivalent is 5 active shareable links plus 50 pending emailed links per group.
- The recipient address of an emailed link is never stored.

An emailed site invite is bound to its address like board and group invites: `recipient_hash` is an HMAC of the normalized address keyed from `SECRET_KEY` (`visiban/invite_recipient.py`, #1703), checked inside `consume_invite_token` on the locked row before the invite is consumed. It is NULL for shareable links and for emailed invites minted before the column existed, which redeem as before.

A multi-use link guards against repeat redemption by the same person with `InviteLinkRedemption` (#925): a SHA-256 hash of the normalized email per `(invite_link, email_hash)`, under a unique constraint. Single-use links don't need it, since `used_at` already blocks re-use. Storage is hash-only, so an operator asking "who redeemed this link" sees hashes, not addresses.

### BoardInviteLink *(1.2+)*

Board-scoped invites (`vbnb_` tokens, #1444) live in the boards app beside `BoardMembership`.

**Storage:**

- Only the SHA-256 of the token is stored, as for the other two invite kinds. The address an emailed invite went to is not stored either.
- An emailed board or group invite keeps `recipient_hash`, an HMAC of the normalized address keyed from `SECRET_KEY` (`visiban/invite_recipient.py`, #1678). Every redemption path compares it with the redeeming account's addresses on the locked invite row, before the invite is consumed. It is NULL for shareable links and for emailed invites minted before the column existed, which redeem as before. It is never serialized.

**Grants:**

- An invite can grant only `member`, `collaborator` or `viewer` (`BoardInviteLink.GRANTABLE_ROLES`, enforced by `generate()` and again at redemption). Never `admin`, the moderator flag, or group membership.
- Under `EMAIL_VERIFICATION=mandatory`, a group or board invite used to register with a not-yet-verified address records the new account in `reserved_for` (nullable, partial index, #1704) instead of granting. The membership is granted, and the invite consumed, when that account confirms the invited address.

**Redemption:**

- It is serialized by `select_for_update()` on the invite row, in the join view and in the registration validator.
- It never edits an existing explicit `BoardMembership`: an explicit membership overrides an inherited group role rather than adding to it (see [Permissions](../features/permissions.md)).
- A pending invite whose sender has been deleted or is no longer a board admin is unusable. The join endpoints answer `410 revoked` and the admin list reports it as `revoked`, without writing to the row. Because nothing is written, it is reversible: if the sender regains board admin, the invite is pending and redeemable again until it expires.
- To remove it for good, an admin revokes it with `DELETE /boards/{id}/invite-links/{link_id}/`, which accepts it since `revoked_at` is still NULL.

**`delivery`:**

- `email`: always single-use, capped at 50 pending per board.
- `link` (#439): a shareable link, optionally multi-use, capped at 5 active per board, and always given an `expires_at` by the API even though the column is nullable. A multi-use link increments `use_count` once per redeeming user (on the first `BoardInviteRedemption` row for that user) and never stamps `used_at`; the `board_invite_link_used_at_requires_single_use` check constraint forbids it. A shareable link never authorizes a new account on an invite-only site (`board_link_registration_refusal`).
- Both caps are checked under a `select_for_update()` on the board row.

`BoardInviteRedemption` records who redeemed which invite, what it granted, and whether a membership was created. It is the durable provenance record; the `member.added` change-feed row also names the invite, but the change feed is pruned after 30 days.

### GroupLabel

A group-level label library (name, color) copied onto every new board created under that group, so related boards start with a consistent label set. Distinct from a board's own `Label` rows, which a board can add to independently afterward.

## `git_lens` app (off by default)

A fourth Django app, `git_lens`, is registered only when `GIT_LENS_ENABLED=true` (default `false`). Otherwise its tables, routes, and one model, `LensConnection`, stay dormant. `LensConnection` is a one-to-one link from a `Board` to an external GitHub or GitLab repository (`provider`, `repo_slug`, plus `column_dim` / `swimlane_dim` for how issues map onto the board's grid). It backs the [Issue Board Lens](../features/issue-board-lens.md): a shareable, read-only board derived from a repo's issues and merge/pull request state. It reuses the host board's RBAC.

## Key design decisions

**CardMovement is append-only.** Every column or swimlane change creates a new `CardMovement` row, giving a full audit trail. Application code never edits what a movement records and never deletes one. The only updates are bookkeeping: filling the board and card snapshot columns, re-pointing `board` when the admin moves a card, and nulling `card` when a card is deleted.

Since 1.2 (#1469) `CardMovement.save()` refuses to rewrite an existing row, `delete()` on a row always refuses, and the Django admin shows movements read-only. **Yes, but:** this guards against accidental writes, not tampering. A queryset `update()`/`delete()` or raw SQL bypasses it.

**A card's movements outlive the card; a board's do not.** `CardMovement.card` is `on_delete=SET_NULL` (#1469): hard-deleting a card (directly, or by deleting the column or swimlane it is in) keeps its movements, with `card` set to `NULL`. Each row also carries `board` (where it happened, `on_delete=CASCADE`) and `card_uid` / `card_title` (the card's uid and title when the row was recorded; rows from before the 1.2 upgrade and imported rows carry them as of the upgrade or import). A deleted card's history therefore stays on its board's History view under its original uid and title.

A movement leaves in two ways:

- Deleting the whole board, the explicit destructive act, removes every movement on it through `board`.
- The superuser-run `purge_card_history` management command (#1797) deletes matching rows (by default only deleted cards') with a queryset delete and writes a `card_history.purged` `AdminActionLog` entry in the same transaction.

See [Card History Retention](../administration/card-history-retention.md).

**BoardMembership is explicit per board.** A user can have different roles on different boards. Group membership is inherited automatically (see [Group Inheritance](../features/rbac/inheritance.md)), but an explicit `BoardMembership` row overrides it.

**Column positions use a two-pass update.** To avoid `unique_together(board, position)` conflicts when reordering, columns are first shifted to high temporary positions, then assigned final positions.

**Card positions are per-cell.** Position is scoped to `(board, column, swimlane)`. When a card moves cells, siblings in both source and target cells are renumbered.

**UIDs are stable external identifiers.** Boards, columns, swimlanes, labels, and cards each carry a `uid`: a 16-character random hex string assigned at creation and never changed or reused. UIDs survive renames and are preserved in `CardMovement` records after the referenced column or swimlane is deleted. They are the canonical key for integrations and webhooks that reference Visiban objects durably. See [Stable UIDs](../features/stable-uids.md).

**Soft-delete via `archived_at`.** Cards are never hard-deleted from the board view. Archiving sets `archived_at` and hides the card; restoring clears it. Both create a `CardMovement` record with the matching `movement_type`, so the event appears in the card's history.

**Denormalized names and UIDs on CardMovement.** The `from_column_name`, `to_column_name`, `from_swimlane_name`, `to_swimlane_name` fields (and their `*_uid` counterparts) are written at move time, preserving readable history after the referenced column or swimlane is deleted (`on_delete=SET_NULL` on the FK). `card_uid` and `card_title` do the same for the card (#1469); the API serves them only once the card itself is gone.

**InviteLink is hash-only.** `InviteLink` (site-level) and `PersonalAccessToken` store only a SHA-256 hash of the raw token. The raw value is returned exactly once at creation and never persisted, like GitHub PATs.
