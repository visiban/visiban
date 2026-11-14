# Create and manage boards over the API

Create a board with `POST /api/v1/boards/` and a `name`; it answers `201`. Every other call here hangs off the returned board id.

```bash
curl -X POST -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Sales Pipeline"}' http://localhost:8000/api/v1/boards/
```

Omit `template` for the `simple_kanban` layout; omit `swimlane_name` for no swimlane. List boards with `GET /api/v1/boards/`.

**Go deeper:** [Boards](#boards), [Templates](#templates), [Export & Import](#export-import), [Members](#members), [Board invites](#board-invites), [Board sharing](#board-sharing), [Columns](#columns), [Swimlanes](#swimlanes), [Labels](#labels), [Custom fields](#custom-fields-since-12), [Public share endpoint](#public-share-endpoint).

**Why it matters:** columns, swimlanes, labels, membership, and sharing all enforce board roles, so check the role a call needs before you script it.

**The big picture:** everything you do with a board short of the cards inside it (see [Cards API](cards.md)).

## Boards

### `GET /api/v1/boards/`
List all boards accessible to the current user.

**Query parameters**

| Parameter | Description |
|---|---|
| `?starred=true` | Return only boards the requesting user has starred |
| `?expand=group` | Populate `group_detail` on each board with a `GroupBrief` object (see `GET /api/v1/boards/{id}/full/` for the shape). Without this parameter `group_detail` is `null`. Triggers a one-query ancestor bulk-fetch — safe to use on list responses. |
| `?offset=<n>` | Zero-based row offset (default `0`) |
| `?page_size=<n>` | Rows per page (default `50`, max `200`) |

**Response** — the standard [paginated envelope](index.md#pagination): `{ "count", "offset", "page_size", "results": [ ...boards ] }`. Read the boards from `results`; the response is not a bare array.

### `POST /api/v1/boards/`

> **Changed in 1.2**

Create a board.

**Request**

| Field | Required | Description |
|---|---|---|
| `name` | ✓ | Board name |
| `description` | | Board description (default: `""`) |
| `template` | | Template slug to use for column layout (default: `"simple_kanban"`). See `GET /api/v1/boards/templates/` for available slugs. Omit it (or send `""`/`null`) for the default; a non-blank slug that matches no active template returns `400` (see **Errors**). |
| `swimlane_name` | | Name for the first swimlane. Omit it (or send blank) and the board gets **no** swimlane; no template supplies a default. By contrast, [`POST /groups/{id}/boards/`](groups.md#boards), defaults an omitted value to `"General"`. |
| `group` | | Integer group ID — assigns the board to this group at creation time. Since 1.2 the caller must be an admin of the group or of one of its ancestor groups (or a site admin with all-content access), the same rule as [`POST /groups/{id}/boards/`](groups.md#boards). `null` or omitted creates a personal board. |

Since 1.2, a non-string `swimlane_name` returns `400 Bad Request` with the error keyed to `swimlane_name` (it returned `500` before).

**Errors**

| Status | Body | Condition |
|---|---|---|
| `400 Bad Request` | `{"code": "unknown_template", "detail": "Unknown board template: '...'."}` (both plain strings, #1660) | `template` was sent as a non-blank value that doesn't match an active template's slug. Deliberately distinct from a per-field validation error: a stale or mistyped `template` once created a `simple_kanban` board with a `201` and hid the mistake (#1115). |
| `400 Bad Request` | `{"group": ["Unknown group, or you are not an admin of it."]}` | `group` names a group that does not exist or that the caller does not administer. Both return the same body. |

### `GET /api/v1/boards/{id}/`
Get board summary. Response includes:

| Field | Type | Description |
|---|---|---|
| `id`, `uid` | integer, string | Database ID and stable 16-char hex UID |
| `name`, `description` | string | Board name and description |
| `owner` | object | Owner user object |
| `group`, `group_name` | integer / null, string / null | Group ID and name (null for personal boards) |
| `group_detail` | object / null | Populated with a `GroupBrief` object when `?expand=group` is appended to the request; `null` otherwise. `GroupBrief` shape: `{ id, name, parent, parent_name, ancestors }` where `parent` is the parent group FK ID (or `null`) and `ancestors` is a root-first `[{ id, name }]` chain. |
| `member_count` | integer | Number of direct board members. Reported as the true total for every viewer, including non-owner members, on list, retrieve and the `board.created` / `board.updated` payloads (before 1.2 a direct member who was not the owner saw `1` on `GET /api/v1/boards/`). `card_count` and `archived_card_count` are likewise true totals for every viewer. |
| `card_count` | integer | Number of active (non-archived) cards |
| `archived_card_count` | integer | Number of archived cards. Reported separately because `card_count` excludes them, yet `DELETE /api/v1/boards/{id}/` deletes them too. Clients that confirm a board delete should treat `card_count + archived_card_count` as the number of cards at stake. Also present on `GET /api/v1/boards/`, `GET /api/v1/groups/{id}/boards/`, and `/full/`. Added in 1.2 (#1289). |
| `staleness_threshold_days` | integer | Days without movement before a card is considered stale (default: 7) |
| `allowed_priorities` | array / null | **Deprecated (#1429).** Has no effect and is kept only for API compatibility; marked `deprecated: true` in the OpenAPI schema. Still accepted on write and returned unchanged, but not enforced: card create and update accept any priority regardless of this list (scaffold, see [Field Enforcement](../architecture/field-enforcement.md)). It will be removed only in a future major release. Duplicate entries are silently de-duplicated (order of first occurrence is kept); a submitted list longer than 100 entries is rejected with `400 Bad Request`. |
| `enforce_wip_limits` | boolean | When `true`, moving, creating, or restoring a card into a column at its WIP limit returns `409 Conflict` (default: `true` for new boards); board admins can override with `?force=true`. Board import is not checked (by design). Create and restore checked since 1.2 (#1428) |
| `enforce_wip_hard` | boolean | When `true`, WIP limits on card move, create, and restore cannot be overridden by any role — all users are blocked (default: `false`). Active regardless of `enforce_wip_limits`. Board import is not checked (by design). Create and restore checked since 1.2 (#1428) |
| `enforce_weight_limits` | boolean | When `true`, moving, creating, or restoring a card, or raising a card's `weight` with PATCH, so that a column would exceed its weight limit returns `409 Conflict` (default: `true` for new boards); board admins can override with `?force=true`. Lowering a weight is never blocked. Board import is not checked (by design). Create, restore, and PATCH checked since 1.2 (#1428) |
| `export_min_role` | string | Minimum role required to export this board. One of `"viewer"`, `"collaborator"`, `"member"`, `"admin"` (default: `"viewer"`). Owners and site admins always bypass. Limits only the export action and its file formats; it does not restrict ordinary reads (`/cards/`, `/full/`, `/api/v1/cards/`, timeline, MCP), which follow board membership. Admin-only when writing; sending any other value (including `"site_admin"` or `"owner"`) returns `400 Bad Request`. A stored value outside this set is treated as `"admin"` by the export gate. Added in 1.1 (#843). |
| `card_density` | string | Per-board card layout density. One of `"comfortable"`, `"standard"`, `"dense"` (default: `"comfortable"` for new boards; existing boards on upgrade are migrated to `"dense"` to preserve their pre-1.1 visual). Drives how much metadata renders on the card face — see the [Card density](../features/board.md#card-density) feature doc. Admin-only when writing; sending any other value returns `400 Bad Request`. Added in 1.1 (#961). |
| `show_wip_at_limit` | boolean | When `true`, a column's header stat row shows a calm `WIP n/n` indicator (in place of the card count) once the column's card count exactly equals its `wip_limit` (default: `false`). Purely ambient — does not affect move enforcement. Admin-only when writing. See the [At-limit WIP indicator](../features/board.md#at-limit-wip-indicator) feature doc. Added in 1.2 (#973). |
| `show_row_chip_field_names` | boolean | When `true` (the default), pinned swimlane field chips in a row's label panel show `Field name: value`. When `false`, they show the value alone; the name stays in the chip's tooltip, for screen readers, and in the row's `+N` field list. Checkbox fields always show their name, and card-face chips are unaffected. Display only. Admin-only when writing. See [Hiding field names on row chips](../features/custom-fields.md#hiding-field-names-on-row-chips). Added in 1.2 (#1418). |
| `stale_warning_pct` | integer | Percentage (0--100) of `staleness_threshold_days` a card has used before the warning step. It sets the yellow/green boundary in the analytics heatmap and the yellow step of the card aging tint. `0` turns the warning step off |
| `is_starred` | boolean | Whether the requesting user has starred this board |
| `created_at`, `updated_at` | string | ISO 8601 timestamps |
| `health_status` | string / null | The board's own health status: `"on_track"`, `"at_risk"` or `"off_track"`, or `null` to inherit from the nearest group above it that sets one (default: `null`). Admin-only when writing; any other value (including `""`) returns `400 Bad Request`. See [Health Status](../features/health-status.md). Added in 1.3 (#1133). |
| `effective_health_status` | string / null | Read-only. The status that applies: `health_status` when set, otherwise the `health_status` of the nearest ancestor group that sets one, walking up from the board's group through at most six groups; `null` when none does. Computed on every read, so a group change applies to every board that does not set its own value. Added in 1.3 (#1133). |
| `health_status_source` | object / null | Read-only. `{ "id", "name", "changed_at" }` of the group that supplies `effective_health_status`; `null` when `health_status` is set on the board itself or when nothing applies. `changed_at` (1.3+, #2242) is when that group's own status was last set, or `null`; the group's setter and note are not included. Added in 1.3 (#1133). |
| `health_status_changed_at` | string / null | Read-only. When the board's own `health_status` was last set or confirmed (ISO 8601), or `null` if never recorded (including a status set before 1.3's history existed). Added in 1.3 (#2242). |
| `health_status_changed_by` | object / null | Read-only. Who last set or confirmed it, as `{ "id", "username", "display_name", "avatar_url" }` (the `owner` shape), or `null` for a removed account, an automatic change or no recorded change. Added in 1.3 (#2242). |
| `health_status_note` | string / null | Read-only. The note given with the last set or confirm (at most 280 characters), or `null`. Added in 1.3 (#2242). |
| `default_preset` | string / null | The [board preset](../features/board.md#board-presets) members see until they pick one themselves: `"classic"` (the board exactly as it rendered before presets) or `"default"`, or `null` for no board default (default: `null`). Presets are defined by the web client in 1.3; this field stores only the id. A member's own choice and a `?preset=` link take precedence over it. Admin-only when writing; any other value (including `""`) returns `400 Bad Request`. On every board payload, including `/full/` (read-only there), the group board lists and the `board.created` / `board.updated` [WebSocket events](websockets.md). Added in 1.3 (#1146). |

The health fields are on every board payload: list, retrieve, create and update responses, `/full/`, [`GET /api/v1/groups/{id}/boards/`](groups.md#get-apiv1groupsidboards), `descendant-boards/` and its paged form, and the `board.created` / `board.updated` [WebSocket events](websockets.md). A list resolves every row's inherited value from one ancestor lookup for the whole page.

### `PUT /api/v1/boards/{id}/` / `PATCH /api/v1/boards/{id}/`
Update board fields. `PUT` and `PATCH` are both accepted, and every field is optional in either. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Writable fields:** `name`, `description`, `staleness_threshold_days`, `stale_warning_pct`, `allowed_priorities`, `enforce_wip_limits`, `enforce_weight_limits`, `enforce_wip_hard`, `export_min_role`, `card_density`, `show_wip_at_limit`, `show_row_chip_field_names`, `health_status` (1.3+), `default_preset` (1.3+), `group` (see below; since 1.2, changing it to a different group also requires admin of that group). The whole request requires board admin (or site admin); no field is editable by a non-admin, so even a one-field `description` PATCH from a non-admin gets `403 Forbidden`.

**`group` on update:** [`POST /api/v1/boards/{id}/move-group/`](#post-apiv1boardsidmove-group) is the preferred way to change it. Since 1.2, setting `group` to a different group requires admin of that group or of one of its ancestor groups (or a site admin with all-content access). Otherwise, or if the group does not exist, the request returns `400` with `{"group": ["Unknown group, or you are not an admin of it."]}` and changes nothing. The check runs against the board's group when the update is applied. Sending the current `group` unchanged (for example in an echoing `PUT`) or `null` (detach to a personal board) needs only board admin. Since 1.2, a `group` change made this way sends the same [group-channel events](websockets.md#group-channel-since-11) as move-group: `board.deleted` to the old group and `board.created` to the new one.

### `DELETE /api/v1/boards/{id}/`
Delete a board. Requires the board owner or a user with `can_access_all_content` (the `site_admin` role). A board admin who is not the owner gets `403 Forbidden`; see the [role matrix](../features/rbac/roles.md). Deletes every card, **including archived cards** (see `archived_card_count` above).

Since 1.2, if cards keep being created in, or moved into, the board while it is being deleted, the delete gives up after a bounded number of internal retries and returns `409 Conflict` with `{"code": "container_changed", "detail": "Cards were added while this was being deleted. Please try again."}`. Nothing is deleted; retry the request (#1602). A create or move that targets the board while it is being deleted waits for the delete and then returns `404`. Other requests that write to the board while it is being deleted also wait for the delete and then return `404` with nothing written: board `PATCH`/`PUT`, share link enable and revoke, move-group, column and swimlane create, update, reorder and set-collapsed, card and swimlane custom-field definition create, update and delete, label create, update and delete, saved-filter create, star and unstar, member add, role change and removal, and invite link create and send. A delete of a board, column or swimlane that waits behind another delete of the same object also waits and then returns `404`; the deletion event is sent once. A `PATCH` of a board that waits behind another write to the same board (for example a share link change or a move to a group) applies only the fields it sends: the fields it did not send keep the other request's committed values. While a column or swimlane is being deleted, an update of that column or swimlane waits and then returns `404`; other column and swimlane requests wait for it and then proceed (a column reorder that still lists the deleted column returns `400`).

### `GET /api/v1/boards/{id}/full/`
Full board state — columns, swimlanes, cards, labels, members, `current_user_role`, and `capabilities`. All objects include their `uid` field. Also includes `share_token` (the board's public share UUID, returned only to `admin` and `site_admin` role members, `null` when no share link exists; lower roles always get `null`) and `share_token_expires_at` (ISO-8601 timestamp of the share link's expiry, or `null` for no expiry; admin-only, mirrors `share_token` visibility — added in 1.1, #804). The `capabilities` object contains boolean feature flags for enterprise-registered extension points (all `false` in OSS). The keys are additive-only (never removed or renamed), and a client should treat an absent key as `false`. Current keys: `movement_export` (`true` when an enterprise movement-export backend is registered; gates the export UI on the movements view).

*(1.2+, #1935)* `share_link_active` is `true` when the board has a share link set and `false` when it has none, for `admin` and `site_admin` role members; lower roles get `null`. A link past its `share_token_expires_at` still reads `true` until it is rotated or revoked (its public page answers `410 Gone`). *(#1939)* A link with no recorded enabler (enabled before the enabler was recorded (for example under 1.1, or 1.2.0-beta.3 and earlier)) reads `false`, and `share_token` and `share_token_expires_at` read `null`, since such a link does not resolve; turning sharing on issues a new link. Use this field to tell whether a link exists.

!!! warning "Deprecated: `share_token` on board reads"
    `share_token` in this response is **deprecated since 1.2** and will be removed in 2.0, together with the stored token. Until then it keeps its name, type and admin-only visibility and is still populated for a link that can resolve, so existing clients keep working (a link with no recorded enabler reads `null`, as described above). New clients should read the token only from the [`POST /api/v1/boards/{id}/share/`](#post-apiv1boardsidshare) response, which returns it when a link is created or rotated, show it to the admin then, and use `share_link_active` to tell whether a link is set. The Visiban web app works this way from 1.2: it shows the link once, right after it is created, and offers **Rotate link** for a link created earlier.

`cards` lists active cards only. Since 1.2, the payload also carries `archived_card_count` (integer) — the number of archived cards that `cards` omits but that a board delete would remove (#1289).

Since 1.2, each card in the payload also carries `external_ref` (`{ provider, ref, url }` or `null`) — see [External ref](cards.md#external-ref-since-12).

Since 1.2, also includes `custom_field_definitions` (the board's card custom field schema) and `swimlane_custom_field_definitions` (the board's [swimlane custom field](#swimlane-custom-fields-since-12) schema) — both read-only lists, available to every board role. Definition schemas disclose nothing a board reader does not already have; which of a swimlane's *values* a given role may read is decided per-definition by `is_admin_only`, not by this field.

**`members` is the effective roster, not membership rows.** It lists everyone who can act on the board: direct members, members inherited from the board's group (and its ancestors), and the board owner. For a site-admin requester (board role `site_admin`, or an instance site admin) it also lists every user with all-content access who holds no other role on the board, so they appear in @mention autocomplete and member management; for every other requester it lists the board's own members only (since 1.2, #1714). Mentioning a user with all-content access by typing their `@username` notifies them either way. Only direct members have a `BoardMembership` row on the board, so for the other rows `id` is `null`; all-content rows carry `role: "site_admin"`, which is not a membership role. In the OpenAPI schema this is the `EffectiveBoardMember` component (role enum `EffectiveBoardRoleEnum`), distinct from the strict `BoardMembership` component returned by `POST /api/v1/boards/{id}/members/`, whose `id` is never `null` and whose `role` never includes `site_admin`. Since 1.2 the schema documents `/full/` as its own `BoardFull` component; before that it was mis-documented as `Board` (#1137), a schema-only correction that did not change the response body.

**`?expand=group`:** populates `group_detail` with a `GroupBrief` object: `id`, `name`, `parent` (parent group FK ID or `null`), `parent_name` (or `null`), and `ancestors` (root-first `[{ id, name }]`). Without it, `group_detail` is `null`.

### `GET /api/v1/boards/{id}/events/`
Board change feed: committed board mutations in ascending `id` order, so a consumer can resume after a dropped WebSocket instead of re-fetching `/full/`. Added in 1.2.

**Query parameters:** `after` (cursor — a feed row `id`, never a WebSocket frame's `event_id`; default `0`) and `limit` (`1`–`500`, default `100`). Both are validated, not clamped; an out-of-range or malformed value returns `400`.

**Response:** `{ "results": [{ id, event, data, actor_id, actor, created_at }, ...], "next_cursor": <int|null>, "next": <int|null> }`. `next_cursor` is the cursor for the following page (pass it as `after`), or `null` when the caller is caught up. `next` is a deprecated duplicate with the same value; use `next_cursor`. `actor` (since 1.2, #1663) is the acting user as a nullable nested `BoardUser` object (`id`, `username`, `display_name`, `avatar_url`), alongside the unchanged integer `actor_id`; see [Change Feed](events.md).

**Permissions:** any board role, the same gate as `/full/` and the WebSocket handshake — the feed replays events the caller could already have streamed. `is_moderator` is stripped from `member.*` payloads for roles below `admin`, exactly as the WebSocket consumer strips it — except on the row belonging to the reader themselves, which always carries the field (#1191).

**`410 Gone`:** an event after the cursor that the caller could have read has aged out of the retention window (`BOARD_EVENT_RETENTION_DAYS`, default 30 days) and been pruned. Re-sync via `/full/`, then resume with the body's `next_cursor` as `after` (1.3+; `/full/` carries no event id). A cursor whose own event was pruned, with nothing the caller could have read pruned after it, is not expired (1.3+, #2058, #2079); see [When a cursor expires](events.md#errors) for the exact rule and for boards not pruned since the upgrade. The `detail` text's "newest event id" means a row `id` of this feed, never a WebSocket frame's `event_id`.

```json
{
  "detail": "This cursor can no longer be resumed — events after it may have been pruned by the retention window. Re-sync the board state and resume from the newest event id you see after that.",
  "code": "cursor_expired",
  "resync_url": "https://your-instance.example.com/api/v1/boards/1/full/",
  "next_cursor": 84213
}
```

See [Change Feed](events.md) for the full contract, retention, and the reconnect flow.

### `POST /api/v1/boards/{id}/health-status/`

*(1.3+, #2242)* Set or confirm the board's own health status. This is the explicit action behind the editor's **Save** and **Confirm status**: it always records a history row, even when `status` equals the current value (a *reconfirm*, which refreshes `health_status_changed_at`), and it is the only write that stores a note. A `PATCH`/`PUT` of `health_status` (and a create, or a Django admin edit) records a row only when the value changes, with no note. Board admin only (`403 Forbidden` otherwise; `404 Not Found` for a board you cannot see).

| Field | Type | Description |
|---|---|---|
| `status` | string / null | Required. `"on_track"`, `"at_risk"` or `"off_track"`, or `null` to clear the board's own value (inherit). Clearing when nothing is set here returns `400` (`{"status": ["Nothing set here to confirm."]}`). |
| `note` | string / null | Optional. The reason, at most 280 characters (`400` if longer). Surrounding whitespace is trimmed, line breaks become spaces, and an empty note is stored as `null`. |

**Response `200 OK`:** the board, with the same fields as a `PATCH` response. Sends `board.updated`, like any board edit.

### `GET /api/v1/boards/{id}/health-history/`

*(1.3+, #2242)* The board's own health status changes, newest first, at most 20 per request. When `has_more` is `true`, repeat the request with `?offset=20`, `?offset=40`, and so on to reach older changes (optional; default 0). Any board role (viewer and up) may read; anyone else gets `404 Not Found`.

```json
{
  "results": [
    {"from_status": "on_track", "to_status": "at_risk", "changed_by": {"id": 3, "username": "priya", "display_name": "Priya", "avatar_url": ""}, "changed_at": "2026-11-14T10:00:00Z", "note": "vendor slipped API delivery"}
  ],
  "has_more": false
}
```

A row whose `from_status` equals `to_status` is a reconfirm. A `null` status means "nothing set here" (inherit). `changed_by` is `null` for a removed account or an automatic change. `has_more` is `true` when older changes exist; they are kept (they are deleted only with the board) but this endpoint does not page past the 20 most recent. History is never imported or exported. These endpoints and fields follow the 1.0+ API stability rules: fields may be added, never removed or retyped.

### `POST /api/v1/boards/{id}/star/`
Star (favorite) a board. Takes no body. Returns `200 OK` with the updated board object, whether or not it was already starred.

**Permissions:** requires authentication and board access (any role). Sends `board.star_changed` to the requesting user's own WebSocket sessions only (#1677).

### `DELETE /api/v1/boards/{id}/star/`
Unstar a board. Returns `200 OK` with the updated board object (`is_starred: false`), the same as `POST`, not `204 No Content`. The OpenAPI schema documented a bodiless `204` until 1.2 (#1783); the endpoint has always answered `200` with the board. Sends `board.star_changed` to the requesting user's own WebSocket sessions only.

**Permissions:** requires authentication and board access (any role).

### `GET /api/v1/boards/?starred=true`
List only boards the requesting user has starred.

### `POST /api/v1/boards/{id}/move-group/`
Move board to a different group (or `null` for personal).

Since 1.2, a request body that is not a JSON object returns `400 Bad Request` (it returned `500` before). A `group_id` that is not an integer or is out of range is `404`, as before.

**Minimum role:** Board owner, board admin, or site admin. Since 1.2, to move into a group the caller must also be an admin of the target group or of one of its ancestor groups (or a site admin with all-content access), the same rule as [`POST /api/v1/groups/{id}/boards/`](groups.md). Moving to personal (`null`) needs only the board role above.

> **Added in 1.2**

A move-group, board `PATCH`/`PUT` that sets `group`, board create with a `group`, or [`POST /api/v1/groups/{id}/boards/`](groups.md) that arrives while the target group is being deleted waits for the delete to finish. Move-group and the group board create then answer `404`, as for an unknown group; board create and `PATCH`/`PUT` answer `400` with `{"group": ["Unknown group, or you are not an admin of it."]}`, as for an unknown group. Nothing is written. A group delete that arrives while such a request is in flight waits for it, then detaches the board from the group (#1638).

**Request** `{ "group_id": 5 }` or `{ "group_id": null }`. `group_id` is the only key read; omitting it is the same as `null` (move to personal).

**Response** `200 OK` with the updated board object.

**Errors**

| Status | Body | Condition |
|---|---|---|
| `403 Forbidden` | `{"detail": "..."}` | Caller is not board owner/admin, or can see the target group but is not an admin of it |
| `404 Not Found` | `{"detail": "..."}` | Target group does not exist or is not visible to the caller (both answer the same; before 1.2 a group the caller was not a member of returned `403`) |

---

## Sample boards

> **Added in 1.2**

Read-only endpoints behind the **Start from a sample** gallery on the Import Board screen. They need the same access as importing (authentication, no pending password or username change) and, for a personal access token, the `read` scope. Both set `Cache-Control: private, max-age=3600`.

The files ship in the backend image, so a sample always matches the same release's importer. To use one, fetch it and post it to [`POST /api/v1/boards/import/`](#post-apiv1boardsimport) like any other export file; group access and the import rate limit are enforced there.

### `GET /api/v1/boards/samples/`
List the sample boards in gallery order.

```json
[
  {
    "id": "sales_overlay",
    "title": "Sales Overlay",
    "description": "See which accounts have coverage gaps under an enterprise overlay sales model.",
    "swimlane_theme": "account",
    "card_count": 42,
    "includes": ["labels", "checklists", "comments", "history"],
    "order": 1,
    "schema_version": 2,
    "date_anchor": "2026-03-15"
  }
]
```

| Field | Description |
|---|---|
| `id` | Stable identifier, `[a-z0-9_]+`. Never renamed; use it for `GET /boards/samples/{id}/`. |
| `title` | Display name. An import without a `name` is titled `Imported: <title>`. |
| `description` | One line on what the board is for. |
| `swimlane_theme` | What a swimlane stands for on this board, e.g. `account`, `region`. |
| `card_count` | Active cards. Archived cards in the file are not counted. |
| `includes` | Any of `labels`, `checklists`, `comments`, `history`, derived from the file's contents. |
| `order` | Gallery order. Unique; the list is sorted by it. |
| `schema_version` | The export schema version of the file. |
| `date_anchor` | The day the board's dates are measured from. Since #1949 the sample file carries the same value as a top-level `date_anchor`, so importing the file with no options already dates the board around today (see [Date shifting](#date-shifting)). Sending it as the import option [`shift_dates_from`](#import-options) does the same explicitly. |

### `GET /api/v1/boards/samples/{id}/`
Return one sample as the raw Visiban JSON export (`Content-Type: application/json`), with a strong `ETag`. Send it back in `If-None-Match` to get `304 Not Modified` with no body. The bundled nginx (Compose and the Helm frontend) gzips `application/json` for clients that send `Accept-Encoding: gzip`, so a fetch is roughly 30-60 KB on the wire against 265-560 KB raw. A deployment behind a different proxy gets the raw size unless that proxy compresses.

| Status | When |
|---|---|
| `401 Unauthorized` | Not authenticated. |
| `403 Forbidden` | The account has a pending password or username change, or the token lacks the `read` scope. |
| `404 Not Found` | `id` is not in the shipped manifest. |

---

## Templates

### `GET /api/v1/boards/templates/`
List all active board templates. Requires authentication. Used by the board creation modal to populate the template picker.

This endpoint and board creation (`POST /api/v1/boards/`, `POST /api/v1/groups/{id}/boards/`) read the same `BoardTemplate` table, so a template's listed columns are exactly the columns a new board gets (#1115).

**Response**
```json
[
  {
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "name": "Sales Pipeline",
    "slug": "sales_pipeline",
    "description": "Track deals through your sales stages.",
    "icon": "chart-up",
    "lane_label": "Account",
    "lane_placeholder": "e.g. Acme Corp",
    "columns_json": [
      { "name": "Prospect", "color": "#6B7280", "position": 0 },
      { "name": "Qualified", "color": "#3B82F6", "position": 1 },
      { "name": "Discovery", "color": "#8B5CF6", "position": 2 },
      { "name": "Demo", "color": "#F59E0B", "position": 3 },
      { "name": "Proposal Sent", "color": "#F97316", "position": 4 },
      { "name": "Negotiation", "color": "#EF4444", "position": 5 },
      { "name": "Closed Won", "color": "#10B981", "position": 6, "is_done": true },
      { "name": "Closed Lost", "color": "#9CA3AF", "position": 7, "is_done": true }
    ],
    "sort_order": 1
  },
  ...
]
```

| Field | Description |
|---|---|
| `id` | UUID — not an integer |
| `slug` | Stable identifier (used by integrations) — snake_case, e.g. `sales_pipeline`, `simple_kanban` |
| `lane_label` | Label for the "first swimlane" step in board creation (e.g. "Account", "Project") |
| `lane_placeholder` | Placeholder text shown in the swimlane name input |
| `columns_json` | Native JSON array of column objects that will be created: `{name, color, position}`, plus `is_done: true` on a template's terminal column(s) (e.g. "Done", "Closed Won") — omitted (not `false`) on every other column. Since 1.3 a column may also carry a [`policy`](#column-policy-since-13), applied to the new column; a malformed one is dropped rather than failing board creation. |

Available templates: **Sales Pipeline**, **Customer Support**, **Customer Success**, **Simple Kanban**, **Product Roadmap**, **Project Delivery**, **Content Production**, **Hiring & Recruiting**, **Legal & Compliance**, **Infrastructure & DevOps**, **Blank Board**.

**Registering additional templates.** Any installed package (not just enterprise) can register templates, with no OSS code change or migration, via `boards.hooks.TEMPLATE_PROVIDERS` — see that module for the callable signature and conflict policy (new slugs only; the sync never overwrites an existing built-in or provider-registered row). See [`docs/architecture/open-core-boundary.md`](../architecture/open-core-boundary.md) for the OSS extension-point conventions.

### `GET /api/v1/boards/{id}/summary/`
Board health summary: per-swimlane card counts, stage distribution, and velocity. Uses a fixed number of queries regardless of board size. *Changed in 1.3* (#448): velocity and cycle time replay the history of the cards that entered a done column in the last 30 days, so the cost grows with recent completions rather than with the board's whole history (before, this was SQL aggregates only).

**Response shape:**

```json
{
  "swimlanes": [
    {
      "id": 1,
      "name": "Acme Corp",
      "color": "#3B82F6",
      "total_cards": 5,
      "active_cards": 3,
      "done_30d": 4,
      "avg_cycle_days": 6.5,
      "stage_distribution": { "Backlog": 2, "In Progress": 3, "Done": 0 },
      "velocity_7d": 1,
      "velocity_30d": 4,
      "blocked_cards": 1
    }
  ],
  "extension_panels": []
}
```

| Field | Type | Description |
|---|---|---|
| `id`, `name`, `color` | — | Swimlane identifier, name, and color |
| `total_cards` | integer | Total active (non-archived) cards in this swimlane |
| `active_cards` | integer | Cards in this swimlane that are not in a done column |
| `done_30d` | integer | Cards whose first entry into a done column fell in the last 30 days, archived since or not; the same value as `velocity_30d`. *Changed in 1.3* (#448): before, this counted moves, so a card entering a done column twice counted twice, and a card archived since left the count |
| `avg_cycle_days` | float\|null | Mean [cycle time](../architecture/decisions.md#flow-metric-definitions) in days of the cards whose first entry into a done column fell in the last 30 days, archived since or not, rounded to one decimal; `null` if there are none. *Changed in 1.3* (#448): before, it started at a card's first movement of any kind, so it measured lead time, and it left out archived cards |
| `stage_distribution` | object | Card count per column for this swimlane (all columns, including zero counts) |
| `velocity_7d` | integer | Cards whose first entry into a done column fell in the last 7 days, archived since or not (counts cards, not moves; *changed in 1.3*, #448) |
| `velocity_30d` | integer | The same over the last 30 days |
| `blocked_cards` | integer | *Added in 1.3* (#1149). Active cards in this swimlane (not archived and not in a done column, the cards `active_cards` counts) that are blocked now, manually or by an active `blocks` relation (the card's [`is_blocked`](cards.md#block-and-unblock-since-13)). One more aggregate query |
| `extension_panels` | array | `[]` in OSS. Panels registered through the `ANALYTICS_EXTENSIONS` hook, limited to those whose `min_role` the caller meets (see [Panel visibility by role](#panel-visibility-by-role)); the web UI renders them in the Summary tab below the swimlane table. See [Extension panel payload](#extension-panel-payload) |

#### Extension panel payload

> **Added in 1.2** (#1770)

Each `extension_panels` entry comes from an `ANALYTICS_EXTENSIONS` callable (`boards/hooks.py`), normalized by the API encoder: tuples become lists, date, time and UUID values become strings, and `Decimal` values become numbers. The web UI renders two panel types, `stats` and `table`. The shape is a public contract: existing types only gain optional fields, and an incompatible shape gets a new `type` name. There is no version field.

| Field | Required | Rule |
|---|---|---|
| `id` | yes | String, 1-100 characters, unique per response (the first valid panel with an id wins; a later duplicate is skipped, but renders if the earlier one was malformed) |
| `title` | yes | String, 1-120 characters |
| `type` | yes, to render | `"stats"` or `"table"`. A panel with a missing or unknown `type` (including legacy `{id, title, data}` panels) is returned by the API but has no renderer and is skipped |
| `description` | no | String, up to 500 characters |
| `data` | yes | Shape depends on `type`, below |

`stats` data: `{"items": [{"label": ..., "value": ..., "hint": ...}]}`

- 1-24 items; `label` is a string of 1-80 characters; `value` is a string of up to 200 characters, a finite number, or `null` (rendered as `—`); `hint` is an optional string of up to 200 characters.

`table` data: `{"columns": [{"key": ..., "label": ..., "align": ...}], "rows": [{...}]}`

- 1-12 columns; `key` is a string of 1-64 characters, unique within the panel, and not `__proto__`, `constructor` or `prototype` (a panel using one of those keys is skipped); `label` is a string of 1-80 characters; `align` is `"left"` (default) or `"right"`.
- 0-200 rows. Each row is an object keyed by column `key`; every cell is a string of up to 200 characters, a finite number, or `null`. A missing key renders as `null`. Zero rows renders `No data.`

Rendering rules:

- At most 20 panels are rendered; extras are skipped. Unknown fields are ignored at every level.
- A `null` optional field (`description`, `hint`, `align`) is treated as absent, so a Python `None` is fine; omitting the key is still preferred.
- Any other violation (wrong type, a value over a limit, `NaN` or infinity, a boolean or object cell) skips the whole panel. Panels are never truncated. Skipped panels log one browser console warning that names the panel id (or its index when the id is missing, empty, not a string, or over 100 characters) and the reason, never the title or data. Panels over the 20-panel cap log a single summary warning.
- The backend also validates each panel before responding: a panel that is not an object, or that contains `NaN`, infinity or a value that cannot be serialized to JSON, (including a string with a lone surrogate) is dropped by the API, with a server warning that names the callable and the exception type but never the panel contents or exception text, so a bad panel does not fail the summary response. The frontend skips any panel that still breaks the rules above.
- Chart panel types are not part of v1; they are tracked in #1774.
- Panels supply text and numbers only. Every string renders as plain text: there is no HTML, Markdown, link, class, color, or style support. A URL in a string is shown as text, not as a link.

Example:

```json
{
  "id": "delivery-risk",
  "title": "Delivery risk",
  "type": "stats",
  "data": { "items": [{ "label": "Blocked cards", "value": 4, "hint": "since Monday" }] }
}
```

#### Panel visibility by role

> **Changed in 1.2** (#1826)

The summary goes to every member who can read the board, viewers included, so each `ANALYTICS_EXTENSIONS` callable sets a `min_role` attribute naming the lowest board role that may see its panel:

```python
def delivery_risk(board, request):
    return {"id": "delivery-risk", "title": "Delivery risk", "type": "stats", "data": {...}}

delivery_risk.min_role = "viewer"
ANALYTICS_EXTENSIONS.append(delivery_risk)
```

| `min_role` | Panel is shown to |
|---|---|
| `"viewer"` | Every member who can read the board |
| `"collaborator"` | Collaborators, members, admins |
| `"member"` | Members and admins |
| `"admin"` | Board admins, including the owner |
| `"site_admin"` | Users with all-content access only |

- The summary resolves the caller's board role the way it authorizes the request (all-content access, then owner, then explicit membership, then the nearest group membership) and drops every panel above that role **before calling any panel**. A dropped panel's callable is never invoked.
- **Fail closed:** a callable with no `min_role` (or `None`) is admin-only, and so is one with an invalid value (unknown, miscased or not a string), which also logs a server warning naming the callable. Panels registered before 1.2 are therefore admin-only until their author sets `min_role`.
- A callable class can set `min_role` as a class attribute. For a bound method, set it on the function in the class body; a bound method object does not accept new attributes.
- A panel can still narrow its output by checking `request.user`, but needn't gate access itself.
- A dropped panel leaves no trace: it is absent from `extension_panels`, as if none were registered.

---

### `GET /api/v1/boards/{id}/analytics/`
Time-in-stage heatmap derived from `CardMovement` records.

**Query parameters:**

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `days` | integer | `30` | Must be a positive integer (`≥ 1`, `≤ 365`). Returns `400` if non-integer, `≤ 0`, or `> 365`. |
| `stalled_days` | integer | board's `staleness_threshold_days` | When provided, overrides the board setting for stalled-card detection in this request only. Must be a positive integer (`≥ 1`, `≤ 90`). Returns `400` if non-integer, `≤ 0`, or `> 90`. Omit to use the board's configured threshold. |

> **Added in 1.2**

An invalid `days` or `stalled_days` returns `400 Bad Request` with `{"detail": "...", "code": "invalid_query_param"}` (before 1.2 the body had `detail` only), the API-wide shape for a bad query parameter — see [Error responses](index.md#error-responses).

**Response shape:**

```json
{
  "days": 30,
  "columns": ["Backlog", "In Progress", "Done"],
  "done_columns": ["Done"],
  "board_medians": { "Backlog": 2.0, "In Progress": 5.5 },
  "stalled_threshold_days": 7,
  "staleness_threshold_days": 7,
  "stale_warning_pct": 75,
  "swimlanes": [
    {
      "id": 1,
      "name": "Acme Corp",
      "avg_days_per_column": { "Backlog": 1.5, "In Progress": 8.0 },
      "is_outlier": { "Backlog": false, "In Progress": true },
      "age_avg_days_per_column": { "Backlog": 2.1, "In Progress": 9.3 },
      "age_is_outlier": { "Backlog": false, "In Progress": true },
      "throughput_avg_days_per_column": { "Backlog": 1.2, "In Progress": 7.5 },
      "throughput_card_count_per_column": { "Backlog": 4, "In Progress": 2 },
      "throughput_is_outlier": { "Backlog": false, "In Progress": true },
      "deal_velocity_days": 12.3,
      "stalled_cards": [
        { "id": 42, "uid": "3a9f1c2d7e4b8a05", "title": "Fix login bug", "days_since_move": 14 }
      ]
    }
  ],
  "blocked": {
    "total": { "days": 3.5, "seconds": 302400, "blocks": 2 },
    "days_per_column": { "Backlog": 0.0, "In Progress": 3.5, "Done": 0.0 },
    "seconds_per_column": { "Backlog": 0, "In Progress": 302400, "Done": 0 },
    "blocks_per_column": { "Backlog": 0, "In Progress": 2, "Done": 0 },
    "top_reasons": [
      { "reason": "Waiting on customer", "count": 2, "total_days": 3.5, "total_seconds": 302400 }
    ]
  }
}
```

**Response fields:**

| Field | Type | Description |
|---|---|---|
| `days` | integer | The window used for the query, mirrored from the `days` query parameter. |
| `columns` | list[str] | All column names on the board in position order, including done columns. Preserved for backward compatibility — consumers that need only active columns should subtract `done_columns`. |
| `done_columns` | list[str] | Column names where `is_done=True`. These columns are excluded from the dwell-time heatmap. The `avg_days_per_column`, `is_outlier`, and `board_medians` dicts contain keys only for active (non-done) columns. |
| `board_medians` | object | Median dwell time in days per active column, keyed by column name. Done columns are omitted. Preserved for backward compatibility — prefer `age_avg_days_per_column` for current-dwell snapshots. |
| `stalled_threshold_days` | integer | Effective threshold used for stalled-card detection in this response. Equals `staleness_threshold_days` when `stalled_days` is not provided, or the supplied `stalled_days` value otherwise. |
| `staleness_threshold_days` | integer | The board's configured staleness threshold in days. Used for heatmap outlier coloring (`is_outlier`, `age_is_outlier`, `throughput_is_outlier`). Always reflects the board setting regardless of any `stalled_days` override. |
| `stale_warning_pct` | integer | The board's warning percentage (0–100). Controls the yellow/green boundary in the heatmap. |
| `swimlanes[].avg_days_per_column` | object | **Deprecated.** Period-filtered average dwell time per active column (clamped entry). Kept for backward compatibility — prefer `throughput_avg_days_per_column` instead. |
| `swimlanes[].is_outlier` | object | Whether `avg_days_per_column` for each active column meets or exceeds `staleness_threshold_days`. Done columns are omitted. |
| `swimlanes[].age_avg_days_per_column` | object | Current dwell, not age, whatever the field name says: how long the cards **presently sitting** in each active column have been in their open [visit](../architecture/decisions.md#flow-metric-definitions), averaged per column. Cards in done columns are excluded. `null` when the column has no currently-dwelling cards. *Changed in 1.3* (#448): a swimlane-only move no longer resets a card's time, and a card whose column changed without a movement is left out. A restore still starts a new visit. |
| `swimlanes[].age_is_outlier` | object | Whether `age_avg_days_per_column` for each active column meets or exceeds `staleness_threshold_days`. |
| `swimlanes[].throughput_avg_days_per_column` | object | Average completed dwell: visits to each active column that **closed** during the period window, at their full length. Cards still dwelling are excluded. `null` when no visit closed during the window. *Changed in 1.3* (#448): a swimlane-only move no longer splits a visit, an archive closes one and a restore opens a new one (so the archived period is not dwell), and a visit keeps its true start however long ago it began. |
| `swimlanes[].throughput_card_count_per_column` | object | Number of visits behind that average. `0` means no visit closed. |
| `swimlanes[].throughput_is_outlier` | object | Whether `throughput_avg_days_per_column` for each active column meets or exceeds `staleness_threshold_days`. |
| `swimlanes[].deal_velocity_days` | number or null | Average days from a card's first movement ever to its most recent movement, over this swimlane's cards whose most recent movement falls in the period. Cards count whether or not they reached a done column. `null` when there is no velocity data. |
| `blocked` | object | *Added in 1.3* (#1149). Manual blocked time inside the `days` window, by the column each block started in. A block counts for the part of it inside the window; an open block runs to now, or to the card's archive time while the card is archived (after a restore it runs to now again, archived period included). Every end is clipped to now, so an imported block with future timestamps adds nothing beyond now. An open block whose card was hard-deleted is left out; a closed block of a hard-deleted card still counts, as its movements do. Relation blocks are not timed. |
| `blocked.total` | object | `{days, seconds, blocks}` for every block in the window, including blocks in columns that no longer exist, which no per-column entry holds. |
| `blocked.days_per_column` | object | Blocked days per column, keyed by column name, every column (done columns included) with zeros. One decimal. |
| `blocked.seconds_per_column` | object | The same blocked time in whole seconds, for durations under a day. |
| `blocked.blocks_per_column` | object | Number of blocks overlapping the window per column. |
| `blocked.top_reasons` | array | Up to 10 `{reason, count, total_days, total_seconds}`, most frequent first (ties: more blocked time first). Reasons that differ only in case or spacing are one entry, shown with the newest spelling. Includes blocks in a column that no longer exists. |
| `swimlanes[].stalled_cards` | array | Cards that have not moved for longer than `stalled_threshold_days`. Each entry is `{ "id", "uid", "title", "days_since_move" }`. |

*Changed in 1.3* (#448): columns are matched by identity, never by name. A column deleted and recreated under the same name no longer inherits the old column's visits, done flag or blocked time.

A cell is flagged as an outlier (`is_outlier: true`) when its per-swimlane average meets or exceeds the board's `staleness_threshold_days`. Heatmap color-coding uses `staleness_threshold_days` and `stale_warning_pct` to determine green, yellow, and red thresholds (see [Analytics — Color-coding](../features/analytics.md#color-coding)). Done columns are excluded from dwell-time calculations entirely — cards that have moved into a done column are considered complete and do not accumulate further dwell time in the heatmap. Archived cards contribute their dwell time up to the archive timestamp; active cards accumulate dwell time until they move again. Cards are excluded from stalled detection once archived.

CSV export (`Export CSV` button) is available to any board member whose role meets the board's `export_min_role` threshold. Owners and site admins always bypass.

---

### Flow metrics

<span class="vb-version" title="Added in 1.3">1.3+</span>

`GET /api/v1/boards/{id}/metrics/cycle-time/`, `.../throughput/`, `.../cumulative-flow/` and `.../wip-age/` return the charts on the [Analytics](../features/analytics.md#flow-metrics) tab, for any board member, viewers included. Every number follows the [flow metric definitions](../architecture/decisions.md#flow-metric-definitions), and each response quotes its definition in `definition`.

**Query parameters, on all four:**

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `days` | integer | `90` | Rolling range, `1`-`365`. Cannot be combined with `from_date` or `to_date`. |
| `from_date` | date | 90 days ending at `to_date` | First UTC day of the range, inclusive. |
| `to_date` | date | Today (UTC) | Last UTC day, inclusive. A range holds at most 366 days. |
| `swimlane_id` | integer | none | Cards now in this swimlane of this board. |
| `label_id` | integer | none | Cards now carrying this label of this board. |

A bad value, or a swimlane or label that is not on this board, returns `400` with `{"detail": "...", "code": "invalid_query_param"}`. A board you cannot access returns `404`.

**How a range applies.** A duration sample belongs to the range its completion falls in. Bucketed outputs (throughput, cumulative flow) report only whole UTC days and whole ISO weeks, and today, which is still running, is never a bucket. WIP age is a snapshot: the range moves only its `cycle_time_percentiles`.

**Percentiles** are nearest-rank, in days at full precision (round for display). A percentile is `null` when its sample is too small: `p50` needs 5 values, `p85` needs 7 and `p95` needs 20. Clients draw nothing for a `null`, and never recompute it.

**`cards`.** The responses name cards by `uid`. `cards` lists each one they name, as `{uid, id, title, archived, assignee}`, so a client can show a card's title and owner, including an archived card's, without another request. For its transitions, use [`GET /api/v1/boards/{board_id}/cards/{id}/movements/`](cards.md) with that `id`.

#### `GET /api/v1/boards/{id}/metrics/cycle-time/`

```json
{
  "definition": "the time from a card's first move out of ...",
  "sample_size": 34,
  "excluded_incomplete_history": 2,
  "percentiles": { "p50": 4.21, "p85": 8.14, "p95": 12.6 },
  "samples": [
    {
      "card_uid": "3a9f1c2d7e4b8a05",
      "value_days": 8.14,
      "start": "2026-06-01T09:00:00Z",
      "end": "2026-06-09T12:21:36Z",
      "reopened": false
    }
  ],
  "cards": [
    { "uid": "3a9f1c2d7e4b8a05", "id": 42, "title": "Fix login", "archived": false, "assignee": null }
  ]
}
```

`excluded_incomplete_history` counts the cards left out only because their history is missing, broken or misdated. `reopened` is `true` when the card was reopened after this completion; its number does not change.

#### `GET /api/v1/boards/{id}/metrics/throughput/`

Adds an optional `period`, `week` (the default) or `day`.

```json
{
  "definition": "the number of cards whose first entry into a done column falls in a period.",
  "period": "week",
  "total": 9,
  "median": 2,
  "samples": [
    { "start": "2026-06-01", "count": 3, "card_uids": ["3a9f1c2d7e4b8a05"] }
  ],
  "cards": []
}
```

`median` is the nearest-rank p50 of the period counts, zero periods included, and `null` under five whole periods. `start` is the period's first UTC day.

#### `GET /api/v1/boards/{id}/metrics/cumulative-flow/`

```json
{
  "definition": "for each day, the number of cards in each column at the end of that day.",
  "columns": [
    { "column_uid": "col0000001", "column_name": "Doing", "is_done": false },
    { "column_uid": "col0000002", "column_name": "Done", "is_done": true },
    { "column_uid": null, "column_name": null, "is_done": false }
  ],
  "days": [
    { "date": "2026-06-01", "counts": { "col0000001": 4, "col0000002": 7, "null": 0 } }
  ],
  "bottleneck_column_uid": "col0000001"
}
```

The last column, `column_uid: null`, is one band for every deleted column; in `counts` it is the key `"null"`. `bottleneck_column_uid` is the current column that is not done whose count grew the most from the first day to the last (the earlier column wins a tie), or `null` when none grew.

Add `date=YYYY-MM-DD`, a UTC day before today, for the cards behind that day's counts instead:

```json
{
  "definition": "for each day, the number of cards in each column at the end of that day.",
  "date": "2026-06-01",
  "columns": [
    { "column_uid": "col0000001", "card_uids": ["3a9f1c2d7e4b8a05"] },
    { "column_uid": null, "card_uids": [] }
  ],
  "cards": []
}
```

#### `GET /api/v1/boards/{id}/metrics/wip-age/`

```json
{
  "definition": "how long an in-progress card has been in progress: ...",
  "sample_size": 12,
  "excluded_incomplete_history": 1,
  "cycle_time_percentiles": { "p50": 4.21, "p85": 8.14, "p95": null },
  "columns": [{ "column_uid": "col0000001", "column_name": "Doing" }],
  "samples": [
    {
      "card_uid": "3a9f1c2d7e4b8a05",
      "column_uid": "col0000001",
      "value_days": 15.4,
      "start": "2026-06-01T09:00:00Z",
      "dwell_by_column": [
        { "column_uid": "col0000001", "value_days": 12.2 },
        { "column_uid": null, "value_days": 3.2 }
      ],
      "is_blocked": true,
      "blocked_days": 1.5
    }
  ],
  "cards": []
}
```

`columns` lists the columns that are not done, in position order. `samples` run in that order, oldest first within a column. `dwell_by_column` sums the card's measured visits per column, in order of first entry, with deleted columns as `column_uid: null`. `is_blocked` is the card's state now, manual or by a relation. `blocked_days` is its manual blocked time since its age started; it is reported beside age and never subtracted from it. A card without complete history has no age and counts in `excluded_incomplete_history`.

### `GET /api/v1/boards/{id}/movements/`
Board-level movement history for all cards, sorted newest first.

**Permissions:** any board member (`viewer` and above).

**Pagination:** the standard [envelope](index.md#pagination), but the page size is fixed at 50 results and `page_size` is ignored. Use `offset` to page through results.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `swimlane_id` | integer | Filter by the card's current swimlane |
| `to_column_id` | integer | Filter by destination column |
| `moved_by_id` | integer | Filter by the user who performed the move |
| `moved_after` | ISO date | Include movements on or after this date (e.g. `2026-01-01`) |
| `moved_before` | ISO date | Include movements on or before this date |
| `exclude_type` | comma-separated string | Exclude movement types (e.g. `archived,unarchived` hides system events). A value containing a NUL (0x00) character returns `400` with `{"detail": "exclude_type must not contain NUL (0x00) characters.", "code": "invalid_query_param"}` (*Changed in 1.3, #1887*; it was a `500` on PostgreSQL) |
| `offset` | integer | Pagination offset (default: `0`). A negative value is treated as `0`; a value above `2^62` returns `400` with `{"detail": "...", "code": "invalid_query_param"}`. |

`export_min_role` also applies to movement exports requested with `?export=<format>`: a caller below the threshold receives the same `403` with `code: "export_restricted"` as the board export, and each successful export is recorded in the [export history](#get-apiv1boardsidexport-history). Movement exports share the board export rate limit (20 exports/hour per authenticated user, scope `board_export`; `429 Too Many Requests` when exceeded). Ordinary movement reads are not rate limited by it.

With neither `moved_after` nor `moved_before`, the full history is returned (no default date cutoff). Results are always paginated to `page_size: 50`, so a missing date window can't cause a runaway query.

*(1.2+)* A `moved_after` or `moved_before` that is not a valid date (`YYYY-MM-DD`), or a `swimlane_id`, `to_column_id` or `moved_by_id` that is not an integer (or is outside the signed 64-bit range), returns `400 Bad Request` with `{"detail": "...", "code": "invalid_query_param"}`. Earlier releases answered `500` for non-integer ids and unparseable dates; an id outside the signed 64-bit range matched nothing or errored, depending on the database. Values that were accepted before, such as an id of `0` (which matches nothing), are still accepted.

**Response**
```json
{
  "count": 142,
  "offset": 0,
  "page_size": 50,
  "results": [
    {
      "id": 1089,
      "card_title": "Fix login bug",
      "card_uid": "a1b2c3d4e5f60001",
      "from_column": 2,
      "from_column_name": "In Progress",
      "from_column_uid": "c0l0abc123456701",
      "to_column": 3,
      "to_column_name": "Done",
      "to_column_uid": "c0l0abc123456702",
      "from_swimlane": 1,
      "from_swimlane_name": "Acme Corp",
      "from_swimlane_uid": "sw1mabcdef123401",
      "to_swimlane": 1,
      "to_swimlane_name": "Acme Corp",
      "to_swimlane_uid": "sw1mabcdef123401",
      "moved_by": { "id": 3, "username": "alice", "display_name": "Alice Smith", "avatar_url": null },
      "moved_at": "2026-03-25T14:30:00Z",
      "movement_type": "move",
      "notes": ""
    }
  ]
}
```

Each result object fields:

| Field | Type | Description |
|---|---|---|
| `id` | integer | Movement record ID |
| `card_title` | string | The card's current title. For a card that was hard-deleted, the title recorded on the movement (since 1.2; as of the upgrade or import for older rows) |
| `card_uid` | string | Card stable 16-char hex UID — still the original card's UID after the card is hard-deleted |
| `from_column`, `to_column` | integer / null | Column FK IDs (may be `null` if column was deleted) |
| `from_column_name`, `to_column_name` | string | Denormalized column names (preserved after deletion) |
| `from_column_uid`, `to_column_uid` | string | Denormalized column UIDs |
| `from_swimlane`, `to_swimlane` | integer / null | Swimlane FK IDs (may be `null` if swimlane was deleted) |
| `from_swimlane_name`, `to_swimlane_name` | string | Denormalized swimlane names |
| `from_swimlane_uid`, `to_swimlane_uid` | string | Denormalized swimlane UIDs |
| `moved_by` | object | User who performed the move — `{ id, username, display_name, avatar_url }` |
| `moved_at` | string | ISO 8601 timestamp |
| `movement_type` | string | One of `move`, `archived`, `unarchived` |
| `notes` | string | Optional notes recorded at move time |
| `imported_from_username` | string / null | *Since 1.2.* `null` unless the record was created by a board import with history; then `moved_by` is the importing user and this is the username the import file named (`""` when it named nobody). History imported by earlier versions carries `null`, since the original name was not kept. See [Imported history](../features/card-history.md#imported-history) |

**Errors:** `404 Not Found` if the board does not exist or the caller has no access to it.

---

## Saved Filters

Saved filters are per-user filter presets on a board. Any board member (including viewers) can save and restore their own. Filters are private: no user can see or modify another's.

### `GET /api/v1/boards/{id}/saved-filters/`
List all saved filters belonging to the requesting user on this board.

**Response**
```json
[
  {
    "id": 1,
    "name": "My urgent cards",
    "state_json": { "priorities": ["urgent", "high"], "assigneeIds": [3] },
    "state_version": 1,
    "created_at": "2026-03-20T10:00:00Z"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | integer | Filter preset ID |
| `name` | string | User-defined name (unique per user per board, max 100 characters) |
| `state_json` | object | Filter state — see [shape](#state_json-shape) below |
| `state_version` | integer | Schema version of `state_json` (currently `1`; rows predating v1.1 backfill to `1`) |
| `created_at` | string | ISO 8601 timestamp |

### `POST /api/v1/boards/{id}/saved-filters/`
Create a new saved filter preset.

**Request**

| Field | Required | Description |
|---|---|---|
| `name` | ✓ | Filter name (max 100 characters, unique per user per board) |
| `state_json` | ✓ | Filter state object — see [shape](#state_json-shape) below |
| `state_version` |  | Schema version the client is writing (integer from 1 to 32767; defaults to `1`). Clients should send `1`; the server accepts higher values unchanged so a mixed-version deploy does not lose the user's save |

#### `state_json` shape

The server rejects unknown top-level keys and type-checks each known key, but does not validate values semantically (the frontend must confirm, for example, that an `assigneeId` is a real user):

| Key | Type | Notes |
|---|---|---|
| `search` | string | Free-text search term |
| `assigneeIds` | integer[] | User IDs to include |
| `labelIds` | integer[] | Label IDs to include |
| `priorities` | string[] | Subset of `low`, `medium`, `high`, `urgent` |
| `dueDate` | string \| null | One of `overdue`, `today`, `this_week`, `none`, or `null` for "no filter" |
| `blockedOnly` | boolean | *Added in 1.3* (#1149). `true` shows only blocked cards (manual or relation). Absent means `false` |
| `customFields` | object | Custom-field filter values keyed by numeric field id (digit string), at most 50 entries. Each value is `{kind: "text", query}`, `{kind: "number" \| "date", equals}` (strings), or `{kind: "choice" \| "multi_choice", values}` (at most 50 strings). Strings are capped at 500 characters. |
| `visibleCustomFieldFilterIds` | integer[] | IDs of custom-field filters shown in the filter bar, at most 50 |
| `laneFilter` | object | *Added in 1.3* (#2205). Rules that hide swimlanes by swimlane field values: `{items: [...]}`, at most 20 items and 50 rules in all. A rule is `{kind: "rule", id, join, field, op, value?, min?, max?}`: `id` a non-negative integer, `join` `"and"` or `"or"` (ignored on the first), `field` a swimlane field id or `null` (not chosen yet), `op` one of `is`, `is_not`, `between`, `contains` (*added in 1.3*, #2226, for text and URL fields), `not_contains` and `wildcard` (*added in 1.3*, #2227, text and URL fields: a case-insensitive negative substring match, and a match of any part of the value where `*` is any run of characters and `?` one character), and `value` / `min` / `max` strings of at most 500 characters. A `contains`, `not_contains` or `wildcard` rule must carry a `value` string (empty while the user has not typed yet) and no `min` or `max`. The op list only grows; a client drops a rule whose op it does not know. A group is `{kind: "group", id, join, rules: [rule, ...]}`; groups do not nest. Unknown keys are rejected. Absent means no lane filter |

All keys are optional. The total serialized size of `state_json` must not exceed 64 KB. String values (`search`, custom-field `query`, `equals`, and `values` entries, and lane-rule `value`, `min`, and `max`) must not contain NUL (0x00) characters; they return `400`.

**Errors:** `400 Bad Request` if name is empty, exceeds 100 characters, a filter with the same name already exists for this user on this board, `state_json` contains unknown keys or wrong-typed values, or `state_version` is not an integer between 1 and 32767.

### `DELETE /api/v1/boards/{id}/saved-filters/{filter_id}/`
Delete a saved filter preset. Only its owner can delete it; deleting another user's filter returns `404 Not Found`.

---

## Export & Import

### `GET /api/v1/boards/{id}/export/`
Export the board. CSV is the default; append `?format=json` for a JSON dump. `?format=csv` returns the same CSV bytes as omitting `format` whenever `Accept` is absent or allows `application/json` or `*/*`.

- Under `format=csv` and `format=json`, error responses (`401`, `403`, `404`, `406`, `429`) are JSON.
- `Accept: text/csv` alone returns `406 Not Acceptable` on the CSV paths, with or without `format`, because no renderer serves `text/csv`. Send `*/*` or omit `Accept`.
- With `format` omitted and a browser `Accept` (`text/html`), or with `format=api`, errors render as HTML from the browsable API.

**Query parameters**

| Parameter | Values | Default | Description |
|---|---|---|---|
| `format` | `csv`, `json` | `csv` | Response format. Omit it, or send `csv`, for CSV; send `json` for the JSON dump. Other values such as `xml` return `404 Not Found` from the API's format negotiation. `csv` is accepted since 1.2 (#1790); earlier versions returned `404` for it, so omit `format` to target older servers. |

Both formats are file downloads (`Content-Disposition: attachment`): CSV as `text/csv`, JSON as `application/json`.

**Rate limit:** 20 exports/hour per authenticated user (scope: `board_export`). Exceeding the limit returns `429 Too Many Requests`.

Requires board membership; a caller with no access gets `404 Not Found`, as for a missing board. A member whose role is below the board's `export_min_role` gets `403 Forbidden` with body `{"detail": "...", "code": "export_restricted", "min_role": "<threshold>"}`. Owners and site admins always bypass the threshold.

**CSV columns:** `Card ID`, `Title`, `Description`, `Column`, `Swimlane`, `Priority`, `Assignee`, `Labels`, `Due Date`, `Weight`, `Created At`, `Created By`, `Last Moved At`, `Movement Count`, `Movement History`

`Movement History` is a semicolon-separated list of pipe-delimited records: `<timestamp>|<from_column>|<to_column>|<moved_by>`. Since 1.2, a record created by a board import with history has `<moved_by>` followed by ` (imported, originally <name>)`, or ` (imported)` when the import file named nobody. Any `|`, `;` or line break in that source name is written as a space, so the record keeps its four parts.

Since 1.2, one column is **appended** per [custom field](#custom-fields-since-12) on the board, in display order, headed `Custom: <field name>`. The fixed columns keep their positions, so index-based consumers are unaffected, and the prefix keeps a field named `Title` from colliding with a built-in header. A [multi-select](#multi-select-fields) value is written as its entries joined with `"; "`.

Also since 1.2, one column is appended per [swimlane custom field](#swimlane-custom-fields-since-12), after the `Custom: ` block, headed `Swimlane Custom: <field name>`. A row field's value repeats on every card row of its swimlane, so the CSV stays one row per card. The distinct `Swimlane Custom: ` prefix (rather than reusing `Custom: `) is required: a card field and a row field may share a `name`, and a shared prefix would produce identical headers. A field with `is_admin_only: true` produces no column for an exporter below `admin`, so its existence is not disclosed (the rule `contact_email`/`notes` already follow in this export).

### `GET /api/v1/boards/{id}/export/?format=json`
Export the board as JSON (`application/json`). Same permissions as the CSV variant: board membership and the `export_min_role` threshold. Owners and site admins always bypass.

**Rate limit:** 20 exports/hour per authenticated user (scope: `board_export`). Exceeding the limit returns `429 Too Many Requests`.

**Response shape:**

The top-level `schema_version` is always `2` in 1.1+ exports. The importer reads versions 0 (pre-1.0, no field present), 1, and 2. Version 2 adds `archived_at` per card, `movement_type`, movement `notes`, and comment `created_at`.

Each card also carries `movements` (`{from_column, to_column, from_swimlane, to_swimlane, moved_by, moved_at, notes, movement_type}`, one per `CardMovement`) and `activities` (`{event_type, from_value, to_value, actor, created_at}`, one per `CardActivity`) arrays, mirroring the [movements](cards.md#history) and [activities](cards.md#history) endpoints. `moved_by`/`actor` are usernames, not user objects, and `null` once the acting user is deleted. Since 1.2 both also carry `imported_from_username` (additive; `schema_version` stays `2`): `null` for history recorded on the board, and the source username for a row that came from an earlier import. Each card's `comments` (`{author, body, created_at}`) carry it too since 1.2, with the same meaning (#1702). Since 1.3 (#2199) each activity also carries `item_text`: the checklist item's text on `checklist_item_assigned` and `checklist_item_due_changed` entries, `null` otherwise (additive; `schema_version` stays `2`). On import a missing `item_text` is `null`; a present one must be `null` or a string of at most 500 characters, otherwise the import fails with `400`.

On import with `history` on, every movement and activity entry is recorded under the importing user and keeps the file's time. Its source name is kept as text in `imported_from_username`: the entry's own value when the file has one (a re-exported import), otherwise its `moved_by` / `actor`, or `""`. Only `assignee` is resolved to an account; source names never are. `imported_from_username` must be a string or `null`, at most 150 characters, with no NUL characters.

Since 1.2 (#1906), import also restores each card's `created_at` from the file, whatever the `history` option. It is used when it is not in the future and, with `history` on, not later than the card's first imported history entry (movement, activity or comment). Otherwise, or when the field is absent or unusable, the card is dated to the import. A bad `created_at` does not reject the file.

Comments (with `comments` on) work the same way since 1.2: each is posted under the importing user, keeps the file's `created_at`, and keeps its source name in `imported_from_username`: the comment's own value when the file has one, otherwise its `author` (a string; any other value is ignored, as before), or `""`. An `author` is never resolved to an account, and one over 150 characters is cut to 150. The same `imported_from_username` validation applies.

Since 1.2 the payload also carries the board's `custom_fields` schema and each card's `custom_field_values`, keyed by field name. Both are **additive**: `schema_version` stays `2`. JSON import restores both (see [Custom fields on import](#custom-fields-on-import)).

Also since 1.2, each card carries `external_ref` (`{ provider, ref, url }`, or `null` when unset). On import it is restored after validation against the same rules as the card API; invalid entries are silently dropped. CSV export and import do not carry it.

Since 1.3 (#1149), each card also carries its [manual blocked state](cards.md#block-and-unblock-since-13): `blocked_at` (ISO 8601 or `null`), `blocked_reason` (`""` when not blocked), and `blocks`, the full block history oldest first (`{blocked_at, blocked_by, reason, unblocked_at, unblocked_by, resolution, column, imported_from_username}`; `blocked_by`/`unblocked_by` are usernames, `column` the name of the column the block started in). Additive: `schema_version` stays `2`, and an importer that predates these keys ignores them. The `blocked` and `unblocked` activity entries ride in `activities` as usual. On import, the card's current block (`blocked_at`/`blocked_reason`) is restored whatever the `history` option, as card state like `archived_at`; the closed entries of `blocks` are restored only with `history` on, attributed to the importing user with the file's `blocked_by` kept in `imported_from_username`, keeping their times and resolution. An open entry in `blocks` is not restored as such: the card's own `blocked_at` decides whether it is blocked, so the card and its open block cannot disagree. An entry without a valid `blocked_at`, or that ends before it starts, is dropped. A reason is required, as on the [block endpoint](cards.md#block-and-unblock-since-13): a card with `blocked_at` but a missing or blank `blocked_reason`, or a `blocks` entry with a `blocked_at` but no reason, makes the import fail with `400` naming the card and entry, rather than importing a block with no reason; reasons and resolutions are trimmed. `blocks` is capped at 1000 entries per card and its text values at 500 characters; CSV export and import do not carry it.

Also since 1.2, each swimlane object carries `custom_field_values` (keyed by [swimlane custom field](#swimlane-custom-fields-since-12) name), and a top-level `swimlane_custom_fields` array carries that schema. These are separate keys from the card-level pair because they are independent per-board sets on different objects. Both are additive, and JSON import restores them. A definition with `is_admin_only: true`, and any value under it, is omitted for a caller below `admin`, the same gate this export applies to a swimlane's `contact_email` and `notes`.

Since 1.3 (#1101), each column object also carries its [policy](#column-policy-since-13) (`null` when it has none). Additive: `schema_version` stays `2`, and JSON import restores it after checking it like the column API does.

Since 1.3, each swimlane object also carries its [limits](#swimlane-limits-since-13): `wip_limit`, `weight_limit`, `limit_enforcement`, and `limit_columns`, the names of the columns that count (or `null` for the default, every column not marked done). Names, not ids, because the file keys columns by name and an import creates new ids. All four are additive (`schema_version` stays `2`), and JSON import restores them without enforcing them. A `limit_columns` name that is not one of the file's columns, an empty list, a limit below `1`, or a `limit_enforcement` other than `"block"`, `"hard"` or `null` is a `400`.

Since 1.3 (#2243), each swimlane object also carries its [lane health status](../features/health-status.md#lane-status), `health_status` (`"on_track"`, `"at_risk"`, `"off_track"` or `null` for no status), as the last key. Additive: `schema_version` stays `2`, an older file without the key imports as `null`, and any other value is a `400`.

```json
{
  "schema_version": 2,
  "name": "Sales Pipeline",
  "description": "",
  "columns": [{ "name": "Backlog", "position": 0, "color": "#64748B", "wip_limit": null, "weight_limit": null, "allow_card_creation": true }],
  "swimlanes": [
    {
      "name": "Acme Corp",
      "position": 0,
      "color": "#3B82F6",
      "contact_email": "",
      "notes": "",
      "custom_field_values": { "Account Tier": "Enterprise" },
      "wip_limit": 3,
      "weight_limit": null,
      "limit_enforcement": null,
      "limit_columns": null
    }
  ],
  "labels": [{ "name": "Bug", "color": "#EF4444" }],
  "custom_fields": [
    { "name": "Array Type", "field_type": "dropdown", "choices": ["raid6", "raid10"], "position": 0, "show_on_card": true, "is_required": false, "help_text": "", "number_prefix": "", "number_suffix": "", "number_decimals": null, "choice_colors": { "raid10": "green" } }
  ],
  "swimlane_custom_fields": [
    { "name": "Account Tier", "field_type": "dropdown", "choices": ["Startup", "Growth", "Enterprise"], "position": 0, "show_on_row": true, "is_admin_only": true, "is_required": false, "help_text": "", "number_prefix": "", "number_suffix": "", "number_decimals": null, "choice_colors": {} }
  ],
  "cards": [
    {
      "title": "Fix login bug",
      "description": "",
      "column": "Backlog",
      "swimlane": "Acme Corp",
      "priority": "high",
      "assignee": "alice",
      "labels": ["Bug"],
      "due_date": "2026-04-01",
      "weight": 2,
      "position": 0,
      "created_at": "2026-03-01T10:00:00Z",
      "created_by": "alice",
      "archived_at": null,
      "custom_field_values": { "Array Type": "raid10" },
      "external_ref": { "provider": "gitlab", "ref": "acme/webapp!45", "url": "https://gitlab.com/acme/webapp/-/merge_requests/45" },
      "comments": [{ "author": "bob", "body": "On it.", "created_at": "2026-03-02T09:00:00Z", "imported_from_username": null }],
      "checklist": [{ "text": "Write tests", "is_checked": false, "assignee": "bob", "due_date": "2026-04-02" }],
      "movements": [
        { "from_column": null, "to_column": "Backlog", "from_swimlane": null, "to_swimlane": "Acme Corp", "moved_by": "alice", "moved_at": "2026-03-01T10:00:00Z", "notes": "", "movement_type": "move", "imported_from_username": null }
      ],
      "activities": [
        { "event_type": "priority_change", "from_value": "medium", "to_value": "high", "actor": "alice", "created_at": "2026-03-01T11:00:00Z", "imported_from_username": null }
      ]
    }
  ]
}
```

### `GET /api/v1/boards/{id}/export-history/`
Return recent successful board exports for audit (#842). Requires board `admin` or `site_admin`; the owner always resolves to `admin`. A `member`, `collaborator`, or `viewer` gets `403 Forbidden` with body `{"detail": "Export history is restricted to board admins."}`. Failed exports (permission denied, rate limited) are not logged.

**Query parameters:** `offset` (default `0`) and `page_size` (default `50`, max `200`).

**Response** (paginated — the standard [envelope](index.md#pagination) with `count`, `offset`, `page_size`, `results`; ordered newest-first. There are no `next` / `previous` links.)

```json
{
  "count": 12,
  "offset": 0,
  "page_size": 50,
  "results": [
    {
      "id": 42,
      "actor": { "id": 1, "username": "alice", "display_name": "Alice", "avatar_url": "" },
      "actor_role_label": "member",
      "export_format": "csv",
      "row_count": 128,
      "created_at": "2026-04-22T14:31:02Z"
    }
  ]
}
```

| Field | Description |
|---|---|
| `actor` | The user who performed the export, or `null` if the user has since been deleted. |
| `actor_role_label` | Role the actor held at the moment of export. One of `"viewer"`, `"collaborator"`, `"member"`, `"admin"`, `"owner"`, `"site_admin"` — captured at write time, not recomputed on read. Distinct from `Board.export_min_role`, which only accepts the lower four values. |
| `export_format` | `"csv"` or `"json"` for board exports; `"movements_<format>"` (lowercased, at most 20 characters) for movement history exports. The web UI renders `movements_<format>` as `Movements (<FORMAT>)`. |
| `row_count` | Number of rows exported: cards for a board export, movements for a movement-history export (`movements_<format>`). |
| `created_at` | ISO 8601 timestamp. |

### `POST /api/v1/boards/import/`
Import a board from a Visiban JSON or CSV export file. Accepts `multipart/form-data` with a `file` field and optional `name` (board name override), `group_id` (place the board in a group), and `options` (choose what to import) fields. Creates a new board atomically.

**Permission:** authenticated user. When `group_id` is set, since 1.2 the caller must be an admin of that group or of one of its ancestor groups (or a site admin with all-content access), the same rule as `POST /api/v1/groups/{id}/boards/`. A group the caller can see but does not administer returns `403 Forbidden`; a group that does not exist or is not visible returns `404 Not Found`.

**Rate limit:** 10 imports/hour per authenticated user (scope: `board_import`). Exceeding the limit returns `429 Too Many Requests`.

**Import limits:** up to 500 cards, 50 columns, and 100 swimlanes per import. Payloads exceeding these limits return `400 Bad Request`.

A JSON import also caps its child collections (#1507). The caps sit well above a real board, but are hard limits: a file over any of them, including a board's own export, is refused with `400 Bad Request`.

| Collection | Limit |
|---|---|
| `labels` (board label definitions) | 1,000 |
| Label names on one card (`cards[].labels`) | 1,000 |
| `comments` per card | 1,000 |
| `checklist` items per card | 500 |
| `movements` per card | 2,000 |
| `activities` per card | 5,000 |
| Distinct usernames referenced (`assignee`, movement `moved_by`, activity `actor`) | 1,000 |
| Rows written by the whole import (see below) | 50,000 |

The whole-import limit caps every row the import inserts. It is counted from the file before anything is written, regardless of the import options, so no import writes more than 50,000 rows. It counts 3 for the board itself (the board, your membership, and its `board.created` event); one per column, swimlane, label, and custom field definition; one per swimlane custom field value; and, for each card, 1 for the card, 1 for its MR/PR link, one per custom field value, one per comment, movement, activity, and label name, two per checklist item (the item and its "checklist item added" entry), and 2 for the "label added" and "weight changed" entries the importer may add.

**Malformed values in a JSON file** return `400 Bad Request` naming the item and key, and nothing is created. Since 1.2 (#1507) this covers:

- Column and swimlane `position`, card `weight` and `position`, and column `wip_limit` and `weight_limit` must be integers from 0 to 2,147,483,647. Only `wip_limit` and `weight_limit` may be `null`.
- Column positions must be unique. A column with no `position` takes its index in the list, so an explicit position can collide with another column's default. Swimlane positions may repeat.
- Text values must not be `null`, a list, or an object, and must not contain NUL characters: column, swimlane, and label `color`; swimlane `contact_email` and `notes`; board and card `description`; comment `body`; checklist `text`; movement `notes`; activity `from_value` and `to_value`. A plain number or `true`/`false` is stored as its text (`5` → `"5"`, `true` → `"True"`), as in earlier releases, except for `color` on columns, swimlanes, and labels, which must be hex (since 1.3): a number or boolean there is replaced by the default and counted in `import_summary.skipped.colors`; `NaN` and `Infinity` are refused. A key left out takes its default.
- Text values stored in a limited column must fit it: column and swimlane `name` (255), label `name` (50), `color` (7), `contact_email` (254), card `title` (500), checklist `text` (500), movement `notes` (500), the column and swimlane names in a movement (255), the `name` form field (255), usernames in `assignee`, checklist item `assignee`, `moved_by`, and `actor` (150), and `imported_from_username` on movements, activities, and comments (150).
- Column `is_done` and `allow_card_creation`, and checklist `is_checked`, must be `true` or `false`.
- Since 1.3, a column `policy` must be `null` or follow the same rules as the [column API](#column-policy-since-13); it is stored normalized (criteria trimmed, an empty policy as `null`).
- Dates and timestamps (`due_date`, `archived_at`, and comment, movement, and activity timestamps) must be strings that name a real date or time; a number such as `20200101`, an impossible value such as `2024-02-30` or `T25:00:00`, or a time whose UTC equivalent falls outside years 1–9999 (such as `9999-12-31T23:59:59-12:00`) is rejected.
- A file that cannot be parsed, including one with an integer literal of more than 4,300 digits or nesting too deep to parse, returns `{"detail": "The uploaded file is not valid JSON."}`.

Error messages quote only a short, truncated part of any file value. A value that passes these checks but cannot be stored returns `400` with `{"detail": "The import file contains a value that cannot be stored."}`. Every exported file imports unchanged within the caps above; a board too large for them must be split before re-import.

**Request** (`multipart/form-data`)

| Field | Required | Description |
|---|---|---|
| `file` | ✓ | The JSON or CSV export file. Treated as JSON if its name ends in `.json` **or** its content type contains `json`; otherwise as CSV if its name ends in `.csv` or its content type contains `csv`; anything else is rejected. JSON is checked first, so a `.csv` file sent with a JSON content type is parsed as JSON. |
| `name` | | Board name to use, exactly as given — no prefix and no duplicate suffix. When omitted, the board is named by the rule in [Default board name](#default-board-name). |
| `group_id` | | Place the imported board into this group. Requires group admin. |
| `options` | | A JSON object, sent as a string, choosing what to import. Omit it to import everything. See [Import options](#import-options). |

#### Default board name

> **Changed in 1.2** (#1446) — earlier releases named a JSON import after the file's `name` verbatim and every CSV import `Imported Board`. API callers that relied on the old default should send `name` explicitly.

Without a `name` field, both formats name the new board `Imported: <name>`:

- **JSON** — `<name>` is the `name` field in the file. An unpaired UTF-16 surrogate in it (`"\ud800"`, which PostgreSQL cannot store) is replaced with U+FFFD in the default name.
- **CSV** — a CSV carries no board name, so `<name>` is the uploaded filename without its extension (`Q3 plan.csv` → `Imported: Q3 plan`). An empty filename stem falls back to `Board`.

If a board with that exact name exists, the lowest unused number is appended: `Imported: Roadmap - 1`, then `- 2`, and so on. A gap left by a deleted or renamed board is reused first. Only boards where the new board lands count: the target group's boards when `group_id` is set, otherwise every ungrouped board you can access (the boards under **My Boards** on the dashboard). The name is truncated to the 255-character limit so the prefix and number always fit. Names are not unique, so two simultaneous imports can occasionally get the same name.

#### Import options

> **Added in 1.2**

Board structure (name, columns, swimlanes) is always imported. Every option is an optional boolean that defaults to `true`:

| Key | Imports | Formats |
|---|---|---|
| `cards` | Cards. JSON: with their assignees, due dates, weights, and MR/PR links, plus the "weight changed" activity entry for a non-default weight when `history` is on. CSV: title, description, priority, weight, due date, and assignee (the `Assignee` username, matched case-insensitively; blank or unknown usernames import unassigned) — no MR/PR link. | JSON, CSV |
| `labels` | Label definitions, the labels on cards, and the "label added" activity entries the importer records for them | JSON, CSV |
| `comments` | Card comments. Requires `cards`. | JSON |
| `checklist` | Card checklist items, and the "checklist item added" activity entries the importer records for them. Requires `cards`. | JSON |
| `history` | Card movements, the card `activities` from the file, and the "weight changed" activity entry the importer records for a non-default weight. Requires `cards`. | JSON |

The importer writes its own "label added", "checklist item added" and "weight changed" entries only for history the file does not already record. With `history` on, a card whose `activities` already contain that event type keeps the file's entries (original timestamp and source name, recorded under the importing user) and gets no synthetic copy, so re-importing an export does not double its history.

Three more options are not include flags. They move the file's dates (see [Date shifting](#date-shifting)):

| Key | Type | Effect |
|---|---|---|
| `shift_dates_from` | `YYYY-MM-DD` string, JSON only, optional | The day to move dates *from*. Moves every date in the file by the whole days between this date and the target day (`shift_dates_to`, default today): card due dates, checklist item due dates (since 1.3, #445), `date` custom field values on cards and swimlanes, the timestamps on cards (including a blocked card's `blocked_at`), comments, movements, activities and, since 1.3 (#1149), block history entries (`blocks[].blocked_at` / `unblocked_at`, so block durations are unchanged), and the old and new values of due-date-change history entries (card and checklist item). Spacing between dates is preserved. When absent, a file's own top-level `date_anchor` is used in its place; a file without one is not shifted. Must not be in the future or more than 10 years ago. Used by the sample gallery with a sample's `date_anchor`. When given, it is echoed in `import_summary.options_applied` and the `board.created` event's `import_options`. |
| `shift_dates` | boolean, JSON only, optional, default `true` | `false` turns all shifting off: the file's dates are imported exactly as written, its `date_anchor` is not read, and `shift_dates_to` is ignored. Sending it with `shift_dates_from` is a contradiction and is rejected. Added in 1.2 (#1949). Echoed in `options_applied` when sent. |
| `shift_dates_to` | `YYYY-MM-DD` string, JSON only, optional, default today (UTC) | The day to move dates *to*: the shifted board is dated around this day instead of today. Used only when dates shift (an explicit `shift_dates_from` or the file's `date_anchor`); otherwise ignored. It may be earlier than the source date, which moves dates back. Must not be in the future (UTC) or more than 10 years ago, so imported history never lands after the moment of import. Added in 1.2 (#1949). Echoed in `options_applied` and `import_options` when sent and applied. |

A CSV import rejects all three as unknown options: dates in a CSV are always imported as written.

#### Date shifting

> **Added in 1.2** (#1452; the file's own anchor, `shift_dates` and `shift_dates_to` since #1949)

The shipped [sample boards](../getting-started/sample-boards.md) are generated around a fixed day, so imported as written most cards would be overdue. Each sample file carries that day as a top-level `"date_anchor": "YYYY-MM-DD"` key. The importer resolves the shift like this:

1. `shift_dates` is `false`: nothing moves.
2. Otherwise the source day is `shift_dates_from` when sent. An explicit option always wins over the file.
3. Otherwise it is the file's `date_anchor`, when the file has one.
4. With no source day, nothing moves. A file without `date_anchor`, which includes every board export, imports exactly as in earlier releases.

Dates then move by the whole days from the source day to `shift_dates_to`, or to today's UTC date when it is not sent. The importer, not the web client, reads the anchor, so the import dialog, a `curl` upload, and any API client get the same board from the same file. When the file's anchor was used, `options_applied.shift_dates_from` reports it.

Only a string counts as an anchor: a `date_anchor` that is `null`, a number, a list, or an object is ignored, and the file imports unshifted. A string `date_anchor` the importer would use is validated like `shift_dates_from`. One that is not a real `YYYY-MM-DD` date, or is out of range, returns `400 Bad Request`, for example `The file's 'date_anchor' is invalid: date_anchor cannot be in the future. Send the import option shift_dates as false to import its dates as written.` With `shift_dates: false`, or an explicit `shift_dates_from`, the key is not read.

```bash
# A downloaded sample, dated around today (no options needed)
curl -X POST https://visiban.example.com/api/v1/boards/import/ \
  -H "Authorization: Token $TOKEN" -F file=@sales_overlay.json

# The same file dated around 1 June 2026, or with its dates as written
curl ... -F file=@sales_overlay.json -F 'options={"shift_dates_to": "2026-06-01"}'
curl ... -F file=@sales_overlay.json -F 'options={"shift_dates": false}'
```

An omitted `comments`, `checklist`, or `history` follows `cards`, so `{"cards": false}` alone imports structure and labels only. An explicit contradiction such as `{"cards": false, "comments": true}` is rejected.

An invalid `options` field returns `400 Bad Request` before anything is created, with one of these `detail` messages:

| `detail` | When |
|---|---|
| `'options' is not valid JSON.` | The field does not parse as JSON. |
| `'options' must be a JSON object.` | It parses, but not to an object (for example `[]` or `true`). |
| `Invalid 'options': Unknown import option(s): x.` | A key other than the five above, `shift_dates_from`, `shift_dates`, and `shift_dates_to` — or, for a CSV file, other than `labels` and `cards`. |
| `Invalid 'options': 'shift_dates_from': shift_dates_from cannot be in the future.` | The date is after today (UTC). |
| `Invalid 'options': 'shift_dates_from': shift_dates_from cannot be more than 10 years ago.` | The date is more than 10 years back. |
| `Invalid 'options': 'shift_dates_from': Date has wrong format. Use one of these formats instead: YYYY-MM-DD.` | The value is not a `YYYY-MM-DD` string (`null` reads `This field may not be null.`). |
| `Invalid 'options': 'shift_dates_to': shift_dates_to cannot be in the future.` | The target day is after today (UTC). The same three messages as for `shift_dates_from` apply, naming `shift_dates_to`. |
| `Invalid 'options': Import option shift_dates_from requires 'shift_dates'.` | `shift_dates_from` was sent with `shift_dates: false`. |
| `Invalid 'options': Import option(s) comments require 'cards'.` | A dependent is explicitly `true` while `cards` is `false`. |
| `Invalid 'options': 'labels': Must be a valid boolean.` | A value is not a JSON boolean (the key named is the offending one; `null` reads `'labels': This field may not be null.`). |

```bash
curl -X POST https://visiban.example.com/api/v1/boards/import/ \
  -H "Authorization: Token $TOKEN" \
  -F file=@board.json \
  -F 'options={"labels": false, "history": false}'
```

#### Custom fields on import

> **Added in 1.2**

A JSON file's `custom_fields` and `swimlane_custom_fields` definitions are restored with the board's structure, in list order, whatever the `options`. Each is validated as the [custom field](#custom-fields-since-12) and [swimlane custom field](#swimlane-custom-fields-since-12) APIs validate a new definition, and the per-board limits apply to the whole list: at most 30 card fields (2 shown on the card) and 15 swimlane fields (8 shown on the row), with unique names. A failing definition returns `400 Bad Request` and creates nothing, for example
`'custom_fields' entry at index 1: 'choices': …` or `Duplicate swimlane_custom_fields names: Owner`.

Values (`custom_field_values` on each card and swimlane, keyed by field name) go through the same normalizer as `PATCH`. A value naming no imported field, or one its field's type refuses, is dropped and the import proceeds. Card values follow the `cards` option; swimlane values are structure and always import. Values exported by Visiban are already in stored form and round-trip unchanged.

#### Custom fields in a CSV import

> **Added in 1.2**

A CSV import reads the `Custom: <name>` and `Swimlane Custom: <name>` columns the CSV
export writes, so card and swimlane field values survive a CSV round trip.

- **Every field becomes a `text` field.** A CSV carries no field type, so nothing is
  inferred: a number, date, dropdown or checkbox column imports as text, and dropdown
  choices, number formatting and pin settings are not restored. **JSON is the lossless
  format** for field definitions; use it when types matter. A multi-select cell such as
  `UI; DB` is stored as that plain text, not parsed into entries.
- **Cells are stored exactly as exported.** The export removes leading formula characters
  (`=`, `+`, `-`, `@`, tab, carriage return) from text values so a spreadsheet cannot run
  them, and that removal is irreversible: a text value `=1+1` is exported, and re-imported,
  as `1+1`. The importer does not un-escape and does not sanitize. (Number and checkbox
  values are written as stored, so a number such as `-5` keeps its sign.)
- **Definitions** are created in header order, subject to the same limits as a JSON file:
  at most 30 card fields and 15 swimlane fields, unique names, validated as the field APIs
  validate them. A violation returns `400 Bad Request` and creates nothing, as does the
  same custom header appearing twice (`Duplicate custom field CSV headers: Custom: Region`).
  A card field and a swimlane field may share a name. A header with an empty name
  (`Custom: `) is skipped with a warning.
- **Swimlane values** are repeated on every card row of the lane in the export, so the
  importer takes the first non-empty cell per lane and field; a later, different value is
  ignored and reported once as a warning. Swimlane values import whatever the `cards`
  option says; card values follow it.
- **Blank cells** create no value. A value longer than 500 characters, one containing a NUL
  (`\x00`) byte, or one an extension validator refuses, is dropped with a warning and the import proceeds.

<a id="csv-cell-limits"></a>

**Cell limits (since 1.2, #1512).** The importer checks every row before creating anything. A violation returns `400 Bad Request` as `Row N: <field> ...` and creates nothing. N counts data rows from 2 (the first data row is row 2), so it can differ from the physical line number when a quoted cell spans several lines. Echoed values are truncated. Only cells the import writes are checked: with `cards` set to `false` the `Title`, `Description`, `Assignee` and `Weight` cells are skipped, and with `labels` set to `false` so is `Labels`. Ignored columns (`Priority`, `Card ID`, unknown headers and so on) are never checked.

| Field | Limit |
|---|---|
| `Title` | At most 500 characters |
| `Column`, `Swimlane` | At most 255 characters |
| `Labels` | Each comma-separated label at most 50 characters |
| `Weight` | An integer from -2147483648 to 2147483647 (a non-numeric value still imports as `1`) |
| `Due Date` | A real calendar date; `2020-02-30` is refused like any other invalid date |
| `Title`, `Description`, `Assignee`, `Column`, `Swimlane`, `Labels` | No NUL (`\x00`) bytes (`Custom:` cells keep the drop-with-warning rule above) |
| `name` form field | At most 255 characters and no NUL bytes, as for a JSON import |

The response gains `import_summary.warnings`, a list of strings (always present on a CSV
import, `[]` when nothing was dropped). It holds at most 20 entries followed by one
`…and N more` entry. A JSON import does not return the key.

```json
"import_summary": {
  "options_applied": { "...": "..." },
  "skipped": { "...": "..." },
  "warnings": ["Swimlane 'East' field 'Owner' has conflicting values; kept 'Avery'."]
}
```

**Response** `201 Created`

Returns the new board in the shape of `GET /api/v1/boards/{id}/`, plus an `import_summary` object (the `BoardImportResponse` component in the OpenAPI document).

```json
{
  "id": 512,
  "uid": "bd_1a2b3c4d5e6f7890",
  "name": "Imported: Roadmap",
  "owner": { "id": 7, "username": "alice", "display_name": "Alice" },
  "group": null,
  "created_at": "2026-04-21T14:02:11Z",
  "updated_at": "2026-04-21T14:02:11Z",
  "import_summary": {
    "options_applied": { "labels": false, "cards": true, "comments": true, "checklist": true, "history": false },
    "skipped": {
      "cards": 0,
      "comments": 0,
      "checklist_items": 0,
      "label_refs": 4,
      "movements": 12,
      "activities": 30,
      "colors": 0
    }
  }
}
```

#### Import summary

> **Added in 1.2**

| Field | Description |
|---|---|
| `import_summary.options_applied` | All five options as resolved, including dependents that followed `cards`, plus `shift_dates_from` (a `YYYY-MM-DD` string) when it was sent or the file's `date_anchor` was used in its place, `shift_dates` when it was sent, and `shift_dates_to` when it was sent and dates moved. A CSV import reports `comments`, `checklist`, and `history` equal to `cards`. |
| `import_summary.skipped.*` | How many items in the file the chosen options left out: `cards`, `comments`, `checklist_items`, `label_refs` (label references on cards), `movements`, and `activities`. `colors` (since 1.3) is different: it counts column, swimlane, and label colors that were not hex and were replaced by the default (see [Color values](#color-values)). Items the importer drops regardless of options — a label name with no definition, an activity with an unknown event type — are not counted. All are `0` when no options are sent, except `colors`, which counts replacements whatever the options. |

The `board.created` event for the new board carries the resolved options as an additional `import_options` field.

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "..."}` | File is missing, empty, has an unsupported extension, exceeds the upload size limit (`MAX_UPLOAD_SIZE_BYTES`, default 10 MB — the same env var and default as [card attachment uploads](cards.md#attachments), and distinct from the Trello importer's own `IMPORT_MAX_SIZE_BYTES`), is not valid JSON/CSV, or references columns/swimlanes that fail validation. Also returned when `options` is not valid JSON, is not an object, has an unknown key, has a non-boolean value, sets `comments`, `checklist`, or `history` to `true` with `cards` set to `false`, or — for a CSV file — has any key other than `labels` and `cards`. A CSV file also returns `400` for a cell over the [CSV cell limits](#csv-cell-limits), a NUL byte, or an impossible `Due Date`. |
| `401 Unauthorized` | `{"detail": "Authentication credentials were not provided."}` | Caller is not authenticated. |
| `403 Forbidden` | `{"detail": "..."}` | `group_id` was supplied for a group the caller can see but is not an admin of. Since 1.2; before 1.2 a caller who was not a member of the group received `403`, and any member could import. |
| `404 Not Found` | `{"detail": "..."}` | `group_id` does not match a group that exists and is visible to the caller. *(1.2+)* Also returned, with nothing created, when the group is deleted while the import runs; a group delete that arrives while an import into it is in flight waits for it and then detaches the new board from the group (#1719). |
| `429 Too Many Requests` | `{"detail": "..."}` | The `board_import` rate limit was exceeded. |

### `POST /api/v1/boards/import/trello/`

> **Added in 1.2** (#456)

Import a Trello JSON export (Trello: **Menu → Print, export, and share → Export as JSON**) into a new board. The flow is stateless and has two steps: call with `?dry_run=true` for a preview of exactly what will be created, then re-upload the same file with `?confirm=true` to create the board. Both modes run the same parsing and mapping code, so the preview is what the import does.

The import is **synchronous**: the board exists when the `201` returns, bounded by the upload size cap, the count caps below, and the rate limits. Imported content sends no notifications (no @mention, assignment, or card-moved) and records no movement history for imported cards.

**Permission:** authenticated user. When `group_id` is set, the caller must be an admin of that group or of one of its ancestor groups (or a site admin with all-content access) in **both** modes, so a preview cannot be used to probe a group the caller could not import into. The caller becomes the board's owner and admin.

**Query parameters** — specify exactly one:

| Parameter | Description |
|---|---|
| `dry_run=true` | Parse and plan only. Returns `200 OK` with the preview. Creates nothing. |
| `confirm=true` | Create the board. Returns `201 Created`. |

Sending neither, or both, returns `400 Bad Request` (`"Specify exactly one of ?dry_run=true or ?confirm=true."`).

**Request** (`multipart/form-data`)

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | yes | The Trello JSON export. Maximum size is `IMPORT_MAX_SIZE_BYTES` (default 25 MB). |
| `name` | string | no | Board name. Defaults to the Trello board's name. Maximum 255 characters. Only used on `confirm`. |
| `group_id` | integer | no | Place the imported board into this group. Requires group admin. Also widens the pool used for [member matching](#member-matching). |
| `mapping` | string (JSON) | no | JSON-encoded object of mapping options, described below. Omitted or blank means all defaults. Send the same `mapping` on `dry_run` and `confirm`. |
| `file_sha256` | string | no | On `confirm`, the `file_sha256` returned by the preview. If present and it does not match the uploaded file, the request is rejected with `400`, so a different file cannot be swapped in between preview and confirm. |

**`mapping` options** — unknown keys return `400`.

An export, or a `mapping`, that contains an unpaired UTF-16 surrogate (`"\ud800"`, valid JSON that PostgreSQL cannot store) returns `400` naming the surrogate's code point.

| Key | Type | Default | Description |
|---|---|---|---|
| `swimlane_label_ids` | string[] | `[]` | Trello label ids (from `mapping.labels[].trello_id` in the preview) to turn into swimlanes, in the order given. Only named labels are eligible (`swimlane_eligible: true`). |
| `default_swimlane_name` | string | `"Unassigned"` | Name of the swimlane for cards that have no mapped label. Must be non-empty and must not equal the name of a label mapped to a swimlane. |
| `include_archived_lists` | boolean | `false` | Import archived (closed) lists as columns, and their cards as archived cards. |
| `add_matched_members` | boolean | `false` | Add [matched members](#member-matching) to the board and assign them to their cards. |

**Mapping rules**

- **Lists to columns**, ordered by Trello position and renumbered densely from 0. Archived lists are skipped unless `include_archived_lists` is `true`; their cards are then imported as archived cards. Without that option, cards in archived lists are skipped. Cards that reference a list missing from the export are skipped.
- **Labels** keep their names. Trello color names are converted to hex (`#RRGGBB`); an unnamed label is named after its color. A duplicate name gets a `" (2)"` suffix (then `(3)`, and so on).
- **Labels to swimlanes** for the labels listed in `swimlane_label_ids`. A card goes to the swimlane of the first mapped label in **the card's own label order**; any other mapped labels stay as ordinary labels. Cards with no mapped label go to the default swimlane.
- **Checklists** are flattened into one checklist per card. When a card has several checklists, each item's text is prefixed with its checklist name. Since 1.3 (#2197) a checklist item keeps its Trello due date (`due`, converted to a UTC date like a card's; an unreadable one is left empty and counted in `invalid_due_dates`) and its member (`idMember`), matched like card members below.
- **Comments** are imported with their original timestamps.
- **Archived cards** (closed in Trello) are imported archived.
- **Attachments** are not copied. Each attachment is appended to the card description as a link, and only `http` and `https` URLs are kept. Uploaded files are reported under `unmappable` as `attachment_files`.
- **Due dates** are converted to a UTC date.

#### Member matching

A Trello member matches a Visiban user when the Trello **username** equals the Visiban username exactly, ignoring case. Display and full names are never used.

Matching considers only users the caller can already see: co-members of the caller's boards and groups, and members and owner of the target group. Site admins can match any active user. This stops a crafted file from probing whether a username exists. The response reports only a **count** of matches, never which accounts.

- `add_matched_members: false` (default): matched users are not added to the board and cards are left unassigned.
- `add_matched_members: true`: matched users are added to the board with the `member` role and assigned to their cards (the first matched Trello member on each card) and, since 1.3, to their checklist items. Adding members or assigning items sends no notification.
- A checklist item whose member did not match, or any checklist item when `add_matched_members` is `false`, imports unassigned (#2197).

Since 1.2 (#1702), with either setting, every comment is authored by the importer and keeps its Trello time. The Trello author's display name is kept as text in the comment's `imported_from_username` (at most 150 characters, line breaks collapsed), never matched to an account, and the body starts with the plain-text line `(imported from Trello)`. Earlier versions authored a matched member's comments as that member when `add_matched_members` was `true`, and put the author's name in the body (`Full Name (imported from Trello):`) otherwise; comments imported then are unchanged.

Unmatched members are listed in the preview by their Trello name (from the uploader's own file).

**Import limits.** Exports over any of these caps return `400 Bad Request`:

| Item | Cap |
|---|---|
| Lists | 50 |
| Cards | 5,000 |
| Labels | 200 |
| Checklist items | 20,000 |
| Comments | 20,000 |
| Members | 1,000 |
| Actions (Trello activity entries, including comments) | 50,000 |
| Attachments (all cards) | 20,000 |
| Label or member references on one card | 500 |
| JSON objects and arrays in the file | 1,000,000 |

**Rate limits**

| Mode | Scope | Limit |
|---|---|---|
| `dry_run=true` | `board_import_preview` | 60/hour per authenticated user |
| `confirm=true` | `board_import` | 10/hour per authenticated user, **shared** with [`POST /api/v1/boards/import/`](#post-apiv1boardsimport) |

Exceeding either limit returns `429 Too Many Requests`. Previews are throttled separately, so re-previewing while you adjust the mapping does not use up the import budget.

**Response** `200 OK` (`dry_run=true`) — the preview:

```json
{
  "source": "trello",
  "file_sha256": "9f2b6c1d0a7e4f38b5c9d2e1a4f7083c6b5d9e2f1a0c8b7d6e5f4a3b2c1d0e9f",
  "board": { "name": "Website Relaunch", "description": "Q4 marketing site rebuild" },
  "counts": {
    "lists": 5,
    "lists_archived": 1,
    "cards": 42,
    "cards_archived": 6,
    "labels": 8,
    "checklists": 7,
    "checklist_items": 31,
    "comments": 58,
    "attachments": 9,
    "members": 4
  },
  "result": {
    "columns": 4,
    "swimlanes": 3,
    "labels": 8,
    "cards": 37,
    "cards_archived": 2,
    "checklist_items": 28,
    "comments": 52
  },
  "mapping": {
    "columns": [
      { "trello_id": "64f1a2b3c4d5e6f708192a3b", "name": "Backlog", "position": 0, "card_count": 12, "archived": false },
      { "trello_id": "64f1a2b3c4d5e6f708192a3c", "name": "Old ideas", "position": null, "card_count": 5, "archived": true }
    ],
    "labels": [
      {
        "trello_id": "64f1a2b3c4d5e6f708192a40",
        "name": "Design",
        "color": "#9F8FEF",
        "original_color": "purple",
        "card_count": 14,
        "swimlane_eligible": true
      }
    ],
    "swimlanes": [
      { "name": "Design", "label_id": "64f1a2b3c4d5e6f708192a40" },
      { "name": "Unassigned", "label_id": null }
    ],
    "default_swimlane": "Unassigned"
  },
  "members": {
    "total": 4,
    "matched": 2,
    "unmatched": [
      { "trello_id": "5a1b2c3d4e5f6a7b8c9d0e1f", "full_name": "Priya Nair" },
      { "trello_id": "5a1b2c3d4e5f6a7b8c9d0e20", "full_name": "Tom Becker" }
    ]
  },
  "options": {
    "swimlane_label_ids": ["64f1a2b3c4d5e6f708192a40"],
    "default_swimlane_name": "Unassigned",
    "include_archived_lists": false,
    "add_matched_members": false
  },
  "warnings": [
    {
      "code": "archived_lists_skipped",
      "message": "Archived lists and their cards will be skipped. Turn on “Include archived lists” to import them.",
      "count": 1
    },
    {
      "code": "matched_members_not_added",
      "message": "Matched members will not be added to the board and assignees are left empty.",
      "count": 2
    }
  ],
  "unmappable": [
    { "kind": "attachment_files", "count": 9 },
    { "kind": "power_up_data", "count": 3 }
  ]
}
```

In `mapping.columns`, `position` is `null` for a list that will not be imported (an archived list while `include_archived_lists` is `false`). `mapping.columns[].name` and `mapping.labels[].name` are the final names after de-duplication.

`counts` describes the Trello file; `result` describes what will be created.

**`warnings`** — each entry is `{code, message, count}` and is only present when `count` is greater than zero. Codes:

| Code | Meaning |
|---|---|
| `archived_lists_skipped` | Archived lists (and their cards) will be skipped; `include_archived_lists` is `false`. |
| `cards_in_archived_lists_skipped` | Cards in archived lists will be skipped. |
| `cards_missing_list` | Cards referencing a list that is not in the export will be skipped. |
| `multiple_swimlane_labels` | Cards with more than one swimlane label go to the swimlane of their first such label. |
| `checklists_flattened` | Cards with several named checklists get one combined checklist with prefixed item text. |
| `invalid_due_dates` | Due dates that could not be read will be left empty. |
| `descriptions_truncated` | Card descriptions longer than 50,000 characters (including the appended attachment links) will be shortened to 50,000. |
| `comments_truncated` | Comments longer than 10,000 characters (including the `(imported from Trello)` line) will be shortened to 10,000. |
| `unknown_labels` | Label references missing from the export will be ignored. |
| `comments_may_be_incomplete` | The export hit Trello's 1,000-action limit, so older comments may be missing. |
| `matched_members_not_added` | Members matched but `add_matched_members` is `false`. Only present when `false`. |
| `unmatched_members` | Members with no matching Visiban user are not assigned to cards or checklist items. |

**`unmappable`** — Trello data that has no Visiban equivalent and is dropped. Each entry is `{kind, count}`, present only when the count is greater than zero. Kinds:

| Kind | Meaning |
|---|---|
| `attachment_files` | Attachments (only a link is preserved in the card description; file contents are not copied). |
| `custom_fields` | Trello custom field definitions and per-card values. |
| `power_up_data` | Power-Up data on the board or on cards. |
| `start_dates` | Card start dates. |
| `stickers` | Card stickers. |

**Response** `201 Created` (`confirm=true`)

Unlike [`POST /api/v1/boards/import/`](#post-apiv1boardsimport), which returns the board at the top level (plus `import_summary`), this endpoint wraps the board with a summary. `board` has the shape of `GET /api/v1/boards/{id}/`; `summary` repeats the preview's `counts`, `result`, `warnings`, and `unmappable`. The OpenAPI document names these `TrelloImportPreview` (the `dry_run=true` 200) and `TrelloImportConfirm` (this 201). The two envelopes differ today; aligning them additively, and adding an error `code`, is tracked in #1903. Error bodies on both carry `detail` only, with no `code`.

```json
{
  "board": {
    "id": 513,
    "uid": "bd_7c1e9a4b2d6f8035",
    "name": "Website Relaunch",
    "owner": { "id": 7, "username": "alice", "display_name": "Alice" },
    "group": null,
    "created_at": "2026-09-26T14:02:11Z",
    "updated_at": "2026-09-26T14:02:11Z"
  },
  "summary": {
    "counts": {
      "lists": 5, "lists_archived": 1, "cards": 42, "cards_archived": 6, "labels": 8,
      "checklists": 7, "checklist_items": 31, "comments": 58, "attachments": 9, "members": 4
    },
    "result": {
      "columns": 4, "swimlanes": 3, "labels": 8, "cards": 37,
      "cards_archived": 2, "checklist_items": 28, "comments": 52
    },
    "warnings": [
      {
        "code": "archived_lists_skipped",
        "message": "Archived lists and their cards will be skipped. Turn on “Include archived lists” to import them.",
        "count": 1
      }
    ],
    "unmappable": [
      { "kind": "attachment_files", "count": 9 }
    ]
  }
}
```

Creating the board broadcasts `board.created` on the same channels as the native import.

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "..."}` | Neither or both of `dry_run` / `confirm` given; `file` missing; the file is not valid UTF-8 JSON or is nested too deeply; it is not a Trello export (`lists` and `cards` are required); a schema or type error (the message names the offending field); an [import cap](#post-apiv1boardsimporttrello) is exceeded; `mapping` is not a JSON object, has an unknown key, has a wrong type, lists a label that is not a named label in the export, or uses a `default_swimlane_name` that collides with a mapped label; on `confirm`, `file_sha256` does not match the uploaded file; on `confirm`, there are no lists to import (for example, every list is archived and `include_archived_lists` is `false`). |
| `401 Unauthorized` | `{"detail": "Authentication credentials were not provided."}` | Caller is not authenticated. |
| `403 Forbidden` | `{"detail": "..."}` | `group_id` was supplied for a group the caller can see but is not an admin of (since 1.2; before 1.2 a caller who was not a member of the group received `403`, and any member could import); or the account has a pending password or username change. |
| `404 Not Found` | `{"detail": "..."}` | `group_id` does not match a group that exists and is visible to the caller. *(1.2+)* Also returned, with nothing created, when the group is deleted while the import runs; a group delete that arrives while an import into it is in flight waits for it and then detaches the new board from the group (#1719). |
| `413 Content Too Large` | `{"detail": "File too large. The maximum size for a Trello import is 25 MB."}` | The file is larger than `IMPORT_MAX_SIZE_BYTES`. Note that the native import endpoint returns `400` for an oversized file. |
| `429 Too Many Requests` | `{"detail": "Request was throttled. ..."}` | Rate limit exceeded; see **Rate limits** above. |

---

## Members

### `POST /api/v1/boards/{id}/members/`
Add or update a board member. Requires board admin: a caller with no access gets `404`, a member below admin gets `403`. Cannot modify a site admin's existing board membership (the same restriction as `DELETE` below); a site admin with no membership on the board is added like any other active user.

For a caller who is not a site admin, the response (and the `member.added` / `member.updated` event) omits `is_site_admin` for every target. When the target is a site admin with no direct membership, the stored role is the higher of the requested role and the role the user already holds through a group, so the new membership never lowers it (any other user's new direct membership keeps its ordinary precedence over a group-inherited role). `is_site_admin` is therefore optional here (not in the OpenAPI `required` list): a site-admin caller gets it, others do not.

*(1.3+, #1828)* A request that would give the board owner a stored role below `admin` returns `400 Bad Request` and writes nothing, for every caller including site admins:

```json
{"detail": "The board owner's membership cannot be removed or demoted. The owner keeps admin access to the board while they own it.", "code": "board_owner_protected"}
```

Branch on `code`, not on `detail`, which may be reworded. That covers naming a lower `role` for the owner, and adding an owner who has no membership row without `role` (a new row defaults to `member`). Setting the owner to `admin` is accepted, and so is a request that names no `role` for an owner who already has a row (it keeps the stored role, so it is not a demotion). Before 1.3 these requests succeeded, but changed nothing the owner could do: the owner holds `admin` through board ownership whatever the row says. The other `400`s from this endpoint carry `detail` only.

Since 1.2, a request body that is not a JSON object returns `400 Bad Request` (it returned `500` before). Since 1.2 a `user_id` that is present but not an integer, or is beyond the 64-bit integer range, is a `400` too: a non-integer value used to answer `404` and an out-of-range one `500`. An omitted `user_id` still answers `404`.

**Request** `{ "user_id": 42, "role": "member", "is_moderator": true }`

| Field | Required | Description |
|---|---|---|
| `user_id` | ✓ | ID of the user to add or update. A new membership needs an active user: an id that matches no user and an id that matches an inactive user both return the same `404 Not Found`. A user who already has a membership can have the role updated whatever their status |
| `role` | | Role to assign. When omitted, a new membership gets `"member"` and an existing membership keeps its current role (before 1.2 an omitted `role` reset an existing member to `"member"`). A request that only sets `is_moderator: true` on a collaborator or viewer, with no `role`, returns `400 Bad Request`, the same as sending that role explicitly. Valid: `admin`, `member`, `collaborator`, `viewer`. Any other value, or a non-string, returns `400 Bad Request` with `{"detail": "Role must be one of: ..."}` |
| `is_moderator` | | Boolean. Grants content-moderation rights (delete/archive others' content). Only valid for `member` and `admin` roles — setting `true` on a collaborator or viewer returns `400 Bad Request`. Automatically cleared when demoting to collaborator or viewer. Also cleared when a collaborator or viewer is promoted to member or admin without an explicit `is_moderator` in the request (an explicit value wins; role edits made in the Django admin do not clear it). |

**Visibility of `is_moderator` in board responses (since 1.1; self-row exception since 1.2):** the `is_moderator` field is included in the `members` array of `GET /api/v1/boards/{id}/full/` for `admin` and `site_admin` requesters, on every row. A lower-role requester (`member`, `collaborator`, `viewer`) receives the field only on the row belonging to themselves — so a member promoted to moderator can see their own entitlement — and every other row omits it. This endpoint's own response always carries the field, since it requires board admin. The `member.added` / `member.updated` WebSocket broadcast and the [change feed](events.md) apply the identical self-row rule per recipient (#1191): the subscriber's/reader's own row always carries the field, every other non-admin-visible row omits it.

**Member row `role` and assignability (since 1.3, #1905):** in the `members` array of `GET /api/v1/boards/{id}/full/`, the board owner's row has `role: "admin"`, the role the board grants them, even when they hold an explicit membership with a lower stored role; that row keeps its membership `id`. *(1.3+, #1828)* The members endpoints refuse to remove or demote the owner's membership (see below), so such a row can only be raised back to `admin`. Before 1.3 such a row showed the stored role. A row whose stored role is not one of `admin`, `member`, `collaborator` or `viewer` is listed as stored, so an admin can find and remove it; it grants no access, and the server refuses that user as a card assignee. A client building an assignee picker should offer only rows with `role` `admin`, `member`, `collaborator` or `site_admin`, plus any row with `has_all_content_access: true`; the Visiban web app does this in every assignee picker since 1.3. What the server enforces is unchanged.

**`has_all_content_access` on member rows (since 1.3, #1301):** for a board `admin` or `site_admin` requester (board role `site_admin`, or an instance site admin on any board role), each row in the `members` array of `GET /api/v1/boards/{id}/full/` carries a boolean `has_all_content_access`: `true` when the member has `can_access_all_content`, which always resolves to full access ahead of any explicit membership. A row can therefore carry a stored `role` such as `viewer` while the member still has full access; use this field, not `role`, to tell. It is present on every row the requester receives (direct, group-inherited and owner rows), and rows with `role: "site_admin"` are always `true`. Requesters below `admin` omit the key. It does not widen who is listed: the all-content users with no role on the board still appear only for a site-admin requester (#1714). It is never added to the nested `user` object.

**`is_site_admin` on member rows (since 1.2):** each row in the `members` array of `GET /api/v1/boards/{id}/full/` carries a boolean `is_site_admin`; the response of this endpoint and the `member.added` / `member.updated` events this endpoint produces (WebSocket broadcast and [change feed](events.md)) carry it only when the caller who made the change is a site admin (the payload is built once, so subscribers of any role do not receive it otherwise; a client re-reads the board to get the flag). A `member.added` event from invite redemption keeps its documented payload, which subscribers receive according to their role — the member's instance-level site-admin flag, the same flag this endpoint and `DELETE` below check. Use it, not `role`, to decide whether a row can be edited: `role: "site_admin"` means the member has `can_access_all_content`, which is a separate flag. The field is present only for `admin` and `site_admin` requesters, subscribers and readers, and there is no self-row exception (read your own flag from `/api/v1/auth/me/`). On `/full/`, a board admin who is not a site admin receives it only on rows backed by a membership on this board (`id` not `null`), which are the only rows this endpoint refuses to change for them; group-inherited and owner rows omit it for that requester (since 1.2, #1714). A site-admin requester (board role `site_admin`, or an instance site admin) receives it on every row. It is never added to the nested `user` object.

### `DELETE /api/v1/boards/{id}/members/{user_id}/`
Remove a member. Requires board admin. Cannot remove a site admin who is a member of the board. Returns `204` when the membership is removed. *(1.3+, #1828)* Removing the board owner's membership returns `400 Bad Request` with the same `{detail, code}` body as `POST` above (`code` `board_owner_protected`) and writes nothing, for every caller including the owner and site admins; before 1.3 it answered `204` but the owner kept admin access through board ownership and only disappeared from the roster. The owner leaves a board by deleting it. If the user has no membership on the board, the response is the same `404 Not Found` (status and body) whether the id is unknown, belongs to an inactive user, or belongs to an active user who is not a member; an inactive user who has a membership can be removed.

---

## Board invites

> **Added in 1.2**

A board admin can email a **single-use invite** to someone who may not have an account yet, or create a **shareable invite link** to paste anywhere. The invite token (`vbnb_` prefix) travels only in the email, or — for a shareable link — in the create response, once; it is never returned again. Only its first 8 characters (`prefix`) are shown. The address it was sent to is not stored. *(1.2+, #1678)* An emailed invite stores a keyed fingerprint of that address instead, and redeeming it requires an account with that address (see `POST /api/v1/boards/join/{token}/` below). The fingerprint is never returned by any endpoint or event. Shareable links have no fingerprint. Invites grant `member`, `collaborator` or `viewer` — never `admin`, and never the moderator flag. A board invite never adds anyone to the board's group.

### `GET /api/v1/boards/{id}/invite-links/`
List the board's invites, newest first, as a bare array (not paginated). Requires board admin (an admin of the board, the owner, an admin of the board's group, or a site admin with all-content access). Returns **every pending invite plus at most the 50 most recent past ones** (used, expired or revoked); older history is not returned. A caller with no access to the board, or for a board that does not exist, gets `404`, an unauthenticated request `401` — the same as the members endpoints.

| Field | Description |
|---|---|
| `id`, `prefix`, `name` | Identity. `name` is empty for emailed invites, and optional for shareable links. |
| `role` | `member`, `collaborator` or `viewer`. |
| `delivery` | `email` for emailed invites, `link` for shareable links. |
| `created_at`, `created_by_username` | When and by whom it was sent. `created_by_username` is `null` when the sender's account was deleted. |
| `expires_at`, `is_expired`, `single_use`, `used_at` | Lifetime. |
| `status` | `pending`, `used`, `expired` or `revoked` (precedence revoked > used > expired). A pending invite whose sender's account was deleted, or who is no longer an admin of the board, is reported as `revoked` — the join endpoints refuse it the same way — although nobody revoked it explicitly, and it frees its slot in the cap for its kind — the 50 pending emailed invites, or the 5 active shareable links. This is **not written** to the invite: if the sender regains board admin, the invite reads as `pending` and can be redeemed again (until it expires). To make it permanent, revoke it with `DELETE` below, which accepts it because it was never actually revoked. |
| `can_register` | Advisory: whether a new person could create an account from this invite under the site's **current** registration mode — computed when you read it, so it changes if the mode or the sender's site-admin status changes. Always `false` when `status` is not `pending`, and always `false` for a shareable link unless the site is `open`. |
| `use_count` | *(1.2)* How many **distinct people** have redeemed the invite: the first redemption by each account counts once, and following the link again later does not add to it. A multi-use shareable link never sets `used_at`, so this is its only usage signal. |

**Example response**

```json
[
  {
    "id": 42,
    "prefix": "vbnb_3f9",
    "name": "",
    "role": "collaborator",
    "delivery": "email",
    "created_at": "2026-10-06T14:02:11.512Z",
    "created_by_username": "alice",
    "expires_at": "2026-10-13T14:02:11.498Z",
    "is_expired": false,
    "single_use": true,
    "used_at": null,
    "status": "pending",
    "can_register": true,
    "use_count": 0
  },
  {
    "id": 37,
    "prefix": "vbnb_c07",
    "name": "",
    "role": "viewer",
    "delivery": "email",
    "created_at": "2026-10-02T09:15:40.003Z",
    "created_by_username": null,
    "expires_at": "2026-11-01T09:15:39.990Z",
    "is_expired": false,
    "single_use": true,
    "used_at": null,
    "status": "revoked",
    "can_register": false,
    "use_count": 0
  }
]
```

The second invite was sent by an account that has since been deleted, so it lists as `revoked` even though `DELETE` was never called.

### `POST /api/v1/boards/{id}/invite-links/`
> **Added in 1.2**

Create a **shareable invite link** (`delivery: "link"`). Requires board admin, with the list's permission matrix: `403` for a caller who can see the board but is not a board admin, `404` for a missing board or no access, `401` unauthenticated.

**Request** `{ "role": "viewer", "expiry_days": 7, "single_use": false, "name": "Contractors" }`

| Field | Required | Description |
|---|---|---|
| `expiry_days` | ✓ | `1`, `7` or `30`. **Required** — a shareable board link always expires, so there is no "never" option (*(1.2+)* group links always expire too, with `expiry_days` defaulting to `7`; see [Groups](groups.md#post-apiv1groupsidinvite-links)). Missing, `null` or any other value is refused with `400`. |
| `role` | | `member` (default), `collaborator` or `viewer`. `admin` is refused with `400`. |
| `single_use` | | `false` (default): anyone holding the link can join until it expires or is revoked. `true`: the first redemption consumes it. |
| `name` | | Up to 100 characters, to tell links apart. Leading and trailing whitespace is trimmed. Default empty. |

**Response** `201 Created` — the list row above plus `token`, the raw `vbnb_` token. The field is named `token` here and on the [group invite-link create response](groups.md#post-apiv1groupsidinvite-links), but `raw_token` on the [site invite-link create response](admin.md#post-apiv1admininvite-links). The names differ for historical reasons and are frozen by the 1.0 contract: no rename before a major version. A consistent alias is planned for the next major version (#1255); until then each endpoint keeps its name. (`can_register: true` in the example below is for an `open` site; on an `invite_only` or `closed` site it is `false` for every shareable link.) **This is the only time the token is returned**; only its SHA-256 hash is stored. The join URL is `<site>/join/<token>`.

```json
{
  "id": 51,
  "prefix": "vbnb_8a2",
  "name": "Contractors",
  "role": "viewer",
  "delivery": "link",
  "created_at": "2026-10-07T09:30:00.120Z",
  "created_by_username": "alice",
  "expires_at": "2026-10-14T09:30:00.101Z",
  "is_expired": false,
  "single_use": false,
  "used_at": null,
  "status": "pending",
  "can_register": true,
  "use_count": 0,
  "token": "vbnb_8a2c0f…"
}
```

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | field errors (example below) | Missing or invalid `expiry_days`, invalid `role`, a non-boolean `single_use`, or a `name` over 100 characters. |
| `400 Bad Request` | `{"detail": "Maximum of 5 active invite links reached. Revoke a link to create a new one."}` | The board already has **5 active shareable links**. Active means pending: not revoked, not consumed, not expired, and its creator is still a board admin. Emailed invites have their own cap and never count. |
| `401 Unauthorized` | `{"detail": "Authentication credentials were not provided."}` | No credentials. |
| `403 Forbidden` | `{"detail": "You must be a board admin to manage invites."}` | The caller can see the board but is not a board admin. A caller with no access to the board gets `404`. |
| `404 Not Found` | `{"detail": "..."}` | No such board. |
| `429 Too Many Requests` | `{"detail": "Request was throttled. ..."}`, `Retry-After` header | The caller's standard per-user API budget (DRF `user` scope, 5000 requests/hour, shared with every other authenticated endpoint) is spent. |

Example field-error body, for `{"role": "admin", "single_use": "maybe"}`:

```json
{
  "role": ["\"admin\" is not a valid choice."],
  "expiry_days": ["This field is required."],
  "single_use": ["Must be a valid boolean."]
}
```

The cap is checked under a lock on the board row, so concurrent requests cannot exceed it. Creation is throttled only by the standard per-user API rate (the DRF `user` scope, 5000 requests/hour per account), like group link creation; the cap bounds what a burst can mint. It publishes `invite_link.created` on the board channel, like a send.

**Who can join with a shareable link** depends on the site's registration mode:

| Mode | New account from the link | Existing account |
|---|---|---|
| `open` | Yes — the person signs up, then the SPA's follow-up join redeems the link. | Joins. |
| `invite_only` | **Never**, whoever created the link. Only an emailed single-use invite sent by a site admin admits a new account (see [Authentication](authentication.md#invite-only-mode)). | Joins. |
| `closed` | Never. | Joins. |

A multi-use link increments `use_count` once per person who redeems it and never sets `used_at`; a single-use link is consumed by its first redemption. Redemption follows the access rules under `POST /api/v1/boards/join/{token}/` below: it never changes an existing membership and never grants the board's group.

### `POST /api/v1/boards/{id}/invite-links/send/`
Email one invite. Requires board admin. Same contract as the [group send endpoint](groups.md): the response is identical whether the address belongs to a member, another user, or nobody, and the email is always sent.

**Request** `{ "email": "sam@example.com", "role": "collaborator", "expiry_days": 30 }`

| Field | Required | Description |
|---|---|---|
| `email` | ✓ | One address. Whitespace, display names and lists are refused. |
| `role` | | `member` (default), `collaborator` or `viewer`. `admin` is refused with `400`. |
| `expiry_days` | | `1`, `7` (default) or `30`. Any other value is refused with `400`. |

**Responses**

| Status | Body | When |
|---|---|---|
| `202 Accepted` | `{"detail": "Invite sent", "sent_to": "...", "delivery": "console"?}` | Sent. `delivery: "console"` only in development, when mail is printed to the server console. |
| `400 Bad Request` | field errors, or `{"code": "invite_email_cap_reached", "detail": "..."}` | Invalid input, or the board already has 50 pending emailed invites (invites from a deleted sender or one who is no longer a board admin do not count). |
| `403 Forbidden` | `{"code": "invite_email_disabled", ...}` or `{"detail": "..."}` | Email invites are switched off (`INVITE_EMAIL_ENABLED=false`, or a demo instance), or the caller can see the board but is not a board admin. A caller with no access to the board gets `404`. |
| `429 Too Many Requests` | `Retry-After` header | A send budget is spent: per sender (`invite_email_user`, 10/hour), per board (`invite_email_board`, 30/day, shared by every admin of the board) and instance-wide (`invite_email_global`, 200/day, shared with group invites). Refused requests spend no budget. |
| `502 Bad Gateway` | `{"code": "<smtp code>", "detail": "..."}` | The mail server refused the message. The invite is revoked automatically and the budget refunded, so you can retry once mail works. |

### `DELETE /api/v1/boards/{id}/invite-links/{link_id}/`
Revoke a pending invite, emailed or shareable. Requires board admin; any board admin may revoke any admin's invite. Sets `revoked_at` and `revoked_by`.

| Status | Body | When |
|---|---|---|
| `204 No Content` | — | Revoked. Revoking an expired invite is allowed. |
| `400 Bad Request` | `{"detail": "This invite has already been used and cannot be revoked."}` | The invite was consumed; its "used" record is kept. |
| `401 Unauthorized` | `{"detail": "Authentication credentials were not provided."}` | No credentials. |
| `403 Forbidden` | `{"detail": "You must be a board admin to manage invites."}` | The caller can see the board but is not a board admin. A caller with no access to the board gets `404`. |
| `404 Not Found` | `{"detail": "No BoardInviteLink matches the given query."}` | No such invite, an invite that belongs to another board, or one already revoked. |

The [site-admin board-invite revoke](admin.md#delete-apiv1adminboard-invite-linksid) behaves identically: `204` on success, `400` for a used invite, `404` for an unknown or already-revoked one.

The exception in the invite family is the site invite-link revoke, [`DELETE /api/v1/admin/invite-links/{id}/`](admin.md#delete-apiv1admininvite-linksid), which keeps its 1.1 contract (`200` with the revoked link, `400` on a repeat revoke) for all of 1.x (#1912).

Creating, sending and revoking publish `invite_link.created` / `invite_link.revoked` on the board's [WebSocket channel](websockets.md#invite-events-since-12) with just `{ "id": <int> }`.

### `GET /api/v1/boards/join/{token}/`
Public preview of an invite — no authentication. Returns `{ "board_id", "board_name", "role", "can_register" }`.

The **board name is disclosed to anyone holding the token**, deliberately and as in the group join preview (#801): the token is a 160-bit capability, so its holder may see what it grants before signing in. `can_register` is the same advisory bit as on the list.

| Status | Body | When |
|---|---|---|
| `404 Not Found` | `{"detail": "Not found."}` | No such token. |
| `410 Gone` | `{"code": "used" \| "expired" \| "revoked", "detail": "..."}` | A known invite that can no longer be used. `revoked` also covers an invite whose sender has since been deactivated or is no longer an admin of the board. A used invite still answers `200` to someone who already has access to the board. |
| `429 Too Many Requests` | `{"detail": "Request was throttled. ..."}`, `Retry-After` header | The per-IP `join_group` budget (10/hour) is spent — shared with the group join endpoints and with `POST` below. |

### `POST /api/v1/boards/join/{token}/`
Redeem an invite as the signed-in user. Returns `{ "board_id", "board_name", "role", "created" }` — `201` when a membership was created, `200` otherwise. Same `404` / `410` / `429` responses as the preview, plus:

| Status | When |
|---|---|
| `401 Unauthorized` | No credentials. |
| `403 Forbidden` | `{"detail": "..."}` with no `code`: the account must change its password or username first (`must_change_password` / `must_change_username`), a personal access token lacks the `write` scope, or a session request fails the CSRF check. |
| `403 Forbidden` | *(1.2+, #1678)* `{"code": "invite_recipient_mismatch", "detail": "This invite was sent to a different email address. ..."}`: an emailed invite, and none of the caller's addresses is the one it was sent to. Under `EMAIL_VERIFICATION=mandatory` only verified addresses count; under `optional` or `none` the account's `email` counts too. Matching ignores case and surrounding spaces. Nothing is written and the invite is not consumed. The response never names the invited address. Shareable links and emailed invites sent before upgrading to this version are not checked. A consumed invite followed again by the person who redeemed it is not checked either. |

Redeeming depends on the access you already have, because an explicit board membership **replaces** any role inherited from the board's group rather than adding to it:

- **No access** → you become a board member with the invite's role (`created: true`).
- **Only a group-inherited role ranked below the invite's** (for example a group viewer redeeming a member invite) → an explicit membership with the invite's role is created (`created: true`).
- **An equal or higher inherited role, an explicit board membership of any role, board ownership or all-content access** → nothing changes (`created: false`). A group admin who redeems a viewer invite is **not** downgraded to viewer.

A redeemed single-use invite is consumed either way. Redeeming it again as the person who already has access returns `200` with nothing changed (`created` reports whether this invite created your membership, `true` after signing up from it); anyone else gets `410 {"code": "used"}`. When a membership is created, the board's `member.added` event carries an extra `invite: { "id", "created_by_id" }` key for `admin` and `site_admin` recipients, on the WebSocket and in the [change feed](events.md); other recipients get the event without it.

> **Added in 1.2**

A join that arrives while the board is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1631).

Both join endpoints share the per-IP `join_group` throttle (10/hour) with the [group join endpoints](groups.md): board and group join attempts from one address draw from one budget.

Signing up with a board invite on an invite-only site is covered in [Authentication](authentication.md#invite-only-mode).

Site admins can list and revoke every board's invites with the [admin board invite endpoints](admin.md#board-invites).

---

## Board sharing

### `POST /api/v1/boards/{id}/share/`
Generate (or regenerate) a public share token for the board. Requires board admin.

If a token exists, this call invalidates it immediately and returns a new UUID, so existing share links stop working. This is how a link is **rotated**.

*(1.2+, #1935)* This response is where clients should read the token: show it (or `share_url`) to the admin now. The `share_token` field on [`GET /api/v1/boards/{id}/full/`](#get-apiv1boardsidfull) is deprecated and will be removed in 2.0; to tell later whether a link is set, read `share_link_active` there.

**Permissions:** board `admin` or `site_admin` only.

**Request (optional)**
```json
{
  "expires_in_days": 7
}
```

`expires_in_days` is optional. Allowed values: `7`, `30`, `90`, or `null`. Omitting it or sending `null` creates a link that never expires; this API default is part of the 1.x contract and does not change. Any other integer returns `400 Bad Request`. New in 1.1 (#804).

*(1.2+, #1865)* The **Sharing** tab in board settings pre-selects **30 days** and sends it explicitly; choosing **Never** sends `null`. Clients calling the API directly keep the "never expires" default unless they send a value.

*(1.2+, #1865)* The link records the admin who enabled it, and lasts only while that account keeps the standing that let it enable sharing on this board: active, and a board `admin` or `site_admin` there (by membership, ownership, group role, or all-content access). When that account is deactivated or deleted, demoted below board admin (including by being added to the board directly with a lower role, which takes precedence over a group role), removed from the board or from the group that made it an admin, loses that group role because it joined a nearer group with a lower role, the board's group is changed (`PATCH`/`PUT` with `group`, or move-group), or a group is moved or deleted, or loses all-content access, the token and its expiry are cleared and a `board.updated` event is sent, plus *(1.3+)* the admin-only [`share_link.updated`](websockets.md#share-link-events-since-13) event with `active: false`. An account that is still an admin of the board another way keeps the link. Links enabled before the enabler was recorded (for example under 1.1, or 1.2.0-beta.3 and earlier), record no enabler and do not resolve from the upgrade on (#1939); a `POST` here issues a new link that records the caller. No response body or event payload includes the enabler.

**Response**
```json
{
  "share_token": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "share_url": "https://your-instance.example.com/api/share/3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "share_token_expires_at": "2026-04-28T17:30:00+00:00",
  "share_token_issued_at": "2026-04-21T17:30:00+00:00"
}
```

`share_token_expires_at` is `null` when no TTL was requested.

*(1.3+, #1967)* `share_token_issued_at` is when this link was issued. It is additive. Besides `board.updated`, a successful call sends the admin-only [`share_link.updated`](websockets.md#share-link-events-since-13) WebSocket event with `active: true`, the new expiry, and `issued_at` set to this same `share_token_issued_at`, so other admin sessions see the change and the caller can tell its own change from a later rotation by someone else. The event never carries the token. `DELETE` below sends it with `active: false`.

The `board.updated` recorded with a share link's enable, rotate, revoke or server-side clear is a system event: `actor_id` and `actor` are `null` on its [change feed](events.md) row, and its payload has no `is_starred`.

**Errors:** `403 Forbidden` if the caller can see the board but is not a board admin, including a caller whose admin role was removed while the request was waiting on a concurrent change to the board; `404 Not Found` if the caller has no access to it. `400 Bad Request` if `expires_in_days` is not one of the allowed values.

### `DELETE /api/v1/boards/{id}/share/`
Revoke the board's public share token. Requires board admin. Existing share links immediately return `404 Not Found`. The token and any TTL are cleared.

**Permissions:** board `admin` or `site_admin` only.

**Response**
```json
{
  "share_token": null,
  "share_url": null,
  "share_token_expires_at": null,
  "share_token_issued_at": null
}
```

**Errors:** `403 Forbidden` if the caller can see the board but is not a board admin; `404 Not Found` if the caller has no access to it.

---

## Columns

Column objects include a read-only `uid`, a stable 16-character hex identifier that survives rename and reorder. Any `uid` sent in a request body is ignored.

### `GET /api/v1/boards/{id}/columns/`
List all columns on the board in position order. Available to all board members.

Paginated: the standard [envelope](index.md#pagination) `{ "count", "offset", "page_size", "results" }`, with `?offset` and `?page_size` (default `50`, max `200`).

### `GET /api/v1/boards/{id}/columns/{col_id}/`
Get a single column. Available to all board members.

### `POST /api/v1/boards/{id}/columns/`
Create a column. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Request** `{ "name": "Review", "color": "#8B5CF6", "wip_limit": 3, "weight_limit": null, "allow_card_creation": false, "is_done": false }`

Column objects returned by all endpoints include the following fields:

| Field | Type | Description |
|---|---|---|
| `id`, `uid` | integer, string | Database ID and stable 16-char hex UID (read-only) |
| `name` | string | Column name |
| `position` | integer | Display order (0-based); update via `reorder/` only — a `PATCH`/`PUT` that changes `position` returns `400 Bad Request` (since 1.2, #1275). Echoing the current value back is accepted. |
| `color` | string | Hex color code, `#RRGGBB`. Since 1.3 a written value must be hex: `#RGB` is accepted and stored expanded (`#abc` becomes `#aabbcc`, case kept), and anything else is `400`. A value equal to the stored one is accepted as is, so rows saved before 1.3 with a non-hex color still load and can be renamed. See [Color values](#color-values). |
| `wip_limit` | integer / null | Maximum number of cards; `null` means unlimited (binding on every API card write path except board import; see note) |
| `weight_limit` | integer / null | Maximum total card weight; `null` means unlimited (binding on every API card write path except board import; see note) |
| `allow_card_creation` | boolean | When `false`, new cards cannot be created directly in this column |
| `is_done` | boolean | When `true`, marks this column as a "done" stage used for cycle-time and throughput metrics. Default: `false`. |
| `policy` | object / null | Since 1.3. The column's written [policy](../features/column-policies.md): `{"v": 1, "entry": [...], "done": [...], "mode": "advisory"}` (or `"confirm"`), or `null` for none. Readable by every board member; only board admins can write it. Left out of the anonymous share-link payload (`GET /api/share/{token}/`), whose columns carry every other field listed here. See [Column policy](#column-policy-since-13). |

> When `allow_card_creation` is `false`, posting a new card to that column returns `400 Bad Request` with `{"column": "Card creation is not allowed in this column."}`.
>
> WIP and weight limits are enforced when `enforce_wip_limits` or `enforce_weight_limits` is enabled on the board. A card move, create, or restore into an over-limit column (or a PATCH raising a card's `weight` past the weight limit) returns `409 Conflict` — see the move endpoint in the [Cards API](cards.md) for the full error schema and the `?force=true` admin override. When enforcement is disabled, limits are displayed but not enforced.
>
> Since 1.2 (#1428) limits are checked on every API card write path except board import (REST, MCP, and the Django admin), not just the move endpoint. Board import and the operator seed commands are exempt by design: import restores a board as exported, so an imported column can hold more than its limit — see [Field Enforcement](../architecture/field-enforcement.md).

### `PUT /api/v1/boards/{id}/columns/{col_id}/` / `PATCH /api/v1/boards/{id}/columns/{col_id}/`
Update a column. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Writable fields:** `name`, `color`, `wip_limit` (integer or `null`), `weight_limit` (integer or `null`), `allow_card_creation` (boolean), `is_done` (boolean), `policy` (object or `null`, since 1.3)

`PUT` and `PATCH` are both accepted. `PATCH` changes only the fields you send. `PUT` requires `name`, as on create (`400` with `{"name": ["This field is required."]}` without it); any other writable field you leave out keeps its current value, it is not reset to its default. To change one field without resending the name, use `PATCH`.

#### Column policy (since 1.3)

`policy` holds a column's entry criteria and definition of done (#1101). It is advisory: no card move, create or restore is ever refused because of it.

| Key | Type | Rules |
|---|---|---|
| `v` | integer | Required. Always `1`. |
| `entry` | array of strings | Entry criteria, in display order. Up to 8, each non-blank and at most 200 characters after trimming. Default `[]`. |
| `done` | array of strings | Definition of done, same rules. Default `[]`. |
| `mode` | string | `"advisory"` (default) or `"confirm"`. `"confirm"` asks the web app to show the mover a checklist of the entry criteria after a drag-and-drop move into the column. The server never checks it. |

A criterion containing a control character (including NUL or a line break) is refused too. Any other key, a wrong `v`, or a value breaking these rules returns `400` with a `policy` error. Criteria are stored trimmed, and a policy whose two lists are both empty is stored as `null`. Send `"policy": null` to remove it. Leaving `policy` out of a `PUT` keeps the current value.

```json
{ "policy": { "v": 1, "entry": ["Has an owner"], "done": ["Reviewed", "Docs updated"], "mode": "confirm" } }
```

The `column.updated` socket event carries the column with its `policy`, like every other field.

### `DELETE /api/v1/boards/{id}/columns/{col_id}/`
Delete a column. Requires board admin.

Since 1.2, if cards keep being created in, or moved into, the column during the delete, it gives up after a bounded number of internal retries and returns `409 Conflict` with `{"code": "container_changed", "detail": "Cards were added while this was being deleted. Please try again."}`. Nothing is deleted; retry (#1602). A create or move targeting the column mid-delete waits for the delete, then returns `404`.

### `POST /api/v1/boards/{id}/columns/reorder/`
Reorder columns. Requires board admin.

Since 1.2, a request body that is not a JSON object returns `400 Bad Request` (it returned `500` before). Entries that are not integers were already a `400`; since 1.2 an entry beyond the 64-bit integer range is also a `400` (it returned `500` before).

**Request** `{ "order": [3, 1, 4, 2] }`. `order` must be **exactly** this board's current column IDs: every column once, no duplicates, no ID from another board. A partial list, a duplicate, a foreign ID, or (on a board that has columns) an empty list is rejected with `400` and body `{"order": ["..."]}`, never partially applied. *(Since 1.2, #1302 — same
rule as checklist-item reorder, #1292.)*

---

## Swimlanes

Swimlane objects include a `uid` field — stable across renames, read-only.

**Role-gated fields:** `contact_email` and `notes` are only included in responses for `admin` and `site_admin` role members. `member`, `collaborator`, and `viewer` roles receive swimlane objects without those fields. This applies to the swimlane list endpoint, `GET /api/v1/boards/{id}/full/`, and WebSocket broadcast events.

**`custom_field_values` visibility (since 1.2):** unlike `contact_email`/`notes`, a row's custom field values are gated **per definition**, not per role. Every board role receives `custom_field_values`, but an entry appears only if its [definition](#swimlane-custom-fields-since-12) has `is_admin_only: false` (the default is `true`). Board admins and site admins see every value. A share-link visitor (`GET /api/share/{token}/`) never receives `custom_field_values`; see [Public share endpoint](#public-share-endpoint).

### `GET /api/v1/boards/{id}/swimlanes/`
List all swimlanes on the board in position order. Available to all board members. `admin` and `site_admin` roles see `contact_email` and `notes`; all other roles receive swimlane objects without those fields.

Paginated: the standard [envelope](index.md#pagination) `{ "count", "offset", "page_size", "results" }`, with `?offset` and `?page_size` (default `50`, max `200`).

### `GET /api/v1/boards/{id}/swimlanes/{swimlane_id}/`
Get a single swimlane. Same role-gated field rules as the list endpoint.

### `POST /api/v1/boards/{id}/swimlanes/`
Create a swimlane. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Request** `{ "name": "Acme Corp", "contact_email": "", "color": "#3B82F6" }`

> Swimlane names are unique per board. Creating a swimlane with a name that already exists on the same board returns `400 Bad Request`.

Swimlane response objects include the following fields:

| Field | Type | Description |
|---|---|---|
| `id`, `uid` | integer, string | Database ID and stable 16-char hex UID (read-only) |
| `name` | string | Swimlane name |
| `position` | integer | Display order (0-based); update via `reorder/` only — a `PATCH`/`PUT` that changes `position` returns `400 Bad Request` (since 1.2, #1275). Echoing the current value back is accepted. |
| `color` | string | Hex color code, `#RRGGBB`. Since 1.3 a written value must be hex: `#RGB` is accepted and stored expanded (`#abc` becomes `#aabbcc`, case kept), and anything else is `400`. A value equal to the stored one is accepted as is, so rows saved before 1.3 with a non-hex color still load and can be renamed. See [Color values](#color-values). |
| `is_collapsed` | boolean | Whether the swimlane row is collapsed in the board view |
| `created_at` | string | ISO 8601 timestamp of swimlane creation |
| `contact_email` | string | Admin-only — contact email for this swimlane (empty string if unset) |
| `notes` | string | Admin-only — internal notes (empty string if unset) |
| `custom_field_values` | array | Since 1.2. `[{ "field_definition": <id>, "value": "<string>" }, ...]` — one entry per [swimlane custom field](#swimlane-custom-fields-since-12) definition that has a value **and** is visible to the requesting role (see the `custom_field_values` visibility note above). Values are always strings; numbers as written, dates as `YYYY-MM-DD`, checkboxes as `"true"`/`"false"`. |
| `wip_limit` | integer or null | Since 1.3 (#1150). Maximum number of active cards in the swimlane's counted columns. `null` (the default) means no limit; the minimum is `1`. Every board role receives it. See [Swimlane limits](#swimlane-limits-since-13). |
| `weight_limit` | integer or null | Since 1.3. Maximum total weight of active cards in the counted columns. `null` means no limit; minimum `1`. |
| `limit_enforcement` | string or null | Since 1.3. `"block"` (refused with `409`; board admins can override with `?force=true`), `"hard"` (the WIP limit admits no override for any role; the weight limit stays a block), or `null` (the default) to inherit the board's `enforce_wip_limits`, `enforce_wip_hard` and `enforce_weight_limits`, exactly as a column does. A write of `""` is accepted and stored as `null`, so it is never returned. |
| `health_status` | string or null | Since 1.3 (#2243). The lane's manual [health status](../features/health-status.md#lane-status): `on_track`, `at_risk`, `off_track`, or `null` (the default) for no status. Independent of the board's `health_status`: `null` never inherits the board's value, and a lane's value never rolls up to the board. Every member reads it; only board admins and site admins write it (`403` for other roles, before the body is validated). Any other value returns `400` with `{"health_status": [...]}`. Not on the public share-link payload. |
| `limit_column_ids` | array of integers or null | Since 1.3. Ids of the board's columns whose cards count toward the swimlane's limits, sorted. `null` (the default) means every column whose `is_done` is `false`. An empty list is refused with `400`. Deleting a column removes its id; a list left empty becomes `null`. |

`contact_email` and `notes` are only returned to `admin` and `site_admin` role members (see role-gated fields note above).

### `PUT /api/v1/boards/{id}/swimlanes/{swimlane_id}/` / `PATCH /api/v1/boards/{id}/swimlanes/{swimlane_id}/`
Update a swimlane. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Writable fields:** `name`, `color`, `is_collapsed`, `contact_email`, `notes`, `custom_field_values` (since 1.2), `wip_limit`, `weight_limit`, `limit_enforcement`, `limit_column_ids`, `health_status` (since 1.3)

A `limit_column_ids` entry that is not a column of this board, whether it exists on another board or not at all, returns `400 Bad Request` with the same message either way. So does one deleted while the request was in flight.

`PUT` and `PATCH` are both accepted. `PATCH` changes only the fields you send. `PUT` requires `name`; any other writable field you leave out keeps its current value, it is not reset to its default.

> Swimlane names are unique per board. Renaming a swimlane to a name that already exists on the same board returns `400 Bad Request`.

`custom_field_values` writes work with `PUT` and `PATCH` alike. Send only the entries you want to change; a swimlane custom field not named keeps its value. Send `{"field_definition": <id>, "value": ""}` to clear (and delete) a value. At most one entry per `field_definition` per request; a `field_definition` id from another board is rejected with `400 Bad Request`. Writes here are admin-only, so an admin may write an `is_admin_only` field's value; that is expected, not an escalation. There is no separate values endpoint.

!!! note
    The `PUT`/`PATCH` HTTP response always includes `contact_email`, `notes`, and every
    `custom_field_values` entry regardless of `is_admin_only` — the caller is the admin who
    just wrote it. The `swimlane.updated` WebSocket broadcast, however, is always built from
    the **public** swimlane shape, for every connected client — including the admin who made
    the change. `contact_email`, `notes`, and any `is_admin_only` value are absent from that
    frame for everyone; an admin sees the change on their next REST fetch, not in real time.
    See [WebSockets](websockets.md#swimlane-field-events-since-12) for the full contract.

### Swimlane limits (since 1.3)

> **Added in 1.3** (#1150)

A swimlane can carry its own `wip_limit` and `weight_limit`, enforced on the same card write paths as a column's: a move, a card create, a restore from archive, and (weight only) a `PATCH` that raises a card's `weight`. Only cards in the swimlane's counted columns (`limit_column_ids`) count, and archived cards never do.

- **When a move is checked.** Only when it adds to the swimlane's counted total: the card enters a counted column of the swimlane from another swimlane, from an uncounted column of the same swimlane, or from nowhere (create, restore). A move between two counted columns of one swimlane, or a reorder, never trips the swimlane's limit, exactly as a swimlane-only move never trips a column's.
- **Errors.** `409` with `swimlane_wip_limit_exceeded`, `swimlane_wip_hard_blocked` or `swimlane_weight_limit_exceeded`. The bodies are the column codes' bodies plus `swimlane_name`; `column_name` names the target cell's column, and `current_count` / `current_weight` / `wip_limit` / `weight_limit` are the swimlane's. See [Cards — Move](cards.md#post-apiv1boardsboard_idcardsidmove).
- **Several limits at once.** When the column and the swimlane (or WIP and weight) both trip, the response names the strictest one: a hard limit before a soft one, and the column before the swimlane when they are equally strict. A board that never sets a swimlane limit gets exactly the bodies it got before 1.3. One `?force=true` from a board admin overrides every soft limit the move trips; it never overrides a hard one.
- **Import and export.** The JSON export carries `wip_limit`, `weight_limit`, `limit_enforcement` and `limit_columns` (column **names**, or `null`) per swimlane, and the JSON import restores them. Import never enforces a limit, so an imported swimlane can be over its limit.

### `DELETE /api/v1/boards/{id}/swimlanes/{swimlane_id}/`
Delete a swimlane. Requires board admin.

Since 1.2, if cards keep being created in, or moved into, the swimlane during the delete, it gives up after a bounded number of internal retries and returns `409 Conflict` with `{"code": "container_changed", "detail": "Cards were added while this was being deleted. Please try again."}`. Nothing is deleted; retry (#1602). A create or move targeting the swimlane mid-delete waits for the delete, then returns `404`.

### `PATCH /api/v1/boards/{id}/swimlanes/{swimlane_id}/set-collapsed/`
Toggle a swimlane's default collapsed state. Requires admin or site admin; members, collaborators, and viewers are rejected.

This sets the board-wide default for all users: a board structure preference, not a per-user setting.

**Minimum role:** admin or site admin

**Request**
```json
{ "is_collapsed": true }
```

**Response** — updated swimlane object (same shape as `GET /api/v1/boards/{id}/swimlanes/{swimlane_id}/`)

**Errors**

| Status | Body | Condition |
|---|---|---|
| `400 Bad Request` | `{"is_collapsed": "This field must be a boolean."}` | `is_collapsed` was not a boolean |
| `403 Forbidden` | `{"detail": "..."}` | Caller is a member, collaborator, or viewer |

A `swimlane.updated` WebSocket event is broadcast to all connected board clients on success.

!!! note
    The deprecated snake_case alias `set_collapsed` (with underscore) is retained for 1.x backward compatibility and emits the same response. A successful (`2xx`) response from it additionally includes the following headers; an error response (`400`, `403`, `404`) does not:

    - `Deprecation: true` — signals that this URL path is deprecated (RFC 8594).
    - `Link: <canonical-url>; rel="successor-version"` — points to the canonical kebab-case path (RFC 8288).

    Prefer the kebab-case form `set-collapsed`. The underscore alias will be removed in 2.0. *(1.2+)* The OpenAPI schema marks the alias operation `deprecated: true`; the canonical `set-collapsed` operation is not deprecated.

### `POST /api/v1/boards/{id}/swimlanes/reorder/`
Reorder swimlanes. Requires board admin.

Since 1.2, a request body that is not a JSON object returns `400 Bad Request`, and since 1.2 so does an entry beyond the 64-bit integer range (each returned `500` before); non-integer entries were already a `400`.

**Request** `{ "order": [2, 1, 3] }`. `order` must be **exactly** this board's current swimlane IDs: every swimlane once, no duplicates, no ID from another board. A partial list, a duplicate, a foreign ID, or (on a board that has swimlanes) an empty list is rejected with `400` and body `{"order": ["..."]}`, never partially applied. *(Since 1.2, #1302 —
same rule as checklist-item reorder, #1292.)*

---

## Labels

Label objects include a `uid` field — stable across renames, read-only.

### `GET /api/v1/boards/{id}/labels/`
List board labels. Available to all board members.

Paginated: the standard [envelope](index.md#pagination) `{ "count", "offset", "page_size", "results" }`, with `?offset` and `?page_size` (default `50`, max `200`).

### `GET /api/v1/boards/{id}/labels/{label_id}/`
Get a single label. Available to all board members.

### `POST /api/v1/boards/{id}/labels/`
Create a label. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Request** `{ "name": "Bug", "color": "#EF4444" }`

### `PUT /api/v1/boards/{id}/labels/{label_id}/` / `PATCH /api/v1/boards/{id}/labels/{label_id}/`
Update a label. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Writable fields:** `name`, `color` (hex, see [Color values](#color-values))

`PUT` and `PATCH` are both accepted. `PATCH` changes only the fields you send. `PUT` requires `name`; a `color` you leave out keeps its current value.

### `DELETE /api/v1/boards/{id}/labels/{label_id}/`
Delete a label. Requires board admin.

---

## Custom fields (since 1.2)

Typed, per-board metadata fields that cards can carry: a label is an untyped tag, a custom field is a named key with a type. A board's definitions also come back on `GET /api/v1/boards/{id}/full/` as `custom_field_definitions`, so a client has the schema on board load. Card **values** are read and written through the [card endpoints](cards.md), not here.

Definition objects include a `uid` field — stable across renames, read-only.

**Limits:** at most **30** definitions per board, and at most **2** with
`show_on_card: true`.

| Field | Type | Read-only | Description |
|---|---|---|---|
| `id` | integer | yes | Database primary key |
| `uid` | string | yes | Stable 16-character hex UID |
| `name` | string | no | Field name; unique within the board |
| `field_type` | string | no\* | One of `"text"`, `"number"`, `"date"`, `"dropdown"`, `"checkbox"`, `"url"` (see [URL fields](#url-fields)), `"multi_select"` (see [Multi-select fields](#multi-select-fields)) |
| `choices` | string[] | no | Permitted values; required and non-empty (at most 100, unique) for `"dropdown"` and `"multi_select"`, rejected for every other type |
| `position` | integer | yes | Display order; set on create and changed only via `reorder/` |
| `show_on_card` | boolean | no | Pin the value to the card face. Max 2 per board |
| `is_required` | boolean | no | Declared but **not enforced** in this release |
| `help_text` | string | no | Hint shown next to the input |
| `number_prefix` | string | no | *Since 1.2.* Display-only text before a number value; `""` (default) for none. `"number"` fields only — see [Number formatting](#number-formatting) |
| `number_suffix` | string | no | *Since 1.2.* Display-only text after a number value; `""` (default) for none. `"number"` fields only |
| `number_decimals` | integer \| null | no | *Since 1.2.* Fixed decimal places (0–10) for display; `null` (default) shows the number as typed. `"number"` fields only |
| `choice_colors` | object | no | *Since 1.2.* Display-only `{choice: palette_key}` map; `{}` (default) for none. `"dropdown"` and `"multi_select"` fields only — see [Choice colors](#choice-colors) |
| `threshold_direction` | string | no | *Since 1.3.* `""` (default, off), `"above"` or `"below"`. `"number"` and `"date"` fields only — see [Threshold marking](#threshold-marking) |
| `threshold_warn` | number \| null | no | *Since 1.3.* Warning threshold; `null` (default) for none. `"number"` fields only |
| `threshold_alert` | number \| null | no | *Since 1.3.* Alert threshold; `null` (default) for none. `"number"` fields only |
| `threshold_warn_days` | integer \| null | no | *Since 1.3.* Warning threshold as a signed day offset from today; `null` (default) for none. `"date"` fields only |
| `threshold_alert_days` | integer \| null | no | *Since 1.3.* Alert threshold as a signed day offset from today; `null` (default) for none. `"date"` fields only |
| `created_at` | string | yes | ISO 8601 creation timestamp |

\* `field_type` is writable only while the definition has zero values — see the `PATCH`
errors below.

#### URL fields

A `"url"` field stores a web address, on card and swimlane custom fields alike. Like every type it is text-backed: the value is the stored string.

- **Validated on write**, through the same rule as a card's
  [external ref](cards.md#external-ref-since-12) URL: the value must be an absolute
  `http://` or `https://` URL with a host. Any other scheme (`javascript:`, `data:`,
  `ftp:`, `mailto:` — matched case-insensitively), a missing scheme (`example.com`),
  embedded whitespace or control characters, a backslash, a percent-encoded host,
  credentials (`user:pass@`), or an invalid port is rejected with `400 Bad Request`.
- **At most 500 characters**, the cap that applies to every custom field value. A longer
  URL is rejected, never truncated.
- **Stored as sent** (after trimming surrounding whitespace) — the scheme's case and the
  rest of the URL are not rewritten. The API does not add a missing `https://`; the web
  UI does that before it sends the value.
- `choices` is rejected for a `"url"` field, as for every type that cannot carry choices
  (anything but `"dropdown"` and `"multi_select"`).
- **Clients that do not recognize `"url"`** should render the value as plain text (it is always a string). A client that renders a link must still check the scheme at render time and use `rel="noopener noreferrer"`.
- Enterprise `CUSTOM_FIELD_VALIDATORS` hooks receive `"url"` as the `field_type` and run
  after this validation.

#### Multi-select fields

> **Added in 1.2**

A `"multi_select"` field holds any number of the definition's `choices`, on card and swimlane custom fields alike. It is text-backed like every type: **the `value` on the wire is still a string**, a JSON array encoded as a string, never a JSON array.

```json
{ "field_definition": 14, "value": "[\"web\",\"ios\"]" }
```

- **Canonical form.** The stored (and returned) string is compact JSON (`["web","ios"]`, no
  spaces, non-ASCII characters unescaped), **deduplicated**, with entries that are current
  choices **in `choices` order**, followed by any orphaned entries (see below). Resubmitting
  the same set in a different order is therefore not a change: the stored row is not
  rewritten and no `custom_field_value_changed` /
  `swimlane_custom_field_value_changed` signal fires.
- **Accepted on write** — any of: an array of strings (`"value": ["ios", "web"]`); the JSON
  array string a read returned (so echoing a payload back is a no-op); a plain string, read
  as a single entry (`"value": "web"`). `""`, `null` and `[]` (or an array of blank
  strings) clear the field. Surrounding whitespace on each entry is trimmed.
- **Every entry must be a current choice — or already stored on that card or swimlane.**
  Anything else is a `400`: `'<entry>' is not a choice for '<name>'.` A non-string entry
  (or a nested array) is a `400`: `Each value of '<name>' must be a string.` An object, a
  boolean, or an entry containing NUL (`\u0000`) is also a `400`.
- **At most 500 characters, measured on the canonical string.** Over the cap is a `400`,
  never a truncation: `'<name>' value is longer than 500 characters.` The same message is
  returned, without parsing, for an array of more than 500 entries or a JSON array string
  longer than 2,000 characters.
- **Permissions** are those of the owner's other writes: a card value needs board member
  or above and is subject to the same ownership gate as any card edit; a swimlane value
  can be written by board admins only.
- **Orphans are kept.** Renaming or removing a choice never rewrites stored values: an
  entry that is no longer a choice stays in the value, is returned as stored, and may be
  kept (or dropped) on later writes to that same card or swimlane. It cannot be added
  anywhere it is not already stored. Clients should render an orphaned entry like any
  other value.
- `field_type` follows the same freeze rule as every type — it cannot change once any value
  exists — so there is no conversion path to or from `"dropdown"`.
- **Clients that do not recognize `"multi_select"`** should render the value as plain text;
  it is always a string.
- **Export.** The JSON export carries the stored string unchanged. The CSV export writes the
  entries joined with `"; "` (`web; ios`), each entry formula-sanitized like every other CSV
  cell.
- **Extension points.** Enterprise `CUSTOM_FIELD_VALIDATORS` /
  `SWIMLANE_CUSTOM_FIELD_VALIDATORS` hooks receive `field_type == "multi_select"` and the
  canonical string (for example `'["web","ios"]'`), never a list; a hook that rewrites the
  value must return a string of the same shape. A rewritten value is re-canonicalized and
  re-checked against the 500-character cap; one that is not a JSON array of strings is
  refused with a `400`. The `custom_field_value_changed` and
  `swimlane_custom_field_value_changed` signals send `old_value`/`new_value` as the
  canonical strings — the whole set, not a per-entry diff.

#### Number formatting

> **Added in 1.2**

Three optional, **display-only** settings on a `"number"` definition, on card and swimlane custom fields alike. They change how a client renders a value, never the value: on the wire, in exports, and in filters it stays the plain number string the user entered.

```json
{ "name": "Budget", "field_type": "number", "number_prefix": "$", "number_suffix": " USD", "number_decimals": 2 }
```

| Field | Type | Default | Rule |
|---|---|---|---|
| `number_prefix` | string | `""` | At most 10 characters. Stored exactly as sent — leading and trailing spaces are **not** trimmed (`"$ "` is a valid prefix). |
| `number_suffix` | string | `""` | At most 10 characters, stored exactly as sent (`" h"`). |
| `number_decimals` | integer or `null` | `null` | `0`–`10` inclusive. `null` means "render the number as typed". |

- **All three are optional** on create and `PATCH`; omitted, they keep their defaults (or
  current values), which reproduce the pre-1.2 rendering exactly. Existing clients that
  ignore them are unaffected.
- **Only on a number field.** On any other `field_type`, a non-default value is a
  `400 Bad Request` keyed by the offending field:
  `{"number_prefix": ["Number format options can only be set on a number field."]}`.
  Sending the defaults (`""`, `""`, `null`) is always accepted, so a client may send all
  three keys for every type. A `PATCH` is checked against the definition's stored type
  when `field_type` is not in the body.
- **Changing the type clears them.** When a definition with no values is retyped away from
  `"number"`, all three are reset to their defaults in the same write. Sending a
  non-default format in the same request as the retype is a `400`.
- **Other `400`s:** `number_decimals` below 0 (`Ensure this value is greater than or equal
  to 0.`), above 10 (`Ensure this value is less than or equal to 10.`), or not an integer
  (`A valid integer is required.`); a prefix or suffix over 10 characters (`Ensure this
  field has no more than 10 characters.`), containing NUL (`Null characters are not
  allowed.`), or `null` (`This field may not be null.`).
- **Rendering (the web UI's rule, recommended for other clients):** a value that does not
  parse as a finite number is shown raw. With `number_decimals` `null`, the number is
  shown **as typed** (`"+5"` → `$+5`, `"1e3"` → `$1e3`, no grouping). With it set, round
  to that many places with thousands grouping (`1e3` → `1,000`); values beyond 2^53 lose
  precision in the **display only** — the stored value is untouched. Then add the prefix
  and suffix verbatim, with a minus sign **before** the prefix (`-$5.00`).
- **Export.** The JSON export's `custom_fields` and `swimlane_custom_fields` entries carry
  the three keys (additive — `schema_version` is unchanged); card and swimlane values stay
  the raw number string in both JSON and CSV.
- **Events.** `custom_field.created` / `custom_field.updated` and
  `swimlane_custom_field.created` / `swimlane_custom_field.updated` carry the full
  definition, so the three fields arrive with them.

#### Threshold marking

> **Added in 1.3**

Optional, **display-only** thresholds on a card custom field of type `"number"` or `"date"`. A client marks a card's value once it reaches a threshold; the value itself never changes. Swimlane (row) custom fields have no thresholds (#2217). These are new fields on an existing endpoint: they are **stable and additive**, and a client that ignores them is unaffected.

```json
{ "name": "Spend", "field_type": "number", "threshold_direction": "above", "threshold_warn": 5000, "threshold_alert": 6000 }
{ "name": "Renewal", "field_type": "date", "threshold_direction": "below", "threshold_warn_days": 14, "threshold_alert_days": 0 }
```

| Field | Type | Default | Rule |
|---|---|---|---|
| `threshold_direction` | string | `""` | `""` (off), `"above"` or `"below"`. |
| `threshold_warn`, `threshold_alert` | number or `null` | `null` | `"number"` fields only. Finite, between `-1e15` and `1e15`. |
| `threshold_warn_days`, `threshold_alert_days` | integer or `null` | `null` | `"date"` fields only. A signed day offset from today (`-3` = three days ago), between `-3650` and `3650`. |

- **All five are optional** on create and `PATCH`. Omitted keys keep their current values
  (or the defaults on create). A `PATCH` is checked against the stored values for any key
  it does not send, and against the stored type when `field_type` is not in the body.
- **Direction and values go together.** With `threshold_direction` `""`, every threshold
  must be `null` (`400` keyed `threshold_direction`). With a direction set, at least one
  threshold of the field's type is required (`400` keyed `threshold_warn` or
  `threshold_warn_days`). Turning thresholds off therefore means sending `""` and the
  `null`s together.
- **Ordering.** When both are set, the alert threshold must be strictly beyond the warning
  in the direction: above, `alert > warn`; below, `alert < warn`. Otherwise `400` keyed
  `threshold_alert` / `threshold_alert_days`. Changing only the direction re-checks the
  stored pair.
- **Wrong type.** A non-null number threshold on a `"date"` field, a day threshold on a
  `"number"` field, or any non-default threshold on another type is a `400` keyed by the
  offending field. Sending the defaults (`""` and `null`s) is always accepted.
- **Changing the type clears them.** Retyping a definition (possible only while it has no
  values) resets all five to their defaults unless the same request sets thresholds valid
  for the new type.
- **Other `400`s:** `NaN` or infinity (`A valid number is required.`), a value out of
  range (`Ensure this value is less than or equal to …`), a non-integer day offset
  (`A valid integer is required.`), an unknown direction (`"sideways" is not a valid choice.`).
  Errors are plain field-keyed lists, like [number formatting](#number-formatting).
- **Evaluation (the web UI's rule, recommended for other clients):** boundaries are
  **inclusive**. `"above"` marks a value at or over a threshold, `"below"` one at or under
  it, and the alert level wins over the warning. A number value is compared as a finite
  number (`"1e3"`, `"+5"`, `"1.50"` all parse); one that does not parse is not marked. A
  date value is compared by its day offset from **today in the viewer's timezone** (the
  same "today" as due dates); a value that is not a calendar date is not marked.
- **Export and import.** The JSON export's `custom_fields` entries carry the five keys
  (additive — `schema_version` is unchanged), and import validates them with the same
  rules. An older server ignores them on import.
- **Events.** `custom_field.created` / `custom_field.updated` carry the full definition, so
  the five fields arrive with them.

#### Choice colors

> **Added in 1.2**

An optional, **display-only** color per choice on a `"dropdown"` or `"multi_select"` definition, on card and swimlane custom fields alike. `choices` stays a plain list of strings; the colors live in a separate map keyed by choice text. Values are never touched.

```json
{ "name": "Severity", "field_type": "dropdown", "choices": ["Low", "High"], "choice_colors": { "High": "red" } }
```

- **Shape.** An object mapping a choice (its text, exactly as in `choices`) to a palette
  key. Default `{}`. A choice with no entry has no explicit color; the web UI renders it
  with its automatic dot, the same as before 1.2.
- **Palette keys only, never hex:** `slate`, `blue`, `green`, `amber`, `red`, `violet`,
  `pink`, `teal`. The client owns how each key looks in light and dark themes and
  guarantees its contrast; a hex or CSS color is refused.
- **Optional** on create and `PATCH`; omitted, the map keeps its default (or current
  value). Sending `{}` is always accepted, for every `field_type`.
- **Stale keys are pruned, not refused.** On every write, entries whose key is not one of
  the definition's current `choices` (after the choices in the same request are applied,
  or the stored ones when `choices` is not sent) are dropped silently. Keys are matched
  after trimming surrounding whitespace, like `choices`. So **renaming or removing a
  choice drops its color** — the choice text is the key, and a color is not carried over
  to a renamed choice. A `PATCH` that only changes `choices` prunes the stored map the
  same way.
- **Changing the type clears it.** When a definition is retyped away from `"dropdown"` /
  `"multi_select"`, the map is reset to `{}` in the same write. Retyping between
  `"dropdown"` and `"multi_select"` keeps it.
- **Errors** — all `400 Bad Request`, keyed by `choice_colors`:

    | Cause | Message |
    |---|---|
    | A non-empty map on any other `field_type` (judged against the stored type when the body does not change it) | `Choice colors can only be set on a dropdown or multi-select field.` |
    | Not an object (a list, string, number, boolean) | `Choice colors must be an object mapping a choice to a color.` |
    | `null` | `This field may not be null.` |
    | More than 100 entries (the per-field choice cap) | `At most 100 choice colors are allowed.` |
    | A key containing NUL (`\u0000`) | `Choice color keys must be choice names without NUL (0x00) characters.` |
    | A value that is not one of the palette keys (including hex, other case, or a non-string) | `Choice colors must be one of: slate, blue, green, amber, red, violet, pink, teal.` |

- **Rendering (the web UI's rule, recommended for other clients):** a value whose choice
  has a known color key renders as a tinted badge **with its text label** — color never
  carries meaning alone. A value that is no longer a choice (an orphan), or a key the
  client does not recognize (one added by a newer server), renders neutral, label shown.
- **Export.** The JSON export's `custom_fields` and `swimlane_custom_fields` entries carry
  `choice_colors` (additive — `schema_version` is unchanged; `choices` is unchanged). Card
  and swimlane values are unchanged in JSON and CSV. A non-admin exporter does not receive
  an `is_admin_only` swimlane definition at all, colors included.
- **Events.** `custom_field.created` / `custom_field.updated` and
  `swimlane_custom_field.created` / `swimlane_custom_field.updated` carry the full
  definition, so `choice_colors` arrives with them (an additive field).

### `GET /api/v1/boards/{id}/custom-fields/`
List the board's custom field definitions in `position` order. Available to **all board members, including viewers**, who need the schema to read the values they already see. Paginated with the project-wide offset pagination.

### `GET /api/v1/boards/{id}/custom-fields/{field_id}/`
Get a single definition. Available to all board members.

### `POST /api/v1/boards/{id}/custom-fields/`
Create a definition. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Request** `{ "name": "Array Type", "field_type": "dropdown", "choices": ["raid6", "raid10"], "show_on_card": true }`

A number field may also carry display-only formatting — see [Number formatting](#number-formatting):
`{ "name": "Budget", "field_type": "number", "number_prefix": "$", "number_suffix": " USD", "number_decimals": 2 }`

A dropdown or multi-select field may also color its choices — see [Choice colors](#choice-colors):
`{ "name": "Severity", "field_type": "dropdown", "choices": ["Low", "High"], "choice_colors": { "High": "red" } }`

`position` is server-assigned (appended to the end) and ignored if supplied.

**Errors:**
- `400 Bad Request` if the name is blank or already used on this board, a dropdown or
  multi-select has no choices, a type that cannot carry choices supplies them, a
  non-number type supplies a [number format](#number-formatting) option, a number format
  option is out of range, `choice_colors` is malformed or set on a type without choices
  (see [Choice colors](#choice-colors)), the board already has 30 definitions, or a
  third field is pinned with `show_on_card`.

### `PATCH /api/v1/boards/{id}/custom-fields/{field_id}/` / `PUT /api/v1/boards/{id}/custom-fields/{field_id}/`
Update a definition. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Writable fields:** `name`, `field_type`, `choices`, `show_on_card`, `is_required`, `help_text`, `number_prefix`, `number_suffix`, `number_decimals`, `choice_colors`

`PATCH` and `PUT` are both accepted. `PATCH` changes only the fields you send and is the one to use for a rename or a single-option change. `PUT` requires `name`; any other writable field you leave out keeps its current value, it is not reset to its default. Every rule and error below applies to both.

> Removing (or renaming) a choice on a dropdown or multi-select does **not** rewrite cards
> that already hold it: the stored value keeps reading back. A dropdown value that is no
> longer a choice can no longer be written again; a multi-select entry that is no longer a
> choice may be re-written on the same card (kept alongside other edits) but not added
> anywhere else — see [Multi-select fields](#multi-select-fields).

> **Since 1.2:** `field_type` is frozen once any card holds a value for the field, because a stale `CustomFieldValue` is never revalidated or migrated against a new type and a change would corrupt it silently. Delete and recreate the field to change its type once it has values. A field with zero values may still change type freely. This release has no `text` → `dropdown` (or any other) conversion path.

**Errors:**
- `400 Bad Request` if `field_type` is changed on a definition that already has at least
  one `CustomFieldValue`.
- `400 Bad Request` for a [number format](#number-formatting) option on a non-number field
  (judged against the stored `field_type` when the body does not change it), or out of
  range.
- `400 Bad Request` with a `choice_colors` key for a malformed map, an unknown palette key,
  or a non-empty map on a type without choices — see [Choice colors](#choice-colors).
  Renaming or removing a choice prunes its color; retyping away from a choice type clears
  the map.

### `DELETE /api/v1/boards/{id}/custom-fields/{field_id}/`
Delete a definition. Requires board admin. **Every card's value for that field is deleted
with it.**

### `POST /api/v1/boards/{id}/custom-fields/reorder/`
Reorder definitions. Requires board admin. `POST` only, like the column and swimlane reorder actions; since 1.2 (#1868) `PUT` returns `405 Method Not Allowed`. (`PUT` was accepted briefly in the 1.2 pre-releases and never shipped in a GA release.)

Since 1.2, a request body that is not a JSON object returns `400 Bad Request`, and since 1.2 so does an entry beyond the 64-bit integer range (each returned `500` before); non-integer entries were already a `400`.

**Request** `{ "order": [3, 1, 2] }` — custom field IDs in the new order. IDs belonging to
another board are ignored.

**Response** the full list in the new order.

---

## Swimlane custom fields (since 1.2)

Typed, per-board metadata fields that **swimlane rows** can carry — the row-level
counterpart to [Custom fields](#custom-fields-since-12) above. A swimlane represents an
entity (an account, a customer, a project), and this is the typed alternative to stuffing
everything into `notes` as unstructured prose. A board's definitions are also returned on
`GET /api/v1/boards/{id}/full/` as `swimlane_custom_field_definitions`, so a client has the
schema on board load. Row **values** are read and written through the
[swimlane endpoints](#swimlanes) as `custom_field_values`, not here — this section covers
the schema only.

Card custom fields and swimlane custom fields are independent per-board sets with
independent name uniqueness: a card field and a row field may share the same `name` on the
same board.

Definition objects include a `uid` field — stable across renames, read-only.

**Limits:** at most **15** definitions per board, and at most **3** with `show_on_row:
true`. These caps are deliberately different from the card-level field's 30/2 — see the
model docstring for the reasoning; do not assume they track each other.

| Field | Type | Read-only | Description |
|---|---|---|---|
| `id` | integer | yes | Database primary key |
| `uid` | string | yes | Stable 16-character hex UID |
| `name` | string | no | Field name; unique within the board's swimlane fields (a card field may reuse the same name) |
| `field_type` | string | no | One of `"text"`, `"number"`, `"date"`, `"dropdown"`, `"checkbox"`, `"url"` (see [URL fields](#url-fields)), `"multi_select"` (see [Multi-select fields](#multi-select-fields)). Immutable once any swimlane holds a value for this definition — see **Errors** below. |
| `choices` | string[] | no | Permitted values; required, non-empty (at most 100, unique) for `"dropdown"` and `"multi_select"`, rejected for every other type |
| `position` | integer | yes | Display order; set on create and changed only via `reorder/` |
| `show_on_row` | boolean | no | Pin the value to the swimlane row header. Max 3 per board |
| `is_admin_only` | boolean | no | When `true` (the default), this field's **values** are served only to `admin` and `site_admin` role members and are omitted entirely from share-link payloads. Does not affect who can read the *definition* — see [Swimlanes](#swimlanes) for the values visibility rule. |
| `is_required` | boolean | no | Declared but **not enforced** in this release |
| `help_text` | string | no | Hint shown next to the input |
| `number_prefix` | string | no | *Since 1.2.* Display-only text before a number value; `""` (default) for none. `"number"` fields only — see [Number formatting](#number-formatting) |
| `number_suffix` | string | no | *Since 1.2.* Display-only text after a number value; `""` (default) for none. `"number"` fields only |
| `number_decimals` | integer \| null | no | *Since 1.2.* Fixed decimal places (0–10) for display; `null` (default) shows the number as typed. `"number"` fields only |
| `choice_colors` | object | no | *Since 1.2.* Display-only `{choice: palette_key}` map; `{}` (default) for none. `"dropdown"` and `"multi_select"` fields only — see [Choice colors](#choice-colors) |
| `created_at` | string | yes | ISO 8601 creation timestamp |

### `GET /api/v1/boards/{id}/swimlane-custom-fields/`
List the board's swimlane custom field definitions, in `position` order. Available to **all
board members, including viewers** — a reader needs the schema to make sense of the values
they can already see. This lists the schema regardless of `is_admin_only`; it is the
*values* that are withheld from non-admins, not the field's existence. Paginated with the
project-wide offset pagination.

### `GET /api/v1/boards/{id}/swimlane-custom-fields/{field_id}/`
Get a single definition. Available to all board members. A definition `id` belonging to
another board returns `404 Not Found`.

### `POST /api/v1/boards/{id}/swimlane-custom-fields/`
Create a definition. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Request** `{ "name": "Account Tier", "field_type": "dropdown", "choices": ["Startup", "Growth", "Enterprise"], "show_on_row": true, "is_admin_only": true }`

A number field may also carry display-only formatting — see [Number formatting](#number-formatting):
`{ "name": "ARR", "field_type": "number", "number_prefix": "$", "number_suffix": "", "number_decimals": 0 }`

A dropdown or multi-select field may also color its choices — see [Choice colors](#choice-colors):
`{ "name": "Account Tier", "field_type": "dropdown", "choices": ["Startup", "Enterprise"], "choice_colors": { "Enterprise": "violet" } }`

`position` is server-assigned (appended to the end) and ignored if supplied.

**Errors:**
- `400 Bad Request` if the name is blank or already used on this board's swimlane fields, a
  dropdown or multi-select has no choices, a type that cannot carry choices supplies them,
  a non-number type supplies a [number format](#number-formatting) option, a number format
  option is out of range, `choice_colors` is malformed or set on a type without choices
  (see [Choice colors](#choice-colors)), the board already has 15
  swimlane field definitions, or a ninth field is pinned with `show_on_row`.

### `PATCH /api/v1/boards/{id}/swimlane-custom-fields/{field_id}/` / `PUT /api/v1/boards/{id}/swimlane-custom-fields/{field_id}/`
Update a definition. Requires board admin. *(1.3+, #2009)* A caller below admin gets `403` before the body is validated, so an invalid body no longer answers `400` with the field errors for them; a caller with no access to the board still gets `404`.

**Writable fields:** `name`, `field_type`, `choices`, `show_on_row`, `is_admin_only`, `is_required`, `help_text`, `number_prefix`, `number_suffix`, `number_decimals`, `choice_colors`

`PATCH` and `PUT` are both accepted. `PATCH` changes only the fields you send. `PUT` requires `name`; any other writable field you leave out keeps its current value, it is not reset to its default. Every rule and error below applies to both.

**Errors:**
- `400 Bad Request` with a `field_type` key if the request changes `field_type` and at
  least one swimlane already holds a value for this definition. A definition with zero
  values stays freely editable. There is no `text` → `dropdown` (or other) conversion path —
  clear the field's values first, or create a new definition.
- `400 Bad Request` with a `name` key if the new name collides with another swimlane field
  on this board.
- `400 Bad Request` keyed by the offending field for a [number format](#number-formatting)
  option on a non-number field, or out of range. Retyping a definition away from
  `"number"` clears its format options.
- `400 Bad Request` with a `choice_colors` key for a malformed map, an unknown palette key,
  or a non-empty map on a type without choices — see [Choice colors](#choice-colors).
  Renaming or removing a choice prunes its color; retyping away from a choice type clears
  the map.

> Removing (or renaming) a choice on a dropdown or multi-select does **not** rewrite rows
> that already hold it: the stored value keeps reading back. A dropdown value that is no
> longer a choice can no longer be written again; a multi-select entry that is no longer a
> choice may be re-written on the same swimlane but not added anywhere else — see
> [Multi-select fields](#multi-select-fields).

### `DELETE /api/v1/boards/{id}/swimlane-custom-fields/{field_id}/`
Delete a definition. Requires board admin. **Every swimlane's value for that field is
deleted with it.**

### `POST /api/v1/boards/{id}/swimlane-custom-fields/reorder/`
Reorder definitions. Requires board admin. `POST` only, like the column, swimlane, and card-custom-field reorder actions; since 1.2 (#1868) `PUT` returns `405 Method Not Allowed`. (`PUT` was accepted briefly in the 1.2 pre-releases and never shipped in a GA release.)

Since 1.2, a request body that is not a JSON object returns `400 Bad Request`, and since 1.2 so does an entry beyond the 64-bit integer range (each returned `500` before); non-integer entries were already a `400`.

**Request** `{ "order": [5, 3, 4] }`: swimlane custom field IDs in the new order. IDs from another board are silently ignored, neither reordered nor exposed.

**Response** the full list in the new order.

---

## Public share endpoint

### `GET /api/share/{token}/`
Returns a read-only board payload identified by its UUID share token. No authentication is required.

**Authentication:** none required (public endpoint).

**Rate limiting:** 120 requests/hour per IP, plus a 240 requests/hour per-token limit as defense in depth against CGNAT/proxy-pool abuse of a single link. Exceeding either returns `429 Too Many Requests`.

**Errors:**
- `404 Not Found` if the token is invalid, has been revoked, or does not exist. *(1.2+, #1865)* Also when the admin who enabled the link is no longer active or no longer an admin of the board; the link is cleared on that read and does not come back if the account regains admin. This is checked before the expiry, so such a link answers `404` even after its expiry has passed. *(1.2+, #1939)* Also when the link has no recorded enabler (enabled before the enabler was recorded (for example under 1.1, or 1.2.0-beta.3 and earlier)), with the same response; the link is cleared on that read.
- `410 Gone` if the token's TTL has elapsed (an admin set an expiry at enable time and it has passed). The token is *not* auto-rotated: an admin must disable and re-enable sharing for a fresh link. Body: `{"detail": "This share link has expired."}`. Added in 1.1 (#804).

**Response**
```json
{
  "uid": "a1b2c3d4e5f60001",
  "name": "Sales Pipeline",
  "columns": [
    {
      "id": 1,
      "uid": "c0l0abc123456701",
      "name": "Backlog",
      "position": 0,
      "color": "#64748B",
      "wip_limit": null,
      "weight_limit": null,
      "allow_card_creation": true,
      "is_done": false
    }
  ],
  "swimlanes": [
    { "id": 1, "uid": "sw1mabcdef123401", "name": "Acme Corp", "position": 0, "color": "#3B82F6", "is_collapsed": false, "created_at": "2026-03-01T10:00:00Z" }
  ],
  "cards": [
    {
      "uid": "crd0abc123456701",
      "column": 1,
      "swimlane": 1,
      "title": "Fix login bug",
      "priority": "high",
      "assignee": { "display_name": "Alice" },
      "labels": [{ "id": 3, "name": "Bug", "color": "#EF4444" }],
      "due_date": "2026-04-01",
      "weight": 2,
      "position": 0,
      "last_moved_at": "2026-03-25T14:30:00Z",
      "checklist_total": 3,
      "checklist_done": 1,
      "is_stale": false,
      "blocker_count": 1
    }
  ],
  "labels": [
    { "id": 3, "name": "Bug", "color": "#EF4444" }
  ]
}
```

Response fields:

| Field | Type | Description |
|---|---|---|
| `uid` | string | Board stable 16-char hex UID |
| `name` | string | Board name |
| `columns` | array | Column objects; includes `is_done` flag (see Columns section). `policy` (since 1.3) is never included — a structural omission, as for swimlane contact details |
| `swimlanes` | array | Swimlane objects; `contact_email`, `notes`, and `custom_field_values` (since 1.2) are never included — a structural omission, not an `is_admin_only` filter, since the visitor is unauthenticated |
| `cards` | array | Active (non-archived) card objects |
| `labels` | array | Label objects |

Public card objects use `uid` as the identifier and carry no database `id`. `assignee` holds `display_name` only (email, username, and avatar are omitted), or `null` for an unassigned card. Comments and checklist item text are excluded; only the `checklist_total` and `checklist_done` counts appear. The `is_stale` field is `true` when the card has not moved within the board's `staleness_threshold_days` window. `is_stale` ignores the card's column, so a Done-column card can be `true`; clients decide display. The stale-card notification digest, by contrast, skips Done-column cards.

`blocker_count` (since 1.2) is the number of active cards blocking this one — see [Card relations](cards.md#relations-since-12). The count is included, but the relation list is not: relations are same-board only, so every blocker is a card this payload already carries, whereas the relation rows themselves carry the creating user and a timestamp that this payload deliberately excludes.

## Color values

> **Changed in 1.3**

`color` on columns, swimlanes, board labels, and [group labels](groups.md) is stored as text of up to 7 characters. Since 1.3 every write checks it:

- `#RRGGBB` is accepted as sent. The server does not change its case.
- `#RGB` is accepted and stored expanded, digit by digit: `#abc` is stored as `#aabbcc`.
- Anything else (`red`, `#12345`, `#GGGGGG`, an empty string) returns `400 Bad Request` with the error under `color`.
- A value equal to the one already stored is accepted unchanged. Rows saved before 1.3 can hold a non-hex color, and clients resend the current color when they rename a row; those edits keep working. Changing such a row to a different non-hex value is `400`.
- Responses are unchanged: no `pattern` is published for `color`, because existing rows may not match it.
- [JSON board import](#post-apiv1boardsimport) does not fail on a non-hex color. It stores the default for that field (`#6B7280` for a column, `#3B82F6` for a swimlane, `#EAB308` for a label), expands `#RGB`, and counts each replacement in `import_summary.skipped.colors`. A color longer than 7 characters is still `400`.
- Board templates and Trello imports apply the same rule and fall back to the default.
- The Django admin forms for columns, swimlanes, and labels (superuser-only) apply the same rule: a non-hex color is refused with a field error, and an unchanged legacy value still saves.
