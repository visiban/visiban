# Let an AI agent read and write your boards over MCP

Set `MCP_SERVER_ENABLED=true`, create a Personal Access Token with the `mcp:read` scope, and point an MCP client at `/mcp`.

```bash
MCP_SERVER_ENABLED=true   # backend environment; restart the backend
# client header:
# Authorization: Bearer vbn_0123456789abcdef0123456789abcdef01234567
```

**Why it matters:** the server is off by default, and `/mcp` returns `404 Not Found` until you enable it.

**Watch out:** `/mcp` takes `Bearer`, while the REST API takes `Token`. Write tools also need the `mcp:write` scope. See [Authentication](#authentication).

**Go deeper:** [Enabling the server](#enabling-the-server), [Connecting a client](#connecting-a-client), [Tools](#tools), [Resources](#resources), [Stability and versioning](#stability-and-versioning) (the last section before the roadmap).

**The big picture:** Visiban can expose its boards to AI agents over the [Model Context Protocol](https://spec.modelcontextprotocol.io) (MCP). An MCP-compatible client — Claude, Copilot, or a custom agent — connects to `/mcp`, authenticates with a Personal Access Token, and calls tools that read and write your Visiban data.

The feature is flag-gated: `/mcp` returns `404 Not Found` unless the server is started with `MCP_SERVER_ENABLED=true`.

!!! note
    This is the Phase 1 (OSS core) surface: board discovery, full card CRUD, and the `board://`/`card://` resources below. A full setup guide is tracked separately.

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
    > **Added in 1.3**

    Set the chart value in the values file you pass on every install and upgrade:

    ```yaml
    backend:
      settings:
        mcpServerEnabled: true
    ```

    ```bash
    helm upgrade --install visiban helm/visiban -f my-values.yaml
    ```

    Chart versions before 0.8.0 (Visiban 1.2 and earlier) reject this key.

    The chart's frontend proxy already forwards `/mcp` to the backend.

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

If you terminate TLS behind a reverse proxy, the `/mcp` location must disable response buffering: the transport holds a long-lived Server-Sent Events response open, and a buffering proxy withholds event frames. The bundled Nginx templates and the Helm chart already include a correct `/mcp` block.

### DNS rebinding protection

The transport checks every request's `Host` and `Origin` headers against `ALLOWED_HOSTS` and `CORS_ALLOWED_ORIGINS`, which stops a malicious web page from using DNS rebinding to reach the MCP server from a victim's browser. A request whose `Host` is not allowed gets `421 Misdirected Request`. If you reach the server on a hostname the backend does not know, add it to `ALLOWED_HOSTS`.

!!! warning "If `ALLOWED_HOSTS` is `*`"
    A wildcard cannot serve as a rebinding allowlist: the two settings guard different threats, and inheriting the wildcard would silently switch this protection off. Set `MCP_ALLOWED_HOSTS` to the hostnames clients actually reach `/mcp` on:

    ```bash
    MCP_ALLOWED_HOSTS=visiban.example.com,visiban.internal
    ```

    Until you do, the backend logs a warning at startup and only `Origin` checking (from `CORS_ALLOWED_ORIGINS`) applies. `MCP_ALLOWED_HOSTS` takes precedence over `ALLOWED_HOSTS` whenever it is set.

    On Helm, the chart has no value for `MCP_ALLOWED_HOSTS`. Remove `*` from `backend.settings.allowedHosts` instead: the chart's render guard already refuses a catch-all entry unless `backend.settings.allowUnsafeHosts` is `true`.

---

## Authentication

Every request to `/mcp` must carry a Visiban [Personal Access Token](../features/personal-access-tokens.md) in an `Authorization` header using the **`Bearer`** scheme:

```
Authorization: Bearer vbn_0123456789abcdef0123456789abcdef01234567
```

!!! warning "`Bearer` here, `Token` everywhere else"
    The REST API uses the `Token` scheme (see [Authentication](authentication.md)). `/mcp` uses `Bearer` because the MCP specification mandates it. The two schemes are not interchangeable: the REST API rejects `Bearer`, and `/mcp` rejects `Token`.

    Both resolve the **same** Personal Access Token records, so a token that is revoked, expired, or dropped by a password change stops working for MCP at the same moment it stops working for the REST API.

In the web app, open Settings > Access Tokens, tick **mcp:read** (add **mcp:write** for write tools) and generate the token. A token made with only the default `read` and `write` scopes is refused at `/mcp`. Or create it via the API:

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

The reason is consent, not capability. Users paste a PAT into an agent, a different kind of consumer from a shell script. Requiring a scope that can only have been chosen deliberately means no pre-existing token quietly becomes an agent credential because MCP was switched on.

Scopes never widen access: an `mcp:read` token still sees exactly the boards its owner can see, with the same roles.

A token intended for both an agent and a script needs both sets of scopes, e.g. `["read", "mcp:read"]`.

### Write tools additionally require `mcp:write`

> **Added in 1.2**

`mcp:read` opens a session and is enough for every read tool below. Any **write** tool (`create_card`, `move_card`, `update_card`, `archive_card`, `block_card`, `unblock_card`) additionally requires **`mcp:write`** on the same token. Scopes are non-hierarchical: `mcp:read` does not grant `mcp:write`, and `mcp:write` alone does not even open a session (a token needs `mcp:read` to reach `/mcp` at all). A write-capable agent credential therefore needs **both**: `["mcp:read", "mcp:write"]`.

Unlike a missing `mcp:read` (rejected at the transport, before any tool runs), a missing `mcp:write` is reported by the tool as a [tool error](#tool-errors): an `isError: true` result carrying `{"error": {"code": "missing_scope", "detail": "..."}}`, not a `401`. The session is valid; only that call was declined.

### Errors

| Status | Meaning |
|---|---|
| `401 Unauthorized` | The `Authorization` header is missing, is not the `Bearer` scheme, or the token is unknown, expired, revoked, or belongs to a deactivated account. |
| `401 Unauthorized` | The token is valid but lacks the `mcp:read` scope, or predates scopes entirely. The message names the scope required. |
| `403 Forbidden` | The token's account has a pending forced change (`must_change_password` or `must_change_username`). Same message as the REST API; the MCP error also carries `error.data.code` (`must_change_username` for the username case); change the password or choose a username in the web app, then retry. |
| `404 Not Found` | `MCP_SERVER_ENABLED` is not set. |
| `421 Misdirected Request` | The `Host` header is not in `ALLOWED_HOSTS`. |

Authentication is enforced at the transport layer, before any MCP protocol frame is parsed, so an unauthenticated caller never reaches the protocol machinery. The `401` body is a JSON-RPC error envelope, so spec-compliant clients surface a useful message.

### Protocol errors and limits

> **Changed in 1.2** (MCP SDK 2.3.0). In the `Accept` row, only wildcard handling changed.

These responses come from the MCP SDK rather than from a Visiban tool, so a client should handle them in addition to the [tool errors](#tool-errors):

| Situation | Response |
|---|---|
| Unknown JSON-RPC method | JSON-RPC error `-32601` (Method not found). Earlier pre-releases returned `-32602`. |
| `resources/read` fails inside the server | JSON-RPC error `-32603` (Internal error), with a short message. Earlier pre-releases returned code `0`. |
| `resources/read` for an unknown URI | JSON-RPC error `-32602` (Invalid params). |
| Request body larger than 4 MiB | `413`, before the body is parsed. |
| `Accept` header that does not accept both `application/json` and `text/event-stream`, including a missing, JSON-only or event-stream-only one | `406`. Wildcards are accepted: `*/*`, or `application/*` together with `text/*` (the 1.30.0 SDK returned `406` for `*/*`). Send `Accept: application/json, text/event-stream` on every `POST`, as spec-compliant clients do. |
| Transport-level error | JSON-RPC error with `id: null`. Earlier pre-releases used the string `"server-error"`. |

`serverInfo.version` reports the Visiban app version, not the SDK version.

---

## Rate limiting

> **Added in 1.2**

DRF's request throttles (`DEFAULT_THROTTLE_RATES`) never apply to `/mcp`: the MCP server is mounted in-process at the ASGI level and calls tool functions directly, not through a DRF view. `/mcp` has its own per-token limiter, keyed on the presented Personal Access Token (never on IP or the raw token value). Limits therefore hold whatever network or proxy a caller uses, and across every backend replica, because they share the cache backend the REST throttles use.

Two limits stack on every call:

| Bucket | Applies to | Default | Setting |
|---|---|---|---|
| Baseline (read) | Every tool call and every resource read | `300/min` per token | `MCP_THROTTLE_READ_RATE` |
| Compute | `list_cards` and `board://{board_id}` only, **in addition to** the baseline limit above | `30/min` per token | `MCP_THROTTLE_COMPUTE_RATE` |

A call to `list_cards` or `board://{board_id}` spends a unit from **both** buckets; every other tool/resource spends only the baseline unit. There is no `DEBUG`-time bypass: unlike the REST throttle rates, these apply in local development too, since a runaway agent loop is exactly what the compute bucket exists to catch.

This applies uniformly to every token, including a site admin's — there is no admin exemption from the throttle, unlike maintenance mode.

Both settings accept the same `<count>/<period>` syntax as DRF's throttle rates (`m`/`min`, `h`/`hour`, `s`/`sec`, `d`/`day` — e.g. `"300/min"`, `"20/hour"`). Leaving both unset still gives the defaults above, not an unlimited server. A rate string that fails to parse raises `ImproperlyConfigured` at startup rather than silently disabling the limit.

```bash
MCP_THROTTLE_READ_RATE=300/min
MCP_THROTTLE_COMPUTE_RATE=30/min
```

### Failed-authentication limit (per IP)

> **Added in 1.2** (#1679)

The per-token limits above only apply once a token has resolved, so they cannot slow a caller who keeps presenting invalid tokens. `/mcp` therefore also applies an approximate per-IP limit to **failed** token lookups:

| Bucket | Applies to | Default | Setting |
|---|---|---|---|
| Pre-auth failures | Requests whose Bearer token is unknown, revoked, expired, or otherwise fails lookup (HTTP `401`) | `30/min` per client IP | `MCP_THROTTLE_PREAUTH_RATE` |

Only failed lookups spend this budget. A valid token that merely lacks the `mcp:read` scope is not counted, and neither are successful requests, but the check runs before the lookup for every request. Once an IP has used its budget, further requests from it, **valid ones included**, are answered `429` (a `Retry-After` header and a JSON-RPC error with `data.code: "throttled"` and `data.retry_after`) until the window slides. Valid agents that share an IP with a client that keeps failing (an agent looping on a revoked token, or a hostile host behind the same NAT) are therefore blocked too. This is a best-effort brake on guessing, not a hard cap: the counter is approximate, and concurrent or multi-replica failures can exceed the budget or lose counts. The client IP is resolved with the same `NUM_PROXIES` logic as the REST throttles; set `NUM_PROXIES` to match your proxy chain or all clients behind a proxy will share one bucket. The setting is optional, uses the same `<count>/<period>` syntax as the others, and an unparseable value raises `ImproperlyConfigured`. Like the per-token buckets, the limiter fails closed: if the cache backend is unavailable the request errors rather than skipping the check.

### Throttled tool calls

A tool call over its limit returns a structured [tool error](#tool-errors) (`isError: true`), exactly like every other tool-level error — never a `429` or a transport-level failure. The error payload is:

```json
{
  "error": {
    "code": "throttled",
    "detail": "Rate limit exceeded for this token (mcp_read). Retry after 12 second(s).",
    "retry_after": 12
  }
}
```

`retry_after` is a whole number of seconds; an agent should wait at least that long before retrying the same call.

### Throttled resource reads

Resources have no structured-error return path (see [Resource errors](#resource-errors) below), so a throttled `board://`/`card://` read surfaces the same way any other resource failure does: as a JSON-RPC-level error whose message includes the retry hint, e.g. `Rate limit exceeded for this token (mcp_compute). Retry after 4 second(s).` — rather than as a `{"error": {...}}` payload in the resource's content.

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

### Tool errors

> **Added in 1.2**

A tool that can fail for a reason other than "your token can't reach `/mcp` at all" (a bad id, a role or scope that may not write, a WIP limit) returns a structured error as its tool result — never a `500`, and never an unstructured exception message. The error payload has a top-level `error` key instead of the tool's normal payload:

```json
{
  "error": {
    "code": "wip_limit_exceeded",
    "column_name": "In Progress",
    "current_count": 3,
    "wip_limit": 3
  }
}
```

#### Result envelope

> **Changed in 1.2** (before GA, #2004)

A failed call is a `CallToolResult` with `isError: true`. The error payload above is in `structuredContent` under `result`, exactly where a successful call puts its payload, and the same payload is repeated as a single JSON text block in `content`:

```json
{
  "isError": true,
  "structuredContent": {
    "result": {
      "error": {"code": "board_not_found", "detail": "No Board matches the given query."}
    }
  },
  "content": [
    {"type": "text", "text": "{\n  \"error\": {\n    \"code\": \"board_not_found\", ..."}
  ]
}
```

A successful call has `isError: false` and its payload in `structuredContent.result`. Clients that check `isError` see every Visiban failure as a failure, and on a tool error clients that read `structuredContent` get every field (`code`, counters, `retry_after`, ...) just as they get the payload on success. The advertised `outputSchema` is unchanged, and an error result still conforms to it (its `result` is an object). The MCP Python SDK's client checks `structuredContent` against `outputSchema` only when `isError` is `false`.

*Changed in 1.2 (before GA, #2004): the 1.2 pre-releases returned these errors with `isError: false`. The payload, its location and its text block did not change; only `isError` did. Verified against the MCP Python SDK `mcp` 2.3.0, which passes a tool's error result through with its `structuredContent` intact.*

`isError: true` does not always come with a structured payload. There are two kinds of failure result:

- **Tool errors** (everything in the table below): `isError: true`, with the `{"error": {...}}` payload in `structuredContent.result` and in the text block.
- **Failures outside Visiban's tool code**: arguments that do not match a tool's input schema (a missing required argument, or a string where an integer is expected), which the SDK rejects before any Visiban code runs, and an unexpected server-side exception. Both are `isError: true` with a single text message and **no** `structuredContent`, so no `code`.

A client must check that `structuredContent` is present before reading an error `code` from it, and treat an `isError: true` result without one as a generic failure.

Every error has a `code` your agent can branch on, and the table below is the complete set. Codes are never removed; new ones may be added in a minor release, so treat an unrecognized `code` as a generic failure rather than crashing. Most errors also carry a human-readable `detail`. Exactly six codes do not: `wip_limit_exceeded`, `weight_limit_exceeded`, `swimlane_wip_limit_exceeded` and `swimlane_weight_limit_exceeded` carry only their own fields (`column_name`, `swimlane_name` for the swimlane codes, and the counters), `validation_error` carries an `errors` object, and `card_creation_not_allowed` carries a `column` message. `internal_error` carries `code` plus whatever fields the underlying error has, normally `detail`. Branch on `code`, never on `detail`.

| `code` | Meaning |
|---|---|
| `board_not_found` | The board id does not exist, or exists but you have no role on it (identical either way — Visiban never confirms a board id you cannot see). |
| `card_not_found` | Same, for a card id. |
| `column_not_found` | `move_card` and `create_card`. The column id does not exist, or belongs to a different board than the one you named. Identical either way. At create time an unresolvable column id is normally a `validation_error` (`errors.column`) from input validation; this code occurs there only when the column, or its board, is deleted while the request is in flight. |
| `swimlane_not_found` | `move_card` and `create_card`. Same, for a swimlane id (`errors.swimlane` at create time; this code only when the swimlane is deleted mid-request). |
| `object_not_found` | Reserved generic not-found code for a lookup with no more specific code above. |
| `permission_denied` | Your board role is `collaborator` or `viewer`; card writes require `admin` or `member`. Also returned by `update_card`, `archive_card`, `block_card` and `unblock_card` when your role only allows changing cards you created, and by `move_card` when the card is assigned to someone else and your role is below moderator. |
| `force_not_permitted` | Reserved: no tool currently exposes `force`. A `force` override of a WIP or weight limit was requested by someone who is not a board admin. |
| `invalid_version` | Reserved: `version` (on `move_card` and `update_card` since 1.3) is schema-typed as an integer, so this is not currently reachable. The supplied `version` is not an integer. |
| `invalid_position` | Reserved: `position` is schema-typed as an integer, so this is not currently reachable. The supplied move `position` is not an integer. |
| `card_creation_not_allowed` | `create_card` targeted a column that has card creation turned off. Carries a `column` message instead of `detail`: `{"column": "Card creation is not allowed in this column.", "code": "card_creation_not_allowed"}`. |
| `container_changed` | Reserved: no MCP tool deletes containers. A column, swimlane, or board kept gaining cards while it was being locked for deletion; nothing was deleted. Retry. |
| `use_move_endpoint` | Reserved: no tool currently emits it, because `update_card` takes no column, swimlane, or position. An update tried to change a card's column, swimlane, or position. Use `move_card` instead. |
| `card_already_blocked` | `block_card` on a card that already has an open manual block. Nothing changed; unblock it first. Added in 1.3 (#1149). |
| `card_not_blocked` | `unblock_card` on a card with no open manual block. A `blocks` relation to another card is not a manual block and is not cleared by `unblock_card`. Added in 1.3 (#1149). |
| `internal_error` | A tool error with no registered code. Should not occur; report it as a bug. |
| `demo_read_only` | The instance is a shared demo (`DEMO_MODE`) and every MCP write is refused. |
| `missing_scope` | Your token lacks the `mcp:write` scope required for this tool — see above. |
| `maintenance_mode` | The instance is in [maintenance mode](admin.md#maintenance-mode) and your token does not belong to a site admin. Only ever returned by the write tools below (`create_card`, `move_card`, `update_card`, `archive_card`, `block_card`, `unblock_card`) — the read tools (`list_boards`, `list_columns`, `list_swimlanes`, `list_cards`) keep working regardless. Added in 1.2. |
| `throttled` | Your token has exceeded its per-token rate limit. Carries a `retry_after` (seconds) — see [Rate limiting](#rate-limiting). Added in 1.2. |
| `validation_error` | A field failed validation — includes an `errors` object keyed by field name, e.g. an `assignee` username or label name that does not resolve to an assignable board member/label, or an `assignee`, `labels`, `label` or `priority` argument that contains a NUL (0x00) character (refused before any lookup, #2033). Every unresolved `assignee` returns the same message, whether the username does not exist, belongs to someone with no role on the board, or belongs to a `viewer` (who cannot be assigned). |
| `wip_limit_exceeded` / `wip_hard_blocked` | The target column is at its WIP limit. Returned by `move_card` and, since 1.2 (#1428), `create_card`. Neither tool overrides either — there is no `force` option over MCP. |
| `weight_limit_exceeded` | The target column is at its weight limit (`move_card`, and `create_card` since 1.2). |
| `swimlane_wip_limit_exceeded` / `swimlane_wip_hard_blocked` | The target swimlane is at its own WIP limit (`move_card`, `create_card`). Same fields as the column codes plus `swimlane_name`; `column_name` names the target cell's column and the counters are the swimlane's. A move between two columns that both count toward the swimlane's limit never returns it. When a column and a swimlane limit both trip, the stricter one is returned (hard before soft, the column first when equal). *Added in 1.3 (#1150).* |
| `swimlane_weight_limit_exceeded` | The target swimlane is at its own weight limit (`move_card`, `create_card`; `update_card` takes no `weight`, so it never returns this). Same fields as `weight_limit_exceeded` plus `swimlane_name`. *Added in 1.3 (#1150).* |
| `version_conflict` | `move_card`, `update_card`, and `create_card` when `position` is given. For `move_card` and `update_card`, the `version` you passed no longer matches the card (*Added in 1.3, #1974*; see [Optimistic concurrency](#optimistic-concurrency)), or, for `move_card` only, the card kept changing under concurrent writes while the server retried locking it, which can happen without a `version`. Nothing was changed; `current_version` is the card's version now. Re-read the card and retry. For `create_card`, cards kept entering the target column/swimlane cell while the server retried locking it. Nothing was created, so there is no card to report: `current_version` is `null` and `detail` says so. Retry the same call. Added in 1.2 (#1522). |

### User fields

Users are identified by username and display name, matching the REST API. Every user-bearing field in tool and resource output — a card's `assignee`, a movement's `moved_by`, an activity's `actor`, and a comment's `author` — is either `null` or a `{username, display_name}` object, the same `username`/`display_name` pair the REST API embeds for board members. `display_name` is an empty string when the user has not set one.

The `assignee` argument of `list_cards`, `create_card`, and `update_card` takes a username, matched case-insensitively.

*Changed in 1.2 (before GA, #1671): the 1.2 pre-releases reported these fields as email address strings and took the `create_card`/`update_card` assignee as `assignee_email`; that argument is now `assignee`. The `list_cards` `assignee` filter kept its name but now matches a username instead of an email address, so an email value returns no cards rather than an error.*

*Changed in 1.2 (before GA, #2004): `assignee_email` is no longer listed in the `create_card`/`update_card` input schema. A call that passes it with any non-null value, including an empty string, is rejected with an `isError: true` [tool error](#tool-errors), code `validation_error`, `errors` `` {"assignee_email": ["This argument was replaced by `assignee` (a username)."]} ``, and nothing is created or changed. An explicit `"assignee_email": null` is ignored, and the call runs as if the argument were absent. For clients of v1.2.0-beta.2 through rc.1, which already rejected a non-null value and ignored `null` the same way, only `isError` changed. For clients of v1.2.0-beta.1 and earlier, where `assignee_email` was the working email-based assignee argument, it no longer assigns anyone: send `assignee` (a username) instead. Other arguments a tool does not declare are ignored by the MCP SDK (`mcp` 2.3.0), not rejected.*

### Stable identifiers (`uid`)

> **Added in 1.3** (#1974)

Every board, column, swimlane, label, and card in tool and resource output carries a `uid` next to its integer `id` (`archive_card`, which returns no card object, carries it as `card_uid` next to `card_id`): the 16-character [stable UID](../features/stable-uids.md) the REST API, the [WebSocket frames](websockets.md) (`card_uid`, `column_uid`, ...) and the [change feed](events.md) use. Use `uid` to match an MCP card to a `card.*` event or a REST card, and as the key in any external system. Tool arguments still take the integer `id`s, unchanged.

A movement has no `uid` of its own (its integer `id` identifies it), but it carries the `from_column_uid`, `to_column_uid`, `from_swimlane_uid`, and `to_swimlane_uid` snapshots REST's movement history serves, which survive a rename or delete of the column or swimlane.

*Changed in 1.3 (#1974): before 1.3 only `list_boards` returned a `uid`. The new keys are additive; no existing key changed.*

### Optimistic concurrency

> **Added in 1.3** (#1974)

Every card object in tool and resource output (from `list_cards`, `create_card`, `move_card`, `update_card`, `board://` and `card://`) carries `version`, a counter that goes up on every field update, every block or unblock (since 1.3), and every move of the card, over MCP or REST. Pass it back as the optional `version` argument of `move_card` or `update_card` to make the write conditional: if the card changed since you read it, the call returns a `version_conflict` [tool error](#tool-errors) carrying `current_version`, and nothing is written or broadcast. Omit `version` and the call behaves exactly as before 1.3, with no check.

`move_card`'s `version` is the REST move endpoint's `version` body field, with the same semantics and the same error. The REST `PATCH`/`PUT` card endpoints still neither accept nor check `version`; the conditional update exists on the MCP `update_card` tool only.

A successful `create_card`, `move_card`, or `update_card` returns the card with its new `version`, which is the one to send on the next write.

### `list_columns`

Lists a board's columns, ordered by position. All board roles may call it.

**Arguments:** `board_id` (integer, required).

**Returns:** an array of `{id, uid, name, position, color, wip_limit, policy, card_count}` — `card_count` excludes archived cards; `uid` is new in 1.3 (see [Stable identifiers](#stable-identifiers-uid)). `wip_limit` is checked by both `move_card` and `create_card` (since 1.2, #1428); only a board import can leave `card_count` above it (see [Field Enforcement](../architecture/field-enforcement.md)). `policy` (since 1.3, #1101) is the column's written entry criteria and definition of done, `{"v": 1, "entry": [...], "done": [...], "mode": "advisory" | "confirm"}`, or `null`; it is [advisory](../features/column-policies.md), so `move_card` never refuses a move because of it — read it before moving a card if you want to follow the team's policy.

### `list_swimlanes`

Lists a board's swimlanes, ordered by position. All board roles may call it.

**Arguments:** `board_id` (integer, required).

**Returns:** an array of `{id, uid, name, position, color, card_count, is_collapsed, wip_limit, weight_limit}` (`uid` since 1.3; `wip_limit` and `weight_limit`, the swimlane's own limits or `null`, since 1.3, #1150), plus `contact_email` for `admin`/`site_admin` callers only — a `collaborator`/`viewer` response simply omits that key, matching the same admin-only visibility the web UI already applies to swimlane contact info.

### `list_cards`

Lists a board's cards, ordered by column position, then swimlane position, then card position, with ties broken by id so paging is stable. (The REST card list orders by `position` then id by default; the MCP ordering is the board's visual reading order.) All board roles may call it. A call returns at most 200 cards. When more cards match than were returned, the result says so in-band: the array is unchanged, but the result's content gains one extra text block, `Showing N of M cards; call again with offset=K`, and its `_meta` carries `{"visiban/total": M, "visiban/truncated": true}`. A complete result has neither. Page past the cap with `limit`/`offset`. Pass `include_meta: true` to get the total and flag in the returned data itself.

**Trade-off for clients:** because the card array has no room for a flag, the notice is a plain text block after the per-card JSON blocks, and only on truncated calls. A client that JSON-parses every content block will hit one non-card block then; `structuredContent` (`{"result": [...]}`) is unchanged and is the machine-readable path. A `limit` of `0` is a total-only request and gets no notice; use `include_meta` for the total.

`limit`/`offset` and the totals mirror the REST `GET /api/v1/boards/{board_id}/cards/` endpoint's `X-Total-Count` / `X-Truncated` headers and `limit`/`offset` query params, with the same bounds. The names are deliberate: `limit` and `total`/`truncated` match the card list's own `?limit=` and headers (a second pagination style by design, see the [API overview](index.md)), and MCP `total` corresponds to the paginated REST envelope's `count` and to the `X-Total-Count` header.

**Arguments:** `board_id` (integer, required); `column_id`, `swimlane_id` (integers), `assignee` (username, case-insensitive), `priority`, `label` (name) — all optional filters, ANDed together; `include_archived` (boolean, default `false`); `limit` (integer, default and maximum `200`; a larger value is clamped to `200`, as in REST); `offset` (integer, default `0`); `include_meta` (boolean, default `false`). A negative `limit`, or an `offset` above 2^62, returns a `validation_error`; a negative `offset` is treated as `0`, as on every REST endpoint (*1.2, #1823*), while a non-numeric `offset` is rejected by the input schema like any mistyped argument. The tool's input schema coerces numeric strings, whole numbers and JSON booleans (`"5"`, `5.0`, `true` becomes `1`) to integers and rejects non-numeric or fractional values (`"abc"`, `5.5`) with an `isError` result.

**Deliberate differences from REST:** the MCP tool filters by names an agent can read, where REST filters by integer ids. `assignee` is a username (REST `?assignee=` takes a user id) and `label` is a label name (REST `?label=` on the cross-board `GET /api/v1/cards/` takes a label id; the board-scoped list has no label filter). The `unassigned` and `overdue` filters exist only on the board-scoped REST list (`GET /api/v1/boards/{board_id}/cards/`); the cross-board `GET /api/v1/cards/` and this tool do not have them. To find unassigned cards over MCP, list the cards and check for `assignee: null`.

*Changed in 1.2: `limit`, `offset` and `include_meta` are new and optional, and the card fields are unchanged. A call that omits them returns the same array as before; the only difference is the in-band notice and `_meta` on a call that was truncated (#1762).*

**Returns:** by default, an array of `{id, uid, version, title, description, priority, assignee, labels, column, swimlane, due_date, position, created_at, updated_at, blocked_at, blocked_reason}`. `assignee` is a `{username, display_name}` object or `null` (see [User fields](#user-fields)); `labels` is an array of names; `column`/`swimlane` are `{id, uid, name}` objects so a result can be fed straight into `move_card`. `uid`, `version`, and the `uid` inside `column`/`swimlane` are new in 1.3 (#1974; see [Stable identifiers](#stable-identifiers-uid) and [Optimistic concurrency](#optimistic-concurrency)). `blocked_at` (ISO 8601, or `null`) and `blocked_reason` (`""` when not blocked) are the card's manual blocked state, *added in 1.3* (#1149; see [`block_card`](#block_card)).

With `include_meta: true`, an object instead (and no in-band notice, since the data carries the signal): `{cards, total, truncated, limit, offset}`. `cards` is the same array described above; `total` is the number of cards matching the filters, ignoring `limit`/`offset`; `truncated` is `true` when more matching cards exist after the returned ones (fetch them with a larger `offset`); `limit` and `offset` echo the values applied.

### `create_card`

Creates a card, appended to the end of its column/swimlane cell (or inserted at `position` if given). Requires `admin` or `member` board role and the `mcp:write` scope.

**Arguments:** `board_id`, `column_id`, `swimlane_id`, `title` (required); `description`, `priority` (default `"medium"`), `assignee` (username of any board member whose role is not `viewer`), `labels` (array of names), `due_date` (`YYYY-MM-DD`), `position` — all optional.

**Returns:** the created card, same shape as one row of `list_cards`. Writes a `CardMovement` record with no "from" column (matching how the REST API records card creation) and broadcasts `card.created` on the board's WebSocket channel. The broadcast frame (and its [change-feed](events.md) row) carries the full card exactly as a REST create sends it, not the tool's return shape above; when `position` is given and differs from the position the card was appended at, the follow-up reorder also sends a `card.moved` frame (`{card}`, with no `movement`, plus since 1.3 the [`sibling_positions`](websockets.md#sibling-positions-on-cardmoved-since-13) of the cards it shifted). *Fixed in 1.2 (#1926): the frame carried the tool's return shape, which web clients could not apply.*

With `position`, the create and the reorder are one transaction: if the call returns an error, no card was created and no frame was sent, so it is safe to retry. *Fixed in 1.2 (#1992): a reorder that failed left the card created behind the error, and a retry created a duplicate.*

Enforces the column's and the swimlane's WIP and weight limits exactly as `move_card` does, with no override: a create into a full column returns `wip_limit_exceeded`/`wip_hard_blocked`/`weight_limit_exceeded`, a create into a full swimlane (when the target column counts toward its limits) returns `swimlane_wip_limit_exceeded`/`swimlane_wip_hard_blocked`/`swimlane_weight_limit_exceeded`, and nothing is written. When both trip, the stricter one is returned (hard before soft, the column first when equal). *Changed in 1.2 (#1428): creates were not checked before. Changed in 1.3 (#1150): swimlane limits.*

### `move_card`

Moves a card to a new column and/or swimlane and/or position. Requires `admin` or `member` board role and the `mcp:write` scope.

**Arguments:** `card_id` (required); `to_column_id`, `to_swimlane_id` — at least one required, the other defaults to the card's current value; `position` (default `0`); `version` (integer, optional, *added in 1.3*): the card's `version` from a prior read, which makes the move fail with `version_conflict` if the card changed since (see [Optimistic concurrency](#optimistic-concurrency)).

**Returns:** `{"card": <card>, "movement": <movement-or-null>}`. `movement` is `null` for a pure position reorder within the same cell (no column/swimlane change); otherwise it carries `{id, from_column, to_column, from_swimlane, to_swimlane, from_column_uid, to_column_uid, from_swimlane_uid, to_swimlane_uid, moved_at, moved_by, imported_from_username}`. The four `*_uid` keys (*added in 1.3*) are the column and swimlane UIDs captured when the movement was written, `null` where the matching name is `null` (no "from" cell on a creation row) or where an old row predates UID capture. `imported_from_username` is `null` except on a row created by a board import with history (since 1.2), where it holds the username the import file named and `moved_by` is the user who imported it. Enforces the board's WIP/weight limits exactly as the REST move endpoint does, with no override — a blocked move returns `wip_limit_exceeded`/`wip_hard_blocked`/`weight_limit_exceeded` rather than moving the card.

Broadcasts `card.moved` with the same payload as the REST move endpoint (`{card, movement}`, full card and movement objects, `movement` omitted for a same-cell reorder), plus since 1.3 the [`sibling_positions`](websockets.md#sibling-positions-on-cardmoved-since-13) of the cards the move renumbered, not the tool's return shape. *Fixed in 1.2 (#1926).*

### `update_card`

Updates one or more fields on a card. Requires `admin` or `member` board role and the `mcp:write` scope.

**Arguments:** `card_id` (required); any of `title`, `description`, `priority`, `assignee` (username), `labels`, `due_date` — omitted fields are left unchanged. `labels: []` clears every label; `assignee: ""` unassigns the card. Cannot change a card's column or swimlane — use `move_card`. `version` (integer, optional, *added in 1.3*): the card's `version` from a prior read; the update then fails with `version_conflict`, changing nothing, if the card changed since (see [Optimistic concurrency](#optimistic-concurrency)).

**Returns:** the updated card, same shape as `create_card`. Records a `CardActivity` audit entry per field that actually changed. Broadcasts `card.updated` with the full card, as a REST update does, not the tool's return shape. *Fixed in 1.2 (#1926).*

### `block_card`

> **Added in 1.3** (#1149)

Marks a card manually blocked, with a reason, so its blocked time is measured and can be grouped by reason. Same rules as the REST [block endpoint](cards.md#block-and-unblock-since-13): requires `admin` or `member` board role (a `member` may block only cards they created, unless a moderator) and the `mcp:write` scope.

**Arguments:** `card_id` and `reason` (required). `reason` is trimmed and must then be 1-500 characters; a blank or longer one returns `validation_error` with `errors.reason`.

**Returns:** the updated card, same shape as `create_card`, with `blocked_at` and `blocked_reason` set and `version` bumped. Writes a block record and a `blocked` activity, and broadcasts `card.updated` with the full card. Returns `card_already_blocked` if the card already has an open block.

### `unblock_card`

> **Added in 1.3** (#1149)

Clears a card's manual block. Same roles and scope as `block_card`.

**Arguments:** `card_id` (required); `resolution` (optional, up to 500 characters): how the block was resolved.

**Returns:** the updated card with `blocked_at: null` and `blocked_reason: ""`. Closes the block record (keeping its reason and duration), writes an `unblocked` activity, and broadcasts `card.updated`. Returns `card_not_blocked` if the card has no open block. A `blocks` relation to another card is a separate signal (`blocker_count`) and is not cleared.

### `archive_card`

Soft-deletes a card. Idempotent — archiving an already-archived card succeeds and returns its existing `archived_at`. Requires `admin` or `member` board role and the `mcp:write` scope.

**Arguments:** `card_id` (required).

**Returns:** `{"card_id": <id>, "card_uid": <uid>, "archived_at": <ISO 8601 timestamp>}`. `card_uid` (*added in 1.3, #1974*) is the card's [stable UID](#stable-identifiers-uid), the same value the `card.archived` WebSocket frame carries. The result has no card object and so no `version`.

---

## Resources

> **Added in 1.2**

A **resource** is MCP's second kind of server capability, alongside a tool. A tool is invoked with `tools/call` and takes arguments an agent chooses per call; a resource is addressed by a URI and read with `resources/read`, so an agent can load a whole board's or card's context in one round trip instead of chaining `list_*` tool calls. Visiban registers two resource templates: `board://{board_id}` and `card://{card_id}`.

Like every other endpoint under `/mcp`, reading a resource requires the `mcp:read` scope. Neither resource needs `mcp:write` — both are read-only.

`/mcp` also now sends `Access-Control-*` headers — including a response to preflight `OPTIONS` requests — for origins listed in `CORS_ALLOWED_ORIGINS`, the same setting already used by the REST API and the WebSocket, so a browser-based MCP client can reach the server directly.

### `board://{board_id}`

A read-only board snapshot: metadata, columns, swimlanes, up to 200 active cards, and labels — like calling `list_columns` + `list_swimlanes` + `list_cards` and merging the results (unlike `GET /api/v1/boards/{id}/full/`, the card list is capped at 200), but resolves and authorizes the board once instead of three times. All board roles may read it. Mime type `application/json`.

**Returns:**

| Field | Type | Description |
|---|---|---|
| `id` | integer | Board primary key. |
| `uid` | string | Stable public short id, as in `list_boards`. Added in 1.3 (#1974). |
| `name` | string | Board name. |
| `description` | string | Board description; empty string when unset. |
| `created_at` | string | ISO 8601 timestamp. |
| `updated_at` | string | ISO 8601 timestamp. |
| `columns` | array | Same shape as `list_columns`'s return above. |
| `swimlanes` | array | Same shape as `list_swimlanes`'s return above, including the admin/site_admin-only `contact_email` rule. |
| `cards` | array | Same shape as `list_cards`'s return above, unfiltered and excluding archived cards. Capped at 200 cards like `list_cards`; `cards_total` and `cards_truncated` say whether it was. |
| `cards_total` | integer | Number of active cards on the board, ignoring the 200-card cap. Added in 1.2 (#1762). |
| `cards_truncated` | boolean | `true` when `cards` holds fewer than `cards_total` rows; fetch the rest with `list_cards` (`limit`/`offset`). Added in 1.2 (#1762). |
| `labels` | array | `{id, uid, name, color}` objects, one per label defined on the board (`uid` since 1.3). A card's `labels` stay an array of names, which are unique per board; map them to a `uid` through this list. |

!!! note
    `board://{board_id}` deliberately omits every web-session-only field the REST board detail response carries — `share_token` (deprecated on REST since 1.2), `share_token_expires_at`, `share_link_active`, `capabilities`, `is_starred`, `members`, `current_user_role`. These have no meaning for an AI agent reading board context, and a share token in particular is a bearer credential that must never appear in agent-facing output.

### `card://{card_id}`

Card detail plus full audit history. Requires board membership — any role, including `collaborator`/`viewer`. Mime type `application/json`.

**Returns:** the same fields as one row of `list_cards`, plus:

| Field | Type | Description |
|---|---|---|
| `archived_at` | string or `null` | ISO 8601 timestamp, or `null` if the card is not archived. |
| `movements` | array | `{id, from_column, to_column, from_swimlane, to_swimlane, from_column_uid, to_column_uid, from_swimlane_uid, to_swimlane_uid, moved_at, moved_by, imported_from_username}` objects — same shape as `move_card`'s `movement` above (the `*_uid` keys since 1.3). |
| `checklist_items` | array | `{id, text, is_checked, position}` objects. |
| `activities` | array | `{id, event_type, from_value, to_value, actor, created_at, imported_from_username}` objects, newest first. `imported_from_username` works as on `movements`. |
| `comments` | array | `{id, body, author, created_at, updated_at, imported_from_username}` objects, oldest first. `imported_from_username` is `null` except on a comment created by a board import (since 1.2), where it holds the author name the source named and `author` is the user who imported it. |

### Resource errors

Resources fail differently from tools. A tool that cannot complete returns a structured `{"error": {"code": ...}}` result (see [Tool errors](#tool-errors) above); a resource read has no such channel. A failed read (a bad id, or an id on a board the caller cannot access) surfaces as a plain JSON-RPC-level error, with a message like `No Board matches the given query.` or `No Card matches the given query.`

That message is deliberately identical whether the id does not exist or sits on a board the caller cannot see, for the same IDOR-prevention reason as the `board_not_found`/`card_not_found` tool error codes above. The two cases cannot be told apart, by design.

The same "raise, don't return" rule applies to a throttled resource read — see [Throttled resource reads](#throttled-resource-reads) above.

---

## Stability and versioning

> **Added in 1.2**

The MCP surface is a public contract from 1.2 and follows the same compatibility rules as the REST API from 1.0 onward. It is **not** experimental.

- **Tool names** (`list_boards`, `list_columns`, `list_swimlanes`, `list_cards`, `create_card`, `move_card`, `update_card`, `archive_card`, and since 1.3 `block_card`, `unblock_card`) and **resource URIs** (`board://{board_id}`, `card://{card_id}`) are never removed or renamed in a minor or patch release.
- **Argument schemas** change additively only: new arguments are optional with a sensible default, and an existing argument is never removed, renamed, made required, or given a different type.
- **Results and error payloads** only gain fields; existing fields keep their name and type. The error `code` values listed under [Tool errors](#tool-errors) are never removed.
- A tool or resource that must go away is marked deprecated here for at least one minor release, and removal needs a major version bump.
- **Resource URIs address objects by integer id.** `board://{board_id}` and `card://{card_id}` take the same integer `id` the tools take, and that scheme is frozen. A `uid` is not accepted in their place. If uid-addressed reads are ever added, they will be new, additional resource templates, and these two will keep working unchanged. *Recorded in 1.3 (#1974).*
- New tools, resources, optional arguments, and result fields can appear in any minor release, so clients should ignore fields they do not recognize.
- The configuration names `MCP_SERVER_ENABLED`, `MCP_ALLOWED_HOSTS`, `MCP_THROTTLE_*_RATE`, and the `/mcp` path follow the environment-variable rules: they are not renamed, and a rename keeps the old name as a deprecated alias for at least one minor release.

---

## Roadmap

Phase 1 covers connectivity, authentication, board discovery, full card CRUD, and the `board://`/`card://` resources (this release). A full setup guide is tracked separately. Analytics tools and OAuth 2.1 are planned for the Enterprise edition.
