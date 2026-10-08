# Groups API

Groups organize boards into a hierarchy — subgroups, shared members, shared labels, and board defaults. Shared labels and `allowed_priorities` are copied onto boards created in the group; the default member role is saved but not yet enforced.

## Groups

### `GET /api/v1/groups/`
List all groups accessible to the current user.

!!! note "Response shape differs from `GET /api/v1/groups/{id}/`"
    The list endpoint uses a leaner `GroupSerializer` that **does not** include the `ancestors` field — only the single-object retrieve endpoint (`GET /api/v1/groups/{id}/`) returns `ancestors`. Clients iterating the list and reading `entry.ancestors` will get `undefined`. Fetch the single group if you need the ancestor chain.

### `POST /api/v1/groups/`
Create a group. Any authenticated user may create a top-level group. Creating a subgroup requires admin of the parent.

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
| `default_board_member_role` | string | **Scaffold.** Intended role for group members on new boards. **Not enforced:** stored but not read by any code path; group members' board access comes from their group role (scaffold, see [Field Enforcement](../architecture/field-enforcement.md)) |
| `allowed_priorities` | array | **Advisory.** Copied onto a board's `allowed_priorities` when the board is created through `POST /groups/{id}/boards/`; it does not restrict card priorities, because the board-level field is not enforced either. Empty array means all priorities allowed. Duplicate entries are silently de-duplicated (order of first occurrence is kept); a submitted list longer than 100 entries is rejected with `400 Bad Request`. |
| `ancestors` | array | Ordered list of ancestor groups from root to immediate parent. Each entry is `{ "id": 1, "name": "Acme Corp" }`. Empty for top-level groups. **Only present on this single-object retrieve endpoint** — the list endpoint (`GET /api/v1/groups/`) omits `ancestors`. |
| `created_at` | string | ISO 8601 timestamp |

### `PUT /api/v1/groups/{id}/` / `PATCH /api/v1/groups/{id}/`
Update group fields. Both `PUT` and `PATCH` are accepted. Requires group admin.

**Writable fields:** `name`, `description`, `parent`, `default_board_member_role`, `allowed_priorities`. The latter two duplicate what [`PATCH /groups/{id}/board-defaults/`](#board-defaults) does — either endpoint can set them.

### `DELETE /api/v1/groups/{id}/`
Delete a group. Requires group owner or site admin.

---

## Members

### `GET /api/v1/groups/{id}/members/`
List group members. Requires group membership.

**Response** — array of member objects:

| Field | Type | Description |
|---|---|---|
| `id` | integer / null | Membership record ID. `null` for inherited members — access via an ancestor group's membership rather than a direct row on this group. A group's owner always holds a direct `admin` `GroupMembership` row (created with the group, or transferred via [Transfer ownership](#transfer-ownership), which requires the new owner to already be a direct admin), so the owner's `id` here is never `null`. A site admin with no membership of their own does not appear in this list at all. Callers must not assume this field is always an integer. |
| `user` | object | `{ "id", "username", "display_name", "avatar_url" }` |
| `role` | string | Effective role on this group: `admin`, `member`, `collaborator`, or `viewer` |
| `joined_at` | string / null | ISO 8601 timestamp of when the membership was created; `null` for inherited members |
| `is_inherited` | boolean | `true` when the member's access comes from a parent (ancestor) group rather than a direct membership on this group |
| `inherited_from` | string / null | Display name of the ancestor group that grants access, when `is_inherited` is `true`; `null` otherwise |

### `PATCH /api/v1/groups/{id}/members/{user_id}/`
Change a member's role. Requires group admin. Cannot modify a site admin.

**Request** `{ "role": "admin" }`

Valid roles: `admin`, `member`, `collaborator`, `viewer`

*(1.2+)* Changing a member's role away from `admin` revokes their unused [invite links](#invite-links) in this group and its subgroups that they can no longer administer (for example through another admin membership on an ancestor), and each revoked link emits `invite_link.revoked` on its group's channel. This frees their slots under the 5-active-link cap.

### `DELETE /api/v1/groups/{id}/members/{user_id}/`
Remove a member. Requires group admin. Cannot remove a site admin. *(1.2+)* The removed member's unused invite links in this group and its subgroups that they can no longer administer are revoked, with an `invite_link.revoked` event per link.

---

## Subgroups

### `GET /api/v1/groups/{id}/subgroups/`
List direct subgroups of this group that are visible to the requesting user. Requires membership in this group or any ancestor group. Visibility follows the RBAC inheritance model: members of a parent group see all descendant subgroups (not only subgroups they have been added to directly) — see [Role Inheritance](../features/rbac/inheritance.md#visibility-of-descendant-groups) for the full rule.

**Response** — array of `Group` summary objects (same shape as the list endpoint; `ancestors` is omitted for parity with `GET /api/v1/groups/`).

---

## Boards

### `GET /api/v1/groups/{id}/boards/`
List boards in this group. Requires group membership.

### `POST /api/v1/groups/{id}/boards/`
Create a board in this group. Requires group admin. Boards created here inherit the group's `shared_labels` and `allowed_priorities` automatically. The seeded `allowed_priorities` value is not enforced on cards (see [Field Enforcement](../architecture/field-enforcement.md)).

**Request**

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Board display name |
| `description` | No | Optional free-text description |
| `template` | No | Template slug to pre-populate columns. Valid values match those from `GET /api/v1/boards/templates/` (e.g. `simple_kanban`, `sales_pipeline`, `customer_support`). Default: `simple_kanban`. Omitting the field (or sending `""`/`null`) uses the default; a non-blank slug that doesn't match an active template returns `400 {"code": ["unknown_template"], ...}` — same validation and error shape as `POST /api/v1/boards/` (#1115). |
| `swimlane_name` | No | Label for the swimlane axis (e.g. `"Customer"`, `"Team"`). Defaults to `"General"`; truncated to 255 characters |

### `GET /api/v1/groups/{id}/descendant-boards/`
List all boards in this group and all of its descendant subgroups that the requesting user can access. This answers "what boards live anywhere inside this group subtree?" — including boards in deeply nested subgroups. Requires group membership.

**Response** — array of board summary objects (same shape as `GET /api/v1/groups/{id}/boards/`). Each board's `group_detail` is always populated with a `GroupBrief` payload including the `ancestors` chain, so callers can render a full relative breadcrumb without an extra request (#845). `ancestors` is root-first and does **not** include the board's direct parent group — that name is in `group_name`.

**Errors:** `403 Forbidden` if the caller is not a group member; `404 Not Found` if the group does not exist.

---

## Invite links

A group can have up to 5 active shareable invite links. Each link has an independent name, role, and expiry. Links sent by email (`delivery: "email"`, below) are capped separately — up to 50 pending per group — and never count against the 5.

A link can stay listed as active, and keep holding one of the 5 slots, after its creator is deleted or the group is re-parented so the creator no longer administers it, and links left in that state before upgrading are not backfilled. Join and preview still refuse such a link, so nobody is admitted through it; cleaning up the listing and the slot is tracked in #1513.

Inherited group-admin rights (which decide whether a link's creator still counts as an admin, and which links are revoked on demotion) are considered only up to 6 ancestor levels; nesting deeper than that is not honored for these checks.

### `GET /api/v1/groups/{id}/invite-links/`
List all invite links for this group. Requires group admin.

### `POST /api/v1/groups/{id}/invite-links/`
Create a new invite link. Requires group admin.

**Request**
```json
{ "name": "Team link", "role": "member", "expiry_days": 7, "single_use": false }
```

All fields are optional. `role` defaults to `member`; `expiry_days` accepts any positive integer (`≥ 1`) or `null` (never expires) — common values `7`, `30`, `90`. `single_use` (boolean, default `false`) creates a link that expires automatically after one person joins.

Valid roles: `admin`, `member`, `collaborator`, `viewer`

**Response (create only)** — the raw `token` is returned once and never again:
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
| `role` | string | Role granted on redemption: `admin` / `member` / `collaborator` / `viewer`. |
| `is_active` | boolean | `true` until revoked. A consumed single-use link still shows `is_active: true` but cannot be redeemed again — see `status`. |
| `is_expired` | boolean | `true` once `expires_at` has passed. |
| `expires_at` | string / null | ISO 8601 expiry; `null` means never expires. |
| `created_at` | string | ISO 8601 timestamp. |
| `created_by_username` | string / null | Username of the admin who created the link (#1008). `null` if the creator's account has since been anonymized. |
| `single_use` | boolean | `true` if the link is consumed by the first redemption (cannot be reused). |
| `used_at` | string / null | ISO 8601 timestamp of consumption (single-use links only); `null` for multi-use or unredeemed. |
| `status` | string | Computed status: `pending` (active and unredeemed), `used` (single-use and consumed), `expired` (past `expires_at`), or `revoked` (admin disabled). |
| `delivery` | string | `link` (created here and shared by an admin) or `email` (sent to one address by `POST …/invite-links/send/`). Added in 1.2. |

!!! note
    `revoked` is a real status value, but `GET /invite-links/` cannot return a link in that state — a revoked link's `is_active` is cleared and it is filtered out of the list. Once a link is revoked, it is gone from this endpoint entirely rather than kept around showing `status: "revoked"`.

### `POST /api/v1/groups/{id}/invite-links/send/`
Email a single-use invite link to one address. Requires group admin. *(Added in 1.2.)*

**Request**
```json
{ "email": "new.person@example.org", "role": "member", "expiry_days": 7 }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | Yes | Recipient address. Surrounding spaces are stripped; an address containing a line break is rejected. The address is used for this one send and is **never stored** or logged. |
| `role` | string | No | Role granted on join: `admin` / `member` / `collaborator` / `viewer`. Default `member`. |
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
| `400 Bad Request` | `{"code": "invite_email_cap_reached", ...}` | The group already has 50 pending emailed links (active, unexpired, unused) |
| `403 Forbidden` | — | Caller is not a group admin |
| `403 Forbidden` | `{"code": "invite_email_disabled", ...}` | `INVITE_EMAIL_ENABLED=false`, or the instance runs in demo mode |
| `429 Too Many Requests` | — | Rate limit: 10 sends/hour per user, 30/day per group (shared by all its admins), 200/day instance-wide for group invites. Requests refused for another reason, and sends the mail server rejected, don't count |
| `502 Bad Gateway` | `{"code": "<error code>", ...}` | The mail server refused or could not be reached. The just-created link is revoked automatically. `code` is one of the sanitized SMTP codes (`auth_failed`, `connection_refused`, `dns_failure`, `tls_failure`, `timeout`, `config_unusable`, `unknown`) — never the raw server reply |

A successful send emits `invite_link.created` (payload `{ "id" }` only) on the group's WebSocket channel; a failed send emits `invite_link.revoked` for the auto-revoked link. See [WebSockets](websockets.md).

### `DELETE /api/v1/groups/{id}/invite-links/{link_id}/`
Revoke a single invite link. Requires group admin. Works the same for shareable and emailed links.

**Errors**

| Status | Condition |
|---|---|
| `404 Not Found` | Link does not exist, or is already revoked |
| `400 Bad Request` | The link is a single-use link that has already been consumed — `{"detail": "This link has already been consumed and cannot be revoked."}` |

---

## Favorites

### `POST /api/v1/groups/{id}/star/`
Star (favorite) a group. Requires group membership (any role) — not just authentication.

### `DELETE /api/v1/groups/{id}/star/`
Unstar a group. Requires group membership (any role) — not just authentication.

### `GET /api/v1/groups/?starred=true`
List only starred groups for the current user.

---

## Transfer ownership

### `POST /api/v1/groups/{id}/transfer-ownership/`
Transfer group ownership to another user. Requires the **current owner** (not just admin).

**Request**
```json
{ "new_owner_id": 42, "confirmation": "Engineering" }
```

- `new_owner_id` — the user ID of the new owner; must already be a group **admin**
- `confirmation` — must exactly match the group's name (case-sensitive) to prevent accidental transfers

The previous owner becomes a regular admin after transfer. Returns the updated group object.

**Error responses**
- `403 Forbidden` — you are not the current owner
- `400 Bad Request` — request body is not a JSON object
- `400 Bad Request` — confirmation does not match group name
- `400 Bad Request` — `new_owner_id` is not a member of this group
- `400 Bad Request` — `new_owner_id` is a member but not an admin

---

## Group shared labels

Group labels are a shared label library. When a new board is created inside the group, it inherits the group's labels automatically.

### `GET /api/v1/groups/{id}/labels/`
List group shared labels. Requires group membership.

**Response** `[{ "id": 1, "name": "Bug", "color": "#EF4444" }, ...]`

### `POST /api/v1/groups/{id}/labels/`
Create a group shared label. Requires group admin.

**Request** `{ "name": "Feature", "color": "#3B82F6" }`

### `PATCH /api/v1/groups/{id}/labels/{label_id}/`
Update a group shared label name or color. Requires group admin.

### `DELETE /api/v1/groups/{id}/labels/{label_id}/`
Delete a group shared label. Requires group admin. Does **not** remove the label from boards that already inherited it.

---

## Board defaults

### `PATCH /api/v1/groups/{id}/board-defaults/`
Update the board defaults for this group. `allowed_priorities` is copied onto boards created in the group; `default_board_member_role` is saved but not yet enforced. Requires group admin.

**Patchable fields**

| Field | Type | Description |
|---|---|---|
| `default_board_member_role` | string | **Scaffold.** `admin`, `member`, `collaborator`, or `viewer`. Stored but not yet enforced — see the field table above |
| `allowed_priorities` | array / null | **Advisory.** Seeds `allowed_priorities` on new boards created in this group (e.g. `["low", "medium", "high"]`); `null` means all. Not enforced on cards — see the field table above |

**Request**
```json
{ "default_board_member_role": "member", "allowed_priorities": ["low", "medium", "high"] }
```

Returns the updated group object.

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

*(1.2+)* An authenticated caller who is already a member of the link's group gets `200` with the preview for a consumed single-use link instead of `410`. This is the path a newcomer takes after an emailed invite created their account (see [`POST /api/v1/auth/registration/`](authentication.md)); everyone else still gets `410`.

### `POST /api/v1/groups/join/{token}/`
Join the group with the role configured on the invite link. Requires authentication. Rate-limited to 10 requests/hour per IP, shared with the board join endpoints.

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

*(1.2+)* If the caller is already a member of the link's group, a consumed single-use link returns `200` with the group, the same as any repeat join; the link is not re-stamped and the caller's role is unchanged.
