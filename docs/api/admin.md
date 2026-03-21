# Admin API

> **Added in 1.0.0-rc.6**

All endpoints in this section require **site admin** authentication. Non-admin users receive `403 Forbidden`.

See [Admin Panel](../administration/admin-panel.md) for the equivalent UI and [Site Admins](../administration/site-admins.md) for first-boot setup.

---

## Site settings

### `GET /api/admin/settings/`
Return the current instance-wide settings.

**Response**
```json
{ "registration_mode": "open" }
```

| Field | Values | Description |
|---|---|---|
| `registration_mode` | `"open"` / `"invite_only"` / `"closed"` | Controls who can self-register |

### `PATCH /api/admin/settings/`
Update site settings. All fields are optional.

**Request**
```json
{ "registration_mode": "invite_only" }
```

Changes take effect immediately — no restart required.

---

## Users

### `GET /api/admin/users/`
Paginated list of all accounts on the instance. Site admin only.

**Query params**

| Param | Description |
|---|---|
| `search` | Filter by username, display name, or email (partial, case-insensitive) |
| `page` | Page number (default: 1) |
| `page_size` | Results per page (default: 50, max: 200) |

**Response**
```json
{
  "count": 142,
  "next": "/api/admin/users/?page=2",
  "previous": null,
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
      "must_change_password": false,
      "date_joined": "2026-01-15T09:00:00Z"
    }
  ]
}
```

### `POST /api/admin/users/`
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
| `username` | Yes | Must be unique on the instance |
| `email` | Yes | Must be unique on the instance |
| `password` | Yes | Minimum 12 characters |
| `force_password_reset` | No | Default `true` — the user must set a new password on first login |

Returns `201 Created` with the new user object. The response does **not** include the password — copy it before closing if needed.

### `PATCH /api/admin/users/{id}/`
Update a user's account flags. Site admin only.

**Patchable fields**

| Field | Type | Notes |
|---|---|---|
| `is_active` | boolean | `false` deactivates the account (blocks login without deleting data). Cannot deactivate your own account. |
| `is_site_admin` | boolean | Grant or revoke site admin. Cannot demote yourself. Cannot demote the last active admin. |
| `must_change_password` | boolean | `true` forces a password reset on next login |

**Request**
```json
{ "is_active": false }
```
