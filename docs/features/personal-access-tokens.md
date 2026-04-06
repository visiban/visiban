# Personal Access Tokens

Personal Access Tokens (PATs) let you authenticate API requests from scripts, CI pipelines, and integrations without sharing your password or relying on a browser session cookie. Each token acts on your behalf with your full access rights.

When to use a PAT:

- **Scripts** — automate card creation, moves, or exports from a shell script or cron job
- **CI/CD pipelines** — trigger board updates from your deployment pipeline
- **Integrations** — connect external tools that call the Visiban API directly
- **Local development** — test API calls quickly without maintaining a session

For interactive use in a browser, the session-based login is used automatically and no token is needed.

---

## Create a token

1. Open your avatar menu (top-right) and select **Settings**.
2. Go to **Access Tokens** in the left sidebar.
3. Click **New token**.
4. Enter a descriptive name — for example, `deploy-script` or `ci-pipeline`.
5. Optionally set an expiry date (see [Expiry](#expiry) below).
6. Click **Create token**.

!!! warning "Copy your token now"
    The full token value is shown **only once** — immediately after creation. Once you navigate away, Visiban stores only a secure hash and cannot show the token again. Copy it to a password manager or secret store before leaving the page.

Tokens are prefixed with `vbn_` so they are easy to identify in logs and configuration files. The full format is `vbn_` followed by 40 hex characters (44 characters total), generated with `secrets.token_hex`. Integrators can validate this with the regex `^vbn_[0-9a-f]{40}$`.

---

## Identifying tokens after creation

Because the full token value is shown only once, the Access Tokens list identifies each token by its **prefix** — the first 8 characters of the raw value (e.g. `vbn_a3f1...`). Combined with the name you gave the token and the **last used** timestamp, this is usually enough to tell tokens apart.

The **Last used** column shows when the token was last used to authenticate an API request. Tokens that have never been used show "Never".

---

## Expiry

The expiry date is optional:

- **Leave blank** — the token never expires and remains valid until revoked manually or your password changes.
- **Set a date** — the maximum allowed expiry is **one year from today**. After the expiry date the token is rejected with `401 Unauthorized`.

Expired tokens remain visible in the Access Tokens list and can be revoked there.

---

## Use a token in API requests

Pass the token in the `Authorization` header using the `Token` scheme:

```bash
curl -s https://your-instance.example.com/api/v1/boards/ \
  -H "Authorization: Token vbn_your_token_here"
```

!!! note
    Visiban uses DRF's built-in token auth, which requires the `Token` prefix — not `Bearer`.

The token works for all API endpoints that accept authenticated requests. The same header format applies regardless of the HTTP method:

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

Revoked tokens are deleted immediately. Any request using the revoked token will receive `401 Unauthorized`.

---

## Security notes

- **Password change revokes all tokens** — when you change your password, every PAT associated with your account is revoked automatically. You will need to create new tokens and update any scripts or integrations that use them.
- **Maximum 10 tokens per user** — if you reach the limit, revoke tokens you no longer use before creating new ones. The **New token** button is disabled when the limit is reached.
- **Treat tokens like passwords** — store them in a secrets manager or CI secrets vault, never in plain text in source code or config files committed to a repository.
- **Scope** — a PAT carries your full access rights. It can read and write every board, card, and group you have access to. There is no scope restriction at creation time.

---

## Full API reference

For endpoint paths, request/response shapes, and error codes, see [API Authentication](../api/authentication.md).
