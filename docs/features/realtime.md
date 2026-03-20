# Real-time Updates

Visiban uses WebSockets (Django Channels + Redis) to push board changes to all connected clients instantly — no polling required.

## How it works

1. When a user opens a board, the frontend opens a WebSocket connection to `ws://{host}/ws/boards/{board_id}/`
2. The server authenticates the connection using the session cookie; unauthenticated connections are closed with code `4001`
3. Any mutation — card, column, or swimlane change — broadcasts an event to all clients subscribed to that board's channel group
4. The frontend applies the event to local state, keeping all open tabs in sync without a page refresh

## Connection status

The top-right corner of the board toolbar shows the connection state:

- 🟢 **Live** — WebSocket connected; the dot pulses with a green animation to indicate an active connection
- ⚪ **Connecting…** — attempting to connect or reconnecting; dot is static and grey

The client reconnects automatically after 3 seconds if the connection drops.

## Event types

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

`card.archived` payload: `{ "card": { "id": 101, "archived_at": "2026-03-20T10:00:00Z", ... } }`

`card.unarchived` payload: `{ "card": { "id": 101, "archived_at": null, ... } }`

### Column events

| Event | Trigger |
|---|---|
| `column.created` | Column added to the board |
| `column.updated` | Column renamed, recolored, or limits changed |
| `column.deleted` | Column deleted |

### Swimlane events

| Event | Trigger |
|---|---|
| `swimlane.created` | Swimlane added to the board |
| `swimlane.updated` | Swimlane renamed, recolored, or collapsed state changed |
| `swimlane.deleted` | Swimlane deleted |

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

For most events `data` is the full serialized object. Deletion events include only the ID:

```json
{ "event": "card.deleted", "data": { "card_id": 101 } }
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

All other events include the full serialized object (or just the ID for deletion events) so the frontend can update local state without a round-trip to the API.

## Requirements

A Redis instance is required as the Django Channels channel layer backend. The `REDIS_URL` environment variable must be set.

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

## ASGI server

The backend runs under **daphne** (ASGI) instead of gunicorn (WSGI) to support WebSocket connections. This is handled automatically in `docker-compose.yml` and the Helm chart.
