# Boards API

## Boards

### `GET /api/boards/`
List all boards accessible to the current user.

### `POST /api/boards/`
Create a personal board. Creates default columns (Backlog, To Do, Doing, Done) and a "General" swimlane.

**Request** `{ "name": "My Board", "description": "" }`

### `GET /api/boards/{id}/`
Get board summary.

### `PUT /api/boards/{id}/`
Update board name/description. Requires board admin.

### `DELETE /api/boards/{id}/`
Delete board. Requires board owner or site admin.

### `GET /api/boards/{id}/full/`
Full board state — columns, swimlanes, cards, labels, members, and `current_user_role`.

### `POST /api/boards/{id}/move-group/`
Move board to a different group (or `null` for personal).

**Request** `{ "group_id": 5 }` or `{ "group_id": null }`

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

### `POST /api/boards/{id}/columns/`
Create a column. Requires board admin.

**Request** `{ "name": "Review", "color": "#8B5CF6", "wip_limit": 3, "weight_limit": null, "allow_card_creation": false }`

### `PUT /api/boards/{id}/columns/{col_id}/`
Update a column. Requires board admin.

### `DELETE /api/boards/{id}/columns/{col_id}/`
Delete a column. Requires board admin.

### `POST /api/boards/{id}/columns/reorder/`
Reorder columns. Requires board admin.

**Request** `{ "order": [3, 1, 4, 2] }` — list of column IDs in new order.

---

## Swimlanes

### `POST /api/boards/{id}/swimlanes/`
Create a swimlane. Requires board admin.

**Request** `{ "name": "Acme Corp", "contact_email": "", "color": "#3B82F6" }`

### `PUT /api/boards/{id}/swimlanes/{swimlane_id}/`
Update a swimlane. Requires board admin.

### `DELETE /api/boards/{id}/swimlanes/{swimlane_id}/`
Delete a swimlane. Requires board admin.

### `POST /api/boards/{id}/swimlanes/reorder/`
Reorder swimlanes. Requires board admin.

**Request** `{ "order": [2, 1, 3] }`

---

## Labels

### `GET /api/boards/{id}/labels/`
List board labels.

### `POST /api/boards/{id}/labels/`
Create a label. Requires board admin.

**Request** `{ "name": "Bug", "color": "#EF4444" }`

### `PUT /api/boards/{id}/labels/{label_id}/`
Update a label. Requires board admin.

### `DELETE /api/boards/{id}/labels/{label_id}/`
Delete a label. Requires board admin.
