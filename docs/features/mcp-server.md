# MCP Server

> **Added in 1.2**

This guide walks through connecting an AI agent — Claude Desktop or any other [Model Context Protocol](https://spec.modelcontextprotocol.io) (MCP) client — to a self-hosted Visiban instance: enabling the server, issuing a credential, and wiring up the client. For the full tool/resource reference (exact argument and return shapes, error codes), see [API Reference — MCP Server](../api/mcp.md).

## What is the Visiban MCP server?

MCP is an open protocol that lets AI assistants call tools and read resources exposed by a server, instead of relying only on what a user types into the chat. Visiban's MCP server exposes your boards, columns, swimlanes, cards, and the movement audit trail over this protocol, so an AI agent can answer questions about your pipeline and — with a suitably scoped credential — create, move, update, and archive cards on your behalf.

Any Streamable HTTP MCP client can connect: Claude Desktop, Claude.ai (via a remote MCP connector), or a custom agent built on the MCP SDK. This guide uses Claude Desktop as the worked example.

!!! note "Off by default"
    The MCP server is disabled until an operator sets `MCP_SERVER_ENABLED=true`. While it's off, `/mcp` returns `404 Not Found` and the MCP SDK is never imported.

## Prerequisites

- A Visiban 1.2+ self-hosted instance (Docker Compose or Helm) with `MCP_SERVER_ENABLED=true` set on the backend
- A Visiban account to generate a Personal Access Token (any account can generate one; which boards the token can see depends on that account's own access, not on any special admin privilege)
- An MCP-compatible AI client — Claude Desktop, or any client supporting the Streamable HTTP transport

## Generating a Bearer token

The MCP server reuses Visiban's existing [Personal Access Token](personal-access-tokens.md) system — there is no separate "API Tokens" screen in Django admin. Generate one from your own account settings:

1. Open your avatar menu (top-right) and select **Settings**.
2. Go to **Access Tokens** in the left sidebar.
3. Click **New token**.
4. Enter a descriptive name — for example, `claude-desktop`.
5. Select scopes: **`mcp:read`** is required to open an MCP session at all. Also select **`mcp:write`** if you want the agent to create, move, update, or archive cards — read-only agents can omit it.
6. Optionally set an expiry date.
7. Click **Create token**.

!!! warning "Copy your token now"
    The full token value is shown **only once**, immediately after creation. Copy it to a password manager or secret store before navigating away.

Scopes are **not** hierarchical: a token's default `read`/`write` REST scopes do not grant MCP access, and `mcp:read` does not grant `mcp:write`. A token created before 1.2 has no scopes recorded and is refused at `/mcp` even though it still works over REST — create a new token instead of reusing an old one. See [Personal Access Tokens — Scopes](personal-access-tokens.md#scopes) for the full non-hierarchical-scopes rule.

## Connecting Claude Desktop

Add a `visiban` entry to Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "visiban": {
      "type": "streamable-http",
      "url": "https://<your-visiban-host>/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

Replace `<your-visiban-host>` with your instance's hostname and `<your-token>` with the token you just copied. Restart Claude Desktop after saving the file.

Once connected, Claude Desktop shows Visiban as an active MCP server with a green status indicator. Opening the server's details lists:

- **Tools** — `list_boards`, `list_columns`, `list_swimlanes`, `list_cards`, and, if your token carries `mcp:write`, `create_card`, `move_card`, `update_card`, `archive_card`
- **Resources** — the `board` and `card` resource templates (`board://{board_id}`, `card://{card_id}`)

If the server doesn't appear, double-check the URL includes `/mcp`, the token is prefixed `Bearer ` (not `Token `), and `MCP_SERVER_ENABLED` is set on the backend.

## Available tools (OSS)

| Tool | Description | Board role required | Scope required |
|---|---|---|---|
| `list_boards` | List every board the caller can access, with effective role and counts | *(filters to accessible boards)* | `mcp:read` |
| `list_columns` | List a board's columns | any (admin, member, collaborator, viewer) | `mcp:read` |
| `list_swimlanes` | List a board's swimlanes (`contact_email` included for admin/site_admin only) | any | `mcp:read` |
| `list_cards` | List a board's cards, with optional filters | any | `mcp:read` |
| `create_card` | Create a card in a column/swimlane cell | admin, member | `mcp:read` + `mcp:write` |
| `move_card` | Move a card to a new column/swimlane/position; enforces WIP/weight limits | admin, member | `mcp:read` + `mcp:write` |
| `update_card` | Update title/description/priority/assignee/labels/due date | admin, member | `mcp:read` + `mcp:write` |
| `archive_card` | Soft-delete a card (idempotent) | admin, member | `mcp:read` + `mcp:write` |

`collaborator` and `viewer` roles can read but not write — a write tool called with either role returns a structured `permission_denied` error, not a `500`. Full argument/return shapes and every error code are documented in [API Reference — MCP Server — Tools](../api/mcp.md#tools).

## Available resources (OSS)

| Resource | URI | Description |
|---|---|---|
| Board snapshot | `board://{board_id}` | Full read-only board snapshot: metadata, columns, swimlanes, active cards, and labels — one round trip instead of three `list_*` calls. Any board role. |
| Card detail | `card://{card_id}` | Card detail plus full audit history (movements, activities, comments, checklist items). Requires board membership, any role. |

Both resources are read-only and require only the `mcp:read` scope. See [API Reference — MCP Server — Resources](../api/mcp.md#resources) for the exact response shape.

## Self-hosted / Docker Compose deployment notes

- The `/mcp` endpoint is served on the same port as the Django app — no additional container, process, or ingress rule is needed. If you terminate TLS behind a reverse proxy, disable response buffering on the `/mcp` location (the bundled Nginx templates and Helm chart already do this).
- Set `MCP_SERVER_ENABLED=true` on the backend service and restart it — the flag is off by default, so `/mcp` 404s until it's set.
- **`ALLOWED_HOSTS` / `MCP_ALLOWED_HOSTS`** guard DNS rebinding and apply to every client, browser-based or not: the `Host` header of a request to `/mcp` must match one of these. If `ALLOWED_HOSTS` is `*` (a common self-hosting shortcut), set `MCP_ALLOWED_HOSTS` explicitly to the hostname(s) clients reach `/mcp` on — a wildcard cannot serve as the rebinding allowlist.
- **`CORS_ALLOWED_ORIGINS`** only matters for a *browser-based* MCP client (for example, a custom web agent, or a future Claude.ai in-browser connector) — it controls whether a browser is allowed to read the response. A native desktop app like Claude Desktop is not subject to CORS, so this setting has no effect on it.

```yaml
# docker-compose.yml
services:
  backend:
    environment:
      MCP_SERVER_ENABLED: "true"
      # Only needed if ALLOWED_HOSTS is "*":
      # MCP_ALLOWED_HOSTS: visiban.example.com
```

## Verifying with MCP Inspector

Before wiring up an AI client, confirm the server itself is reachable with the reference [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector
# Connect to: http://localhost:8000/mcp
# Transport: Streamable HTTP
# Add header: Authorization: Bearer <token>
```

The Inspector should list the server and its tools/resources exactly as described above. If the connection fails, check the backend logs — a `401` means the token or scope is wrong, and a `404` means `MCP_SERVER_ENABLED` is not set.

## Upgrade path to enterprise

The tools, resources, and Bearer-token authentication above are the full OSS (Phase 1) surface. [Visiban Enterprise](https://visiban.com/enterprise) is planned to add OAuth 2.1 (so connecting a client no longer means managing a long-lived Bearer token by hand), analytics tools, prompt templates, and RBAC-scoped tool visibility (hiding tools a caller's role could never use, rather than returning a `permission_denied` when they're called). None of this is implemented yet — see the [API reference's roadmap note](../api/mcp.md#roadmap).
