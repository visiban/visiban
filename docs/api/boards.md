# Boards API

Boards, columns, swimlanes, labels, custom fields, membership, sharing, and export/import — everything you do with a board short of the cards inside it (see [Cards API](cards.md)).

## Boards

### `GET /api/v1/boards/`
List all boards accessible to the current user.

**Query parameters**

| Parameter | Description |
|---|---|
| `?starred=true` | Return only boards the requesting user has starred |
| `?expand=group` | Populate `group_detail` on each board with a `GroupBrief` object (see `GET /api/v1/boards/{id}/full/` for the shape). Without this parameter `group_detail` is `null`. Triggers a one-query ancestor bulk-fetch — safe to use on list responses. |

### `POST /api/v1/boards/`

> **Changed in 1.2**

Create a board.

**Request**

| Field | Required | Description |
|---|---|---|
| `name` | ✓ | Board name |
| `description` | | Board description (default: `""`) |
| `template` | | Template slug to use for column layout (default: `"simple_kanban"`). See `GET /api/v1/boards/templates/` for available slugs. Omitting the field (or sending `""`/`null`) uses the default; sending a non-blank slug that doesn't match an active template returns `400` — see **Errors** below. |
| `swimlane_name` | | Name for the first swimlane. Omitting it (or sending blank) creates the board with **no** swimlane at all — no template currently supplies a non-empty default. Contrast with [`POST /groups/{id}/boards/`](groups.md#boards), which defaults an omitted value to `"General"`. |
| `group` | | Integer group ID — assigns the board to this group at creation time. The caller must be a group member. |

**Errors**

| Status | Body | Condition |
|---|---|---|
| `400 Bad Request` | `{"code": ["unknown_template"], "detail": ["Unknown board template: '...'."]}` | `template` was sent as a non-blank value that doesn't match an active template's slug. This is deliberately distinct from a generic per-field validation error — a stale or mistyped `template` value previously created a `simple_kanban` board with a `201` instead of surfacing the mistake (#1115). |

### `GET /api/v1/boards/{id}/`
Get board summary. Response includes:

| Field | Type | Description |
|---|---|---|
| `id`, `uid` | integer, string | Database ID and stable 16-char hex UID |
| `name`, `description` | string | Board name and description |
| `owner` | object | Owner user object |
| `group`, `group_name` | integer / null, string / null | Group ID and name (null for personal boards) |
| `group_detail` | object / null | Populated with a `GroupBrief` object when `?expand=group` is appended to the request; `null` otherwise. `GroupBrief` shape: `{ id, name, parent, parent_name, ancestors }` where `parent` is the parent group FK ID (or `null`) and `ancestors` is a root-first `[{ id, name }]` chain. |
| `member_count` | integer | Number of direct board members |
| `card_count` | integer | Number of active (non-archived) cards |
| `archived_card_count` | integer | Number of archived cards. Reported separately because `card_count` excludes them, yet `DELETE /api/v1/boards/{id}/` deletes them too. Clients that confirm a board delete should treat `card_count + archived_card_count` as the number of cards at stake. Also present on `GET /api/v1/boards/`, `GET /api/v1/groups/{id}/boards/`, and `/full/`. Added in 1.2 (#1289). |
| `staleness_threshold_days` | integer | Days without movement before a card is considered stale (default: 7) |
| `allowed_priorities` | array / null | Intended list of priority values for cards on this board (e.g. `["low", "medium", "high"]`); `null` or `[]` means all. **Not enforced:** card create and update accept any priority regardless of this list (scaffold, see [Field Enforcement](../architecture/field-enforcement.md)). Duplicate entries are silently de-duplicated (order of first occurrence is kept); a submitted list longer than 100 entries is rejected with `400 Bad Request`. |
| `enforce_wip_limits` | boolean | When `true`, moving, creating, or restoring a card into a column at its WIP limit returns `409 Conflict` (default: `true` for new boards); board admins can override with `?force=true`. Board import is not checked (by design). Create and restore checked since 1.2 (#1428) |
| `enforce_wip_hard` | boolean | When `true`, WIP limits on card move, create, and restore cannot be overridden by any role — all users are blocked (default: `false`). Active regardless of `enforce_wip_limits`. Board import is not checked (by design). Create and restore checked since 1.2 (#1428) |
| `enforce_weight_limits` | boolean | When `true`, moving, creating, or restoring a card, or raising a card's `weight` with PATCH, so that a column would exceed its weight limit returns `409 Conflict` (default: `true` for new boards); board admins can override with `?force=true`. Lowering a weight is never blocked. Board import is not checked (by design). Create, restore, and PATCH checked since 1.2 (#1428) |
| `export_min_role` | string | Minimum role required to export this board. One of `"viewer"`, `"collaborator"`, `"member"`, `"admin"` (default: `"viewer"`). Owners and site admins always bypass. Admin-only when writing; sending any other value (including `"site_admin"` or `"owner"`) returns `400 Bad Request`. Added in 1.1 (#843). |
| `card_density` | string | Per-board card layout density. One of `"comfortable"`, `"standard"`, `"dense"` (default: `"comfortable"` for new boards; existing boards on upgrade are migrated to `"dense"` to preserve their pre-1.1 visual). Drives how much metadata renders on the card face — see the [Card density](../features/board.md#card-density) feature doc. Admin-only when writing; sending any other value returns `400 Bad Request`. Added in 1.1 (#961). |
| `show_wip_at_limit` | boolean | When `true`, a column's header stat row shows a calm `WIP n/n` indicator (in place of the card count) once the column's card count exactly equals its `wip_limit` (default: `false`). Purely ambient — does not affect move enforcement. Admin-only when writing. See the [At-limit WIP indicator](../features/board.md#at-limit-wip-indicator) feature doc. Added in 1.2 (#973). |
| `stale_warning_pct` | integer | Warning percentage (0--100) controlling the yellow/green boundary in the analytics heatmap |
| `is_starred` | boolean | Whether the requesting user has starred this board |
| `created_at`, `updated_at` | string | ISO 8601 timestamps |

### `PUT /api/v1/boards/{id}/` / `PATCH /api/v1/boards/{id}/`
Update board fields. Both `PUT` and `PATCH` are accepted — all fields are optional in either case. Requires board admin.

**Writable fields:** `name`, `description`, `staleness_threshold_days`, `stale_warning_pct`, `allowed_priorities`, `enforce_wip_limits`, `enforce_weight_limits`, `enforce_wip_hard`, `export_min_role`, `card_density`, `show_wip_at_limit`. The entire request requires board admin (or site admin) — there is no tier of fields a non-admin member can edit; a non-admin PATCHing even a single field like `description` receives `403 Forbidden`.

### `DELETE /api/v1/boards/{id}/`
Delete board. Requires board owner or site admin. Deletes every card on the board, **including archived cards** — see `archived_card_count` above.

### `GET /api/v1/boards/{id}/full/`
Full board state — columns, swimlanes, cards, labels, members, `current_user_role`, and `capabilities`. All objects include their `uid` field. Also includes `share_token` (the board's public share UUID, returned only to `admin` and `site_admin` role members — `null` is returned to lower roles when no share link exists) and `share_token_expires_at` (ISO-8601 timestamp of the share link's expiry, or `null` for no expiry; admin-only, mirrors `share_token` visibility — added in 1.1, #804). The `capabilities` object contains boolean feature flags for enterprise-registered extension points (all `false` in OSS).

`cards` lists active cards only. Since 1.2, the payload also carries `archived_card_count` (integer) — the number of archived cards that `cards` omits but that a board delete would remove (#1289).

Since 1.2, each card in the payload also carries `external_ref` (`{ provider, ref, url }` or `null`) — see [External ref](cards.md#external-ref-since-12).

Since 1.2, also includes `custom_field_definitions` (the board's card custom field schema) and `swimlane_custom_field_definitions` (the board's [swimlane custom field](#swimlane-custom-fields-since-12) schema) — both read-only lists, available to every board role. Definition schemas disclose nothing a board reader does not already have; which of a swimlane's *values* a given role may read is decided per-definition by `is_admin_only`, not by this field.

**`members` is the effective roster, not membership rows.** It lists everyone who can act on the board: direct members, members inherited from the board's group (and its ancestors), the board owner, and every site admin (so they appear in @mention autocomplete). Only direct members have a `BoardMembership` row on the board, so for the other three `id` is `null`; site admins carry `role: "site_admin"`, which is not a membership role. In the OpenAPI schema this is the `EffectiveBoardMember` component (role enum `EffectiveBoardRoleEnum`), distinct from the strict `BoardMembership` component returned by `POST /api/v1/boards/{id}/members/`, whose `id` is never `null` and whose `role` never includes `site_admin`. Since 1.2 the schema documents `/full/` as its own `BoardFull` component; before that it was mis-documented as `Board` (#1137). The response body itself did not change.

**`?expand=group` parameter:** when `?expand=group` is appended, the `group_detail` field in the response is populated with a `GroupBrief` object containing `id`, `name`, `parent` (parent group FK ID or `null`), `parent_name` (parent group display name or `null`), and `ancestors` (root-first `[{ id, name }]` chain). Without this parameter `group_detail` is `null`.

### `GET /api/v1/boards/{id}/events/`
Board change feed — committed board mutations in ascending `id` order, so an out-of-process consumer can resume after a dropped WebSocket instead of re-fetching `/full/`. Added in 1.2.

**Query parameters:** `after` (cursor — the last event `id` processed; default `0`) and `limit` (`1`–`500`, default `100`). Both are validated, not clamped; an out-of-range or malformed value returns `400`.

**Response:** `{ "results": [{ id, event, data, actor_id, created_at }, ...], "next": <int|null> }`. `next` is the cursor for the following page, or `null` when the caller is caught up.

**Permissions:** any board role, the same gate as `/full/` and the WebSocket handshake — the feed replays events the caller could already have streamed. `is_moderator` is stripped from `member.*` payloads for roles below `admin`, exactly as the WebSocket consumer strips it — except on the row belonging to the reader themselves, which always carries the field (#1191).

**`410 Gone`:** the cursor has aged out of the retention window (`BOARD_EVENT_RETENTION_DAYS`, default 30 days) and newer events exist. Re-sync via `/full/` and resume from the newest `event_id` seen after that.

```json
{
  "detail": "Event cursor is no longer available — it fell outside the retention window. Re-sync the board state and resume from the newest event id you see after that.",
  "code": "cursor_expired",
  "resync_url": "https://your-instance.example.com/api/v1/boards/1/full/"
}
```

See [Change Feed](events.md) for the full contract, retention, and the reconnect flow.

### `POST /api/v1/boards/{id}/star/`
Star (favorite) a board. Returns `200 OK` with the updated board object (whether or not the board was already starred).

**Permissions:** requires authentication and board access (any role). Broadcasts `board.star_changed` to all board WebSocket subscribers.

### `DELETE /api/v1/boards/{id}/star/`
Unstar a board. Broadcasts `board.star_changed` to all board WebSocket subscribers.

**Permissions:** requires authentication and board access (any role).

### `GET /api/v1/boards/?starred=true`
List only boards the requesting user has starred.

### `POST /api/v1/boards/{id}/move-group/`
Move board to a different group (or `null` for personal).

**Minimum role:** Board owner, board admin, or site admin. The caller must also be a member of the target group.

**Request** `{ "group_id": 5 }` or `{ "group_id": null }`

**Errors**

| Status | Body | Condition |
|---|---|---|
| `403 Forbidden` | `{"detail": "..."}` | Caller is not board owner/admin, or is not a member of the target group |
| `404 Not Found` | `{"detail": "..."}` | Target group does not exist |

---

## Sample boards

> **Added in 1.2**

Read-only endpoints behind the **Start from a sample** gallery on the Import Board screen. They need the same access as importing (authentication, no pending password or username change) and, for a personal access token, the `read` scope. Both set `Cache-Control: private, max-age=3600`.

The files are shipped inside the backend image, so a sample always matches the importer of the same release. To use one, fetch it and post it to [`POST /api/v1/boards/import/`](#post-apiv1boardsimport) like any other export file; group access and the import rate limit are enforced there.

### `GET /api/v1/boards/samples/`
List the sample boards in gallery order.

```json
[
  {
    "id": "sales_overlay",
    "title": "Sales Overlay",
    "description": "See which accounts have coverage gaps under an enterprise overlay sales model.",
    "swimlane_theme": "account",
    "card_count": 42,
    "includes": ["labels", "checklists", "comments", "history"],
    "order": 1,
    "schema_version": 2,
    "date_anchor": "2026-03-15"
  }
]
```

| Field | Description |
|---|---|
| `id` | Stable identifier, `[a-z0-9_]+`. Never renamed; use it for `GET /boards/samples/{id}/`. |
| `title` | Display name. An import without a `name` is titled `Imported: <title>`. |
| `description` | One line on what the board is for. |
| `swimlane_theme` | What a swimlane stands for on this board, e.g. `account`, `region`. |
| `card_count` | Active cards. Archived cards in the file are not counted. |
| `includes` | Any of `labels`, `checklists`, `comments`, `history`, derived from the file's contents. |
| `order` | Gallery order. Unique; the list is sorted by it. |
| `schema_version` | The export schema version of the file. |
| `date_anchor` | The day the board's dates are measured from. Send it as the import option [`shift_dates_from`](#import-options) to have the imported board dated around today. |

### `GET /api/v1/boards/samples/{id}/`
Return one sample as the raw Visiban JSON export (`Content-Type: application/json`), with a strong `ETag`. Send it back in `If-None-Match` to get `304 Not Modified` with no body. The bundled nginx (Compose and the Helm frontend) gzips `application/json` for clients that send `Accept-Encoding: gzip`, so a fetch is roughly 30-60 KB on the wire against 265-560 KB raw. A deployment behind a different proxy gets the raw size unless that proxy compresses.

| Status | When |
|---|---|
| `401 Unauthorized` | Not authenticated. |
| `403 Forbidden` | The account has a pending password or username change, or the token lacks the `read` scope. |
| `404 Not Found` | `id` is not in the shipped manifest. |

---

## Templates

### `GET /api/v1/boards/templates/`
List all active board templates. Requires authentication. Used by the board creation modal to populate the template picker.

This endpoint and board creation (`POST /api/v1/boards/`, `POST /api/v1/groups/{id}/boards/`) read the same `BoardTemplate` database table — a template's listed columns are exactly the columns a board created with it will get (#1115).

**Response**
```json
[
  {
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "name": "Sales Pipeline",
    "slug": "sales_pipeline",
    "description": "Track deals through your sales stages.",
    "icon": "chart-up",
    "lane_label": "Account",
    "lane_placeholder": "e.g. Acme Corp",
    "columns_json": [
      { "name": "Prospect", "color": "#6B7280", "position": 0 },
      { "name": "Qualified", "color": "#3B82F6", "position": 1 },
      { "name": "Discovery", "color": "#8B5CF6", "position": 2 },
      { "name": "Demo", "color": "#F59E0B", "position": 3 },
      { "name": "Proposal Sent", "color": "#F97316", "position": 4 },
      { "name": "Negotiation", "color": "#EF4444", "position": 5 },
      { "name": "Closed Won", "color": "#10B981", "position": 6, "is_done": true },
      { "name": "Closed Lost", "color": "#9CA3AF", "position": 7, "is_done": true }
    ],
    "sort_order": 1
  },
  ...
]
```

| Field | Description |
|---|---|
| `id` | UUID — not an integer |
| `slug` | Stable identifier (used by integrations) — snake_case, e.g. `sales_pipeline`, `simple_kanban` |
| `lane_label` | Label for the "first swimlane" step in board creation (e.g. "Account", "Project") |
| `lane_placeholder` | Placeholder text shown in the swimlane name input |
| `columns_json` | Native JSON array of column objects that will be created: `{name, color, position}`, plus `is_done: true` on a template's terminal column(s) (e.g. "Done", "Closed Won") — omitted (not `false`) on every other column. |

Available templates: **Sales Pipeline**, **Customer Support**, **Customer Success**, **Simple Kanban**, **Product Roadmap**, **Project Delivery**, **Content Production**, **Hiring & Recruiting**, **Legal & Compliance**, **Infrastructure & DevOps**, **Blank Board**.

**Registering additional templates.** An installed package (not just enterprise) can register more templates without an OSS code change or migration via `boards.hooks.TEMPLATE_PROVIDERS` — see that module for the callable signature and conflict policy (new slugs only; an existing row, built-in or provider-registered, is never overwritten by the sync). See [`docs/architecture/open-core-boundary.md`](../architecture/open-core-boundary.md) for how this fits the OSS extension-point conventions.

### `GET /api/v1/boards/{id}/summary/`
Board health summary — per-swimlane card counts, stage distribution, and velocity. Uses 1–4 aggregate queries regardless of board size (1 unconditionally, plus up to 3 more only when the board has at least one done column).

**Response shape:**

```json
{
  "swimlanes": [
    {
      "id": 1,
      "name": "Acme Corp",
      "color": "#3B82F6",
      "total_cards": 5,
      "active_cards": 3,
      "done_30d": 4,
      "avg_cycle_days": 6.5,
      "stage_distribution": { "Backlog": 2, "In Progress": 3, "Done": 0 },
      "velocity_7d": 1,
      "velocity_30d": 4
    }
  ],
  "extension_panels": []
}
```

| Field | Type | Description |
|---|---|---|
| `id`, `name`, `color` | — | Swimlane identifier, name, and color |
| `total_cards` | integer | Total active (non-archived) cards in this swimlane |
| `active_cards` | integer | Cards in this swimlane that are not in a done column |
| `done_30d` | integer | Cards completed in the last 30 days (cards moved into any column with `is_done: true`) |
| `avg_cycle_days` | float\|null | Average number of days from a card's first movement to its done-column entry; `null` if no completed cards |
| `stage_distribution` | object | Card count per column for this swimlane (all columns, including zero counts) |
| `velocity_7d` | integer | Cards moved into any column with `is_done: true` in the last 7 days |
| `velocity_30d` | integer | Cards moved into any column with `is_done: true` in the last 30 days |
| `extension_panels` | array | Always `[]` in OSS — reserved slot for enterprise analytics panel extensions |

---

### `GET /api/v1/boards/{id}/analytics/`
Time-in-stage heatmap derived from `CardMovement` records.

**Query parameters:**

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `days` | integer | `30` | Must be a positive integer (`≥ 1`, `≤ 365`). Returns `400` if non-integer, `≤ 0`, or `> 365`. |
| `stalled_days` | integer | board's `staleness_threshold_days` | When provided, overrides the board setting for stalled-card detection in this request only. Must be a positive integer (`≥ 1`, `≤ 90`). Returns `400` if non-integer, `≤ 0`, or `> 90`. Omit to use the board's configured threshold. |

**Response shape:**

```json
{
  "days": 30,
  "columns": ["Backlog", "In Progress", "Done"],
  "done_columns": ["Done"],
  "board_medians": { "Backlog": 2.0, "In Progress": 5.5 },
  "stalled_threshold_days": 7,
  "staleness_threshold_days": 7,
  "stale_warning_pct": 75,
  "swimlanes": [
    {
      "id": 1,
      "name": "Acme Corp",
      "avg_days_per_column": { "Backlog": 1.5, "In Progress": 8.0 },
      "is_outlier": { "Backlog": false, "In Progress": true },
      "age_avg_days_per_column": { "Backlog": 2.1, "In Progress": 9.3 },
      "age_is_outlier": { "Backlog": false, "In Progress": true },
      "throughput_avg_days_per_column": { "Backlog": 1.2, "In Progress": 7.5 },
      "throughput_card_count_per_column": { "Backlog": 4, "In Progress": 2 },
      "throughput_is_outlier": { "Backlog": false, "In Progress": true },
      "deal_velocity_days": 12.3,
      "stalled_cards": [
        { "id": 42, "uid": "3a9f1c2d7e4b8a05", "title": "Fix login bug", "days_since_move": 14 }
      ]
    }
  ]
}
```

**Response fields:**

| Field | Type | Description |
|---|---|---|
| `days` | integer | The window used for the query, mirrored from the `days` query parameter. |
| `columns` | list[str] | All column names on the board in position order, including done columns. Preserved for backward compatibility — consumers that need only active columns should subtract `done_columns`. |
| `done_columns` | list[str] | Column names where `is_done=True`. These columns are excluded from the dwell-time heatmap. The `avg_days_per_column`, `is_outlier`, and `board_medians` dicts contain keys only for active (non-done) columns. |
| `board_medians` | object | Median dwell time in days per active column, keyed by column name. Done columns are omitted. Preserved for backward compatibility — prefer `age_avg_days_per_column` for current-dwell snapshots. |
| `stalled_threshold_days` | integer | Effective threshold used for stalled-card detection in this response. Equals `staleness_threshold_days` when `stalled_days` is not provided, or the supplied `stalled_days` value otherwise. |
| `staleness_threshold_days` | integer | The board's configured staleness threshold in days. Used for heatmap outlier coloring (`is_outlier`, `age_is_outlier`, `throughput_is_outlier`). Always reflects the board setting regardless of any `stalled_days` override. |
| `stale_warning_pct` | integer | The board's warning percentage (0–100). Controls the yellow/green boundary in the heatmap. |
| `swimlanes[].avg_days_per_column` | object | **Deprecated.** Period-filtered average dwell time per active column (clamped entry). Kept for backward compatibility — prefer `throughput_avg_days_per_column` instead. |
| `swimlanes[].is_outlier` | object | Whether `avg_days_per_column` for each active column meets or exceeds `staleness_threshold_days`. Done columns are omitted. |
| `swimlanes[].age_avg_days_per_column` | object | Snapshot of current dwell time for cards **presently sitting** in each active column (i.e. how long each currently-dwelling card has been in its column, averaged per column). Cards in done columns are excluded. `null` when the column has no currently-dwelling cards. |
| `swimlanes[].age_is_outlier` | object | Whether `age_avg_days_per_column` for each active column meets or exceeds `staleness_threshold_days`. |
| `swimlanes[].throughput_avg_days_per_column` | object | Average dwell time for cards that **exited** each active column during the period window. Cards still dwelling (not yet moved out) are excluded. `null` when no cards exited during the window. |
| `swimlanes[].throughput_card_count_per_column` | object | Number of cards that exited each active column during the period window. `0` means no cards exited. |
| `swimlanes[].throughput_is_outlier` | object | Whether `throughput_avg_days_per_column` for each active column meets or exceeds `staleness_threshold_days`. |
| `swimlanes[].deal_velocity_days` | number or null | Average days between a card's first and last movement within the period for this swimlane. `null` when there is no velocity data. |
| `swimlanes[].stalled_cards` | array | Cards that have not moved for longer than `stalled_threshold_days`. Each entry is `{ "id", "uid", "title", "days_since_move" }`. |

A cell is flagged as an outlier (`is_outlier: true`) when its per-swimlane average meets or exceeds the board's `staleness_threshold_days`. Heatmap color-coding uses `staleness_threshold_days` and `stale_warning_pct` to determine green, yellow, and red thresholds (see [Analytics — Color-coding](../features/analytics.md#color-coding)). Done columns are excluded from dwell-time calculations entirely — cards that have moved into a done column are considered complete and do not accumulate further dwell time in the heatmap. Archived cards contribute their dwell time up to the archive timestamp; active cards accumulate dwell time until they move again. Cards are excluded from stalled detection once archived.

CSV export (`Export CSV` button) is available to any board member whose role meets the board's `export_min_role` threshold. Owners and site admins always bypass.

---

### `GET /api/v1/boards/{id}/movements/`
Board-level movement history for all cards on the board, sorted newest first. Requires any board membership (viewer and above).

**Permissions:** any board member (`viewer` and above).

**Pagination:** fixed page size of 50 results. Use `offset` to page through results.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `swimlane_id` | integer | Filter by the card's current swimlane |
| `to_column_id` | integer | Filter by destination column |
| `moved_by_id` | integer | Filter by the user who performed the move |
| `moved_after` | ISO date | Include movements on or after this date (e.g. `2026-01-01`) |
| `moved_before` | ISO date | Include movements on or before this date |
| `exclude_type` | comma-separated string | Exclude movement types (e.g. `archived,unarchived` hides system events) |
| `offset` | integer | Pagination offset (default: `0`) |

`export_min_role` also applies to movement exports requested with `?export=<format>`: a caller below the threshold receives the same `403` with `code: "export_restricted"` as the board export, and each successful export is recorded in the [export history](#get-apiv1boardsidexport-history). Movement exports share the board export rate limit (20 exports/hour per authenticated user, scope `board_export`; `429 Too Many Requests` when exceeded). Ordinary movement reads are not rate limited by it.

When neither `moved_after` nor `moved_before` is specified, the full movement history is returned (no default date cutoff). Results are always paginated to `page_size: 50` so the absence of a date window does not cause runaway queries.

**Response**
```json
{
  "count": 142,
  "offset": 0,
  "page_size": 50,
  "results": [
    {
      "id": 1089,
      "card_title": "Fix login bug",
      "card_uid": "a1b2c3d4e5f60001",
      "from_column": 2,
      "from_column_name": "In Progress",
      "from_column_uid": "c0l0abc123456701",
      "to_column": 3,
      "to_column_name": "Done",
      "to_column_uid": "c0l0abc123456702",
      "from_swimlane": 1,
      "from_swimlane_name": "Acme Corp",
      "from_swimlane_uid": "sw1mabcdef123401",
      "to_swimlane": 1,
      "to_swimlane_name": "Acme Corp",
      "to_swimlane_uid": "sw1mabcdef123401",
      "moved_by": { "id": 3, "username": "alice", "display_name": "Alice Smith", "avatar_url": null },
      "moved_at": "2026-03-25T14:30:00Z",
      "movement_type": "move",
      "notes": ""
    }
  ]
}
```

Each result object fields:

| Field | Type | Description |
|---|---|---|
| `id` | integer | Movement record ID |
| `card_title` | string | Card title at time of retrieval |
| `card_uid` | string | Card stable 16-char hex UID |
| `from_column`, `to_column` | integer / null | Column FK IDs (may be `null` if column was deleted) |
| `from_column_name`, `to_column_name` | string | Denormalized column names (preserved after deletion) |
| `from_column_uid`, `to_column_uid` | string | Denormalized column UIDs |
| `from_swimlane`, `to_swimlane` | integer / null | Swimlane FK IDs (may be `null` if swimlane was deleted) |
| `from_swimlane_name`, `to_swimlane_name` | string | Denormalized swimlane names |
| `from_swimlane_uid`, `to_swimlane_uid` | string | Denormalized swimlane UIDs |
| `moved_by` | object | User who performed the move — `{ id, username, display_name, avatar_url }` |
| `moved_at` | string | ISO 8601 timestamp |
| `movement_type` | string | One of `move`, `archived`, `unarchived` |
| `notes` | string | Optional notes recorded at move time |

**Errors:** `403 Forbidden` if the caller is not a board member; `404 Not Found` if the board does not exist.

---

## Saved Filters

Saved filters are user-scoped filter presets on a board. Any board member (including viewers) can save and restore their own filter presets. Filters are private — users cannot see or modify other users' presets.

### `GET /api/v1/boards/{id}/saved-filters/`
List all saved filters belonging to the requesting user on this board.

**Response**
```json
[
  {
    "id": 1,
    "name": "My urgent cards",
    "state_json": { "priorities": ["urgent", "high"], "assigneeIds": [3] },
    "state_version": 1,
    "created_at": "2026-03-20T10:00:00Z"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | integer | Filter preset ID |
| `name` | string | User-defined name (unique per user per board, max 100 characters) |
| `state_json` | object | Filter state — see [shape](#state_json-shape) below |
| `state_version` | integer | Schema version of `state_json` (currently `1`; rows predating v1.1 backfill to `1`) |
| `created_at` | string | ISO 8601 timestamp |

### `POST /api/v1/boards/{id}/saved-filters/`
Create a new saved filter preset.

**Request**

| Field | Required | Description |
|---|---|---|
| `name` | ✓ | Filter name (max 100 characters, unique per user per board) |
| `state_json` | ✓ | Filter state object — see [shape](#state_json-shape) below |
| `state_version` |  | Schema version the client is writing (positive integer; defaults to `1`). Clients should send `1`; the server accepts higher values unchanged so a mixed-version deploy does not lose the user's save |

#### `state_json` shape

Top-level keys are validated server-side. Unknown keys are rejected; each known key is type-checked but its values are not semantically validated (the frontend remains responsible for confirming, e.g., that an `assigneeId` corresponds to a real user):

| Key | Type | Notes |
|---|---|---|
| `search` | string | Free-text search term |
| `assigneeIds` | integer[] | User IDs to include |
| `labelIds` | integer[] | Label IDs to include |
| `priorities` | string[] | Subset of `low`, `medium`, `high`, `urgent` |
| `dueDate` | string \| null | One of `overdue`, `today`, `this_week`, `none`, or `null` for "no filter" |

All keys are optional. The total serialized size of `state_json` must not exceed 64 KB.

**Errors:** `400 Bad Request` if name is empty, exceeds 100 characters, a filter with the same name already exists for this user on this board, `state_json` contains unknown keys or wrong-typed values, or `state_version` is not a positive integer.

### `DELETE /api/v1/boards/{id}/saved-filters/{filter_id}/`
Delete a saved filter preset. Only the owning user can delete their own filters — attempting to delete another user's filter returns `404 Not Found`.

---

## Export & Import

### `GET /api/v1/boards/{id}/export/`
Export the board. Append `?format=json` for a JSON dump; omit for CSV (the default).

**Query parameters**

| Parameter | Values | Default | Description |
|---|---|---|---|
| `format` | `json` | _(omit for CSV)_ | Response format. Omit or set to anything other than `json` for CSV. |

**Rate limit:** 20 exports/hour per authenticated user (scope: `board_export`). Exceeding the limit returns `429 Too Many Requests`.

Requires board membership — non-members receive `403 Forbidden` with body `{"detail": "Board export requires board membership."}`. If the caller is a member but their role is below the board's `export_min_role` threshold, returns `403 Forbidden` with body `{"detail": "...", "code": "export_restricted", "min_role": "<threshold>"}`. Owners and site admins always bypass the threshold.

**CSV columns:** `Card ID`, `Title`, `Description`, `Column`, `Swimlane`, `Priority`, `Assignee`, `Labels`, `Due Date`, `Weight`, `Created At`, `Created By`, `Last Moved At`, `Movement Count`, `Movement History`

`Movement History` is a semicolon-separated list of pipe-delimited records: `<timestamp>|<from_column>|<to_column>|<moved_by>`.

Since 1.2, one further column is **appended** per [custom field](#custom-fields-since-12)
defined on the board, in the fields' display order, headed `Custom: <field name>`. The
fixed columns above keep their positions, so a consumer reading by index is unaffected.
The prefix keeps a field named e.g. `Title` from colliding with a built-in header.
A [multi-select](#multi-select-fields) value is written as its entries joined with `"; "`.

Also since 1.2, one further column is appended per [swimlane custom
field](#swimlane-custom-fields-since-12) defined on the board, after the `Custom: ` block,
headed `Swimlane Custom: <field name>`. A row field's value is repeated on every card row
belonging to that swimlane, so the CSV stays one row per card. The distinct `Swimlane
Custom: ` prefix (rather than reusing `Custom: `) is required, not cosmetic: a card field
and a row field may legally share a `name` on the same board, and sharing the prefix would
produce two identical headers. A field with `is_admin_only: true` produces no column at all
for an exporter below `admin` — its existence is not disclosed, the same rule
`contact_email`/`notes` already follow in this export.

### `GET /api/v1/boards/{id}/export/?format=json`
Export the board as JSON. Returns `application/json`. Same permission rules as the CSV variant: requires board membership and meeting the `export_min_role` threshold. Owners and site admins always bypass.

**Rate limit:** 20 exports/hour per authenticated user (scope: `board_export`). Exceeding the limit returns `429 Too Many Requests`.

**Response shape:**

The top-level `schema_version` field is always `2` in 1.1+ exports. The importer understands versions 0 (pre-1.0, no field present), 1, and 2. Version 2 adds `archived_at` per card, `movement_type`, movement `notes`, and comment `created_at`.

Each card also carries its own `movements` (`{from_column, to_column, from_swimlane, to_swimlane, moved_by, moved_at, notes, movement_type}`, one per `CardMovement`) and `activities` (`{event_type, from_value, to_value, actor, created_at}`, one per `CardActivity`) arrays, mirroring the [movements](cards.md#history) and [activities](cards.md#history) endpoints. As with the rest of this export, `moved_by`/`actor` are usernames rather than user objects, and `null` when the acting user has since been deleted.

Since 1.2 the payload also carries the board's `custom_fields` schema and each card's
`custom_field_values`, keyed by field name. Both are **additive**, so `schema_version`
stays at `2` and an existing consumer is unaffected. JSON import restores both (see
[Custom fields on import](#custom-fields-on-import)).

Also since 1.2, each card carries `external_ref` (`{ provider, ref, url }`, or `null` when unset). On import it is restored after validation against the same rules as the card API; invalid entries are silently dropped. CSV export and import do not carry it.

Also since 1.2, each swimlane object carries its own `custom_field_values` (keyed by
[swimlane custom field](#swimlane-custom-fields-since-12) name), and a top-level
`swimlane_custom_fields` array carries that schema — the row-level counterpart to
`custom_fields`/`custom_field_values`, kept as separate keys rather than merged into the
card ones because they are independent per-board sets attached to different objects.
Both are additive, and JSON import restores them, same as the card-level pair. A definition with
`is_admin_only: true`, and any value under it, is omitted from the export entirely for a
caller below `admin` — the same role gate this export already applies to a swimlane's
`contact_email` and `notes`.

```json
{
  "schema_version": 2,
  "name": "Sales Pipeline",
  "description": "",
  "columns": [{ "name": "Backlog", "position": 0, "color": "#64748B", "wip_limit": null, "weight_limit": null, "allow_card_creation": true }],
  "swimlanes": [
    {
      "name": "Acme Corp",
      "position": 0,
      "color": "#3B82F6",
      "contact_email": "",
      "notes": "",
      "custom_field_values": { "Account Tier": "Enterprise" }
    }
  ],
  "labels": [{ "name": "Bug", "color": "#EF4444" }],
  "custom_fields": [
    { "name": "Array Type", "field_type": "dropdown", "choices": ["raid6", "raid10"], "position": 0, "show_on_card": true, "is_required": false, "help_text": "", "number_prefix": "", "number_suffix": "", "number_decimals": null, "choice_colors": { "raid10": "green" } }
  ],
  "swimlane_custom_fields": [
    { "name": "Account Tier", "field_type": "dropdown", "choices": ["Startup", "Growth", "Enterprise"], "position": 0, "show_on_row": true, "is_admin_only": true, "is_required": false, "help_text": "", "number_prefix": "", "number_suffix": "", "number_decimals": null, "choice_colors": {} }
  ],
  "cards": [
    {
      "title": "Fix login bug",
      "description": "",
      "column": "Backlog",
      "swimlane": "Acme Corp",
      "priority": "high",
      "assignee": "alice",
      "labels": ["Bug"],
      "due_date": "2026-04-01",
      "weight": 2,
      "position": 0,
      "created_at": "2026-03-01T10:00:00Z",
      "created_by": "alice",
      "archived_at": null,
      "custom_field_values": { "Array Type": "raid10" },
      "external_ref": { "provider": "gitlab", "ref": "acme/webapp!45", "url": "https://gitlab.com/acme/webapp/-/merge_requests/45" },
      "comments": [{ "author": "bob", "body": "On it.", "created_at": "2026-03-02T09:00:00Z" }],
      "checklist": [{ "text": "Write tests", "is_checked": false }],
      "movements": [
        { "from_column": null, "to_column": "Backlog", "from_swimlane": null, "to_swimlane": "Acme Corp", "moved_by": "alice", "moved_at": "2026-03-01T10:00:00Z", "notes": "", "movement_type": "move" }
      ],
      "activities": [
        { "event_type": "priority_change", "from_value": "medium", "to_value": "high", "actor": "alice", "created_at": "2026-03-01T11:00:00Z" }
      ]
    }
  ]
}
```

### `GET /api/v1/boards/{id}/export-history/`
Return recent successful board exports for audit purposes (#842). Requires board `admin` or `site_admin` role — the board owner always resolves to `admin` even with no explicit membership row, so only `member`, `collaborator`, and `viewer` roles are actually turned away, with `403 Forbidden` and body `{"detail": "Export history is restricted to board admins."}`. Failed exports (permission denied, rate limited) are not logged.

**Response** (paginated — standard DRF envelope with `count`, `next`, `previous`, `results`; ordered newest-first)

```json
{
  "count": 12,
  "next": null,
  "previous": null,
  "results": [
    {
      "id": 42,
      "actor": { "id": 1, "username": "alice", "display_name": "Alice", "avatar_url": "" },
      "actor_role_label": "member",
      "export_format": "csv",
      "row_count": 128,
      "created_at": "2026-04-22T14:31:02Z"
    }
  ]
}
```

| Field | Description |
|---|---|
| `actor` | The user who performed the export, or `null` if the user has since been deleted. |
| `actor_role_label` | Role the actor held at the moment of export. One of `"viewer"`, `"collaborator"`, `"member"`, `"admin"`, `"owner"`, `"site_admin"` — captured at write time, not recomputed on read. Distinct from `Board.export_min_role`, which only accepts the lower four values. |
| `export_format` | `"csv"` or `"json"` for board exports; `"movements_<format>"` (lowercased, at most 20 characters) for movement history exports. |
| `row_count` | Number of cards included in the export. |
| `created_at` | ISO 8601 timestamp. |

### `POST /api/v1/boards/import/`
Import a board from a Visiban JSON or CSV export file. Accepts `multipart/form-data` with a `file` field, an optional `name` field to override the board name, an optional `group_id` field to place the imported board into a group, and an optional `options` field to choose what to import. Creates a new board atomically.

**Permission:** authenticated user. When `group_id` is set, the caller must be a member of that group (any role — viewer and above); a non-member receives `403 Forbidden`.

**Rate limit:** 10 imports/hour per authenticated user (scope: `board_import`). Exceeding the limit returns `429 Too Many Requests`.

**Import limits:** up to 500 cards, 50 columns, and 100 swimlanes per import. Payloads exceeding these limits return `400 Bad Request`.

**Request** (`multipart/form-data`)

| Field | Required | Description |
|---|---|---|
| `file` | ✓ | The JSON or CSV export file. The file is treated as JSON if its name ends in `.json` **or** its content type contains `json`; otherwise as CSV if its name ends in `.csv` or its content type contains `csv`; anything else is rejected. The JSON check runs first, so a `.csv` file uploaded with a JSON content type is parsed as JSON. |
| `name` | | Board name to use, exactly as given — no prefix and no duplicate suffix. When omitted, the board is named by the rule in [Default board name](#default-board-name). |
| `group_id` | | Place the imported board into this group. Requires group membership (any role). |
| `options` | | A JSON object, sent as a string, choosing what to import. Omit it to import everything. See [Import options](#import-options). |

#### Default board name

> **Changed in 1.2** (#1446) — earlier releases named a JSON import after the file's `name` verbatim and every CSV import `Imported Board`. API callers that relied on the old default should send `name` explicitly.

Without a `name` field, both formats name the new board `Imported: <name>`:

- **JSON** — `<name>` is the `name` field in the file.
- **CSV** — a CSV carries no board name, so `<name>` is the uploaded filename without its extension (`Q3 plan.csv` → `Imported: Q3 plan`). An empty filename stem falls back to `Board`.

If a board with that exact name already exists, the lowest unused number is appended: `Imported: Roadmap - 1`, then `- 2`, and so on; a gap left by a deleted or renamed board is reused first. Only boards where the new board lands count: the target group's boards when `group_id` is set, otherwise every board you can access (your own or shared with you) that is not in a group — the boards listed under **My Boards** on the dashboard. The name is truncated to the 255-character limit so the prefix and number always fit. Board names are not unique, so two imports running at the same moment can occasionally receive the same name.

#### Import options

> **Added in 1.2**

Board structure (name, columns, swimlanes) is always imported. Every option is an optional boolean that defaults to `true`:

| Key | Imports | Formats |
|---|---|---|
| `cards` | Cards. JSON: with their assignees, due dates, weights, and MR/PR links, plus the "weight changed" activity entry for a non-default weight when `history` is on. CSV: title, description, priority, weight, due date, and assignee (the `Assignee` username, matched case-insensitively; blank or unknown usernames import unassigned) — no MR/PR link. | JSON, CSV |
| `labels` | Label definitions, the labels on cards, and the "label added" activity entries the importer records for them | JSON, CSV |
| `comments` | Card comments. Requires `cards`. | JSON |
| `checklist` | Card checklist items, and the "checklist item added" activity entries the importer records for them. Requires `cards`. | JSON |
| `history` | Card movements, the card `activities` from the file, and the "weight changed" activity entry the importer records for a non-default weight. Requires `cards`. | JSON |

The importer writes its own "label added", "checklist item added" and "weight changed"
entries only for history the file does not already record: with `history` on, a card whose
`activities` already contain that event type keeps the file's entries (with their original
actor and timestamp) and gets no synthetic copy, so re-importing an export does not double
its history.

One more option is not an include flag:

| Key | Type | Effect |
|---|---|---|
| `shift_dates_from` | `YYYY-MM-DD` string, JSON only, optional | Moves every date in the file forward by the whole days between this date and today: card due dates, `date` custom field values on cards and swimlanes, the timestamps on cards, comments, movements, and activities, and the old and new values of due-date-change history entries. Spacing between dates is preserved. Absent by default, so a plain import is unchanged. Must not be in the future or more than 10 years ago. A CSV import rejects it as an unknown option. Used by the sample flow with a sample's `date_anchor`. When given, it is echoed in `import_summary.options_applied` and the `board.created` event's `import_options`. |

An omitted `comments`, `checklist`, or `history` follows `cards`, so `{"cards": false}` alone imports structure and labels only. An explicit contradiction such as `{"cards": false, "comments": true}` is rejected.

An invalid `options` field returns `400 Bad Request` before anything is created, with one of these `detail` messages:

| `detail` | When |
|---|---|
| `'options' is not valid JSON.` | The field does not parse as JSON. |
| `'options' must be a JSON object.` | It parses, but not to an object (for example `[]` or `true`). |
| `Invalid 'options': Unknown import option(s): x.` | A key other than the five above and `shift_dates_from` — or, for a CSV file, other than `labels` and `cards`. |
| `Invalid 'options': 'shift_dates_from': shift_dates_from cannot be in the future.` | The date is after today (server date). |
| `Invalid 'options': 'shift_dates_from': shift_dates_from cannot be more than 10 years ago.` | The date is more than 10 years back. |
| `Invalid 'options': 'shift_dates_from': Date has wrong format. Use one of these formats instead: YYYY-MM-DD.` | The value is not a `YYYY-MM-DD` string (`null` reads `This field may not be null.`). |
| `Invalid 'options': Import option(s) comments require 'cards'.` | A dependent is explicitly `true` while `cards` is `false`. |
| `Invalid 'options': 'labels': Must be a valid boolean.` | A value is not a JSON boolean (the key named is the offending one; `null` reads `'labels': This field may not be null.`). |

```bash
curl -X POST https://visiban.example.com/api/v1/boards/import/ \
  -H "Authorization: Token $TOKEN" \
  -F file=@board.json \
  -F 'options={"labels": false, "history": false}'
```

#### Custom fields on import

> **Added in 1.2**

A JSON file's `custom_fields` and `swimlane_custom_fields` definitions are restored with the
board's structure, in list order, whatever the `options`. Each is validated exactly as the
[custom field](#custom-fields-since-12) and
[swimlane custom field](#swimlane-custom-fields-since-12) APIs validate a new definition, and
the per-board limits apply to the list as a whole: at most 30 card fields (2 shown on the
card) and 15 swimlane fields (8 shown on the row), with unique names. A definition that
fails returns `400 Bad Request` and creates nothing — for example
`'custom_fields' entry at index 1: 'choices': …` or `Duplicate swimlane_custom_fields names: Owner`.

Values (`custom_field_values` on each card and each swimlane, keyed by field name) go
through the same normalizer as `PATCH`. A value naming no imported field, or one its field's
type refuses, is dropped and the rest of the import proceeds. Card values follow the
`cards` option; swimlane values are structure and always import. Values exported by
Visiban are already in stored form and round-trip unchanged.

CSV import does not read the `Custom: ` or `Swimlane Custom: ` columns.

**Response** `201 Created`

Returns the newly created board object, using the same shape as `GET /api/v1/boards/{id}/`, plus an `import_summary` object.

```json
{
  "id": 512,
  "uid": "bd_1a2b3c4d5e6f7890",
  "name": "Imported: Roadmap",
  "owner": { "id": 7, "username": "alice", "display_name": "Alice" },
  "group": null,
  "created_at": "2026-04-21T14:02:11Z",
  "updated_at": "2026-04-21T14:02:11Z",
  "import_summary": {
    "options_applied": { "labels": false, "cards": true, "comments": true, "checklist": true, "history": false },
    "skipped": {
      "cards": 0,
      "comments": 0,
      "checklist_items": 0,
      "label_refs": 4,
      "movements": 12,
      "activities": 30
    }
  }
}
```

#### Import summary

> **Added in 1.2**

| Field | Description |
|---|---|
| `import_summary.options_applied` | All five options as resolved, including dependents that followed `cards`, plus `shift_dates_from` (a `YYYY-MM-DD` string) when it was sent. A CSV import reports `comments`, `checklist`, and `history` equal to `cards`. |
| `import_summary.skipped.*` | How many items in the file the chosen options left out: `cards`, `comments`, `checklist_items`, `label_refs` (label references on cards), `movements`, and `activities`. Items the importer drops regardless of options — a label name with no definition, an activity with an unknown event type — are not counted. All are `0` when no options are sent. |

The `board.created` event for the new board carries the resolved options as an additional `import_options` field.

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "..."}` | File is missing, empty, has an unsupported extension, exceeds the upload size limit (`MAX_UPLOAD_SIZE_BYTES`, default 10 MB — the same env var and default as [card attachment uploads](cards.md#attachments), and distinct from the Trello importer's own `VISIBAN_IMPORT_MAX_SIZE`), is not valid JSON/CSV, or references columns/swimlanes that fail validation. Also returned when `options` is not valid JSON, is not an object, has an unknown key, has a non-boolean value, sets `comments`, `checklist`, or `history` to `true` with `cards` set to `false`, or — for a CSV file — has any key other than `labels` and `cards`. |
| `401 Unauthorized` | `{"detail": "Authentication credentials were not provided."}` | Caller is not authenticated. |
| `403 Forbidden` | `{"detail": "..."}` | `group_id` was supplied but the caller is not a member of that group. |
| `404 Not Found` | `{"detail": "..."}` | `group_id` does not match an existing group. |
| `429 Too Many Requests` | `{"detail": "..."}` | The `board_import` rate limit was exceeded. |

### `POST /api/v1/boards/import/trello/`

> **Added in 1.2** (#456)

Import a Trello JSON export (Trello: **Menu → Print, export, and share → Export as JSON**) into a new board. The flow is stateless and has two steps: call with `?dry_run=true` to get a preview of exactly what will be created, then re-upload the same file with `?confirm=true` to create the board. Both modes run the same parsing and mapping code, so the preview is what the confirmed import does.

The import is **synchronous**: the board exists when the `201` returns. It is bounded by the upload size cap, the count caps below, and the rate limits. Imported content does not send notifications (no @mention, assignment, or card-moved notifications), and no movement history is recorded for imported cards.

**Permission:** authenticated user. When `group_id` is set, the caller must be the group owner or a member of that group (any role) in **both** modes, so a preview cannot be used to probe a group the caller could not import into. The caller becomes the board's owner and admin.

**Query parameters** — specify exactly one:

| Parameter | Description |
|---|---|
| `dry_run=true` | Parse and plan only. Returns `200 OK` with the preview. Creates nothing. |
| `confirm=true` | Create the board. Returns `201 Created`. |

Sending neither, or both, returns `400 Bad Request` (`"Specify exactly one of ?dry_run=true or ?confirm=true."`).

**Request** (`multipart/form-data`)

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | yes | The Trello JSON export. Maximum size is `VISIBAN_IMPORT_MAX_SIZE` (default 25 MB). |
| `name` | string | no | Board name. Defaults to the Trello board's name. Maximum 255 characters. Only used on `confirm`. |
| `group_id` | integer | no | Place the imported board into this group. Also widens the pool used for [member matching](#member-matching). |
| `mapping` | string (JSON) | no | JSON-encoded object of mapping options, described below. Omitted or blank means all defaults. Send the same `mapping` on `dry_run` and `confirm`. |
| `file_sha256` | string | no | On `confirm`, the `file_sha256` returned by the preview. If present and it does not match the uploaded file, the request is rejected with `400`, so a different file cannot be swapped in between preview and confirm. |

**`mapping` options** — unknown keys return `400`.

| Key | Type | Default | Description |
|---|---|---|---|
| `swimlane_label_ids` | string[] | `[]` | Trello label ids (from `mapping.labels[].trello_id` in the preview) to turn into swimlanes, in the order given. Only named labels are eligible (`swimlane_eligible: true`). |
| `default_swimlane_name` | string | `"Unassigned"` | Name of the swimlane for cards that have no mapped label. Must be non-empty and must not equal the name of a label mapped to a swimlane. |
| `include_archived_lists` | boolean | `false` | Import archived (closed) lists as columns, and their cards as archived cards. |
| `add_matched_members` | boolean | `false` | Add [matched members](#member-matching) to the board and assign them to their cards. |

**Mapping rules**

- **Lists to columns**, ordered by Trello position and renumbered densely from 0. Archived lists are skipped unless `include_archived_lists` is `true`; their cards are then imported as archived cards. Without that option, cards in archived lists are skipped. Cards that reference a list missing from the export are skipped.
- **Labels** keep their names. Trello color names are converted to hex (`#RRGGBB`); an unnamed label is named after its color. A duplicate name gets a `" (2)"` suffix (then `(3)`, and so on).
- **Labels to swimlanes** for the labels listed in `swimlane_label_ids`. A card goes to the swimlane of the first mapped label in **the card's own label order**; any other mapped labels stay as ordinary labels. Cards with no mapped label go to the default swimlane.
- **Checklists** are flattened into one checklist per card. When a card has several checklists, each item's text is prefixed with its checklist name.
- **Comments** are imported with their original timestamps.
- **Archived cards** (closed in Trello) are imported archived.
- **Attachments** are not copied. Each attachment is appended to the card description as a link, and only `http` and `https` URLs are kept. Uploaded files are reported under `unmappable` as `attachment_files`.
- **Due dates** are converted to a UTC date.

#### Member matching

A Trello member matches a Visiban user when the Trello **username** equals the Visiban username exactly, ignoring case. Display and full names are never used.

Matching only considers users the caller can already see: co-members of the caller's boards, co-members of the caller's groups, members of any group the caller owns, and members and owner of the target group. Site admins can match any active user. This keeps a crafted file from being used to check whether an arbitrary username exists. The response reports only a **count** of matches, never which accounts matched.

- `add_matched_members: false` (default): matched users are not added to the board, cards are left unassigned, and every comment is authored by the importer, starting with the plain-text line `Full Name (imported from Trello):`.
- `add_matched_members: true`: matched users are added to the board with the `member` role and assigned to their cards (the first matched Trello member on each card). Their comments are authored by them but always start with the plain-text line `(imported from Trello)`, so an imported comment is never indistinguishable from one posted in Visiban. Comments by unmatched people keep the `Full Name (imported from Trello):` form. Adding members sends no notification.

Unmatched members are listed in the preview by their Trello name (from the uploader's own file).

**Import limits.** Exports over any of these caps return `400 Bad Request`:

| Item | Cap |
|---|---|
| Lists | 50 |
| Cards | 5,000 |
| Labels | 200 |
| Checklist items | 20,000 |
| Comments | 20,000 |
| Members | 1,000 |
| Actions (Trello activity entries, including comments) | 50,000 |
| Attachments (all cards) | 20,000 |
| Label or member references on one card | 500 |
| JSON objects and arrays in the file | 1,000,000 |

**Rate limits**

| Mode | Scope | Limit |
|---|---|---|
| `dry_run=true` | `board_import_preview` | 60/hour per authenticated user |
| `confirm=true` | `board_import` | 10/hour per authenticated user, **shared** with [`POST /api/v1/boards/import/`](#post-apiv1boardsimport) |

Exceeding either limit returns `429 Too Many Requests`. Previews are throttled separately so that re-previewing while adjusting the mapping does not consume the import budget.

**Response** `200 OK` (`dry_run=true`) — the preview:

```json
{
  "source": "trello",
  "file_sha256": "9f2b6c1d0a7e4f38b5c9d2e1a4f7083c6b5d9e2f1a0c8b7d6e5f4a3b2c1d0e9f",
  "board": { "name": "Website Relaunch", "description": "Q4 marketing site rebuild" },
  "counts": {
    "lists": 5,
    "lists_archived": 1,
    "cards": 42,
    "cards_archived": 6,
    "labels": 8,
    "checklists": 7,
    "checklist_items": 31,
    "comments": 58,
    "attachments": 9,
    "members": 4
  },
  "result": {
    "columns": 4,
    "swimlanes": 3,
    "labels": 8,
    "cards": 37,
    "cards_archived": 2,
    "checklist_items": 28,
    "comments": 52
  },
  "mapping": {
    "columns": [
      { "trello_id": "64f1a2b3c4d5e6f708192a3b", "name": "Backlog", "position": 0, "card_count": 12, "archived": false },
      { "trello_id": "64f1a2b3c4d5e6f708192a3c", "name": "Old ideas", "position": null, "card_count": 5, "archived": true }
    ],
    "labels": [
      {
        "trello_id": "64f1a2b3c4d5e6f708192a40",
        "name": "Design",
        "color": "#9F8FEF",
        "original_color": "purple",
        "card_count": 14,
        "swimlane_eligible": true
      }
    ],
    "swimlanes": [
      { "name": "Design", "label_id": "64f1a2b3c4d5e6f708192a40" },
      { "name": "Unassigned", "label_id": null }
    ],
    "default_swimlane": "Unassigned"
  },
  "members": {
    "total": 4,
    "matched": 2,
    "unmatched": [
      { "trello_id": "5a1b2c3d4e5f6a7b8c9d0e1f", "full_name": "Priya Nair" },
      { "trello_id": "5a1b2c3d4e5f6a7b8c9d0e20", "full_name": "Tom Becker" }
    ]
  },
  "options": {
    "swimlane_label_ids": ["64f1a2b3c4d5e6f708192a40"],
    "default_swimlane_name": "Unassigned",
    "include_archived_lists": false,
    "add_matched_members": false
  },
  "warnings": [
    {
      "code": "archived_lists_skipped",
      "message": "Archived lists and their cards will be skipped. Turn on “Include archived lists” to import them.",
      "count": 1
    },
    {
      "code": "matched_members_not_added",
      "message": "Matched members will not be added to the board; assignees are left empty and comments are attributed to you.",
      "count": 2
    }
  ],
  "unmappable": [
    { "kind": "attachment_files", "count": 9 },
    { "kind": "power_up_data", "count": 3 }
  ]
}
```

In `mapping.columns`, `position` is `null` for a list that will not be imported (an archived list while `include_archived_lists` is `false`). `mapping.columns[].name` and `mapping.labels[].name` are the final names after de-duplication.

`counts` describes the Trello file; `result` describes what will be created.

**`warnings`** — each entry is `{code, message, count}` and is only present when `count` is greater than zero. Codes:

| Code | Meaning |
|---|---|
| `archived_lists_skipped` | Archived lists (and their cards) will be skipped; `include_archived_lists` is `false`. |
| `cards_in_archived_lists_skipped` | Cards in archived lists will be skipped. |
| `cards_missing_list` | Cards referencing a list that is not in the export will be skipped. |
| `multiple_swimlane_labels` | Cards with more than one swimlane label go to the swimlane of their first such label. |
| `checklists_flattened` | Cards with several named checklists get one combined checklist with prefixed item text. |
| `invalid_due_dates` | Due dates that could not be read will be left empty. |
| `descriptions_truncated` | Card descriptions longer than 50,000 characters (including the appended attachment links) will be shortened to 50,000. |
| `comments_truncated` | Comments longer than 10,000 characters (including the attribution prefix) will be shortened to 10,000. |
| `unknown_labels` | Label references missing from the export will be ignored. |
| `comments_may_be_incomplete` | The export hit Trello's 1,000-action limit, so older comments may be missing. |
| `matched_members_not_added` | Members matched but `add_matched_members` is `false`. Only present when `false`. |
| `unmatched_members` | Members with no matching Visiban user are not assigned; their comments are attributed to the importer with their Trello name. |

**`unmappable`** — Trello data that has no Visiban equivalent and is dropped. Each entry is `{kind, count}`, present only when the count is greater than zero. Kinds:

| Kind | Meaning |
|---|---|
| `attachment_files` | Attachments (only a link is preserved in the card description; file contents are not copied). |
| `custom_fields` | Trello custom field definitions and per-card values. |
| `power_up_data` | Power-Up data on the board or on cards. |
| `start_dates` | Card start dates. |
| `stickers` | Card stickers. |

**Response** `201 Created` (`confirm=true`)

Unlike [`POST /api/v1/boards/import/`](#post-apiv1boardsimport), which returns the board object at the top level (with an added `import_summary`), this endpoint wraps the board together with a summary. `board` has the same shape as `GET /api/v1/boards/{id}/`; `summary` repeats the preview's `counts`, `result`, `warnings`, and `unmappable`.

```json
{
  "board": {
    "id": 513,
    "uid": "bd_7c1e9a4b2d6f8035",
    "name": "Website Relaunch",
    "owner": { "id": 7, "username": "alice", "display_name": "Alice" },
    "group": null,
    "created_at": "2026-09-26T14:02:11Z",
    "updated_at": "2026-09-26T14:02:11Z"
  },
  "summary": {
    "counts": {
      "lists": 5, "lists_archived": 1, "cards": 42, "cards_archived": 6, "labels": 8,
      "checklists": 7, "checklist_items": 31, "comments": 58, "attachments": 9, "members": 4
    },
    "result": {
      "columns": 4, "swimlanes": 3, "labels": 8, "cards": 37,
      "cards_archived": 2, "checklist_items": 28, "comments": 52
    },
    "warnings": [
      {
        "code": "archived_lists_skipped",
        "message": "Archived lists and their cards will be skipped. Turn on “Include archived lists” to import them.",
        "count": 1
      }
    ],
    "unmappable": [
      { "kind": "attachment_files", "count": 9 }
    ]
  }
}
```

Creating the board broadcasts `board.created` on the same channels as the native import.

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "..."}` | Neither or both of `dry_run` / `confirm` given; `file` missing; the file is not valid UTF-8 JSON or is nested too deeply; it is not a Trello export (`lists` and `cards` are required); a schema or type error (the message names the offending field); an [import cap](#post-apiv1boardsimporttrello) is exceeded; `mapping` is not a JSON object, has an unknown key, has a wrong type, lists a label that is not a named label in the export, or uses a `default_swimlane_name` that collides with a mapped label; on `confirm`, `file_sha256` does not match the uploaded file; on `confirm`, there are no lists to import (for example, every list is archived and `include_archived_lists` is `false`). |
| `401 Unauthorized` | `{"detail": "Authentication credentials were not provided."}` | Caller is not authenticated. |
| `403 Forbidden` | `{"detail": "..."}` | `group_id` was supplied but the caller is not a member of that group; or the account has a pending password or username change. |
| `404 Not Found` | `{"detail": "..."}` | `group_id` does not match an existing group. |
| `413 Content Too Large` | `{"detail": "File too large. The maximum size for a Trello import is 25 MB."}` | The file is larger than `VISIBAN_IMPORT_MAX_SIZE`. Note that the native import endpoint returns `400` for an oversized file. |
| `429 Too Many Requests` | `{"detail": "Request was throttled. ..."}` | Rate limit exceeded; see **Rate limits** above. |

---

## Members

### `POST /api/v1/boards/{id}/members/`
Add or update a board member. Requires board admin. Cannot modify a site admin's board membership (same restriction as `DELETE` below).

**Request** `{ "user_id": 42, "role": "member", "is_moderator": true }`

| Field | Required | Description |
|---|---|---|
| `user_id` | ✓ | ID of the user to add or update |
| `role` | | Role to assign (default: `"member"`). Valid: `admin`, `member`, `collaborator`, `viewer` |
| `is_moderator` | | Boolean. Grants content-moderation rights (delete/archive others' content). Only valid for `member` and `admin` roles — setting `true` on a collaborator or viewer returns `400 Bad Request`. Automatically cleared when demoting to collaborator or viewer. |

**Visibility of `is_moderator` in board responses (since 1.1; self-row exception since 1.2):** the `is_moderator` field is included in the `members` array of `GET /api/v1/boards/{id}/full/` for `admin` and `site_admin` requesters, on every row. A lower-role requester (`member`, `collaborator`, `viewer`) receives the field only on the row belonging to themselves — so a member promoted to moderator can see their own entitlement — and every other row omits it. This endpoint's own response always carries the field, since it requires board admin. The `member.added` / `member.updated` WebSocket broadcast and the [change feed](events.md) apply the identical self-row rule per recipient (#1191): the subscriber's/reader's own row always carries the field, every other non-admin-visible row omits it.

**`is_site_admin` on member rows (since 1.2):** each row in the `members` array of `GET /api/v1/boards/{id}/full/`, this endpoint's response, and the `member.added` / `member.updated` WebSocket broadcast and [change feed](events.md) carries a boolean `is_site_admin` — the member's instance-level site-admin flag, the same flag this endpoint and `DELETE` below check. Use it, not `role`, to decide whether a row can be edited: `role: "site_admin"` means the member has `can_access_all_content`, which is a separate flag. The field is present only for `admin` and `site_admin` requesters, subscribers and readers, and there is no self-row exception (read your own flag from `/api/v1/auth/me/`). It is never added to the nested `user` object.

### `DELETE /api/v1/boards/{id}/members/{user_id}/`
Remove a member. Requires board admin. Cannot remove a site admin.

---

## Board invites

*(New in 1.2)* A board admin can email a **single-use invite** to someone who may not have an account yet. The invite token (`vbnb_` prefix) travels only in the email and is never returned by the API; only its first 8 characters (`prefix`) are shown. The address it was sent to is not stored. Invites grant `member`, `collaborator` or `viewer` — never `admin`, and never the moderator flag. A board invite never adds anyone to the board's group.

### `GET /api/v1/boards/{id}/invite-links/`
List the board's invites, newest first, as a bare array (not paginated). Requires board admin (an admin of the board, the owner, an admin of the board's group, or a site admin with all-content access). Returns **every pending invite plus at most the 50 most recent past ones** (used, expired or revoked); older history is not returned. A caller with no access to the board gets `403`, a board that does not exist `404`, an unauthenticated request `401` — the same as the members endpoints.

| Field | Description |
|---|---|
| `id`, `prefix`, `name` | Identity. `name` is empty for emailed invites. |
| `role` | `member`, `collaborator` or `viewer`. |
| `delivery` | `email` for emailed invites (`link` is reserved for shareable links, not yet available). |
| `created_at`, `created_by_username` | When and by whom it was sent. `created_by_username` is `null` when the sender's account was deleted. |
| `expires_at`, `is_expired`, `single_use`, `used_at` | Lifetime. |
| `status` | `pending`, `used`, `expired` or `revoked` (precedence revoked > used > expired). A pending invite whose sender's account was deleted, or who is no longer an admin of the board, is reported as `revoked` — the join endpoints refuse it the same way — although nobody revoked it explicitly, and it stops counting toward the 50-pending cap. This is **not written** to the invite: if the sender regains board admin, the invite reads as `pending` and can be redeemed again (until it expires). To make it permanent, revoke it with `DELETE` below, which accepts it because it was never actually revoked. |
| `can_register` | Advisory: whether a new person could create an account from this invite under the site's **current** registration mode — computed when you read it, so it changes if the mode or the sender's site-admin status changes. Always `false` when `status` is not `pending`. |

**Example response**

```json
[
  {
    "id": 42,
    "prefix": "vbnb_3f9",
    "name": "",
    "role": "collaborator",
    "delivery": "email",
    "created_at": "2026-10-06T14:02:11.512Z",
    "created_by_username": "alice",
    "expires_at": "2026-10-13T14:02:11.498Z",
    "is_expired": false,
    "single_use": true,
    "used_at": null,
    "status": "pending",
    "can_register": true
  },
  {
    "id": 37,
    "prefix": "vbnb_c07",
    "name": "",
    "role": "viewer",
    "delivery": "email",
    "created_at": "2026-10-02T09:15:40.003Z",
    "created_by_username": null,
    "expires_at": "2026-11-01T09:15:39.990Z",
    "is_expired": false,
    "single_use": true,
    "used_at": null,
    "status": "revoked",
    "can_register": false
  }
]
```

The second invite was sent by an account that has since been deleted, so it lists as `revoked` even though `DELETE` was never called.

### `POST /api/v1/boards/{id}/invite-links/send/`
Email one invite. Requires board admin. Same contract as the [group send endpoint](groups.md): the response is identical whether the address belongs to a member, another user, or nobody, and the email is always sent.

**Request** `{ "email": "sam@example.com", "role": "collaborator", "expiry_days": 30 }`

| Field | Required | Description |
|---|---|---|
| `email` | ✓ | One address. Whitespace, display names and lists are refused. |
| `role` | | `member` (default), `collaborator` or `viewer`. `admin` is refused with `400`. |
| `expiry_days` | | `1`, `7` (default) or `30`. Any other value is refused with `400`. |

**Responses**

| Status | Body | When |
|---|---|---|
| `202 Accepted` | `{"detail": "Invite sent", "sent_to": "...", "delivery": "console"?}` | Sent. `delivery: "console"` only in development, when mail is printed to the server console. |
| `400 Bad Request` | field errors, or `{"code": "invite_email_cap_reached", "detail": "..."}` | Invalid input, or the board already has 50 pending emailed invites (invites from a deleted sender or one who is no longer a board admin do not count). |
| `403 Forbidden` | `{"code": "invite_email_disabled", ...}` or `{"detail": "..."}` | Email invites are switched off (`INVITE_EMAIL_ENABLED=false`, or a demo instance), or the caller is not a board admin. |
| `429 Too Many Requests` | `Retry-After` header | A send budget is spent: per sender (`invite_email_user`, 10/hour), per board (`invite_email_board`, 30/day, shared by every admin of the board) and instance-wide (`invite_email_global`, 200/day, shared with group invites). Refused requests spend no budget. |
| `502 Bad Gateway` | `{"code": "<smtp code>", "detail": "..."}` | The mail server refused the message. The invite is revoked automatically and the budget refunded, so you can retry once mail works. |

### `DELETE /api/v1/boards/{id}/invite-links/{link_id}/`
Revoke a pending invite. Requires board admin; any board admin may revoke any admin's invite. Returns `204`. A used invite cannot be revoked (`400`); an unknown or already-revoked invite is `404`.

Sending and revoking publish `invite_link.created` / `invite_link.revoked` on the board's [WebSocket channel](websockets.md#invite-events-since-12) with just `{ "id": <int> }`.

### `GET /api/v1/boards/join/{token}/`
Public preview of an invite — no authentication. Returns `{ "board_id", "board_name", "role", "can_register" }`.

The **board name is disclosed to anyone holding the token**. That is deliberate and matches the group join preview (#801): the token is a 160-bit capability, so whoever holds it may see what it grants before signing in. `can_register` is the same advisory bit as on the list.

| Status | Body | When |
|---|---|---|
| `404 Not Found` | `{"detail": "Not found."}` | No such token. |
| `410 Gone` | `{"code": "used" \| "expired" \| "revoked", "detail": "..."}` | A known invite that can no longer be used. `revoked` also covers an invite whose sender has since been deactivated or is no longer an admin of the board. A used invite still answers `200` to someone who already has access to the board. |
| `429 Too Many Requests` | `{"detail": "Request was throttled. ..."}`, `Retry-After` header | The per-IP `join_group` budget (10/hour) is spent — shared with the group join endpoints and with `POST` below. |

### `POST /api/v1/boards/join/{token}/`
Redeem an invite as the signed-in user. Returns `{ "board_id", "board_name", "role", "created" }` — `201` when a membership was created, `200` otherwise. Same `404` / `410` / `429` responses as the preview, plus:

| Status | When |
|---|---|
| `401 Unauthorized` | No credentials. |
| `403 Forbidden` | The account must change its password or username first (`must_change_password` / `must_change_username`), or a personal access token lacks the `write` scope. |

What redeeming does depends on the access you already have, because an explicit board membership **replaces** any role you inherit from the board's group rather than adding to it:

- **No access** → you become a board member with the invite's role (`created: true`).
- **Only a group-inherited role ranked below the invite's** (for example a group viewer redeeming a member invite) → an explicit membership with the invite's role is created (`created: true`).
- **An equal or higher inherited role, an explicit board membership of any role, board ownership or all-content access** → nothing changes (`created: false`). A group admin who redeems a viewer invite is **not** downgraded to viewer.

A redeemed single-use invite is consumed either way. Redeeming it again as the person who already has access returns `200` with nothing changed (`created` reports whether this invite created your membership — `true` after signing up from it); anyone else gets `410 {"code": "used"}`. When a membership is created, the board's `member.added` event carries an extra `invite: { "id", "created_by_id" }` key.

Both join endpoints share the per-IP `join_group` throttle (10/hour) with the [group join endpoints](groups.md) — board and group join attempts from one address draw from one budget.

Signing up with a board invite on an invite-only site is covered in [Authentication](authentication.md#invite-only-mode).

---

## Board sharing

### `POST /api/v1/boards/{id}/share/`
Generate (or regenerate) a public share token for the board. Requires board admin.

If a token already exists, calling this endpoint immediately invalidates the previous one and returns a new UUID. Any existing share links stop working as soon as the new token is issued.

**Permissions:** board `admin` or `site_admin` only.

**Request (optional)**
```json
{
  "expires_in_days": 7
}
```

`expires_in_days` is optional. Allowed values: `7`, `30`, `90`, or `null` (the default — never expires). Any other integer returns `400 Bad Request`. New in 1.1 (#804).

**Response**
```json
{
  "share_token": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "share_url": "https://your-instance.example.com/api/share/3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "share_token_expires_at": "2026-04-28T17:30:00+00:00"
}
```

`share_token_expires_at` is `null` when no TTL was requested.

**Errors:** `403 Forbidden` if the caller is not a board admin. `400 Bad Request` if `expires_in_days` is not one of the allowed values.

### `DELETE /api/v1/boards/{id}/share/`
Revoke the public share token for the board. Requires board admin. All existing share links immediately return `404 Not Found` after revocation. Both the token and any TTL are cleared.

**Permissions:** board `admin` or `site_admin` only.

**Response**
```json
{
  "share_token": null,
  "share_url": null,
  "share_token_expires_at": null
}
```

**Errors:** `403 Forbidden` if the caller is not a board admin.

---

## Columns

Column objects include a `uid` field — a stable 16-character hex identifier that does not change when the column is renamed or reordered. The `uid` is read-only; any `uid` value sent in a request body is ignored.

### `GET /api/v1/boards/{id}/columns/`
List all columns on the board in position order. Available to all board members.

### `GET /api/v1/boards/{id}/columns/{col_id}/`
Get a single column. Available to all board members.

### `POST /api/v1/boards/{id}/columns/`
Create a column. Requires board admin.

**Request** `{ "name": "Review", "color": "#8B5CF6", "wip_limit": 3, "weight_limit": null, "allow_card_creation": false, "is_done": false }`

Column objects returned by all endpoints include the following fields:

| Field | Type | Description |
|---|---|---|
| `id`, `uid` | integer, string | Database ID and stable 16-char hex UID (read-only) |
| `name` | string | Column name |
| `position` | integer | Display order (0-based); update via `reorder/` only — a `PATCH`/`PUT` that changes `position` returns `400 Bad Request` (since 1.2, #1275). Echoing the current value back is accepted. |
| `color` | string | Hex color code |
| `wip_limit` | integer / null | Maximum number of cards; `null` means unlimited (binding on every API card write path except board import; see note) |
| `weight_limit` | integer / null | Maximum total card weight; `null` means unlimited (binding on every API card write path except board import; see note) |
| `allow_card_creation` | boolean | When `false`, new cards cannot be created directly in this column |
| `is_done` | boolean | When `true`, marks this column as a "done" stage used for cycle-time and throughput metrics. Default: `false`. |

> When `allow_card_creation` is `false`, posting a new card to that column returns `400 Bad Request` with `{"column": "Card creation is not allowed in this column."}`.
>
> WIP and weight limits are enforced when `enforce_wip_limits` or `enforce_weight_limits` is enabled on the board. A card move, create, or restore into an over-limit column (or a PATCH raising a card's `weight` past the weight limit) returns `409 Conflict` — see the move endpoint in the [Cards API](cards.md) for the full error schema and the `?force=true` admin override. When enforcement is disabled, limits are displayed but not enforced.
>
> Since 1.2 (#1428) limits are checked on every API card write path except board import (REST, MCP, and the Django admin), not just the move endpoint. Board import and the operator seed commands are exempt by design: import restores a board as exported, so an imported column can hold more than its limit — see [Field Enforcement](../architecture/field-enforcement.md).

### `PUT /api/v1/boards/{id}/columns/{col_id}/`
Update a column. Requires board admin.

**Writable fields:** `name`, `color`, `wip_limit` (integer or `null`), `weight_limit` (integer or `null`), `allow_card_creation` (boolean), `is_done` (boolean)

### `DELETE /api/v1/boards/{id}/columns/{col_id}/`
Delete a column. Requires board admin.

### `POST /api/v1/boards/{id}/columns/reorder/`
Reorder columns. Requires board admin.

**Request** `{ "order": [3, 1, 4, 2] }` — `order` must be **exactly** this board's
current column IDs: every column once, no duplicates, and no ID from another
board. A partial list, a duplicate ID, an ID belonging to a different board, or
(on a board that has columns) an empty list are all rejected with `400` and body
`{"order": ["..."]}` rather than partially applied. *(Since 1.2, #1302 — same
rule as checklist-item reorder, #1292.)*

---

## Swimlanes

Swimlane objects include a `uid` field — stable across renames, read-only.

**Role-gated fields:** `contact_email` and `notes` are only included in responses for `admin` and `site_admin` role members. `member`, `collaborator`, and `viewer` roles receive swimlane objects without those fields. This applies to the swimlane list endpoint, `GET /api/v1/boards/{id}/full/`, and WebSocket broadcast events.

**`custom_field_values` visibility (since 1.2):** unlike `contact_email`/`notes`, visibility of a row's custom field values is gated **per definition**, not per role. Every board role receives `custom_field_values`, but each entry is present only if its [definition](#swimlane-custom-fields-since-12) has `is_admin_only: false` — the default is `true`. Board admins and site admins always see every value regardless of `is_admin_only`. A share-link visitor (`GET /api/share/{token}/`) never receives `custom_field_values` at all — see [Public share endpoint](#public-share-endpoint).

### `GET /api/v1/boards/{id}/swimlanes/`
List all swimlanes on the board in position order. Available to all board members. `admin` and `site_admin` roles see `contact_email` and `notes`; all other roles receive swimlane objects without those fields.

### `GET /api/v1/boards/{id}/swimlanes/{swimlane_id}/`
Get a single swimlane. Same role-gated field rules as the list endpoint.

### `POST /api/v1/boards/{id}/swimlanes/`
Create a swimlane. Requires board admin.

**Request** `{ "name": "Acme Corp", "contact_email": "", "color": "#3B82F6" }`

> Swimlane names are unique per board. Creating a swimlane with a name that already exists on the same board returns `400 Bad Request`.

Swimlane response objects include the following fields:

| Field | Type | Description |
|---|---|---|
| `id`, `uid` | integer, string | Database ID and stable 16-char hex UID (read-only) |
| `name` | string | Swimlane name |
| `position` | integer | Display order (0-based); update via `reorder/` only — a `PATCH`/`PUT` that changes `position` returns `400 Bad Request` (since 1.2, #1275). Echoing the current value back is accepted. |
| `color` | string | Hex color code |
| `is_collapsed` | boolean | Whether the swimlane row is collapsed in the board view |
| `created_at` | string | ISO 8601 timestamp of swimlane creation |
| `contact_email` | string | Admin-only — contact email for this swimlane (empty string if unset) |
| `notes` | string | Admin-only — internal notes (empty string if unset) |
| `custom_field_values` | array | Since 1.2. `[{ "field_definition": <id>, "value": "<string>" }, ...]` — one entry per [swimlane custom field](#swimlane-custom-fields-since-12) definition that has a value **and** is visible to the requesting role (see the `custom_field_values` visibility note above). Values are always strings; numbers as written, dates as `YYYY-MM-DD`, checkboxes as `"true"`/`"false"`. |

`contact_email` and `notes` are only returned to `admin` and `site_admin` role members (see role-gated fields note above).

### `PUT /api/v1/boards/{id}/swimlanes/{swimlane_id}/`
Update a swimlane. Requires board admin.

**Writable fields:** `name`, `color`, `is_collapsed`, `contact_email`, `notes`, `custom_field_values` (since 1.2)

> Swimlane names are unique per board. Renaming a swimlane to a name that already exists on the same board returns `400 Bad Request`.

`custom_field_values` writes are also accepted on `PATCH`. Send only the entries you want to change — a swimlane custom field not named in the list keeps its current value. Send `{"field_definition": <id>, "value": ""}` to clear (and delete) a value. At most one entry per `field_definition` per request; a `field_definition` id from another board is rejected with `400 Bad Request`. Since writes to this endpoint are already admin-only, an admin may write a value for an `is_admin_only` field — that is the expected case, not an escalation. There is no separate values endpoint; values are always written through this one.

!!! note
    The `PUT`/`PATCH` HTTP response always includes `contact_email`, `notes`, and every
    `custom_field_values` entry regardless of `is_admin_only` — the caller is the admin who
    just wrote it. The `swimlane.updated` WebSocket broadcast, however, is always built from
    the **public** swimlane shape, for every connected client — including the admin who made
    the change. `contact_email`, `notes`, and any `is_admin_only` value are absent from that
    frame for everyone; an admin sees the change on their next REST fetch, not in real time.
    See [WebSockets](websockets.md#swimlane-field-events-since-12) for the full contract.

### `DELETE /api/v1/boards/{id}/swimlanes/{swimlane_id}/`
Delete a swimlane. Requires board admin.

### `PATCH /api/v1/boards/{id}/swimlanes/{swimlane_id}/set-collapsed/`
Toggle the default collapsed state of a swimlane. Requires admin or site admin role — members, collaborators, and viewers are rejected.

This sets the board-wide default for all users — it is a board structure preference, not a per-user setting.

**Minimum role:** admin or site admin

**Request**
```json
{ "is_collapsed": true }
```

**Response** — updated swimlane object (same shape as `GET /api/v1/boards/{id}/swimlanes/{swimlane_id}/`)

**Errors**

| Status | Body | Condition |
|---|---|---|
| `400 Bad Request` | `{"is_collapsed": "This field must be a boolean."}` | `is_collapsed` was not a boolean |
| `403 Forbidden` | `{"detail": "..."}` | Caller is a member, collaborator, or viewer |

A `swimlane.updated` WebSocket event is broadcast to all connected board clients on success.

!!! note
    The deprecated snake_case alias `set_collapsed` (with underscore) is retained for 1.x backward compatibility and emits the same response but additionally includes the following response headers:

    - `Deprecation: true` — signals that this URL path is deprecated (RFC 8594).
    - `Link: <canonical-url>; rel="successor-version"` — points to the canonical kebab-case path (RFC 8288).

    Prefer the kebab-case form `set-collapsed`. The underscore alias will be removed in 2.0.

### `POST /api/v1/boards/{id}/swimlanes/reorder/`
Reorder swimlanes. Requires board admin.

**Request** `{ "order": [2, 1, 3] }` — `order` must be **exactly** this board's
current swimlane IDs: every swimlane once, no duplicates, and no ID from another
board. A partial list, a duplicate ID, an ID belonging to a different board, or
(on a board that has swimlanes) an empty list are all rejected with `400` and
body `{"order": ["..."]}` rather than partially applied. *(Since 1.2, #1302 —
same rule as checklist-item reorder, #1292.)*

---

## Labels

Label objects include a `uid` field — stable across renames, read-only.

### `GET /api/v1/boards/{id}/labels/`
List board labels. Available to all board members.

### `GET /api/v1/boards/{id}/labels/{label_id}/`
Get a single label. Available to all board members.

### `POST /api/v1/boards/{id}/labels/`
Create a label. Requires board admin.

**Request** `{ "name": "Bug", "color": "#EF4444" }`

### `PUT /api/v1/boards/{id}/labels/{label_id}/`
Update a label. Requires board admin.

**Writable fields:** `name`, `color`

### `DELETE /api/v1/boards/{id}/labels/{label_id}/`
Delete a label. Requires board admin.

---

## Custom fields (since 1.2)

Typed, per-board metadata fields that cards can carry — where a label is an untyped tag,
a custom field is a named key with a type. A board's definitions are also returned on
`GET /api/v1/boards/{id}/full/` as `custom_field_definitions`, so a client has the schema
on board load. Card **values** are read and written through the
[card endpoints](cards.md), not here.

Definition objects include a `uid` field — stable across renames, read-only.

**Limits:** at most **30** definitions per board, and at most **2** with
`show_on_card: true`.

| Field | Type | Read-only | Description |
|---|---|---|---|
| `id` | integer | yes | Database primary key |
| `uid` | string | yes | Stable 16-character hex UID |
| `name` | string | no | Field name; unique within the board |
| `field_type` | string | no\* | One of `"text"`, `"number"`, `"date"`, `"dropdown"`, `"checkbox"`, `"url"` (see [URL fields](#url-fields)), `"multi_select"` (see [Multi-select fields](#multi-select-fields)) |
| `choices` | string[] | no | Permitted values; required and non-empty (at most 100, unique) for `"dropdown"` and `"multi_select"`, rejected for every other type |
| `position` | integer | yes | Display order; set on create and changed only via `reorder/` |
| `show_on_card` | boolean | no | Pin the value to the card face. Max 2 per board |
| `is_required` | boolean | no | Declared but **not enforced** in this release |
| `help_text` | string | no | Hint shown next to the input |
| `number_prefix` | string | no | *Since 1.2.* Display-only text before a number value; `""` (default) for none. `"number"` fields only — see [Number formatting](#number-formatting) |
| `number_suffix` | string | no | *Since 1.2.* Display-only text after a number value; `""` (default) for none. `"number"` fields only |
| `number_decimals` | integer \| null | no | *Since 1.2.* Fixed decimal places (0–10) for display; `null` (default) shows the number as typed. `"number"` fields only |
| `choice_colors` | object | no | *Since 1.2.* Display-only `{choice: palette_key}` map; `{}` (default) for none. `"dropdown"` and `"multi_select"` fields only — see [Choice colors](#choice-colors) |
| `created_at` | string | yes | ISO 8601 creation timestamp |

\* `field_type` is writable only while the definition has zero values — see the `PATCH`
errors below.

#### URL fields

A `"url"` field stores a web address. It applies to card and swimlane custom fields alike,
and is text-backed like every other type — the value is the stored string, with no extra
columns or structure.

- **Validated on write**, through the same rule as a card's
  [external ref](cards.md#external-ref-since-12) URL: the value must be an absolute
  `http://` or `https://` URL with a host. Any other scheme (`javascript:`, `data:`,
  `ftp:`, `mailto:` — matched case-insensitively), a missing scheme (`example.com`),
  embedded whitespace or control characters, a backslash, a percent-encoded host,
  credentials (`user:pass@`), or an invalid port is rejected with `400 Bad Request`.
- **At most 500 characters**, the cap that applies to every custom field value. A longer
  URL is rejected, never truncated.
- **Stored as sent** (after trimming surrounding whitespace) — the scheme's case and the
  rest of the URL are not rewritten. The API does not add a missing `https://`; the web
  UI does that before it sends the value.
- `choices` is rejected for a `"url"` field, as for every type that cannot carry choices
  (anything but `"dropdown"` and `"multi_select"`).
- **Clients that do not recognize `"url"`** should fall back to rendering the value as
  plain text — the value is always a string. A client that renders it as a link must
  still check the scheme at render time and use `rel="noopener noreferrer"`.
- Enterprise `CUSTOM_FIELD_VALIDATORS` hooks receive `"url"` as the `field_type` and run
  after this validation.

#### Multi-select fields

*Since 1.2.* A `"multi_select"` field holds any number of the definition's `choices`. It
applies to card and swimlane custom fields alike, and is text-backed like every other type:
**the `value` on the wire is still a string** — a JSON array encoded as a string, never a
JSON array.

```json
{ "field_definition": 14, "value": "[\"web\",\"ios\"]" }
```

- **Canonical form.** The stored (and returned) string is compact JSON (`["web","ios"]`, no
  spaces, non-ASCII characters unescaped), **deduplicated**, with entries that are current
  choices **in `choices` order**, followed by any orphaned entries (see below). Resubmitting
  the same set in a different order is therefore not a change: the stored row is not
  rewritten and no `custom_field_value_changed` /
  `swimlane_custom_field_value_changed` signal fires.
- **Accepted on write** — any of: an array of strings (`"value": ["ios", "web"]`); the JSON
  array string a read returned (so echoing a payload back is a no-op); a plain string, read
  as a single entry (`"value": "web"`). `""`, `null` and `[]` (or an array of blank
  strings) clear the field. Surrounding whitespace on each entry is trimmed.
- **Every entry must be a current choice — or already stored on that card or swimlane.**
  Anything else is a `400`: `'<entry>' is not a choice for '<name>'.` A non-string entry
  (or a nested array) is a `400`: `Each value of '<name>' must be a string.` An object, a
  boolean, or an entry containing NUL (`\u0000`) is also a `400`.
- **At most 500 characters, measured on the canonical string.** Over the cap is a `400`,
  never a truncation: `'<name>' value is longer than 500 characters.` The same message is
  returned, without parsing, for an array of more than 500 entries or a JSON array string
  longer than 2,000 characters.
- **Permissions** are those of the owner's other writes: a card value needs board member
  or above and is subject to the same ownership gate as any card edit; a swimlane value
  can be written by board admins only.
- **Orphans are kept.** Renaming or removing a choice never rewrites stored values: an
  entry that is no longer a choice stays in the value, is returned as stored, and may be
  kept (or dropped) on later writes to that same card or swimlane. It cannot be added
  anywhere it is not already stored. Clients should render an orphaned entry like any
  other value.
- `field_type` follows the same freeze rule as every type — it cannot change once any value
  exists — so there is no conversion path to or from `"dropdown"`.
- **Clients that do not recognize `"multi_select"`** should render the value as plain text;
  it is always a string.
- **Export.** The JSON export carries the stored string unchanged. The CSV export writes the
  entries joined with `"; "` (`web; ios`), each entry formula-sanitized like every other CSV
  cell.
- **Extension points.** Enterprise `CUSTOM_FIELD_VALIDATORS` /
  `SWIMLANE_CUSTOM_FIELD_VALIDATORS` hooks receive `field_type == "multi_select"` and the
  canonical string (for example `'["web","ios"]'`), never a list; a hook that rewrites the
  value must return a string of the same shape. A rewritten value is re-canonicalized and
  re-checked against the 500-character cap; one that is not a JSON array of strings is
  refused with a `400`. The `custom_field_value_changed` and
  `swimlane_custom_field_value_changed` signals send `old_value`/`new_value` as the
  canonical strings — the whole set, not a per-entry diff.

#### Number formatting

*Since 1.2.* Three optional, **display-only** settings on a `"number"` definition, on card
and swimlane custom fields alike. They change how a client renders a value, never the
value: the `value` on the wire, in exports, and in filters stays the plain number string
the user entered.

```json
{ "name": "Budget", "field_type": "number", "number_prefix": "$", "number_suffix": " USD", "number_decimals": 2 }
```

| Field | Type | Default | Rule |
|---|---|---|---|
| `number_prefix` | string | `""` | At most 10 characters. Stored exactly as sent — leading and trailing spaces are **not** trimmed (`"$ "` is a valid prefix). |
| `number_suffix` | string | `""` | At most 10 characters, stored exactly as sent (`" h"`). |
| `number_decimals` | integer or `null` | `null` | `0`–`10` inclusive. `null` means "render the number as typed". |

- **All three are optional** on create and `PATCH`; omitted, they keep their defaults (or
  current values), which reproduce the pre-1.2 rendering exactly. Existing clients that
  ignore them are unaffected.
- **Only on a number field.** On any other `field_type`, a non-default value is a
  `400 Bad Request` keyed by the offending field:
  `{"number_prefix": ["Number format options can only be set on a number field."]}`.
  Sending the defaults (`""`, `""`, `null`) is always accepted, so a client may send all
  three keys for every type. A `PATCH` is checked against the definition's stored type
  when `field_type` is not in the body.
- **Changing the type clears them.** When a definition with no values is retyped away from
  `"number"`, all three are reset to their defaults in the same write. Sending a
  non-default format in the same request as the retype is a `400`.
- **Other `400`s:** `number_decimals` below 0 (`Ensure this value is greater than or equal
  to 0.`), above 10 (`Ensure this value is less than or equal to 10.`), or not an integer
  (`A valid integer is required.`); a prefix or suffix over 10 characters (`Ensure this
  field has no more than 10 characters.`), containing NUL (`Null characters are not
  allowed.`), or `null` (`This field may not be null.`).
- **Rendering (the web UI's rule, recommended for other clients):** a value that does not
  parse as a finite number is shown raw. With `number_decimals` `null`, the number is
  shown **as typed** (`"+5"` → `$+5`, `"1e3"` → `$1e3`, no grouping). With it set, round
  to that many places with thousands grouping (`1e3` → `1,000`); values beyond 2^53 lose
  precision in the **display only** — the stored value is untouched. Then add the prefix
  and suffix verbatim, with a minus sign **before** the prefix (`-$5.00`).
- **Export.** The JSON export's `custom_fields` and `swimlane_custom_fields` entries carry
  the three keys (additive — `schema_version` is unchanged); card and swimlane values stay
  the raw number string in both JSON and CSV.
- **Events.** `custom_field.created` / `custom_field.updated` and
  `swimlane_custom_field.created` / `swimlane_custom_field.updated` carry the full
  definition, so the three fields arrive with them.

#### Choice colors

*Since 1.2.* An optional, **display-only** color per choice on a `"dropdown"` or
`"multi_select"` definition, on card and swimlane custom fields alike. `choices` is
unchanged — still a plain list of strings — and the colors live beside it in a separate
map keyed by the choice text. Values are never touched.

```json
{ "name": "Severity", "field_type": "dropdown", "choices": ["Low", "High"], "choice_colors": { "High": "red" } }
```

- **Shape.** An object mapping a choice (its text, exactly as in `choices`) to a palette
  key. Default `{}`. A choice with no entry has no explicit color; the web UI renders it
  with its automatic dot, the same as before 1.2.
- **Palette keys only, never hex:** `slate`, `blue`, `green`, `amber`, `red`, `violet`,
  `pink`, `teal`. The client owns how each key looks in light and dark themes and
  guarantees its contrast; a hex or CSS color is refused.
- **Optional** on create and `PATCH`; omitted, the map keeps its default (or current
  value). Sending `{}` is always accepted, for every `field_type`.
- **Stale keys are pruned, not refused.** On every write, entries whose key is not one of
  the definition's current `choices` (after the choices in the same request are applied,
  or the stored ones when `choices` is not sent) are dropped silently. Keys are matched
  after trimming surrounding whitespace, like `choices`. So **renaming or removing a
  choice drops its color** — the choice text is the key, and a color is not carried over
  to a renamed choice. A `PATCH` that only changes `choices` prunes the stored map the
  same way.
- **Changing the type clears it.** When a definition is retyped away from `"dropdown"` /
  `"multi_select"`, the map is reset to `{}` in the same write. Retyping between
  `"dropdown"` and `"multi_select"` keeps it.
- **Errors** — all `400 Bad Request`, keyed by `choice_colors`:

    | Cause | Message |
    |---|---|
    | A non-empty map on any other `field_type` (judged against the stored type when the body does not change it) | `Choice colors can only be set on a dropdown or multi-select field.` |
    | Not an object (a list, string, number, boolean) | `Choice colors must be an object mapping a choice to a color.` |
    | `null` | `This field may not be null.` |
    | More than 100 entries (the per-field choice cap) | `At most 100 choice colors are allowed.` |
    | A key containing NUL (`\u0000`) | `Choice color keys must be choice names without NUL (0x00) characters.` |
    | A value that is not one of the palette keys (including hex, other case, or a non-string) | `Choice colors must be one of: slate, blue, green, amber, red, violet, pink, teal.` |

- **Rendering (the web UI's rule, recommended for other clients):** a value whose choice
  has a known color key renders as a tinted badge **with its text label** — color never
  carries meaning alone. A value that is no longer a choice (an orphan), or a key the
  client does not recognize (one added by a newer server), renders neutral, label shown.
- **Export.** The JSON export's `custom_fields` and `swimlane_custom_fields` entries carry
  `choice_colors` (additive — `schema_version` is unchanged; `choices` is unchanged). Card
  and swimlane values are unchanged in JSON and CSV. A non-admin exporter does not receive
  an `is_admin_only` swimlane definition at all, colors included.
- **Events.** `custom_field.created` / `custom_field.updated` and
  `swimlane_custom_field.created` / `swimlane_custom_field.updated` carry the full
  definition, so `choice_colors` arrives with them (an additive field).

### `GET /api/v1/boards/{id}/custom-fields/`
List the board's custom field definitions, in `position` order. Available to **all board
members, including viewers** — a reader needs the schema to make sense of the values they
can already see. Paginated with the project-wide offset pagination.

### `GET /api/v1/boards/{id}/custom-fields/{field_id}/`
Get a single definition. Available to all board members.

### `POST /api/v1/boards/{id}/custom-fields/`
Create a definition. Requires board admin.

**Request** `{ "name": "Array Type", "field_type": "dropdown", "choices": ["raid6", "raid10"], "show_on_card": true }`

A number field may also carry display-only formatting — see [Number formatting](#number-formatting):
`{ "name": "Budget", "field_type": "number", "number_prefix": "$", "number_suffix": " USD", "number_decimals": 2 }`

A dropdown or multi-select field may also color its choices — see [Choice colors](#choice-colors):
`{ "name": "Severity", "field_type": "dropdown", "choices": ["Low", "High"], "choice_colors": { "High": "red" } }`

`position` is server-assigned (appended to the end) and ignored if supplied.

**Errors:**
- `400 Bad Request` if the name is blank or already used on this board, a dropdown or
  multi-select has no choices, a type that cannot carry choices supplies them, a
  non-number type supplies a [number format](#number-formatting) option, a number format
  option is out of range, `choice_colors` is malformed or set on a type without choices
  (see [Choice colors](#choice-colors)), the board already has 30 definitions, or a
  third field is pinned with `show_on_card`.

### `PATCH /api/v1/boards/{id}/custom-fields/{field_id}/`
Update a definition. Requires board admin.

**Writable fields:** `name`, `field_type`, `choices`, `show_on_card`, `is_required`, `help_text`, `number_prefix`, `number_suffix`, `number_decimals`, `choice_colors`

> Removing (or renaming) a choice on a dropdown or multi-select does **not** rewrite cards
> that already hold it: the stored value keeps reading back. A dropdown value that is no
> longer a choice can no longer be written again; a multi-select entry that is no longer a
> choice may be re-written on the same card (kept alongside other edits) but not added
> anywhere else — see [Multi-select fields](#multi-select-fields).

> **Since 1.2:** `field_type` is frozen once any card holds a value for this field — a
> stale `CustomFieldValue` is never revalidated or migrated against a new type, so changing
> it out from under existing data would corrupt it silently. Delete and recreate the field
> to change its type once it has values. A field with zero values may still have its type
> changed freely. There is no `text` → `dropdown` (or any other) conversion path in this
> release.

**Errors:**
- `400 Bad Request` if `field_type` is changed on a definition that already has at least
  one `CustomFieldValue`.
- `400 Bad Request` for a [number format](#number-formatting) option on a non-number field
  (judged against the stored `field_type` when the body does not change it), or out of
  range.
- `400 Bad Request` with a `choice_colors` key for a malformed map, an unknown palette key,
  or a non-empty map on a type without choices — see [Choice colors](#choice-colors).
  Renaming or removing a choice prunes its color; retyping away from a choice type clears
  the map.

### `DELETE /api/v1/boards/{id}/custom-fields/{field_id}/`
Delete a definition. Requires board admin. **Every card's value for that field is deleted
with it.**

### `PUT /api/v1/boards/{id}/custom-fields/reorder/`
Reorder definitions. Requires board admin. `POST` is accepted as well, matching the column
and swimlane reorder actions.

**Request** `{ "order": [3, 1, 2] }` — custom field IDs in the new order. IDs belonging to
another board are ignored.

**Response** the full list in the new order.

---

## Swimlane custom fields (since 1.2)

Typed, per-board metadata fields that **swimlane rows** can carry — the row-level
counterpart to [Custom fields](#custom-fields-since-12) above. A swimlane represents an
entity (an account, a customer, a project), and this is the typed alternative to stuffing
everything into `notes` as unstructured prose. A board's definitions are also returned on
`GET /api/v1/boards/{id}/full/` as `swimlane_custom_field_definitions`, so a client has the
schema on board load. Row **values** are read and written through the
[swimlane endpoints](#swimlanes) as `custom_field_values`, not here — this section covers
the schema only.

Card custom fields and swimlane custom fields are independent per-board sets with
independent name uniqueness: a card field and a row field may share the same `name` on the
same board.

Definition objects include a `uid` field — stable across renames, read-only.

**Limits:** at most **15** definitions per board, and at most **3** with `show_on_row:
true`. These caps are deliberately different from the card-level field's 30/2 — see the
model docstring for the reasoning; do not assume they track each other.

| Field | Type | Read-only | Description |
|---|---|---|---|
| `id` | integer | yes | Database primary key |
| `uid` | string | yes | Stable 16-character hex UID |
| `name` | string | no | Field name; unique within the board's swimlane fields (a card field may reuse the same name) |
| `field_type` | string | no | One of `"text"`, `"number"`, `"date"`, `"dropdown"`, `"checkbox"`, `"url"` (see [URL fields](#url-fields)), `"multi_select"` (see [Multi-select fields](#multi-select-fields)). Immutable once any swimlane holds a value for this definition — see **Errors** below. |
| `choices` | string[] | no | Permitted values; required, non-empty (at most 100, unique) for `"dropdown"` and `"multi_select"`, rejected for every other type |
| `position` | integer | yes | Display order; set on create and changed only via `reorder/` |
| `show_on_row` | boolean | no | Pin the value to the swimlane row header. Max 3 per board |
| `is_admin_only` | boolean | no | When `true` (the default), this field's **values** are served only to `admin` and `site_admin` role members and are omitted entirely from share-link payloads. Does not affect who can read the *definition* — see [Swimlanes](#swimlanes) for the values visibility rule. |
| `is_required` | boolean | no | Declared but **not enforced** in this release |
| `help_text` | string | no | Hint shown next to the input |
| `number_prefix` | string | no | *Since 1.2.* Display-only text before a number value; `""` (default) for none. `"number"` fields only — see [Number formatting](#number-formatting) |
| `number_suffix` | string | no | *Since 1.2.* Display-only text after a number value; `""` (default) for none. `"number"` fields only |
| `number_decimals` | integer \| null | no | *Since 1.2.* Fixed decimal places (0–10) for display; `null` (default) shows the number as typed. `"number"` fields only |
| `choice_colors` | object | no | *Since 1.2.* Display-only `{choice: palette_key}` map; `{}` (default) for none. `"dropdown"` and `"multi_select"` fields only — see [Choice colors](#choice-colors) |
| `created_at` | string | yes | ISO 8601 creation timestamp |

### `GET /api/v1/boards/{id}/swimlane-custom-fields/`
List the board's swimlane custom field definitions, in `position` order. Available to **all
board members, including viewers** — a reader needs the schema to make sense of the values
they can already see. This lists the schema regardless of `is_admin_only`; it is the
*values* that are withheld from non-admins, not the field's existence. Paginated with the
project-wide offset pagination.

### `GET /api/v1/boards/{id}/swimlane-custom-fields/{field_id}/`
Get a single definition. Available to all board members. A definition `id` belonging to
another board returns `404 Not Found`.

### `POST /api/v1/boards/{id}/swimlane-custom-fields/`
Create a definition. Requires board admin.

**Request** `{ "name": "Account Tier", "field_type": "dropdown", "choices": ["Startup", "Growth", "Enterprise"], "show_on_row": true, "is_admin_only": true }`

A number field may also carry display-only formatting — see [Number formatting](#number-formatting):
`{ "name": "ARR", "field_type": "number", "number_prefix": "$", "number_suffix": "", "number_decimals": 0 }`

A dropdown or multi-select field may also color its choices — see [Choice colors](#choice-colors):
`{ "name": "Account Tier", "field_type": "dropdown", "choices": ["Startup", "Enterprise"], "choice_colors": { "Enterprise": "violet" } }`

`position` is server-assigned (appended to the end) and ignored if supplied.

**Errors:**
- `400 Bad Request` if the name is blank or already used on this board's swimlane fields, a
  dropdown or multi-select has no choices, a type that cannot carry choices supplies them,
  a non-number type supplies a [number format](#number-formatting) option, a number format
  option is out of range, `choice_colors` is malformed or set on a type without choices
  (see [Choice colors](#choice-colors)), the board already has 15
  swimlane field definitions, or a ninth field is pinned with `show_on_row`.

### `PATCH /api/v1/boards/{id}/swimlane-custom-fields/{field_id}/`
Update a definition. Requires board admin.

**Writable fields:** `name`, `field_type`, `choices`, `show_on_row`, `is_admin_only`, `is_required`, `help_text`, `number_prefix`, `number_suffix`, `number_decimals`, `choice_colors`

**Errors:**
- `400 Bad Request` with a `field_type` key if the request changes `field_type` and at
  least one swimlane already holds a value for this definition. A definition with zero
  values stays freely editable. There is no `text` → `dropdown` (or other) conversion path —
  clear the field's values first, or create a new definition.
- `400 Bad Request` with a `name` key if the new name collides with another swimlane field
  on this board.
- `400 Bad Request` keyed by the offending field for a [number format](#number-formatting)
  option on a non-number field, or out of range. Retyping a definition away from
  `"number"` clears its format options.
- `400 Bad Request` with a `choice_colors` key for a malformed map, an unknown palette key,
  or a non-empty map on a type without choices — see [Choice colors](#choice-colors).
  Renaming or removing a choice prunes its color; retyping away from a choice type clears
  the map.

> Removing (or renaming) a choice on a dropdown or multi-select does **not** rewrite rows
> that already hold it: the stored value keeps reading back. A dropdown value that is no
> longer a choice can no longer be written again; a multi-select entry that is no longer a
> choice may be re-written on the same swimlane but not added anywhere else — see
> [Multi-select fields](#multi-select-fields).

### `DELETE /api/v1/boards/{id}/swimlane-custom-fields/{field_id}/`
Delete a definition. Requires board admin. **Every swimlane's value for that field is
deleted with it.**

### `PUT /api/v1/boards/{id}/swimlane-custom-fields/reorder/`
Reorder definitions. Requires board admin. `POST` is accepted as well, matching the column,
swimlane, and card-custom-field reorder actions.

**Request** `{ "order": [5, 3, 4] }` — swimlane custom field IDs in the new order. IDs
belonging to another board are silently ignored rather than reordered or exposed.

**Response** the full list in the new order.

---

## Public share endpoint

### `GET /api/share/{token}/`
Returns a read-only board payload identified by its UUID share token. No authentication is required.

**Authentication:** none required (public endpoint).

**Rate limiting:** 120 requests/hour per IP, plus a 240 requests/hour per-token limit as defense in depth against CGNAT/proxy-pool abuse of a single link. Exceeding either returns `429 Too Many Requests`.

**Errors:**
- `404 Not Found` if the token is invalid, has been revoked, or does not exist.
- `410 Gone` if the token's TTL has elapsed (admin set an expiry at enable time and that timestamp has passed). The token is *not* auto-rotated — an admin must disable and re-enable sharing to get a fresh link. Body: `{"detail": "This share link has expired."}`. Added in 1.1 (#804).

**Response**
```json
{
  "uid": "a1b2c3d4e5f60001",
  "name": "Sales Pipeline",
  "columns": [
    {
      "id": 1,
      "uid": "c0l0abc123456701",
      "name": "Backlog",
      "position": 0,
      "color": "#64748B",
      "wip_limit": null,
      "weight_limit": null,
      "allow_card_creation": true,
      "is_done": false
    }
  ],
  "swimlanes": [
    { "id": 1, "uid": "sw1mabcdef123401", "name": "Acme Corp", "position": 0, "color": "#3B82F6", "is_collapsed": false, "created_at": "2026-03-01T10:00:00Z" }
  ],
  "cards": [
    {
      "uid": "crd0abc123456701",
      "column": 1,
      "swimlane": 1,
      "title": "Fix login bug",
      "priority": "high",
      "assignee": { "display_name": "Alice" },
      "labels": [{ "id": 3, "name": "Bug", "color": "#EF4444" }],
      "due_date": "2026-04-01",
      "weight": 2,
      "position": 0,
      "last_moved_at": "2026-03-25T14:30:00Z",
      "checklist_total": 3,
      "checklist_done": 1,
      "is_stale": false,
      "blocker_count": 1
    }
  ],
  "labels": [
    { "id": 3, "name": "Bug", "color": "#EF4444" }
  ]
}
```

Response fields:

| Field | Type | Description |
|---|---|---|
| `uid` | string | Board stable 16-char hex UID |
| `name` | string | Board name |
| `columns` | array | Column objects; includes `is_done` flag (see Columns section) |
| `swimlanes` | array | Swimlane objects; `contact_email`, `notes`, and `custom_field_values` (since 1.2) are never included — a structural omission, not an `is_admin_only` filter, since the visitor is unauthenticated |
| `cards` | array | Active (non-archived) card objects |
| `labels` | array | Label objects |

Card objects in the public payload use `uid` as the identifier (not `id`) and do not include a database `id`. The `assignee` field contains `display_name` only (email, username, and avatar are omitted), or `null` for an unassigned card. Comments and checklist item text are not included; only `checklist_total` and `checklist_done` counts are present. The `is_stale` field is `true` when the card has not moved within the board's `staleness_threshold_days` window.

`blocker_count` (since 1.2) is the number of active cards blocking this one — see [Card relations](cards.md#relations-since-12). The count is included, but the relation list is not: relations are same-board only, so every blocker is a card this payload already carries, whereas the relation rows themselves carry the creating user and a timestamp that this payload deliberately excludes.
