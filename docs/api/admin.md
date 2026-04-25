# Admin API

All endpoints in this section require **site admin** authentication. Non-admin users receive `403 Forbidden`.

See [Admin Panel](../administration/admin-panel.md) for the equivalent UI and [Site Admins](../administration/site-admins.md) for first-boot setup.

---

## Site settings

### `GET /api/v1/admin/settings/`
Return the current instance-wide settings.

**Response**
```json
{ "registration_mode": "open", "uploads_enabled": true }
```

| Field | Type | Description |
|---|---|---|
| `registration_mode` | `"open"` / `"invite_only"` / `"closed"` | Controls who can self-register |
| `uploads_enabled` | boolean | When `false`, attachment uploads are blocked for all users |

### `PATCH /api/v1/admin/settings/`
Update site settings. All fields are optional.

**Request**
```json
{ "registration_mode": "invite_only", "uploads_enabled": false }
```

Changes take effect within approximately 60 seconds (server-side cache TTL) — no restart required.

---

## Users

### `GET /api/v1/admin/users/`
Paginated list of all accounts on the instance. Site admin only.

**Query params**

| Param | Description |
|---|---|
| `search` | Filter by username, display name, or email (partial, case-insensitive) |
| `offset` | Zero-based row offset (default: `0`) |
| `page_size` | Results per page (default: `50`, max: `200`) |

**Response** — `{count, offset, page_size, results}` envelope (same shape as all paginated endpoints):
```json
{
  "count": 142,
  "offset": 0,
  "page_size": 50,
  "results": [
    {
      "id": 1,
      "username": "alice",
      "email": "alice@example.com",
      "display_name": "Alice Smith",
      "first_name": "Alice",
      "last_name": "Smith",
      "avatar_url": null,
      "is_active": true,
      "is_site_admin": false,
      "can_access_all_content": false,
      "has_completed_tour": true,
      "must_change_password": false,
      "date_joined": "2026-01-15T09:00:00Z",
      "owned_boards": [
        { "id": 3, "uid": "a1b2c3d4e5f60718", "name": "Acme Pipeline" }
      ]
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `id`, `username`, `email` | — | Account identifiers |
| `display_name`, `first_name`, `last_name` | string | Name fields |
| `avatar_url` | string\|null | URL to the user's avatar image |
| `is_active` | boolean | `false` means the account is deactivated (login blocked) |
| `is_site_admin` | boolean | Whether this user has access to the admin panel |
| `can_access_all_content` | boolean | Whether this user has super-admin access to all boards and groups, independent of membership |
| `has_completed_tour` | boolean | Whether the onboarding tour has been dismissed |
| `must_change_password` | boolean | `true` means the user will be forced to set a new password on next login |
| `date_joined` | ISO 8601 | Account creation timestamp |
| `owned_boards` | array | Boards owned by this user — each entry has `id`, `uid`, and `name`. Critical for determining what must be transferred before deactivation. |

### `POST /api/v1/admin/users/`
Create a new local account. Site admin only.

**Request**
```json
{
  "username": "bob",
  "email": "bob@example.com",
  "password": "securepassword123",
  "force_password_reset": true
}
```

| Field | Required | Notes |
|---|---|---|
| `username` | Yes | Must be unique on the instance (case-insensitive) |
| `email` | Yes | Must be unique on the instance |
| `password` | Yes | Minimum 12 characters |
| `force_password_reset` | No | Default `true` — the user must set a new password on first login |

Returns `201 Created` with the new user object. The response does **not** include the password — copy it before closing if needed.

### `PATCH /api/v1/admin/users/{id}/`
Update a user's account flags. Site admin only.

**Patchable fields**

| Field | Type | Notes |
|---|---|---|
| `is_active` | boolean | `false` deactivates the account (blocks login without deleting data). Cannot deactivate your own account. |
| `is_site_admin` | boolean | Grant or revoke admin panel access. Cannot demote yourself. Cannot demote the last active admin. |
| `can_access_all_content` | boolean | Grant or revoke omniscient read/write access to all boards and groups. Independent of `is_site_admin` — see [Site Admins](../administration/site-admins.md). |
| `has_completed_tour` | boolean | Reset (`false`) to re-show the onboarding tour to this user on next login |
| `must_change_password` | boolean | `true` forces a password reset on next login |

**Request**
```json
{ "is_active": false }
```

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "..."}` | Invalid field value, or attempting to demote yourself / the last active site admin. |
| `403 Forbidden` | `{"detail": "..."}` | Caller is not a site admin. |
| `409 Conflict` | `{"code": "owned_boards", "detail": "...", "owned_boards": [{"id", "uid", "name"}, ...]}` | Caller attempted to set `is_active: false` on a user who owns one or more boards. Use [`POST /api/v1/admin/users/{id}/deactivate/`](#post-apiv1adminusersiddeactivate) instead and supply a `transfers` list. The `owned_boards` array identifies which boards block the deactivation. |

### `POST /api/v1/admin/users/{id}/deactivate/`

Deactivate a user account and transfer ownership of any boards they own to other members.

**Permission:** `IsSiteAdmin`. Cannot deactivate your own account.

If the target user owns one or more boards, you must supply a `transfers` list mapping each owned board to an eligible recipient. The recipient must have access to the board — either as a direct board member or through group membership. Group-inherited access is accepted. If any owned board has no eligible transfer targets (i.e. the user is the sole member with no group-inherited members either), the request returns `400 Bad Request` with details.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `transfers` | array | Conditional | Required when the user owns boards. Each entry maps one board to a new owner. |
| `transfers[].board_id` | integer | Yes | ID of the board to transfer. |
| `transfers[].transfer_to` | integer | Yes | ID of the user who will become the new owner. Must be an existing board member. |

```json
{
  "transfers": [
    { "board_id": 12, "transfer_to": 7 },
    { "board_id": 18, "transfer_to": 7 }
  ]
}
```

**Response** `200 OK` — the updated user object (same shape as `GET /api/v1/admin/users/`).

```json
{
  "id": 4,
  "username": "carol",
  "email": "carol@example.com",
  "display_name": "Carol Jones",
  "first_name": "Carol",
  "last_name": "Jones",
  "avatar_url": null,
  "is_active": false,
  "is_site_admin": false,
  "must_change_password": false,
  "date_joined": "2025-11-02T08:00:00Z",
  "owned_boards": []
}
```

After a successful deactivation with transfers, `owned_boards` will be `[]` — all boards have been transferred to their new owners.

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | A `transfer_to` does not have access to the specified board (neither direct membership nor group-inherited access) |
| `400 Bad Request` | A board in the `transfers` list does not belong to this user |
| `409 Conflict` | User owns one or more boards and no `transfers` were provided |

---

## Invite links

Invite links allow new users to self-register when the instance is in `invite_only` mode. Each link contains a single-use or multi-use token that is validated during registration.

### `GET /api/v1/admin/invite-links/`

List all invite links on the instance.

**Permission:** `IsSiteAdmin`.

**Response**

```json
[
  {
    "id": 1,
    "prefix": "iL4xQ",
    "expires_at": "2026-04-30T00:00:00Z",
    "single_use": true,
    "used_at": null,
    "revoked_at": null,
    "created_at": "2026-03-20T10:00:00Z",
    "use_count": 0,
    "status": "active",
    "created_by_username": "admin"
  },
  {
    "id": 2,
    "prefix": "rZ9mW",
    "expires_at": null,
    "single_use": false,
    "used_at": null,
    "revoked_at": "2026-03-25T14:00:00Z",
    "created_at": "2026-03-15T09:00:00Z",
    "use_count": 4,
    "status": "revoked",
    "created_by_username": "admin"
  }
]
```

**Response fields**

| Field | Type | Description |
|---|---|---|
| `id` | integer | Unique link ID. |
| `prefix` | string | Short identifier derived from the token — safe to display, cannot be used to reconstruct the full token. |
| `expires_at` | datetime \| null | ISO 8601 UTC expiry, or `null` if the link does not expire. |
| `single_use` | boolean | When `true`, the link becomes invalid after one successful registration. |
| `used_at` | datetime \| null | ISO 8601 UTC timestamp of when a single-use link was consumed, or `null`. |
| `revoked_at` | datetime \| null | ISO 8601 UTC timestamp of when the link was revoked, or `null`. |
| `created_at` | datetime | ISO 8601 UTC timestamp of when the link was created. |
| `use_count` | integer | Number of successful registrations through this link. Incremented on every consumption (including multi-use links) and preserved across revocation for audit visibility. |
| `status` | `"active"` \| `"expired"` \| `"used"` \| `"revoked"` | Computed status of the link. |
| `created_by_username` | string | Username of the admin who created the link. |

---

### `POST /api/v1/admin/invite-links/`

Create a new invite link.

**Permission:** `IsSiteAdmin`.

**Request body** — all fields are optional.

| Field | Type | Required | Description |
|---|---|---|---|
| `expires_in_days` | `1` \| `7` \| `30` \| `null` | No | How many days until the link expires. `null` creates a non-expiring link. Default: `null`. |
| `single_use` | boolean | No | When `true`, the link is invalidated after one successful registration. Default: `false`. |

```json
{ "expires_in_days": 7, "single_use": true }
```

**Response** `201 Created`

The response includes a one-time `raw_token` field. **Store or share it immediately — it cannot be retrieved again.** All other fields are identical to the list response.

```json
{
  "id": 3,
  "prefix": "kT2vN",
  "expires_at": "2026-04-03T10:00:00Z",
  "single_use": true,
  "used_at": null,
  "revoked_at": null,
  "created_at": "2026-03-27T10:00:00Z",
  "use_count": 0,
  "status": "active",
  "created_by_username": "admin",
  "raw_token": "kT2vNa8f3b1c9e2d7f4a0b5c6d8e1f2a3b4c5d6e7"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | `expires_in_days` is not one of `1`, `7`, `30`, or `null` |
| `400 Bad Request` | The active-link cap for the instance has been reached |

---

### `DELETE /api/v1/admin/invite-links/{id}/`

Revoke an invite link immediately. The link can no longer be used for registration.

**Permission:** `IsSiteAdmin`.

**Response** `200 OK` — the updated link object with `status: "revoked"`.

```json
{
  "id": 1,
  "prefix": "iL4xQ",
  "expires_at": "2026-04-30T00:00:00Z",
  "single_use": true,
  "used_at": null,
  "revoked_at": "2026-03-27T11:05:00Z",
  "created_at": "2026-03-20T10:00:00Z",
  "use_count": 0,
  "status": "revoked",
  "created_by_username": "admin"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | Link is already revoked |
| `400 Bad Request` | Link has already been used (single-use links cannot be revoked after use) |
| `404 Not Found` | Link does not exist |
