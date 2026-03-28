# Real-time Updates

Visiban uses WebSockets (Django Channels + Redis) to push board changes to all connected clients instantly — no polling required.

## How it works

1. When a user opens a board, the frontend opens a WebSocket connection to `ws://{host}/ws/boards/{board_id}/`
2. The server authenticates the connection using the session cookie; unauthenticated connections are closed with code `4001`
3. Any mutation — card, column, swimlane, label, member, or board setting change — broadcasts an event to all clients subscribed to that board's channel group
4. The frontend applies the event to local state, keeping all open tabs in sync without a page refresh

## Connection status

The top-right corner of the board toolbar shows the connection state:

- 🟢 **Live** — WebSocket connected; dot pulses with a green animation
- 🟡 **Reconnecting…** — connection dropped; client is retrying automatically; dot pulses amber
- ⚫ **Offline** — connection permanently failed (authentication error or repeated failures); dot is grey and static — reload the page to reconnect

The client reconnects automatically after 3 seconds if the connection drops. If the server closes the connection with code `4001` (unauthenticated) or `4003` (unauthorized), no retry is attempted — the indicator switches directly to **Offline**.

## Event types

### Board events

| Event | Trigger |
|---|---|
| `board.updated` | Board settings changed, share token toggled, or board moved between groups |
| `board.deleted` | Board deleted |

### Member events

| Event | Trigger |
|---|---|
| `member.added` | User added to the board |
| `member.updated` | Member's role changed |
| `member.removed` | Member removed from the board |

!!! warning
    When a `member.removed` event targets the current user, the server automatically closes that user's WebSocket connection. The client does not need to handle this explicitly — the connection indicator will switch to **Offline** and the user will no longer receive events for the board.

### Card events

| Event | Trigger |
|---|---|
| `card.created` | Card added to the board |
| `card.updated` | Card field changed (title, priority, assignee, etc.) |
| `card.moved` | Card dragged to a new column or swimlane |
| `card.deleted` | Card deleted |

### Card archive events

| Event | Trigger |
|---|---|
| `card.archived` | Card archived via the Archive action |
| `card.unarchived` | Card restored from the archived panel |

`card.archived` payload — contains only the card ID (not the full card object):

```json
{ "event": "card.archived", "data": { "card_id": 101 } }
```

`card.unarchived` payload — contains the full serialized card so the frontend can restore it to the board without an additional API call:

```json
{ "event": "card.unarchived", "data": { "id": 101, "uid": "3a9f1c2d7e4b8a05", "title": "...", "archived_at": null, ... } }
```

### Column events

| Event | Trigger |
|---|---|
| `column.created` | Column added to the board |
| `column.updated` | Column renamed, recolored, or limits changed |
| `column.deleted` | Column deleted |
| `columns.reordered` | Columns reordered by an admin |

### Swimlane events

| Event | Trigger |
|---|---|
| `swimlane.created` | Swimlane added to the board |
| `swimlane.updated` | Swimlane renamed, recolored, or collapsed state changed |
| `swimlane.deleted` | Swimlane deleted |
| `swimlanes.reordered` | Swimlanes reordered by an admin |

### Label events

| Event | Trigger |
|---|---|
| `label.created` | Label added to the board |
| `label.updated` | Label renamed or recolored |
| `label.deleted` | Label deleted |

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
{ "event": "card.deleted", "data": { "card_id": 101 } }
```

```json
{ "event": "column.deleted", "data": { "column_id": 5 } }
```

```json
{ "event": "swimlane.deleted", "data": { "swimlane_id": 3 } }
```

```json
{ "event": "label.deleted", "data": { "label_id": 12 } }
```

```json
{ "event": "board.deleted", "data": { "board_id": 7 } }
```

```json
{ "event": "member.removed", "data": { "user_id": 42 } }
```

### Reorder payloads

The `columns.reordered` and `swimlanes.reordered` events include the full list of objects in their new order:

```json
{ "event": "columns.reordered", "data": { "columns": [ { "id": 1, ... }, { "id": 2, ... } ] } }
```

```json
{ "event": "swimlanes.reordered", "data": { "swimlanes": [ { "id": 1, ... }, { "id": 2, ... } ] } }
```

### `card.moved` payload

The `card.moved` event includes both the updated card and the movement record — the same shape returned by `POST /api/boards/{id}/cards/{id}/move/`:

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

## Requirements

Real-time updates require a Redis instance. Visiban uses two separate Redis connections:

| Environment variable | Purpose | Default |
|---|---|---|
| `REDIS_URL` | Django Channels — the WebSocket channel layer | `redis://localhost:6379/0` |
| `REDIS_CACHE_URL` | Django cache — rate limiting, health checks | `redis://localhost:6379/1` |

These are independent variables. By default they point to the same Redis host but use different databases (`/0` and `/1`). You can point them at separate Redis instances in production if needed.

### Docker Compose

Redis is included in the default `docker-compose.yml` — no extra setup needed.

### Production / Helm

Set `REDIS_URL` to your Redis DSN, or use the bundled bitnami/redis subchart:

```yaml
redis:
  enabled: true
```

To use an external Redis instance:

```yaml
redis:
  enabled: false
externalRedis:
  url: "redis://my-redis-host:6379/0"
```

!!! tip
    If you use a single external Redis instance for both Channels and caching, set both `REDIS_URL` and `REDIS_CACHE_URL` to the same DSN. Using different database numbers (e.g. `/0` and `/1`) keeps the keyspaces separate and avoids accidental eviction of channel-layer data by cache expiry.

## ASGI server

The backend runs under **daphne** (ASGI) instead of gunicorn (WSGI) to support WebSocket connections. This is handled automatically in `docker-compose.yml` and the Helm chart.
