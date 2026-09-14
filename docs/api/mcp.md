# MCP Server

Visiban can expose its boards to AI agents over the [Model Context Protocol](https://spec.modelcontextprotocol.io) (MCP). An MCP-compatible client — Claude, Copilot, or a custom agent — connects to `/mcp`, authenticates with a Personal Access Token, and calls tools that read your Visiban data.

The feature is flag-gated: `/mcp` returns `404 Not Found` unless the server is started with `MCP_SERVER_ENABLED=true`.

!!! note
    This is the Phase 1 (OSS core) surface. It is read-only and ships a single tool, `list_boards`.

---

## Enabling the server

Set the environment variable on the backend and restart it:

```bash
MCP_SERVER_ENABLED=true
```

=== "Docker Compose"
    ```yaml
    services:
      backend:
        environment:
          MCP_SERVER_ENABLED: "true"
    ```

=== "Helm"
    ```yaml
    backend:
      extraEnv:
        - name: MCP_SERVER_ENABLED
          value: "true"
    ```

When the flag is off, the app is not installed, the `/mcp` route does not exist, and the MCP SDK is never imported — an install that does not use MCP exposes no additional surface.

---

## Transport

| | |
|---|---|
| Endpoint | `/mcp` |
| Transport | Streamable HTTP (MCP spec rev `2025-03-26`) |
| Methods | `POST` |
| Session mode | Stateless |

The server runs **stateless**: every request is self-contained and no session state is pinned to a single process. This means a deployment running several backend replicas needs no sticky-session configuration.

If you terminate TLS behind a reverse proxy, the `/mcp` location must disable response buffering — the transport holds a long-lived Server-Sent Events response open, and a buffering proxy will withhold event frames. The bundled Nginx templates and the Helm chart already include a correct `/mcp` block.

### DNS rebinding protection

The transport validates the `Host` and `Origin` headers of every request against the server's `ALLOWED_HOSTS` and `CORS_ALLOWED_ORIGINS` settings. This stops a malicious web page from using DNS rebinding to reach the MCP server from a victim's browser. A request whose `Host` is not allowed is rejected with `421 Misdirected Request`. If you reach the server on a hostname the backend does not know about, add it to `ALLOWED_HOSTS`.

!!! warning "If `ALLOWED_HOSTS` is `*`"
    A wildcard cannot serve as a rebinding allowlist — the two settings guard different threats, and inheriting the wildcard would silently switch this protection off. Set `MCP_ALLOWED_HOSTS` to the hostnames clients actually reach `/mcp` on:

    ```bash
    MCP_ALLOWED_HOSTS=visiban.example.com,visiban.internal
    ```

    Until you do, the backend logs a warning at startup and only `Origin` checking (from `CORS_ALLOWED_ORIGINS`) applies. `MCP_ALLOWED_HOSTS` takes precedence over `ALLOWED_HOSTS` whenever it is set.

---

## Authentication

Every request to `/mcp` must carry a Visiban [Personal Access Token](../features/personal-access-tokens.md) in an `Authorization` header using the **`Bearer`** scheme:

```
Authorization: Bearer vbn_a3f2e1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
```

!!! warning "`Bearer` here, `Token` everywhere else"
    The REST API uses the `Token` scheme (see [Authentication](authentication.md)). `/mcp` uses `Bearer` because the MCP specification mandates it. The two schemes are not interchangeable: the REST API rejects `Bearer`, and `/mcp` rejects `Token`.

    Both resolve the **same** Personal Access Token records, so a token that is revoked, expired, or dropped by a password change stops working for MCP at the same moment it stops working for the REST API.

Create a token from **Profile → Access Tokens**, or via the API:

```bash
curl -s -X POST http://localhost:8000/api/v1/auth/tokens/ \
  -H "Authorization: Token <your-session-token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "claude-desktop", "scopes": ["mcp:read"]}'
```

The plaintext token is shown **once**, at creation. Only a SHA-256 hash is stored.

### The `mcp:read` scope is required

> **Changed in 1.2**

`/mcp` accepts a token only if it carries the **`mcp:read`** [scope](authentication.md#scopes). This is not implied by anything else:

- a token scoped `read` and `write` for the REST API is **refused** at `/mcp`
- a token created **before 1.2** (no scopes recorded) is **refused** at `/mcp`, even though it still works across the whole REST API
- `mcp:write` does not imply `mcp:read`

The reason is consent, not capability. A PAT is a credential a user is instructed to paste into an agent, and an agent is a fundamentally different kind of consumer from a shell script. Requiring a scope that can only have been chosen deliberately means no pre-existing token quietly becomes an agent credential because MCP was switched on.

Scopes never widen access: an `mcp:read` token still sees exactly the boards its owner can see, with the same roles.

A token intended for both an agent and a script needs both sets of scopes, e.g. `["read", "mcp:read"]`.

### Errors

| Status | Meaning |
|---|---|
| `401 Unauthorized` | The `Authorization` header is missing, is not the `Bearer` scheme, or the token is unknown, expired, revoked, or belongs to a deactivated account. |
| `401 Unauthorized` | The token is valid but lacks the `mcp:read` scope, or predates scopes entirely. The message names the scope required. |
| `404 Not Found` | `MCP_SERVER_ENABLED` is not set. |
| `421 Misdirected Request` | The `Host` header is not in `ALLOWED_HOSTS`. |

Authentication is enforced at the transport layer, before any MCP protocol frame is parsed — an unauthenticated caller cannot reach the protocol machinery at all. The `401` body is a JSON-RPC error envelope so that spec-compliant clients surface a useful message.

---

## Connecting a client

Point any MCP client at the endpoint with the token as a Bearer credential. For example, with the reference inspector:

```bash
npx @modelcontextprotocol/inspector
```

Then connect to `http://localhost:8000/mcp` using **Streamable HTTP** transport, adding the `Authorization: Bearer vbn_...` header. The inspector will list the server and its tools.

---

## Tools

### `list_boards`

Returns every board the authenticated user can access.

**Arguments:** none.

**Returns:** an array of objects.

| Field | Type | Description |
|---|---|---|
| `id` | integer | Board primary key, the same identifier the REST API uses. |
| `uid` | string | Stable public short id. |
| `name` | string | Board name. |
| `description` | string | Board description; empty string when unset. |
| `role` | string | The user's **effective** role on the board — see below. |
| `column_count` | integer | Number of columns. |
| `swimlane_count` | integer | Number of swimlanes. |
| `card_count` | integer | Number of **non-archived** cards. |
| `created_at` | string | ISO 8601 timestamp. |
| `updated_at` | string | ISO 8601 timestamp. |

**Example**

```json
[
  {
    "id": 12,
    "uid": "5930ca070e34672b",
    "name": "Platform Roadmap",
    "description": "Q3 delivery",
    "role": "admin",
    "column_count": 5,
    "swimlane_count": 3,
    "card_count": 42,
    "created_at": "2026-09-14T05:13:39.725480+00:00",
    "updated_at": "2026-09-14T05:13:39.725490+00:00"
  }
]
```

#### Which boards are returned

The tool applies exactly the same access rule as `GET /api/v1/boards/`, so an agent sees the same boards the user sees in the web UI. A board is included when the user owns it, holds a membership on it, inherits access through a group, or is a site admin with access to all content.

#### The `role` field

`role` is the user's *effective* role, not a raw membership row. It is one of:

| Value | Meaning |
|---|---|
| `admin` | Board admin, or the board's owner. |
| `member` | Can create, edit, move, and delete cards. |
| `collaborator` | Read-only on cards; may comment and attach. |
| `viewer` | Read-only. |
| `site_admin` | A site administrator with access to all content. Not a board membership — it is not revocable per board. |

Group-inherited access reports the role inherited from the group.

---

## Roadmap

Phase 1 (this release) covers connectivity, authentication, and board discovery. Card and board write tools, MCP resources, and a full setup guide are tracked separately. Analytics tools and OAuth 2.1 are planned for the Enterprise edition.
