# WebSocket API

Visiban uses WebSockets to push real-time board updates to all connected clients. The WebSocket connection is board-scoped — each open board tab maintains one connection and receives all mutation events for that board.

---

## Connecting

```
ws://<host>/ws/boards/<board_id>/
```

Authentication uses the same token as the REST API. Pass it as a query parameter on the initial upgrade request:

```
ws://localhost:8000/ws/boards/42/?token=9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b
```

The server validates the token and board membership before completing the WebSocket handshake. An invalid token or non-member connection receives a close frame with code `4003`.

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
| `board.deleted` | Board was deleted | `{ "board_id": <int> }` |

### Column events

| Event | Trigger | `data` shape |
|---|---|---|
| `column.created` | New column created | Full `ColumnSerializer` object |
| `column.updated` | Column renamed, recolored, or settings changed | Full `ColumnSerializer` object |
| `column.deleted` | Column deleted | `{ "column_id": <int> }` |
| `columns.reordered` | Column order changed | `{ "columns": [<ColumnSerializer>, ...] }` — all columns in new order |

### Swimlane events

| Event | Trigger | `data` shape |
|---|---|---|
| `swimlane.created` | New swimlane created | `SwimlaneSerializer` object (public fields only — `contact_email` and `notes` are omitted regardless of role) |
| `swimlane.updated` | Swimlane updated | `SwimlaneSerializer` object (same field rules as above) |
| `swimlane.deleted` | Swimlane deleted | `{ "swimlane_id": <int> }` |
| `swimlanes.reordered` | Swimlane order changed | `{ "swimlanes": [<SwimlaneSerializer>, ...] }` — all swimlanes in new order |

!!! note
    `contact_email` and `notes` are intentionally omitted from WebSocket swimlane payloads to prevent viewer-role clients from receiving PII that the REST API would withhold. Admins who need these fields should re-fetch the swimlane via REST after receiving an update event.

### Label events

| Event | Trigger | `data` shape |
|---|---|---|
| `label.created` | New label created | Full `LabelSerializer` object |
| `label.updated` | Label renamed or recolored | Full `LabelSerializer` object |
| `label.deleted` | Label deleted | `{ "label_id": <int> }` |

### Card events

| Event | Trigger | `data` shape |
|---|---|---|
| `card.created` | New card created | Full `CardSerializer` object |
| `card.updated` | Card fields edited, comment added/deleted, attachment added/deleted, checklist changed | Full `CardSerializer` object |
| `card.deleted` | Card deleted | `{ "card_id": <int> }` |
| `card.moved` | Card moved to a different column or swimlane | `{ "card": <CardSerializer>, "movement": <CardMovementSerializer> }` |
| `card.archived` | Card archived | `{ "card_uid": <string> }` |
| `card.unarchived` | Card restored from archive | Full `CardSerializer` object |

### Member events

| Event | Trigger | `data` shape |
|---|---|---|
| `member.added` | User added to board | Full `BoardMembershipSerializer` object |
| `member.updated` | Member role or moderator flag changed | Full `BoardMembershipSerializer` object |
| `member.removed` | User removed from board | `{ "user_id": <int> }` |

---

## Delivery guarantees

WebSocket events are registered with `transaction.on_commit()` inside a database transaction. This means:

- Events are **never broadcast for rolled-back transactions** — if a write fails and rolls back, no event fires.
- Events fire **after** the transaction commits, so the data is guaranteed to be visible to any subsequent REST read by the time the event reaches clients.

There is no at-least-once delivery guarantee — if a client is disconnected when an event fires, it will not be replayed. Clients should re-fetch the full board state (`GET /api/boards/{id}/full/`) on reconnect.

---

## Client example (JavaScript)

```js
const boardId = 42;
const token = "9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b";
const ws = new WebSocket(`ws://localhost:8000/ws/boards/${boardId}/?token=${token}`);

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
  if (event.code === 4003) {
    // authentication failure — token invalid or not a board member
  }
  // reconnect logic and re-fetch full board state
};
```
