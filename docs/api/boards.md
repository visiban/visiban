# Boards API

## Boards

### `GET /api/v1/boards/`
List all boards accessible to the current user.

### `POST /api/v1/boards/`
Create a board.

**Request**

| Field | Required | Description |
|---|---|---|
| `name` | ✓ | Board name |
| `description` | | Board description (default: `""`) |
| `template` | | Template slug to use for column layout (default: `"simple_kanban"`). See `GET /api/v1/boards/templates/` for available slugs. |
| `swimlane_name` | | Name for the first swimlane (default: `"General"`) |

### `GET /api/v1/boards/{id}/`
Get board summary. Response includes:

| Field | Type | Description |
|---|---|---|
| `id`, `uid` | integer, string | Database ID and stable 16-char hex UID |
| `name`, `description` | string | Board name and description |
| `owner` | object | Owner user object |
| `group`, `group_name` | integer / null, string / null | Group ID and name (null for personal boards) |
| `member_count` | integer | Number of direct board members |
| `card_count` | integer | Number of active (non-archived) cards |
| `staleness_threshold_days` | integer | Days without movement before a card is considered stale (default: 7) |
| `allowed_priorities` | array / null | Permitted priority values for cards on this board (e.g. `["low", "medium", "high"]`); `null` means all priorities are allowed |
| `enforce_wip_limits` | boolean | When `true`, card moves that would exceed a column's WIP limit return `409 Conflict` (default: `true` for new boards) |
| `enforce_wip_hard` | boolean | When `true`, WIP limits cannot be overridden by any role — all users are blocked (default: `false`) |
| `enforce_weight_limits` | boolean | When `true`, card moves that would exceed a column's weight limit return `409 Conflict` (default: `true` for new boards) |
| `stale_warning_pct` | integer | Warning percentage (0--100) controlling the yellow/green boundary in the analytics heatmap |
| `is_starred` | boolean | Whether the requesting user has starred this board |
| `created_at`, `updated_at` | string | ISO 8601 timestamps |

### `PUT /api/v1/boards/{id}/` / `PATCH /api/v1/boards/{id}/`
Update board fields. Both `PUT` and `PATCH` are accepted — all fields are optional in either case. Requires board admin.

**Writable fields:** `name`, `description`, `staleness_threshold_days`, `stale_warning_pct`, `allowed_priorities`. Board admins may also set `enforce_wip_limits`, `enforce_weight_limits`, and `enforce_wip_hard`; non-admins sending these fields receive `403 Forbidden`.

### `DELETE /api/v1/boards/{id}/`
Delete board. Requires board owner or site admin.

### `GET /api/v1/boards/{id}/full/`
Full board state — columns, swimlanes, cards, labels, members, `current_user_role`, and `capabilities`. All objects include their `uid` field. Also includes `share_token` (the board's public share UUID, returned only to `admin` and `site_admin` role members — `null` is returned to lower roles when no share link exists) and `share_token_expires_at` (ISO-8601 timestamp of the share link's expiry, or `null` for no expiry; admin-only, mirrors `share_token` visibility — added in 1.1, #804). The `capabilities` object contains boolean feature flags for enterprise-registered extension points (all `false` in OSS).

### `POST /api/v1/boards/{id}/star/`
Star (favorite) a board. Returns `200 OK` with the updated board object (whether or not the board was already starred).

### `DELETE /api/v1/boards/{id}/star/`
Unstar a board.

### `GET /api/v1/boards/?starred=true`
List only boards the requesting user has starred.

### `POST /api/v1/boards/{id}/move-group/`
Move board to a different group (or `null` for personal).

**Request** `{ "group_id": 5 }` or `{ "group_id": null }`

---

## Templates

### `GET /api/v1/boards/templates/`
List all active board templates. Requires authentication. Used by the board creation modal to populate the template picker.

**Response**
```json
[
  {
    "id": 1,
    "name": "Sales Pipeline",
    "slug": "sales-pipeline",
    "description": "Track deals through your sales stages.",
    "icon": "💼",
    "lane_label": "Account",
    "lane_placeholder": "Acme Corp",
    "columns_json": "[\"Prospect\", \"Qualified\", \"Proposal\", \"Negotiation\", \"Closed Won\"]",
    "sort_order": 1
  },
  ...
]
```

| Field | Description |
|---|---|
| `slug` | Stable identifier (used by integrations) |
| `lane_label` | Label for the "first swimlane" step in board creation (e.g. "Account", "Project") |
| `lane_placeholder` | Placeholder text shown in the swimlane name input |
| `columns_json` | JSON array of column names that will be created |

Available templates: **Sales Pipeline**, **Customer Support**, **Customer Success**, **Simple Kanban**, **Product Roadmap**, **Project Delivery**, **Content Production**, **Hiring & Recruiting**, **Legal & Compliance**, **Infrastructure & DevOps**, **Blank Board**.

### `GET /api/v1/boards/{id}/summary/`
Board health summary — per-swimlane card counts, stage distribution, and velocity. Uses three aggregate queries regardless of board size.

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

CSV export (`Export CSV` button) is available to `member`, `admin`, and `site_admin` roles only.

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
Export the board as CSV. Returns a downloadable `text/csv` file. Requires `member` or `admin` role — viewers and collaborators receive `403 Forbidden`.

**CSV columns:** `Card ID`, `Title`, `Description`, `Column`, `Swimlane`, `Priority`, `Assignee`, `Labels`, `Due Date`, `Weight`, `Created At`, `Created By`, `Last Moved At`, `Movement Count`, `Movement History`

`Movement History` is a semicolon-separated list of pipe-delimited records: `<timestamp>|<from_column>|<to_column>|<moved_by>`.

### `GET /api/v1/boards/{id}/export/?format=json`
Export the board as JSON. Returns `application/json`. Requires `member` or `admin` role — viewers and collaborators receive `403 Forbidden`.

**Response shape:**

```json
{
  "name": "Sales Pipeline",
  "description": "",
  "columns": [{ "name": "Backlog", "position": 0, "color": "#64748B", "wip_limit": null, "weight_limit": null, "allow_card_creation": true }],
  "swimlanes": [{ "name": "Acme Corp", "position": 0, "color": "#3B82F6", "contact_email": "", "notes": "" }],
  "labels": [{ "name": "Bug", "color": "#EF4444" }],
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
      "comments": [{ "author": "bob", "body": "On it.", "created_at": "2026-03-02T09:00:00Z" }],
      "checklist": [{ "text": "Write tests", "is_checked": false }]
    }
  ]
}
```

### `POST /api/v1/boards/import/`
Import a board from a Visiban JSON or CSV export file. Accepts `multipart/form-data` with a `file` field, an optional `name` field to override the board name, and an optional `group_id` field to place the imported board into a group. Creates a new board atomically.

**Permission:** authenticated user. When `group_id` is set, the caller must be an admin of that group (direct or inherited); a non-admin receives `403 Forbidden`.

**Request** (`multipart/form-data`)

| Field | Required | Description |
|---|---|---|
| `file` | ✓ | The JSON or CSV export file. Format is detected from the file contents. |
| `name` | | Override the imported board name. |
| `group_id` | | Place the imported board into this group. Requires group admin (see Permission above). |

**Response** `201 Created`

Returns the newly created board object, using the same shape as `GET /api/v1/boards/{id}/`:

```json
{
  "id": 512,
  "uid": "bd_1a2b3c4d5e6f7890",
  "name": "Imported Board",
  "owner": { "id": 7, "username": "alice", "display_name": "Alice" },
  "group": null,
  "created_at": "2026-04-21T14:02:11Z",
  "updated_at": "2026-04-21T14:02:11Z"
}
```

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "..."}` | File is missing, empty, exceeds the upload size limit, is not valid JSON/CSV, or references columns/swimlanes that fail validation. |
| `401 Unauthorized` | `{"detail": "Authentication credentials were not provided."}` | Caller is not authenticated. |
| `403 Forbidden` | `{"detail": "..."}` | `group_id` was supplied but the caller is not an admin of that group. |

---

## Members

### `POST /api/v1/boards/{id}/members/`
Add or update a board member. Requires board admin.

**Request** `{ "user_id": 42, "role": "member", "is_moderator": true }`

| Field | Required | Description |
|---|---|---|
| `user_id` | ✓ | ID of the user to add or update |
| `role` | | Role to assign (default: `"member"`). Valid: `admin`, `member`, `collaborator`, `viewer` |
| `is_moderator` | | Boolean. Grants content-moderation rights (delete/archive others' content). Only valid for `member` and `admin` roles — setting `true` on a collaborator or viewer returns `400 Bad Request`. Automatically cleared when demoting to collaborator or viewer. |

### `DELETE /api/v1/boards/{id}/members/{user_id}/`
Remove a member. Requires board admin. Cannot remove a site admin.

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
| `position` | integer | Display order (0-based) |
| `color` | string | Hex color code |
| `wip_limit` | integer / null | Maximum number of cards; `null` means unlimited |
| `weight_limit` | integer / null | Maximum total card weight; `null` means unlimited |
| `allow_card_creation` | boolean | When `false`, new cards cannot be created directly in this column |
| `is_done` | boolean | When `true`, marks this column as a "done" stage used for cycle-time and throughput metrics. Default: `false`. |

> When `allow_card_creation` is `false`, posting a new card to that column returns `400 Bad Request` with `{"column": "Card creation is not allowed in this column."}`.
>
> WIP and weight limits are enforced when `enforce_wip_limits` or `enforce_weight_limits` is enabled on the board. A card move to an over-limit column returns `409 Conflict` — see the move endpoint in the [Cards API](cards.md) for the full error schema and the `?force=true` admin override. When enforcement is disabled, limits are displayed but not enforced.

### `PUT /api/v1/boards/{id}/columns/{col_id}/`
Update a column. Requires board admin.

**Writable fields:** `name`, `color`, `wip_limit` (integer or `null`), `weight_limit` (integer or `null`), `allow_card_creation` (boolean), `is_done` (boolean)

### `DELETE /api/v1/boards/{id}/columns/{col_id}/`
Delete a column. Requires board admin.

### `POST /api/v1/boards/{id}/columns/reorder/`
Reorder columns. Requires board admin.

**Request** `{ "order": [3, 1, 4, 2] }` — list of column IDs in new order.

---

## Swimlanes

Swimlane objects include a `uid` field — stable across renames, read-only.

**Role-gated fields:** `contact_email` and `notes` are only included in responses for `admin` and `site_admin` role members. `member`, `collaborator`, and `viewer` roles receive swimlane objects without those fields. This applies to the swimlane list endpoint, `GET /api/v1/boards/{id}/full/`, and WebSocket broadcast events.

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
| `position` | integer | Display order (0-based) |
| `color` | string | Hex color code |
| `is_collapsed` | boolean | Whether the swimlane row is collapsed in the board view |
| `created_at` | string | ISO 8601 timestamp of swimlane creation |
| `contact_email` | string | Admin-only — contact email for this swimlane (empty string if unset) |
| `notes` | string | Admin-only — internal notes (empty string if unset) |

`contact_email` and `notes` are only returned to `admin` and `site_admin` role members (see role-gated fields note above).

### `PUT /api/v1/boards/{id}/swimlanes/{swimlane_id}/`
Update a swimlane. Requires board admin.

**Writable fields:** `name`, `color`, `is_collapsed`, `contact_email`, `notes`

### `DELETE /api/v1/boards/{id}/swimlanes/{swimlane_id}/`
Delete a swimlane. Requires board admin.

### `POST /api/v1/boards/{id}/swimlanes/reorder/`
Reorder swimlanes. Requires board admin.

**Request** `{ "order": [2, 1, 3] }`

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

## Public share endpoint

### `GET /api/share/{token}/`
Returns a read-only board payload identified by its UUID share token. No authentication is required.

**Authentication:** none required (public endpoint).

**Rate limiting:** 120 requests/hour per IP. Exceeding the limit returns `429 Too Many Requests`.

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
    { "id": 1, "uid": "sw1mabcdef123401", "name": "Acme Corp", "position": 0, "color": "#3B82F6" }
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
      "is_stale": false
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
| `swimlanes` | array | Swimlane objects; `contact_email` and `notes` are never included |
| `cards` | array | Active (non-archived) card objects |
| `labels` | array | Label objects |

Card objects in the public payload use `uid` as the identifier (not `id`) and do not include a database `id`. The `assignee` field contains `display_name` only; email, username, and avatar are omitted. Comments and checklist item text are not included; only `checklist_total` and `checklist_done` counts are present. The `is_stale` field is `true` when the card has not moved within the board's `staleness_threshold_days` window.
