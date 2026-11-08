# Board changes appear instantly for everyone

<a id="real-time-updates"></a>

WebSockets (Django Channels + Valkey) push every board change to all connected clients, with no polling. Valkey ships in the default `docker-compose.yml`, so there is nothing to set up.

**Why it matters:** Open tabs and teammates stay in sync without a page refresh.

**Yes, but:** background tabs can miss events. Visiban re-fetches the board when a tab returns to the foreground and after every reconnect; see [Tab-focus reconciliation](#tab-focus-reconciliation).

**Watch out:** production needs a Valkey instance, set via `REDIS_URL`; see [Requirements](#requirements).

## How it works

1. When a user opens a board, the frontend opens a WebSocket connection to `ws://{host}/ws/boards/{board_id}/`.
2. The browser SPA authenticates with the session cookie. Unauthenticated connections are closed with code `4001`, connections from a non-member are closed with `4003`, and so are connections from an account with a pending password or username change (the same account-state checks apply to REST, MCP, and WebSocket connections). These codes are sent before the connection opens, so the bundled server (Daphne) delivers them to the browser as a failed connection (HTTP `403` on the upgrade, close code `1006`), not as the code itself. See [How a refused handshake reaches the client](../api/websockets.md#how-a-refused-handshake-reaches-the-client); delivering the codes is tracked in #2145.
3. Any mutation (card, column, swimlane, label, member, or board setting change) broadcasts an event to all clients subscribed to that board's channel group.
4. The frontend applies the event to local state, keeping all open tabs in sync without a page refresh.

Native, CLI, and agent clients have no cookie jar to send, so they authenticate with a short-lived **ticket** (since 1.2) obtained over the REST API instead. See [WebSocket API → Ticket authentication](../api/websockets.md#ticket-authentication-since-12) for the full flow.

## Connection status

The top-right corner of the board toolbar shows the connection state via the **ConnectionStatus** component. When healthy the indicator is intentionally quiet; it becomes prominent only when there is a problem:

- 🟢 **Live** — WebSocket connected; bare dot with the word "Live" (label visible at wide viewports only — quiet by design)
- 🟡 **Reconnecting…** — connection dropped; client is retrying automatically; amber pill with label always shown
- 🟡 **Stale** — connected but no event has arrived in over 60 seconds; amber pill indicates the feed may be lagging
- 🟡 **Connecting…** — initial connection attempt in progress; amber pill
- 🔴 **Offline** — connection permanently failed (authentication error or repeated failures); red pill — reload the page to reconnect, or sign in again if the session ended

**Reconnect rules:**

- The client reconnects automatically after 3 seconds if the connection drops.
- If the server closes an **open** connection with code `4001` (unauthenticated) or `4003` (unauthorized), no retry is attempted. The indicator switches directly to **Offline**. Today the server sends only `4003` on an open connection.
- A connection refused at the handshake (for example because you are signed out, are not a member, or the server is having a problem) reaches the browser as a failed connection, not as one of these codes. The client treats it like a dropped connection and keeps retrying every 3 seconds, with the indicator on **Reconnecting…**, and does not sign you out (#2145).
- **Session expiry** (since 1.3): a `4001`, or a `4003` where your session itself has ended (expired, revoked, or logged out elsewhere), signs you out of the web app just like any other expired-session response, even if you make no other request, so per-user preferences such as recent boards are cleared. A `4003` caused only by lost access to the board or group keeps you signed in: the web app checks your session first. Board and group pages behave the same way.
- If the server cannot confirm your access because of a temporary server problem, such as the database being briefly unreachable, it closes the connection with code `1011` instead, and the client keeps reconnecting until the server recovers (since 1.2).

After you log out or change your password, open board and group tabs show the connection indicator as **Offline** within about 30–40 seconds. Reload the page to reconnect. This includes the tab you changed your password in. Logging out in one browser does not affect tabs signed in through another session. See [Credential revocation](../api/websockets.md#credential-revocation-since-12).

## Event types

Board-channel events fall into a few categories:

- **Board** — settings changes, deletion, and per-user star toggles
- **Members** — added, role changed, or removed (removing the current user also closes their connection; if that event is lost, the server's access re-check still closes the connection, with code `4003`, at the first board change, or the first keepalive ping (sent every 30 seconds), more than about 7 seconds after the server last confirmed their access — see [Access re-check and eviction](../api/websockets.md#access-re-check-and-eviction))
- **Cards** — created, field changes, moves between columns/swimlanes, deletion, archive, and restore
- **Columns, swimlanes, and labels** — created, updated, deleted, and (for columns and swimlanes) reordered
- **Feature-specific families** riding the same board channel: saved-filter events (see [Saved Filters](saved-filters.md)), custom field and swimlane field events (see [Custom Fields](custom-fields.md#api-and-real-time-events)), and, when [Issue Board Lens](issue-board-lens.md) is enabled, Git Lens connection events

For the complete, canonical event list, trigger conditions, and `data` shape for every event, see **[WebSocket API — Event reference](../api/websockets.md#event-reference)**. That table is CI-enforced against the backend event registry and frontend handlers, so it cannot drift the way a second hand-maintained copy would.

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

Deleting a column, swimlane, or board deletes the cards in it too, and only the container's `*.deleted` event is sent, not one `card.deleted` per card. Connected clients remove those cards when they receive it. A card elsewhere that one of the deleted cards was blocking gets a `card.updated` event, so its blocked indicator clears without a reload. See [Deleting a container deletes its cards](../api/websockets.md#deleting-a-container-deletes-its-cards).

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
    The legacy plural event names (`columns.reordered`, `swimlanes.reordered`) emitted in 1.0 were dropped in 1.1 (#944). Only the singular forms above are emitted. Subscribe to `column.reordered` / `swimlane.reordered`.

### `card.moved` payload

The `card.moved` event includes both the updated card and the movement record, the same shape returned by `POST /api/v1/boards/{id}/cards/{id}/move/`:

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

There is no `movement` key if only the position changed within the same column/swimlane cell (a pure reorder, with no column or swimlane change).

Since 1.3 the event also carries `sibling_positions`, the other cards whose position the move changed in its source and target cells, as `{ "id", "position", "version" }` entries (#1890). The web app applies them so every open copy of the board shows the cards in the same order as the mover's, without a reload. A frame from an older server has no `sibling_positions` and still applies. See [Sibling positions on `card.moved`](../api/websockets.md#sibling-positions-on-cardmoved-since-13) for the rules.

## Group real-time events

<span class="vb-version" title="Added in 1.1">1.1+</span>

Visiban also exposes a per-group WebSocket channel for clients that display the group detail page (board list, member list, live board creation).

- **Connection URL:** `ws://{host}/ws/groups/{group_id}/`
- **Authentication:** same as the board channel; session cookie required. Unauthenticated connections are closed with code `4001`; connections from users without group membership, or with a pending password or username change, are closed with code `4003`. No retry is attempted for either code when it closes an open connection. At the handshake both codes reach the browser as a failed connection, which is retried like a dropped one (#2145). The web app handles both cases as described under [Reconnect rules](#connection-status).
- **What it streams:** board lifecycle changes within the group (created, updated, deleted or moved out, starred/unstarred), group lifecycle changes (created, updated, deleted, starred/unstarred, including subgroups), group-level labels, group membership changes (removing the current user also closes their connection, mirroring the board channel), and invite link revocations.

Each payload follows the standard `{"event": "...", "data": {...}}` envelope. The group channel does not emit card-level events; those remain on the per-board channel.

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

To guard against this, Visiban automatically re-fetches the full board state when a tab returns to the foreground (`visibilitychange` event). A 30-second throttle prevents redundant fetches when the user rapidly switches between tabs. The reload is "silent": it does not flash a loading skeleton.

The board is also re-fetched each time the WebSocket reconnects after a dropped connection, regardless of the 30-second throttle, so changes made while you were disconnected appear without a manual refresh.

- The initial connection triggers an extra fetch only when it opens more than 1 second after the board loaded (since 1.3), for example after a slow handshake or a first attempt that failed and was retried, because changes made in that gap are never delivered. It follows the same drag rule as a reconnect. A connection that opens sooner does not refetch, so a change made in that shorter gap shows up at the next refresh (tracked in #2089). The group page does the same for its boards list (since 1.3, #2088): when its connection first opens more than 1 second after the page loaded, or before the initial load has been applied, it re-reads the boards list once. Only the boards list is re-read, not the group's details, subgroups or members (tracked in #2136). Since 1.3 (#2139), a board created, renamed, starred, deleted or moved out of the group while that re-read is in flight is applied again on top of the server's answer, so a deleted board no longer comes back and a new one no longer disappears until the next reload.
- If a reconnect happens while you are dragging a card, column, or swimlane, the refresh waits and runs once when the drag ends, so the board can briefly show its pre-disconnect state until then.
- When several refreshes overlap, only the most recently started one updates the board.

## Resuming after a dropped connection

<span class="vb-version" title="Added in 1.2">1.2+</span>

The SPA handles a dropped connection by refetching the full board on reconnect, as described above. A consumer outside the browser (a second front end, a sync job, the MCP server's REST client) can instead replay exactly what it missed:

- Every event the board channel broadcasts is durably persisted in the same transaction as the mutation it describes, and each WebSocket frame carries the matching `event_id`.
- `GET /api/v1/boards/{id}/events/?after=<event_id>` returns the missed events in order, so a consumer can catch up without re-fetching the whole board.
- Events are retained for `BOARD_EVENT_RETENTION_DAYS` days (default 30); a cursor with a pruned event after it that the consumer could have read gets `410 Gone` with a re-sync hint and a cursor to resume from afterward, instead of silently skipping events. A consumer idle on a quiet board whose own cursor event was pruned, with nothing it could have read pruned after it, keeps reading (1.3+, #2058, #2079).

See [Board Change Feed API](../api/events.md) for the full reference.

## Optimistic concurrency control

Card moves use optimistic concurrency control (OCC) to prevent lost updates. Every card carries a `version` number that increments when the card is moved or its fields are updated. Archiving or restoring a card in the app or through the API, and adding or removing comments, attachments, checklist items or relations, leave it unchanged. Since 1.3 every save of the card in the Django admin increments it, including one that only archives or restores it (#2040), so a move that was in flight when an admin saved the card is refused with `409 Conflict` rather than applied over the admin's edit. The frontend includes the card's current `version` in a move request. If another user modified the card in the meantime, the server returns `409 Conflict` with a `version_conflict` error code, and the frontend refreshes the board automatically.

The version check is backward-compatible: clients that omit the `version` field bypass the OCC check entirely.

The web app also uses `version` to order the copies of a single card it receives. A card reaches the browser both as the HTTP response to your own change (an edit, move, create or restore) and as `card.*` WebSocket frames, and the two transports are not ordered against each other: the response to your edit can arrive after a frame for someone else's later edit. The board view and the open card panel therefore discard such a copy when its `version` is **lower** than the one already on screen. A copy with the **same** version still replaces it, because comment, attachment, checklist and relation changes, and archiving or restoring a card in the app, change the card's counters without incrementing `version`. A Django admin save increments it (since 1.3, #2040), so it is ordered against a concurrent save of the same card like any other edit. When a move fails, only that card's location is put back, and not if a newer version of it arrived while the move was in flight; changes to other cards that arrived meanwhile are kept. A full board refresh (on reconnect, when the tab regains focus, after a version conflict, or from **Refresh board**) replaces the board with what the server returned, except for cards that changed on screen while the refresh was in flight. For those, the same rule applies: a card whose copy on screen has a higher `version` keeps it, a card created or restored meanwhile stays even though the server's answer predates it, and a card deleted or archived on its own meanwhile does not come back. Every other card takes the server's copy, even an older one, so a refresh still repairs a board that missed events. Since 1.3, every other change that reaches the board while a refresh is in flight is applied again, in the order it arrived, on top of what the server returned (#2130): a column or swimlane created, edited, reordered or deleted, a label created, renamed or deleted, a member added, changed or removed, a custom field definition change, and board settings, share link and star state. A column or swimlane deleted meanwhile therefore stays deleted together with the cards the server's answer places in it, including cards the board had missed, while a card the answer places elsewhere (a move the board had missed) stays. A column created meanwhile stays, so a card created in it is not left without a column. Each change is applied as what it changed: an item added, edited, removed or moved. A change that replaces a whole list (a reorder, or the **Fields** tab saving its list) sets only the items and fields it changed, so it does not remove a column, swimlane or field definition that the server's answer has and the board had missed. A change the server's answer already contains is therefore applied a second time without effect. A column or swimlane deleted meanwhile also takes its archived cards with it, which the server's answer still counted, so the archived-card count is read again once the refresh lands. If that request fails, the count stays too high until the next refresh, which only makes the Danger Zone ask for confirmation when it does not need to. Some changes that arrive while a refresh is in flight can still be reverted by it:

- A change that does not increment `version` (a comment, attachment, checklist item or relation) can revert until the next event for that card when the server read the board before it. An equal `version` must take the server's copy, so the two cannot be told apart. A complete fix needs an event cursor on `/full/` (#2089).
- A card you are moving can briefly snap back to its old place while your move request is still in flight. The move's response then puts it in its new place.

*Fixed in 1.3 (#1969): a single older copy could replace a newer one, and a failed move undid every change that arrived during it. Fixed in 1.3 (#2038): a full refresh could revert a card edit, move, create, restore, delete or archive that arrived while it was in flight, until the next event for that card. Fixed in 1.3 (#2130): it could also bring back a column or swimlane deleted meanwhile, with its cards, until the next full refresh, since no later event removes it again, and revert other changes to columns, swimlanes, labels, members, custom field definitions and board settings.*

## ASGI server

The backend runs under **daphne** (ASGI) instead of gunicorn (WSGI) to support WebSocket connections. This is handled automatically in `docker-compose.yml` and the Helm chart.
