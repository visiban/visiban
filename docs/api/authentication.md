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

## Common errors

| Status | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Missing or invalid token | Check the `Authorization` header format: `Token <key>` |
| `403 Forbidden` | Valid token but insufficient role | Check the user's role on the board/group |
| `403 Forbidden` (CSRF) | Session auth without CSRF token | Include `X-CSRFToken` header, or switch to token auth |
