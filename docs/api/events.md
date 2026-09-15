# Board Change Feed API

!!! info "Since 1.2"
    The change feed is new in Visiban 1.2.

Every board mutation is appended to a durable, ordered feed. A consumer that is
not inside the Django process — a second front end, a CRM sync job, the MCP REST
client — can read that feed with a cursor instead of holding a WebSocket open and
hoping it never drops.

The feed does not replace the [WebSocket API](websockets.md); it completes it.
The socket is how you learn about a change *now*; the feed is how you find out
what happened while you were not listening. Both carry the same payloads, so one
handler serves both.

---

## How the two surfaces fit together

1. Open the board WebSocket and process frames as they arrive.
2. Remember the `event_id` of the last frame you processed.
3. When the socket drops and reconnects, call
   `GET /api/v1/boards/{id}/events/?after=<last event_id>` and replay the
   results through the same handler. No `/full/` re-fetch, no diffing.
4. If that call returns `410 Gone`, your cursor has aged out of the retention
   window. Re-fetch `GET /api/v1/boards/{id}/full/`, then resume from the newest
   `event_id` you see after that.

A consumer with no socket at all can poll the feed on its own schedule — the
cursor makes repeat reads exact rather than approximate.

---

## `GET /api/v1/boards/{id}/events/`

Returns committed events for one board, in ascending `id` order.

**Access** — the requesting user's board role, exactly as for
`GET /api/v1/boards/{id}/full/` and for the WebSocket handshake. Every board
role, including `viewer`, may read the feed: it replays frames the same user
could already have streamed. A non-member gets `403`.

**Query parameters**

| Parameter | Default | Description |
|---|---|---|
| `after` | `0` | Return only events with an `id` strictly greater than this. Pass the last `id` you processed. `0` (or omitted) starts at the oldest retained event. |
| `limit` | `100` | Maximum events to return. Must be between `1` and `500`. |

Both parameters are validated rather than clamped. A malformed `after` is a
`400`, not a silent restart from the beginning of the feed, because a consumer
that quietly replayed history it had already processed would have no way to
notice. A `limit` outside the range is a `400` for the same reason: a consumer
that asked for `10000` and silently received `500` would read
`len(results) < limit` as "caught up" and stop paging with events still unread.

**Response**

```json
{
  "results": [
    {
      "id": 84213,
      "event": "card.moved",
      "data": { "card": { "...": "..." }, "movement": { "...": "..." } },
      "actor_id": 7,
      "created_at": "2026-09-15T10:22:41.881Z"
    }
  ],
  "next": 84213
}
```

| Field | Type | Description |
|---|---|---|
| `id` | integer | The event's id. This is the value that appears as `event_id` on the matching WebSocket frame, and the value to pass back as `after`. |
| `event` | string | Event type — the same dotted names the WebSocket uses. See the [event reference](websockets.md#event-reference). |
| `data` | object | The broadcast payload, verbatim. Identical to the WebSocket frame's `data`. |
| `actor_id` | integer / null | The user who caused the event, or `null` when there was no authenticated actor. A plain id, not a nested user object — resolve it against the board's member list. |
| `created_at` | string | ISO 8601 timestamp of the write. |
| `next` | integer / null | Cursor for the following page, or `null` when the caller is caught up. `null` means "this page was short, so it was the last one"; a non-null value means "ask again with `after=<next>`". |

### Paging

```bash
curl -s -H "Authorization: Token vbn_..." \
  "http://localhost:8000/api/v1/boards/42/events/?after=0&limit=200"
```

Keep calling with `after` set to the previous response's `next` until `next` is
`null`. Order is by `id`, which is the commit order — never re-sort by
`created_at`, since two events can share a timestamp.

### Errors

| Status | Body | Condition |
|---|---|---|
| `400 Bad Request` | `{"after": ["Must be an integer event id."]}` | `after` is not an integer, or is negative. |
| `400 Bad Request` | `{"limit": ["Must be between 1 and 500."]}` | `limit` is not an integer, or is out of range. |
| `403 Forbidden` | `{"detail": "..."}` | The requesting user has no role on this board. |
| `404 Not Found` | — | No board with that id. |
| `410 Gone` | `{"detail": "...", "code": "cursor_expired", "resync_url": "http://.../api/v1/boards/42/full/"}` | The cursor has been pruned and newer events exist, so continuity cannot be proven. Re-sync via `resync_url` and resume from the newest `event_id` seen after that. |

!!! note "410 is deliberately narrow"
    A pruned cursor returns `410` only when there are newer events the consumer
    might have skipped past. A cursor that was pruned with *nothing newer behind
    it* returns an ordinary empty page — a consumer that has simply been idle
    longer than the retention window has missed nothing, and does not need to
    re-sync.

---

## Event coverage

Every event type the WebSocket emits on the board channel is persisted:
`board.*`, `column.*`, `swimlane.*`, `label.*`, `card.*`, `member.*`,
`saved_filter.*`, and `lens_connection.*`. The [WebSocket event
reference](websockets.md#event-reference) is the single list of payload shapes
for both surfaces.

Two consequences worth knowing:

- **A rolled-back mutation appears nowhere.** The feed row is written inside the
  same database transaction as the mutation it describes, and the broadcast is
  deferred until that transaction commits. A mutation the database refused
  produces neither a row nor a frame.
- **`board.deleted` is in the feed.** The event outlives the board it describes,
  so a consumer holding a cursor learns the board is gone rather than simply
  losing access mid-stream. Its own board is of course no longer readable, so
  fetch it from the cursor you already hold, not from a fresh call.

### Fields that depend on who is reading

- `is_moderator` is stripped from `member.added` and `member.updated` payloads
  for readers below `admin`, exactly as the WebSocket consumer strips it per
  subscriber (#978). Replaying from the feed cannot surface a field the socket
  withheld.
- `is_starred`, on `board.*` payloads, reflects the **actor's** state at the time
  of the event, not the reader's. This matches the WebSocket surface, where the
  same payload is fanned out to every subscriber. Read a board's own
  `GET /api/v1/boards/{id}/` for the caller's star state.

---

## Retention

Events are kept for `BOARD_EVENT_RETENTION_DAYS` days (default `30`) and removed
by a management command. Nothing expires on its own — **an install that never
runs the pruner grows the `board_events` table forever**:

```bash
# See what would go, without deleting anything
python manage.py prune_board_events --dry-run

# Prune using the configured window
python manage.py prune_board_events

# Override the window for one run
python manage.py prune_board_events --days 7
```

Schedule it, for example nightly:

```
0 3 * * * docker compose run --rm backend python manage.py prune_board_events
```

Deletion happens in batches (`--batch-size`, default `5000`) so a large cleanup
does not hold locks against concurrent writers for the length of the run.

See [Configuration](../administration/configuration.md) for
`BOARD_EVENT_RETENTION_DAYS`.

---

## Sizing the window

Pick a retention window longer than the longest outage a consumer is expected to
survive. A consumer offline for longer than the window is not broken by it — it
gets a `410` and re-syncs — but every such re-sync is a full `/full/` fetch, so a
window that is too short turns routine restarts into expensive ones.
