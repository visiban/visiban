# Real-time Updates

Visiban uses WebSockets (Django Channels + Redis) to push board changes to all connected clients instantly — no polling required.

## How it works

1. When a user opens a board, the frontend opens a WebSocket connection to `ws://{host}/ws/boards/{board_id}/`
2. The server authenticates the connection using the session cookie; unauthenticated connections are closed with code `4001`
3. Any mutation — card, column, or swimlane change — broadcasts an event to all clients subscribed to that board's channel group
4. The frontend applies the event to local state, keeping all open tabs in sync without a page refresh

## Connection status

The board toolbar shows the connection state:

- 🟢 **Live** — WebSocket connected, real-time updates active
- ⚪ **Connecting…** — attempting to connect or reconnecting

The client reconnects automatically after 3 seconds if the connection drops.

## Event types

### Card events

| Event | Trigger |
|---|---|
| `card.created` | Card added to the board |
| `card.updated` | Card field changed (title, priority, assignee, etc.) |
| `card.moved` | Card dragged to a new column or swimlane |
| `card.deleted` | Card deleted |

### Column events

| Event | Trigger |
|---|---|
| `column.created` | Column added to the board |
| `column.updated` | Column renamed, recoloured, or limits changed |
| `column.deleted` | Column deleted |

### Swimlane events

| Event | Trigger |
|---|---|
| `swimlane.created` | Swimlane added to the board |
| `swimlane.updated` | Swimlane renamed, recoloured, or collapsed state changed |
| `swimlane.deleted` | Swimlane deleted |

All events include the full serialized object (or just the ID for deletion events) so the frontend can update local state without a round-trip to the API.

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
