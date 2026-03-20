# Boards API

## Boards

### `GET /api/boards/`
List all boards accessible to the current user.

### `POST /api/boards/`
Create a personal board. Creates default columns (Backlog, To Do, Doing, Done) and a "General" swimlane.

**Request** `{ "name": "My Board", "description": "" }`

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
| `is_starred` | boolean | Whether the requesting user has starred this board |
| `created_at`, `updated_at` | string | ISO 8601 timestamps |

### `PUT /api/boards/{id}/`
Update board name/description. Requires board admin.

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

Available templates: **Sales Pipeline**, **Customer Support**, **Customer Success**, **Simple Kanban**, **Product Roadmap**, **Project Delivery**, **Blank Board**.

---

## Export & Import

### `GET /api/boards/{id}/export/`
Export the board as CSV. Returns a downloadable file with one row per card including metadata and movement history. Available to all board members.

### `GET /api/boards/{id}/export/?format=json`
Export the board as JSON. Returns a structured object with columns, swimlanes, labels, and cards (including comments and checklists). All objects include their `uid`. Available to all board members.

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

> When `allow_card_creation` is `false`, posting a new card to that column returns `400 Bad Request` with `{"column": "Card creation is not allowed in this column."}`. WIP and weight limits are informational soft limits — the API does not reject card creation or moves when they are exceeded.

### `PUT /api/boards/{id}/columns/{col_id}/`
Update a column. Requires board admin.

### `DELETE /api/boards/{id}/columns/{col_id}/`
Delete a column. Requires board admin.

### `POST /api/boards/{id}/columns/reorder/`
Reorder columns. Requires board admin.

**Request** `{ "order": [3, 1, 4, 2] }` — list of column IDs in new order.

---

## Swimlanes

Swimlane objects include a `uid` field — stable across renames, read-only.

### `POST /api/boards/{id}/swimlanes/`
Create a swimlane. Requires board admin.

**Request** `{ "name": "Acme Corp", "contact_email": "", "color": "#3B82F6" }`

> Swimlane names are unique per board. Creating a swimlane with a name that already exists on the same board returns `400 Bad Request`.

### `PUT /api/boards/{id}/swimlanes/{swimlane_id}/`
Update a swimlane. Requires board admin.

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

### `DELETE /api/boards/{id}/labels/{label_id}/`
Delete a label. Requires board admin.
