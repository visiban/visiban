# Call the API without sharing your password

> **Added in 1.0**

Open **Settings → Access Tokens**, fill in the **New token** form, and click **Generate token**. Then send it as `Authorization: Token vbn_...` on API requests.

**Why it matters:** Each token acts on your behalf, limited to your own access rights and narrowed by its [scopes](#scopes). Scripts, CI pipelines, and integrations never need your password or a browser session cookie.

**When to use a PAT:**

- **Scripts** — automate card creation, moves, or exports from a shell script or cron job
- **CI/CD pipelines** — trigger board updates from your deployment pipeline
- **Integrations** — connect external tools that call the Visiban API directly
- **Local development** — test API calls quickly without maintaining a session

In a browser, session-based login is used automatically; no token needed.

**Watch out:** the full token value is shown **only once**. Copy it before leaving the page.

---

## Create a token

1. Open your avatar menu (top right) and select **Settings**.
2. Go to **Access Tokens** in the left sidebar.
3. Use the **New token** form above the token list.
4. Enter a descriptive name, for example `deploy-script` or `ci-pipeline`.
5. Optionally set an expiry date (see [Expiry](#expiry) below).
6. Choose the token's [scopes](#scopes). `read` and `write` are pre-checked, so leaving them alone gives the default token. Tick `mcp:read` (and `mcp:write` for write tools) to make a token an MCP client can use, or untick `read` and `write` if the token is only for MCP. At least one scope is required. `admin` is offered to site administrators only.
7. Click **Generate token**.

The token list shows each token's scopes; tokens created before 1.2 are labeled "Legacy: full REST access". You can also set scopes through the API with `POST /api/v1/auth/tokens/` and a `scopes` list; see [Scopes](#scopes).

!!! warning "Copy your token now"
    The full token value is shown **only once** — immediately after creation. Once you navigate away, Visiban stores only a secure hash and cannot show the token again. Copy it to a password manager or secret store before leaving the page.

Tokens are prefixed with `vbn_` so they're easy to spot in logs and configuration files. The full format is `vbn_` followed by 40 hex characters (44 characters total), generated with `secrets.token_hex`. Validate it with the regex `^vbn_[0-9a-f]{40}$`.

---

## Identifying tokens after creation

Since the full value is shown only once, the Access Tokens list identifies each token by its **prefix** (the first 8 characters, for example `vbn_a3f1...`). Together with the token's name and its **last used** timestamp, that usually tells tokens apart.

**Last used** shows when the token last authenticated a request; tokens never used show "Never".

---

## Scopes

> **Added in 1.2**

Every token created from version 1.2 onward carries an explicit list of **scopes**: the operations it's allowed to perform. Scopes let you give a script, a CI pipeline, or an AI agent a credential less powerful than your own account.

| Scope | Grants |
|---|---|
| `read` | `GET`, `HEAD` and `OPTIONS` requests to the REST API |
| `write` | `POST`, `PUT`, `PATCH` and `DELETE` requests to the REST API |
| `admin` | Access to the `/api/v1/admin/*` endpoints (only if your account is a site administrator) |
| `mcp:read` | Read access through the [MCP server](../api/mcp.md) |
| `mcp:write` | Write access through the MCP server |

### Scopes are non-hierarchical

This is the most important thing to know about them, and it is deliberate:

!!! warning "No scope implies any other"
    `admin` does **not** grant `read` or `write`. `write` does **not** grant `read`. Neither `read` nor `write` grants `mcp:read`, and `mcp:read` does not grant `mcp:write`.

    A token must carry **every** scope its request needs. A token that reads the admin API needs both `admin` **and** `read`. A token that writes a card needs `write`. An agent that reads boards over MCP needs `mcp:read` — being able to read them over REST isn't enough.

**Why it's non-hierarchical:** a hierarchy would quietly turn a narrow credential back into a broad one. If `admin` implied `write`, a token issued only to read the settings page could modify every board on the instance. Listing each grant explicitly keeps the token's authority exactly what you see on the token list, with nothing inherited.

### Default scopes

A token created without specific scopes gets `read` and `write`: enough for the scripting and CI use cases PATs were built for, and nothing more. `admin` and the `mcp:*` scopes must always be requested explicitly.

### Tokens created before 1.2

Tokens that already existed when your instance upgraded to 1.2 have **no scopes recorded**. They keep working exactly as before across the whole REST API, including the admin endpoints if you're a site administrator, so upgrading doesn't break a running integration.

The MCP server refuses them: an agent credential has to be issued deliberately, so a token created before MCP scopes existed can't be used as one. To connect an MCP client, create a new token with `mcp:read` (tick it in Settings > Access Tokens, or use `POST /api/v1/auth/tokens/` with `"scopes": ["mcp:read"]`; see [MCP Server](mcp-server.md#generating-a-bearer-token)).

Replace pre-1.2 tokens with scoped ones as you rotate them.

### What a scope cannot do

Scopes are a ceiling, never a floor: they narrow a token's authority and never widen it. Every request is still subject to the same board membership and role checks as a browser session. A token scoped `admin` on a non-administrator account reaches nothing new.

---

## Expiry

The expiry date is optional:

- **Leave blank** — the token never expires, and stays valid until revoked manually or your password changes.
- **Set a date** — the maximum expiry is **one year from today**. Past that date the token is rejected with `401 Unauthorized`.

Expired tokens stay visible in the Access Tokens list and can be revoked there.

---

## Use a token in API requests

Pass the token in the `Authorization` header using the `Token` scheme:

```bash
curl -s https://your-instance.example.com/api/v1/boards/ \
  -H "Authorization: Token vbn_your_token_here"
```

!!! note
    Visiban uses DRF's built-in token auth, which requires the `Token` prefix — not `Bearer`.

The token works for every API endpoint its [scopes](#scopes) allow. A request it isn't scoped for is rejected with `403 Forbidden` and a message naming the scope it needs — not `401`, because the credential itself is valid.

The same header format applies regardless of the HTTP method:

```bash
# Create a card
curl -s -X POST https://your-instance.example.com/api/v1/boards/1/cards/ \
  -H "Authorization: Token vbn_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"title": "Deploy v2.3", "column": 4, "swimlane": 2}'

# Move a card
curl -s -X POST https://your-instance.example.com/api/v1/boards/1/cards/42/move/ \
  -H "Authorization: Token vbn_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"column_id": 5, "swimlane_id": 2, "position": 0}'
```

For more examples including Python and HTTPie, see the [API Authentication reference](../api/authentication.md).

---

## Revoke a token

1. Go to **Settings → Access Tokens**.
2. Find the token you want to remove.
3. Click **Revoke** next to it.

Revoked tokens are deleted immediately. Requests using them get `401 Unauthorized`.

---

## Security notes

- **Email changes need a signed-in session** — the account email is changed from Settings in the browser. Through the API (`PATCH /api/v1/auth/me/` or `/api/v1/auth/user/`), a token request that changes it answers `403 Forbidden`. Tokens can still update the other profile fields, and a request that sends your current email back unchanged is accepted.
- **Disconnecting a sign-in provider and setting a first password need a signed-in session** — removing a connected sign-in provider (`DELETE /api/v1/auth/me/connected-accounts/{provider}/`) is done from Settings in the browser, and a token request to it answers `403 Forbidden` whatever its scopes. The same goes for setting a first password on an account that has none (for example one that signs in only through a provider). Changing an existing password with your current password still works with a token.
- **Username changes need a signed-in session** — the username is a login identifier, so it is changed from Settings in the browser. Through the API (`PATCH /api/v1/auth/me/`, `/api/v1/auth/user/` or `POST /api/v1/auth/choose-username/`), a token request that changes it answers `403 Forbidden`. Tokens can still update the other profile fields, and a request that sends your current username back unchanged is accepted.
- **Password change revokes all tokens** — every PAT on your account is revoked automatically when you change your password. Create new tokens and update any scripts or integrations that used the old ones.
- **Maximum 10 tokens per user** — revoke tokens you no longer use before creating new ones. The **New token** button is disabled at the limit.
- **Treat tokens like passwords** — store them in a secrets manager or CI secrets vault, never in plain text in source code or config files committed to a repository.
- **Scopes limit a token, they never extend it** — a scope can only narrow what the token may do, never grant access your account doesn't already have. An `admin`-scoped token held by a non-admin still can't reach the admin API.
- **The same token authenticates AI agents** — if your operator has enabled the [MCP server](../api/mcp.md), a PAT is also the credential an MCP client uses to read your boards. Revoking the token, or changing your password, cuts off that access too.
- **Scopes don't limit instance-wide access** — if your account has the "access all content" privilege, a `write`-scoped token still reaches every board on the instance. Scopes constrain *what kind of operation* a token may perform, not *which boards* it can see.

---

## Full API reference

For endpoint paths, request/response shapes, and error codes, see [API Authentication](../api/authentication.md).
