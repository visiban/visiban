# WebSocket API

Visiban uses WebSockets to push real-time updates to all connected clients. Two channels are available:

- **Board channel** — scoped to one board; receives all mutation events for that board
- **Group channel** (since 1.1) — scoped to one group; receives board create/update/delete events for boards that live in that group

A single open board tab maintains one board channel connection. A group-list page (`/groups/<id>`) maintains one group channel connection.

---

## Board channel

### Connecting

```
ws://<host>/ws/boards/<board_id>/
```

Authentication uses session cookies — the same mechanism as the REST API. The browser automatically sends the session cookie on the WebSocket upgrade request, so no token parameter is needed:

```
ws://localhost:8000/ws/boards/42/
```

The server validates the session via Django's `AuthMiddlewareStack` and checks board membership before completing the WebSocket handshake. The connection is closed with one of two application-defined codes if either check fails:

| Close code | Meaning |
|---|---|
| `4001` | Unauthenticated — no valid session cookie. The client must log in before reconnecting. |
| `4003` | Unauthorized — the user is authenticated but is not a member of this board. Re-login will not help. |

Standard WebSocket close codes (`1000` normal, `1001` going away, `1006` abnormal) may also be observed for transport-level disconnects.

---

## Message format

All server-to-client messages use the same envelope:

```json
{ "event": "<event_type>", "data": { ... } }
```

`event` is a dotted string identifying the event type. `data` is event-specific — see the table below.

Clients should ignore unknown event types to remain forward-compatible with new events added in future releases.

---

## Event reference

### Board events

| Event | Trigger | `data` shape |
|---|---|---|
| `board.updated` | Board name, description, or settings changed | Full `BoardSerializer` object |
| `board.deleted` | Board was deleted | `{ "board_uid": <string>, "board_id": <int> }` |

### Column events

| Event | Trigger | `data` shape |
|---|---|---|
| `column.created` | New column created | Full `ColumnSerializer` object |
| `column.updated` | Column renamed, recolored, or settings changed | Full `ColumnSerializer` object |
| `column.deleted` | Column deleted | `{ "column_uid": <string> }` |
| `column.reordered` | Column order changed (since 1.1) | `{ "columns": [<ColumnSerializer>, ...] }` — all columns in new order |
| `columns.reordered` | Deprecated plural alias for `column.reordered`; emitted alongside it until removed in 2.0 | Same as `column.reordered` |

### Swimlane events

| Event | Trigger | `data` shape |
|---|---|---|
| `swimlane.created` | New swimlane created | `SwimlaneSerializer` object (public fields only — `contact_email` and `notes` are omitted regardless of role) |
| `swimlane.updated` | Swimlane updated | `SwimlaneSerializer` object (same field rules as above) |
| `swimlane.deleted` | Swimlane deleted | `{ "swimlane_uid": <string> }` |
| `swimlane.reordered` | Swimlane order changed (since 1.1) | `{ "swimlanes": [<SwimlaneSerializer>, ...] }` — all swimlanes in new order |
| `swimlanes.reordered` | Deprecated plural alias for `swimlane.reordered`; emitted alongside it until removed in 2.0 | Same as `swimlane.reordered` |

!!! note
    `contact_email` and `notes` are intentionally omitted from WebSocket swimlane payloads to prevent viewer-role clients from receiving PII that the REST API would withhold. Admins who need these fields should re-fetch the swimlane via REST after receiving an update event.

### Label events

| Event | Trigger | `data` shape |
|---|---|---|
| `label.created` | New label created | Full `LabelSerializer` object |
| `label.updated` | Label renamed or recolored | Full `LabelSerializer` object |
| `label.deleted` | Label deleted | `{ "label_uid": <string> }` |

### Card events

| Event | Trigger | `data` shape |
|---|---|---|
| `card.created` | New card created | Full `CardSerializer` object |
| `card.updated` | Card fields edited, comment added/deleted, attachment added/deleted, checklist changed | Full `CardSerializer` object |
| `card.deleted` | Card deleted | `{ "card_uid": <string> }` |
| `card.moved` | Card moved to a different column or swimlane | `{ "card": <CardSerializer>, "movement": <CardMovementSerializer> }` |
| `card.archived` | Card archived | `{ "card_uid": <string> }` |
| `card.unarchived` | Card restored from archive | Full `CardSerializer` object |

### Member events

| Event | Trigger | `data` shape |
|---|---|---|
| `member.added` | User added to board | Full `BoardMembershipSerializer` object |
| `member.updated` | Member role or moderator flag changed | Full `BoardMembershipSerializer` object |
| `member.removed` | User removed from board | `{ "user_id": <int> }` |

### Keepalive

| Event | Trigger | `data` shape |
|---|---|---|
| `ping` | Server keepalive, sent every 30 seconds | `{}` |

Clients must silently ignore `ping` events. The keepalive prevents NATs and reverse proxies from dropping idle connections. Do not treat unknown event types as errors.

---

## Group channel (since 1.1)

Pushes board create/update/delete events for boards that currently live in the group, letting the group page keep its board list live without polling.

### Connecting

```
ws://<host>/ws/groups/<group_id>/
```

Authentication uses the same session-cookie mechanism as the board channel. The server checks group membership (via `get_accessible_group_ids`) before completing the handshake and closes with the same `4001` / `4003` codes on failure.

### Event reference

| Event | Trigger | `data` shape |
|---|---|---|
| `board.created` | Board created in this group, imported into it, or moved into it from elsewhere | Full `BoardSerializer` object |
| `board.updated` | Board in this group renamed or otherwise edited | Full `BoardSerializer` object |
| `board.deleted` | Board deleted, or moved out of this group | `{ "board_id": <int>, "board_uid": <string> }` |
| `board.star_changed` (since 1.1) | A board in this group was starred or unstarred — fires alongside the board-channel `board.star_changed`. Star is per-user state; clients filter on `user_id === me` and ignore events for other users | `{ "uid": <string>, "user_id": <int>, "is_starred": <bool> }` |
| `group.updated` | Group ownership transferred | `{ "id": <int>, "owner_id": <int> }` |
| `ping` | Server keepalive, sent every 30 seconds | `{}` |

A board that moves between groups emits two events atomically (single `transaction.on_commit` callback): `board.deleted` on the old group's channel and `board.created` on the new group's channel.

Personal boards (no group) do not emit events on any group channel.

---

## Delivery guarantees

WebSocket events are registered with `transaction.on_commit()` inside a database transaction. This means:

- Events are **never broadcast for rolled-back transactions** — if a write fails and rolls back, no event fires.
- Events fire **after** the transaction commits, so the data is guaranteed to be visible to any subsequent REST read by the time the event reaches clients.

There is no at-least-once delivery guarantee — if a client is disconnected when an event fires, it will not be replayed. Clients should re-fetch the full board state (`GET /api/v1/boards/{id}/full/`) on reconnect.

---

## Client example (JavaScript)

```js
const boardId = 42;
// Session cookie is sent automatically by the browser on the upgrade request
const ws = new WebSocket(`ws://localhost:8000/ws/boards/${boardId}/`);

ws.onmessage = (event) => {
  const { event: type, data } = JSON.parse(event.data);
  switch (type) {
    case "card.created":
      // add card to local state
      break;
    case "card.updated":
      // update card in local state
      break;
    case "card.deleted":
      // remove card from local state by data.card_id
      break;
    case "card.moved":
      // update card position and record movement
      break;
    default:
      // ignore unknown event types for forward compatibility
  }
};

ws.onclose = (event) => {
  if (event.code === 4001) {
    // not authenticated — redirect to login
  } else if (event.code === 4003) {
    // authenticated but not a member of this board — do not retry
  }
  // otherwise: reconnect logic and re-fetch full board state
};
```
