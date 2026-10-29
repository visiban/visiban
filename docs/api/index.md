# API Reference

Visiban exposes a REST JSON API. All endpoints require an authenticated session unless noted otherwise.

**Base URL:** `http://localhost:8000/api/v1` (dev) or `https://<your-domain>/api/v1` (production)

| Reference | Description |
|---|---|
| [Authentication](authentication.md) | Login, logout, OAuth flows, session auth, Personal Access Tokens (PATs), WebSocket tickets |
| [Boards API](boards.md) | Boards, columns, swimlanes, labels, board member management, and board export/import (including Trello import, since 1.2) |
| [Cards API](cards.md) | Cards, move endpoint, comments, attachments, checklists, and activity |
| [Groups API](groups.md) | Groups, subgroups, group members, and invite links |
| [Notifications API](notifications.md) | List unread notifications, mark as read, and get unread count |
| [Admin API](admin.md) | Site settings, the instance-admin action log, users, and invite links — site admin only |
| [Issue Board Lens API](git-lens.md) | Read-only mirror of GitLab/GitHub issues and MRs onto a board, plus derived-pipeline columns — REST surface experimental; the WebSocket events and `git_lens_enabled` are [stable](git-lens.md#stable-contract-surfaces) |
| [MCP Server](mcp.md) | Model Context Protocol tools for AI agents to read and write boards |
| [WebSockets](websockets.md) | Full event reference and the ticket-authentication flow for the [WebSocket API](#websocket-api) below |
| [Change Feed](events.md) | Durable, resumable feed of board mutations — replay what you missed with a cursor instead of re-fetching (since 1.2) |
| [Health Checks](health.md) | Liveness and readiness probes for K8s / uptime monitoring |
| [Version API](version.md) | Running server version string |
| [OpenAPI Spec](openapi.md) | Machine-readable OpenAPI 3.0 spec, Swagger UI, and ReDoc |

## WebSocket API

Visiban provides a WebSocket endpoint for real-time board updates. Clients connect per board and receive push events whenever board state changes.

### Connection

**URL pattern:** `ws://<host>/ws/boards/{board_id}/` (or `wss://` for TLS)

**Authentication:** session cookie, or a short-lived ticket (since 1.2). The browser SPA relies on the existing session cookie and needs no `Authorization` header. Token-authenticated clients — native, CLI, or a front end on another origin — obtain a ticket from `POST /api/v1/auth/ws-ticket/` and pass it as `?ticket=`. See [WebSockets](websockets.md#ticket-authentication-since-12).

**Close codes:**

| Code | Meaning |
|------|---------|
| `4001` | Not authenticated — no valid session, and no valid ticket |
| `4003` | Not a board member — the authenticated user does not have access to this board. Since 1.2, it can also arrive mid-stream on an open connection, when access is lost, when the account has a pending password or username change, or when the connection's credential is revoked. A later reconnect can succeed once a pending change is completed. See [Access re-check and eviction](websockets.md#access-re-check-and-eviction) |
| `1011` | Internal error (since 1.2 for this case) — the server could not complete its mid-stream access re-check, for example during a database outage. Not a loss of access: reconnect with your normal backoff. See [Access re-check and eviction](websockets.md#access-re-check-and-eviction) |

### Message envelope

All messages from the server use the following shape:

```json
{ "event": "<event_type>", "data": { ... }, "event_id": 84213 }
```

The `data` object contains the serialized resource (card, column, swimlane, etc.) relevant to the event. `event_id` (since 1.2) is the frame's id in the [change feed](events.md) — keep the last one you processed and resume from it after a reconnect.

### Event types

Every event follows the `{ "event": "<event_type>", "data": { ... } }` envelope shown above. The full, CI-enforced list of event types — board, column, swimlane, label, custom field, swimlane field, card, member, and Git Lens events — is maintained in one place: see [WebSockets → Event reference](websockets.md#event-reference).

---

## Versioning policy

All REST endpoints are served under the `/api/v1/` prefix. This is a literal path segment — the version string is not a header or query parameter. An unsupported version prefix (e.g. `/api/v2/`) returns `406 Not Acceptable`.

The `/api/v1/` surface is the stable 1.x contract. Breaking changes (field removals, type changes, endpoint removals) will be introduced under `/api/v2/` with at least one minor-release deprecation notice. Additive changes (new optional response fields, new optional request parameters, new endpoints) are non-breaking and may appear in any 1.x patch or minor release.

Operators and integrators may treat the `/api/v1/` surface as stable for the lifetime of all Visiban 1.x releases.

---

## Common conventions

- All endpoints return `application/json`
- Write endpoints (`POST`, `PUT`, `PATCH`, `DELETE`) require a valid CSRF token or use token-based auth
- Dates are ISO 8601 strings: `"2026-04-01"`
- Requests with no valid credentials (no session, or a missing, invalid, or expired token) return `401 Unauthorized` with a `WWW-Authenticate: Token` header. A credential that is valid but not allowed to perform the action returns `403 Forbidden`. Re-authenticating fixes a `401`; it never fixes a `403`
- Permission errors return `403 Forbidden`; missing resources return `404 Not Found`
- *(1.2+)* Board-scoped routes answer `404 Not Found` to a caller with no access to the board, the same as for a board that does not exist. `403 Forbidden` means the caller can see the board but their role is too low for the action

### Error responses

Many errors carry a machine-readable `code` next to the human-readable `detail`:

```json
{ "detail": "Query param 'days' must not exceed 365.", "code": "invalid_query_param" }
```

`code` is a stable string (for example `export_restricted`, `feature_disabled`, `invite_email_cap_reached`, `group_owner_protected`). When a response has a `code`, compare it rather than `detail`: the `detail` text is for people and may be reworded in any release. Not every error has a `code`; each endpoint's page documents its error bodies. Validation errors on a request body are usually field-keyed (`{"<field>": [...]}`), but some hand-validated bodies answer `{"detail": "..."}` with no `code` instead, for example an invalid `role` on `PATCH /groups/{id}/members/{user_id}/` (`{"detail": "Must be one of: admin, member, collaborator, viewer"}`).

> **Added in 1.2**

**Bad query parameters.** The query parameters listed below answer a refused value (not an integer, out of range, not one of the allowed values, a cursor the server cannot use) with `400 Bad Request`, `{detail, code}` and `code: "invalid_query_param"`:

```json
{ "detail": "offset must not exceed 4611686018427387904.", "code": "invalid_query_param" }
```

This covers:

- `GET /boards/{id}/analytics/`: `days` and `stalled_days`
- `GET /boards/{id}/cards/`: `limit`
- `GET /boards/{id}/movements/`: `moved_after`, `moved_before`, `swimlane_id`, `to_column_id` and `moved_by_id`
- `GET /boards/{id}/events/`: `after` and `limit`
- An `offset` above `2^62` on `GET /boards/{id}/movements/`, `GET /boards/{id}/cards/`, `GET /boards/{id}/cards/archived/` and `GET /boards/{id}/cards/{id}/timeline/`
- `GET /boards/{id}/cards/{id}/timeline/`: an unknown group in `event_types`. Before 1.2 this body was `{detail}` only; `code` is added
- `GET /admin/action-log/`: `action`
- `GET /admin/board-invite-links/`: `status`
- `GET /cards/`: a `cursor` that cannot be decoded, or whose position is not a timestamp Postgres can store (not a valid date and time, or a UTC offset of 16 hours or more)
- Card filter parameters whose value fails the filter's type check, on `GET /boards/{id}/cards/` and `GET /cards/`. These also keep the field-keyed entry the board card list has answered with since 1.1, so a 1.1 client that reads it is unaffected:

```json
{ "assignee": ["Enter a number."], "detail": "assignee: Enter a number.", "code": "invalid_query_param" }
```

Branch on `code`, not on which parameter key is present.

Some parameters are clamped or ignored rather than refused; each endpoint's page says which.

### Pagination

Most list endpoints return the **standard paginated envelope**. A client must read the list from `results`, not from the top level of the response:

```json
{
  "count": 123,
  "offset": 0,
  "page_size": 50,
  "results": [ ... ]
}
```

| Query parameter | Default | Description |
|---|---|---|
| `offset` | `0` | Zero-based number of rows to skip |
| `page_size` | `50` | Rows per page. Values above `200` are clamped to `200` |

`count` is the total number of rows across all pages. The envelope carries **no** `next` or `previous` links: walk the list by increasing `offset` by `page_size` until `offset + page_size >= count`.

The following list endpoints use the standard envelope and accept `offset` and `page_size`:

- `GET /boards/`, `GET /groups/`
- `GET /boards/{id}/columns/`, `swimlanes/`, `labels/`, `custom-fields/`, `swimlane-custom-fields/`, and `export-history/`
- `GET /groups/{id}/descendant-boards/paged/` (see [Groups API](groups.md#get-apiv1groupsiddescendant-boardspaged))
- `GET /admin/users/`, `GET /admin/action-log/`, and `GET /admin/board-invite-links/` (see the [Admin API](admin.md))

Some list endpoints deliberately **do not** use it. Check the endpoint's own page before parsing the response:

| Endpoint | Shape |
|---|---|
| `GET /cards/` | Cursor pagination: `{results, next_cursor}`. See [Cards API](cards.md) |
| `GET /boards/{id}/cards/` | Bare array, capped at 200 rows, with `X-Total-Count` / `X-Truncated` headers and optional `limit` / `offset`. A deliberate second pagination style: it keeps `limit` (not `page_size`) because the response has no envelope to carry a `count`, and the same `limit` / `total` / `truncated` vocabulary is what MCP `list_cards` exposes, so the two stay in step. A negative or non-integer `offset` is `0`, like every other endpoint; a bad `limit` is a `400` with `{detail, code: "invalid_query_param"}`. An `offset` above 2^62 is a `400` with `{detail, code: "invalid_query_param"}`, as on every endpoint that takes `offset`. See [Cards API](cards.md) |
| `GET /boards/{id}/movements/` and `GET /boards/{id}/cards/archived/` | The standard envelope, but the page size is fixed at `50` and `page_size` is ignored; only `offset` pages |
| `GET /boards/{id}/cards/{card_id}/timeline/` | `limit` (default 50, max 200) and `offset`, with `next` / `previous` links. See [Cards API](cards.md) |
| `GET /boards/{id}/events/` | `{results, next_cursor}` cursor feed; `next_cursor` is an integer event id (pass it as `after`), and the deprecated `next` is also returned with the same value. See [Change Feed](events.md) |
| `GET /groups/{id}/descendant-boards/` | Bare JSON array, not paginated and **not bounded**: it returns every board in the group's subtree that the caller can access, which for a top-level group can be the whole organization. Use `GET /groups/{id}/descendant-boards/paged/` for bounded pages |
| Small, bounded lists (group members, subgroups, boards, labels, and invite links of a group; board invite links and saved filters; `GET /admin/invite-links/`; `GET /users/search/` (capped at 10 rows); sample boards and templates; notifications; personal access tokens; connected accounts; a card's comments, attachments, checklist, and relations) | Bare JSON array, not paginated |

### Maintenance mode (503)

> **Added in 1.2**

While a site admin has [maintenance mode](admin.md#maintenance-mode) turned on, **any**
non-safe-method request (anything other than `GET`, `HEAD`, `OPTIONS`, `TRACE`) from a non-site-admin
caller — on any endpoint documented in this reference — is rejected with `503 Service Unavailable`:

```json
{ "code": "maintenance_mode", "detail": "Upgrading to 1.2 — back by 14:00 UTC." }
```

The response carries `Retry-After: 120` so clients back off rather than retry immediately.
`detail` is the operator's configured notice, or a built-in default when they left it blank.
Reads keep working, and site admins keep full read/write access regardless of how they
authenticate (session cookie or personal access token).

A small set of endpoints stay writable even during maintenance — mainly login, logout, the
password-reset/forced-change flows, the admin API itself, and the health probes. See
[Maintenance mode → endpoints that stay writable](admin.md#maintenance-mode) for the exact list.
MCP write tools (`create_card`, `move_card`, `update_card`, `archive_card`) return an equivalent
`{"error": {"code": "maintenance_mode", "detail": "..."}}` result instead of a 503 — see
[MCP Server](mcp.md#tool-errors).

### Actor fields ("who did it")

> **Settled in 1.2** (#1663)

Resources that record which user did something use one of three shapes. Each is
deliberate, and none will be removed or renamed in 1.x:

| Shape | Where | Why |
|---|---|---|
| Nested `BoardUser` — `{ id, username, display_name, avatar_url }`, or `null` | `CardTimelineEntry.actor`, `CardActivity.actor`, `CardMovement.moved_by`, `BoardExportLog.actor`, `LensConnection.created_by`, and `BoardEvent.actor` on the [change feed](events.md) | The default for every board-scoped resource except invite links (see the username row below). `null` means there was no authenticated actor, or the account has since been deleted. |
| Integer id — `actor_id` / `created_by_id` | The [change feed](events.md) (`BoardEvent.actor_id`), the admin action log (alongside `actor_username`), and the `invite.created_by_id` of a [`member.added`](websockets.md#member-events) WebSocket payload, sent to `admin` and `site_admin` recipients only (the change feed returns it inside `data` to the same roles) | The row is append-only and stores a plain column, not a foreign key, so it can outlive the user. On the change feed it sits next to the nested `actor`; the id is kept for consumers that already join against the member list. A broadcast payload carries ids only because it is built once for every subscriber; resolve `invite.created_by_id` against the member list. |
| Username string — `created_by_username` | Every invite-link row: site (`/admin/invite-links/`), group, board, and the site-admin board-invite list | One consistent convention across the whole invite family since 1.1 (#1008). The rows are only ever rendered as a "created by …" label, and `null` means the creator's account was deleted or anonymized. |

New endpoints follow the same rules: a new board-scoped actor field is a nested
`BoardUser`; a new invite-link serializer uses `created_by_username` so the invite
family stays uniform; no other resource gains a new `*_username` field.

### URL path style

Path segments use `kebab-case` (e.g. `/auth/change-password/`, `/boards/<id>/saved-filters/`, `/boards/<id>/move-group/`). This is the canonical style and the convention you should rely on when writing new integrations.

One legacy endpoint still accepts a `snake_case` alias for backward compatibility:

| Canonical (use this) | Deprecated alias (2.0 removal) |
|---|---|
| `PATCH /boards/<id>/swimlanes/<id>/set-collapsed/` | `PATCH /boards/<id>/swimlanes/<id>/set_collapsed/` |

The snake_case path remains routable through every 1.x release. It will be removed in 2.0 after a full minor-release deprecation window. *(1.2+)* The OpenAPI schema marks the alias operation `deprecated: true`.

### Expanding foreign-key fields

Endpoints that return a foreign key as an integer id may also support a nested companion field gated on the `?expand=<name>` query parameter. The default response shape is unchanged; passing `expand` adds a parallel `_detail` field populated with a minimal nested object.

| Endpoint | Expandable field | Query | Default shape | Expanded shape |
|---|---|---|---|---|
| `GET /boards/` | `group` | `?expand=group` | `group_detail: null` | `group_detail: { id, name, parent, parent_name, ancestors }` |
| `GET /boards/<id>/` | `group` | `?expand=group` | `group_detail: null` | `group_detail: { id, name, parent, parent_name, ancestors }` |
| `GET /boards/<id>/full/` | `group` | `?expand=group` | `group_detail: null` | `group_detail: { id, name, parent, parent_name, ancestors }` |
| `GET /groups/<id>/boards/` | `group` | `?expand=group` | `group_detail: null` | `group_detail: { id, name, parent, parent_name, ancestors }` |

Multiple expansions may be combined with a comma, e.g. `?expand=group,members`. Unknown values are silently ignored. The original FK id fields (`group`, `group_name`) always remain in the response for backward compatibility.

The `ancestors` field on the expanded `group_detail` payload is root-first and excludes the group itself (callers already have that in `name`). Useful for rendering breadcrumbs without a follow-up request. Added in 1.1 (#845).
