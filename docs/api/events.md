# Replay missed board changes with one cursor request

`GET /api/v1/boards/{id}/events/?after=<last event_id>` returns what happened on a board since your last event, in order.

```bash
curl -H "Authorization: Token $TOKEN" \
  "http://localhost:8000/api/v1/boards/3/events/?after=84200"
# 200 {"results": [{"id": 84213, "event": "card.moved", ...}], "next_cursor": 84213, "next": 84213}
```

**Why it matters:** a consumer that drops offline can resume from its last cursor and miss nothing, without re-fetching the whole board.

**How it works:** every board mutation is appended to a durable, ordered feed that a consumer outside the
Django process — a second front end, a CRM sync job, the MCP REST client — can read with a
cursor instead of holding a WebSocket open and hoping it never drops.

**Yes, but:** history is bounded by an operator-set retention window, so handle `410 Gone` by re-fetching `GET /api/v1/boards/{id}/full/`. See [Retention](#retention).

**Go deeper:** [the endpoint](#get-apiv1boardsidevents), [stability guarantees](#stability-and-versioning), [what each reader sees](#fields-that-depend-on-who-is-reading).

!!! info "Since 1.2"
    The change feed is new in Visiban 1.2.

The feed completes the [WebSocket API](websockets.md) rather than replacing it. The socket tells you about a change *now*; the feed tells you what happened while you were not listening. Both carry the same payloads, so one handler serves both.

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

A consumer with no socket can poll the feed on its own schedule; the cursor makes repeat reads exact.

---

## `GET /api/v1/boards/{id}/events/`

Returns committed events for one board, in ascending `id` order.

**Access** — the requesting user's board role, exactly as for
`GET /api/v1/boards/{id}/full/` and for the WebSocket handshake. Every board
role, including `viewer`, may read the feed. A caller with no access to the board gets `404`. The feed
returns the board's retained rows whenever the reader joined the board, bounded
by [retention](#retention), and each row is filtered for the reader by the rules
in [Fields that depend on who is reading](#fields-that-depend-on-who-is-reading),
which match what the WebSocket sends that reader.

**Query parameters**

| Parameter | Default | Description |
|---|---|---|
| `after` | `0` | Return only events with an `id` strictly greater than this. Pass the last `id` you processed. `0` (or omitted) starts at the oldest retained event. |
| `limit` | `100` | Maximum events to return. Must be between `1` and `500`. |

Both parameters are validated, not clamped. A malformed `after` is a `400`, not a silent restart from the start of the feed, because a consumer that quietly replayed processed history would never notice. A `limit` outside the range is a `400` for the same reason: a consumer that asked for `10000` and silently got `500` would read `len(results) < limit` as "caught up" and stop paging with events unread.

**Response**

```json
{
  "results": [
    {
      "id": 84213,
      "event": "card.moved",
      "data": { "card": { "...": "..." }, "movement": { "...": "..." } },
      "actor_id": 7,
      "actor": { "id": 7, "username": "alice", "display_name": "Alice", "avatar_url": "" },
      "created_at": "2026-09-15T10:22:41.881Z"
    }
  ],
  "next_cursor": 84213,
  "next": 84213
}
```

| Field | Type | Description |
|---|---|---|
| `id` | integer | The event's id. This is the value that appears as `event_id` on the matching WebSocket frame, and the value to pass back as `after`. |
| `event` | string | Event type — the same dotted names the WebSocket uses. See the [event reference](websockets.md#event-reference). |
| `data` | object | The broadcast payload, verbatim. Identical to the WebSocket frame's `data`. |
| `actor_id` | integer / null | The user who caused the event, or `null` when there was no authenticated actor. A plain column, not a foreign key: it keeps its value even after the account is deleted. |
| `actor` | object / null | *Added in 1.2 (#1663).* The same user as `actor_id`, in the nested `BoardUser` shape (`id`, `username`, `display_name`, `avatar_url`) used by every board-scoped actor field except invite links — see [Actor fields](index.md#actor-fields-who-did-it). It resolves even when the actor has since left the board, so you do not need the member list to label a row. `null` when `actor_id` is `null` or the account no longer exists. Every actor on a page is fetched in one query, so page cost does not grow with the number of distinct actors. |
| `created_at` | string | ISO 8601 timestamp of the write. |
| `next_cursor` | integer / null | Cursor for the following page, or `null` when the caller is caught up. `null` means "this page was short, so it was the last one"; a non-null value means "ask again with `after=<next_cursor>`". It is an integer, not an opaque string: it is the exclusive `id` cursor that `after` takes. |
| `next` | integer / null | **Deprecated; use `next_cursor`.** Always identical to `next_cursor`. Kept through 1.x for clients written against 1.2.0-beta.1. |

### Paging

```bash
curl -s -H "Authorization: Token vbn_..." \
  "http://localhost:8000/api/v1/boards/42/events/?after=0&limit=200"
```

Call again with `after` set to the previous `next_cursor` until `next_cursor` is `null`. Order is by `id`, the commit order. Never re-sort by `created_at`: two events can share a timestamp.

### Pagination shapes

Besides the standard offset envelope (`{count, offset, page_size, results}`) and bare arrays for small bounded lists, the API has three cursor/link shapes (see [Pagination](index.md#pagination) for the full list). They differ on purpose, and each is frozen by the release that introduced it (decision recorded for #1869):

| Endpoint | Shape | Why it stays |
|---|---|---|
| Change feed, `GET /boards/{id}/events/` | `{results, next_cursor: int \| null}` (plus deprecated `next`) | The cursor is the exclusive event `id`, a monotonic integer a consumer also gets as `event_id` on WebSocket frames, so it is an integer rather than an opaque string. The key name matches `/cards/`, but the request parameter and type differ: the feed takes an integer via `after`, while `/cards/` takes an opaque string via `cursor`. The two do not share a request contract. |
| Cross-board `GET /cards/` | `{results, next_cursor: string \| null}` | The cursor is an opaque string the server may re-encode, so clients must not parse it. |
| Card timeline (1.1) | `limit`/`offset` with `next` / `previous` as URL strings | A limit/offset shape, not a cursor. Frozen in 1.1; a field cannot be renamed or retyped without a major bump. |

New cursor-paginated endpoints should name the response key `next_cursor` but document their own request parameter and cursor type. A client cannot reuse the feed's `after` for `/cards/`, nor `cursor` for the feed (the feed ignores an unknown `cursor` and returns page 1 again). The feed's earlier `next` key (1.2.0-beta.1) stays as a deprecated duplicate, so the rename is not breaking.

### Errors

| Status | Body | Condition |
|---|---|---|
| `400 Bad Request` | `{"detail": "after must be an integer event id.", "code": "invalid_query_param"}` | `after` is not an integer, or is negative (`"after must not be negative."`). |
| `400 Bad Request` | `{"detail": "limit must be between 1 and 500.", "code": "invalid_query_param"}` | `limit` is not an integer (`"limit must be an integer."`), or is out of range. |
| `404 Not Found` | — | No board with that id, or the requesting user has no access to it. |
| `410 Gone` | `{"detail": "...", "code": "cursor_expired", "resync_url": "http://.../api/v1/boards/42/full/"}` | The cursor has been pruned and newer events exist, so continuity cannot be proven. Re-sync via `resync_url` and resume from the newest `event_id` seen after that. |

!!! note "410 is deliberately narrow"
    A pruned cursor returns `410` only when newer events exist that the consumer might have skipped. A cursor pruned with *nothing newer behind it* returns an ordinary empty page: a consumer idle longer than the retention window has missed nothing and need not re-sync.

---

## Event coverage

Every event type the WebSocket emits on the board channel is persisted:
`board.*`, `column.*`, `swimlane.*`, `label.*`, `custom_field.*`,
`swimlane_custom_field.*`, `card.*`, `member.*`, `saved_filter.*`,
`lens_connection.*`, and *(1.2+)* `invite_link.*` (payload `{ "id" }` only,
readable by every board member like the socket frame). The [WebSocket event
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
- **A container delete is one delete event.** Deleting a column, swimlane, or
  board deletes its cards too, and the feed records only the `column.deleted`,
  `swimlane.deleted`, or `board.deleted` row, with no `card.deleted` row per
  card. Treat it as the delete of every card in that container. A surviving
  card that one of the deleted cards was blocking gets a `card.updated` row
  with its lowered `blocker_count` (since 1.2), on its own board's feed. See
  [Deleting a container deletes its cards](websockets.md#deleting-a-container-deletes-its-cards).

### Fields that depend on who is reading

- `is_moderator` is stripped from `member.added` and `member.updated` payloads
  for readers below `admin`, exactly as the WebSocket consumer strips it per
  subscriber (#978) — except on the row belonging to the reader themselves,
  which always carries the field (#1191, mirroring the `/full/` self-row
  exception from #1173). Replaying from the feed cannot surface a field the
  socket withheld from that same reader.
- `is_site_admin` is stripped from the same payloads for readers below
  `admin`, with no self-row exception, matching the WebSocket consumer (since
  1.2). An unknown reader role strips it.
- `is_starred` on `board.created` and `board.updated` rows is the **actor's**
  star state at the time of the event. Since 1.2 it is returned only to the
  reader who is that row's `actor_id`; every other reader gets the row without
  the `is_starred` key, and a row with a null `actor_id` omits it for everyone
  (#1705). This matches the WebSocket, which sends the field only to the acting
  user's own sockets. Clients should not rely on it for star state: use
  `board.star_changed`, or read `GET /api/v1/boards/{id}/` for the caller's own
  value (#1559).
- `share_token`, `share_token_expires_at`, `share_link_active` (1.2+) and
  `share_token_hash` (which no serializer declares) are dropped from every
  payload for every reader, whatever their role. Board admins read them over
  REST only (`GET /api/v1/boards/{id}/full/` and the share action response;
  `share_token` on `/full/` is deprecated since 1.2, see
  [Boards](boards.md#get-apiv1boardsidfull)).
- `board.star_changed`, `saved_filter.created` and `saved_filter.deleted` rows
  are returned only to the user named in their `user_id`, matching the
  WebSocket, which delivers those frames only to that user's own sessions (#1677). Other readers' pages simply do not contain them; a page
  is still filled to `limit` from the remaining rows, and cursors are unaffected.
- `invite` on an invite-redemption `member.added` row is returned to `admin` /
  `site_admin` readers only, with no self-row exception, matching the WebSocket
  consumer (#1677). An unknown reader role strips it.
- `custom_field_values` on `swimlane.created`, `swimlane.updated` and
  `swimlane.reordered` rows is re-filtered on every read against the board's
  **current** swimlane field definitions (#1677). A stored row keeps the values
  that were shareable when it was written; a field marked `is_admin_only` or
  deleted since then is omitted from that row for every reader, admins included,
  because the WebSocket never carries admin-only values to anyone. Stored rows are
  not rewritten, so a field made shareable again replays again. The
  `custom_field_values` key itself is always present.

---

## Retention

Events are kept for `BOARD_EVENT_RETENTION_DAYS` days (default `30`) and removed by a management command. Nothing expires on its own: **an install that never runs the pruner grows the `board_events` table forever**. Retention bounds how much history the feed returns: any reader with access to the board receives every retained row for it, whenever they joined, each filtered by the rules in [Fields that depend on who is reading](#fields-that-depend-on-who-is-reading). Run the pruner on a schedule:

```bash
# See what would go, without deleting anything
python manage.py prune_board_events --dry-run

# Prune using the configured window
python manage.py prune_board_events

# Override the window for one run
python manage.py prune_board_events --days 7
```

Schedule it nightly. Both deployment paths ship an opt-in scheduler with this job **off** by default. Turn it on with `SCHEDULE_PRUNE_BOARD_EVENTS=03:00` in `.env` for the Compose `scheduler` profile, or `scheduledJobs.pruneBoardEvents.enabled=true` in Helm. Host cron also works:

```
0 3 * * * docker compose run --rm backend python manage.py prune_board_events
```

See [Scheduled Jobs](../administration/scheduled-jobs.md).

Deletion runs in batches (`--batch-size`, default `5000`), so a large cleanup does not hold locks against concurrent writers for the whole run.

See [Configuration](../administration/configuration.md) for
`BOARD_EVENT_RETENTION_DAYS`.

---

## Sizing the window

Pick a retention window longer than the longest outage a consumer should survive. A consumer offline longer than the window is not broken: it gets a `410` and re-syncs. But every re-sync is a full `/full/` fetch, so a too-short window makes routine restarts expensive.

---

## Stability and versioning

> **Added in 1.2**

The change feed is a public contract from 1.2 and follows the same compatibility rules as the REST API from 1.0 onward. It is **not** experimental.

- **The endpoint, its `after` and `limit` parameters, and the response envelope** (`results`, `next_cursor`, and the deprecated `next`) are never removed or renamed in a minor or patch release. The cursor semantics (`after` is exclusive, ordering is by `id`, `next_cursor` is `null` once a page comes back short) and the `400`, `404`, and `410` error behavior described below do not change.
- **Row fields** (`id`, `event`, `data`, `actor_id`, `actor`, `created_at`) only gain fields; an existing field keeps its name and type and is never removed.
- **Event types and payloads** carry the same `{event, data}` payloads as the WebSocket, so the same rules apply: an event type is never removed, a payload field is never removed, and new event types and payload fields can appear in any minor release. Clients should ignore event types and fields they do not recognize. Retiring an event follows the process in [Retiring an event](../development/websocket-event-contract.md#retiring-an-event).
- **Per-reader fields are the exception.** The fields documented under [Fields that depend on who is reading](#fields-that-depend-on-who-is-reading) are per-reader and may be withheld from recipients who lack access, including when the rule is tightened for security reasons (as in 1.2). Clients must treat them as optional.
- **`next_cursor` is the cursor; `next` is deprecated.** `next_cursor` is the documented cursor field. `next` was the name in 1.2.0-beta.1 and is still emitted with an identical value in every response, so clients written against the beta keep working. New clients should read `next_cursor`. `next` is removed only at a major version bump. See [Pagination shapes](#pagination-shapes).
- A part of the feed that must go away is marked deprecated here for at least one minor release, and removal needs a major version bump.
- **Not covered:** how long history is kept. The retention window is an operator setting (`BOARD_EVENT_RETENTION_DAYS`), so a consumer must handle `410 Gone` rather than assume any particular depth of history. See [Retention](#retention).
