# Groups API

Groups organize boards into a hierarchy — subgroups, shared members, shared labels, and board defaults. Shared labels and `allowed_priorities` are copied onto boards created in the group; the default member role is deprecated and has no effect ([#1430](https://gitlab.com/visiban/visiban/-/issues/1430)).

## Groups

### `GET /api/v1/groups/`
**Response** — the standard [paginated envelope](index.md#pagination) `{ "count", "offset", "page_size", "results": [ ...groups ] }`. It accepts `?offset` (default `0`) and `?page_size` (default `50`, max `200`); read the groups from `results`, not from the top level.

List all groups accessible to the current user: groups they belong to, their subgroups, and the ancestors of those groups (so a client can render the path to a subgroup). *(1.2+)* Only a membership with one of the four roles (`admin`, `member`, `collaborator`, `viewer`) counts; a stored membership with any other role value (one no API accepts, written by a direct database edit or an older import) grants no group access, lists no group, and does not admit the user to the [group channel](websockets.md#group-channel-since-11), the same as it grants no board role. Owning a group without such a membership does not list it either (#1829); every owner holds an `admin` membership, see [Members](#members). A group the user has no access to itself (no membership in it or in one of its ancestors), returned only so navigation (tree, breadcrumbs) keeps working — typically an ancestor of one of their groups — is returned navigation-only, with its fields withheld: each such row has `navigation_only: true`, `description: ""`, `member_count`, `board_count` and `subgroup_count` of `0`, and empty `shared_labels` and `allowed_priorities` — see [Ancestor groups](#ancestor-groups-navigation-only). For example, a user whose only membership is the subgroup `Platform` receives its parent like this (shown as a full response):

```json
{
  "count": 1,
  "offset": 0,
  "page_size": 50,
  "results": [
    {
      "id": 1,
      "name": "Engineering",
      "description": "",
      "owner": { "id": 3, "username": "maya", "display_name": "Maya", "avatar_url": "" },
      "parent": null,
      "parent_name": null,
      "member_count": 0,
      "board_count": 0,
      "subgroup_count": 0,
      "created_at": "2026-01-05T09:00:00Z",
      "default_board_member_role": "member",
      "allowed_priorities": [],
      "shared_labels": [],
      "is_starred": false,
      "navigation_only": true,
      "can_place_boards": false
    }
  ]
}
```

!!! note "Response shape differs from `GET /api/v1/groups/{id}/`"
    The list endpoint uses a leaner `GroupSerializer` that **does not** include the `ancestors` field — only the single-object retrieve endpoint (`GET /api/v1/groups/{id}/`) returns `ancestors`. Clients iterating the list and reading `entry.ancestors` will get `undefined`. Fetch the single group if you need the ancestor chain.

### `POST /api/v1/groups/`
Create a group. Any authenticated user may create a top-level group. Creating a subgroup requires admin of the parent (directly or through an ancestor group). The endpoint returns the same `400 Bad Request` for an unknown `parent` id and for a parent the caller does not administer: `{"parent": ["Select a parent group you administer."]}`, the same body `PATCH` uses. *(1.2+)* A subgroup that would sit more than 6 levels deep is refused with `400 Bad Request`: `{"parent": ["Groups can be nested at most 6 levels deep."]}`, the same limit and message a `PATCH` parent change uses. A parent exactly 5 levels deep accepts a new subgroup (level 6); a parent 6 levels deep does not. Existing deeper trees are not changed.

> **Added in 1.2**

A subgroup create that arrives while its parent (or an ancestor of it) is being deleted waits for the delete to finish and then answers the same `400` as for an unknown `parent`, with nothing created; a delete that arrives while the create is in flight waits for it and then deletes the new subgroup with the rest of the tree (#1719).

**Request**
```json
{ "name": "Engineering", "description": "Backend and frontend teams.", "parent": 1 }
```

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Display name |
| `description` | No | Optional free-text summary |
| `parent` | No | Parent group ID; omit for a top-level group |

### `GET /api/v1/groups/{id}/`
Get group details.

**Response fields:**

| Field | Type | Description |
|---|---|---|
| `id` | integer | Group ID |
| `name` | string | Display name |
| `description` | string | Optional free-text summary. Empty string if not set. |
| `parent` | integer\|null | Parent group ID, or `null` for top-level groups |
| `parent_name` | string\|null | Parent group display name (convenience field), or `null` |
| `owner` | object | `{ "id", "username", "display_name", "avatar_url" }` |
| `member_count` | integer | Total number of direct members (does not include inherited) |
| `board_count` | integer | Number of boards directly in this group |
| `subgroup_count` | integer | Number of direct subgroups |
| `is_starred` | boolean | Whether the requesting user has starred this group |
| `shared_labels` | array | Labels shared across all boards in this group |
| `default_board_member_role` | string | Returned for navigation-only groups as well (see [Ancestor groups](#ancestor-groups-navigation-only)). **Deprecated (#1430).** Has no effect and is kept only for API compatibility; marked `deprecated: true` in the OpenAPI schema. Stored but not read by any code path; group members' board access comes from their group role (scaffold, see [Field Enforcement](../architecture/field-enforcement.md)) |
| `allowed_priorities` | array | **Advisory.** Copied onto a board's `allowed_priorities` when the board is created through `POST /groups/{id}/boards/`; it does not restrict card priorities, because the board-level field is not enforced either. Empty array means all priorities allowed. Duplicate entries are silently de-duplicated (order of first occurrence is kept); a submitted list longer than 100 entries is rejected with `400 Bad Request`. |
| `ancestors` | array | Ordered list of ancestor groups from root to immediate parent. Each entry is `{ "id": 1, "name": "Acme Corp" }`. Empty for top-level groups. **Only present on this single-object retrieve endpoint** — the list endpoint (`GET /api/v1/groups/`) omits `ancestors`. |
| `created_at` | string | ISO 8601 timestamp |
| `navigation_only` | boolean | *(1.2+)* `true` when the requesting user has no access to this group itself and it is returned only so navigation (tree, breadcrumbs) keeps working; its fields are withheld. See [Ancestor groups](#ancestor-groups-navigation-only). |
| `can_place_boards` | boolean | *(1.2+)* `true` when the requesting user may place a board in this group — create one through [`POST /groups/{id}/boards/`](#post-apiv1groupsidboards), move one in with `POST /boards/{id}/move-group/`, or import one into it. See [Board placement](#board-placement-can_place_boards). |

#### Board placement (`can_place_boards`)

> **Added in 1.2**

Placing a board in a group requires the group admin role on that group or on one of its ancestors (within the 6-level walk), or access to all content. `can_place_boards` reports that rule for the requesting user, computed with the same check the server applies to those writes, so a client can disable groups it would refuse instead of waiting for a `403`. It is returned on every REST response that carries a group object (list, retrieve, `/subgroups/`, create, update, `board-defaults`, `transfer-ownership`, and the invite join response); the list computes it for every row with one query. A navigation-only group is always `false`. For example, a member of `Engineering` who administers only its subgroup `Platform` receives:

```json
[
  { "id": 1, "name": "Engineering", "parent": null, "navigation_only": false, "can_place_boards": false },
  { "id": 2, "name": "Platform", "parent": 1, "navigation_only": false, "can_place_boards": true }
]
```

(Other fields omitted.) The value describes the requesting user, so it is REST-only: `group.*` WebSocket event payloads do not carry `can_place_boards`, because one frame goes to every subscriber of the group. Re-read it over REST when a group event arrives.

#### Ancestor groups (navigation-only)

> **Added in 1.2**

Group access is inherited downward only: membership in a subgroup grants nothing on its parent. The list and retrieve endpoints still return the ancestors of a user's groups so clients can render the sidebar tree and breadcrumbs, but a group the user has no access to itself — not a member of it or of one of its ancestors within the 6-level walk — is returned with `navigation_only: true` and these fields withheld (set to empty values):

| Field | Value for a navigation-only group |
|---|---|
| `description` | `""` |
| `member_count`, `board_count`, `subgroup_count` | `0` |
| `shared_labels` | `[]` |
| `allowed_priorities` | `[]` |

`id`, `name`, `parent`, `parent_name`, `owner`, `created_at`, `default_board_member_role`, `is_starred` and (on retrieve) `ancestors` are returned as for a member. `default_board_member_role` is returned intentionally: it is a required enum with no empty value, it is deprecated with no effect, and it is not sensitive. Ownership alone does not count as membership here, the same as for the nested routes and *(1.2+)* the list itself, which no longer returns a group only because the caller owns it (#1829). `owner` (public profile fields only, no email) is returned because clients require it; an ancestor's owner is normally also a member there, but an owner whose membership was removed is still named. Every key stays in the response with a value of its documented type, so existing clients keep parsing it; read `navigation_only` to tell withheld values from real zeros. This matches the nested routes, which already answer `403` to such a user (`/members/`, `/boards/`, `/subgroups/`, `/labels/`, `/descendant-boards/`, `/descendant-boards/paged/`, `/star/`), and the group WebSocket channel, which does not admit them. Users with access to all content always receive every field.

**Backward compatibility:** before 1.2 these fields carried the ancestor's real values for this role; no key was removed or retyped.

### `PUT /api/v1/groups/{id}/` / `PATCH /api/v1/groups/{id}/`
Update group fields. Both `PUT` and `PATCH` are accepted. Requires group admin.

**Writable fields:** `name`, `description`, `parent`, `default_board_member_role`, `allowed_priorities`. The latter two duplicate what [`PATCH /groups/{id}/board-defaults/`](#board-defaults) does — either endpoint can set them.

**Changing `parent`** *(1.2+)*. Sending the group's current `parent` value is not a change and needs nothing beyond group admin. A change is accepted only when, in this order:

1. **Authority over the group's place in the tree** — required for every change, to another group or to top level (`"parent": null`): the caller is the group's owner, an admin of one of its current ancestor groups, or has access to all content. An admin of the group itself, without one of those, cannot change its parent. A top-level group has no ancestors, so only its owner (or a user with access to all content) can move it under another group.
2. **Admin of the new parent** — when moving under another group: the caller is also an admin of the new parent group (directly or through one of its ancestors), the same check `POST /api/v1/groups/` applies to a new subgroup.
3. **Structure** — the new parent is not the group itself or one of its subgroups, and the resulting tree is at most 6 levels deep, counting the moved group's own subgroups.

Changing `parent` revokes unused invite links in the moved subtree whose creator no longer administers the link's group through the new ancestor chain (see [Invite links](#invite-links)).

**Errors:**

| Status | When |
|---|---|
| `400 Bad Request` | `{"parent": ["Select a parent group you administer."]}` — the caller passes rule 1, and `parent` names a group they do not administer or an ID that does not resolve to a group (the same response in both cases). `{"parent": [...]}` — the new parent is the group itself or one of its subgroups, or the move would nest groups more than 6 levels deep (on `POST`, a new subgroup more than 6 levels deep: `{"parent": ["Groups can be nested at most 6 levels deep."]}`). Also the usual per-field validation errors |
| `403 Forbidden` | The caller is not a group admin; or the request changes `parent` (to any value, including an ID that does not resolve) and the caller fails rule 1 |
| `404 Not Found` | The caller cannot see the group being updated |

> **Added in 1.2**

An update that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1719). A `parent` that is deleted meanwhile answers the unknown-parent `400`.

### `DELETE /api/v1/groups/{id}/`
Delete a group. Requires group owner or site admin. A group member who is not the owner gets `403 Forbidden` with `{"detail": "Only the group owner can delete this group."}`; a caller who cannot see the group at all gets `404`.

> **Added in 1.2**

A delete that arrives while the same group is being deleted, or while an invite to it (or to one of its subgroups) is being redeemed or a board is being placed in it or one of its subgroups, waits for that request to finish. A second delete of the same group then answers `404`, and a delete that waited behind an ownership transfer away from the caller answers `403` (#1638). It also waits for an in-flight write to the group or its subgroups — a subgroup create, an update, a board-defaults or member role change, an invite link create, send or revoke, a label create or update, a star, an ownership transfer, or a board import into the group — and then proceeds against what that write left: it deletes the new or changed rows with the group, detaches an imported board from it (the board itself is kept), and answers `403` if the write was an ownership transfer away from the caller (#1719).

---

## Members

### `GET /api/v1/groups/{id}/members/`
List group members. Requires group membership.

**Response** — array of member objects:

| Field | Type | Description |
|---|---|---|
| `id` | integer / null | Membership record ID. `null` for inherited members — access via an ancestor group's membership rather than a direct row on this group. A group's owner holds a direct `admin` `GroupMembership` row: it is created with the group, kept by [Transfer ownership](#transfer-ownership) (which requires the new owner to already be a direct admin and keeps the previous owner as one), and the owner's membership cannot be removed or demoted. *(1.2+)* Upgrading restores that row on any group whose owner lacked it, promoting an existing membership or adding one, so the owner's `id` here is not `null`. A site admin with no membership of their own does not appear in this list at all. Callers must not assume this field is always an integer. |
| `user` | object | `{ "id", "username", "display_name", "avatar_url" }` |
| `role` | string | Effective role on this group: `admin`, `member`, `collaborator`, or `viewer` |
| `joined_at` | string / null | ISO 8601 timestamp of when the membership was created; `null` for inherited members |
| `is_inherited` | boolean | `true` when the member's access comes from a parent (ancestor) group rather than a direct membership on this group |
| `inherited_from` | string / null | Display name of the ancestor group that grants access, when `is_inherited` is `true`; `null` otherwise |

### `PATCH /api/v1/groups/{id}/members/{user_id}/`
Change a member's role. Requires group admin. Cannot modify the membership of a site admin who is a member of the group. The target must already have a membership in the group (the role of an inactive member can be changed); otherwise the response is the same `404 Not Found` whether the id is unknown, belongs to an inactive user, or belongs to an active user who is not a member.

**Request** `{ "role": "admin" }` (`role` is required and is the only key read)

Valid roles: `admin`, `member`, `collaborator`, `viewer`

**Response** `200 OK` with the membership `{ "id", "user", "role", "joined_at" }`. Unlike the rows of `GET .../members/`, it carries no `is_inherited` or `inherited_from`.

Since 1.2, a request body that is not a JSON object returns `400 Bad Request` (it returned `500` before). A non-numeric `{user_id}` in the path is `404`, as before.

> **Added in 1.2**

Changing a member's role away from `admin` revokes their unused [invite links](#invite-links) in this group and its subgroups that they can no longer administer (for example through another admin membership on an ancestor), and each revoked link emits `invite_link.revoked` on its group's channel. This frees their slots under the 5-active-link cap. *(1.2+)* It also turns off the public [board share links](boards.md#board-sharing) the member enabled on boards where they are no longer a board admin by another route, and each affected board receives a `board.updated` event.

> **Added in 1.2**

A role change that would demote the group owner, or demote the group's last active admin, returns `400 Bad Request` with a `detail` message and a machine-readable `code`, and writes nothing:

| `code` | `detail` | Condition |
|---|---|---|
| `group_owner_protected` | `The group owner's membership cannot be removed or demoted. Transfer ownership first.` | The target is the group owner |
| `group_last_admin` | `A group must keep at least one admin.` | The target is the group's last active admin |

Branch on `code`, not on the `detail` text, which may be reworded. Other `400`s from this endpoint (a missing or invalid `role`, a body that is not a JSON object) carry `detail` only.

Setting the owner's role to `admin` is accepted. Only active admins count toward the minimum; a deactivated admin does not. The check runs under row locks, so two requests that would each demote a different one of two admins cannot both succeed.

> **Added in 1.2**

A role change that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1719). The same `404` answers a role change whose membership was removed while it waited.

### `DELETE /api/v1/groups/{id}/members/{user_id}/`
Remove a member. Requires group admin. Cannot remove a site admin who is a member of the group. *(1.2+)* A removal that arrives while the group is being deleted, or while another removal of the same member is in flight, waits for it to finish and then answers `404`, with nothing written. Returns `204` when the membership is removed; *(1.2+)* removing the group owner, or the group's last active admin, returns `400 Bad Request` with the same `{detail, code}` body as `PATCH` above, `code` being `group_owner_protected` or `group_last_admin` (the owner leaves through [Transfer ownership](#transfer-ownership) or by deleting the group); the `400` for the last admin also applies when the remaining admins are deactivated, because only active admins count; with no membership the response is the same `404 Not Found` as for `PATCH`, and an inactive member can be removed. *(1.2+)* The removed member's unused invite links in this group and its subgroups that they can no longer administer are revoked, with an `invite_link.revoked` event per link. *(1.2+)* Removing an admin membership also turns off the public [board share links](boards.md#board-sharing) the member enabled on boards where they are no longer a board admin by another route, with a `board.updated` event per board.

*(1.2+)* Deleting a user account removes all of that user's group memberships, so the Django admin's user delete applies the same minimum: it refuses to delete the last active admin of a group, or, in a bulk delete, every active admin of one. See [Django admin](../administration/django-admin.md).

---

## Subgroups

### `GET /api/v1/groups/{id}/subgroups/`
List direct subgroups of this group that are visible to the requesting user. Requires membership in this group or any ancestor group. Visibility follows the RBAC inheritance model: members of a parent group see all descendant subgroups (not only subgroups they have been added to directly) — see [Role Inheritance](../features/rbac/inheritance.md#visibility-of-descendant-groups) for the full rule.

**Response** — array of `Group` summary objects (same shape as the list endpoint; `ancestors` is omitted for parity with `GET /api/v1/groups/`).

---

## Boards

### `GET /api/v1/groups/{id}/boards/`
List boards in this group. Requires group membership.

A board is listed only when the caller's role on it resolves the same way as for board detail; a board the caller cannot open is not listed.

Pass `?expand=group` to populate `group_detail` on each board (see [Expanding foreign-key fields](index.md#expanding-foreign-key-fields)). *(1.2+)* The ancestor chain is resolved with one bulk fetch, so the query count does not grow with the number of boards (#1316).

### `POST /api/v1/groups/{id}/boards/`

Create a board in this group. Requires group admin. Boards created here inherit the group's `shared_labels` and `allowed_priorities` automatically. The seeded `allowed_priorities` value is not enforced on cards (see [Field Enforcement](../architecture/field-enforcement.md)).

> **Added in 1.2**

A create that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1638).

**Request**

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Board display name |
| `description` | No | Optional free-text description |
| `template` | No | Template slug to pre-populate columns. Valid values match those from `GET /api/v1/boards/templates/` (e.g. `simple_kanban`, `sales_pipeline`, `customer_support`). Default: `simple_kanban`. Omitting the field (or sending `""`/`null`) uses the default; a non-blank slug that doesn't match an active template returns `400 {"code": "unknown_template", "detail": "..."}` — same validation and error shape as `POST /api/v1/boards/` (#1115). |
| `swimlane_name` | No | Label for the swimlane axis (e.g. `"Customer"`, `"Team"`). Defaults to `"General"`; truncated to 255 characters |

Since 1.2, a body that is not a JSON object, or a non-string `swimlane_name`, returns `400 Bad Request` (a non-string `swimlane_name`, and a numeric or boolean body, returned `500` before).

### `GET /api/v1/groups/{id}/descendant-boards/`
List all boards in this group and all of its descendant subgroups that the requesting user can access. This answers "what boards live anywhere inside this group subtree?" — including boards in deeply nested subgroups. Requires group membership.

A board is listed only when the caller's role on it resolves the same way as for board detail; a board the caller cannot open is not listed. The same rule applies to `GET /api/v1/groups/{id}/boards/` and the paged variant.

**Response** — array of board summary objects (same shape as `GET /api/v1/groups/{id}/boards/`). Each board's `group_detail` is always populated with a `GroupBrief` payload including the `ancestors` chain, so callers can render a full relative breadcrumb without an extra request (#845). `ancestors` is root-first and does **not** include the board's direct parent group — that name is in `group_name`.

**Errors:** `404 Not Found` if the group does not exist or the caller cannot see it; `403 Forbidden` if the caller sees the group only as [navigation-only](#ancestor-groups-navigation-only) (a member of a descendant subgroup, not of this group or an ancestor).

This endpoint is never paginated: it returns the whole subtree in one array, and `offset` / `page_size` in the query string are ignored. For a root group in a large organization that can be every board the caller can see; use the paged variant below to fetch it in bounded pages.

### `GET /api/v1/groups/{id}/descendant-boards/paged/`

> **Added in 1.2**

The same boards as `GET /api/v1/groups/{id}/descendant-boards/`, with the same access rules and the same per-board payload (including `group_detail.ancestors`), returned in pages (#1317). Requires group membership. A board is listed only when the caller's role on it resolves the same way as for board detail.

**Query parameters**

| Param | Notes |
|---|---|
| `offset` | Zero-based row offset (default `0`). An invalid or negative value is treated as `0`. |
| `page_size` | Rows per page (default `50`, max `200`). An invalid, zero or negative value uses the default; a larger value is capped at `200`. |

Boards are ordered by `id`, oldest first. Editing a board in place (its name, description or settings) does not change its position, and a board created in the subtree during a walk is added at the end. Neither moves the boards already returned.

Other changes during a walk do shift the window, as with every offset-paginated endpoint:

- **Rows added before the current offset:** a board moved into the subtree (a `PATCH` of its `group`, or `POST /api/v1/boards/{id}/move-group/`), a subgroup re-parented into the subtree, or a newly granted membership that makes more of the subtree visible. These can insert earlier rows, so a board already returned can appear again on the next page.
- **Rows removed before the current offset:** a board deleted or moved out of the subtree, or access removed. These shift later rows back, so the next page can skip a board.

A client that needs an exact snapshot should de-duplicate by `id`, and re-read from `offset=0` if `count` changes between pages.

**Response** — the standard `{count, offset, page_size, results}` envelope (the same shape as every other paginated endpoint), where `results` is an array of board objects:

```json
{
  "count": 137,
  "offset": 50,
  "page_size": 50,
  "results": [
    {"id": 412, "name": "Q3 Roadmap", "group": 7, "group_name": "Platform", "group_detail": {"id": 7, "name": "Platform", "ancestors": [{"id": 1, "name": "Engineering"}]}, "...": "..."}
  ]
}
```

Fetch the next page with `offset + page_size` until it reaches `count`.

**Errors:** the same as `GET /api/v1/groups/{id}/descendant-boards/`: `404 Not Found` if the group does not exist or the caller cannot see it; `403 Forbidden` for a navigation-only caller.

---

## Invite links

A group can have up to 5 active shareable invite links. Each link has an independent name, role, and expiry. Links sent by email (`delivery: "email"`, below) are capped separately — up to 50 pending per group — and never count against the 5.

A link is revoked automatically (set inactive, freeing its slot, and announced as `invite_link.revoked`) when its creator is deactivated or deleted, loses group admin rights, or when a `parent` change moves the group so the creator no longer administers the link's group. Unused links only; a consumed single-use link is left alone. Join and preview independently refuse any link whose creator no longer qualifies, so nobody is admitted through a stale one.

Upgrade cleanup: on upgrade, unused links whose creator was already deleted or deactivated are deactivated once. **Not backfilled:** links whose creator still exists and is active but was demoted, removed, or moved out of administering the group before this fix (tracked in #1565). They stay listed as active and hold a slot until revoked manually, but still admit nobody.

Inherited group-admin rights (which decide whether a link's creator still counts as an admin, and which links are revoked on demotion) are considered only up to 6 ancestor levels; nesting deeper than that is not honored for these checks.

### `GET /api/v1/groups/{id}/invite-links/`
List all invite links for this group. Requires group admin.

### `POST /api/v1/groups/{id}/invite-links/`
Create a new invite link. Requires group admin.

**Request**
```json
{ "name": "Team link", "role": "member", "expiry_days": 7, "single_use": false }
```

All fields are optional. `single_use` (boolean, default `false`) creates a link that expires automatically after one person joins.

| Field | Values |
|---|---|
| `role` | `member` (default), `collaborator` or `viewer`. *(1.2+)* `admin` is refused with `400`: a shareable link is a bearer credential. An [emailed invite](#post-apiv1groupsidinvite-linkssend) is capped the same way. |
| `expiry_days` | *(1.2+)* An integer from `1` to `30`; defaults to `7` when omitted. `null` and values over `30` are refused with `400`: a shareable link always expires. Before 1.2 any positive integer or `null` (never expires) was accepted. |

Upgrading to 1.2 revokes unused shareable links that had the `admin` role and gives unused links with no expiry an expiry 7 days after the upgrade (#1940). Revoked links no longer appear in this list. A legacy non-admin link (member, collaborator or viewer) that already expires more than 30 days out keeps that expiry.

> **Added in 1.2**

A create that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1719). Two creates on the same group run one after the other, so they cannot together exceed the 5-active-link cap.

**Response (create only)** — the raw secret is returned once and never again, in a field named `token`:

!!! note "Field name differs from site invite links"
    Group and [board](boards.md#board-invites) invite-link create responses name the secret `token`. The site-wide [`POST /api/v1/admin/invite-links/`](admin.md#post-apiv1admininvite-links) response names the same kind of value `raw_token`. The names differ for historical reasons and are frozen by the 1.0 API contract: both are stable and will not be renamed before a major version. Read the field that matches the endpoint you called. A consistent alias is planned for the next major version (tracked in #1255); until then each endpoint keeps its current name for 1.0 API compatibility. The field is present only on this create response, never on list responses.

```json
{
  "id": 1,
  "token": "abc123raw",
  "prefix": "abc123ra",
  "name": "Team link",
  "role": "member",
  "is_active": true,
  "is_expired": false,
  "expires_at": "2026-04-07T00:00:00Z",
  "created_at": "2026-03-31T00:00:00Z",
  "created_by_username": "alice",
  "single_use": false,
  "used_at": null,
  "status": "pending",
  "delivery": "link"
}
```

**List response** — `token` is absent; `prefix` (first 8 chars) is shown for identification:
```json
{
  "id": 1,
  "prefix": "abc123ra",
  "name": "Team link",
  "role": "member",
  "is_active": true,
  "is_expired": false,
  "expires_at": "2026-04-07T00:00:00Z",
  "created_at": "2026-03-31T00:00:00Z",
  "created_by_username": "alice",
  "single_use": false,
  "used_at": null,
  "status": "pending",
  "delivery": "link"
}
```

| Field | Type | Description |
|---|---|---|
| `id` | integer | Invite link ID |
| `token` | string | Raw token — present **only** in the create response. The full token can never be retrieved later; admins identify links by `prefix`. |
| `prefix` | string | First 8 characters of the token, shown in the admin UI for audit. |
| `name` | string | Admin-assigned label for the link (e.g. "Engineering Slack"). |
| `role` | string | Role granted on redemption: `admin` / `member` / `collaborator` / `viewer`. *(1.2+)* No new invite grants `admin`, shareable or emailed. An `admin` value can appear only on a link created before the cap; such a link grants nothing (shareable ones are revoked on upgrade, #1940; emailed ones are refused at preview and join with `404`, and cannot register an account). |
| `is_active` | boolean | `true` until revoked. A consumed single-use link still shows `is_active: true` but cannot be redeemed again — see `status`. |
| `is_expired` | boolean | `true` once `expires_at` has passed. |
| `expires_at` | string / null | ISO 8601 expiry; `null` means never expires. Every link created in 1.2+ has an expiry, and upgrade gives unused legacy links one (#1940). |
| `created_at` | string | ISO 8601 timestamp. |
| `created_by_username` | string / null | Username of the admin who created the link (#1008). `null` if the creator's account has since been anonymized. |
| `single_use` | boolean | `true` if the link is consumed by the first redemption (cannot be reused). |
| `used_at` | string / null | ISO 8601 timestamp of consumption (single-use links only); `null` for multi-use or unredeemed. |
| `status` | string | Computed status: `pending` (active and unredeemed), `used` (single-use and consumed), `expired` (past `expires_at`), or `revoked` (admin disabled). *(#2006)* An unused link with the `admin` role also reports `revoked`: it was minted before invites were capped below admin and can never be redeemed. |
| `delivery` | string | `link` (created here and shared by an admin) or `email` (sent to one address by `POST …/invite-links/send/`). Added in 1.2. |

!!! note
    `revoked` is a real status value, but `GET /invite-links/` cannot return a link revoked by an admin — a revoked link's `is_active` is cleared and it is filtered out of the list. Once a link is revoked, it is gone from this endpoint entirely rather than kept around showing `status: "revoked"`.

### `POST /api/v1/groups/{id}/invite-links/send/`
> **Added in 1.2**

Email a single-use invite link to one address. Requires group admin.

**Request**
```json
{ "email": "new.person@example.org", "role": "member", "expiry_days": 7 }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | Yes | Recipient address. Surrounding spaces are stripped; an address containing a line break is rejected. The address itself is **never stored** or logged. *(1.2+)* The link keeps only a keyed hash of it, which binds the invite to that address (see `POST /api/v1/groups/join/{token}/`) and is never returned. |
| `role` | string | No | Role granted on join: `member` (default), `collaborator` or `viewer`. *(1.2+)* `admin` is refused with `400` and `{"role": ["\"admin\" is not a valid choice."]}`, nothing is minted and no email is sent: a forwarded or misdirected email must not mint a group admin. Make someone an admin by changing their role after they join. |
| `expiry_days` | integer | No | Days until the link expires, `1`–`30`. Default `7`. There is no "never expires" option for emailed links. |

The server mints a link with `single_use: true` and `delivery: "email"`, then sends a plain-text email naming the group, the join link (`<FRONTEND_URL>/join/<token>`) and the expiry date. There is no free-text message field.

**Response** `202 Accepted`
```json
{ "detail": "Invite sent", "sent_to": "new.person@example.org" }
```

The response is identical whether the address belongs to an existing member, an existing user who is not a member, or nobody — and the email is always sent — so this endpoint cannot be used to discover which addresses have accounts. The raw token is **never** returned; it exists only in the email. Under `DEBUG` with console mail delivery the response also carries `"delivery": "console"`.

**Errors**

| Status | Body | Reason |
|---|---|---|
| `400 Bad Request` | field errors | Invalid or missing `email`, address with a line break, `expiry_days` outside `1`–`30` or `null` |
| `400 Bad Request` | `{"code": "invite_email_cap_reached", ...}` | The group already has 50 pending emailed links (active, unexpired, unused; *(#2006)* an unusable `admin` invite does not count) |
| `403 Forbidden` | — | Caller is not a group admin |
| `403 Forbidden` | `{"code": "invite_email_disabled", ...}` | `INVITE_EMAIL_ENABLED=false`, or the instance runs in demo mode |
| `429 Too Many Requests` | — | Rate limit: 10 sends/hour per user, 30/day per group (shared by all its admins), 200/day instance-wide for group invites. Requests refused for another reason, and sends the mail server rejected, don't count |
| `502 Bad Gateway` | `{"code": "<error code>", ...}` | The mail server refused or could not be reached. The just-created link is revoked automatically. `code` is one of the sanitized SMTP codes (`auth_failed`, `connection_refused`, `dns_failure`, `tls_failure`, `timeout`, `config_unusable`, `unknown`) — never the raw server reply |

A successful send emits `invite_link.created` (payload `{ "id" }` only) on the group's WebSocket channel; a failed send emits `invite_link.revoked` for the auto-revoked link. See [WebSockets](websockets.md).

> **Added in 1.2**

A send that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1719). No email is sent.

### `DELETE /api/v1/groups/{id}/invite-links/{link_id}/`
Revoke a single invite link. Requires group admin. Works the same for shareable and emailed links.

**Errors**

| Status | Condition |
|---|---|
| `404 Not Found` | Link does not exist, or is already revoked |
| `400 Bad Request` | The link is a single-use link that has already been consumed — `{"detail": "This link has already been consumed and cannot be revoked."}` |

> **Added in 1.2**

A revoke that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1719). A revoke waits for a join through the same link that is in flight, and then answers the consumed-link `400` if that join used it.

---

## Favorites

### `POST /api/v1/groups/{id}/star/`
Star (favorite) a group. Requires group membership (any role) — not just authentication. Takes no request body.

**Response** `201 Created` with `{ "starred": true }` when the group was not starred yet, `200 OK` with the same body when it already was.

> **Added in 1.2**

A star that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1719).

### `DELETE /api/v1/groups/{id}/star/`
Unstar a group. Requires group membership (any role) — not just authentication. Returns `204 No Content`.

### `GET /api/v1/groups/?starred=true`
List only starred groups for the current user.

---

## Transfer ownership

### `POST /api/v1/groups/{id}/transfer-ownership/`
Transfer group ownership to another user. Requires the **current owner** (not just admin). There is no API route for administrators; a superuser can transfer a departed owner's group from the Django admin (see [Transferring a group's ownership](../administration/django-admin.md#transferring-a-groups-ownership)).

**Request**
```json
{ "new_owner_id": 42, "confirmation": "Engineering" }
```

- `new_owner_id` — the user ID of the new owner; must already be a group **admin**
- `confirmation` — must exactly match the group's name (case-sensitive) to prevent accidental transfers

Since 1.2, a `new_owner_id` that is not an integer, or is beyond the 64-bit integer range, returns `400 Bad Request` (it returned `500` before). A body that is not a JSON object was already a `400`.

The previous owner becomes a regular admin after transfer. Returns the updated group object.

**Error responses**
- `403 Forbidden` — you are not the current owner
- `400 Bad Request` — request body is not a JSON object
- `400 Bad Request` — confirmation does not match group name
- `400 Bad Request` — `new_owner_id` is not a member of this group
- `400 Bad Request` — `new_owner_id` is a member but not an admin
- `400 Bad Request` — the group's owner changed while the request was being processed (`Only the group owner can transfer ownership.`)
- `404 Not Found` *(1.2+)* — the group was deleted while the request waited for it (#1719)

---

## Group shared labels

Group labels are a shared label library. When a new board is created inside the group, it inherits the group's labels automatically.

### `GET /api/v1/groups/{id}/labels/`
List group shared labels. Requires group membership.

**Response** `[{ "id": 1, "name": "Bug", "color": "#EF4444" }, ...]`

### `POST /api/v1/groups/{id}/labels/`
Create a group shared label. Requires group admin.

**Request** `{ "name": "Feature", "color": "#3B82F6" }`

> **Added in 1.2**

A create that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1719).

### `PATCH /api/v1/groups/{id}/labels/{label_id}/`
Update a group shared label name or color. Requires group admin.

> **Added in 1.2**

An update that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1719). The same `404` answers an update of a label deleted while it waited; before, the update re-created the deleted label.

### `DELETE /api/v1/groups/{id}/labels/{label_id}/`
Delete a group shared label. Requires group admin. Does **not** remove the label from boards that already inherited it.

---

## Board defaults

### `PATCH /api/v1/groups/{id}/board-defaults/`
Update the board defaults for this group. `allowed_priorities` is copied onto boards created in the group; `default_board_member_role` is **deprecated (#1430)**: still accepted and stored, but it has no effect. Requires group admin. Only the two fields below are read; any other key in the body is ignored.

**Patchable fields**

| Field | Type | Description |
|---|---|---|
| `default_board_member_role` | string | **Deprecated (#1430).** `admin`, `member`, `collaborator`, or `viewer`. Accepted and stored, but has no effect — see the field table above |
| `allowed_priorities` | array / null | **Advisory.** Seeds `allowed_priorities` on new boards created in this group (e.g. `["low", "medium", "high"]`); `null` means all. Not enforced on cards — see the field table above |

**Request**
```json
{ "default_board_member_role": "member", "allowed_priorities": ["low", "medium", "high"] }
```

Returns the updated group object.

> **Added in 1.2**

A `PATCH` that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1719).

---

## Join (public)

### `GET /api/v1/groups/join/{token}/`
Resolve an invite token to a group name. No authentication required. Rate-limited to 10 requests/hour per IP — *(1.2+)* one budget shared with the [board join endpoints](boards.md#board-invites).

**Response** `{ "group_id": 5, "group_name": "Engineering", "role": "member", "can_register": true }`

| Field | Type | Description |
|---|---|---|
| `group_id` | integer | The link's group |
| `group_name` | string | The group's name |
| `role` | string | Role granted on join: `admin` / `member` / `collaborator` / `viewer` |
| `can_register` | boolean | **Added in 1.2** (#1481). Whether [`POST /api/v1/auth/registration/`](authentication.md) would accept this link as `invite_token` under the current registration mode: always `true` in `"open"` mode, always `false` in `"closed"` mode, and in `"invite_only"` mode `true` only for an unused, unexpired emailed single-use invite whose sender is still an active site admin and group admin while email invites are enabled. The value is the same for anonymous and authenticated callers. It is a bare boolean — the reason a link does not qualify is never disclosed. **Advisory only:** it can go stale before the registration request (the sender can lose site admin, the invite can be consumed, the mode can change), and registration re-checks and stays the enforcer. Clients should treat a missing field (older servers) as unknown, not `false`. |

**Disclosure:** `can_register` is visible to anyone holding the token, and its value can narrow down whether the site is closed, whether the link is an emailed single-use invite, and whether its sender still has admin rights. This is accepted under the token-as-capability model of this endpoint (#801): a token holder could learn the same thing by attempting registration with it. No reason, registration mode, delivery type or sender is ever returned.

`can_register` is present only on `200` responses, never on `404` / `410` bodies. A member previewing their own consumed single-use invite (below) gets `can_register: false` in `"invite_only"` mode. Site invite links (`vbnl_`) are out of scope: they are not group tokens, and the SPA routes them to the registration form without calling this endpoint.

**Errors:** `404 Not Found` (invalid or revoked token, or, *(1.2+)* the link's creator is no longer an active admin of the group — deactivated, removed, demoted or deleted — the same response, with no reason given, reported the same way whatever the link's other state: a link with a gone creator is `404` even if it is also expired or consumed. A link with a live creator still answers `410` for expired or consumed, so the two cases remain distinguishable to a token holder), `410 Gone` — `{"detail": "This invite link has expired."}` (past its expiry) or `{"detail": "This invite link has already been used."}` (single-use link already consumed)

*(1.2+, #1940)* A shareable (`delivery: "link"`) link with the `admin` role answers `404`, the same as a revoked link, and never previews or grants admin. Upgrade revokes the ones created before 1.2; this also covers one reactivated afterward. *(#2006)* An emailed `admin` invite sent before the cap answers `404` too; no invite grants admin.

> **Added in 1.2**

An authenticated caller who is already a member of the link's group gets `200` with the preview for a consumed single-use link instead of `410`. This is the path a newcomer takes after an emailed invite created their account (see [`POST /api/v1/auth/registration/`](authentication.md)); everyone else still gets `410`.

### `POST /api/v1/groups/join/{token}/`
Join the group with the role configured on the invite link. Requires authentication. Rate-limited to 10 requests/hour per IP, shared with the board join endpoints.

> **Added in 1.2** (#1678)

An emailed link (`delivery: "email"`) works only for an account with the address it was sent to. Otherwise the response is `403 {"code": "invite_recipient_mismatch", "detail": "This invite was sent to a different email address. ..."}`, nothing is written, and the link is not consumed. The same address rules apply as for [board invites](boards.md#post-apiv1boardsjointoken): verified addresses, plus the account's `email` unless `EMAIL_VERIFICATION=mandatory`, ignoring case. Shareable links and emailed links sent before upgrading to this version are not checked. Only a keyed fingerprint of the address is stored, and it is never returned.

**Response body** — returns the full group object (same shape as `GET /api/v1/groups/{id}/` but using the list serializer, without `ancestors`):

```json
{
  "id": 5,
  "name": "Engineering",
  "description": "Backend and frontend teams.",
  "owner": { "id": 1, "username": "alice", "display_name": "Alice Smith", "avatar_url": null },
  "parent": null,
  "parent_name": null,
  "member_count": 4,
  "board_count": 2,
  "subgroup_count": 1,
  "is_starred": false,
  "shared_labels": [],
  "default_board_member_role": "member",
  "allowed_priorities": [],
  "created_at": "2026-03-01T10:00:00Z"
}
```

**Status:** `201 Created` on first join; `200 OK` if the caller was already a member (existing role preserved, no downgrade).

**Note:** Existing memberships are not downgraded — if you already hold a higher role than the link's role, your current role is preserved.

**Errors:** `401 Unauthorized` (not authenticated), `404 Not Found` (invalid or revoked token, or, *(1.2+)* the link's creator is no longer an active admin of the group — deactivated, removed, demoted or deleted — the same response, with no reason given, reported the same way whatever the link's other state: a link with a gone creator is `404` even if it is also expired or consumed. A link with a live creator still answers `410` for expired or consumed, so the two cases remain distinguishable to a token holder), `410 Gone` — `{"detail": "This invite link has expired."}` (past its expiry) or `{"detail": "This invite link has already been used."}` (single-use link already consumed by someone who is not a member)

*(1.2+, #1940)* A shareable (`delivery: "link"`) link with the `admin` role answers `404` and nothing is written, the same as a revoked link. *(#2006)* An emailed `admin` invite sent before the cap is refused the same way.

> **Added in 1.2**

If the caller is already a member of the link's group, a consumed single-use link returns `200` with the group, the same as any repeat join; the link is not re-stamped and the caller's role is unchanged.

> **Added in 1.2**

A join that arrives while the group is being deleted waits for the delete to finish and then answers `404`, with nothing written (#1638).
