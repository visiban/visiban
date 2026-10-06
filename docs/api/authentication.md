# API Authentication

Visiban supports two authentication methods: **token** (recommended for scripts and API clients) and **session** (used by the browser SPA).

Token authentication covers two token types that share the same `Authorization: Token <value>` header scheme:

- **Session tokens** — short-lived tokens issued by `POST /api/v1/auth/login/`. Invalidated on logout or password change.
- **Personal Access Tokens (PATs)** — long-lived named tokens created through the API or profile settings. Format: `vbn_` followed by 40 hex characters (44 chars total). Invalidated individually via `DELETE /api/v1/auth/tokens/{id}/`, or all at once when the user's password is changed.

---

## Token authentication

### 1. Obtain a token

> **Changed in 1.2** (#1206) — the `username` field (and the optional `email` field) now also accepts an account's email address; earlier releases accepted the exact-case username only.

Log in to get your API token. The token is permanent until you log out or it is revoked.

!!! note
    The `username` field takes either the account's exact-case username **or** its email address (matched case-insensitively). An optional `email` field is also accepted in place of `username`.

    - A username always wins: if the value is some account's username (usernames may contain `@`), it logs in as that account, never as another account whose email happens to match.
    - An email address shared by more than one active account logs into **none** of them — it fails with the same generic error as a wrong password. Those users can still log in by username. Deactivated accounts don't count toward the match.
    - Failed attempts by username and by email count toward one lockout for the account. A deliberate consequence: someone who already knows an account's username and has locked it out can tell whether a candidate email belongs to that same account, because it gets the "Too many failed login attempts" error instead of the generic one. This is the accepted cost of not letting an attacker double their guesses by switching identifiers, and it is still bounded by the per-IP rate.
    - Accounts created via the web registration form have auto-generated usernames (derived from the email address); either identifier works for them.
    - Usernames and emails are cross-checked so one account can't switch off another's email login (**changed in 1.2**, #1221). A new or changed username can't equal another active account's email, and a new or changed email can't equal another active account's email or any account's username (all compared ignoring case and surrounding spaces). This applies to registration, [`PATCH /api/v1/auth/me/`](#patch-apiv1authme), `POST /api/v1/auth/choose-username/`, and admin-created accounts. Only a *change* is checked, so an account that already collides from before 1.2 can still save the rest of its profile. Social/SSO signup whose IdP username collides gets a generated username instead of an error. With `EMAIL_VERIFICATION=mandatory`, a profile email change is checked when it's confirmed rather than when it's requested, so the request itself doesn't reveal whether an address is in use. A colliding confirmation answers `409` (`email_in_use`) and the email isn't changed. Rows that still collide, from before 1.2 or created outside the API, keep the rules above: the username wins, and a shared email logs into none of them.

=== "curl"
    ```bash
    curl -s -X POST http://localhost:8000/api/v1/auth/login/ \
      -H "Content-Type: application/json" \
      -d '{"username": "admin", "password": "your-password"}' \
      | python3 -m json.tool
    ```

=== "httpie"
    ```bash
    http POST http://localhost:8000/api/v1/auth/login/ \
      username=admin password=your-password
    ```

**Response**
```json
{
  "key": "9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
}
```

Store the `key` value — this is your API token.

**Errors**

| Status | Cause |
|---|---|
| `400 Bad Request` | Wrong username/email or password — `{"non_field_errors": ["Unable to log in with provided credentials."]}`. The response is identical whether the identifier is unknown, ambiguous, or the password is wrong. |
| `400 Bad Request` | Locked out — either the per-account rate (5 failed attempts / 5 min for that account — failures by username and by email count together toward the same account's lockout, and a lockout tripped through one identifier blocks the other) or the per-IP rate (10 failed attempts / min from that IP, across ANY accounts) tripped; both return the same `{"non_field_errors": ["Too many failed login attempts. Try again later."]}` and there's no way to tell which from the response (see [Rate limiting](../architecture/deployment.md#rate-limiting)). The correct password is refused too while either is active — including for an account that never itself failed, if it shares an IP (e.g. behind a NAT) with one that tripped the per-IP rate. The **per-account** lockout now has two early-recovery paths (#1203): a successful password reset clears it automatically, or a site admin can clear it directly via `POST /api/v1/admin/users/{id}/clear-lockout/` (see [Admin API](admin.md)). The **per-IP** rate has no early-recovery path and none is planned — clearing it on demand would undermine the protection it exists for (it is shared across every account attempted from that IP, so clearing it for one account's benefit would clear it for all of them). |
| `429 Too Many Requests` | Per-IP request-volume ceiling exceeded (`LoginRateThrottle`, 20/hour — a separate DRF throttle, independent of the two `login_failed` lockouts above) |

---

### 2. Make authenticated requests

Pass the token in the `Authorization` header using the `Token` scheme.

!!! note
    Visiban uses the prefix `Token`, not `Bearer`. This applies to both session tokens and Personal Access Tokens. For PATs the full header looks like:
    `Authorization: Token vbn_0123456789abcdef0123456789abcdef01234567`

    The one exception is the [MCP server](mcp.md) at `/mcp`, which requires the `Bearer` scheme because the Model Context Protocol specification mandates it. The two schemes are scoped to their own transports and are not interchangeable, but they resolve the same Personal Access Token records — revoking a token revokes it for both.

=== "curl"
    ```bash
    # List boards
    curl -s http://localhost:8000/api/v1/boards/ \
      -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" \
      | python3 -m json.tool

    # Get full board state
    curl -s http://localhost:8000/api/v1/boards/1/full/ \
      -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"

    # Create a card (POST with JSON body)
    curl -s -X POST http://localhost:8000/api/v1/boards/1/cards/ \
      -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" \
      -H "Content-Type: application/json" \
      -d '{"title": "Fix bug", "column": 2, "swimlane": 1}'

    # Move a card
    curl -s -X POST http://localhost:8000/api/v1/boards/1/cards/42/move/ \
      -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" \
      -H "Content-Type: application/json" \
      -d '{"column_id": 3, "swimlane_id": 1, "position": 0}'
    ```

=== "httpie"
    ```bash
    # List boards
    http http://localhost:8000/api/v1/boards/ \
      "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"

    # Create a card
    http POST http://localhost:8000/api/v1/boards/1/cards/ \
      "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" \
      title="Fix bug" column:=2 swimlane:=1

    # Move a card
    http POST http://localhost:8000/api/v1/boards/1/cards/42/move/ \
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
    boards = requests.get(f"{BASE}/api/v1/boards/", headers=headers).json()

    # Move a card
    requests.post(
        f"{BASE}/api/v1/boards/1/cards/42/move/",
        headers=headers,
        json={"column_id": 3, "swimlane_id": 1, "position": 0},
    )
    ```

---

### 3. Log out / invalidate the token

```bash
curl -s -X POST http://localhost:8000/api/v1/auth/logout/ \
  -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
```

This deletes the token server-side. Any further requests with it will receive `401 Unauthorized`.

---

## Personal Access Tokens

Personal Access Tokens (PATs) are named, long-lived tokens tied to a user account. They are intended for scripts, CI pipelines, and third-party integrations where a session login is not practical.

**Token format:** `vbn_` prefix + 40 hex characters, e.g. `vbn_0123456789abcdef0123456789abcdef01234567`.

The raw token value is shown **once** at creation and never again — Visiban stores only a SHA-256 hash.

All PATs for a user are revoked automatically when that user's password is changed.

---

### `GET /api/v1/auth/tokens/`

List all Personal Access Tokens for the authenticated user.

**Permission:** Requires authentication.

**Response**

```json
[
  {
    "id": 1,
    "name": "CI deploy key",
    "prefix": "vbn_0123",
    "created_at": "2026-03-01T09:00:00Z",
    "last_used_at": "2026-03-24T14:22:00Z",
    "expires_at": "2027-03-01T09:00:00Z",
    "scopes": ["read", "write"]
  },
  {
    "id": 2,
    "name": "Local dev",
    "prefix": "vbn_9c1d",
    "created_at": "2026-03-10T11:30:00Z",
    "last_used_at": null,
    "expires_at": null,
    "scopes": null
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
| `scopes` | string[] \| null | The scopes this token carries. `null` for a token created before 1.2 — see [Scopes](#scopes) below. Added in 1.2. |

---

### `POST /api/v1/auth/tokens/`

Create a new Personal Access Token.

**Permission:** Requires authentication. A user may have at most 10 active PATs.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | A label for the token (1–64 characters). |
| `expires_at` | datetime | No | ISO 8601 expiry. Must be in the future and at most 1 year from now. Omit for a non-expiring token. |
| `scopes` | string[] | No | Scopes to grant. Must be a non-empty subset of `read`, `write`, `admin`, `mcp:read`, `mcp:write`. Defaults to `["read", "write"]` when omitted. Added in 1.2. |

```json
{
  "name": "CI deploy key",
  "expires_at": "2027-03-01T09:00:00Z",
  "scopes": ["read", "write"]
}
```

**Response** `201 Created`

The response includes a one-time `token` field containing the raw `vbn_` value. **Store it immediately — it cannot be retrieved again.**

```json
{
  "id": 3,
  "name": "CI deploy key",
  "prefix": "vbn_0123",
  "token": "vbn_0123456789abcdef0123456789abcdef01234567",
  "created_at": "2026-03-24T15:00:00Z",
  "last_used_at": null,
  "expires_at": "2027-03-01T09:00:00Z",
  "scopes": ["read", "write"]
}
```

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | `name` missing, empty, or longer than 64 characters |
| `400 Bad Request` | `expires_at` is in the past |
| `400 Bad Request` | `expires_at` is more than 1 year from now |
| `400 Bad Request` | User already has 10 active tokens |
| `400 Bad Request` | `scopes` contains an unrecognized value, or is an empty list |
| `401 Unauthorized` | Request is not authenticated |
| `403 Forbidden` | The request was authenticated with a *scoped* PAT — scoped tokens cannot create tokens (see [Scopes](#scopes)) |

---

### `POST /api/v1/auth/ws-ticket/`

Mint a short-lived, single-use ticket for a WebSocket handshake. Added in 1.2.

WebSocket upgrades cannot carry an `Authorization` header from a browser, and the session cookie is `SameSite=Lax` so it is not sent cross-origin. Token-authenticated clients — native, CLI, or a front end on another origin — use this endpoint to exchange the credential they already hold for a one-shot ticket, then pass it as the `ticket` query parameter on the upgrade. See [WebSocket API → Ticket authentication](websockets.md#ticket-authentication-since-12).

**Permission:** Requires authentication. Accepts any supported credential — PAT, session token, or session cookie.

A *scoped* PAT must hold `write`: minting a ticket is a `POST`, and the scope baseline is resolved from the path and method (see [Scopes](#scopes)). A `read`-only token therefore cannot open a WebSocket. Legacy tokens (created before 1.2, `scopes` unset) keep full authority here as everywhere else.

**Request body:** none.

**Response** `201 Created`

The `ticket` is returned here and never again.

```json
{
  "ticket": "sW9qL2v8dYb1rKp4mNx7cT0zQe3fA6hJ5uV8iO1lP2g",
  "expires_at": "2026-09-14T10:15:30Z"
}
```

| Field | Type | Description |
|---|---|---|
| `ticket` | string | The credential to pass as `?ticket=` on the WebSocket upgrade. Single use. |
| `expires_at` | datetime | ISO 8601. 30 seconds after issuance. |

The ticket authenticates only — board and group membership is still enforced on every connection, so a ticket belonging to a non-member is closed with `4003`.

A ticket cannot be revoked once issued: logging out, or deleting the PAT it was obtained with, does not invalidate an outstanding ticket. It remains valid until it is spent or its 30 seconds elapse. The short TTL is what bounds this, and it is a deliberate trade-off for keeping the handshake a single cache lookup.

**Errors**

| Status | Reason |
|---|---|
| `401 Unauthorized` | Request is not authenticated |
| `403 Forbidden` | The request was authenticated with a scoped PAT that does not hold `write` |
| `405 Method Not Allowed` | Any method other than `POST` |
| `429 Too Many Requests` | Per-user rate limit exceeded (60/minute in production) — back off rather than retrying immediately |

---

### `DELETE /api/v1/auth/tokens/{id}/`

Revoke a Personal Access Token. The token is immediately invalidated and cannot be used for further requests.

**Permission:** Requires authentication. Users can only revoke their own tokens.

**Response** `204 No Content`

**Errors**

| Status | Reason |
|---|---|
| `403 Forbidden` | The request was authenticated with a *scoped* PAT — scoped tokens cannot revoke tokens |
| `404 Not Found` | Token does not exist, or belongs to a different user |

!!! note
    A missing token and a token owned by another user both return `404 Not Found` — not `403 Forbidden`. This prevents user enumeration (IDOR prevention).

---

## Scopes

> **Added in 1.2**

Every Personal Access Token created from 1.2 onward carries an explicit list of scopes. A request is authorized only if the token holds **every** scope that request requires.

| Scope | Required for |
|---|---|
| `read` | Any `GET`, `HEAD` or `OPTIONS` request to the REST API |
| `write` | Any `POST`, `PUT`, `PATCH` or `DELETE` request to the REST API |
| `admin` | Any request to `/api/v1/admin/*`, **in addition to** the verb scope above |
| `mcp:read` | Any request to the MCP transport at `/mcp` (see [MCP server](mcp.md)) |
| `mcp:write` | Required, **in addition to** `mcp:read`, to call an MCP write tool (`create_card`, `move_card`, `update_card`, `archive_card`) |

### Non-hierarchical by design

No scope implies any other. Concretely:

- `admin` does not grant `read` or `write`
- `write` does not grant `read`
- neither `read` nor `write` grants `mcp:read`
- `mcp:read` does not grant `mcp:write`

Requirements **compose**. `GET /api/v1/admin/settings/` requires `{admin, read}`; `PATCH /api/v1/admin/settings/` requires `{admin, write}`.

```bash
# Fails with 403 — the token has `admin` but the request is also a read.
curl -s https://your-instance.example.com/api/v1/admin/settings/ \
  -H "Authorization: Token vbn_admin_scope_only"
# {"detail": "This token is missing the required scope: read."}
```

### Resolution order

For a request authenticated with a PAT:

1. If the token has **no scopes recorded** (`scopes: null` — created before 1.2), it is allowed anywhere on the REST API, exactly as before 1.2. It is refused by `/mcp`.
2. If the token's scope list is **empty** (`[]`), every request is refused. An empty list is an explicit grant of nothing, not a wildcard.
3. Otherwise the token must hold every scope the endpoint requires, per the table above.

### Error semantics

A scope failure is **`403 Forbidden`**, never `401 Unauthorized`. The credential is valid; only its authority is insufficient, and no amount of re-authenticating will change that. Clients should not retry a `403` with fresh credentials.

The `detail` message names the scope that was missing. It never echoes the scopes the token actually holds.

### Tokens cannot mint tokens

A scoped token cannot call `POST /api/v1/auth/tokens/` or `DELETE /api/v1/auth/tokens/{id}/`. If it could, a `read`-only token could issue itself an `admin` one and the scope model would mean nothing. A scoped token **may** list tokens (`GET`) if it holds `read`.

Tokens created before 1.2 retain the old behavior here and can still mint and revoke.

### Scopes never widen access

A scope can only narrow what a token may do. Board membership, role, and site-administrator checks all still apply. An `admin`-scoped token on an account that is not a site administrator reaches no admin endpoint.

---

## Session authentication

The browser SPA uses cookie-based sessions. CSRF protection is enforced — every mutating request (`POST`, `PATCH`, `PUT`, `DELETE`) must include the `X-CSRFToken` header.

This method is not recommended for scripts. Use token auth for all non-browser clients.

=== "curl"
    ```bash
    # Step 1 — log in and save cookies + extract CSRF token
    curl -s -c cookies.txt -X POST http://localhost:8000/api/v1/auth/login/ \
      -H "Content-Type: application/json" \
      -d '{"username": "admin", "password": "your-password"}'

    CSRF=$(grep csrftoken cookies.txt | awk '{print $7}')

    # Step 2 — use session cookie + CSRF token for mutating requests
    curl -s -b cookies.txt \
      -H "X-CSRFToken: $CSRF" \
      -H "Content-Type: application/json" \
      -X POST http://localhost:8000/api/v1/boards/ \
      -d '{"name": "My Board"}'
    ```

---

## User search

### `GET /api/v1/users/?search=<query>`
Search users by display name, username, or first name. Requires authentication. Excludes the requesting user from results. Used internally for @mention autocomplete and the member invite typeahead.

> **Note:** Email is intentionally excluded from the search criteria. Filtering on email without returning it would allow any authenticated caller to silently confirm whether a given email address exists on the instance. Search is limited to username, display name, and first name only.

Rate-limited to 30 requests/minute per user.

**Query params**

| Param | Description |
|---|---|
| `search` | Search term — minimum 2 characters; partial match on username, display name, and first name. Returns `[]` for shorter queries. |

**Response** `[{ "id": 5, "username": "alice", "display_name": "Alice Smith", "avatar_url": null }, ...]`

> Results include `id`, `username`, `display_name`, and `avatar_url` only — the full user profile (including email) is not returned by this endpoint.

---

## OAuth providers

### `GET /api/v1/auth/providers/`
Returns the list of configured OAuth providers. No authentication required. Used by the login page to determine which social login buttons to display.

**Response**
```json
{
  "google": true,
  "github": false,
  "gitlab": true,
  "oidc": true,
  "oidc_name": "Okta"
}
```

- `google`, `github`, `gitlab` — `true` if the respective OAuth provider is configured on this instance, `false` otherwise.
- `oidc` — `true` if a generic OIDC provider is configured.
- `oidc_name` — display name for the SSO button (e.g. `"Okta"`), or `null` when `oidc` is `false`.

### Auth error redirects

A failed OAuth (or invite-gated registration) flow redirects the browser back to the frontend with an `?auth_error=<code>` query parameter instead of rendering anything server-side. The SPA's login page reads this parameter and shows a message, then strips it from the URL.

| Code | Meaning |
|---|---|
| `invite_required` | Invite-only mode is enabled and no invite token was present. Also sent for any visit or form submission at `/accounts/signup/` in invite-only mode (#1324), since an invite link is the only way to register. |
| `invite_invalid` | The invite token is malformed or unknown — or *(1.2+)* a group or board invite that is used, revoked, or whose sender can no longer admit new accounts. |
| `invite_expired` | The invite token has expired. |
| `invite_not_for_registration` | **Added in 1.2** (#1445, #1444) — in invite-only mode, the invite token is a group or board invite that cannot create accounts: a shareable group link, or an emailed group or board invite whose sender is not a site admin. Only site invites and emailed single-use group or board invites sent by a site admin can create an account. |
| `signup_closed` | Registration is closed for this instance. Emitted when an OAuth signup attempt (#1323), or a visit or form submission at `/accounts/signup/` (#1324), is made while registration mode is `CLOSED` — redirects to the frontend instead of rendering allauth's stock `signup_closed.html` template. |
| `oauth_failed` | **Added in 1.2** (#1321) — generic fallback for an OAuth signup that could not complete automatically: the provider's email collided with an existing account, or the provider returned no email at all (e.g. GitHub with a private email, since email is a required signup field). Both cases previously fell through to allauth's own unstyled HTML signup form at `accounts/3rdparty/signup/` — which pre-filled the colliding email in an editable field, allowing a second account to be created under a different one. That view is now overridden to redirect here instead. Since #1314, an email collision with an *active* account gets `account_exists` / `account_exists_provider` instead; `oauth_failed` remains for a missing email and for a collision with a deactivated account (never revealed as such). |
| `account_exists` | **Added in 1.2** (#1314) — the provider's email (compared ignoring case only) already belongs to an active account. Also carries `provider=<id>`, the provider that was tried. The user signs in normally, then is offered to connect `provider` (see `pending_connect_provider`). Takes priority over the `invite_*` codes and over closed registration. |
| `account_exists_provider` | **Added in 1.2** (#1314) — as `account_exists`, but the account has no password and signs in with another provider, named by `via=<id>`. Only sent when the provider verified the email and exactly one account matches; otherwise `account_exists` is sent. |

A connect round trip (see [Connected accounts](#connected-accounts)) reports back to the SPA's `/settings` page instead: `?connected=<provider>` on success, `?connect_error=provider_already_connected&provider=<provider>` when that provider identity is already connected to a different account, or `?connect_error=connect_identity_mismatch&provider=<provider>` when a connect for a provider with a pending prompt comes back with a different provider account than the one that tried to sign in (nothing is connected, and the prompt is cleared).

---

## Forgot password

### `POST /api/v1/auth/password/reset/`
Request a password reset email. **No authentication required.**

**Request**
```json
{ "email": "user@example.com" }
```

- The response is always `200 OK` regardless of whether the email matches a registered account — this prevents user enumeration.
- If the email belongs to an account with a usable password, a reset link is emailed. The link points to the frontend route `/reset-password/{uid}/{token}`.
- If the email belongs to an **OAuth-only** account (no password set) and the address is verified on that account, the same reset link is emailed; confirming it sets the account's first password. *Changed in 1.2 (#1314).*
- For an OAuth-only account, the link is valid only while **the address it was sent to** is still verified on the account. If that address has since been unverified or removed, `POST /api/v1/auth/password/reset/confirm/` refuses the link with `400 {"token": ["Invalid value"]}` and no password is set — even if another address on the account is verified. Any change to which of the account's addresses are verified voids its outstanding links; request a new one. Links for accounts that already have a password are unaffected. allauth's own pages at `/accounts/password/reset/` and `/accounts/password/reset/key/<uid>-<token>/` apply the same rules. *Changed in 1.2 (#1337).*
- If the email belongs to an OAuth-only account whose address was never verified, an alternate email is sent directing the user back to their OAuth provider instead, and no reset token is issued.
- **Rate limited** — 5 requests per hour per IP in production (unlimited in debug mode). Exceeding the limit returns `429 Too Many Requests`.

**Response** `200 OK { "detail": "Password reset e-mail has been sent." }`

---

### `POST /api/v1/auth/password/reset/confirm/`
Set a new password using the token from the reset email. **No authentication required.**

**Request**
```json
{
  "uid": "MQ",
  "token": "abc123-...",
  "new_password1": "newsecurepassword",
  "new_password2": "newsecurepassword"
}
```

| Field | Description |
|---|---|
| `uid` | Base64-encoded user PK from the reset link URL |
| `token` | One-time token from the reset link URL |
| `new_password1` | The new password (minimum 12 characters) |
| `new_password2` | Confirmation — must match `new_password1` |

**Response** `200 OK { "detail": "Password has been reset with the new password." }` on success; `400 Bad Request` on invalid/expired token or mismatched passwords.

!!! note
    Session tokens issued by `POST /api/v1/auth/login/` are invalidated on the next login with the new password. Personal Access Tokens (PATs) are **not** automatically revoked by a password reset — use `DELETE /api/v1/auth/tokens/{id}/` to revoke individual PATs, or change the password via `POST /api/v1/auth/change-password/` (which does revoke all PATs).

---

## Change password

### `POST /api/v1/auth/change-password/`
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

### `POST /api/v1/auth/password/change/`

dj-rest-auth's password-change endpoint. Requires authentication (session or
token). It is a **distinct URL and request shape** from
`POST /api/v1/auth/change-password/` above — the two are not aliases and do
not accept the same body — but since 1.2 they enforce the same rules.

**Request**
```json
{
  "old_password": "current-password",
  "new_password1": "new-password",
  "new_password2": "new-password"
}
```

| Field | Required | Description |
|---|---|---|
| `old_password` | Yes (see below) | The account's current password. |
| `new_password1` | Yes | The new password — minimum 12 characters, plus the standard `AUTH_PASSWORD_VALIDATORS` checks (not too similar to the user's other profile fields, not a common password, not entirely numeric). |
| `new_password2` | Yes | Must match `new_password1`. |

!!! warning "Changed in 1.2: `old_password` is now required"
    Before 1.2 this endpoint did not check the current password at all — any
    authenticated caller, including one holding only a Personal Access Token,
    could change the account's password without knowing it (#1257). It now
    requires `old_password` and returns `400` if it is missing or wrong, exactly
    as `/auth/change-password/` does with `current_password`. This is a
    deliberate, security-driven exception to the rule that new request fields
    are optional: an integration that omits `old_password` must be updated to
    send it. Social-only accounts (no usable password yet) may still omit it to
    set their first password, matching `/auth/change-password/`.

- **Minimum 12 characters** (changed in 1.2, #1258). Previously this endpoint
  accepted 8, Django's default. The minimum now comes from the instance-wide
  password policy, so it matches every other password-set path.
- The current session is kept alive after the change (same as
  `/auth/change-password/`) — the caller is not logged out.
- All of the user's Personal Access Tokens are revoked on success, same as
  `/auth/change-password/` — see [Personal Access Tokens](#personal-access-tokens)
  above.
- **Clears `must_change_password` on success** (changed in 1.2, #1259), same
  as `/auth/change-password/`. Either endpoint satisfies a forced password
  change.

**Response** `200 OK { "detail": "New password has been saved." }` on success.

Validation errors use DRF's per-field shape, not `/auth/change-password/`'s
`{"detail": ...}` shape:
```json
{ "old_password": ["Your old password was entered incorrectly. Please enter it again."] }
```
```json
{ "new_password2": ["This password is too short. It must contain at least 12 characters."] }
```

| Status | Reason |
|---|---|
| `400 Bad Request` | `old_password` missing or incorrect; `new_password1` / `new_password2` missing, mismatched, or failing an `AUTH_PASSWORD_VALIDATORS` check |
| `401 Unauthorized` | Request is not authenticated |

!!! note
    Prefer `POST /api/v1/auth/change-password/` for anything user-facing — the
    SPA uses it, and its single-sentence `{"detail": ...}` errors are simpler to
    display. This endpoint is kept for clients that discover it from the OpenAPI
    schema; since 1.2 it is equally safe to use.

---

## Choose username

### `POST /api/v1/auth/choose-username/`
Set a new username for the authenticated user. This endpoint is only relevant
when `must_change_username` is `true` — the user's previous username was
auto-generated by allauth and collided (case-insensitively) with another
account during the uniqueness enforcement migration.

**Request**
```json
{ "username": "desired-username" }
```

- Username must be 1-150 characters; only letters, digits, and `@/./ +/-/_`
- Uniqueness is checked case-insensitively (`iexact`), and since 1.2 (#1221) the username also can't be another active account's email address. Both failures return the same `"That username is already taken."`
- On success, `must_change_username` is cleared

**Response** `200 OK` with the updated user object on success; `400 Bad Request` with `detail` on failure.

!!! note
    This endpoint's response uses the base user serializer, not `CurrentUserSerializer` — it omits `uploads_enabled`, `git_lens_enabled`, `maintenance_mode`, and the other instance-config fields documented under [User profile](#user-profile) below. Re-fetch `GET /api/v1/auth/me/` if you need those.

**Error codes** — the `403` response when `must_change_username` blocks a
normal endpoint includes `"code": "must_change_username"` so API/PAT clients
can detect the condition and call this endpoint programmatically.

---

## User profile

### `GET /api/v1/auth/me/`
Returns the authenticated user's profile.

!!! note
    `GET /api/v1/auth/user/` (dj-rest-auth's built-in endpoint, and the one the bundled SPA
    actually bootstraps from) returns the identical shape — both are served by
    `CurrentUserSerializer`. This section documents the fields once, under `/auth/me/`.

**Permission:** Requires authentication.

**Response fields include:** `id`, `username`, `email`, `first_name`, `last_name`, `display_name`, `avatar_url`, `is_site_admin`, `can_access_all_content`, `uploads_enabled`, `git_lens_enabled`, `maintenance_mode`, `maintenance_message`, `demo_mode`, `demo_next_reset_at`, `must_change_password`, `must_change_username`, `has_usable_password`, `has_completed_tour`, `timezone`, `date_format`, `time_format`, `number_locale`, `close_editor_on_enter`, `notif_card_assigned`, `notif_mentioned`, `notif_due_soon`, `notif_card_moved`, `notif_comment_added`, `notif_board_invite`, `notif_stale`, `email_notif_card_assigned`, `email_notif_mentioned`, `email_notif_due_soon`, `email_notif_card_moved`, `email_notif_comment_added`, `default_board_id`, `theme`, `pending_email`, `pending_connect_provider`, `pending_connect_identity`.

| Field | Type | Description |
|---|---|---|
| `is_site_admin` | boolean | Whether the user can access the `/admin` admin panel and admin API. |
| `can_access_all_content` | boolean | Whether the user has read/write access to every board and group regardless of membership. Independent of `is_site_admin` — see [Site Admins](../administration/site-admins.md). |
| `uploads_enabled` | boolean | Instance-wide setting reflecting whether file attachment uploads are currently permitted. When `false`, the attachment UI is hidden and upload attempts return `403`. |
| `git_lens_enabled` | boolean | Instance-wide setting reflecting whether the [Issue Board Lens](../features/issue-board-lens.md) is enabled (`GIT_LENS_ENABLED`). When `false`, the SPA hides the Lens tab, board settings, and related API surface entirely. Read-only. Added in 1.2. |
| `maintenance_mode` | boolean | Instance-wide setting reflecting whether the instance is in read-only maintenance mode. When `true`, non-admin writes return `503` — see [Maintenance mode](admin.md#maintenance-mode). Read-only. Added in 1.2. |
| `maintenance_message` | string | The notice to show while `maintenance_mode` is `true`. Always non-empty in that case (the server substitutes a built-in default for a blank operator message), and `""` otherwise. Plain text — render it as text, never as HTML. Read-only. Added in 1.2. |
| `demo_mode` | boolean | Whether the instance is a public hosted demo (`DEMO_MODE`). When `true`, unsafe requests outside a small allowlist return `403` with `code: "demo_read_only"` — see [Hosted demo instance](../administration/demo-data.md#hosted-demo-instance). Read-only. Added in 1.2. |
| `demo_next_reset_at` | string (ISO 8601 UTC) or null | The next scheduled demo reset, computed server-side from `DEMO_RESET_SCHEDULE`. `null` unless `demo_mode` is `true`. Read-only. Added in 1.2. |
| `pending_email` | string or null | An email change that is waiting for confirmation, or `null`. Only set on instances with `EMAIL_VERIFICATION=mandatory` — see [`PATCH /api/v1/auth/me/`](#patch-apiv1authme). While it is set, `email` still holds the current address. Read-only. Added in 1.2. |
| `pending_connect_provider` | string or null | A provider this session tried to sign in with whose email matched this account (see `account_exists` under [Auth error redirects](#auth-error-redirects)), or `null`. While set, the SPA offers once to connect it. Expires after 10 minutes, and is cleared by [`DELETE /api/v1/auth/me/pending-connect/`](#delete-apiv1authmepending-connect), by any connect attempt for that provider, or once the provider is connected. Only reported to the account(s) the attempt matched: a sign-in by any other account in the same browser, or a sign-out, discards it. Read-only. Added in 1.2 (#1314). |
| `pending_connect_identity` | string or null | How the provider names the account that tried — its username where it has one, else its email — so the SPA's prompt can show which account it would connect. `null` whenever `pending_connect_provider` is. Read-only. Added in 1.2 (#1314). |
| `theme` | string | The user's preferred color scheme. One of `"system"`, `"dark"`, or `"light"`. Defaults to `"system"`. |
| `notif_stale` | boolean | Receive an in-app notification when a card you own has not moved within the board's staleness window. Defaults to `false`. Writable. Added in 1.2 (previously gated on `notif_due_soon`). |
| `email_notif_card_assigned` | boolean | Also email the user when a card is assigned to them. No effect while `notif_card_assigned` is `false`. Defaults to `false`. Writable. Added in 1.2. |
| `email_notif_mentioned` | boolean | Also email the user when they are @mentioned. No effect while `notif_mentioned` is `false`. Defaults to `false`. Writable. Added in 1.2. |
| `email_notif_due_soon` | boolean | Also email the user when a card they own is due within 24 hours. No effect while `notif_due_soon` is `false`. Defaults to `false`. Writable. Added in 1.2. |
| `email_notif_card_moved` | boolean | Also email the user when a card they own is moved. No effect while `notif_card_moved` is `false`. Defaults to `false`. Writable. Added in 1.2. |
| `email_notif_comment_added` | boolean | Also email the user when someone else comments on a card they created or are assigned to. No effect while `notif_comment_added` is `false`. Defaults to `false`. Writable. Added in 1.2. |

**Example response (excerpt)**

```json
{
  "id": 12,
  "username": "alice",
  "email": "alice@example.com",
  "display_name": "Alice Smith",
  "theme": "dark",
  "timezone": "America/New_York",
  "default_board_id": 5
}
```

### `PATCH /api/v1/auth/me/`
Update the authenticated user's profile. All fields are optional.

**Permission:** Requires authentication.

**Writable fields:** `username`, `email`, `first_name`, `last_name`, `display_name`, `avatar_url`, `has_completed_tour`, `timezone`, `date_format`, `time_format`, `number_locale`, `close_editor_on_enter`, `notif_card_assigned`, `notif_mentioned`, `notif_due_soon`, `notif_card_moved`, `notif_comment_added`, `notif_board_invite`, `notif_stale`, `email_notif_card_assigned`, `email_notif_mentioned`, `email_notif_due_soon`, `email_notif_card_moved`, `email_notif_comment_added`, `default_board_id`, `theme`.

**Request body fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | string | No | 1-150 characters; letters, digits, and `@/./+/-/_` only. Must not match another account's username **ignoring case** — the same rule as [`POST /api/v1/auth/choose-username/`](#post-apiv1authchoose-username) — or another active account's email address (1.2+, #1221). Re-casing your own username is allowed, and so is a username equal to your own email. A request that changes the username also counts against that endpoint's rate limit (the two share one per-user budget), and clears `must_change_username`. |
| `email` | string | No | A valid email address, or `""` to clear it. A **new** address must not match another active account's email or any account's username, ignoring case (1.2+, #1221). A request that changes `email` counts against the same per-user budget as a username change. On instances with `EMAIL_VERIFICATION=mandatory`, a new address doesn't take effect on this request (see below) and is checked against other accounts only when the link is confirmed (a collision then answers `409`, see below), and clearing an existing address is refused. |
| `avatar_url` | string / null | No | URL of the user's avatar image. Accepts any absolute URL or `null` to clear. |
| `theme` | string | No | Color scheme preference. One of `"system"`, `"dark"`, or `"light"`. Defaults to `"system"` for new accounts. |
| `default_board_id` | integer \| null | No | Board to redirect to after login. Must be a board the user is a member of, or `null` to clear. |

**`default_board_id`** — set the board to redirect to after login. Accepts a board `id` (integer) or `null` to clear. The value must be a board the requesting user is a member of; supplying a foreign board ID returns `400 Bad Request`. This prevents enumeration of boards the user has no access to.

> **Changed in 1.2** (#1273) — `username` is now checked case-insensitively and rate-limited, and under `EMAIL_VERIFICATION=mandatory` a changed `email` needs confirmation before it takes effect. Both fields remain writable. Earlier releases stored either value directly.

**Changing `email` when verification is mandatory** — when the instance sets `EMAIL_VERIFICATION=mandatory` and `email` differs from the current address (ignoring case), the request still returns `200 OK`, but:

- `email` in the response (and on the account) is **unchanged**, so it's still the address used for login, password resets, and notification email.
- `pending_email` in the response holds the new address, and a confirmation link is emailed to it.
- The address switches when the link is confirmed through `POST /api/v1/auth/registration/verify-email/` (the link opens the SPA's `/confirm-email/<key>` page, which calls it). `pending_email` then returns to `null`, and the old address is removed from the account.
- Requesting another address before confirming replaces the pending one, and the earlier link normally stops working (two `PATCH` requests racing each other can leave both links usable, and whichever is confirmed wins). Resending to the same pending address is subject to the confirmation-email rate limit; if a resend is skipped, the link already sent still works. To resend the link without re-submitting the form, use [`POST /api/v1/auth/me/pending-email/resend/`](#post-apiv1authmepending-emailresend).
- Sending `email` equal to the current address (ignoring case) while a change is pending **withdraws** it: `pending_email` returns to `null` and the pending link stops working ([`DELETE /api/v1/auth/me/pending-email/`](#delete-apiv1authmepending-email) does the same thing explicitly). A `PATCH` that omits `email` leaves a pending change alone. A round-trip update, where a client GETs the profile, modifies it, and PATCHes or PUTs the full object back (including `PUT /api/v1/auth/user/`), sends the current `email` and therefore **also withdraws** a pending change. Clients should send `email` only when the user edited it.
- Choosing an address that is already a verified address of your own account applies it immediately — unless that address collides with another account's username or active email (1.2+, #1221, #1312), in which case the request answers `400` instead (see the error table below), the same collision rule the initial request-time check above applies.
- An address already verified by another account, or (1.2+, #1221) already held by another active account (even unverified) or used as another account's username, can't be confirmed. Following its link answers `409` with `code: "email_in_use"` (see [Verify email](#post-apiv1authregistrationverify-email)); `pending_email` stays set until the change is withdrawn or replaced.
- `pending_email` only reflects a change requested through this endpoint. Other unconfirmed addresses on the account (for example, ones imported by a social login) are never reported as pending, and they're not removed by a change request or its confirmation.

With `optional` (the default) or `none`, `email` is written directly, as before (including `""` to clear it), and `pending_email` stays `null`.

**Example — set theme**

```json
PATCH /api/v1/auth/me/
{ "theme": "dark" }
```

**Example — set default board**

```json
PATCH /api/v1/auth/me/
{ "default_board_id": 5 }
```

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | `theme` is not one of `"system"`, `"dark"`, or `"light"` — response body contains `{"theme": ["..."]}`  |
| `400 Bad Request` | `default_board_id` refers to a board the user is not a member of |
| `400 Bad Request` | `username` is taken by another account, or is another active account's email (compared ignoring case) — `{"username": ["That username is already taken."]}` |
| `400 Bad Request` | `email` changed to another active account's email or any account's username (compared ignoring case; under `EMAIL_VERIFICATION=mandatory` this is checked when the change is confirmed instead) — `{"email": ["That email address is already in use."]}` |
| `400 Bad Request` | `email` is `""` on an account that has an address, when the instance sets `EMAIL_VERIFICATION=mandatory` — `{"email": ["An email address is required."]}` |
| `429 Too Many Requests` | Too many username or email changes — the request changed `username` or `email` and exhausted the per-user budget it shares with `POST /api/v1/auth/choose-username/` |
| `401 Unauthorized` | Request is not authenticated |

### `DELETE /api/v1/auth/me/pending-email/`

Withdraw the authenticated user's pending email change (see [Changing `email` when verification is mandatory](#patch-apiv1authme)). The unconfirmed address is removed from the account, so the link already sent stops working, and `email` is unchanged. Added in 1.2 (#1293).

Only the address the pending change tracks is removed. In the rare case where two `PATCH` requests raced (see above), the losing request's unconfirmed address is indistinguishable from other unconfirmed addresses on the account, such as ones imported by a social login, so it is left in place. Its link can still verify it as an additional address, but it never changes `email`.

**Permission:** Requires authentication. Acts only on the caller's own pending change; the request takes no address or id. Blocked while the account has a forced password or username change pending, like other profile endpoints except `GET`/`PATCH /api/v1/auth/me/`.

**Request body:** none.

**Response** `200 OK` — the updated profile, the same shape as [`GET /api/v1/auth/me/`](#get-apiv1authme), with `pending_email: null`.

Idempotent: with no change pending it changes nothing and still returns `200`. Other unconfirmed addresses on the account (for example, ones imported by a social login) are never removed.

| Status | Reason |
|---|---|
| `401 Unauthorized` | Request is not authenticated |
| `403 Forbidden` | A forced password or username change is pending |

### `DELETE /api/v1/auth/me/pending-connect/`

Dismiss the one-time "Connect {Provider}?" prompt: clears `pending_connect_provider` for this session. Added in 1.2 (#1314).

**Permission:** Requires authentication. Acts only on the caller's own session.

**Request body:** none.

**Response** `200 OK` — the updated profile, the same shape as [`GET /api/v1/auth/me/`](#get-apiv1authme), with `pending_connect_provider: null`. Idempotent.

<a id="connected-accounts"></a>

### `GET /api/v1/auth/me/connected-accounts/`

List the sign-in providers the caller has connected. One row per provider configured on the instance, plus any provider the caller is still connected to that the operator has since removed. Added in 1.2 (#1314).

**Permission:** Requires authentication. Only the caller's own accounts are listed.

**Response** `200 OK`

```json
[
  { "provider": "google", "connected": true, "email": "alice@gmail.com", "connected_at": "2026-09-30T12:00:00Z" },
  { "provider": "github", "connected": false }
]
```

| Field | Type | Description |
|---|---|---|
| `provider` | string | `google`, `github`, `gitlab`, or `oidc`. |
| `connected` | boolean | Whether the caller has this provider connected. |
| `email` | string or null | The email the provider reported, when connected and known. Omitted when not connected. |
| `connected_at` | string (ISO 8601) | When the provider was connected. Omitted when not connected. |

Connecting is not an API call: the browser POSTs (with the CSRF token) to `/accounts/<provider>/login/?process=connect` — `/accounts/oidc/oidc/login/?process=connect` for generic OIDC — and returns to `/settings` as described under [Auth error redirects](#auth-error-redirects).

### `DELETE /api/v1/auth/me/connected-accounts/<provider>/`

Disconnect a provider from the caller's account. Added in 1.2 (#1314).

**Permission:** Requires authentication. Only the caller's own accounts can be named.

**Request body:** none.

**Response** `200 OK` — the refreshed list, same shape as `GET /api/v1/auth/me/connected-accounts/`.

| Status | Reason |
|---|---|
| `400 Bad Request` | Disconnecting would leave no way to sign in (no password and no other provider, or — under `EMAIL_VERIFICATION=mandatory` — no verified email). `{"detail": "..."}` |
| `401 Unauthorized` | Request is not authenticated |
| `404 Not Found` | The caller has no account connected for that provider |

### `POST /api/v1/auth/me/pending-email/resend/`

Email the confirmation link for the authenticated user's pending email change again. The address is always the pending one; the request can't choose it. Added in 1.2 (#1293).

**Permission:** Requires authentication. Same gating as `DELETE /api/v1/auth/me/pending-email/`.

**Request body:** none (any body is ignored).

**Response** `200 OK`

```json
{ "detail": "Confirmation email sent." }
```

The link is sent through the same confirmation email as the original request and shares its rate limit: at most one email per address every 3 minutes, counting the email sent by the `PATCH` that started the change. Links already sent keep working.

| Status | Reason |
|---|---|
| `404 Not Found` | No email change is pending — `{"detail": "No email change is waiting for confirmation."}` |
| `429 Too Many Requests` | A confirmation email went to this address within the cooldown, so none was sent. The `detail` says so; the earlier link still works. |
| `401 Unauthorized` | Request is not authenticated |
| `403 Forbidden` | A forced password or username change is pending |

---

## Site configuration

### `GET /api/v1/auth/site-config/`
Returns site-level configuration. This endpoint is public — no authentication required.

**Response**
```json
{
  "registration_open": true,
  "registration_mode": "open",
  "demo_mode": false,
  "demo_login": null,
  "demo_reset_schedule": null,
  "demo_next_reset_at": null,
  "invite_email_available": true
}
```

| Field | Type | Values | Description |
|---|---|---|---|
| `registration_open` | boolean | `true` / `false` | Whether new user registration is currently allowed |
| `registration_mode` | string | `"open"` / `"invite_only"` / `"closed"` | The configured registration policy |
| `demo_mode` | boolean | `true` / `false` | Whether the instance runs as a public demo (`DEMO_MODE` env var; default `false`). |
| `demo_login` | object or null | `{"username", "password"}` / `null` | Demo credentials shown on the login page. Non-null only when `demo_mode` is `true` **and** `DEMO_LOGIN_PASSWORD` is set. See [Demo data](../administration/demo-data.md#hosted-demo-instance). |
| `demo_reset_schedule` | string or null | e.g. `"0 * * * *"` / `null` | Cron expression of the demo reset (`DEMO_RESET_SCHEDULE`). Non-null only when `demo_mode` is `true`. Added in 1.2. |
| `demo_next_reset_at` | string or null | ISO 8601 UTC / `null` | The next reset instant, computed server-side from the schedule so clients need no cron parser. Non-null only when `demo_mode` is `true`. Added in 1.2. |
| `invite_email_available` | boolean | `true` / `false` | Whether admins can email invite links. `true` only when `INVITE_EMAIL_ENABLED` is on, demo mode is off, and outbound mail looks configured (`EMAIL_BACKEND` is set explicitly, or the effective sender address is not the `example.com` placeholder). A UI hint, not a delivery guarantee. Added in 1.2. |

Site admins can change the registration mode in **Admin → Site Settings**. See [Site Admins](../administration/site-admins.md).

---

## Registration

### `POST /api/v1/auth/registration/`

Register a new user account. Behavior depends on the instance's current `registration_mode` (see `GET /api/v1/auth/site-config/` above).

**Permission:** None — public endpoint.

#### Open mode

When `registration_mode` is `"open"`, no invite token is required.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | Yes | Must be unique on the instance: not another active account's email or any account's username, compared ignoring case (1.2+, #1221; earlier releases only refused an address another account had verified). A username is auto-derived from the email address. An optional `username` field is also accepted; it can't be another active account's email. |
| `password1` | string | Yes | The desired password (minimum 12 characters). |
| `password2` | string | Yes | Password confirmation — must match `password1`. |

```json
{
  "email": "newuser@example.com",
  "password1": "securepassword123",
  "password2": "securepassword123"
}
```

**Response** `201 Created`

```json
{ "key": "9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" }
```

The returned `key` is an API token that can be used immediately in the `Authorization: Token <key>` header.

#### Invite-only mode

When `registration_mode` is `"invite_only"`, an additional `invite_token` field is required. Invite tokens are created by site admins via `POST /api/v1/admin/invite-links/` and distributed out-of-band, or emailed by a site admin from a group's invite panel (see below).

*(1.2+)* `invite_token` may also be an **emailed group invite** (a `vbng_` token minted by `POST /api/v1/groups/{id}/invite-links/send/`, i.e. `single_use: true` and `delivery: "email"`) **sent by a site admin**. It is accepted only while its sender is still a site admin, still active and an admin of the group (or an ancestor), and while email invites are enabled (`INVITE_EMAIL_ENABLED`, and not a demo instance). A sender who is active but not (or no longer) a site admin gets `invite_not_for_registration`; a deactivated sender, one who lost group-admin rights, or email invites being off gets `invite_invalid`. The new account is then added to that group with the invite's role and the invite is consumed, in the same transaction as the account creation — a failed registration leaves the invite unused, and two registrations racing on one invite create one account. Any other group link (`delivery: "link"`, single-use or not), and an emailed invite from a sender who is not a site admin, is refused. In `"open"` mode the field is ignored, as before; in `"closed"` mode no token creates an account.

*(1.2+)* An **emailed board invite** (a `vbnb_` token from `POST /api/v1/boards/{id}/invite-links/send/`) follows exactly the same rule: accepted only when it is single-use, emailed, unused and unexpired, email invites are enabled, and its sender is still an active site admin and still an admin of the board. The new account becomes a board member with the invite's role, in the same transaction. A board admin who is not a site admin can invite only people who already have an account (`invite_not_for_registration`). OAuth sign-up accepts `vbnb_` the same way (`?invite_token=` on the provider login URL).

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | Yes | Must be unique on the instance. |
| `password1` | string | Yes | Minimum 12 characters. |
| `password2` | string | Yes | Must match `password1`. |
| `invite_token` | string | Yes | The raw token value from the invite link. |

```json
{
  "email": "newuser@example.com",
  "password1": "securepassword123",
  "password2": "securepassword123",
  "invite_token": "kT2vNa8f3b1c9e2d7f4a0b5c6d8e1f2a3b4c5d6e7"
}
```

**Response** `201 Created` — same shape as open mode: `{ "key": "<token>" }`.

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | `invite_token` is missing when the instance is in `invite_only` mode (`code: "invite_missing"`) |
| `400 Bad Request` | `invite_token` does not match any known site, group (`vbng_`) or board (`vbnb_`) invite, has been revoked, or has already been used (single-use links) — all three return the identical `code: "invite_invalid"`, `"Invalid or expired invite link."`, by design, so a caller cannot use the error to distinguish a wrong token from a spent one |
| `400 Bad Request` | The invite link has expired (`code: "invite_expired"`, `"This invite link has expired."`) — the only invite-token failure with its own distinct code |
| `400 Bad Request` (1.2+) | `invite_token` is a group or board invite that cannot create accounts — a shareable group link, or an emailed group or board invite whose sender is not a site admin. Only site invites and emailed single-use group or board invites sent by a site admin can create an account: `{"invite_token": ["This invite link can't be used to create an account on this site. Ask a site admin for an invite."]}`. The OAuth equivalent redirects with `auth_error=invite_not_for_registration` |
| `400 Bad Request` | Email already registered, passwords do not match, or password too short |
| `403 Forbidden` | Registration is `"closed"` — no new accounts can be created |
| `409 Conflict` (`invite_already_redeemed`, 1.1+) | The same email previously redeemed this multi-use invite link | Use a different invite link or contact the link's creator |

### `POST /api/v1/auth/registration/verify-email/`

Confirm an email address from the key in a confirmation link. The link in the email opens the SPA's `/confirm-email/<key>` page, which calls this endpoint. Used both for signup confirmation and for confirming an [email change](#patch-apiv1authme).

**Permission:** None — public endpoint, possession of the key is the credential. IP-throttled (`verify_email` scope).

**Request body:** `{ "key": "<key from the link>" }`

**Response** `200 OK` — `{ "detail": "ok" }`

| Status | Reason |
|---|---|
| `400 Bad Request` | `key` is missing |
| `404 Not Found` | The key is invalid or expired, or the address it names no longer exists (for example, a withdrawn or replaced email change) |
| `409 Conflict` | `{"detail": "...", "code": "email_in_use"}` — the key is valid, but another account has already verified this address, so it can't be confirmed for this one. For a pending email change (1.2+, #1221), also returned when another active account holds the address unverified or uses it as its username. Nothing is changed. Applies to signup confirmations too (for example, two accounts that signed up with the same address before either confirmed it). |
| `429 Too Many Requests` | Too many requests from this IP (`verify_email` throttle scope) |

> **Changed in 1.2** (#1293) — the `409` case used to answer `200 {"detail": "ok"}` without confirming anything. It's only returned to someone holding a valid key, which is only ever emailed to that address, so it reveals nothing the inbox's owner can't already find out. The account that requested the change sees no difference: its `pending_email` stays set either way.

---

## Common errors

| Status | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Missing or invalid token | Check the `Authorization` header format: `Token <key>`. For PATs, ensure the full `vbn_...` value is used. |
| `403 Forbidden` | Valid token but insufficient role | Check the user's role on the board/group |
| `403 Forbidden` (CSRF) | Session auth without CSRF token | Include `X-CSRFToken` header, or switch to token auth |
| `403 Forbidden` (`must_change_password`) | Admin set a forced password-change flag on this account | Change the password via `POST /api/v1/auth/change-password/` (or `POST /api/v1/auth/password/change/`) to clear the flag; all other endpoints are blocked until then |
| `403 Forbidden` (`must_change_username`) | Account's auto-generated username collided during migration | Call `POST /api/v1/auth/choose-username/` — the response body includes `"code": "must_change_username"` as a machine-readable signal |
| `404 Not Found` (PAT delete) | Token ID not found or belongs to another user | Verify the token ID from `GET /api/v1/auth/tokens/` |
