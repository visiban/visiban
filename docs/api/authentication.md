# API Authentication

Visiban supports two authentication methods: **token** (recommended for scripts and API clients) and **session** (used by the browser SPA).

Token authentication covers two token types that share the same `Authorization: Token <value>` header scheme:

- **Session tokens** — short-lived tokens issued by `POST /api/v1/auth/login/`. Invalidated on logout or password change.
- **Personal Access Tokens (PATs)** — long-lived named tokens created through the API or profile settings. Format: `vbn_` followed by 40 hex characters (44 chars total). Invalidated individually via `DELETE /api/v1/auth/tokens/{id}/`, or all at once when the user's password is changed.

!!! note "Trailing slashes on `/api/v1/auth/` routes"
    The dj-rest-auth endpoints — `login/`, `logout/`, `user/`, `password/change/`, `password/reset/`, `password/reset/confirm/`, `registration/verify-email/` and `registration/resend-email/` — accept the path with or without the trailing slash, and both forms are served by the same view with the same rate limits, scope checks and side effects.

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

All PATs for a user are revoked automatically when that user's password is changed or reset through the web interface, the API or the Django admin: the REST endpoints, allauth's pages under `/accounts/password/`, or an administrator setting it in the Django admin.

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

Since 1.2, a body that is not a JSON object, a non-string `name`, and an `expires_at` that is not a string, is not a real date (for example `2026-02-30T00:00:00Z`), or is any non-string value other than `null` (`0`, `false`, `[]`, `{}`) return `400 Bad Request` with `Invalid expires_at value.` (before 1.2 these returned `500` or silently created a non-expiring token). Only `null`, `""` or omitting the field means no expiry. An `expires_at` with no UTC offset is read as UTC.

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
| `401 Unauthorized` | Request is not authenticated, or the credential it was authenticated with is no longer valid (for example it was changed or revoked while the request was in flight); a retry with the current credential succeeds |
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

The ticket authenticates only — board and group membership is still enforced on every connection, so a ticket belonging to a non-member is closed with `4003`. The same account-state checks that apply to REST and MCP (pending password or username change) apply to board and group sockets, at connect and on every access re-check, with close code `4003`.

The ticket is bound to the credential that minted it (since 1.2, #1483). If that credential is revoked before the ticket is spent (the session logs out, the PAT is deleted or expires, or the session token is deleted), the handshake is closed with `4001`. Once the socket is open, the server closes it with `4003` within the access re-check window after logout, password change, or credential revocation. See [WebSocket API → Credential revocation](websockets.md#credential-revocation-since-12).

**Errors**

| Status | Reason |
|---|---|
| `401 Unauthorized` | Request is not authenticated |
| `403 Forbidden` | The request was authenticated with a scoped PAT that does not hold `write` |
| `403 Forbidden` | The request was authenticated by a credential the server cannot re-validate later, so it cannot be bound to a ticket (`"This credential cannot be used to open a WebSocket."`). Session cookies, PATs, and session tokens are always accepted. |
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

### Session-only account-security endpoints

A few account-security operations ignore token scopes entirely: a request authenticated with a token credential (a personal access token of any scope, or the login API token) is refused with `403 Forbidden`, because a `write` scope is not meant to carry authority over how the account is signed in to. The rule applies per operation: `DELETE /api/v1/auth/me/connected-accounts/{provider}/` is always refused (1.2, #1794); setting a first password is refused only for an account with no usable password; changing the account email is refused only when the request changes the address (sending the stored value back unchanged is accepted); and changing the username is refused only when the request changes it (1.2). See their endpoint sections. Use the browser session for these.

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
Search active users by display name or username. Requires authentication. Excludes the requesting user from results. Used internally for @mention autocomplete and the member invite typeahead.

> **Note:** Email is intentionally excluded from the search criteria. Filtering on email without returning it would allow any authenticated caller to silently confirm whether a given email address exists on the instance. Only active users are returned, and only the fields the response returns (username and display name) are matched.

Rate-limited to 30 requests/minute per user.

**Query params**

| Param | Description |
|---|---|
| `search` | Search term — minimum 2 characters; partial match on username and display name. Returns `[]` for shorter queries. |

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
| `invite_invalid` | The invite token is malformed or unknown — or *(1.2+)* a group or board invite that is used, revoked, or whose sender can no longer admit new accounts, or a site invite whose creator is no longer an active site admin. |
| `invite_expired` | The invite token has expired. |
| `invite_not_for_registration` | **Added in 1.2** (#1445, #1444) — in invite-only mode, the invite token is a group or board invite that cannot create accounts: a shareable group or board link, or an emailed group or board invite whose sender is not a site admin. Only site invites and emailed single-use group or board invites sent by a site admin can create an account. |
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
- For an OAuth-only account, the link is valid only while **the address it was sent to** is still verified on the account. If that address has since been unverified or removed, `POST /api/v1/auth/password/reset/confirm/` refuses the link with `400 {"token": ["Invalid value"]}` and no password is set — even if another address on the account is verified. Any change to which of the account's addresses are verified voids its outstanding links; request a new one. Links for accounts that already have a password are unaffected. The server-rendered pages at `/accounts/password/reset/` and `/accounts/password/reset/key/<uid>-<token>/` redirect to the app's `/forgot-password` and `/reset-password/<uid>/<token>` pages (*1.2, #1554*); a URL-mounted allauth view applies the same rules. *Changed in 1.2 (#1337).*
- If the email belongs to an OAuth-only account whose address was never verified, an alternate email is sent directing the user back to their OAuth provider instead, and no reset token is issued.
- **Rate limited** — 5 requests per hour per IP in production (raised to 9999/hour in debug mode, a finite budget; `VISIBAN_DISABLE_THROTTLING` is the CI-only full bypass). Exceeding the limit returns `429 Too Many Requests`.

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

A reset link is accepted once; later use is refused as invalid (this endpoint responds `400` with the invalid-token body, allauth's HTML page shows its invalid-link page, and a submit that overlaps another is refused).

!!! note
    *Changed in 1.2.* A successful reset deletes the API token issued by `POST /api/v1/auth/login/` and all of the account's Personal Access Tokens, and clears a pending forced password change (`must_change_password`). Existing sessions end because the password changed. The old `/accounts/password/reset/key/<uid>-<token>/` URL redirects to the app's reset page, which calls this endpoint.

---

## Change password

### `POST /api/v1/auth/change-password/`

Change the authenticated user's password. Requires authentication.

Since 1.2, a body that is not a JSON object returns `400 Bad Request` (it returned `500` before), and a non-string password is treated as empty and rejected with the usual `400`.

**Request**
```json
{ "current_password": "current-password", "new_password": "new-password" }
```

- `current_password` is not required for social-only accounts (accounts with no usable password that are setting a password for the first time). Setting that first password is available from an interactive session only: a request authenticated with a token (a Personal Access Token or the login API token) is refused with `403 Forbidden` and nothing is changed
- **Changed in 1.2 (#1260):** the session must also have signed in to the account through one of its connected sign-in providers within the last 5 minutes (allauth's `ACCOUNT_REAUTHENTICATION_TIMEOUT`, default 300 seconds). Otherwise the request is refused with `403 Forbidden`, nothing is changed, and the body carries a stable `code` clients can act on (declared on both routes' `403` in the OpenAPI schema, component `PasswordChangeForbidden`, where `code` is optional because other refusals send `detail` only): `{"detail": "To set a password, sign out, sign in again with your sign-in provider, and then set the password within a few minutes. If you can't sign in with a provider, use \"Forgot password?\" on the sign-in page instead.", "code": "recent_login_required"}`. A session with no provider sign-in on record within that window (for example one that signed in longer ago, or by another route) is refused the same way, so the user signs out and signs in again. Accounts that already have a password are unaffected; they prove `current_password` instead
- Minimum 12 characters; standard Django complexity rules apply
- If `must_change_password` was set, it is cleared on success
- The API token issued by `POST /api/v1/auth/login/` is revoked on success; a caller that authenticated with that token receives a replacement in the response's optional `key` field — see [API token on password change](#api-token-on-password-change) below

**Response** `200 OK { "detail": "Password changed successfully." }` on success; `400 Bad Request` with field errors on failure; `403 Forbidden` when a token credential is used to set a first password on an account with no usable password (`{"detail": "Setting a first password is available from an interactive session only."}`), or when the session has no recent provider sign-in to the account (`"code": "recent_login_required"`, above); `429 Too Many Requests` when the request limits described under [Rate limits for password change](#rate-limits-for-password-change) are exceeded. When the request was authenticated with the login API token, the body also carries `key`, the replacement token:

```json
{ "detail": "Password changed successfully.", "key": "<new-api-token>" }
```

#### Rate limits for password change

Both password-change endpoints share one per-user DRF throttle scope, `password_change` (10 requests/hour), and exceeding it returns `429 Too Many Requests`. A wrong current password is also counted against the same per-account `login_failed` budget as failed logins (5 per 5 minutes), so failures at login and here draw on one allowance; while an account is locked out, both endpoints return `429` even for a correct password until the window expires. A correct current password is not counted.

Failed password changes count toward the same per-account and per-IP failed-attempt budgets that sign-in uses, so repeated failures from one IP address can also affect sign-in from that address for a short time.

#### API token on password change

A password change through this endpoint or `POST /api/v1/auth/password/change/` below revokes the account's API token issued by `POST /api/v1/auth/login/`, along with all Personal Access Tokens; a caller authenticated with that token receives a replacement in the optional `key` field. allauth's change and set pages and the Django admin's own-password form do the same.

- **Signed in with a session (the browser SPA):** the session stays signed in. The response has no `key` field. Log in again to get a new API token.
- **Authenticated with the login API token:** the response's optional `key` field holds a new token. Use it for later requests in place of the token you sent, which is revoked. A client that loses the response (for example, to a dropped connection) must log in again to get a token. The response is sent with `Cache-Control: no-store`.
- **Authenticated with a Personal Access Token:** that token is revoked with the rest. The response has no `key` field.

Clients that ignore unknown response fields need no change.

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
    set their first password from a signed-in session, matching
    `/auth/change-password/`; a request authenticated with a token is refused
    with `403 Forbidden` in that case, and so is a session without a recent
    provider sign-in to the account (`"code": "recent_login_required"`, see
    `/auth/change-password/` above; #1260).

- **Minimum 12 characters** (changed in 1.2, #1258). Previously this endpoint
  accepted 8, Django's default. The minimum now comes from the instance-wide
  password policy, so it matches every other password-set path.
- The current session is kept alive after the change (same as
  `/auth/change-password/`) — the caller is not logged out.
- All of the user's Personal Access Tokens are revoked on success, same as
  `/auth/change-password/` — see [Personal Access Tokens](#personal-access-tokens)
  above.
- The login API token is revoked on success, and a caller that authenticated
  with it receives a replacement in the optional `key` field, same as
  `/auth/change-password/` — see
  [API token on password change](#api-token-on-password-change).
- **Clears `must_change_password` on success** (changed in 1.2, #1259), same
  as `/auth/change-password/`. Either endpoint satisfies a forced password
  change.

**Response** `200 OK { "detail": "New password has been saved." }` on success,
plus `key` when the request was authenticated with the login API token.

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
| `429 Too Many Requests` | Per-user request limit or per-account attempt limit reached — see [Rate limits for password change](#rate-limits-for-password-change) |

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

Since 1.2, a body that is not a JSON object returns `400 Bad Request` (it returned `500` before), and a non-string `username` is treated as missing (`400`).

**Request**
```json
{ "username": "desired-username" }
```

- Username must be 1-150 characters; only letters, digits, and `@/./ +/-/_`
- Uniqueness is checked case-insensitively (`iexact`), and since 1.2 (#1221) the username also can't be another active account's email address. Both failures return the same `"That username is already taken."`
- On success, `must_change_username` is cleared
- **Changed in 1.2:** changing the username is available from an interactive session only. A request authenticated with a token (a personal access token or the login API token) that sends a different username answers `403 Forbidden` and nothing is written; sending the stored username back unchanged is not a change.

**Response** `200 OK` with the updated user object on success; `400 Bad Request` with `detail` on failure; `403 Forbidden` with `{"detail": "Changing the username is available from an interactive session only."}` when a token credential requests a different username.

!!! note
    This endpoint's response uses the base user serializer, not `CurrentUserSerializer` — it omits `uploads_enabled`, `git_lens_enabled`, `maintenance_mode`, and the other instance-config fields documented under [User profile](#user-profile) below. Re-fetch `GET /api/v1/auth/me/` if you need those.

**Error codes** — the `403` response when `must_change_username` blocks a
normal endpoint includes `"code": "must_change_username"` so API/PAT clients
can detect the condition. Choosing the new username itself needs an interactive
session (see above), so a token client reports the condition to the account owner.

---

## User profile

### Frozen instance flags on `/auth/user/`

`/auth/user/` (and `/auth/me/`) is the identity object, and the instance-wide flags already on it are **frozen**: `uploads_enabled`, `git_lens_enabled`, `maintenance_mode`, `maintenance_message`, `demo_mode`, and `demo_next_reset_at`. They stay for the 1.x contract and are never removed or renamed.

**Why:** each flag on this object can add a settings, cache, or database read to every `/auth/user/` request and becomes a permanent field on a 1.0+ identity object.

**The rule:** new instance-level flags go on [`GET /api/v1/auth/site-config/`](#get-apiv1authsite-config) (or a capabilities payload), never on this object. Only per-user state belongs here.

All of them except `uploads_enabled` also appear on `site-config`: `git_lens_enabled`, `maintenance_mode`, `maintenance_message`, `demo_mode`, and `demo_next_reset_at`. The server computes both copies with the same code, so they always report the same values and types. Tests pin both field sets (`backend/accounts/tests/test_current_user_instance_flags_frozen_1664.py` and `test_site_config_instance_flags_1872.py`), and a type assertion keeps the TypeScript `User` and `SiteConfig` in step.

!!! warning "Deprecated in 1.2: read instance flags from `site-config`"
    `maintenance_mode`, `maintenance_message`, `demo_mode`, and `demo_next_reset_at` on `/auth/user/` and `/auth/me/` are **deprecated** (#1872). Read them from [`GET /api/v1/auth/site-config/`](#get-apiv1authsite-config). The OpenAPI schema marks the `/auth/user/` copies `deprecated: true`. They are still returned, with unchanged values, for the whole 1.x line. Removal needs a major version.

    `git_lens_enabled` is **not** deprecated on `/auth/user/`. It is a frozen 1.x field there (#1666), and `site-config` carries the same value.

    The bundled web app reads these four from `site-config` (#1913) and no longer reads the `/auth/user/` copies. Third-party clients should do the same.

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
| `can_access_all_content` | boolean | Whether the user has read/write access to every board and group regardless of membership. Independent of `is_site_admin` for non-superusers; a superuser always has it — see [Site Admins](../administration/site-admins.md). |
| `uploads_enabled` | boolean | Instance-wide setting reflecting whether file attachment uploads are currently permitted. When `false`, the attachment UI is hidden and upload attempts return `403`. |
| `git_lens_enabled` | boolean | Instance-wide setting reflecting whether the [Issue Board Lens](../features/issue-board-lens.md) is enabled (`GIT_LENS_ENABLED`). When `false`, the SPA hides the Lens tab, board settings, and related API surface entirely. Read-only. Added in 1.2. Also on [`site-config`](#get-apiv1authsite-config); not deprecated here. |
| `maintenance_mode` | boolean | Instance-wide setting reflecting whether the instance is in read-only maintenance mode. When `true`, non-admin writes return `503` — see [Maintenance mode](admin.md#maintenance-mode). Read-only. Added in 1.2. **Deprecated:** read it from [`site-config`](#get-apiv1authsite-config). |
| `maintenance_message` | string | The notice to show while `maintenance_mode` is `true`. Always non-empty in that case (the server substitutes a built-in default for a blank operator message), and `""` otherwise. Plain text — render it as text, never as HTML. Read-only. Added in 1.2. **Deprecated:** read it from [`site-config`](#get-apiv1authsite-config). |
| `demo_mode` | boolean | Whether the instance is a public hosted demo (`DEMO_MODE`). When `true`, unsafe requests outside a small allowlist return `403` with `code: "demo_read_only"` — see [Hosted demo instance](../administration/demo-data.md#hosted-demo-instance). Read-only. Added in 1.2. **Deprecated:** read it from [`site-config`](#get-apiv1authsite-config). |
| `demo_next_reset_at` | string (ISO 8601 UTC) or null | The next scheduled demo reset, computed server-side from `DEMO_RESET_SCHEDULE`. `null` unless `demo_mode` is `true`. Read-only. Added in 1.2. **Deprecated:** read it from [`site-config`](#get-apiv1authsite-config). |
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

**Writable fields:** `username`, `email`, `first_name`, `last_name`, `display_name`, `avatar_url`, `has_completed_tour`, `timezone`, `date_format`, `time_format`, `number_locale`, `close_editor_on_enter`, `notif_card_assigned`, `notif_mentioned`, `notif_due_soon`, `notif_card_moved`, `notif_comment_added`, `notif_board_invite`, `notif_stale`, `email_notif_card_assigned`, `email_notif_mentioned`, `email_notif_due_soon`, `email_notif_card_moved`, `email_notif_comment_added`, `default_board_id`, `theme`. The write-only `current_password` field (below) is accepted alongside them and is never returned.

**Request body fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | string | No | 1-150 characters; letters, digits, and `@/./+/-/_` only. Must not match another account's username **ignoring case** — the same rule as [`POST /api/v1/auth/choose-username/`](#post-apiv1authchoose-username) — or another active account's email address (1.2+, #1221). Re-casing your own username is allowed, and so is a username equal to your own email. **Changing the username is available from an interactive session only (1.2+):** a request authenticated with a token (a personal access token or the login API token) that sends a different value, including a case-only change or a blank, answers `403` before anything is written; omitting `username` or sending the stored value back unchanged is not a change. A request that changes the username also counts against that endpoint's rate limit (the two share one per-user budget), and clears `must_change_username`. |
| `email` | string | No | A valid email address, or `""` to clear it. A **new** address must not match another active account's email or any account's username, ignoring case (1.2+, #1221). A request that changes `email` counts against the same per-user budget as a username change. On instances with `EMAIL_VERIFICATION=mandatory`, a new address doesn't take effect on this request (see below) and is checked against other accounts only when the link is confirmed (a collision then answers `409`, see below), and clearing an existing address is refused. **Changed in 1.2:** changing `email` (including clearing it, or a case-only change) is available from an interactive session only: a request authenticated with a token (a personal access token or the login API token) that changes it is refused with `403 Forbidden` and nothing in the request is applied, whatever the `EMAIL_VERIFICATION` setting. Omitting `email`, or sending the current value unchanged, is not a change, so token clients can still update the other fields. On an account with a password, a change also needs `current_password` (below). **Changed in 1.2 (#1932):** on an account without a usable password (`has_usable_password: false`), a change instead needs the session to have signed in to the account through one of its connected sign-in providers within the last 5 minutes (allauth's `ACCOUNT_REAUTHENTICATION_TIMEOUT`, default 300 seconds), the same rule as setting a first password; otherwise it answers `403 Forbidden` with `{"detail": "...", "code": "recent_login_required"}`, checked before any other `email` rule, and nothing in the request is applied, whatever the `EMAIL_VERIFICATION` setting. |
| `current_password` | string | Only when changing `email` on an account that has a password | **Added in 1.2.** The account's current password. A request that changes `email` (including clearing it, or a case-only change) on an account with a usable password (`has_usable_password: true`) must include it, in every `EMAIL_VERIFICATION` mode; it is checked before any other `email` rule, and a missing or wrong value answers `400` with a `current_password` error and nothing in the request is applied. A wrong value counts toward the same per-account failed-attempt lockout as login and the password-change endpoints. The change is refused with the same `400` if the account's password changed while the request was in flight (including a hash re-encode at login with the same password); the client should retry. Accounts that sign in only through an identity provider (`has_usable_password: false`) don't send it; they need a recent provider sign-in instead (see `email`). Requests that don't change `email` don't need it, and a value sent with them is ignored. Write-only: never returned. Also applies to `PATCH` and `PUT /api/v1/auth/user/`. |
| `avatar_url` | string | No | URL of the user's avatar image. Must be an absolute `http://` or `https://` URL with a host and no embedded credentials (`user:pass@`), or an empty string to clear. Any other value (`javascript:`, `data:`, relative paths, `ftp:`) is rejected with `400` and an `avatar_url` error. Validated on write only; values stored earlier are returned unchanged. |
| `theme` | string | No | Color scheme preference. One of `"system"`, `"dark"`, or `"light"`. Defaults to `"system"` for new accounts. |
| `default_board_id` | integer \| null | No | Board to redirect to after login. Must be a board the user is a member of, or `null` to clear. |

**`default_board_id`** — set the board to redirect to after login. Accepts a board `id` (integer) or `null` to clear. The value must be a board the requesting user is a member of; supplying a foreign board ID returns `400 Bad Request`. *(1.2+)* A membership whose stored role is not one of the four roles (`admin`, `member`, `collaborator`, `viewer`) does not count (#1829). This prevents enumeration of boards the user has no access to.

> **Changed in 1.2** (#1273) — `username` is now checked case-insensitively and rate-limited, and under `EMAIL_VERIFICATION=mandatory` a changed `email` needs confirmation before it takes effect. Both fields remain writable. Earlier releases stored either value directly.

**Notice to the previous address** (**added in 1.2**) — once an account's email actually changes to a different address (a direct change, a confirmed change under `EMAIL_VERIFICATION=mandatory`, or a change made on the `/accounts/email/` page or in the Django admin), the previous address is sent a short notice that the account's email was changed. The notice does not include the new address. A case-only change, or an account that had no address, sends nothing. A failure to send the notice does not undo or fail the change.

**Notices for accounts without a password** (**added in 1.2**) — on an account with no usable password (identity-provider sign-in only), an address added to or confirmed on the account (on the `/accounts/email/` page, through `POST /api/v1/auth/registration/verify-email/`, or as a pending change under `EMAIL_VERIFICATION=mandatory`) sends a short notice to the account's current email (at most one such notice per account per hour), never to the added address; a confirmation that changes the account's email sends only the previous-address notice above. When the first password on such an account is set through `POST /api/v1/auth/password/reset/confirm/`, `POST /api/v1/auth/change-password/` or `POST /api/v1/auth/password/change/`, the account's email address and every verified address on the account (at most ten in all) receive a short notice, one message each. The notices contain fixed text only, and a failure to send one does not fail the request. Accounts with a password get neither notice.

**Changing `email` when verification is mandatory** — when the instance sets `EMAIL_VERIFICATION=mandatory` and `email` differs from the current address (ignoring case), the request still returns `200 OK`, but:

- `email` in the response (and on the account) is **unchanged**, so it's still the address used for login, password resets, and notification email.
- `pending_email` in the response holds the new address, and a confirmation link is emailed to it.
- The address switches when the link is confirmed through `POST /api/v1/auth/registration/verify-email/` (the link opens the SPA's `/confirm-email/<key>` page, which calls it). `pending_email` then returns to `null`, and the old address is removed from the account.
- Requesting another address before confirming replaces the pending one, and the earlier link normally stops working (two `PATCH` requests racing each other can leave both links usable, and whichever is confirmed wins). Resending to the same pending address is subject to the confirmation-email rate limit; if a resend is skipped, the link already sent still works. To resend the link without re-submitting the form, use [`POST /api/v1/auth/me/pending-email/resend/`](#post-apiv1authmepending-emailresend).
- Sending `email` equal to the current address (ignoring case) while a change is pending **withdraws** it (only the address exactly as stored is not a change; a case-only difference is a change, so a request authenticated with a token is refused with `403 Forbidden`, a session on an account with a password must also send `current_password` or gets `400`, and a session on an account without a password needs a recent provider sign-in or gets `403` with `"code": "recent_login_required"`, see `email` above): `pending_email` returns to `null` and the pending link stops working ([`DELETE /api/v1/auth/me/pending-email/`](#delete-apiv1authmepending-email) does the same thing explicitly). A `PATCH` that omits `email` leaves a pending change alone. A round-trip update, where a client GETs the profile, modifies it, and PATCHes or PUTs the full object back (including `PUT /api/v1/auth/user/`), sends the current `email` and therefore **also withdraws** a pending change. Clients should send `email` only when the user edited it.
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
| `400 Bad Request` | The request changes `email` on an account with a password and omits `current_password` — `{"current_password": ["Enter your current password to change your email address."]}` |
| `400 Bad Request` | The request changes `email` and `current_password` is wrong, or the account's password changed while the request was in flight (including a hash re-encode at login with the same password; retry) — `{"current_password": ["Your current password was entered incorrectly. Please enter it again."]}` |
| `429 Too Many Requests` | The account's failed-attempt lockout is active (too many wrong passwords here, at login, or at a password-change endpoint) — `{"detail": "Too many failed attempts. Try again later."}` |
| `403 Forbidden` | The request changes `email` and was authenticated with a token (a personal access token or the login API token) rather than an interactive session — `{"detail": "Changing the email address is available from an interactive session only."}`. Also applies to `PATCH` and `PUT /api/v1/auth/user/`. |
| `403 Forbidden` | **Added in 1.2 (#1932).** The request changes `email` on an account without a usable password (`has_usable_password: false`) from a session that has not signed in to the account through one of its connected sign-in providers within the last 5 minutes (`ACCOUNT_REAUTHENTICATION_TIMEOUT`, default 300 seconds) — `{"detail": "To change your email address, sign out, sign in again with your sign-in provider, ...", "code": "recent_login_required"}`. Checked before any other `email` rule; nothing in the request is applied. Also applies to `PATCH` and `PUT /api/v1/auth/user/`. |
| `403 Forbidden` | The request changes `username` and was authenticated with a token (a personal access token or the login API token) rather than an interactive session — `{"detail": "Changing the username is available from an interactive session only."}`. Nothing in the request is applied. Also applies to `PATCH` and `PUT /api/v1/auth/user/`. |
| `429 Too Many Requests` | Too many username or email changes — the request changed `username` or `email` and exhausted the per-user budget it shares with `POST /api/v1/auth/choose-username/` |
| `401 Unauthorized` | Request is not authenticated |

### `DELETE /api/v1/auth/me/pending-email/`

Withdraw the authenticated user's pending email change (see [Changing `email` when verification is mandatory](#patch-apiv1authme)). The unconfirmed address is removed from the account, so the link already sent stops working, and `email` is unchanged. Added in 1.2 (#1293).

Only the address the pending change tracks is removed. In the rare case where two `PATCH` requests raced (see above), the losing request's unconfirmed address is indistinguishable from other unconfirmed addresses on the account, such as ones imported by a social login, so it is left in place. Its link can still verify it as an additional address, but it never changes `email`.

**Permission:** Requires authentication, from an interactive session only (changed in 1.2, #1838): a request authenticated with a token (a personal access token or the login API token) answers `403 Forbidden` and nothing is changed, the same rule as changing `email` itself. Acts only on the caller's own pending change; the request takes no address or id. Blocked while the account has a forced password or username change pending, like other profile endpoints except `GET`/`PATCH /api/v1/auth/me/`.

**Request body:** none.

**Response** `204 No Content` — no body. Re-fetch the profile with [`GET /api/v1/auth/me/`](#get-apiv1authme) or `GET /api/v1/auth/user/`, or set `pending_email` to `null`, to show the new state. Before 1.2.0 GA this returned `200` with the updated profile; it was changed to `204` to match the other 1.2 revoke endpoints (#2005).

Idempotent: with no change pending it changes nothing and still returns `204`. Other unconfirmed addresses on the account (for example, ones imported by a social login) are never removed.

| Status | Reason |
|---|---|
| `401 Unauthorized` | Request is not authenticated |
| `403 Forbidden` | Authenticated with a token rather than an interactive session — `{"detail": "Changing the email address is available from an interactive session only."}` |
| `403 Forbidden` | A forced password or username change is pending |

### `DELETE /api/v1/auth/me/pending-connect/`

Dismiss the one-time "Connect {Provider}?" prompt: clears `pending_connect_provider` for this session. Added in 1.2 (#1314).

**Permission:** Requires authentication. Acts only on the caller's own session.

**Request body:** none.

**Response** `204 No Content` — no body. Re-fetch the profile with [`GET /api/v1/auth/me/`](#get-apiv1authme) or `GET /api/v1/auth/user/`, or set both `pending_connect_provider` and `pending_connect_identity` to `null`, to show the new state. Idempotent. Before 1.2.0 GA this returned `200` with the updated profile; it was changed to `204` to match the other 1.2 revoke endpoints (#2005).

<a id="connected-accounts"></a>

### `GET /api/v1/auth/me/connected-accounts/`

List the sign-in providers the caller has connected. One row per provider configured on the instance, plus any provider the caller is still connected to that the operator has since removed. Added in 1.2 (#1314).

**Permission:** Requires authentication. Only the caller's own accounts are listed.

**Response** `200 OK`

```json
[
  { "provider": "google", "connected": true, "email": "alice@gmail.com", "connected_at": "2026-09-30T12:00:00Z" },
  { "provider": "github", "connected": false, "email": null, "connected_at": null }
]
```

| Field | Type | Description |
|---|---|---|
| `provider` | string | `google`, `github`, `gitlab`, or `oidc`. |
| `connected` | boolean | Whether the caller has this provider connected. |
| `email` | string or null | The email the provider reported, when connected and known; `null` when not connected. Always present. |
| `connected_at` | string (ISO 8601) or null | When the provider was connected; `null` when not connected. Always present. *Changed in 1.2 (#1871): previously omitted on a disconnected row; the schema now documents both `email` and `connected_at` as always present and nullable.* |

Connecting is not an API call: the browser POSTs (with the CSRF token) to `/accounts/<provider>/login/?process=connect` — `/accounts/oidc/oidc/login/?process=connect` for generic OIDC — and returns to `/settings` as described under [Auth error redirects](#auth-error-redirects).

For an account with a usable password, the callback first requires a recent authentication (a sign-in recorded by allauth's flows, or the `/accounts/reauthenticate/` page, within `ACCOUNT_REAUTHENTICATION_TIMEOUT`, default 300 seconds; a login through `POST /api/v1/auth/login/` does not count). Without one it redirects to `/accounts/reauthenticate/?next=/accounts/<provider>/login/?process=connect` (URL-encoded) and connects nothing; once the password is confirmed, the browser returns to the provider's connect start to begin again. An identity already connected to the caller's account is not asked. An account without a usable password is not asked; its primary email address is sent a notice after the provider is connected. Added in 1.2 (#1710).

### `DELETE /api/v1/auth/me/connected-accounts/{provider}/`

Disconnect a provider from the caller's account. Added in 1.2 (#1314).

**Permission:** Requires authentication. Only the caller's own accounts can be named. **Interactive session only** (1.2, #1794): a request authenticated with a token (a personal access token, whatever its scopes, or the login API token) is refused with `403 Forbidden`, so a leaked token cannot remove a way to sign in.

**Request body:** none.

**Response** `204 No Content` — no body. Re-fetch [`GET /api/v1/auth/me/connected-accounts/`](#connected-accounts) to show the new state. Before 1.2.0 GA this returned `200` with the refreshed list; it was changed to `204` to match the other 1.2 revoke endpoints (#2005).

| Status | Reason |
|---|---|
| `400 Bad Request` | Disconnecting would leave no way to sign in (no password and no other provider, or — under `EMAIL_VERIFICATION=mandatory` — no verified email). `{"detail": "..."}` |
| `401 Unauthorized` | Request is not authenticated |
| `403 Forbidden` | Authenticated with a token rather than an interactive session — `{"detail": "Disconnecting a sign-in provider is available from an interactive session only."}`. Checked before the provider is looked up, so the answer is the same whether or not it is connected. |
| `404 Not Found` | The caller has no account connected for that provider |

### `POST /api/v1/auth/me/pending-email/resend/`

Email the confirmation link for the authenticated user's pending email change again. The address is always the pending one; the request can't choose it. Added in 1.2 (#1293).

**Permission:** Requires authentication, from an interactive session only (changed in 1.2, #1838). Same gating as `DELETE /api/v1/auth/me/pending-email/`: a token caller answers `403 Forbidden` before the pending change is looked up, so the answer is the same whether or not one is pending.

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
| `403 Forbidden` | Authenticated with a token rather than an interactive session — `{"detail": "Changing the email address is available from an interactive session only."}` |
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
  "invite_email_available": true,
  "git_lens_enabled": false,
  "maintenance_mode": false,
  "maintenance_message": ""
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
| `git_lens_enabled` | boolean | `true` / `false` | Whether the [Issue Board Lens](../features/issue-board-lens.md) is enabled (`GIT_LENS_ENABLED`). Same value as on `/auth/user/`. Added in 1.2 (#1872). |
| `maintenance_mode` | boolean | `true` / `false` | Whether the instance is in read-only [maintenance mode](admin.md#maintenance-mode). Added in 1.2 (#1872). |
| `maintenance_message` | string | text / `""` | The maintenance notice. Always non-empty while `maintenance_mode` is `true` (a blank operator message is replaced by the built-in default), and `""` otherwise. Plain text: render it as text, never as HTML. Added in 1.2 (#1872). |

Every field describes the instance, not the caller, so an anonymous request and a signed-in one get the same body. Clients should read `git_lens_enabled`, `maintenance_mode`, `maintenance_message`, `demo_mode`, and `demo_next_reset_at` here rather than from `/auth/user/` (see [Frozen instance flags](#frozen-instance-flags-on-authuser)).

!!! note "The maintenance notice is public"
    Anyone can read this endpoint, so `maintenance_message` is visible without signing in. An anonymous write during maintenance also gets the same notice in its `503` body. Do not put internal detail in the notice.

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

With `EMAIL_VERIFICATION=mandatory` the new account is not signed in, and the response is instead `201 Created` with `{"detail": "Verification e-mail sent."}`; the account can log in once its address is confirmed.

#### An address that is already in use

> **Changed in 1.2** (#1877)

What a registration for an address that another account already uses gets depends on `EMAIL_VERIFICATION`:

- **`mandatory`** — the same response as any other registration: `201 Created` with `{"detail": "Verification e-mail sent."}`, after the same form checks (password rules, matching passwords, a `403` when registration is closed). No account is created and the existing account is left unchanged. Instead of a confirmation link, the address receives an email saying an account already exists, with a link to reset its password. The same applies in invite-only mode, where the invite stays unused, and to the server-rendered `/accounts/signup/` form. Earlier releases answered `400` here.
- **`optional`** or **`none`** (the default is `optional`) — `400 Bad Request` with `{"email": ["User is already registered with this e-mail address."]}`, as before. In these modes a new registration is signed in immediately and receives a token, which a registration that creates no account cannot match, so the existing response is kept.

"In use" means an address another active account has as its email, an address another account has verified, or another account's username, compared ignoring case. Registration is rate-limited per IP address (`register` scope, 10 requests per minute) in every mode. Operators who want registration to answer every address the same way should set `EMAIL_VERIFICATION=mandatory` (see [Configuration](../administration/configuration.md)).

#### Invite-only mode

When `registration_mode` is `"invite_only"`, an additional `invite_token` field is required. Invite tokens are created by site admins via `POST /api/v1/admin/invite-links/` and distributed out-of-band, or emailed by a site admin from a group's invite panel (see below).

> **Added in 1.2**

`invite_token` may also be an **emailed group invite** (a `vbng_` token minted by `POST /api/v1/groups/{id}/invite-links/send/`, i.e. `single_use: true` and `delivery: "email"`) **sent by a site admin**. It is accepted only while its sender is still a site admin, still active and an admin of the group (or an ancestor), and while email invites are enabled (`INVITE_EMAIL_ENABLED`, and not a demo instance). A sender who is active but not (or no longer) a site admin gets `invite_not_for_registration`; a deactivated sender, one who lost group-admin rights, or email invites being off gets `invite_invalid`. The new account is then added to that group with the invite's role and the invite is consumed, in the same transaction as the account creation (with `EMAIL_VERIFICATION=mandatory` and the invited address not yet verified, the invite is held for the account in that transaction instead, and the membership is granted and the invite consumed when the address is confirmed, #1704) — a failed registration leaves the invite unused, and two registrations racing on one invite create one account. Any other group link (`delivery: "link"`, single-use or not), and an emailed invite from a sender who is not a site admin, is refused. In `"open"` mode the field is ignored, as before; in `"closed"` mode no token creates an account.

> **Added in 1.2**

An **emailed board invite** (a `vbnb_` token from `POST /api/v1/boards/{id}/invite-links/send/`) follows exactly the same rule: accepted only when it is single-use, emailed, unused and unexpired, email invites are enabled, and its sender is still an active site admin and still an admin of the board. The new account becomes a board member with the invite's role, in the same transaction (with `EMAIL_VERIFICATION=mandatory` and the invited address not yet verified, when the address is confirmed instead, #1704). A board admin who is not a site admin can invite only people who already have an account (`invite_not_for_registration`). A **shareable board invite link** (`delivery: "link"`, from `POST /api/v1/boards/{id}/invite-links/`) never creates an account in `"invite_only"` mode, whoever created it (`invite_not_for_registration`). OAuth sign-up accepts `vbnb_` the same way (`?invite_token=` on the provider login URL). For OAuth, the account is created and the invite redeemed in one transaction, so when several sign-ups race on one single-use invite (site, group or board) exactly one account is created; the others are redirected with an `auth_error` such as `invite_invalid` and leave no account behind. A sign-up refused at invite redemption clears the pending invite from the session, so the person needs a fresh invite link to try again.

> **Added in 1.2** (#1678)

An emailed site, group or board invite is bound to the address it was sent to. Registration with a different `email` is refused with `400 {"email": ["This invite was sent to a different email address. Sign up with the address the invite was sent to, or ask for a new invite."], "code": "invite_recipient_mismatch"}`. The invite is still valid, so this is an `email` field error and not an `invite_token` one, and clients should keep the token for a retry with the invited address. The check runs only after the rest of the form is valid, so a form error, such as mismatched passwords, reads the same whatever address was typed. No account is created and the invite stays unused. Matching ignores case and surrounding spaces. For OAuth sign-up, the provider's address must match; otherwise the account is rolled back and the browser is redirected with `auth_error=invite_recipient_mismatch`. The new account still follows the normal email-verification setting. With `EMAIL_VERIFICATION=mandatory`, a group or board invite whose address is not yet verified on the new account grants its membership when that address is confirmed, not at registration; the `201` response is the usual verify-email answer (#1704). Shareable invite links and emailed invites sent before upgrading to this version are not bound to an address (#1703 extended the binding to emailed site invites).

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

**Response** `201 Created` — same shape as open mode: `{ "key": "<token>" }`, or `{"detail": "Verification e-mail sent."}` with `EMAIL_VERIFICATION=mandatory`, including for an address that is already in use (see [above](#an-address-that-is-already-in-use)).

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | `invite_token` is missing when the instance is in `invite_only` mode (`code: "invite_missing"`) |
| `400 Bad Request` | `invite_token` does not match any known site, group (`vbng_`) or board (`vbnb_`) invite, has been revoked, or has already been used (single-use links) — or *(1.2+)* is a site invite whose creator is no longer an active site admin (deactivated, deleted, or no longer a site admin) — all of these return the identical `code: "invite_invalid"`, `"Invalid or expired invite link."`, by design, so a caller cannot use the error to distinguish a wrong token from a spent one |
| `400 Bad Request` | The invite link has expired (`code: "invite_expired"`, `"This invite link has expired."`) — the only invite-token failure with its own distinct code |
| `400 Bad Request` (1.2+) | `invite_token` is a group or board invite that cannot create accounts — a shareable group or board link, or an emailed group or board invite whose sender is not a site admin. Only site invites and emailed single-use group or board invites sent by a site admin can create an account: `{"invite_token": ["This invite link can't be used to create an account on this site. Ask a site admin for an invite."]}`. The OAuth equivalent redirects with `auth_error=invite_not_for_registration` |
| `400 Bad Request` | Email already registered (only with `EMAIL_VERIFICATION` `optional` or `none`, see [above](#an-address-that-is-already-in-use)), passwords do not match, or password too short |
| `403 Forbidden` | Registration is `"closed"` — no new accounts can be created |
| `409 Conflict` (`invite_already_redeemed`, 1.1+) | The same email previously redeemed this multi-use invite link | Use a different invite link or contact the link's creator. The same status with `invite_invalid` is possible if a group or board invite is lost to a concurrent redemption (unreachable while the invite row lock is held); the account is rolled back either way |

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

### `POST /api/v1/auth/registration/resend-email/`

Send the confirmation email again for an address awaiting verification.

**Permission:** None — public endpoint. Throttled per IP for both authenticated and anonymous callers (`resend_email` scope, 10 requests per hour by default).

**Request body:** `{ "email": "<address>" }`

**Response** `200 OK` — `{ "detail": "ok" }`. The response is the same whether or not the address belongs to an account.

| Status | Reason |
|---|---|
| `400 Bad Request` | The `email` value is not a valid address |
| `429 Too Many Requests` | Too many requests from this IP (`resend_email` throttle scope) |

> **Added in 1.2** (#1552) — scoped rate limit for this endpoint.

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
