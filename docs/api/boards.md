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
| `created_at`, `updated_at` | string | ISO 8601 timestamps |

### `PUT /api/boards/{id}/`
Update board fields. Requires board admin.

**Writable fields:** `name`, `description`, `staleness_threshold_days`, `allowed_priorities`. Board admins may also set `enforce_wip_limits` and `enforce_weight_limits`; non-admins sending these fields receive `403 Forbidden`.

### `DELETE /api/boards/{id}/`
Delete board. Requires board owner or site admin.

### `GET /api/boards/{id}/full/`
Full board state — columns, swimlanes, cards, labels, members, and `current_user_role`. All objects include their `uid` field.

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

> **Added in 1.0.0-rc.9:** Content Production, Hiring & Recruiting, Legal & Compliance, Infrastructure & DevOps templates.

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
  "board_medians": { "Backlog": 2.0, "In Progress": 5.5, "Done": 1.0 },
  "stalled_threshold_days": 7,
  "swimlanes": [
    {
      "id": 1,
      "name": "Acme Corp",
      "avg_days_per_column": { "Backlog": 1.5, "In Progress": 8.0, "Done": null },
      "is_outlier": { "Backlog": false, "In Progress": true, "Done": false },
      "deal_velocity_days": 12.3,
      "stalled_cards": [
        { "id": 42, "title": "Fix login bug", "days_since_move": 14 }
      ]
    }
  ]
}
```

A cell is flagged as an outlier (`is_outlier: true`) when its per-swimlane average exceeds 2× the board-wide median for that column. Archived cards contribute their dwell time up to the archive timestamp; active cards accumulate dwell time until they move again. Cards are excluded from stalled detection once archived.

CSV export (`Export CSV` button) is available to `admin` and `site_admin` roles only.

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

## Columns

Column objects include a `uid` field — a stable 16-character hex identifier that does not change when the column is renamed or reordered. The `uid` is read-only; any `uid` value sent in a request body is ignored.

### `POST /api/boards/{id}/columns/`
Create a column. Requires board admin.

**Request** `{ "name": "Review", "color": "#8B5CF6", "wip_limit": 3, "weight_limit": null, "allow_card_creation": false }`

> When `allow_card_creation` is `false`, posting a new card to that column returns `400 Bad Request` with `{"column": "Card creation is not allowed in this column."}`.
>
> WIP and weight limits are enforced when `enforce_wip_limits` or `enforce_weight_limits` is enabled on the board. A card move to an over-limit column returns `409 Conflict` — see the move endpoint in the [Cards API](cards.md) for the full error schema and the `?force=true` admin override. When enforcement is disabled, limits are displayed but not enforced.

### `PUT /api/boards/{id}/columns/{col_id}/`
Update a column. Requires board admin.

**Writable fields:** `name`, `color`, `wip_limit` (integer or `null`), `weight_limit` (integer or `null`), `allow_card_creation` (boolean)

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
