# API Authentication

Visiban supports two authentication methods: **token** (recommended for scripts and API clients) and **session** (used by the browser SPA).

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
    Visiban uses DRF's built-in token auth which requires the prefix `Token`, not `Bearer`.

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

### `GET /api/users/?q=<query>`
Search users by display name, email, or username. Requires authentication. Used internally for @mention autocomplete and the member invite typeahead.

Rate-limited to 120 requests/hour per user.

**Query params**

| Param | Description |
|---|---|
| `q` | Search term (partial match on username, display name, or email) |

**Response** `[{ "id": 5, "username": "alice", "display_name": "Alice Smith", "email": "alice@example.com", "avatar_url": null }, ...]`

---

## OAuth providers

### `GET /api/auth/providers/`
Returns the list of configured OAuth providers. No authentication required. Used by the login page to determine which social login buttons to display.

**Response**
```json
{ "providers": ["google", "github", "gitlab"] }
```

Returns an empty list if no OAuth providers are configured.

---

## Change password

### `POST /api/auth/change-password/`
Change the authenticated user's password. Requires authentication.

**Request**
```json
{ "old_password": "current-password", "new_password1": "new-password", "new_password2": "new-password" }
```

- `new_password1` and `new_password2` must match
- Minimum length and complexity rules apply (Django password validators)
- If `must_change_password` was set, it is cleared on success

**Response** `200 OK` on success; `400 Bad Request` with field errors on failure.

---

## User profile

### `GET /api/auth/me/`
Returns the authenticated user's profile.

**Response fields include:** `id`, `username`, `email`, `first_name`, `last_name`, `display_name`, `avatar_url`, `is_site_admin`, `must_change_password`, `has_usable_password`, `timezone`, `date_format`, `time_format`, `number_locale`, `close_editor_on_enter`, `notif_card_assigned`, `notif_mentioned`, `notif_due_soon`, `notif_card_moved`, `notif_comment_added`, `default_board_id`.

### `PATCH /api/auth/me/`
Update the authenticated user's profile. All fields are optional.

**Writable fields:** `first_name`, `last_name`, `timezone`, `date_format`, `time_format`, `number_locale`, `close_editor_on_enter`, `notif_card_assigned`, `notif_mentioned`, `notif_due_soon`, `notif_card_moved`, `notif_comment_added`, `default_board_id`.

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
| `401 Unauthorized` | Missing or invalid token | Check the `Authorization` header format: `Token <key>` |
| `403 Forbidden` | Valid token but insufficient role | Check the user's role on the board/group |
| `403 Forbidden` (CSRF) | Session auth without CSRF token | Include `X-CSRFToken` header, or switch to token auth |
