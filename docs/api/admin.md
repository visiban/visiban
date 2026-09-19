# Admin API

All endpoints in this section require **site admin** authentication. Non-admin users receive `403 Forbidden`.

See [Admin Panel](../administration/admin-panel.md) for the equivalent UI and [Site Admins](../administration/site-admins.md) for first-boot setup.

---

## Site settings

### `GET /api/v1/admin/settings/`
Return the current instance-wide settings.

**Response**
```json
{
  "registration_mode": "open",
  "uploads_enabled": true,
  "maintenance_mode": false,
  "maintenance_message": ""
}
```

| Field | Type | Description |
|---|---|---|
| `registration_mode` | `"open"` / `"invite_only"` / `"closed"` | Controls who can self-register |
| `uploads_enabled` | boolean | When `false`, attachment uploads are blocked for all users |
| `maintenance_mode` | boolean | When `true`, non-admin write requests are rejected with `503`. Defaults to `false`. Added in 1.2. |
| `maintenance_message` | string | Plain-text notice shown while maintenance mode is active. Max 1000 characters. Blank means "use the built-in default". Added in 1.2. |

### `PATCH /api/v1/admin/settings/`
Update site settings. All fields are optional.

**Request**
```json
{ "registration_mode": "invite_only", "uploads_enabled": false }
```

Changes take effect within approximately 60 seconds (server-side cache TTL) — no restart required.

Every change to `registration_mode`, `uploads_enabled`, `maintenance_mode` and
`maintenance_message` is recorded in the [action log](#action-log). Submitting a field with
the value it already holds is not a change and records nothing.

---

## Action log

> **Added in 1.2**

### `GET /api/v1/admin/action-log/`

Return the audit trail of instance-wide admin actions, newest first. Site-admin only — an
audit trail of privileged actions is itself sensitive, since it shows when the instance was
unattended and who holds admin rights.

Read-only: there is no write or delete endpoint. Rows are appended by the actions themselves,
and an audit log an admin can edit is not evidence of anything.

**Query parameters**

| Param | Description |
|---|---|
| `action` | Return only rows with this action. An unrecognized value is a `400`, not an empty page. |
| `offset` / `page_size` | Standard pagination (default 50, max 200). |

**Response**
```json
{
  "count": 2,
  "offset": 0,
  "page_size": 50,
  "results": [
    {
      "id": 2,
      "action": "maintenance_mode.disabled",
      "actor_id": 4,
      "actor_username": "alice",
      "source": "admin_api",
      "metadata": { "message": "Upgrading to 1.2 — back by 14:00 UTC." },
      "created_at": "2026-09-18T14:02:11Z"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `id` | integer | Unique row id |
| `action` | string | What happened, as `<subject>.<verb>` — see the table below |
| `actor_id` | integer / null | User who performed the action; `null` when there was no authenticated actor. May reference an account that has since been deleted |
| `actor_username` | string | Username captured at the time of the action; `""` when there was no authenticated actor |
| `source` | `"admin_api"` / `"django_admin"` / `"cli"` | Which operator path was used |
| `metadata` | object | Action-specific detail. Keys are additive-only |
| `created_at` | string | ISO 8601 timestamp |

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"action": ["'<value>' is not a valid action."]}` | The `action` query param does not match one of the values in the table below |

**Actions**

| `action` | `metadata` |
|---|---|
| `maintenance_mode.enabled` | `{"message": "<the notice users will now see>"}` |
| `maintenance_mode.disabled` | `{"message": "<the notice users saw during the window>"}` |
| `maintenance_message.changed` | `{"from": "...", "to": "..."}` |
| `registration_mode.changed` | `{"from": "open", "to": "closed"}` |
| `uploads_enabled.enabled` | `{}` |
| `uploads_enabled.disabled` | `{}` |

New action types may be added in any minor release; treat an unrecognized `action` as an
opaque string rather than failing on it.

!!! warning "What this log does *not* record yet"
    Only the instance-wide settings above are covered. Granting or revoking site admin,
    changing `can_access_all_content`, deactivating a user, and creating or revoking invite
    links are **not** recorded — so this is not yet a complete record of privileged activity.
    Do not read an absence of entries as evidence that no admin action took place.

!!! warning "The acting admin's username is retained indefinitely"
    `actor_username` is stored verbatim and is **not** cleared when the account is deleted —
    unlike, for example, group and invite-link creators, which report `null` once anonymized.
    This is deliberate: an audit record that cannot name the actor cannot answer the question
    it exists for. Operators with data-erasure obligations should account for this table.

!!! note "Direct database writes are not captured"
    Rows are written by the admin API, the `maintenance_mode` management command, and the
    Django admin. A change made straight through the ORM (`manage.py shell`) has no actor to
    record and leaves no row, so an empty log means "no audited path made this change" — not
    "nothing happened".

---

## Maintenance mode

> **Added in 1.2**

Turning `maintenance_mode` on puts the whole instance into read-only mode, for the duration
of an upgrade or a migration.

```bash
curl -X PATCH https://visiban.example.com/api/v1/admin/settings/ \
  -H "Authorization: Token vbn_…" \
  -H "Content-Type: application/json" \
  -d '{"maintenance_mode": true, "maintenance_message": "Upgrading to 1.2 — back by 14:00 UTC."}'
```

While it is active:

- **Reads keep working.** `GET`, `HEAD`, `OPTIONS` and `TRACE` are never blocked — maintenance
  mode is read-only mode, not an outage.
- **Writes from non-admins are rejected** with `503 Service Unavailable`:

  ```json
  { "code": "maintenance_mode", "detail": "Upgrading to 1.2 — back by 14:00 UTC." }
  ```

  The response carries `Retry-After: 120` so clients back off rather than retry immediately.
  `detail` is the operator's message, or the built-in default when that message is blank.
- **Site admins are exempt** and keep full read/write access, whether they authenticate with a
  session cookie or a personal access token.
- **`GET /api/v1/auth/user/`** reports `maintenance_mode` and `maintenance_message` so a client
  can show the notice. When `maintenance_mode` is `true`, `maintenance_message` is always
  non-empty. Same shape as [`GET /api/v1/auth/me/`](authentication.md#get-apiv1authme) — both
  are served by `CurrentUserSerializer`.

!!! warning "Endpoints that stay writable"
    `/api/v1/admin/`, `/api/v1/auth/login/`, `/api/v1/auth/logout/`, the password reset and
    forced-change endpoints, and `/api/v1/auth/ws-ticket/` continue to accept writes, as do
    `/admin/` and `/api/health/`. The **only** exempt paths under `/accounts/` are the SSO login
    round trip — `/accounts/<provider>/login/` and `/accounts/<provider>/login/callback/` — so a
    signed-out SSO-only admin can still sign back in. Every other `/accounts/` write (signup,
    email management, password change, 3rd-party connect/disconnect) is **not** exempt. These are
    the recovery path: a maintenance mode you cannot switch off is an outage. Self-registration,
    profile updates and token creation are likewise **not** exempt and are blocked like any other
    write.

The state is stored on the `SiteSetting` singleton, so it survives a restart, and the cache is
invalidated on save, so a change reaches every worker immediately rather than after the 60s TTL.

MCP write tools (`create_card`, `move_card`, `update_card`, `archive_card`) are blocked too, and
return `{"error": {"code": "maintenance_mode", "detail": "…"}}`. MCP read tools keep working.

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
