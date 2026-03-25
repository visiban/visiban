# API Authentication

Visiban supports two authentication methods: **token** (recommended for scripts and API clients) and **session** (used by the browser SPA).

Token authentication covers two token types that share the same `Authorization: Token <value>` header scheme:

- **Session tokens** — short-lived tokens issued by `POST /api/auth/login/`. Invalidated on logout or password change.
- **Personal Access Tokens (PATs)** — long-lived named tokens created through the API or profile settings. Format: `vbn_` followed by 40 hex characters (44 chars total). Invalidated individually via `DELETE /api/auth/tokens/{id}/`, or all at once when the user's password is changed.

---

## Token authentication

### 1. Obtain a token

Log in to get your API token. The token is permanent until you log out or it is revoked.

!!! note
    The `username` field accepts either a username or an email address. Accounts created via the web registration form have auto-generated usernames (derived from the email address) — the signup form no longer prompts for a username.

=== "curl"
    ```bash
    curl -s -X POST http://localhost:8000/api/auth/login/ \
      -H "Content-Type: application/json" \
      -d '{"username": "admin", "password": "your-password"}' \
      | python3 -m json.tool
    ```

=== "httpie"
    ```bash
    http POST http://localhost:8000/api/auth/login/ \
      username=admin password=your-password
    ```

**Response**
```json
{
  "key": "9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
}
```

Store the `key` value — this is your API token.

---

### 2. Make authenticated requests

Pass the token in the `Authorization` header using the `Token` scheme.

!!! note
    Visiban uses the prefix `Token`, not `Bearer`. This applies to both session tokens and Personal Access Tokens. For PATs the full header looks like:
    `Authorization: Token vbn_a3f2e1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2`

=== "curl"
    ```bash
    # List boards
    curl -s http://localhost:8000/api/boards/ \
      -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" \
      | python3 -m json.tool

    # Get full board state
    curl -s http://localhost:8000/api/boards/1/full/ \
      -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"

    # Create a card (POST with JSON body)
    curl -s -X POST http://localhost:8000/api/boards/1/cards/ \
      -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" \
      -H "Content-Type: application/json" \
      -d '{"title": "Fix bug", "column": 2, "swimlane": 1}'

    # Move a card
    curl -s -X POST http://localhost:8000/api/boards/1/cards/42/move/ \
      -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" \
      -H "Content-Type: application/json" \
      -d '{"column_id": 3, "swimlane_id": 1, "position": 0}'
    ```

=== "httpie"
    ```bash
    # List boards
    http http://localhost:8000/api/boards/ \
      "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"

    # Create a card
    http POST http://localhost:8000/api/boards/1/cards/ \
      "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" \
      title="Fix bug" column:=2 swimlane:=1

    # Move a card
    http POST http://localhost:8000/api/boards/1/cards/42/move/ \
      "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" \
      column_id:=3 swimlane_id:=1 position:=0
    ```

=== "Python"
    ```python
    import requests

    BASE = "http://localhost:8000"
    TOKEN = "9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
    headers = {"Authorization": f"Token {TOKEN}"}

    # List boards
    boards = requests.get(f"{BASE}/api/boards/", headers=headers).json()

    # Move a card
    requests.post(
        f"{BASE}/api/boards/1/cards/42/move/",
        headers=headers,
        json={"column_id": 3, "swimlane_id": 1, "position": 0},
    )
    ```

---

### 3. Log out / invalidate the token

```bash
curl -s -X POST http://localhost:8000/api/auth/logout/ \
  -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
```

This deletes the token server-side. Any further requests with it will receive `401 Unauthorized`.

---

## Personal Access Tokens

Personal Access Tokens (PATs) are named, long-lived tokens tied to a user account. They are intended for scripts, CI pipelines, and third-party integrations where a session login is not practical.

**Token format:** `vbn_` prefix + 40 hex characters, e.g. `vbn_a3f2e1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2`.

The raw token value is shown **once** at creation and never again — Visiban stores only a SHA-256 hash.

All PATs for a user are revoked automatically when that user's password is changed.

---

### `GET /api/auth/tokens/`

List all Personal Access Tokens for the authenticated user.

**Permission:** Requires authentication.

**Response**

```json
[
  {
    "id": 1,
    "name": "CI deploy key",
    "prefix": "vbn_a3f2",
    "created_at": "2026-03-01T09:00:00Z",
    "last_used_at": "2026-03-24T14:22:00Z",
    "expires_at": "2027-03-01T09:00:00Z"
  },
  {
    "id": 2,
    "name": "Local dev",
    "prefix": "vbn_9c1d",
    "created_at": "2026-03-10T11:30:00Z",
    "last_used_at": null,
    "expires_at": null
  }
]
```

The response never includes the raw token value, only the first 8 characters (`prefix`) for identification.

**Response fields**

| Field | Type | Description |
|---|---|---|
| `id` | integer | Unique token ID. Used in `DELETE` requests. |
| `name` | string | Human-readable label given at creation (max 64 chars). |
| `prefix` | string | First 8 characters of the raw token — safe to display. |
| `created_at` | datetime | ISO 8601 UTC timestamp of when the token was created. |
| `last_used_at` | datetime \| null | ISO 8601 UTC timestamp of the most recent authenticated request, or `null` if never used. |
| `expires_at` | datetime \| null | ISO 8601 UTC expiry, or `null` if the token does not expire. |

---

### `POST /api/auth/tokens/`

Create a new Personal Access Token.

**Permission:** Requires authentication. A user may have at most 10 active PATs.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | A label for the token (1–64 characters). |
| `expires_at` | datetime | No | ISO 8601 expiry. Must be in the future and at most 1 year from now. Omit for a non-expiring token. |

```json
{
  "name": "CI deploy key",
  "expires_at": "2027-03-01T09:00:00Z"
}
```

**Response** `201 Created`

The response includes a one-time `token` field containing the raw `vbn_` value. **Store it immediately — it cannot be retrieved again.**

```json
{
  "id": 3,
  "name": "CI deploy key",
  "prefix": "vbn_a3f2",
  "token": "vbn_a3f2e1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  "created_at": "2026-03-24T15:00:00Z",
  "last_used_at": null,
  "expires_at": "2027-03-01T09:00:00Z"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | `name` missing, empty, or longer than 64 characters |
| `400 Bad Request` | `expires_at` is in the past |
| `400 Bad Request` | `expires_at` is more than 1 year from now |
| `400 Bad Request` | User already has 10 active tokens |
| `401 Unauthorized` | Request is not authenticated |

---

### `DELETE /api/auth/tokens/{id}/`

Revoke a Personal Access Token. The token is immediately invalidated and cannot be used for further requests.

**Permission:** Requires authentication. Users can only revoke their own tokens.

**Response** `204 No Content`

**Errors**

| Status | Reason |
|---|---|
| `404 Not Found` | Token does not exist, or belongs to a different user |

!!! note
    A missing token and a token owned by another user both return `404 Not Found` — not `403 Forbidden`. This prevents user enumeration (IDOR prevention).

---

## Session authentication

The browser SPA uses cookie-based sessions. CSRF protection is enforced — every mutating request (`POST`, `PATCH`, `PUT`, `DELETE`) must include the `X-CSRFToken` header.

This method is not recommended for scripts. Use token auth for all non-browser clients.

=== "curl"
    ```bash
    # Step 1 — log in and save cookies + extract CSRF token
    curl -s -c cookies.txt -X POST http://localhost:8000/api/auth/login/ \
      -H "Content-Type: application/json" \
      -d '{"username": "admin", "password": "your-password"}'

    CSRF=$(grep csrftoken cookies.txt | awk '{print $7}')

    # Step 2 — use session cookie + CSRF token for mutating requests
    curl -s -b cookies.txt \
      -H "X-CSRFToken: $CSRF" \
      -H "Content-Type: application/json" \
      -X POST http://localhost:8000/api/boards/ \
      -d '{"name": "My Board"}'
    ```

---

## User search

### `GET /api/users/?search=<query>`
Search users by display name, email, or username. Requires authentication. Used internally for @mention autocomplete and the member invite typeahead.

Rate-limited to 30 requests/minute per user.

**Query params**

| Param | Description |
|---|---|
| `search` | Search term — minimum 2 characters; partial match on username, display name, email, or first name. Returns `[]` for shorter queries. |

**Response** `[{ "id": 5, "username": "alice", "display_name": "Alice Smith", "avatar_url": null }, ...]`

> Results include `id`, `username`, `display_name`, and `avatar_url` only — the full user profile (including email) is not returned by this endpoint.

---

## OAuth providers

### `GET /api/auth/providers/`
Returns the list of configured OAuth providers. No authentication required. Used by the login page to determine which social login buttons to display.

**Response**
```json
{ "google": true, "github": false, "gitlab": true }
```

Each key is `true` if the provider is configured on this instance, `false` otherwise.

---

## Change password

### `POST /api/auth/change-password/`
Change the authenticated user's password. Requires authentication.

**Request**
```json
{ "current_password": "current-password", "new_password": "new-password" }
```

- `current_password` is not required for social-only accounts (accounts with no usable password that are setting a password for the first time)
- Minimum 12 characters; standard Django complexity rules apply
- If `must_change_password` was set, it is cleared on success

**Response** `200 OK` on success; `400 Bad Request` with field errors on failure.

---

## User profile

### `GET /api/auth/me/`
Returns the authenticated user's profile.

**Response fields include:** `id`, `username`, `email`, `first_name`, `last_name`, `display_name`, `avatar_url`, `is_site_admin`, `can_access_all_content`, `uploads_enabled`, `must_change_password`, `has_usable_password`, `timezone`, `date_format`, `time_format`, `number_locale`, `close_editor_on_enter`, `notif_card_assigned`, `notif_mentioned`, `notif_due_soon`, `notif_card_moved`, `notif_comment_added`, `default_board_id`.

| Field | Type | Description |
|---|---|---|
| `is_site_admin` | boolean | Whether the user can access the `/admin` admin panel and admin API. |
| `can_access_all_content` | boolean | Whether the user has read/write access to every board and group regardless of membership. Independent of `is_site_admin` as of 1.0.0-rc.9 — see [Site Admins](../administration/site-admins.md). |
| `uploads_enabled` | boolean | Instance-wide setting reflecting whether file attachment uploads are currently permitted. When `false`, the attachment UI is hidden and upload attempts return `403`. |

### `PATCH /api/auth/me/`
Update the authenticated user's profile. All fields are optional.

**Writable fields:** `first_name`, `last_name`, `display_name`, `timezone`, `date_format`, `time_format`, `number_locale`, `close_editor_on_enter`, `notif_card_assigned`, `notif_mentioned`, `notif_due_soon`, `notif_card_moved`, `notif_comment_added`, `default_board_id`.

**`default_board_id`** — set the board to redirect to after login. Accepts a board `id` (integer) or `null` to clear. The value must be a board the requesting user is a member of; supplying a foreign board ID returns `400 Bad Request`. This prevents enumeration of boards the user has no access to.

```json
PATCH /api/auth/me/
{ "default_board_id": 5 }
```

---

## Site configuration

### `GET /api/auth/site-config/`
Returns site-level configuration. This endpoint is public — no authentication required.

**Response**
```json
{
  "registration_open": true,
  "registration_mode": "open"
}
```

| Field | Type | Values | Description |
|---|---|---|---|
| `registration_open` | boolean | `true` / `false` | Whether new user registration is currently allowed |
| `registration_mode` | string | `"open"` / `"invite_only"` / `"closed"` | The configured registration policy |

Site admins can change the registration mode in **Admin → Site Settings**. See [Site Admins](../administration/site-admins.md).

---

## Common errors

| Status | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Missing or invalid token | Check the `Authorization` header format: `Token <key>`. For PATs, ensure the full `vbn_...` value is used. |
| `403 Forbidden` | Valid token but insufficient role | Check the user's role on the board/group |
| `403 Forbidden` (CSRF) | Session auth without CSRF token | Include `X-CSRFToken` header, or switch to token auth |
| `404 Not Found` (PAT delete) | Token ID not found or belongs to another user | Verify the token ID from `GET /api/auth/tokens/` |
