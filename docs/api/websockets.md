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

There are two ways to authenticate the handshake:

- **Session cookie** — used by the browser SPA. The browser automatically sends the session cookie on the upgrade request, so no parameter is needed:

    ```
    ws://localhost:8000/ws/boards/42/
    ```

- **Ticket** (since 1.2) — used by token-authenticated clients. See [Ticket authentication](#ticket-authentication-since-12) below.

The server checks board membership before completing the handshake, regardless of which method authenticated the connection. The connection is closed with one of two application-defined codes if either check fails:

| Close code | Meaning |
|---|---|
| `4001` | Unauthenticated — no valid session cookie, and no valid ticket. The client must log in (or obtain a fresh ticket) before reconnecting. |
| `4003` | Unauthorized — the user is authenticated but is not a member of this board. Re-login will not help for a non-member. The same account-state checks as REST and MCP apply: an account with a pending password or username change is also closed with `4003`, at connect and on the access re-check, and once the pending change is completed a later reconnect can succeed. An account deactivated while a connection is open is closed with `4003` at the next access re-check; a reconnect attempt by an inactive account is refused at authentication with `4001`. Since 1.2, `4003` can also arrive **mid-stream** on an open connection, when the user loses access, when the credential it connected with is revoked (logout, password change, revoked session or token), or when the server's access re-check fails, for example during a database outage. In the re-check-failure case a later reconnect can succeed. See [Access re-check and eviction](#access-re-check-and-eviction). |

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

The ticket is consumed by the upgrade. **Obtain a new ticket for every connection attempt**, including every reconnect.

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

Board and group `board.*` event payloads never carry the share-link fields (`share_token`, `share_token_expires_at`), and neither does the change feed. Board admins read them over REST from [`GET /api/v1/boards/{id}/full/`](boards.md) and from the share action response.

| Event | Trigger | `data` shape |
|---|---|---|
| `board.created` | New board created (only emitted to subscribers already connected to the board channel) | Full `BoardSerializer` object (`is_starred` is the creator's value and deprecated here; use `board.star_changed`, #1559). On a Visiban JSON/CSV import ([`POST /api/v1/boards/import/`](boards.md#post-apiv1boardsimport)) it also carries `import_options` — all five resolved booleans (`labels`, `cards`, `comments`, `checklist`, `history`; added in 1.2), plus `shift_dates_from` (a `YYYY-MM-DD` string; added in 1.2) when the import sent it. The same payload goes to the group channel when the import sets `group_id`. `import_options` is absent on ordinary board creation, Trello imports, and group-move events. |
| `board.updated` | Board name, description, or settings changed | Full `BoardSerializer` object. `is_starred` in this payload reflects the user who made the change, not the receiving client, and is deprecated in `board.created` / `board.updated` payloads; clients must ignore it and use `board.star_changed` (#1559). |
| `board.deleted` | Board was deleted | `{ "board_uid": <string> }` |
| `board.star_changed` | Board starred or unstarred. Per-user state; clients should filter on `user_id === me` and ignore events for other users | `{ "uid": <string>, "user_id": <int>, "is_starred": <bool> }` |
| `saved_filter.created` | Saved filter created (the private `state_json` is intentionally not broadcast — only the creating user receives the full filter via the REST response) | `{ "filter_id": <int>, "user_id": <int> }` |
| `saved_filter.deleted` | Saved filter deleted | `{ "filter_id": <int>, "user_id": <int> }` |

### Column events

| Event | Trigger | `data` shape |
|---|---|---|
| `column.created` | New column created | Full `ColumnSerializer` object |
| `column.updated` | Column renamed, recolored, or settings changed | Full `ColumnSerializer` object |
| `column.deleted` | Column deleted | `{ "column_uid": <string> }` |
| `column.reordered` | Column order changed (since 1.1) | `{ "columns": [<ColumnSerializer>, ...] }` — all columns in new order |

### Swimlane events

| Event | Trigger | `data` shape |
|---|---|---|
| `swimlane.created` | New swimlane created | `SwimlaneSerializer` object (public fields only — `contact_email` and `notes` are omitted regardless of role) |
| `swimlane.updated` | Swimlane updated | `SwimlaneSerializer` object (same field rules as above) |
| `swimlane.deleted` | Swimlane deleted | `{ "swimlane_uid": <string> }` |
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

### Card events

| Event | Trigger | `data` shape |
|---|---|---|
| `card.created` | New card created | Full `CardSerializer` object |
| `card.updated` | Card fields edited, comment added/deleted, attachment added/deleted, checklist changed, [relation](cards.md#relations-since-12) added/removed | Full `CardSerializer` object |
| `card.deleted` | Card deleted | `{ "card_uid": <string> }` |
| `card.moved` | Card moved to a different column or swimlane | `{ "card": <CardSerializer>, "movement": <CardMovementSerializer> }` — the `movement` object also carries `card_uid` and `card_title` so board-level consumers can identify the card without a second fetch |
| `card.archived` | Card archived | `{ "card_uid": <string> }` |
| `card.unarchived` | Card restored from archive | Full `CardSerializer` object |

!!! note "One change can publish several card frames (since 1.2)"

    A relation change alters two cards, so adding or removing one publishes
    **two** `card.updated` frames — one per card at each end — rather than a
    single frame describing the relation. Each carries a complete card.

    For the same reason, archiving, restoring or deleting a card also publishes
    a `card.updated` frame for every card it was actively blocking, alongside
    that card's own `card.archived` / `card.unarchived` / `card.deleted` frame:
    an archived blocker stops counting toward its targets' `blocker_count`, and
    without those frames a client would keep rendering a blocked indicator for
    a blocker that is no longer on the board.

    A client that applies `card.updated` by replacing the card with that id
    needs no special handling for either case.

### Member events

| Event | Trigger | `data` shape |
|---|---|---|
| `member.added` | User added to board — by an admin, or by redeeming a [board invite](boards.md#board-invites) (since 1.2) | Full `BoardMembershipSerializer` object. When the member joined through an invite it also carries `"invite": { "id": <int>, "created_by_id": <int or null> }` (additive, since 1.2) |
| `member.updated` | Member role or moderator flag changed | Full `BoardMembershipSerializer` object |
| `member.removed` | User removed from board | `{ "user_id": <int> }` |

!!! note "`is_moderator` is filtered per-recipient"
    On `member.added` and `member.updated`, the `is_moderator` field is stripped from the broadcast payload for non-`admin` / non-`site_admin` subscribers (consistent with the REST response filtering, #978) — **except on the row that is the subscriber's own membership**, which always carries the field so a member promoted to moderator sees their own entitlement over the socket (#1191, mirroring the `/full/` self-row exception from #1173). Every other row stays stripped for a non-admin subscriber.

    `is_site_admin` (since 1.2) is sent only to `admin` / `site_admin` subscribers, with no self-row exception — see [Members](boards.md#members).

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

### Git Lens events (since 1.2)

Emitted by the [Git Lens](git-lens.md) connection endpoints. They ride the
**board** channel, not a channel of their own, so a board member with the Lens tab open
sees it appear or disappear without a reload.

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

Authentication uses the same two mechanisms as the board channel — session cookie, or a [ticket](#ticket-authentication-since-12) for token-authenticated clients. The server checks group membership (via `get_accessible_group_ids`) before completing the handshake and closes with the same `4001` / `4003` codes on failure.

### Event reference

| Event | Trigger | `data` shape |
|---|---|---|
| `board.created` | Board created in this group, imported into it, or moved into it from elsewhere | Full `BoardSerializer` object (`is_starred` is the creator's value and deprecated here; use `board.star_changed`, #1559). A Visiban JSON/CSV import into this group also carries `import_options` (all five resolved booleans, added in 1.2, plus `shift_dates_from` as a `YYYY-MM-DD` string when the import sent it, added in 1.2); it is absent on ordinary creation, Trello imports, and move-in events. |
| `board.updated` | Board in this group renamed or otherwise edited | Full `BoardSerializer` object. `is_starred` in this payload reflects the user who made the change, not the receiving client, and is deprecated in `board.created` / `board.updated` payloads; clients must ignore it and use `board.star_changed` (#1559). |
| `board.deleted` | Board deleted, or moved out of this group | `{ "board_uid": <string> }` on outright delete; `{ "board_uid": <string>, "board_id": <int> }` on move-out (the legacy integer is retained on move-out only because clients keyed by `board_id` need to find the row to remove). Treat `board_id` as optional. |
| `board.star_changed` | A board in this group was starred or unstarred — fires alongside the board-channel `board.star_changed`. Star is per-user state; clients filter on `user_id === me` and ignore events for other users | `{ "uid": <string>, "user_id": <int>, "is_starred": <bool> }` |
| `group.created` | Subgroup created under this group, or this group itself created (fired on both the new group's channel and the parent's channel) | Full `GroupSerializer` object. `is_starred` in this payload is the acting user's value, not the receiving client's, and is deprecated in `group.created` / `group.updated` payloads; clients must ignore it and use `group.star_changed` for per-user star state (#1559). The Visiban web client is unaffected because it refetches the group on these events. |
| `group.updated` | Group renamed, board defaults changed, or ownership transferred | Full `GroupSerializer` object. `is_starred` in this payload is the acting user's value, not the receiving client's, and is deprecated in `group.created` / `group.updated` payloads; clients must ignore it and use `group.star_changed` for per-user star state (#1559). The Visiban web client is unaffected because it refetches the group on these events. |
| `group.deleted` | Group deleted | `{ "id": <int> }` |
| `group.star_changed` | This group was starred or unstarred. Per-user state; clients should filter on `user_id === me` | `{ "id": <int>, "user_id": <int>, "is_starred": <bool> }` |
| `group.label.created` | Group shared label created | Full `GroupLabelSerializer` object |
| `group.label.updated` | Group shared label renamed or recolored | Full `GroupLabelSerializer` object |
| `group.label.deleted` | Group shared label deleted | `{ "id": <int> }` |
| `member.added` | User joined this group via an invite link. Named to mirror the board channel's `member.added` so one frontend socket layer handles both | Full `GroupMembershipSerializer` object |
| `member.updated` | Group membership role changed. Mirrors the board channel's `member.updated` | Full `GroupMembershipSerializer` object |
| `member.removed` | User removed from this group. Fires alongside the board-channel `member.removed` sent to each board the user lost access to — that one evicts their board socket, this one keeps the group members panel live for the admins watching it. Also closes the removed user's own group-channel socket, mirroring the board channel's self-eviction (#1329). If this frame is lost, the [access re-check](#access-re-check-and-eviction) still closes that socket | `{ "user_id": <int> }` |
| `invite_link.created` | An invite link for this group was emailed to someone (new in 1.2). A refetch signal only: every group member receives it, including non-admins, so it carries just the link id — admins refetch `GET /invite-links/` (admin-only) for the details, and non-admin clients should ignore it | `{ "id": <int> }` |
| `invite_link.revoked` | An invite link for this group was revoked (also delivered to non-admin members; a refetch signal, like `invite_link.created`) — including an emailed link revoked automatically because its email could not be sent, or because its sender was deactivated (including via `PATCH /admin/users/{id}/`) or, *(1.2+)*, lost group admin rights through a demotion, a removal or the clearing of their `can_access_all_content` flag via `PATCH /admin/users/{id}/` — fired for each of their unused links in that group and its subgroups they can no longer administer. Also fired when the creator's account is deleted, and *(1.2+)* when a `parent` change on `PATCH /groups/{id}/` leaves a link's creator without admin rights over the moved subtree (unused links only; a consumed single-use link is left alone) | `{ "id": <int> }` |
| `ping` | Server keepalive, sent every 30 seconds | `{}` |

A board that moves between groups emits two events atomically (single `transaction.on_commit` callback): `board.deleted` on the old group's channel and `board.created` on the new group's channel.

Personal boards (no group) do not emit events on any group channel.

---

## Delivery guarantees

WebSocket events are registered with `transaction.on_commit()` inside a database transaction. This means:

- Events are **never broadcast for rolled-back transactions** — if a write fails and rolls back, no event fires.
- Events fire **after** the transaction commits, so the data is guaranteed to be visible to any subsequent REST read by the time the event reaches clients.
- The publish is **best-effort** (since 1.2). If the channel layer (Valkey) is unreachable when the event fires, the frame is dropped and the backend logs a `WARNING` (`board broadcast dropped` or `group broadcast dropped`, with the board or group id, event name, and exception class). The write that caused it still returns its normal success status, because the change is already committed. Before 1.2 such a write returned `500` even though it had been saved, and retrying it created a duplicate.

The socket itself has no at-least-once delivery guarantee. A frame sent while a client is disconnected, or dropped during a channel-layer outage, is never re-sent over the socket.

### Access re-check and eviction

A user who loses access to a board or group stops receiving its frames even if the `member.removed` frame that announces the removal is lost (since 1.2, #1477). That frame is published best-effort like every other frame, so the server does not rely on it alone:

- When the socket's own user is the subject of a `member.removed` frame, the server closes the socket at once. This is the fast path.
- Before it forwards **any** frame, the server re-checks that the socket's user still has access. It uses the same rule as the handshake: `get_board_role` for a board channel, `get_accessible_group_ids` for a group channel. A deactivated account has no access. The result is cached per socket for a window of 5 seconds plus a random 0 to 2 seconds, redrawn after every check. The random part keeps the sockets on one board from all re-checking at the same moment. So a busy board costs at most one access query per socket per window. A `member.added` or `member.updated` frame about the socket's own user skips the cache.
- The re-check also confirms that the credential the socket connected with has not been revoked and that the password has not changed since the handshake. See [Credential revocation](#credential-revocation-since-12).
- Each keepalive ping (every 30 seconds) runs the same check first, so a socket on a quiet channel is re-checked even when no frames are published.
- The re-check also applies the same account-state checks as the REST API: an account with a pending password or username change has no access to the channel, at the handshake and on every re-check. Completing the pending change allows a later reconnect.
- If the re-check finds no access, the server closes the socket with close code `4003` and does not forward the frame that triggered the check. The client treats `4003` as final and does not reconnect.
- If the re-check itself fails while a frame is being forwarded, for example because the database is unreachable, the server handles it the same way. It drops the frame, logs a `WARNING` (`board access re-check failed` or `group access re-check failed`), and closes with `4003`. Reload the page to reconnect once the database is back.
- If the re-check fails during a keepalive ping, the socket stays open. The server logs a `WARNING` (`… re-check failed during keepalive`), sends the ping, and retries at the next ping. Nothing is forwarded on that path, and only a definitive denial closes the socket.

The same window applies to the other changes the re-check picks up. A role change that sends no `member.*` frame on the board channel (a group role change, a board moved to another group, a change to all-content access) and the deactivation of a user's account both take effect within it.

The window is a bound, not a guarantee of zero exposure. If the eviction frame is lost, frames forwarded before the window lapses can still reach the removed user, for up to about 7 seconds (5 seconds plus at most 2 seconds) after the socket's last successful check. The socket is closed before the first frame past that window is forwarded. An idle socket gets no frames, so nothing reaches the user. Its keepalive ping runs the re-check, so it closes within about 30–40 seconds (one keepalive interval plus the re-check window) even if no frame arrives.

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
- On a quiet channel, the keepalive ping (every 30 seconds, see [Keepalive](#keepalive)) runs the same check. The close then happens at the first ping after the window. A revoked socket on a quiet channel therefore closes within about 30–40 seconds (one keepalive interval plus the re-check window) even when no events are published.
- The check costs one extra indexed lookup per socket per window.

Related behavior and limits:

- **The tab that changed the password.** The Visiban web app treats `4003` as final. A browser tab that changes its own password keeps its new session, but its open board or group socket closes. The connection indicator shows the failed state until the page is reloaded. Other API clients should obtain a fresh credential (log in again, or mint a new ticket) and reconnect.
- **`SECRET_KEY` rotation.** Rotating `DJANGO_SECRET_KEY` without listing the old key in `SECRET_KEY_FALLBACKS` invalidates every session hash. Each open socket then closes once with `4003` at its next re-check, the same way Django logs every session out. If the old key is kept as a fallback, open sockets stay open.
- **Signed-cookie sessions.** With `SESSION_ENGINE` set to `django.contrib.sessions.backends.signed_cookies`, there is no server-side session record, so a logout cannot be detected for a connection that is already open. Password change, deactivation, and token revocation are still detected. The default database session engine and the cache engines detect logout. Startup emits system-check warning `accounts.W001` when the signed-cookie engine is configured.
- **Cache-only sessions.** With `SESSION_ENGINE` set to `django.contrib.sessions.backends.cache`, a cache outage makes every session look revoked, so open sockets close with `4003` at their next re-check, the same way a revoked session does. The `cached_db` and `db` engines are not affected.

### Missed frames

A transient publish failure does **not** close the socket. A client that stays connected therefore gets no signal that it missed a frame, and its view stays stale until its next resync. In the Visiban web app, the next resync is one of the following: the browser tab regaining focus, an event that triggers a refetch, or **Refresh board** in the connection popover. On the group page, it is the next socket reconnect.

How to resync:

- **API clients** can replay board events from the durable [change feed](events.md). Keep the last `event_id` you processed and call `GET /api/v1/boards/{id}/events/?after=<event_id>`.
- **The Visiban web app** does not read the change feed. The board view re-fetches full board state (`GET /api/v1/boards/{id}/full/`) in these cases:
    - When its socket reconnects. This happens immediately, without the 30-second throttle. If a drag is in progress, the refetch waits until the drag ends.
    - When the tab regains focus, at most once every 30 seconds.
    - After an event that triggers a refetch.
    - When you choose **Refresh board** in the connection popover.
- **Group-channel frames** have no feed row, so group clients re-fetch the group's boards list. The web app's group page does this when its socket reconnects.

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
    case "card.moved":
      // update card position and record movement
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
    // was lost or the server's access re-check failed (see "Access re-check
    // and eviction"). Do not auto-retry. A later, user-initiated reconnect can
    // succeed if the cause was a failed re-check.
  }
  // otherwise: reconnect logic and re-fetch full board state
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
