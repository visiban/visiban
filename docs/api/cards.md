# Create, move, and track cards

Create a card with `POST /api/v1/boards/{board_id}/cards/`, sending a `title`, a `column`, and a `swimlane` (member role or above):

```bash
curl -X POST -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"title": "Fix login bug", "column": 1, "swimlane": 2}' \
  http://localhost:8000/api/v1/boards/3/cards/
```

List a board's cards with `GET` on the same path.

**Yes, but:** the target column must have `allow_card_creation` enabled, and WIP or weight limits can answer `409`. See [create](#post-apiv1boardsboard_idcards) and [WIP and weight limit enforcement](#wip-weight-limit-enforcement).

**Go deeper:** [Cards](#cards), [Archive](#archive), [Move](#move), [History](#history), [Timeline](#timeline), [Comments](#comments), [Attachments](#attachments), [Relations](#relations-since-12), [Checklist](#checklist).

**Why it matters:** card writes appear in activity history and reach connected clients over WebSockets, so a script's moves are visible to the team.

**The big picture:** cards and everything attached to one — moves, comments, attachments, checklists, relations, and activity history.

## Cross-board card query

### `GET /api/v1/cards/`

> **Added in 1.2**

Paginated, filterable card query across every board the requesting user can access — for
table/list views over large boards and for incremental sync (`?updated_since=`). This is
additive: it does not change `GET /api/v1/boards/{board_id}/cards/` (a bare array of up to 200
cards per request, offset-paged with optional `limit`/`offset`) or `GET
/api/v1/boards/{board_id}/full/` (every active card, unpaginated) below.

**Access scoping:** identical to `GET /api/v1/boards/` — boards you own, are a direct member
of, or have via group-ancestry inheritance, or every board if you have `can_access_all_content`.
A card never appears here unless its board would appear in your board list; this holds even if
you pass `?board=<id>` for a board you cannot access — the result is an empty page, not a 403.

**Response shape:** `{results, next_cursor}` — **not** the `{count, offset, page_size, results}`
envelope `OffsetCountPagination` uses elsewhere. This endpoint uses cursor pagination instead of
offset pagination because it is designed for a card feed under concurrent writes (incremental
sync): offset pagination needs a stable row order and `COUNT(*)`, and a page walk can otherwise
skip or repeat rows as cards are created/updated/archived between page fetches. There is no
`previous` field — walk forward only, re-fetching page one (no `cursor`) to restart.

```json
{
  "results": [
    { "id": 101, "uid": "3a9f1c2d7e4b8a05", "board": 4, "column": 2, "swimlane": 1, "...": "..." }
  ],
  "next_cursor": "cD0yMDI2LTA0LTAxKzAwJTNBMDAlM0EwMA%3D%3D"
}
```

`next_cursor` is `null` on the last page. Pass it back as `?cursor=<value>` to fetch the next
page; treat it as opaque.

**Query parameters**

| Parameter | Description |
|---|---|
| `?board=<id>` | Restrict to one board |
| `?swimlane=<id>` | Filter by swimlane ID |
| `?column=<id>` | Filter by column ID |
| `?assignee=<id>` | Filter by assignee user ID |
| `?label=<id>` | Filter by label ID |
| `?priority=<value>` | Filter by priority (`low`, `medium`, `high`, `urgent`) |
| `?due_before=<YYYY-MM-DD>` | Cards with a due date on or before this date (ISO 8601) |
| `?due_after=<YYYY-MM-DD>` | Cards with a due date on or after this date (ISO 8601) |
| `?updated_since=<ISO 8601 datetime>` | Cards updated at or after this timestamp — the incremental-sync filter. A UTC offset of 16 hours or more returns `400` |
| `?include_archived=true` | Include archived cards. Omit or `false` to exclude them (the default, matching the endpoints below) |
| `?search=<q>` | Filter by title and description (partial, case-insensitive; results are unchanged for ASCII text; case folding of some non-ASCII letters, such as Turkish dotted/dotless i and Greek final sigma, may differ from earlier releases). A value containing a NUL (0x00) character returns `400` with `{"detail": "search must not contain NUL (0x00) characters.", "code": "invalid_query_param"}` (*Changed in 1.3, #1887*; it was a `500` on PostgreSQL) |
| `?ordering=<field>` | Sort results. Allowed values: `updated_at` (default: `-updated_at`, i.e. most recently updated first), `-updated_at`, `created_at`, `-created_at`. Every value is a 2-tuple with an `id` tiebreaker under the hood, so cursor pagination stays stable when many cards share the same timestamp. An unrecognized value falls back to the default rather than erroring. `due_date` is deliberately not an ordering option — it is nullable, and a nullable cursor field can silently skip or duplicate rows across a page boundary. |
| `?cursor=<opaque>` | Page cursor from a previous response's `next_cursor`. A cursor that cannot be decoded, or whose position is not a timestamp Postgres can store (not a valid date and time, or a UTC offset of 16 hours or more), returns `400` with `{"detail": "cursor is not a valid page cursor.", "code": "invalid_query_param"}` |
| `?page_size=<n>` | Rows per page (default 50, max 200) |

**Rate limit:** 120 requests/minute per user (scope `card_query`), counted separately from the general 5000/hour per-user budget. Over the limit the endpoint answers `429 Too Many Requests` with `{"detail": "Request was throttled. Expected available in N seconds."}` and a `Retry-After` header. A client doing incremental sync should pace its page walk and honor `Retry-After`. See [Rate limits](index.md#rate-limits).

A filter value that fails its type check (`?updated_since=x`, `?assignee=x`) returns `400` with `{"updated_since": ["Enter a valid date/time."], "detail": "updated_since: Enter a valid date/time.", "code": "invalid_query_param"}`: the [bad query parameter](index.md#error-responses) shape, plus a field-keyed entry for the parameter.

**Card response fields:** the same fields as the card response field table under
`GET /api/v1/boards/{board_id}/cards/{id}/` below, plus `board` (the board's integer ID) —
single-board endpoints omit `board` because the URL already scopes to one board; a cross-board
list has to say which board each row belongs to. `assignee_id` and `label_ids` (the write-only
fields used to set an assignee or labels) are not present — this endpoint is read-only. This includes `external_ref` (read-only here; `null` when unset).

---

## Cards

### `GET /api/v1/boards/{board_id}/cards/`
List the board's active (non-archived) cards, optionally filtered. Returns at most 200 cards per request.

> **Response shape:** a bare JSON array (`[ {...}, {...} ]`), not the standard `{count, offset, page_size, results}` envelope of other list endpoints, and not the `{results, next_cursor}` shape of the cross-board `GET /api/v1/cards/` above. Generic clients that assume an envelope must special-case it. The board UI bulk-loads cards via `GET /api/v1/boards/{board_id}/full/` (no cap); use this endpoint for targeted lookups such as search.

**200-card cap and truncation headers** (since 1.2)

Without `limit`/`offset` the response is the first 200 matching cards, as before. Every `200` response also carries two headers that tell a client whether it got everything:

| Header | Value |
|---|---|
| `X-Total-Count` | Number of active cards matching the filters, ignoring `limit`/`offset` |
| `X-Truncated` | `true` when more matching cards exist after the returned ones, otherwise `false` |

Both headers are CORS-exposed, so cross-origin browser clients can read them. Before 1.2 a board with more than 200 matching cards was truncated with no signal.

To walk past the cap, page with `limit` and `offset` (offset paging, not the cursor paging of `GET /api/v1/cards/`):

```
GET /api/v1/boards/4/cards/?limit=200&offset=0     -> X-Total-Count: 450, X-Truncated: true
GET /api/v1/boards/4/cards/?limit=200&offset=200   -> X-Total-Count: 450, X-Truncated: true
GET /api/v1/boards/4/cards/?limit=200&offset=400   -> X-Total-Count: 450, X-Truncated: false
```

Rows are ordered by `ordering` with the card ID as tiebreaker, so a walk over an unchanged board returns every card exactly once. Cards created, moved or archived mid-walk can still shift rows across a page boundary; for a feed under concurrent writes use the cursor-paginated `GET /api/v1/cards/?board=<id>`.

**Query parameters**

| Parameter | Description |
|---|---|
| `?limit=<n>` | Maximum cards to return. Default and maximum `200`; a larger value is clamped to `200`. `0` returns `[]` with the headers set (a count-only request). A blank value means the default; a negative or non-integer value returns `400` with `{"detail": "...", "code": "invalid_query_param"}` |
| `?offset=<n>` | Number of matching cards to skip. Default `0`. An offset past the end returns `[]`. A blank value means the default; a negative or non-integer value is treated as `0`, as on every other endpoint (*Changed in 1.2, #1823*). Only a value above 2^62 returns `400`, with `{"detail": "...", "code": "invalid_query_param"}` like a bad `limit` |
| `?search=<q>` | Filter by title and description (partial, case-insensitive; results are unchanged for ASCII text; case folding of some non-ASCII letters, such as Turkish dotted/dotless i and Greek final sigma, may differ from earlier releases). A value containing a NUL (0x00) character returns `400` with `{"detail": "search must not contain NUL (0x00) characters.", "code": "invalid_query_param"}` (*Changed in 1.3, #1887*; it was a `500` on PostgreSQL) |
| `?assignee=<id>` | Filter by assignee user ID |
| `?unassigned=true` | Return only cards with no assignee (`false` returns only assigned cards) |
| `?priority=<value>` | Filter by priority (`low`, `medium`, `high`, `urgent`) |
| `?column=<id>` | Filter by column ID |
| `?swimlane=<id>` | Filter by swimlane ID |
| `?due_before=<YYYY-MM-DD>` | Cards with a due date on or before this date (ISO 8601) |
| `?due_after=<YYYY-MM-DD>` | Cards with a due date on or after this date (ISO 8601) |
| `?overdue=true` | Cards past their due date (due date is set and is before today). `false` returns the rest: cards with no due date or a due date of today or later |
| `?blocked=true` | Cards that are blocked, manually or by an active `blocks` relation (the card's `is_blocked`). `false` returns the rest. *Added in 1.3* (#1149) |
| `?ordering=<field>` | Sort results. Prefix with `-` for descending. Allowed fields: `position` (default), `due_date`, `created_at`, `priority`. Example: `?ordering=-due_date` |

A filter value that fails its type check returns `400` with the field-keyed body this endpoint has returned since 1.1, plus `detail` and `code` (*added in 1.2, #1832*): `?assignee=x` gives `{"assignee": ["Enter a number."], "detail": "assignee: Enter a number.", "code": "invalid_query_param"}`. Branch on `code`. See [Error responses](index.md#error-responses).

### `POST /api/v1/boards/{board_id}/cards/`
Create a card. Requires member or above. The target column must have `allow_card_creation` enabled.

The target column's WIP and weight limits are enforced exactly as on a [move](#wip-weight-limit-enforcement) into it: `409` with `wip_limit_exceeded`, `wip_hard_blocked`, or `weight_limit_exceeded`, and a board admin may pass the optional `?force=true` query parameter to override a soft limit (a non-admin gets `403`; hard mode has no override). *Changed in 1.2 (#1428): creates were not checked before.*

Since 1.2, a create returns `404 Not Found` (nothing is written) when its target column or swimlane, or the board, was deleted while the request was in flight (#1602).

**Request**
```json
{
  "title": "Fix login bug",
  "column": 1,
  "swimlane": 2,
  "priority": "high",
  "assignee_id": 5,
  "label_ids": [1, 3],
  "due_date": "2026-04-01",
  "weight": 2
}
```

### `GET /api/v1/boards/{board_id}/cards/{id}/`
Get a single card. The response includes a read-only `uid` (a stable 16-character hex identifier that survives rename, move, and reassignment) and a `version` integer that increments when the card's fields are updated (including its labels and custom-field values), the card is blocked or unblocked (since 1.3, #1149), or the card is moved, and on every Django admin save of the card, including one that only archives or restores it (since 1.3, #2040). Archiving and restoring through the API or MCP, and comment, attachment, checklist or relation changes, leave it unchanged; it never decreases. Clients may pass `version` back on the [move endpoint](#move) as an optimistic concurrency token.

**Card response field table**

Every card object has these fields, in this endpoint, `POST /cards/`, `PATCH /cards/{id}/`, `GET /cards/`, and all mutation responses (archive, unarchive, move).

| Field | Type | Read-only | Nullable | Description |
|---|---|---|---|---|
| `id` | integer | yes | no | Database primary key |
| `uid` | string | yes | no | Stable 16-character hex UID; never changes after creation |
| `column` | integer | no | no | Column FK ID; update via the [move endpoint](#move) only |
| `swimlane` | integer | no | no | Swimlane FK ID; update via the [move endpoint](#move) only |
| `title` | string | no | no | Card title |
| `description` | string | no | no | Rich-text description (plain text or Markdown); empty string if unset |
| `priority` | string | no | no | One of `"low"`, `"medium"`, `"high"`, `"urgent"` |
| `assignee` | object / null | yes | yes | Assignee user — `{ id, username, display_name, avatar_url }` or `null` |
| `assignee_id` | integer / null | write-only | yes | Write-only FK for setting the assignee; omitted from responses |
| `labels` | array | yes | no | Array of label objects — `[{ id, uid, name, color }]` |
| `label_ids` | integer[] | write-only | no | Write-only list of label PKs; omitted from responses |
| `due_date` | string / null | no | yes | ISO 8601 date (e.g. `"2026-04-01"`) or `null` |
| `weight` | integer | no | no | Story-point weight; default `1` |
| `position` | integer | no | no | Sort order within the column/swimlane cell (0-based); update via the [move endpoint](#move) only — a `PATCH`/`PUT` that changes `position` returns `400 Bad Request` (since 1.2, #1275). Echoing the current value back is accepted. |
| `created_by` | object / null | yes | yes | User who created the card — same shape as `assignee`; `null` for cards created before the field was added |
| `created_at` | string | yes | no | ISO 8601 creation timestamp |
| `updated_at` | string | yes | no | ISO 8601 timestamp of last field update |
| `last_moved_at` | string / null | yes | yes | ISO 8601 timestamp of the card's most recent `CardMovement`; `null` for cards that have never been moved |
| `last_move_is_creation` | boolean | yes | yes | `true` when the most recent `CardMovement` is the card's creation (empty `from_column_name`, type `move`) rather than a move. Clients use it to avoid labeling a new card "moved"; `last_moved_at` is unchanged |
| `attachment_count` | integer | yes | no | Number of attachments on this card |
| `checklist_total` | integer | yes | no | Total number of checklist items |
| `checklist_done` | integer | yes | no | Number of checked checklist items |
| `is_stale` | boolean | yes | no | `true` when the card has not moved within the board's `staleness_threshold_days` window; `false` otherwise. `is_stale` ignores the card's column, so a Done-column card can be `true`; clients decide display. The stale-card notification digest, by contrast, skips Done-column cards. |
| `archived_at` | string / null | yes | yes | ISO 8601 timestamp of archiving, or `null` for active cards |
| `version` | integer | yes | no | Optimistic concurrency counter; increments when the card's fields are updated (including its labels and custom-field values), the card is blocked or unblocked (since 1.3, #1149), or the card is moved, and on every Django admin save of the card, including one that only archives or restores it (since 1.3, #2040), so a move sent with the `version` read before an admin save gets `409 version_conflict`. Archiving and restoring through the API or MCP, and comment, attachment, checklist or relation changes, leave it unchanged. It never decreases, so a client can discard a copy of the card whose `version` is lower than the one it holds. Pass as `version` in the [move endpoint](#move) to enable OCC. PATCH and PUT do not accept or check `version`. |
| `custom_field_values` | array | no | no | Values for the board's [custom fields](boards.md#custom-fields-since-12) — `[{ field_definition, value }]`. Readable and writable in the same shape; see below. Empty array when the card has no values. |
| `external_ref` | object / null | no | no | Link to the GitLab/GitHub merge request, pull request, or issue that implements this card (since 1.2) — `{ provider, ref, url }` or `null`. Always present; `null` when unset. Readable and writable in the same shape; see [External ref](#external-ref-since-12). |
| `is_blocked` | boolean | yes | no | *Added in 1.3* (#1149). `true` when the card is blocked manually (`blocked_at` is set) or by at least one active `blocks` relation (`blocker_count` > 0). Derived; the one signal the card face and the board's **Blocked only** filter show. |
| `blocked_at` | string / null | yes | no | *Added in 1.3* (#1149). When the card's open [manual block](#block-and-unblock-since-13) started, or `null` when it is not manually blocked. Changes only through the block and unblock endpoints; PATCH ignores it. |
| `blocked_reason` | string | yes | no | *Added in 1.3* (#1149). The open manual block's reason; `""` when not manually blocked. Changes only through the block endpoint. |
| `blocker_count` | integer | yes | no | Number of active cards blocking this one — see [Relations](#relations-since-12). Counts only the `blocks` relation type, only where this card is the blocked end, and only where the blocking card is not archived. `relates_to` never contributes. The relation list itself is not on the card payload; fetch it from the relations endpoint. |

**Example response**

```json
{
  "id": 101,
  "uid": "3a9f1c2d7e4b8a05",
  "column": 2,
  "swimlane": 1,
  "title": "Fix login bug",
  "description": "Steps to reproduce: ...",
  "priority": "high",
  "assignee": { "id": 7, "username": "alice", "display_name": "Alice Smith", "avatar_url": null },
  "labels": [{ "id": 3, "uid": "lb_abc123", "name": "Bug", "color": "#EF4444" }],
  "due_date": "2026-04-01",
  "weight": 2,
  "position": 0,
  "created_by": { "id": 5, "username": "bob", "display_name": "Bob Jones", "avatar_url": null },
  "created_at": "2026-03-01T10:00:00Z",
  "updated_at": "2026-03-15T09:41:22Z",
  "last_moved_at": "2026-03-15T09:41:22Z",
  "last_move_is_creation": false,
  "attachment_count": 2,
  "checklist_total": 3,
  "checklist_done": 1,
  "is_stale": false,
  "archived_at": null,
  "version": 4,
  "custom_field_values": [
    { "field_definition": 12, "value": "raid10" },
    { "field_definition": 13, "value": "4" }
  ],
  "external_ref": {
    "provider": "gitlab",
    "ref": "acme/webapp!45",
    "url": "https://gitlab.com/acme/webapp/-/merge_requests/45"
  },
  "blocker_count": 1,
  "is_blocked": true,
  "blocked_at": null,
  "blocked_reason": ""
}
```

### `PATCH /api/v1/boards/{board_id}/cards/{id}/`
Update card fields. Requires member or above. Returns `404 Not Found` if the card was deleted concurrently; nothing is saved. A PATCH/PUT racing an archive or move is evaluated against the card's state when written, not when the request began: it returns `404 Not Found` if the card was archived concurrently (as for any archived card), and a concurrent move is kept. Only the submitted fields change, and echoing the pre-move `column`/`swimlane`/`position` is rejected with `use_move_endpoint` (see below).

> **Ownership gate:** Members may only edit cards they created. A member who did not create the card must have the `is_moderator` entitlement or be a board admin. Non-moderator members who did not create the card receive `403 Forbidden`.

**Patchable fields:** `title`, `description`, `priority`, `weight`, `due_date`, `assignee_id`, `label_ids`, `custom_field_values`, `external_ref`

**`PUT /api/v1/boards/{board_id}/cards/{id}/`** is also accepted, with the same permissions, ownership gate, side effects and errors. The difference is which fields are required. `PATCH` needs none. `PUT` requires `title`, `column` and `swimlane`, as on create; `column` and `swimlane` must be the card's *current* values (see the note below on moving cards), so a `PUT` is in practice a round trip of a card you just read. Any other field a `PUT` leaves out keeps its current value; it is not reset. Prefer `PATCH` for edits.

> **Weight limit:** raising `weight` in a column with a `weight_limit`, on a board with `enforce_weight_limits` on, returns `409` with `weight_limit_exceeded` (same body as a [move](#wip-weight-limit-enforcement)) when the column's total would exceed the limit; a board admin may override with the optional `?force=true` query parameter. Lowering `weight`, leaving it unchanged, or editing any other field is never blocked, even in a column already over its WIP or weight limit. The WIP limit is not checked, since the column's card count does not change. *Changed in 1.2 (#1428).*

#### Custom field values (since 1.2)

`custom_field_values` reads and writes in the same shape, so a returned representation can be sent straight back:

```json
{ "custom_field_values": [{ "field_definition": 12, "value": "raid10" }] }
```

- **Only the fields named in the payload are touched.** A PATCH naming one field leaves every other value alone.
- **Sending `""` or `null` clears a field**, removing its value rather than storing a blank. A cleared field is absent from later responses.
- Values are validated and normalized per the definition's `field_type`: a `number` must
  parse as a finite decimal, a `date` must be `YYYY-MM-DD`, a `dropdown` value must be one
  of the definition's current `choices`, and a `checkbox` accepts `true`/`false`, `"true"`/
  `"false"`, `"1"`/`"0"` and `"yes"`/`"no"` and stores `"true"` or `"false"`. A `url` must
  be an absolute `http://` or `https://` URL — see
  [URL fields](boards.md#url-fields). A `multi_select` value is read back as a JSON array
  *string* (`"[\"web\",\"ios\"]"`) and may be written as that string, as an array of
  strings, or as one plain choice; every entry must be a current choice or one already on
  the card — see [Multi-select fields](boards.md#multi-select-fields). A value may be at
  most 500 characters; a longer one (a long URL or a long multi-select included) is
  rejected, not truncated.
- A `field_definition` id that does not belong to this card's board is rejected with `400`,
  as is the same field appearing twice in one payload.
- Setting a value is a card edit: it uses the same role allow-list and ownership gate as any other field, bumps `version`, and appears in the `card.updated` WebSocket payload.
- `is_required` is **not enforced** in this release.

**Errors:**
- `400 Bad Request` with the message on `custom_field_values` for any of the above. The whole update is rolled back, so one failed value never leaves a card half-updated.

#### External ref (since 1.2)

`external_ref` links a card to the merge request, pull request, or issue that implements it. It is also accepted on `POST /api/v1/boards/{board_id}/cards/`. Read and write share one shape:

```json
{
  "external_ref": {
    "provider": "github",
    "ref": "acme/webapp#123",
    "url": "https://github.com/acme/webapp/pull/123"
  }
}
```

| Key | Type | Description |
|---|---|---|
| `provider` | string | One of `"gitlab"`, `"github"`, `"other"` |
| `ref` | string | 1-255 characters. Surrounding whitespace is trimmed; no inner whitespace, control, or invisible Unicode formatting characters (e.g. zero-width space, bidi overrides). Freeform, e.g. `owner/repo#123` or `group/proj!45` |
| `url` | string | At most 2048 characters. Must be an absolute `http` or `https` URL with a host. Surrounding whitespace is trimmed; embedded whitespace, control, or invisible formatting characters are rejected, as are backslashes and a percent-encoded host |

- **Omitting the key leaves the link untouched.** Sending `null` removes it. Sending an object replaces the whole link; all three keys are required even on PATCH, and a partial object is a `400`.
- The response always includes the key; it is `null` when no link is set.
- `javascript:`, `data:`, `ftp:`, protocol-relative, and relative URLs are rejected, as are
  URLs that embed credentials (`user:pass@host`). The host is not checked against `provider`,
  so self-hosted GitLab and GitHub Enterprise URLs are accepted.
- Setting the link is a card edit: it uses the same role allow-list and ownership gate as any other field (viewers receive `403`), bumps `version`, and appears in the `card.updated` WebSocket payload. This release writes no activity-history entry.
- Not included in the anonymous public share-link payload, because a ref can reveal private repository names.
- The field names and value rules above are a stable public contract. The model's `full_clean()` enforces the same rules, so an integration that writes the table directly must call it (or use the API).

**Errors:** `400 Bad Request` with the error nested under `external_ref`, keyed by sub-field:

```json
{ "external_ref": { "url": ["Only http and https URLs are allowed."] } }
```

A non-object value (other than `null`) returns
`{ "external_ref": { "non_field_errors": ["..."] } }`.

> **`column`, `swimlane`, and `position` cannot be changed via PATCH/PUT.** Echoing the card's *current* value is accepted, so a PUT client that round-trips the full representation still works. Submitting a *different* value, on the same board or another, is rejected with `400` and body `{"code": "use_move_endpoint", "detail": "..."}`. To move a card, always use `POST /api/v1/boards/{board_id}/cards/{id}/move/`, which enforces WIP/weight limits and writes the `CardMovement` audit trail.

> `column` and `swimlane` are also rejected on **create** (`POST`) when they reference a column/swimlane belonging to a different board — `400`, not `404`.

> `uid` is not patchable — any `uid` value sent in the request body is silently ignored.

### `DELETE /api/v1/boards/{board_id}/cards/{id}/`
Delete a card. Requires member or above. Returns `404 Not Found` if the card was deleted or archived concurrently; the request has no effect.

> **Ownership gate:** same rule as [PATCH](#patch-apiv1boardsboard_idcardsid): members may only delete cards they created. A member who did not create the card must have the `is_moderator` entitlement or be a board admin. Non-moderator members who did not create the card receive `403 Forbidden`.

Deleting a card also deletes its [relations](#relations-since-12). Broadcasts
`card.deleted`, plus `card.updated` for every card this one was actively
blocking, whose `blocker_count` drops as a result.

---

## Archive

### `POST /api/v1/boards/{board_id}/cards/{id}/archive/`
Soft-delete a card. Takes no body. Sets `archived_at` to now, removes the card from the active board view, and excludes it from WIP/weight counts. **Minimum role: Member.** Returns `404 Not Found` if the card was deleted concurrently. If the delete lands after the archive committed, the archive stays applied but the response is still `404`, since no card is left to return (#1585).

> **Ownership gate:** same rule as [PATCH](#patch-apiv1boardsboard_idcardsid): members may only archive cards they created. A member who did not create the card must have the `is_moderator` entitlement or be a board admin. Non-moderator members who did not create the card receive `403 Forbidden`.

If the card is already archived this is a no-op — `200 OK` is returned with the current card state.

**Response** — full card object with `archived_at` set.

Broadcasts `card.archived` to all board WebSocket subscribers. Also broadcasts `card.updated` for every card this one was actively blocking, whose [`blocker_count`](#relations-since-12) changes when it leaves (or rejoins) the board.

### `POST /api/v1/boards/{board_id}/cards/{id}/unarchive/`
Unarchive a card. Takes no request body (`force` is a query parameter, below). Clears `archived_at`; the card re-enters its original column and swimlane at its original position. **Minimum role: Member.** Returns `404 Not Found` if the card was deleted concurrently (including a no-op restore of a card that vanished before the response was built, #1585); nothing is saved.

> **Ownership gate:** same rule as [PATCH](#patch-apiv1boardsboard_idcardsid): members may only unarchive cards they created. A member who did not create the card must have the `is_moderator` entitlement or be a board admin. Non-moderator members who did not create the card receive `403 Forbidden`.

**Response** — full card object with `archived_at: null`.

Archived cards do not count toward a column's limits, so a restore is checked like a [move](#wip-weight-limit-enforcement) into the card's column: `409` with `wip_limit_exceeded`, `wip_hard_blocked`, or `weight_limit_exceeded`, nothing restored. A board admin may override a soft limit with the optional `?force=true` query parameter; hard mode has no override. Restoring a card that is not archived is still a no-op `200`. *Changed in 1.2 (#1428).*

Broadcasts `card.unarchived` to all board WebSocket subscribers. Also broadcasts `card.updated` for every card this one was actively blocking, whose [`blocker_count`](#relations-since-12) changes when it leaves (or rejoins) the board.

### `GET /api/v1/boards/{board_id}/cards/archived/`
List all archived cards for the board, newest archived first. Available to all board members including viewers.

**Query parameters**

| Parameter | Description |
|---|---|
| `offset` | Pagination offset (default: `0`). A negative value is treated as `0`; a value above `2^62` returns `400` with `{"detail": "...", "code": "invalid_query_param"}`. `count` is always the total number of archived cards, including when `offset` is past the end and `results` is empty. |

**Response** — paginated envelope, page size fixed at 50:

```json
{
  "count": 124,
  "offset": 0,
  "page_size": 50,
  "results": [
    { "id": 101, "uid": "3a9f1c2d7e4b8a05", "archived_at": "2026-03-20T12:00:00Z", "..." : "..." }
  ]
}
```

### `GET /api/v1/boards/{board_id}/cards/{id}/status/`
Check whether a card exists and is archived. The deep-link handler (`?card=`) uses it to explain why a target card is not in the active board view.

**Permissions:** any board member (viewer and above).

**Response**
```json
{ "archived": true }
```

| Field | Type | Description |
|---|---|---|
| `archived` | boolean | `true` when the card exists but is archived; `false` when it is active |

**Errors:** `404 Not Found` if the card does not belong to this board or has been hard-deleted.

---

## Block and unblock (since 1.3)

> **Added in 1.3** (#1149)

A card can be marked **blocked** with a reason ("Waiting on customer", "Vendor outage") and later unblocked. It is a *state*, not a dependency: use a [`blocks` relation](#relations-since-12) when the blocker is another card. Each block is recorded with who, when and why, so blocked time can be measured per card, summed per column in [Analytics](boards.md#get-apiv1boardsidanalytics), and grouped by reason. See [Blocked cards](../features/blocked-cards.md).

Both actions follow the edit rule: **minimum role Member**, and a member may block or unblock only cards they created unless they have the `is_moderator` entitlement or are a board admin (`403` otherwise). Viewers and collaborators get `403` before the body is read. An archived card, or a card on another board, is `404`. Each bumps `version`, writes a `CardActivity` row (`blocked` / `unblocked`), and broadcasts `card.updated` with the full card after the transaction commits. There is no new WebSocket event type.

### `POST /api/v1/boards/{board_id}/cards/{id}/block/`

| Field | Type | Required | Notes |
|---|---|---|---|
| `reason` | string | yes | Trimmed; then 1-500 characters. A missing or blank reason is `400` with `{"reason": ["Enter a reason to block this card."]}` |

**Response** — `200 OK`, the full card with `is_blocked: true` and `blocked_at` / `blocked_reason` set.

| Status | When |
|---|---|
| `400` | `reason` missing, blank, over 500 characters, or contains a NUL character |
| `403` | Viewer or collaborator, or a member blocking a card another user created |
| `404` | No such card on this board, or the card is archived |
| `409` | `{"code": "card_already_blocked", "detail": "This card is already blocked."}`: the card already has an open block |

### `POST /api/v1/boards/{board_id}/cards/{id}/unblock/`

The body is optional.

| Field | Type | Required | Notes |
|---|---|---|---|
| `resolution` | string | no | How the block was resolved; up to 500 characters. Default `""` |

**Response** — `200 OK`, the full card with `blocked_at: null` and `blocked_reason: ""`. `is_blocked` stays `true` if a `blocks` relation still blocks the card: unblock clears the manual block only.

| Status | When |
|---|---|
| `400` | `resolution` over 500 characters |
| `403` | As for block |
| `404` | As for block |
| `409` | `{"code": "card_not_blocked", "detail": "This card is not blocked."}`: the card has no open block |

### `GET /api/v1/boards/{board_id}/cards/{id}/blocks/`

Every manual block of the card, newest first, open or closed. Readable by every board member, viewers included, and for archived cards too, like the card's other history.

| Field | Type | Notes |
|---|---|---|
| `id` | integer | |
| `blocked_at` | string | ISO 8601 |
| `blocked_by` | object \| `null` | User who blocked the card; `null` once that user is deleted |
| `reason` | string | |
| `unblocked_at` | string \| `null` | `null` while the block is open |
| `unblocked_by` | object \| `null` | |
| `resolution` | string | `""` when none was given |
| `column_name` | string | The column the card was in when it was blocked (kept after the column is deleted) |
| `column_uid` | string | That column's [stable UID](../features/stable-uids.md) |
| `duration_seconds` | integer | Measured to `unblocked_at`, or to now while open |
| `imported_from_username` | string \| `null` | As on activities: set only on blocks created by a board import |

```json
[
  {
    "id": 12,
    "blocked_at": "2026-10-28T09:12:00Z",
    "blocked_by": { "id": 3, "username": "jordan", "display_name": "Jordan Lee", "avatar_url": null },
    "reason": "Waiting on customer sign-off",
    "unblocked_at": null,
    "unblocked_by": null,
    "resolution": "",
    "column_name": "Review",
    "column_uid": "c0l5a1b2c3d4e5f6",
    "duration_seconds": 284400,
    "imported_from_username": null
  }
]
```

Hard-deleting a card keeps its block history for the board's analytics; deleting the board removes it.

---

## Move

### `POST /api/v1/boards/{board_id}/cards/{id}/move/`
Move a card to a new column/swimlane/position. Creates a `CardMovement` record if column or swimlane changes. Requires member or above. Returns `404 Not Found` if the card was deleted concurrently; the move is not saved (#1585). Since 1.2 it also returns `404` when the destination column or swimlane, or the board, was deleted while the request was in flight (#1602).

> **Ownership gate:** Members can freely move unassigned cards, cards assigned to themselves, and cards they created. Moving a card that is assigned to a different user and that the member did not create requires the `is_moderator` entitlement or Admin role. In that case, non-moderator members receive `403 Forbidden` with body `{"code": "permission_denied", "detail": "Moving a card assigned to another member requires Moderator or Admin access — ask a board admin."}`.

**Request**
```json
{ "column_id": 3, "swimlane_id": 2, "position": 0, "version": 4 }
```

| Field | Required | Description |
|---|---|---|
| `column_id` | ✓ | ID of the destination column (must belong to this board) |
| `swimlane_id` | ✓ | ID of the destination swimlane (must belong to this board) |
| `position` | | Target position within the destination cell (0-based, default: `0`). Out-of-range values are clamped: a negative value places the card first, a value past the last card places it last. A value that is not an integer returns `400` with body `{"detail": "position must be an integer."}` (since 1.2, #1570). |
| `version` | | Optimistic concurrency token. When provided, the server rejects the move with `409 Conflict` (`code: "version_conflict"`) if the card has been modified since the client last fetched it. Omitting this field disables the OCC check. A move without `version` can still get `409 version_conflict` in one rare case: the card is changed by other writers between the server's read and its row lock on several consecutive attempts (the server re-reads and retries before giving up). Re-fetch and retry. |

**Version conflict error**

```json
{
  "code": "version_conflict",
  "detail": "This card was modified by another user. Please refresh and try again.",
  "current_version": 5
}
```

**Response**
```json
{
  "card": { "id": 101, "uid": "3a9f1c2d7e4b8a05", ... },
  "movement": {
    "id": 42,
    "card_uid": "3a9f1c2d7e4b8a05",
    "card_title": "Fix login bug",
    "from_column": 2,
    "from_column_name": "To Do",
    "from_column_uid": "a1b2c3d4e5f60718",
    "to_column": 3,
    "to_column_name": "Doing",
    "to_column_uid": "9f8e7d6c5b4a3210",
    "from_swimlane": 1,
    "from_swimlane_name": "Acme Corp",
    "from_swimlane_uid": "deadbeef01234567",
    "to_swimlane": 1,
    "to_swimlane_name": "Acme Corp",
    "to_swimlane_uid": "deadbeef01234567",
    "moved_by": { "id": 7, "username": "alice", "display_name": "Alice Smith", "avatar_url": null },
    "moved_at": "2026-03-15T09:41:22Z",
    "movement_type": "move",
    "notes": ""
  }
}
```

| Field | Type | Description |
|---|---|---|
| `moved_by` | object | User who performed the move — `{ id, username, display_name, avatar_url }` |
| `movement_type` | string | Always `"move"` for explicit card moves via this endpoint |
| `imported_from_username` | string / null | *Since 1.2.* Always `null` here; set only on records created by a board import with history (see the history endpoints below) |
| `notes` | string | Optional notes recorded at move time (empty string by default) |

The `movement` key is **absent** from the response when only the position changed within the same cell (no column or swimlane change) — a `CardMovement` record is created, and the `movement` key included, only when the card actually changes column or swimlane.

#### WIP / weight limit enforcement

When `enforce_wip_limits` or `enforce_weight_limits` is enabled on the board and the target column is at or above its limit, the move returns `409 Conflict`. Since 1.2 (#1428) the same check, bodies, and override rules also apply to card create, restore from archive, and a `PATCH` that raises `weight` (see those endpoints above). Board import is exempt by design, because it restores a board as exported. The bodies:

```json
{ "code": "wip_limit_exceeded", "column_name": "Doing", "current_count": 5, "wip_limit": 5 }
```

```json
{ "code": "weight_limit_exceeded", "column_name": "Doing", "current_weight": 10, "weight_limit": 10, "card_weight": 2 }
```

When `enforce_wip_hard` is enabled on the board, the limit cannot be overridden by any role — all users receive `409 Conflict` with code `wip_hard_blocked`:

```json
{ "detail": "WIP limit enforced — move blocked.", "code": "wip_hard_blocked", "column_name": "Doing", "current_count": 5, "wip_limit": 5 }
```

When `enforce_wip_hard` is not enabled, board admins may override the limit by appending `?force=true` to the move URL:

```bash
POST /api/v1/boards/1/cards/42/move/?force=true
```

`?force=true` only matters when the move would otherwise be blocked by a real WIP or weight breach; on a move that hits no limit it is a no-op that succeeds for any role. A non-admin whose move *does* hit a limit and sends `?force=true` receives `403 Forbidden`.

#### Swimlane limits

> **Added in 1.3** (#1150)

A swimlane can have its own `wip_limit` and `weight_limit` (see [Swimlane limits](boards.md#swimlane-limits-since-13)). The same paths enforce them: move, create, restore, and a `PATCH` that raises `weight`. A move is checked against the target swimlane only when it adds to the swimlane's counted total, so a move between two counted columns of one swimlane, or into a column that does not count, never trips it. A move into a counted column from a column of the same swimlane that does not count (for example Done -> Doing under the default, where done columns do not count) *is* checked. Each swimlane chooses `limit_enforcement`: `"block"` (board admins can override with `?force=true`), `"hard"` (no override for the WIP limit), or `null` to follow the board's flags as a column does. The bodies add `swimlane_name`; `column_name` names the target cell's column, and the counters are the swimlane's:

```json
{ "code": "swimlane_wip_limit_exceeded", "column_name": "Doing", "swimlane_name": "Acme Corp", "current_count": 3, "wip_limit": 3 }
```

```json
{ "detail": "Swimlane WIP limit enforced — move blocked.", "code": "swimlane_wip_hard_blocked", "column_name": "Doing", "swimlane_name": "Acme Corp", "current_count": 3, "wip_limit": 3 }
```

```json
{ "code": "swimlane_weight_limit_exceeded", "column_name": "Doing", "swimlane_name": "Acme Corp", "current_weight": 8, "weight_limit": 10, "card_weight": 3 }
```

When more than one limit trips, the response names the strictest: a hard limit before a soft one, then the column before the swimlane, then WIP before weight. A board with no swimlane limits gets exactly the column bodies above. One `?force=true` from a board admin overrides every soft limit the move trips, and none of the hard ones.

The `*_uid` fields in the movement record are permanent: they stay set after the referenced column or swimlane is deleted (the FK `*_id` becomes `null`, the UID is preserved). See [Stable UIDs](../features/stable-uids.md).

---

## History

### `GET /api/v1/boards/{board_id}/cards/{id}/movements/`
Full movement history for a card. Each record includes `card_uid`, `card_title`, `from_column_uid`, `to_column_uid`, `from_swimlane_uid`, and `to_swimlane_uid` in addition to the FK and name fields, and since 1.2 `imported_from_username` (see the activities table below). UID fields are stable across column/swimlane renames and deletions. See [Stable UIDs](../features/stable-uids.md).

### `GET /api/v1/boards/{board_id}/cards/{id}/activities/`
Activity log (field changes, comments, attachments, checklist events, and since 1.3 manual blocks: `blocked` carries the reason in `to_value`; `unblocked` carries the cleared reason in `from_value` and the resolution in `to_value`).

| Field | Type | Notes |
|---|---|---|
| `id` | integer | |
| `event_type` | string | |
| `from_value` | string | |
| `to_value` | string | |
| `actor` | object \| `null` | User who triggered the event, or `null` if that user has since been deleted |
| `created_at` | string | ISO 8601 timestamp |
| `imported_from_username` | string \| `null` | *Since 1.2.* `null` unless the entry was created by a board import with history; then `actor` is the importing user and this is the username the import file named (`""` when it named nobody). History imported by earlier versions carries `null`, since the original name was not kept. See [Imported history](../features/card-history.md#imported-history) |

```json
[
  {
    "id": 501,
    "event_type": "status_changed",
    "from_value": "To Do",
    "to_value": "In Progress",
    "actor": { "id": 3, "username": "jordan", "display_name": "Jordan Lee", "avatar_url": null },
    "created_at": "2026-09-20T14:03:11Z",
    "imported_from_username": null
  }
]
```

---

## Timeline

### `GET /api/v1/boards/{board_id}/cards/{id}/timeline/`
Unified, paginated timeline that merges card movements and field-change activities into a single chronological feed, sorted newest-first. **Minimum role: any board member (viewer and above).**

Use it for one list combining moves, comments, field edits, checklist events, attachments, and system events, instead of fetching `movements/` and `activities/` separately and merging client-side.

**Query parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Page size. Capped at `200`; a negative value is treated as `0` and a non-integer value as the default. `count` is the real total even when the page is empty (`limit=0`). |
| `offset` | integer | `0` | Zero-based page offset. A negative value is treated as `0`; a value above `2^62` returns `400` with `{"detail": "...", "code": "invalid_query_param"}`. |
| `event_types` | string | _(all)_ | Comma-separated filter groups. Valid values: `move`, `comment`, `field`, `checklist`, `attachment`, `system`. Omit to include all event types. |

`event_types` group mapping:

| Group | Included `event_type` values |
|---|---|
| `move` | All `CardMovement` records |
| `comment` | `comment_added` |
| `field` | `priority_change`, `weight_change`, `assignee_change`, `label_change`, `title_change`, `description_change`, `due_date_change`, and since 1.3 `blocked`, `unblocked` (#1149) |
| `checklist` | `checklist_item_added`, `checklist_item_checked`, `checklist_item_unchecked`, `checklist_item_deleted` |
| `attachment` | `attachment_added`, `attachment_deleted` |
| `system` | `archived`, `reactivated` |

An `unblocked` entry's `data` also carries `block_duration_seconds` (*added in 1.3*, #1149): how long the block it closed lasted, or `null` when no closed block matches (an imported entry whose block history was not imported).

**Response**

```json
{
  "count": 84,
  "next": "https://your-instance.example.com/api/v1/boards/1/cards/42/timeline/?limit=50&offset=50",
  "previous": null,
  "results": [
    {
      "id": 317,
      "kind": "move",
      "ts": "2026-04-10T14:22:00Z",
      "actor": {
        "id": 7,
        "username": "alice",
        "display_name": "Alice Smith",
        "avatar_url": null
      },
      "event_type": "move",
      "data": {
        "id": 317,
        "from_column": 2,
        "from_column_name": "In Progress",
        "to_column": 3,
        "to_column_name": "Done",
        "from_swimlane": 1,
        "from_swimlane_name": "Acme Corp",
        "to_swimlane": 1,
        "to_swimlane_name": "Acme Corp",
        "moved_at": "2026-04-10T14:22:00Z",
        "movement_type": "move",
        "notes": ""
      }
    },
    {
      "id": 204,
      "kind": "activity",
      "ts": "2026-04-09T10:05:00Z",
      "actor": {
        "id": 9,
        "username": "bob",
        "display_name": "Bob Jones",
        "avatar_url": null
      },
      "event_type": "priority_change",
      "data": {
        "event_type": "priority_change",
        "from_value": "medium",
        "to_value": "high"
      }
    }
  ]
}
```

**`CardTimelineEntry` fields**

| Field | Type | Description |
|---|---|---|
| `id` | integer | Primary key of the underlying `CardMovement` or `CardActivity` record |
| `kind` | string | `"move"` for movement records; `"activity"` for field-change or system activity records |
| `ts` | string | ISO 8601 timestamp — `moved_at` for movements, `created_at` for activities |
| `actor` | object / null | User who triggered the event — `{ id, username, display_name, avatar_url }`. `null` for system-generated events |
| `event_type` | string | Concrete event type (see group mapping table above). For `kind: "move"` entries this is the `movement_type` value (e.g. `"move"`, `"archived"`, `"unarchived"`) |
| `imported_from_username` | string / null | *Since 1.2.* The underlying record's `imported_from_username` — `null` unless it came from a board import with history |
| `data` | object | Raw fields from the underlying record. Shape differs by `kind` — see examples above. `move` entries include column/swimlane FK IDs, names, timestamp, type, and notes. `activity` entries include `event_type`, `from_value`, and `to_value`. |

**Errors**

| Status | Description |
|---|---|
| `400 Bad Request` | `event_types` names a group not in the allowed set — `{"detail": "Invalid event_types: ... Valid groups: ...", "code": "invalid_query_param"}` (`code` added in 1.2) |
| `400 Bad Request` | `offset` is above `2^62` — `{"detail": "offset must not exceed ...", "code": "invalid_query_param"}` |
| `404 Not Found` | Requesting user has no access to the board |
| `404 Not Found` | Card does not exist or does not belong to this board |

---

## Comments

### `GET /api/v1/boards/{board_id}/cards/{id}/comments/`
List comments. Requires board member or above.

| Field | Type | Description |
|---|---|---|
| `id` | integer | |
| `author` | object \| `null` | User who posted the comment — `{ id, username, display_name, avatar_url }` — or `null` if that user has since been deleted. For an imported comment, the user who ran the import |
| `body` | string | Plain text, at most 10,000 characters |
| `created_at` | string | ISO 8601 timestamp |
| `updated_at` | string | ISO 8601 timestamp |
| `imported_from_username` | string \| `null` | *Since 1.2.* Read-only. `null` unless the comment was created by a JSON or Trello board import; then `author` is the importing user and this is the author name the source named (a JSON file's `author`, a Trello member's display name; `""` when it named nobody). Comments imported by earlier versions carry `null`. See [Imported history](../features/card-history.md#imported-history) |

### `POST /api/v1/boards/{board_id}/cards/{id}/comments/`
Add a comment. **Minimum role: Collaborator.** Returns `404 Not Found` if the card was deleted concurrently; nothing is saved.

**Request** `{ "body": "Looking into this now." }` — returns the new comment, with `imported_from_username: null`. The field is read-only and ignored if sent.

### `DELETE /api/v1/boards/{board_id}/cards/{id}/comments/{comment_id}/`
Delete a comment. **Minimum role: Collaborator.** Collaborators may delete only their own comments, regardless of `is_moderator`. Members with the `is_moderator` entitlement (or admin role) may delete any comment. Returns `404 Not Found` if the card was deleted concurrently; the request has no effect.

---

## Attachments

### `GET /api/v1/boards/{board_id}/cards/{id}/attachments/`
List attachments. Response fields per attachment: `id`, `filename`, `size` (bytes), `url` (absolute URL — scheme + host + path, built from the request), `uploaded_by` (user object, or `null` if the uploader has since been deleted), `uploaded_at`.

To download a file, fetch its `url` with the same `Authorization` header as API requests; attachments are served via the authenticated `/media/<path>` route. Unauthenticated requests return `401 Unauthorized`; users without board membership get `404 Not Found`.

```bash
curl -O -J http://localhost:8000/media/attachments/abc123.pdf \
  -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
```

### `POST /api/v1/boards/{board_id}/cards/{id}/attachments/`
Upload an attachment (`multipart/form-data`, field name `file`). Max size: 10 MB by default, operator-configurable via the `MAX_UPLOAD_SIZE_BYTES` env var. **Minimum role: Collaborator.** Returns `404 Not Found` if the card was deleted concurrently; the request has no effect.

**Allowed file types**

The server validates both the declared `Content-Type` and the file's magic bytes. Uploads with a disallowed type are rejected with `HTTP 400`.

| Category | Accepted types |
|---|---|
| Images | JPEG, PNG, GIF, WebP |
| Documents | PDF |
| Office (OOXML) | DOCX, XLSX, PPTX |
| Archives | ZIP |
| Text | Plain text, CSV |

**Error response (unsupported type)**

```json
{ "detail": "File type 'application/x-executable' is not allowed. Accepted types: images (JPEG, PNG, GIF, WebP), PDF, Office documents (DOCX, XLSX, PPTX), plain text, CSV, ZIP." }
```

**Error response (magic-byte mismatch)**

```json
{ "detail": "File content does not match a recognized safe format. The file may be corrupt or its type may have been misrepresented." }
```

**Error response (no file provided)** — `400 Bad Request`

```json
{ "detail": "No file provided." }
```

**Error response (file too large)** — `400 Bad Request`

```json
{ "detail": "File too large. Maximum size is 10 MB." }
```

**Error response (viewer role)** — `403 Forbidden`. Viewers cannot upload attachments; collaborators and above can.

```json
{ "detail": "Viewers cannot perform this action." }
```

**Error response (uploads disabled)** — `403 Forbidden`. Returned when the site administrator has disabled uploads instance-wide; applies to all roles including admins.

```json
{ "code": "feature_disabled", "detail": "File uploads are disabled by the site administrator." }
```

### `DELETE /api/v1/boards/{board_id}/cards/{id}/attachments/{attachment_id}/`
Delete an attachment. **Minimum role: Collaborator.** Collaborators may delete only their own attachments, regardless of `is_moderator`. Members with the `is_moderator` entitlement (or admin role) may delete any attachment. Returns `404 Not Found` if the card was deleted concurrently; the request has no effect.

---

## Relations (since 1.2)

Typed links between two cards **on the same board**. The board stores one
canonical direction per relation and derives the inverse at read time, so
"A blocks B" and "B is blocked by A" are the same row read from two ends —
they cannot drift apart.

Relation types:

| `relation_type` | Meaning | Symmetric |
|---|---|---|
| `blocks` | The card this row was created from blocks the other card | no |
| `relates_to` | The two cards are associated, with no ordering implied | yes |

`relates_to` is stored in a canonical order (lower card id first), so adding
the same pair from either end is the same relation and the second attempt is
rejected as a duplicate.

Cross-board relations are not supported. A `to_card` on another board is
rejected with `400` and the response discloses nothing about that card.

### `GET /api/v1/boards/{board_id}/cards/{id}/relations/`

List this card's relations, each resolved to **this card's** point of view.
Any board role may read.

Ordered: `blocked_by` first, then `blocks`, then `relates_to`; oldest first
within each group.

**Response**

```json
[
  {
    "id": 42,
    "relation_type": "blocks",
    "direction": "blocked_by",
    "card": {
      "id": 88,
      "uid": "9f2c1a7b3d4e5f60",
      "title": "Provision the staging cluster",
      "column": 2,
      "archived": false
    },
    "created_at": "2026-09-15T11:02:31Z"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | integer | Relation PK — pass to the delete endpoint |
| `relation_type` | string (enum) | `blocks` or `relates_to` — the **stored** type, identical from both ends of the relation (*Changed in 1.3, #1976*: published as the `RelationTypeEnum` enum in OpenAPI; values unchanged) |
| `direction` | string (enum) | `blocks`, `blocked_by`, or `relates_to` — the type as read from the card in the URL (*Changed in 1.3, #1976*: published as the `DirectionEnum` enum in OpenAPI; values unchanged) |
| `card` | object | The card at the other end — `{ id, uid, title, column, archived }` |
| `created_at` | string | ISO 8601 timestamp of when the relation was created |

!!! warning "Read `direction`, not `relation_type`"
    `relation_type` is the stored type and does not change with the viewer. From
    the blocked card's side a row reads `relation_type: "blocks"` with
    `direction: "blocked_by"`; a client that reads `relation_type` alone gets
    the wrong sentence. Always render from `direction`. Since 1.3 (#1976) both
    fields are published as enums in the OpenAPI schema (`RelationTypeEnum`,
    `DirectionEnum`); the wire values have not changed.

`card.archived` is `true` when the linked card has been archived. Such a
relation is still listed so it can be found and removed, but an archived
blocker does **not** count toward `blocker_count`.

### `POST /api/v1/boards/{board_id}/cards/{id}/relations/`

Link this card to another card on the same board. **Minimum role: Member.** Returns `404 Not Found` if the card in the URL was deleted concurrently; nothing is saved.

One tier stricter than the checklist and comment endpoints, which admit
collaborators: a relation changes how a *different* card reads for everyone on
the board, and collaborators have read-only access to card state.

**Request** `{ "to_card": 88, "direction": "blocked_by" }`

| Field | Type | Description |
|---|---|---|
| `to_card` | integer | PK of the card at the other end. Must be on this board and not archived. |
| `direction` | string | `blocks`, `blocked_by`, or `relates_to` — stated from the point of view of the card in the URL. |

The request names a **direction**, not a storage layout. `blocked_by` records
"the other card blocks this one", so both readings are creatable from the same
card without the client needing to know which end is stored as `from_card`.
`relates_to` is normalized by card id, so sending it from either end produces
the same row.

Returns `201` with the same object shape as the list endpoint, resolved to the
card in the URL.

**Rejected with `400`.** The body is `{"code": "<code>", "detail": "<message>"}`
— both plain strings, the same shape as `feature_disabled` and
`export_restricted` — so a client branches on `body.code === "<code>"` rather
than string-matching the message. (1.2.0-beta.1 returned both values as
single-item lists; that was normalized before 1.2.0, #1660.)

| `code` | Condition |
|---|---|
| `self_relation` | `to_card` is the card in the URL (also enforced by a database check constraint) |
| `cross_board` | `to_card` is on another board, or does not exist — deliberately the same answer either way, so the endpoint cannot be used to probe for cards on boards the caller cannot see |
| `archived_card` | `to_card` is archived. Existing relations to a card archived later are kept and flagged, but a new one is refused |
| `relation_exists` | The same relation already exists, including the same fact stated from the other end |
| `relation_cycle` | `to_card` already blocks this card — two cards cannot block each other |

An unknown `direction` is rejected as an ordinary field error on `direction`.

Cycles longer than two hops (A → B → C → A) are **not** detected and are
permitted.

### `DELETE /api/v1/boards/{board_id}/cards/{id}/relations/{relation_id}/`

Remove a relation. **Minimum role: Member.** Returns `204`.

The relation must involve the card in the URL at one end or the other; a
relation between two unrelated cards returns `404`. Either end may delete —
both cards display the relation, so the permission to unlink is the same from
both sides. There is no per-creator restriction: a member can already edit both
endpoint cards, so `created_by` is recorded for attribution, not authorization.

### Real-time

Adding or removing a relation publishes **two** `card.updated` events on the
board channel — one per card at each end — because both cards' relation lists,
and the blocked card's `blocker_count`, change together. Each event carries a
complete card payload. See [WebSockets](websockets.md).

---

## Checklist

### `GET /api/v1/boards/{board_id}/cards/{id}/checklist/`
List checklist items.

### `POST /api/v1/boards/{board_id}/cards/{id}/checklist/`
Add a checklist item. **Minimum role: Collaborator.** Returns `404 Not Found` if the card was deleted concurrently; nothing is saved.

**Request** `{ "text": "Write tests" }`

### `PATCH /api/v1/boards/{board_id}/cards/{id}/checklist/{item_id}/`
Update an item (e.g. check/uncheck). **Minimum role: Collaborator.**

> **Concurrent card delete:** if the card is deleted while the request is in flight, the response is `404 Not Found` and the change is not saved.

> **Ownership gate:** Collaborators and members may only edit items they created. Admins and moderators may edit any item. Items with no recorded creator (created before the `created_by` field existed in migration 0044, or whose creator's account was deleted) can be edited only by admins and moderators, the same as comments and attachments. Non-moderator callers who did not create the item receive `403 Forbidden` with `{"detail": "You can only edit checklist items you created."}`.

> **`position` cannot be changed via PATCH.** Echoing the item's *current* `position` is accepted, so a PUT-style client that round-trips the full representation still works. Submitting a *different* value is rejected with `400` and body `{"position": ["Changing a checklist item's position via PATCH is not allowed — ..."]}`. To reorder checklist items, use `POST /api/v1/boards/{board_id}/cards/{id}/checklist/reorder/` (since 1.2, #1292).

**Request** `{ "is_checked": true }`

### `DELETE /api/v1/boards/{board_id}/cards/{id}/checklist/{item_id}/`
Delete a checklist item. **Minimum role: Collaborator.** Same ownership gate as `PATCH` above. Returns `404 Not Found` if the card was deleted concurrently; the request has no effect.

### `POST /api/v1/boards/{board_id}/cards/{id}/checklist/reorder/`
Reorder checklist items on a card. **Minimum role: Collaborator.** Not ownership-gated: unlike `PATCH`/`DELETE` on one item, reordering changes the whole list's display order, not one item's content, so any collaborator+ may reorder whoever created each item. *(Since 1.2, #1292.)* Returns `404 Not Found` if the card was deleted concurrently; the request has no effect.

**Request** `{ "order": [17, 21, 19] }`. `order` must be **exactly** this card's current checklist item IDs: every item once, no duplicates, no ID from another card. A partial list, a duplicate, a foreign ID, or (on a card that has items) an empty list is rejected with `400` and body `{"order": ["..."]}`, never partially applied. Returns the reordered list (same shape as `GET`).

**Checklist item response shape**

All checklist endpoints (`GET`, `POST`, `PATCH`, `POST .../reorder/`) return checklist item objects with the following fields:

| Field | Type | Description |
|---|---|---|
| `id` | integer | Checklist item database PK |
| `text` | string | Item text |
| `is_checked` | boolean | Whether the item is checked |
| `position` | integer | Sort order within the checklist (0-based); update via `reorder/` only — a `PATCH` that changes `position` returns `400 Bad Request` (since 1.2, #1292). Echoing the current value back is accepted. |
| `created_by` | object / null | User who added the item — `{ id, username, display_name, avatar_url }`. `null` for items created before this field was added (migration 0044) and for items whose creator's account was deleted. Only admins and moderators can edit or delete `null`-creator items. |

**Example response**

```json
{
  "id": 17,
  "text": "Write tests",
  "is_checked": false,
  "position": 0,
  "created_by": { "id": 7, "username": "alice", "display_name": "Alice Smith", "avatar_url": null }
}
```
