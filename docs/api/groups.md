# Groups API

## Groups

### `GET /api/groups/`
List all groups accessible to the current user.

### `POST /api/groups/`
Create a group. Any authenticated user may create a top-level group. Creating a subgroup requires admin of the parent.

**Request**
```json
{ "name": "Engineering", "parent": 1 }
```
`parent` is optional. Omit for a top-level group.

### `GET /api/groups/{id}/`
Get group details.

### `PUT /api/groups/{id}/`
Update group name/parent. Requires group admin.

### `DELETE /api/groups/{id}/`
Delete a group. Requires group owner or site admin.

---

## Members

### `GET /api/groups/{id}/members/`
List group members. Requires group membership.

### `PATCH /api/groups/{id}/members/{user_id}/`
Change a member's role. Requires group admin. Cannot modify a site admin.

**Request** `{ "role": "admin" }`

Valid roles: `admin`, `member`

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

### `POST /api/groups/{id}/invite-link/`
Generate (or return existing) an active invite link. Requires group admin.

**Response** `{ "id": 1, "token": "abc123", "is_active": true, "created_at": "..." }`

### `DELETE /api/groups/{id}/invite-link/`
Deactivate all active invite links. Requires group admin.

---

## Join (public)

### `GET /api/groups/join/{token}/`
Resolve an invite token to a group name. No authentication required.

**Response** `{ "group_id": 5, "group_name": "Engineering" }`

### `POST /api/groups/join/{token}/`
Join the group as a `member`. Requires authentication.

**Response** `201 Created` (first join) or `200 OK` (already a member).
