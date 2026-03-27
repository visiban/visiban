# Groups API

## Groups

### `GET /api/groups/`
List all groups accessible to the current user.

### `POST /api/groups/`
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

### `GET /api/groups/{id}/`
Get group details.

**Response includes** `id`, `name`, `description`, `parent`, `owner`, `created_at`, and:

| Field | Type | Description |
|---|---|---|
| `description` | string | Optional free-text summary of the group. Empty string if not set. |
| `ancestors` | array | Ordered list of ancestor groups from root to immediate parent. Each entry is `{ "id": 1, "name": "Acme Corp" }`. Empty array for top-level groups. |

### `PUT /api/groups/{id}/`
Update group name, description, or parent. Requires group admin.

**Writable fields:** `name`, `description`, `parent`.

### `DELETE /api/groups/{id}/`
Delete a group. Requires group owner or site admin.

---

## Members

### `GET /api/groups/{id}/members/`
List group members. Requires group membership.

### `PATCH /api/groups/{id}/members/{user_id}/`
Change a member's role. Requires group admin. Cannot modify a site admin.

**Request** `{ "role": "admin" }`

Valid roles: `admin`, `member`, `collaborator`, `viewer`

### `DELETE /api/groups/{id}/members/{user_id}/`
Remove a member. Requires group admin. Cannot remove a site admin.

---

## Subgroups

### `GET /api/groups/{id}/subgroups/`
List direct subgroups. Requires group membership.

---

## Boards

### `GET /api/groups/{id}/boards/`
List boards in this group. Requires group membership.

### `POST /api/groups/{id}/boards/`
Create a board in this group. Requires group admin.

**Request** `{ "name": "Sprint 12", "description": "" }`

---

## Invite links

A group can have up to 5 active invite links. Each link has an independent name, role, and expiry.

### `GET /api/groups/{id}/invite-links/`
List all invite links for this group. Requires group admin.

### `POST /api/groups/{id}/invite-links/`
Create a new invite link. Requires group admin.

**Request**
```json
{ "name": "Team link", "role": "member", "expiry_days": 7 }
```

All fields are optional. `role` defaults to `member`; `expiry_days` may be `1`, `7`, `30`, or `null` (never expires).

Valid roles: `admin`, `member`, `collaborator`, `viewer`

**Response** `{ "id": 1, "token": "abc123", "name": "Team link", "role": "member", "is_active": true, "expires_at": "...", "created_at": "..." }`

### `DELETE /api/groups/{id}/invite-links/{link_id}/`
Revoke a single invite link. Requires group admin.

---

## Favorites

### `POST /api/groups/{id}/star/`
Star (favorite) a group. Requires authentication.

### `DELETE /api/groups/{id}/star/`
Unstar a group. Requires authentication.

### `GET /api/groups/?starred=true`
List only starred groups for the current user.

---

## Transfer ownership

### `POST /api/groups/{id}/transfer-ownership/`
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

### `GET /api/groups/{id}/labels/`
List group shared labels. Requires group membership.

**Response** `[{ "id": 1, "name": "Bug", "color": "#EF4444" }, ...]`

### `POST /api/groups/{id}/labels/`
Create a group shared label. Requires group admin.

**Request** `{ "name": "Feature", "color": "#3B82F6" }`

### `PATCH /api/groups/{id}/labels/{label_id}/`
Update a group shared label name or color. Requires group admin.

### `DELETE /api/groups/{id}/labels/{label_id}/`
Delete a group shared label. Requires group admin. Does **not** remove the label from boards that already inherited it.

---

## Board defaults

### `PATCH /api/groups/{id}/board-defaults/`
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

### `GET /api/groups/join/{token}/`
Resolve an invite token to a group name. No authentication required.

**Response** `{ "group_id": 5, "group_name": "Engineering" }`

### `POST /api/groups/join/{token}/`
Join the group with the role configured on the invite link. Requires authentication.

**Response** `201 Created` (first join) or `200 OK` (already a member).
