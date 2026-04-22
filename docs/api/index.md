# API Reference

Visiban exposes a REST JSON API. All endpoints require an authenticated session unless noted otherwise.

**Base URL:** `http://localhost:8000/api/v1` (dev) or `https://<your-domain>/api/v1` (production)

| Reference | Description |
|---|---|
| [Authentication](authentication.md) | Login, logout, OAuth flows, session auth, Personal Access Tokens (PATs) |
| [Boards API](boards.md) | Boards, columns, swimlanes, labels, and board member management |
| [Cards API](cards.md) | Cards, move endpoint, comments, attachments, checklists, and activity |
| [Groups API](groups.md) | Groups, subgroups, group members, and invite links |
| [Notifications API](notifications.md) | List unread notifications, mark as read, and get unread count |
| [Health Checks](health.md) | Liveness and readiness probes for K8s / uptime monitoring |
| [OpenAPI Spec](openapi.md) | Machine-readable OpenAPI 3.0 spec, Swagger UI, and ReDoc |

## WebSocket API

Visiban provides a WebSocket endpoint for real-time board updates. Clients connect per board and receive push events whenever board state changes.

### Connection

**URL pattern:** `ws://<host>/ws/boards/{board_id}/` (or `wss://` for TLS)

**Authentication:** session-based. The WebSocket handshake uses the existing session cookie. No `Authorization` header is required.

**Error codes on connection:**

| Code | Meaning |
|------|---------|
| `4001` | No valid session — the client is not authenticated |
| `4003` | Not a board member — the authenticated user does not have access to this board |

### Message envelope

All messages from the server use the following shape:

```json
{ "event": "<event_type>", "data": { ... } }
```

The `data` object contains the serialized resource (card, column, swimlane, etc.) relevant to the event.

### Event types

| Event | Trigger |
|-------|---------|
| `card.created` | A new card is created |
| `card.updated` | A card's fields are updated |
| `card.deleted` | A card is deleted |
| `card.moved` | A card is moved to a different column or swimlane |
| `card.archived` | A card is archived |
| `card.unarchived` | An archived card is restored |
| `column.created` | A new column is created |
| `column.updated` | A column's fields are updated |
| `column.deleted` | A column is deleted |
| `column.reordered` | Column positions are changed (since 1.1; replaces deprecated `columns.reordered`) |
| `columns.reordered` | **Deprecated** (removed in 2.0) — plural alias of `column.reordered` |
| `swimlane.created` | A new swimlane is created |
| `swimlane.updated` | A swimlane's fields are updated |
| `swimlane.deleted` | A swimlane is deleted |
| `swimlane.reordered` | Swimlane positions are changed (since 1.1; replaces deprecated `swimlanes.reordered`) |
| `swimlanes.reordered` | **Deprecated** (removed in 2.0) — plural alias of `swimlane.reordered` |
| `label.created` | A new label is created |
| `label.updated` | A label's fields are updated |
| `label.deleted` | A label is deleted |
| `member.added` | A member is added to the board |
| `member.updated` | A member's role is changed |
| `member.removed` | A member is removed from the board |
| `board.updated` | Board settings are changed |
| `board.deleted` | The board is deleted |

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
- Permission errors return `403 Forbidden`; missing resources return `404 Not Found`

### URL path style

Path segments use `kebab-case` (e.g. `/auth/change-password/`, `/boards/<id>/saved-filters/`, `/boards/<id>/move-group/`). This is the canonical style and the convention you should rely on when writing new integrations.

One legacy endpoint still accepts a `snake_case` alias for backward compatibility:

| Canonical (use this) | Deprecated alias (2.0 removal) |
|---|---|
| `PATCH /boards/<id>/swimlanes/<id>/set-collapsed/` | `PATCH /boards/<id>/swimlanes/<id>/set_collapsed/` |

The snake_case path remains routable through every 1.x release. It will be removed in 2.0 after a full minor-release deprecation window.

### Expanding foreign-key fields

Endpoints that return a foreign key as an integer id may also support a nested companion field gated on the `?expand=<name>` query parameter. The default response shape is unchanged; passing `expand` adds a parallel `_detail` field populated with a minimal nested object.

| Endpoint | Expandable field | Query | Default shape | Expanded shape |
|---|---|---|---|---|
| `GET /boards/` | `group` | `?expand=group` | `group_detail: null` | `group_detail: { id, name, parent, parent_name, ancestors }` |
| `GET /boards/<id>/full/` | `group` | `?expand=group` | `group_detail: null` | `group_detail: { id, name, parent, parent_name, ancestors }` |

Multiple expansions may be combined with a comma, e.g. `?expand=group,members`. Unknown values are silently ignored. The original FK id fields (`group`, `group_name`) always remain in the response for backward compatibility.

The `ancestors` field on the expanded `group_detail` payload is root-first and excludes the group itself (callers already have that in `name`). Useful for rendering breadcrumbs without a follow-up request. Added in 1.1 (#845).
