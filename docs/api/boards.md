# Boards API

## Boards

### `GET /api/boards/`
List all boards accessible to the current user.

### `POST /api/boards/`
Create a board.

**Request**

| Field | Required | Description |
|---|---|---|
| `name` | ✓ | Board name |
| `description` | | Board description (default: `""`) |
| `template` | | Template slug to use for column layout (default: `"simple_kanban"`). See `GET /api/boards/templates/` for available slugs. |
| `swimlane_name` | | Name for the first swimlane (default: `"General"`) |

### `GET /api/boards/{id}/`
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
| `enforce_weight_limits` | boolean | When `true`, card moves that would exceed a column's weight limit return `409 Conflict` (default: `true` for new boards) |
| `is_starred` | boolean | Whether the requesting user has starred this board |
| `share_token` | string / null | Public share token UUID, or `null` if sharing is disabled. Only returned for `admin` and `site_admin` roles; all other roles receive `null`. |
| `created_at`, `updated_at` | string | ISO 8601 timestamps |

### `PUT /api/boards/{id}/`
Update board fields. Requires board admin.

**Writable fields:** `name`, `description`, `staleness_threshold_days`, `allowed_priorities`. Board admins may also set `enforce_wip_limits` and `enforce_weight_limits`; non-admins sending these fields receive `403 Forbidden`.

### `DELETE /api/boards/{id}/`
Delete board. Requires board owner or site admin.

### `GET /api/boards/{id}/full/`
Full board state — columns, swimlanes, cards, labels, members, and `current_user_role`. All objects include their `uid` field. Also includes `share_token` (admin-only, see `GET /api/boards/{id}/` above).

### `POST /api/boards/{id}/star/`
Star (favorite) a board. Returns `201 Created` on first star, `200 OK` if already starred.

### `DELETE /api/boards/{id}/star/`
Unstar a board.

### `GET /api/boards/?starred=true`
List only boards the requesting user has starred.

### `POST /api/boards/{id}/move-group/`
Move board to a different group (or `null` for personal).

**Request** `{ "group_id": 5 }` or `{ "group_id": null }`

---

## Templates

### `GET /api/boards/templates/`
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

### `GET /api/boards/{id}/summary/`
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
      "stage_distribution": { "Backlog": 2, "In Progress": 3, "Done": 0 },
      "velocity_7d": 1,
      "velocity_30d": 4
    }
  ]
}
```

| Field | Description |
|---|---|
| `id`, `name`, `color` | Swimlane identifier, name, and color |
| `total_cards` | Total active (non-archived) cards in this swimlane |
| `stage_distribution` | Card count per column for this swimlane (all columns, including zero counts) |
| `velocity_7d` | Cards that moved into the board's last column in the last 7 days |
| `velocity_30d` | Cards that moved into the board's last column in the last 30 days |

---

### `GET /api/boards/{id}/analytics/`
Time-in-stage heatmap derived from `CardMovement` records.

**Query parameters:**

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `days` | integer | `30` | Must be a positive integer (`≥ 1`). Returns `400` if non-integer or `≤ 0`. |
| `stalled_days` | integer | `7` | Must be a positive integer (`≥ 1`). Returns `400` if non-integer or `≤ 0`. |

**Response shape:**

```json
{
  "days": 30,
  "columns": ["Backlog", "In Progress", "Done"],
  "done_columns": ["Done"],
  "board_medians": { "Backlog": 2.0, "In Progress": 5.5 },
  "stalled_threshold_days": 7,
  "swimlanes": [
    {
      "id": 1,
      "name": "Acme Corp",
      "avg_days_per_column": { "Backlog": 1.5, "In Progress": 8.0 },
      "is_outlier": { "Backlog": false, "In Progress": true },
      "deal_velocity_days": 12.3,
      "stalled_cards": [
        { "id": 42, "title": "Fix login bug", "days_since_move": 14 }
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
| `board_medians` | object | Median dwell time in days per active column, keyed by column name. Done columns are omitted. |
| `stalled_threshold_days` | integer | Dwell-time threshold used for stalled-card detection, mirrored from the `stalled_days` query parameter. |
| `swimlanes[].avg_days_per_column` | object | Average dwell time in days for each active column for this swimlane. Done columns are omitted. A `null` value means the swimlane has no movement data for that column in the requested window. |
| `swimlanes[].is_outlier` | object | Whether the swimlane's average for each active column exceeds 2× the board-wide median. Done columns are omitted. |

A cell is flagged as an outlier (`is_outlier: true`) when its per-swimlane average exceeds 2× the board-wide median for that column. Done columns are excluded from dwell-time calculations entirely — cards that have moved into a done column are considered complete and do not accumulate further dwell time in the heatmap. Archived cards contribute their dwell time up to the archive timestamp; active cards accumulate dwell time until they move again. Cards are excluded from stalled detection once archived.

CSV export (`Export CSV` button) is available to `admin` and `site_admin` roles only.

---

### `GET /api/boards/{id}/movements/`
Board-level movement history for all cards on the board, sorted newest first. Requires any board membership (viewer and above).

**Permissions:** any board member (`viewer` and above).

**Pagination:** fixed page size of 50 results. Use `offset` to page through results.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `swimlane_id` | integer | Filter by the card's current swimlane |
| `to_column_id` | integer | Filter by destination column |
| `assignee_id` | integer | Filter by card assignee |
| `moved_after` | ISO date | Include movements on or after this date (e.g. `2026-01-01`) |
| `moved_before` | ISO date | Include movements on or before this date |
| `exclude_type` | comma-separated string | Exclude movement types (e.g. `archived,unarchived` hides system events) |
| `offset` | integer | Pagination offset (default: `0`) |

When neither `moved_after` nor `moved_before` is specified, results default to the last 30 days.

**Response**
```json
{
  "count": 142,
  "offset": 0,
  "results": [
    {
      "id": 1089,
      "card_id": 42,
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
      "moved_by": { "display_name": "Alice" },
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
| `card_id` | integer | Card database ID |
| `card_title` | string | Card title at time of retrieval |
| `card_uid` | string | Card stable 16-char hex UID |
| `from_column`, `to_column` | integer / null | Column FK IDs (may be `null` if column was deleted) |
| `from_column_name`, `to_column_name` | string | Denormalized column names (preserved after deletion) |
| `from_column_uid`, `to_column_uid` | string | Denormalized column UIDs |
| `from_swimlane`, `to_swimlane` | integer / null | Swimlane FK IDs (may be `null` if swimlane was deleted) |
| `from_swimlane_name`, `to_swimlane_name` | string | Denormalized swimlane names |
| `from_swimlane_uid`, `to_swimlane_uid` | string | Denormalized swimlane UIDs |
| `moved_by` | object | User who performed the move (`display_name` only) |
| `moved_at` | string | ISO 8601 timestamp |
| `movement_type` | string | One of `move`, `archived`, `unarchived` |
| `notes` | string | Optional notes recorded at move time |

**Errors:** `403 Forbidden` if the caller is not a board member; `404 Not Found` if the board does not exist.

---

## Export & Import

### `GET /api/boards/{id}/export/`
Export the board as CSV. Returns a downloadable `text/csv` file. Available to all board members.

**CSV columns:** `Card ID`, `Title`, `Description`, `Column`, `Swimlane`, `Priority`, `Assignee`, `Labels`, `Due Date`, `Weight`, `Created At`, `Created By`, `Last Moved At`, `Movement Count`, `Movement History`

`Movement History` is a semicolon-separated list of pipe-delimited records: `<timestamp>|<from_column>|<to_column>|<moved_by>`.

### `GET /api/boards/{id}/export/?format=json`
Export the board as JSON. Returns `application/json`. Available to all board members.

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

### `POST /api/boards/import/`
Import a board from a Visiban JSON or CSV export file. Accepts `multipart/form-data` with a `file` field, an optional `name` field to override the board name, and an optional `group_id` field to place the imported board into a group (requires group admin). Creates a new board atomically. Requires authentication.

---

## Members

### `POST /api/boards/{id}/members/`
Add or update a board member. Requires board admin.

**Request** `{ "user_id": 42, "role": "member" }`

Valid roles: `admin`, `member`, `collaborator`, `viewer`

### `DELETE /api/boards/{id}/members/{user_id}/`
Remove a member. Requires board admin. Cannot remove a site admin.

---

## Board sharing

### `POST /api/boards/{id}/share/`
Generate (or regenerate) a public share token for the board. Requires board admin.

If a token already exists, calling this endpoint immediately invalidates the previous one and returns a new UUID. Any existing share links stop working as soon as the new token is issued.

**Permissions:** board `admin` or `site_admin` only.

**Response**
```json
{
  "share_token": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "share_url": "https://your-instance.example.com/share/3fa85f64-5717-4562-b3fc-2c963f66afa6"
}
```

**Errors:** `403 Forbidden` if the caller is not a board admin.

### `DELETE /api/boards/{id}/share/`
Revoke the public share token for the board. Requires board admin. All existing share links immediately return `404 Not Found` after revocation.

**Permissions:** board `admin` or `site_admin` only.

**Response**
```json
{
  "share_token": null
}
```

**Errors:** `403 Forbidden` if the caller is not a board admin.

---

## Columns

Column objects include a `uid` field — a stable 16-character hex identifier that does not change when the column is renamed or reordered. The `uid` is read-only; any `uid` value sent in a request body is ignored.

### `POST /api/boards/{id}/columns/`
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

### `PUT /api/boards/{id}/columns/{col_id}/`
Update a column. Requires board admin.

**Writable fields:** `name`, `color`, `wip_limit` (integer or `null`), `weight_limit` (integer or `null`), `allow_card_creation` (boolean), `is_done` (boolean)

### `DELETE /api/boards/{id}/columns/{col_id}/`
Delete a column. Requires board admin.

### `POST /api/boards/{id}/columns/reorder/`
Reorder columns. Requires board admin.

**Request** `{ "order": [3, 1, 4, 2] }` — list of column IDs in new order.

---

## Swimlanes

Swimlane objects include a `uid` field — stable across renames, read-only.

**Role-gated fields:** `contact_email` and `notes` are only included in responses for `admin` and `site_admin` role members. `member`, `collaborator`, and `viewer` roles receive swimlane objects without those fields. This applies to the swimlane list endpoint, `GET /api/boards/{id}/full/`, and WebSocket broadcast events.

### `POST /api/boards/{id}/swimlanes/`
Create a swimlane. Requires board admin.

**Request** `{ "name": "Acme Corp", "contact_email": "", "color": "#3B82F6" }`

> Swimlane names are unique per board. Creating a swimlane with a name that already exists on the same board returns `400 Bad Request`.

### `PUT /api/boards/{id}/swimlanes/{swimlane_id}/`
Update a swimlane. Requires board admin.

**Writable fields:** `name`, `color`, `contact_email`, `notes`

### `DELETE /api/boards/{id}/swimlanes/{swimlane_id}/`
Delete a swimlane. Requires board admin.

### `POST /api/boards/{id}/swimlanes/reorder/`
Reorder swimlanes. Requires board admin.

**Request** `{ "order": [2, 1, 3] }`

---

## Labels

Label objects include a `uid` field — stable across renames, read-only.

### `GET /api/boards/{id}/labels/`
List board labels.

### `POST /api/boards/{id}/labels/`
Create a label. Requires board admin.

**Request** `{ "name": "Bug", "color": "#EF4444" }`

### `PUT /api/boards/{id}/labels/{label_id}/`
Update a label. Requires board admin.

**Writable fields:** `name`, `color`

### `DELETE /api/boards/{id}/labels/{label_id}/`
Delete a label. Requires board admin.

---

## Public share endpoint

### `GET /api/share/{token}/`
Returns a read-only board payload identified by its UUID share token. No authentication is required.

**Authentication:** none required (public endpoint).

**Rate limiting:** 120 requests/hour per IP. Exceeding the limit returns `429 Too Many Requests`.

**Errors:** `404 Not Found` if the token is invalid, has been revoked, or does not exist.

**Response**
```json
{
  "uid": "a1b2c3d4e5f60001",
  "name": "Sales Pipeline",
  "staleness_threshold_days": 7,
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
| `staleness_threshold_days` | integer | Days without movement before a card is considered stale |
| `columns` | array | Column objects; includes `is_done` flag (see Columns section) |
| `swimlanes` | array | Swimlane objects; `contact_email` and `notes` are never included |
| `cards` | array | Active (non-archived) card objects |
| `labels` | array | Label objects |

Card objects in the public payload use `uid` as the identifier (not `id`) and do not include a database `id`. The `assignee` field contains `display_name` only; email, username, and avatar are omitted. Comments and checklist item text are not included; only `checklist_total` and `checklist_done` counts are present. The `is_stale` field is `true` when the card has not moved within the board's `staleness_threshold_days` window.
