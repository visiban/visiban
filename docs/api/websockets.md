# Get live board updates over a WebSocket

From a browser, open `ws://localhost:8000/ws/boards/42/` with your session cookie. From a script, trade a token for a one-time ticket first:

```bash
curl -s -X POST http://localhost:8000/api/v1/auth/ws-ticket/ -H "Authorization: Token $TOKEN"
# then connect to: ws://localhost:8000/ws/boards/42/?ticket=<ticket>
```

Every frame arrives as `{ "event": "card.moved", "data": { ... }, "event_id": 84213 }`.

**Why it matters:** a handler written against these events also serves the [change feed](events.md), which carries the same payloads.

**Watch out:** a ticket is consumed by the upgrade, so get a new one for every connection attempt, including every reconnect. A failed handshake closes with `4001` (not authenticated) or `4003` (not a board member).

**Go deeper:** [Ticket authentication](#ticket-authentication-since-12), [Event reference](#event-reference), [Delivery guarantees](#delivery-guarantees), [Client example](#client-example-javascript).

**The big picture:** Visiban uses WebSockets to push real-time updates to all connected clients. Two channels are available:

- **Board channel** — scoped to one board; receives all mutation events for that board
- **Group channel** (since 1.1) — scoped to one group; receives board create/update/delete events for boards that live in that group

A single open board tab maintains one board channel connection. A group-list page (`/groups/<id>`) maintains one group channel connection.

---

## Board channel

### Connecting

```
ws://<host>/ws/boards/<board_id>/
```

There are two ways to authenticate the handshake:

- **Session cookie** — used by the browser SPA. The browser automatically sends the session cookie on the upgrade request, so no parameter is needed:

    ```
    ws://localhost:8000/ws/boards/42/
    ```

- **Ticket** (since 1.2) — used by token-authenticated clients. See [Ticket authentication](#ticket-authentication-since-12) below.

When a handshake carries an `Origin` header (browsers always send one), it must match a configured origin: an entry in `CORS_ALLOWED_ORIGINS` or `CSRF_TRUSTED_ORIGINS`, or an origin whose host equals an exact (non-pattern) `ALLOWED_HOSTS` entry. A handshake whose `Origin` matches none of these is refused before authentication. Clients that send no `Origin` header (CLI, native, and agent clients using a ticket) are not affected. The exact-host match ignores both the scheme and the port (an `http` origin matches an `https` host). `ALLOWED_HOSTS` entries that are `*` or start with a dot (such as `.example.com`) are not applied to this match: an install that uses them must list its public origin (for example `https://boards.example.com`) in `CORS_ALLOWED_ORIGINS` or `CSRF_TRUSTED_ORIGINS`, otherwise browser WebSocket connections are refused. An `Origin` that includes credentials, a path, a query, or a fragment, or more than one `Origin` header, is refused. `manage.py check` and `check --deploy` emit system-check warning `accounts.W002` when `DEBUG` is off, `ALLOWED_HOSTS` contains `*` or a leading-dot entry, no non-loopback origin is listed in `CORS_ALLOWED_ORIGINS` or `CSRF_TRUSTED_ORIGINS`, and no exact public host is listed in `ALLOWED_HOSTS`. Listing a public origin clears it. To accept the configuration deliberately, add `"accounts.W002"` to `SILENCED_SYSTEM_CHECKS` (set the `SILENCED_SYSTEM_CHECKS=accounts.W002` environment variable; Helm: `backend.settings.silencedSystemChecks`).

The server checks board membership before completing the handshake, regardless of which method authenticated the connection. The connection is closed with one of two application-defined codes if either check fails. The table also lists `1011`, which the server sends on an open connection when its access re-check cannot complete:

| Close code | Meaning |
|---|---|
| `4001` | Unauthenticated — no valid session cookie, and no valid ticket. The client must log in (or obtain a fresh ticket) before reconnecting. |
| `4003` | Unauthorized — the user is authenticated but is not a member of this board. Re-login will not help for a non-member. The same account-state checks as REST and MCP apply: an account with a pending password or username change is also closed with `4003`, at connect and on the access re-check, and once the pending change is completed a later reconnect can succeed. An account deactivated while a connection is open is closed with `4003` at the next access re-check; a reconnect attempt by an inactive account is refused at authentication with `4001`. Since 1.2, `4003` can also arrive **mid-stream** on an open connection, when the user loses access or when the credential it connected with is revoked (logout, password change, revoked session or token). With database-backed sessions (the default) and cache-only sessions (since 1.3), `4003` means the server completed the check and found no access; a server-side failure during the check closes with `1011` instead. See **Cache-only sessions** under [Credential revocation](#credential-revocation-since-12) for the handshake caveat. See [Access re-check and eviction](#access-re-check-and-eviction). |
| `1011` | Internal error (standard code, since 1.2 for this case) — the server could not complete the mid-stream access re-check, for example during a database outage. The frame that triggered the check is not delivered. This is not a loss of access: reconnect. The Visiban web app reconnects after its fixed reconnect delay (3 seconds); exponential backoff is tracked in #606. Until the server recovers the reconnect handshake can fail too, so keep retrying. The server also sends `1011` if it fails unexpectedly after the handshake. |

Standard WebSocket close codes (`1000` normal, `1001` going away, `1006` abnormal) may also be observed for transport-level disconnects.

---

## Ticket authentication (since 1.2)

Session and CSRF cookies are `SameSite=Lax`, so the cookie is not sent on a WebSocket upgrade initiated from another origin. Native, CLI, and agent clients have no cookie jar at all. Those clients authenticate with a **ticket**: a short-lived, single-use credential obtained over REST and spent on the handshake.

A ticket **authenticates only**. Board and group membership is still resolved on every connection, so a ticket for a non-member is closed with `4003` exactly as a session connection would be.

### 1. Obtain a ticket

Call [`POST /api/v1/auth/ws-ticket/`](authentication.md#post-apiv1authws-ticket) with any supported REST credential — a PAT, a session token, or a session cookie. A scoped PAT must hold the `write` scope to mint a ticket; see [Authentication → ws-ticket](authentication.md#post-apiv1authws-ticket).

```bash
curl -s -X POST http://localhost:8000/api/v1/auth/ws-ticket/ \
  -H "Authorization: Token vbn_your_personal_access_token"
```

```json
{
  "ticket": "sW9qL2v8dYb1rKp4mNx7cT0zQe3fA6hJ5uV8iO1lP2g",
  "expires_at": "2026-09-14T10:15:30Z"
}
```

### 2. Spend it on the handshake

Pass the ticket as the `ticket` query parameter:

```
ws://<host>/ws/boards/<board_id>/?ticket=<ticket>
```

The upgrade consumes the ticket. **Get a new ticket for every connection attempt**, including every reconnect.

### Rules

| Rule | Detail |
|---|---|
| Single use | The first connection to present a ticket consumes it. A replay is closed with `4001`. |
| Short lived | Valid for 30 seconds from issuance. Request it immediately before connecting, not at app startup. |
| Not board-scoped | One ticket authenticates the bearer for either `ws/boards/<id>/` or `ws/groups/<id>/`. Authorization is still enforced per connection. |
| Fails closed | A ticket that is expired, already spent, or tampered with is closed with `4001` — even if the request also carries a valid session cookie. |
| Rate limited | The issuing endpoint is throttled per user. Back off on `429` rather than retrying in a tight loop. |
| Bound to its credential | A ticket is bound to the credential it was obtained with (since 1.2, #1483). If that credential is revoked before the ticket is spent (logout, PAT deleted or expired, session token deleted), the handshake is closed with `4001`. After the handshake, the socket stays bound to it. See [Credential revocation](#credential-revocation-since-12). |

!!! warning "Do not put a Personal Access Token in the WebSocket URL"
    Query strings are recorded in reverse-proxy access logs and proxy history. A PAT placed there is a long-lived credential leak with no time limit. A ticket is single-use and expires in 30 seconds, which bounds the exposure — but it does not remove it: anything able to read the access log and redeem the ticket before your client's own upgrade arrives would win the race and connect as you, once. Single use at least makes that visible rather than silent, since your own connection is then rejected with `4001`.

    If you terminate TLS at a proxy you control, drop the query string from the access-log format for the `/ws/` location to close this off entirely.

---

## Message format

All server-to-client messages use the same envelope:

```json
{ "event": "<event_type>", "data": { ... }, "event_id": 84213 }
```

`event` is a dotted string identifying the event type. `data` is event-specific — see the table below.

`event_id` (since 1.2) is the id of this event's row in the board [change feed](events.md). It is **additive** — `event` and `data` are unchanged — and is **omitted entirely**, never sent as `null`, on the few frames that are broadcast without a feed row (the group channel's frames, and `ping`). Keep the last `event_id` you processed and hand it to `GET /api/v1/boards/<id>/events/?after=<event_id>` after a reconnect to replay exactly what you missed, instead of re-fetching `/full/`.

Clients should ignore unknown event types to remain forward-compatible with new events added in future releases.

---

## Event reference

!!! note "This table is enforced, not maintained by hand"
    Every name below is checked by CI against the event registries in the backend and the
    event handlers in the web client — a name missing from any of the three fails the
    build. If you are adding an event, see
    [WebSocket event contract](../development/websocket-event-contract.md).

### Board events

Board and group `board.*` event payloads never carry the share-link fields (`share_token`, `share_token_expires_at`, and from 1.2 `share_link_active`), and neither does the change feed. Board admins read them over REST from [`GET /api/v1/boards/{id}/full/`](boards.md) and from the share action response (`share_token` on `/full/` is deprecated since 1.2; the share action response is where the token is meant to be read). A change to the share link reaches admin sockets as [`share_link.updated`](#share-link-events-since-13) (since 1.3), which carries the link's state but never the token.

| Event | Trigger | `data` shape |
|---|---|---|
| `board.created` | New board created (only emitted to subscribers already connected to the board channel) | Full `BoardSerializer` object. `is_starred` is sent only to the sockets of the user who made the change (creator or importer), with that user's value; every other subscriber gets the payload without the `is_starred` key (since 1.2, #1705). On a board created in the Django admin there is no request, so the value that user receives is a constant `false`. Use `board.star_changed` for per-user star state (#1559). On a Visiban JSON/CSV import ([`POST /api/v1/boards/import/`](boards.md#post-apiv1boardsimport)) it also carries `import_options` — all five resolved booleans (`labels`, `cards`, `comments`, `checklist`, `history`; added in 1.2), plus `shift_dates_from` (a `YYYY-MM-DD` string; added in 1.2) when the import sent it or applied the file's `date_anchor` in its place, `shift_dates` when the import sent it, and `shift_dates_to` when it was sent and dates moved (#1949). The same payload goes to the group channel when the import sets `group_id`. `import_options` is absent on ordinary board creation, Trello imports, and group-move events. |
| `board.updated` | Board name, description, or settings changed | Full `BoardSerializer` object. `is_starred` is sent only to the sockets of the user who made the change, with that user's value; every other subscriber gets the payload without the `is_starred` key (since 1.2, #1705). A share link's enable, rotate, revoke or server-side clear has no acting user, so `is_starred` is omitted for every subscriber (see [Share link events](#share-link-events-since-13)). On a board changed in the Django admin there is no request, so the value that user receives is a constant `false`. A client merging the payload keeps its own value. Use `board.star_changed` for per-user star state (#1559). |
| `board.deleted` | Board was deleted, with everything on it. No `card.deleted` or `column.deleted` frames are sent for the cascade; see [Deleting a container deletes its cards](#deleting-a-container-deletes-its-cards) | `{ "board_uid": <string> }` |
| `board.star_changed` | Board starred or unstarred. Per-user state: delivered only to the sockets of the user in `user_id` (the starring user's other tabs), never to other subscribers (#1677). Clients should still filter on `user_id === me` | `{ "uid": <string>, "user_id": <int>, "is_starred": <bool> }` |
| `saved_filter.created` | Saved filter created (the private `state_json` is intentionally not broadcast — only the creating user receives the full filter via the REST response). Per-user state: delivered only to the sockets of the user in `user_id` (#1677) | `{ "filter_id": <int>, "user_id": <int> }` |
| `saved_filter.deleted` | Saved filter deleted. Per-user state: delivered only to the sockets of the user in `user_id` (#1677) | `{ "filter_id": <int>, "user_id": <int> }` |

### Column events

| Event | Trigger | `data` shape |
|---|---|---|
| `column.created` | New column created | Full `ColumnSerializer` object |
| `column.updated` | Column renamed, recolored, or settings or [policy](../features/column-policies.md) (since 1.3) changed | Full `ColumnSerializer` object |
| `column.deleted` | Column deleted, with every card in it (archived cards included). No `card.deleted` frames are sent for those cards; see [Deleting a container deletes its cards](#deleting-a-container-deletes-its-cards) | `{ "column_uid": <string> }` |
| `column.reordered` | Column order changed (since 1.1) | `{ "columns": [<ColumnSerializer>, ...] }` — all columns in new order |

### Swimlane events

| Event | Trigger | `data` shape |
|---|---|---|
| `swimlane.created` | New swimlane created | `SwimlaneSerializer` object (public fields only — `contact_email` and `notes` are omitted regardless of role) |
| `swimlane.updated` | Swimlane updated | `SwimlaneSerializer` object (same field rules as above). Since 1.3 the object also carries `wip_limit`, `weight_limit`, `limit_enforcement` and `limit_column_ids` (#1150), additive. A column delete that removes the column from a swimlane's `limit_column_ids` sends a `swimlane.updated` for that swimlane (before `column.deleted`); a list left empty becomes `null` |
| `swimlane.deleted` | Swimlane deleted, with every card in it (archived cards included). No `card.deleted` frames are sent for those cards; see [Deleting a container deletes its cards](#deleting-a-container-deletes-its-cards) | `{ "swimlane_uid": <string> }` |
| `swimlane.reordered` | Swimlane order changed (since 1.1) | `{ "swimlanes": [<SwimlaneSerializer>, ...] }` — all swimlanes in new order |

!!! note
    `contact_email` and `notes` are intentionally omitted from WebSocket swimlane payloads to prevent viewer-role clients from receiving PII that the REST API would withhold. Admins who need these fields should re-fetch the swimlane via REST after receiving an update event.

### Label events

| Event | Trigger | `data` shape |
|---|---|---|
| `label.created` | New label created | Full `LabelSerializer` object |
| `label.updated` | Label renamed or recolored | Full `LabelSerializer` object |
| `label.deleted` | Label deleted | `{ "label_uid": <string> }` |

### Custom field events (since 1.2)

Schema changes only. A change to a card's **values** arrives as `card.updated`, whose
payload carries the card's `custom_field_values`.

| Event | Trigger | `data` shape |
|---|---|---|
| `custom_field.created` | New custom field definition created | Full `CustomFieldDefinitionSerializer` object |
| `custom_field.updated` | Definition renamed, retyped, or its choices/pinning/number format/choice colors changed | Full `CustomFieldDefinitionSerializer` object |
| `custom_field.deleted` | Definition deleted (and every card value with it) | `{ "custom_field_uid": <string> }` |
| `custom_field.reordered` | Definition order changed | `{ "custom_fields": [<CustomFieldDefinitionSerializer>, ...] }` — all definitions in new order |

### Swimlane field events (since 1.2)

Schema changes only, and a separate set from the card-level events above — swimlane
(row) fields are an independent per-board schema. A change to a swimlane's **values**
arrives as `swimlane.updated`, whose payload carries the swimlane's
`custom_field_values`.

| Event | Trigger | `data` shape |
|---|---|---|
| `swimlane_custom_field.created` | New swimlane field definition created | Full `SwimlaneCustomFieldDefinitionSerializer` object |
| `swimlane_custom_field.updated` | Definition renamed, retyped, or its choices/pinning/visibility/number format/choice colors changed | Full `SwimlaneCustomFieldDefinitionSerializer` object |
| `swimlane_custom_field.deleted` | Definition deleted (and every swimlane value with it) | `{ "swimlane_custom_field_uid": <string> }` |
| `swimlane_custom_field.reordered` | Definition order changed | `{ "swimlane_custom_fields": [<SwimlaneCustomFieldDefinitionSerializer>, ...] }` — all definitions in new order |

!!! warning "Admin-only values never travel over the board channel"
    A board's WebSocket group holds every role at once, so every `swimlane.updated`
    payload is built from the **public** swimlane serializer. A field defined with
    `is_admin_only` (the default) is therefore absent from that payload for everyone,
    admins included — an admin sees the new value on their next REST fetch, not in
    real time. This is the same behavior `contact_email` and `notes` have always had,
    for the same reason.

    A client that keeps swimlane state locally must therefore **merge** this payload
    rather than replace with it, or an admin's own copy of the row loses its
    admin-only values on any unrelated edit.

    The [change feed](events.md#fields-that-depend-on-who-is-reading) applies the
    same rule to stored rows at read time: `swimlane.created`, `swimlane.updated`
    and `swimlane.reordered` rows replay only the values of fields that are
    shareable **now**. A field marked `is_admin_only` (or deleted) after a row was
    written is absent from that row on every later read (#1677).

### Card events

| Event | Trigger | `data` shape |
|---|---|---|
| `card.created` | New card created | Full `CardSerializer` object |
| `card.updated` | Card fields edited, comment added/deleted, attachment added/deleted, checklist changed, [relation](cards.md#relations-since-12) added/removed, card [blocked or unblocked](cards.md#block-and-unblock-since-13) (since 1.3) | Full `CardSerializer` object |
| `card.deleted` | Card deleted | `{ "card_uid": <string> }` |
| `card.moved` | Card moved to a different column or swimlane, or reordered within its cell | `{ "card": <CardSerializer>, "movement": <CardMovementSerializer>, "sibling_positions": [{ "id", "position", "version" }, ...] }` — the `movement` object also carries `card_uid` and `card_title` so board-level consumers can identify the card without a second fetch. A reorder within the same column and swimlane sends no `movement` key. `sibling_positions` (since 1.3) lists the other cards the move renumbered; see [the note below](#sibling-positions-on-cardmoved-since-13) |
| `card.archived` | Card archived | `{ "card_uid": <string> }` |
| `card.unarchived` | Card restored from archive | Full `CardSerializer` object |

!!! note "Manual blocked state rides on `card.updated` (since 1.3)"

    Blocking and unblocking a card (#1149) publish `card.updated`, not a new
    event type. The card object carries three additive fields: `is_blocked`
    (manual or relation block), `blocked_at` and `blocked_reason`. No field was
    removed or renamed, so a client that does not know them keeps working and
    simply ignores them. The change feed records the same `card.updated` row.

In the [change feed](events.md), a row for one of these events can later be
redacted by an operator's card-history purge: same keys, with the card's content
values set to `null` (since 1.3; see [Redacted card events](events.md#redacted-card-events)).
Live frames are never redacted.

These shapes are the same whichever writer made the change: the REST API or the
[MCP](mcp.md) write tools. *Fixed in 1.2 (#1926): a card created, moved or updated
through MCP sent the MCP tool's own return shape in `card.created`, `card.moved`
and `card.updated`, which clients could not apply.*

!!! note "One change can publish several card frames (since 1.2)"

    A relation change alters two cards, so adding or removing one publishes
    **two** `card.updated` frames — one per card at each end — rather than a
    single frame describing the relation. Each carries a complete card.

    For the same reason, archiving, restoring or deleting a card also publishes
    a `card.updated` frame for every card it was actively blocking, alongside
    that card's own `card.archived` / `card.unarchived` / `card.deleted` frame:
    an archived blocker stops counting toward its targets' `blocker_count`, and
    without those frames a client would keep rendering a blocked indicator for
    a blocker that is no longer on the board. This holds whichever way the
    card is archived or restored: through the REST API, the MCP
    `archive_card` tool, or by editing its archived date in the Django admin.
    Deleting a column, swimlane or
    board does the same for the cards its deleted cards were blocking (see
    [Deleting a container deletes its cards](#deleting-a-container-deletes-its-cards)).

    A client that applies `card.updated` by replacing the card with that id
    needs no special handling for either case.

### Sibling positions on `card.moved` (since 1.3)

A move renumbers other cards. Leaving a cell closes the gap the card left
(the `position` of every active card after it in the source cell drops by
one), and entering a cell, or a reorder within one, makes room (the `position`
of every card at or after the target position rises by one). Before 1.3 the `card.moved` frame carried only the
moved card, so other clients kept the old positions of those siblings until
they reloaded the board (#1890).

Since 1.3 the frame also carries `sibling_positions`: one entry for every
**active** (not archived) card in the move's source and target cells whose
`position` the move changed, sorted by `id`:

```json
{
  "event": "card.moved",
  "data": {
    "card": { "id": 101, "column": 3, "swimlane": 2, "position": 1, "version": 5, "...": "..." },
    "movement": { "...": "..." },
    "sibling_positions": [
      { "id": 98,  "position": 0, "version": 2 },
      { "id": 104, "position": 2, "version": 7 }
    ]
  }
}
```

- `id` and `position` are the sibling's id and its position after the move.
  The moved card is never listed; its position is in `card`.
- `version` is the sibling's own `version`, which a position shift does not
  increment. A client that holds a copy of that card with a **higher**
  `version` has a later change to it (a move or an edit) and should skip the
  entry, by the same rule as [card versions](#delivery-guarantees).
- Only the source and target cells are covered, so the list is bounded by the
  size of those two cells. It is empty when the move shifted nothing (for
  example, a card moved to the end of an empty cell). The key is always present
  on frames from a 1.3 or later server.
- Apply an entry by setting that card's `position`, then sort the cell by
  `position`. Do not renumber the cell yourself: a reorder within one cell
  leaves a gap where the card was, and only the server's numbers match what a
  later `/full/` read returns.
- If the moved `card` in a frame is older than the copy you hold, skip the
  frame's `sibling_positions` too: a later change to that card has already
  reached you, and if it was another move in the same cell, its frame sent
  newer positions for the same siblings at the same sibling `version`.
- `version` cannot order two moves of *different* cards in one cell: both
  send the same siblings at the same `version`. Use the frame's `event_id`
  instead. Two moves that set the same card's position are ordered by
  `event_id` in commit order, because the later move locks that card's row
  before it writes its change-feed row. Remember, per card, the highest
  `event_id` whose frame set its position (as a sibling entry or as the moved
  card), and skip a sibling entry, or the moved card's `position`, from a
  frame with a lower `event_id`. Keep it per card: moves in unrelated cells
  are not ordered against each other, so a frame for one cell must not block
  another cell's entries. Clear it when you replace the board from `/full/`.
  A frame with no `event_id` (from a server before the change feed) cannot be
  compared, so apply it.

The Visiban web app applies these rules (since 1.3). An HTTP response has no
`event_id`, so a response that lands after a later frame can still put an
older position on screen until the next frame for that card or the next full
refresh; the same holds for a `card.updated` frame at an equal `version`.

The field is additive. A client written for 1.2 ignores it and behaves as
before, and a 1.3 client must accept a frame without it (from an older server
during a rolling upgrade, or a [change feed](events.md) row written before the
upgrade) and apply the card alone. The REST response to
`POST /api/v1/boards/{id}/cards/{id}/move/` does not carry the field; the
mover's own client receives it on its socket like every other subscriber.
Archived cards are left out because no client shows them in a cell; a restored
card's `card.unarchived` frame carries its current position.

### Deleting a container deletes its cards

A card belongs to exactly one column and one swimlane. Deleting a column,
swimlane, or board deletes every card in it, archived cards included, along with
their comments, checklist items, attachments, movements, and relations. The
server announces the container, not each card: a column delete publishes one
`column.deleted`, a swimlane delete one `swimlane.deleted`, and a board delete
one `board.deleted`. There is no `card.deleted` frame for a card that went with
its container, and none for the archived ones either. The same holds for a
delete made in the Django admin, and for the [change feed](events.md), which
records the same single delete event. Cards *outside* the container whose
`blocker_count` the delete lowered also get a `card.updated` frame each; see
"Cards that survive the delete" below.

A client that keeps cards locally must therefore treat a container delete as
the delete of its cards:

- On `column.deleted`, drop every card whose `column` is the deleted column's
  `id`. The frame carries only `column_uid`, so look the column up by `uid` in
  the state you already hold (from `/full/` or an earlier `column.created`) to
  find its `id`. Do this before removing the column itself.
- On `swimlane.deleted`, do the same with each card's `swimlane`.
- On `board.deleted`, discard the board's state; nothing on it remains.

This is the contract, not a gap that later releases will fill with per-card
frames: a column of thousands of cards is one delete frame, not thousands.
Deleting a user account in the Django admin does not delete cards: an account
that still owns boards cannot be deleted until its boards are transferred, and
a card's `created_by` and `assignee` are cleared, not cascaded.

**Cards that survive the delete (since 1.2).** A card outside the deleted
container can be blocked by a card inside it. Its row survives but its
`blocker_count` drops, so the delete is followed by one `card.updated` frame
for each such card, carrying the count after the delete — the same frame
[deleting a single card](#card-events) sends for the cards it blocked. Only
surviving cards get one: a blocked card deleted by the same cascade gets none,
and deleting an archived blocker sends none, because an archived card does not
count toward `blocker_count`. A container with no blocking relations to
surviving cards still publishes exactly its one delete frame. The same applies
to a delete made in the Django admin, single or bulk, including a card delete,
and the change feed records a `card.updated` row for each of these frames. A
card on another board (the Django admin can move a card, with its relations,
to another board) gets its frame on its own board's channel, never on the
deleted container's.

### Member events

| Event | Trigger | `data` shape |
|---|---|---|
| `member.added` | User added to board — by an admin, or by redeeming a [board invite](boards.md#board-invites) (since 1.2) | Full `BoardMembershipSerializer` object. When the member joined through an invite it also carries `"invite": { "id": <int>, "created_by_id": <int or null> }` (additive, since 1.2) — for `admin` / `site_admin` subscribers only (see the note below) |
| `member.updated` | Member role or moderator flag changed | Full `BoardMembershipSerializer` object |
| `member.removed` | User removed from board | `{ "user_id": <int> }` |

!!! note "`is_moderator` is filtered per-recipient"
    On `member.added` and `member.updated`, the `is_moderator` field is stripped from the broadcast payload for non-`admin` / non-`site_admin` subscribers (consistent with the REST response filtering, #978) — **except on the row that is the subscriber's own membership**, which always carries the field so a member promoted to moderator sees their own entitlement over the socket (#1191, mirroring the `/full/` self-row exception from #1173). Every other row stays stripped for a non-admin subscriber.

    `is_site_admin` (since 1.2) is sent only to `admin` / `site_admin` subscribers, with no self-row exception — see [Members](boards.md#members).

    `invite` on an invite-redemption `member.added` (since 1.2) is sent only to `admin` / `site_admin` subscribers, with no self-row exception (#1677). It exists so an admin's open invite list can refetch; other subscribers receive the membership row without it.

    The subscriber's role used for this filtering is resolved when the socket connects and re-resolved from the database whenever a `member.added` or `member.updated` frame is about the subscriber themselves (since 1.2, #1332). A board admin demoted to viewer therefore stops receiving `is_moderator` and `is_site_admin` on other members' rows starting with the demotion frame itself, and a promoted subscriber gains them, without reconnecting. If the re-resolved role grants no access to the board, the server closes the socket. Role changes that publish no `member.*` frame on the board channel — a group-membership role change, a board moved to another group, or a change to the user's all-content access — take effect at the server's periodic access re-check (see [Access re-check and eviction](#access-re-check-and-eviction)). They apply to the first frame forwarded after the socket's re-check window lapses, at most about 7 seconds after its last successful check. Before #1477 they took effect only on the next reconnect. Until the re-check runs, a demoted admin can still receive the admin-only fields for up to that window.

    The [change feed](events.md) applies the identical gate when the same event is read back over REST, so replaying from a cursor cannot surface a field the socket withheld.

### Invite events (since 1.2)

Emitted by the [board invite](boards.md#board-invites) endpoints. Refetch
signals only: every board subscriber receives them, including non-admins, so
they carry just the invite id. Admin clients refetch `GET /boards/{id}/invite-links/`
(board admin only) for the details — a site-admin client showing every board's
invites may instead refetch `GET /api/v1/admin/board-invite-links/`; other clients
should ignore them. Same names as
the group channel's invite events.

| Event | Trigger | `data` shape |
|---|---|---|
| `invite_link.created` | A board admin emailed an invite to someone, or created a shareable invite link | `{ "id": <int> }` |
| `invite_link.revoked` | An invite was revoked — by a board admin, by a site admin from the admin board invite list, automatically because its email could not be sent, or because its sender was deactivated | `{ "id": <int> }` |

A redeemed invite publishes no event of its own: the `member.added` frame it
causes carries the invite id when a membership was created. When redeeming
creates no membership — the person already had equal or higher access — the
invite is still consumed but **no frame is sent at all**, so an admin's open
invite list keeps showing it as pending until it is next fetched.
`GET /boards/{id}/invite-links/` is authoritative; refetch it on open.

These rows are also stored in the board's [change feed](events.md), where any
board member can read them — with the same `{ "id": <int> }` payload and
nothing more.

### Share link events (since 1.3)

Emitted when the board's [public share link](boards.md#post-apiv1boardsidshare)
is enabled, rotated or revoked, and when its expiry is edited in the Django
admin. It is also emitted when the server turns the link off on its own: when
the admin who enabled it loses admin rights on the board or their account is
deactivated or deleted, or when the public page refuses a link that has no
recorded enabler. **Admin-only:** the server sends the frame only to sockets
whose user is a board `admin` or `site_admin`, re-checked with the same
access check every frame gets (see
[Access re-check and eviction](#access-re-check-and-eviction)). Other
subscribers receive nothing, and their socket stays open. The
[change feed](events.md) applies the same rule to its rows.

| Event | Trigger | `data` shape |
|---|---|---|
| `share_link.updated` | A board admin enabled, rotated or revoked the share link; a Django admin user changed the link's expiry; or the server turned the link off because its enabler lost admin standing on the board | `{ "board_uid": <string>, "active": <bool>, "expires_at": <string or null>, "issued_at": <string or null> }` |

`active` and `expires_at` hold the values `GET /api/v1/boards/{id}/full/`
returns as `share_link_active` and `share_token_expires_at`. The names differ
because those two keys are removed from every frame, this one included.
`expires_at` is an ISO-8601 timestamp, or `null` for a link that never expires
and whenever `active` is `false`. A link past its expiry stays `active: true`
until it is rotated or revoked, as on `/full/`; no frame is sent when a link
expires.

`issued_at` tells a rotation apart. A rotation replaces the link but leaves
`active` at `true`, and with a never-expiring link `expires_at` does not change
either. On the frame for an enable or a rotate, `issued_at` is the ISO-8601
time the new link was issued. It is the same value the share action returned
to its caller as `share_token_issued_at`. On every other change (a revoke, a
server-side clear, an expiry edit) it is `null`, because no new link was
issued. A client that is still showing a link it received can compare the two
values: a non-null `issued_at` later than the one its own request returned
means that link was replaced and no longer works. Compare the times, not just
equality: the links of one board are issued one at a time, so a newer link
always has a later `issued_at`, and a delayed frame for an older link can
arrive after the response for a newer one. `issued_at` is a timestamp, not
derived from the token.

The payload never carries the token: show it to the admin from the share
action response, once. Nor does it carry the admin who enabled the link.
`share_link.updated` rows in the [change feed](events.md) are stored with no
actor, so their `actor_id` and `actor` are `null`.

Each of these changes also sends `board.updated`, as before 1.3. That frame
cannot carry the share state, so clients should read it from
`share_link.updated`. On an enable, rotate, revoke or server-side clear, that
`board.updated` has no acting user: its row in the change feed has a `null`
`actor_id` and `actor`, and its payload omits `is_starred` for every subscriber,
so a client merging it keeps its own value. A change to a board's group or owner
that also clears a link sends its own ordinary `board.updated` as well, which
keeps its actor. The Visiban web app merges this event into the open
board, so the **Sharing** tab follows another admin's change without a reload,
even while it is open. If the tab is still showing a link that was then
revoked or rotated elsewhere, it removes that link and says why.

### Git Lens events (since 1.2)

Emitted by the [Git Lens](git-lens.md) connection endpoints. They ride the
**board** channel, not a channel of their own, so a board member with the Lens tab open
sees it appear or disappear without a reload.

These two events and their payloads are part of the frozen 1.x WebSocket contract, even though the Git Lens REST endpoints remain experimental. Fields may be added but never removed or renamed.

| Event | Trigger | `data` shape |
|---|---|---|
| `lens_connection.configured` | Lens connection created or reconfigured on this board (admin only) | Full `LensConnectionSerializer` object (its `created_by` is `null` if the configuring user has since been deleted) |
| `lens_connection.removed` | Lens connection deleted from this board (admin only) | `{ "board_id": <int> }` |

### Keepalive

| Event | Trigger | `data` shape |
|---|---|---|
| `ping` | Server keepalive, sent every 30 seconds | `{}` |

Clients must silently ignore `ping` events. The keepalive prevents NATs and reverse proxies from dropping idle connections. Since 1.2, the server runs the [access re-check](#access-re-check-and-eviction) before each ping, so a socket can close with `4003` where a ping would otherwise have been sent. Do not treat unknown event types as errors.

---

## Group channel (since 1.1)

Pushes board create/update/delete events for boards that currently live in the group, letting the group page keep its board list live without polling.

### Connecting

```
ws://<host>/ws/groups/<group_id>/
```

Authentication uses the same two mechanisms as the board channel — session cookie, or a [ticket](#ticket-authentication-since-12) for token-authenticated clients. The server checks that the user is a member of the group or one of its ancestors before completing the handshake and closes with the same `4001` / `4003` codes on failure. *(1.2+)* Only a membership with one of the four roles (`admin`, `member`, `collaborator`, `viewer`) counts, as for the [group REST routes](groups.md#get-apiv1groups); owning the group is not enough on its own (#1829).

*(1.2+)* `board.created` and `board.updated` are delivered only to subscribers who can open that board, judged as for [`GET /api/v1/boards/{id}/`](boards.md#get-apiv1boardsid) and the board channel. A group member whose own membership on one board grants no access (its stored role is not one of the four roles) does not receive that board's frames; the socket stays open and every other frame is delivered (#1829). A `board.created` or `board.updated` frame whose `data` has no integer `id` is not delivered to anyone. Whether a subscriber can open a board is re-evaluated with the [access re-check](#access-re-check-and-eviction), so a change to their role on that board takes effect within the same window (about 7 seconds). `board.deleted` is not filtered: it carries only the board's identifiers.

### Event reference

| Event | Trigger | `data` shape |
|---|---|---|
| `board.created` | Board created in this group, imported into it, or moved into it from elsewhere | Full `BoardSerializer` object. `is_starred` is sent only to the sockets of the user who made the change (creator, importer or mover), with that user's value; every other subscriber gets the payload without the `is_starred` key (since 1.2, #1705). On a board created in, or moved into this group from, the Django admin there is no request, so the value that user receives is a constant `false`. Use `board.star_changed` for per-user star state (#1559). A Visiban JSON/CSV import into this group also carries `import_options` (all five resolved booleans, added in 1.2, plus `shift_dates_from` as a `YYYY-MM-DD` string when the import sent it or applied the file's `date_anchor`, `shift_dates` when sent, and `shift_dates_to` when sent and applied, added in 1.2); it is absent on ordinary creation, Trello imports, and move-in events. |
| `board.updated` | Board in this group renamed or otherwise edited | Full `BoardSerializer` object. `is_starred` is sent only to the sockets of the user who made the change, with that user's value; every other subscriber gets the payload without the `is_starred` key (since 1.2, #1705). On a board changed in the Django admin there is no request, so the value that user receives is a constant `false`. A client merging the payload keeps its own value. Use `board.star_changed` for per-user star state (#1559). |
| `board.deleted` | Board deleted, or moved out of this group | `{ "board_uid": <string> }` on outright delete; `{ "board_uid": <string>, "board_id": <int> }` on move-out (the legacy integer is retained on move-out only because clients keyed by `board_id` need to find the row to remove). Treat `board_id` as optional. |
| `board.star_changed` | A board in this group was starred or unstarred — fires alongside the board-channel `board.star_changed`. Star is per-user state: delivered only to the sockets of the user in `user_id`, never to other subscribers (#1677). Clients should still filter on `user_id === me` | `{ "uid": <string>, "user_id": <int>, "is_starred": <bool> }` |
| `group.created` | Subgroup created under this group, or this group itself created (fired on both the new group's channel and the parent's channel) | Full `GroupSerializer` object. `is_starred` is sent only to the sockets of the user who made the change, with that user's value; every other subscriber gets the payload without the `is_starred` key (since 1.2, #1705). Use `group.star_changed` for per-user star state (#1559). `can_place_boards` is not included: it is per-viewer and REST-only (#1692). The Visiban web client refetches the group on these events. |
| `group.updated` | Group renamed, board defaults changed, ownership transferred, or *(1.3+)* health status changed | Full `GroupSerializer` object. `is_starred` is sent only to the sockets of the user who made the change, with that user's value; every other subscriber gets the payload without the `is_starred` key (since 1.2, #1705). On a Django-admin ownership transfer there is no request, so the value the admin user receives is a constant `false`. Use `group.star_changed` for per-user star state (#1559). `can_place_boards` is not included: it is per-viewer and REST-only (#1692). The Visiban web client refetches the group on these events, and *(1.3+)* its subgroup and board lists, whose inherited health status may have changed. A health status change is sent on this group's channel only, not to its subgroups' or boards' channels (#1133). |
| `group.deleted` | Group deleted | `{ "id": <int> }` |
| `group.star_changed` | This group was starred or unstarred. Per-user state: delivered only to the sockets of the user in `user_id` (#1677). Clients should still filter on `user_id === me` | `{ "id": <int>, "user_id": <int>, "is_starred": <bool> }` |
| `group.label.created` | Group shared label created | Full `GroupLabelSerializer` object |
| `group.label.updated` | Group shared label renamed or recolored | Full `GroupLabelSerializer` object |
| `group.label.deleted` | Group shared label deleted | `{ "id": <int> }` |
| `member.added` | User joined this group via an invite link. Named to mirror the board channel's `member.added` so one frontend socket layer handles both | Full `GroupMembershipSerializer` object |
| `member.updated` | Group membership role changed. Mirrors the board channel's `member.updated` | Full `GroupMembershipSerializer` object |
| `member.removed` | User removed from this group. Fires alongside the board-channel `member.removed` sent to each board the user lost access to — that one evicts their board socket, this one keeps the group members panel live for the admins watching it. Also closes the removed user's own group-channel socket, mirroring the board channel's self-eviction (#1329). If this frame is lost, the [access re-check](#access-re-check-and-eviction) still closes that socket | `{ "user_id": <int> }` |
| `invite_link.created` | An invite link for this group was emailed to someone (new in 1.2). A refetch signal only: every group member receives it, including non-admins, so it carries just the link id — admins refetch `GET /invite-links/` (admin-only) for the details, and non-admin clients should ignore it | `{ "id": <int> }` |
| `invite_link.revoked` | An invite link for this group was revoked (also delivered to non-admin members; a refetch signal, like `invite_link.created`) — including an emailed link revoked automatically because its email could not be sent, or because its sender was deactivated (including via `PATCH /admin/users/{id}/`) or, *(1.2+)*, lost group admin rights through a demotion, a removal or the clearing of their `can_access_all_content` flag via `PATCH /admin/users/{id}/` — fired for each of their unused links in that group and its subgroups they can no longer administer. Also fired when the creator's account is deleted, and *(1.2+)* when a `parent` change on `PATCH /groups/{id}/` leaves a link's creator without admin rights over the moved subtree (unused links only; a consumed single-use link is left alone) | `{ "id": <int> }` |
| `ping` | Server keepalive, sent every 30 seconds | `{}` |

A board that moves between groups emits two events atomically (single `transaction.on_commit` callback): `board.deleted` on the old group's channel and `board.created` on the new group's channel. A board moved out of a group to personal sends only the `board.deleted`, and a personal board moved into a group sends only the `board.created`. Since 1.2 this is the same whether the move is made with [`POST /api/v1/boards/{id}/move-group/`](boards.md#post-apiv1boardsidmove-group) or by changing `group` with `PATCH`/`PUT /api/v1/boards/{id}/` or in the Django admin (#1684). Before 1.2, a `PATCH`/`PUT` or Django admin group change sent `board.updated` to the new group's channel only, so the old group's page kept listing the board until reloaded. The board channel receives `board.updated` for a group move either way.

Personal boards (no group) do not emit events on any group channel.

---

## Delivery guarantees

WebSocket events are registered with `transaction.on_commit()` inside a database transaction, so:

- Events are **never broadcast for rolled-back transactions**: a write that fails and rolls back fires no event.
- Events fire **after** the transaction commits, so the data is visible to any later REST read by the time the event reaches clients.
- The publish is **best-effort** (since 1.2). If the channel layer (Valkey) is unreachable when the event fires, the frame is dropped and the backend logs a `WARNING` (`board broadcast dropped` or `group broadcast dropped`, with the board or group id, event name, and exception class). The write still returns its normal success status, because the change is already committed. Before 1.2 such a write returned `500` even though it had been saved, and a retry created a duplicate.

Nothing orders socket frames against REST responses: the response to your own `PATCH` can arrive after a frame for a later change to the same card. To keep the newest copy, compare the card's `version` and discard a copy whose `version` is lower than the one you hold. Keep a copy with an equal `version`: comment, attachment, checklist and relation changes, and an archive or restore through the REST API or MCP, update a card's counters without incrementing `version`. Every other change to a card made through the REST API or MCP, and every Django admin save of a card (since 1.3, #2040, including one that only archives or restores it), increments it, so `version` orders those changes against each other. Operator maintenance outside those surfaces, such as the `clear_viewer_assignees` management command or the assignee cleared when a user account is deleted, does not increment it. The Visiban web app applies this rule to single-card frames and responses (since 1.3); its full board refreshes do not check it yet.

The socket itself has no at-least-once delivery guarantee. A frame sent while a client is disconnected, or dropped during a channel-layer outage, is never re-sent over the socket.

### Access re-check and eviction

A user who loses access to a board or group stops receiving its frames even if the `member.removed` frame announcing the removal is lost (since 1.2, #1477). That frame is best-effort like every other, so the server does not rely on it alone:

- When the socket's own user is the subject of a `member.removed` frame, the server closes the socket at once. This is the fast path.
- Before it forwards **any** frame, the server re-checks that the socket's user still has access. It uses the same rule as the handshake: `get_board_role` for a board channel, membership in the group or one of its ancestors for a group channel. A deactivated account has no access. The result is cached per socket for 5 seconds plus a random 0 to 2 seconds, redrawn after every check; the random part keeps a board's sockets from all re-checking at once. A busy board therefore costs at most one access query per socket per window. A `member.added` or `member.updated` frame about the socket's own user skips the cache.
- The re-check also confirms that the credential the socket connected with has not been revoked and that the password has not changed since the handshake. See [Credential revocation](#credential-revocation-since-12).
- Each keepalive ping (every 30 seconds) runs the same check first, so a socket on a quiet channel is re-checked even when no frames are published.
- The re-check also applies the same account-state checks as the REST API: an account with a pending password or username change has no access to the channel, at the handshake and on every re-check. Completing the pending change allows a later reconnect.
- If the re-check finds no access, the server closes the socket with close code `4003` and does not forward the frame that triggered the check. The client treats `4003` as final and does not reconnect.
- If the re-check itself fails while a frame is being forwarded, for example because the database is unreachable, the server still does not forward the frame. It logs a `WARNING` (`board access re-check failed` or `group access re-check failed`) and closes with `1011`, not `4003`, because the user has not been shown to lack access (since 1.2, #2003). The client reconnects; the Visiban web app does so after its fixed reconnect delay (3 seconds), with exponential backoff tracked in #606. The reconnect runs the full handshake access check, so it succeeds once the database is back if the user still has access, and is closed with `4003` if they do not. The Visiban web app shows the reconnecting state meanwhile and does not need a reload.
- If the re-check fails during a keepalive ping, the socket stays open. The server logs a `WARNING` (`… re-check failed during keepalive`), sends the ping, and retries at the next ping. Nothing is forwarded on that path, and only a definitive denial closes the socket.

The same window applies to the other changes the re-check picks up. A role change that sends no `member.*` frame on the board channel (a group role change, a board moved to another group, a change to all-content access) and the deactivation of a user's account both take effect within it.

The window bounds exposure; it does not eliminate it. If the eviction frame is lost, frames forwarded before the window lapses can still reach the removed user, for up to about 7 seconds (5 seconds plus at most 2 seconds) after the socket's last successful check. The socket closes before the first frame past that window is forwarded. An idle socket gets no frames, so nothing reaches the user, and its keepalive ping runs the re-check, closing it within about 30–40 seconds (one keepalive interval plus the re-check window) even if no frame arrives.

#### Credential revocation (since 1.2)

The re-check also verifies that the credential the socket connected with is still valid (#1483). The server closes the socket with `4003` within the access re-check window after logout, password change, or credential revocation:

| Change | Cookie connection | Ticket connection |
|---|---|---|
| Logout | Closes if this session logged out. A logout in another browser or session does not affect it. | Closes if the credential that minted the ticket logged out (the session, or the session token, which logout deletes). |
| Password change, from any endpoint or session | Closes. This includes the session that made the change: it is issued a new session key, and the open connection is tied to the old one. | Closes, whatever minted the ticket. |
| Session revoked or expired (session row deleted) | Closes. | Closes if a session minted the ticket. |
| PAT deleted or expired | Not affected. | Closes if that PAT minted the ticket. |
| Session token deleted or reissued | Not affected. | Closes if that token minted the ticket. |

When the close happens:

- On a channel with traffic, the close happens on the first frame after the re-check window.
- On a quiet channel, the keepalive ping (every 30 seconds, see [Keepalive](#keepalive)) runs the same check, so the close happens at the first ping after the window: within about 30–40 seconds (one keepalive interval plus the re-check window) even when no events are published.
- The check costs one extra indexed lookup per socket per window.

Related behavior and limits:

- **The tab that changed the password.** The Visiban web app treats `4003` as final. A browser tab that changes its own password keeps its new session, but its open board or group socket closes. The connection indicator shows the failed state until the page is reloaded. Other API clients should obtain a fresh credential (log in again, or mint a new ticket) and reconnect.
- **`SECRET_KEY` rotation.** Rotating `DJANGO_SECRET_KEY` without listing the old key in `SECRET_KEY_FALLBACKS` invalidates every session hash. Each open socket then closes once with `4003` at its next re-check, the same way Django logs every session out. If the old key is kept as a fallback, open sockets stay open.
- **Signed-cookie sessions.** With `SESSION_ENGINE` set to `django.contrib.sessions.backends.signed_cookies`, there is no server-side session record, so a logout cannot be detected for a connection that is already open. Password change, deactivation, and token revocation are still detected. The default database session engine and the cache engines detect logout. Startup emits system-check warning `accounts.W001` when the signed-cookie engine is configured.
- **Cache-only sessions.** With `SESSION_ENGINE` set to `django.contrib.sessions.backends.cache`, the re-check reads the session straight from the cache, so a cache outage is an error, not an empty session: a socket whose frame-path re-check hits it closes with the reconnectable `1011`, as for a database outage (an idle socket stays open and retries at its next ping), and not with the final `4003` (*1.3+*, #2014). This covers the re-check on an already-open socket (the frame path) only; a cache outage during the handshake itself is not mapped to a reconnectable code yet and is tracked in #2086. A session that is absent or expired still closes with `4003`. The `cached_db` and `db` engines do not misreport a cache outage as a revoked session.

### Missed frames

A transient publish failure does **not** close the socket, so a connected client gets no signal that it missed a frame and its view stays stale until its next resync. In the Visiban web app, the next resync is one of the following: the browser tab regaining focus, an event that triggers a refetch, or **Refresh board** in the connection popover. On the group page, it is the next socket reconnect.

How to resync:

- **API clients** can replay board events from the durable [change feed](events.md). Keep the last `event_id` you processed and call `GET /api/v1/boards/{id}/events/?after=<event_id>`.
- **On first connect**, the same gap exists between your initial `GET /api/v1/boards/{id}/full/` and the socket's handshake. The server adds a connection to the board's broadcast group only during the handshake, so a change committed after the snapshot was read and before the handshake completes is in neither the snapshot nor the stream. To close the gap, open the socket first and fetch `/full/` after it opens. Buffer the frames that arrive before the `/full/` response, then apply them on top of the snapshot in order, idempotently, since some of them may already be reflected in it (the same rule the [change feed](events.md#how-the-two-surfaces-fit-together) gives for a re-fetch). A frame applied as it arrives would be reverted by a snapshot read before that frame was committed. Alternatively, re-fetch `/full/` once after the socket opens, which has the same exposure for frames that arrive during that re-fetch.
- **The Visiban web app** does not read the change feed. The board view re-fetches full board state (`GET /api/v1/boards/{id}/full/`) in these cases:
    - When its socket reconnects. This happens immediately, without the 30-second throttle. If a drag is in progress, the refetch waits until the drag ends.
    - When its socket first opens more than 1 second after the board loaded (since 1.3, #1968), for example after a slow handshake or a first connection attempt that failed and was retried. It follows the same rules as a reconnect. The second is counted from when the `/full/` response arrived, not from when the server read the board, so a socket that opens within it does not trigger a refetch even though the gap also includes the time the server spent answering `/full/`. A frame committed inside that shorter gap is missed until the next resync below; a complete fix (an event cursor on `/full/`, or loading over the socket first) is tracked in #2089.
    - When the tab regains focus, at most once every 30 seconds.
    - After an event that triggers a refetch.
    - When you choose **Refresh board** in the connection popover.
- **Group-channel frames** have no feed row, so group clients re-fetch the group's boards list. The web app's group page does this when its socket reconnects. It does not yet resync on its socket's first open, so a group change committed between the page's boards-list fetch and that open is missed until the next reconnect (#2088).

---

## Client example (JavaScript)

Same-origin, session-cookie clients:

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
      // remove card from local state by data.card_uid
      break;
    case "column.deleted":
    case "swimlane.deleted":
      // remove the column or swimlane AND every card in it (no card.deleted
      // is sent for them; see "Deleting a container deletes its cards")
      break;
    case "card.moved":
      // update the card, record the movement, and (since 1.3) set the
      // position of each card in data.sibling_positions
      break;
    default:
      // ignore unknown event types for forward compatibility
  }
};

// Remember the newest event_id you processed; on reconnect, replay from it via
// GET /api/v1/boards/<id>/events/?after=<lastEventId> instead of re-fetching /full/.
// See the Change Feed page for the cursor and 410 re-sync rules.

ws.onclose = (event) => {
  if (event.code === 4001) {
    // not authenticated — redirect to login
  } else if (event.code === 4003) {
    // no access to this board — at the handshake, or mid-stream after access
    // was lost or the credential was revoked (see "Access re-check and
    // eviction"). Do not auto-retry.
  }
  // otherwise (including 1011, a failed server-side access re-check):
  // reconnect logic and re-fetch full board state
};
```

Token-authenticated clients (since 1.2) — a fresh ticket per connection, including
every reconnect, because each one is single-use:

```js
async function connect(boardId, apiToken) {
  const res = await fetch("http://localhost:8000/api/v1/auth/ws-ticket/", {
    method: "POST",
    headers: { Authorization: `Token ${apiToken}` },
  });
  if (!res.ok) throw new Error(`Could not obtain a ticket: ${res.status}`);
  const { ticket } = await res.json();

  // Connect immediately — the ticket expires 30 seconds after it is issued.
  return new WebSocket(
    `ws://localhost:8000/ws/boards/${boardId}/?ticket=${encodeURIComponent(ticket)}`
  );
}
```
