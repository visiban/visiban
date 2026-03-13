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

## Join (public)

### `GET /api/groups/join/{token}/`
Resolve an invite token to a group name. No authentication required.

**Response** `{ "group_id": 5, "group_name": "Engineering" }`

### `POST /api/groups/join/{token}/`
Join the group with the role configured on the invite link. Requires authentication.

**Response** `201 Created` (first join) or `200 OK` (already a member).
