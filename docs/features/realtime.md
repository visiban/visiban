# Real-time Updates

Visiban uses WebSockets (Django Channels + Valkey) to push board changes to all connected clients instantly — no polling required.

## How it works

1. When a user opens a board, the frontend opens a WebSocket connection to `ws://{host}/ws/boards/{board_id}/`
2. The browser SPA authenticates with the session cookie; unauthenticated connections are closed with code `4001`, and connections from a non-member are closed with `4003`
3. Any mutation — card, column, swimlane, label, member, or board setting change — broadcasts an event to all clients subscribed to that board's channel group
4. The frontend applies the event to local state, keeping all open tabs in sync without a page refresh

Native, CLI, and agent clients have no cookie jar to send, so they authenticate with a short-lived **ticket** (since 1.2) obtained over the REST API instead — see [WebSocket API → Ticket authentication](../api/websockets.md#ticket-authentication-since-12) for the full flow.

## Connection status

The top-right corner of the board toolbar shows the connection state via the **ConnectionStatus** component. When healthy the indicator is intentionally quiet; it becomes prominent only when there is a problem:

- 🟢 **Live** — WebSocket connected; bare dot with the word "Live" (label visible at wide viewports only — quiet by design)
- 🟡 **Reconnecting…** — connection dropped; client is retrying automatically; amber pill with label always shown
- 🟡 **Stale** — connected but no event has arrived in over 60 seconds; amber pill indicates the feed may be lagging
- 🟡 **Connecting…** — initial connection attempt in progress; amber pill
- 🔴 **Offline** — connection permanently failed (authentication error or repeated failures); red pill — reload the page to reconnect

The client reconnects automatically after 3 seconds if the connection drops. If the server closes the connection with code `4001` (unauthenticated) or `4003` (unauthorized), no retry is attempted — the indicator switches directly to **Offline**.

## Event types

Board-channel events fall into a few categories:

- **Board** — settings changes, deletion, and per-user star toggles
- **Members** — added, role changed, or removed (removing the current user also closes their connection)
- **Cards** — created, field changes, moves between columns/swimlanes, deletion, archive, and restore
- **Columns, swimlanes, and labels** — created, updated, deleted, and (for columns and swimlanes) reordered
- **Feature-specific families** riding the same board channel: saved-filter events (see [Saved Filters](saved-filters.md)), custom field and swimlane field events (see [Custom Fields](custom-fields.md#api-and-real-time-events)), and — when [Issue Board Lens](issue-board-lens.md) is enabled — Git Lens connection events

For the complete, canonical event list, trigger conditions, and `data` shape for every event, see **[WebSocket API — Event reference](../api/websockets.md#event-reference)** — that table is CI-enforced against the backend event registry and frontend handlers, so it cannot drift the way a second hand-maintained copy would.

## Event payload structure

Every WebSocket message has this envelope:

```json
{
  "event": "card.moved",
  "data": { ... }
}
```

- **`event`** — the event type string (e.g. `card.created`, `card.moved`)
- **`data`** — the serialized payload; contents depend on the event type

For most events, `data` is the full serialized object. Deletion and archive-removal events include only the ID:

```json
{ "event": "card.deleted", "data": { "card_uid": "3a9f1c2d7e4b8a05" } }
```

```json
{ "event": "column.deleted", "data": { "column_uid": "c1d2e3f4a5b67890" } }
```

```json
{ "event": "swimlane.deleted", "data": { "swimlane_uid": "s9f8e7d6c5b4a321" } }
```

```json
{ "event": "label.deleted", "data": { "label_uid": "l1a2b3c4d5e6f780" } }
```

```json
{ "event": "board.deleted", "data": { "board_uid": "bd_1a2b3c4d5e6f7890" } }
```

`board_uid` (added in 1.1, #696) is the stable identifier for a deleted board, matching every other terminal `*.deleted` event. A plain board deletion carries `board_uid` only. The single exception is a board **moved out of a group**: the `board.deleted` emitted on the *old* group's channel additionally carries `"board_id": <int>` so clients keyed by integer id can drop the row without a re-fetch.

```json
{ "event": "member.removed", "data": { "user_id": 42 } }
```

### Reorder payloads

The reorder events include the full list of objects in their new order. The server emits the singular, canonical event names:

```json
{ "event": "column.reordered",  "data": { "columns": [ { "id": 1, ... }, { "id": 2, ... } ] } }
```

```json
{ "event": "swimlane.reordered",  "data": { "swimlanes": [ { "id": 1, ... }, { "id": 2, ... } ] } }
```

!!! note
    The legacy plural event names (`columns.reordered`, `swimlanes.reordered`) emitted in 1.0 were dropped in 1.1 (#944) — only the singular forms above are emitted. Subscribe to `column.reordered` / `swimlane.reordered`.

### `card.moved` payload

The `card.moved` event includes both the updated card and the movement record — the same shape returned by `POST /api/v1/boards/{id}/cards/{id}/move/`:

```json
{
  "event": "card.moved",
  "data": {
    "card": { "id": 101, "uid": "3a9f1c2d7e4b8a05", "column": 3, "swimlane": 2, ... },
    "movement": {
      "id": 42,
      "from_column": 2, "from_column_name": "To Do", "from_column_uid": "a1b2c3d4e5f60718",
      "to_column": 3,   "to_column_name": "Doing",  "to_column_uid": "9f8e7d6c5b4a3210",
      "moved_by": { "id": 7, "username": "alice" },
      "moved_at": "2026-03-15T09:41:22Z",
      "notes": ""
    }
  }
}
```

`movement` is `null` if only the position changed within the same column/swimlane cell (pure reorder — no column or swimlane change occurred).

## Group real-time events

> **Added in 1.1**

In addition to the per-board channel, Visiban exposes a per-group WebSocket channel for clients that display the group detail page (board list, member list, live board creation).

**Connection URL:** `ws://{host}/ws/groups/{group_id}/`

**Authentication:** same as the board channel — session cookie required. Unauthenticated connections are closed with code `4001`; connections from users without group membership are closed with code `4003`. No retry is attempted for either code.

**What it streams:** board lifecycle changes within the group (created, updated, deleted or moved out, starred/unstarred), group lifecycle changes (created, updated, deleted, starred/unstarred, including subgroups), group-level labels, group membership changes (removing the current user also closes their connection, mirroring the board channel), and invite link revocations. Each payload follows the standard `{"event": "...", "data": {...}}` envelope. The group channel does not emit card-level events — those remain on the per-board channel.

For the complete, canonical event list and `data` shape for every event, see **[WebSocket API — Group channel](../api/websockets.md#group-channel-since-11)**.

## Requirements

Real-time updates require a Valkey instance (the Redis-compatible, BSD-licensed fork). Visiban uses two separate connections:

| Environment variable | Purpose | Default |
|---|---|---|
| `REDIS_URL` | Django Channels — the WebSocket channel layer | `redis://localhost:6379/0` |
| `REDIS_CACHE_URL` | Django cache — rate limiting, health checks | `redis://localhost:6379/1` |

These are independent variables. By default they point to the same Valkey host but use different databases (`/0` and `/1`). You can point them at separate instances in production if needed.

!!! note "Why REDIS_URL and not VALKEY_URL?"
    The `redis://` URL scheme and `REDIS_*` env var names are unchanged — they are part of the stable API contract. The deployed service is Valkey, but the connection protocol (RESP) is identical, so no URL or env var changes are required.

### Docker Compose

Valkey is included in the default `docker-compose.yml` — no extra setup needed.

### Production / Helm

Set `REDIS_URL` to your Valkey DSN, or use the bundled Valkey: the chart's own StatefulSet on the official, pinned `valkey/valkey:8-alpine` image (see [Bundled Valkey](../getting-started/kubernetes.md#bundled-valkey)):

```yaml
valkey:
  enabled: true
```

To use an external Valkey (or Redis-compatible) instance:

```yaml
valkey:
  enabled: false
externalRedis:
  url: "redis://my-valkey-host:6379/0"
```

!!! tip
    If you use a single external Redis instance for both Channels and caching, set both `REDIS_URL` and `REDIS_CACHE_URL` to the same DSN. Using different database numbers (e.g. `/0` and `/1`) keeps the keyspaces separate and avoids accidental eviction of channel-layer data by cache expiry.

## Tab-focus reconciliation

When a browser tab is backgrounded, the operating system may throttle or suspend JavaScript timers and WebSocket connections. Events broadcast while the tab is inactive can be lost, causing the board state to drift.

To guard against this, Visiban automatically re-fetches the full board state when a tab returns to the foreground (`visibilitychange` event). A 30-second throttle prevents redundant fetches when the user rapidly switches between tabs. The reload is "silent" — it does not flash a loading skeleton.

## Resuming after a dropped connection

> **Added in 1.2**

The SPA handles a dropped connection by refetching the full board on reconnect, as described above. A consumer that lives outside the browser — a second front end, a sync job, the MCP server's REST client — can instead replay exactly what it missed:

- Every event the board channel broadcasts is durably persisted in the same transaction as the mutation it describes, and each WebSocket frame carries the matching `event_id`.
- `GET /api/v1/boards/{id}/events/?after=<event_id>` returns the missed events in order, so a consumer can catch up without re-fetching the whole board.
- Events are retained for `BOARD_EVENT_RETENTION_DAYS` days (default 30); a cursor older than that gets `410 Gone` with a re-sync hint instead of silently skipping events.

See [Board Change Feed API](../api/events.md) for the full reference.

## Optimistic concurrency control

Card moves use optimistic concurrency control (OCC) to prevent lost updates. Every card carries a `version` number that increments on every mutation (move, field update). When the frontend sends a move request, it includes the card's current `version`. If another user modified the card in the meantime, the server returns `409 Conflict` with a `version_conflict` error code, and the frontend refreshes the board automatically.

The version check is backward-compatible: clients that omit the `version` field bypass the OCC check entirely.

## ASGI server

The backend runs under **daphne** (ASGI) instead of gunicorn (WSGI) to support WebSocket connections. This is handled automatically in `docker-compose.yml` and the Helm chart.
