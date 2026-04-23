# Groups API

## Groups

### `GET /api/v1/groups/`
List all groups accessible to the current user.

!!! note "Response shape differs from `GET /api/v1/groups/{id}/`"
    The list endpoint uses a leaner `GroupSerializer` that **does not** include the `ancestors` field — only the single-object retrieve endpoint (`GET /api/v1/groups/{id}/`) returns `ancestors`. Clients iterating the list and reading `entry.ancestors` will get `undefined`. Fetch the single group if you need the ancestor chain.

### `POST /api/v1/groups/`
Create a group. Any authenticated user may create a top-level group. Creating a subgroup requires admin of the parent.

**Request**
```json
{ "name": "Engineering", "description": "Backend and frontend teams.", "parent": 1 }
```

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Display name |
| `description` | No | Optional free-text summary |
| `parent` | No | Parent group ID; omit for a top-level group |

### `GET /api/v1/groups/{id}/`
Get group details.

**Response fields:**

| Field | Type | Description |
|---|---|---|
| `id` | integer | Group ID |
| `name` | string | Display name |
| `description` | string | Optional free-text summary. Empty string if not set. |
| `parent` | integer\|null | Parent group ID, or `null` for top-level groups |
| `parent_name` | string\|null | Parent group display name (convenience field), or `null` |
| `owner` | object | `{ "id", "username", "display_name", "avatar_url" }` |
| `member_count` | integer | Total number of direct members (does not include inherited) |
| `board_count` | integer | Number of boards directly in this group |
| `subgroup_count` | integer | Number of direct subgroups |
| `is_starred` | boolean | Whether the requesting user has starred this group |
| `shared_labels` | array | Labels shared across all boards in this group |
| `default_board_member_role` | string | Role assigned to group members on new boards |
| `allowed_priorities` | array | Priority values permitted on boards in this group. Empty array means all priorities allowed. |
| `ancestors` | array | Ordered list of ancestor groups from root to immediate parent. Each entry is `{ "id": 1, "name": "Acme Corp" }`. Empty for top-level groups. **Only present on this single-object retrieve endpoint** — the list endpoint (`GET /api/v1/groups/`) omits `ancestors`. |
| `created_at` | string | ISO 8601 timestamp |

### `PUT /api/v1/groups/{id}/`
Update group name, description, or parent. Requires group admin.

**Writable fields:** `name`, `description`, `parent`.

### `DELETE /api/v1/groups/{id}/`
Delete a group. Requires group owner or site admin.

---

## Members

### `GET /api/v1/groups/{id}/members/`
List group members. Requires group membership.

### `PATCH /api/v1/groups/{id}/members/{user_id}/`
Change a member's role. Requires group admin. Cannot modify a site admin.

**Request** `{ "role": "admin" }`

Valid roles: `admin`, `member`, `collaborator`, `viewer`

### `DELETE /api/v1/groups/{id}/members/{user_id}/`
Remove a member. Requires group admin. Cannot remove a site admin.

---

## Subgroups

### `GET /api/v1/groups/{id}/subgroups/`
List direct subgroups of this group that are visible to the requesting user. Requires membership in this group or any ancestor group. Visibility follows the RBAC inheritance model: members of a parent group see all descendant subgroups (not only subgroups they have been added to directly) — see [Role Inheritance](../features/rbac/inheritance.md#visibility-of-descendant-groups) for the full rule.

**Response** — array of `Group` summary objects (same shape as the list endpoint; `ancestors` is omitted for parity with `GET /api/v1/groups/`).

---

## Boards

### `GET /api/v1/groups/{id}/boards/`
List boards in this group. Requires group membership.

### `POST /api/v1/groups/{id}/boards/`
Create a board in this group. Requires group admin. Boards created here inherit the group's `shared_labels` and `allowed_priorities` automatically.

**Request**

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Board display name |
| `description` | No | Optional free-text description |
| `template` | No | Template slug to pre-populate columns. Valid values match those from `GET /api/v1/boards/templates/` (e.g. `simple_kanban`, `sales_pipeline`, `customer_support`). Default: `simple_kanban`. |
| `swimlane_name` | No | Label for the swimlane axis (e.g. `"Customer"`, `"Team"`). Defaults to `"Swimlane"` |

### `GET /api/v1/groups/{id}/descendant-boards/`
List all boards in this group and all of its descendant subgroups that the requesting user can access. This answers "what boards live anywhere inside this group subtree?" — including boards in deeply nested subgroups. Requires group membership.

**Response** — array of board summary objects (same shape as `GET /api/v1/groups/{id}/boards/`). Each board's `group_detail` is always populated with a `GroupBrief` payload including the `ancestors` chain, so callers can render a full relative breadcrumb without an extra request (#845). `ancestors` is root-first and does **not** include the board's direct parent group — that name is in `group_name`.

**Errors:** `403 Forbidden` if the caller is not a group member; `404 Not Found` if the group does not exist.

---

## Invite links

A group can have up to 5 active invite links. Each link has an independent name, role, and expiry.

### `GET /api/v1/groups/{id}/invite-links/`
List all invite links for this group. Requires group admin.

### `POST /api/v1/groups/{id}/invite-links/`
Create a new invite link. Requires group admin.

**Request**
```json
{ "name": "Team link", "role": "member", "expiry_days": 7 }
```

All fields are optional. `role` defaults to `member`; `expiry_days` may be `1`, `7`, `30`, or `null` (never expires).

Valid roles: `admin`, `member`, `collaborator`, `viewer`

**Response (create only)** — the raw `token` is returned once and never again:
```json
{ "id": 1, "token": "abc123raw", "prefix": "abc123ra", "name": "Team link", "role": "member", "is_active": true, "is_expired": false, "expires_at": "2026-04-07T00:00:00Z", "created_at": "2026-03-31T00:00:00Z" }
```

**List response** — `token` is absent; `prefix` (first 8 chars) is shown for identification:
```json
{ "id": 1, "prefix": "abc123ra", "name": "Team link", "role": "member", "is_active": true, "is_expired": false, "expires_at": "2026-04-07T00:00:00Z", "created_at": "2026-03-31T00:00:00Z" }
```

### `DELETE /api/v1/groups/{id}/invite-links/{link_id}/`
Revoke a single invite link. Requires group admin.

---

## Favorites

### `POST /api/v1/groups/{id}/star/`
Star (favorite) a group. Requires authentication.

### `DELETE /api/v1/groups/{id}/star/`
Unstar a group. Requires authentication.

### `GET /api/v1/groups/?starred=true`
List only starred groups for the current user.

---

## Transfer ownership

### `POST /api/v1/groups/{id}/transfer-ownership/`
Transfer group ownership to another user. Requires the **current owner** (not just admin).

**Request**
```json
{ "new_owner_id": 42, "confirmation": "Engineering" }
```

- `new_owner_id` — the user ID of the new owner; must already be a group **admin**
- `confirmation` — must exactly match the group's name (case-sensitive) to prevent accidental transfers

The previous owner becomes a regular admin after transfer. Returns the updated group object.

**Error responses**
- `403 Forbidden` — you are not the current owner
- `400 Bad Request` — confirmation does not match group name, or new owner is not an admin member

---

## Group shared labels

Group labels are a shared label library. When a new board is created inside the group, it inherits the group's labels automatically.

### `GET /api/v1/groups/{id}/labels/`
List group shared labels. Requires group membership.

**Response** `[{ "id": 1, "name": "Bug", "color": "#EF4444" }, ...]`

### `POST /api/v1/groups/{id}/labels/`
Create a group shared label. Requires group admin.

**Request** `{ "name": "Feature", "color": "#3B82F6" }`

### `PATCH /api/v1/groups/{id}/labels/{label_id}/`
Update a group shared label name or color. Requires group admin.

### `DELETE /api/v1/groups/{id}/labels/{label_id}/`
Delete a group shared label. Requires group admin. Does **not** remove the label from boards that already inherited it.

---

## Board defaults

### `PATCH /api/v1/groups/{id}/board-defaults/`
Update the default settings applied to new boards created in this group. Requires group admin.

**Patchable fields**

| Field | Type | Description |
|---|---|---|
| `default_board_member_role` | string | Role assigned to group members on new boards — `admin`, `member`, `collaborator`, or `viewer` |
| `allowed_priorities` | array / null | Restricts which priorities new boards may use (e.g. `["low", "medium", "high"]`); `null` allows all |

**Request**
```json
{ "default_board_member_role": "member", "allowed_priorities": ["low", "medium", "high"] }
```

Returns the updated group object.

---

## Join (public)

### `GET /api/v1/groups/join/{token}/`
Resolve an invite token to a group name. No authentication required. Rate-limited to 10 requests/hour per IP.

**Response** `{ "group_id": 5, "group_name": "Engineering", "role": "member" }`

**Errors:** `404 Not Found` (invalid token), `410 Gone` (link expired or deactivated)

### `POST /api/v1/groups/join/{token}/`
Join the group with the role configured on the invite link. Requires authentication. Rate-limited to 10 requests/hour per IP.

**Response** `201 Created` (first join) or `200 OK` (already a member at the same or higher role).

**Note:** Existing memberships are not downgraded — if you already hold a higher role than the link's role, your current role is preserved.

**Errors:** `401 Unauthorized` (not authenticated), `404 Not Found` (invalid token), `410 Gone` (link expired or deactivated)
