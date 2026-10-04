# Groups

> **Added in 1.0**

Groups organize boards and users into a hierarchy. A board can belong to one group; a group can have one parent group (unlimited nesting, traversal capped at 6 levels).

**Why it matters:** membership and shared settings inherit down the tree, so a manager can onboard a whole team by adding one group instead of every board.

## Group description

Each group has an optional **description** field — a short free-text summary of the group's purpose. It appears on the group detail page and is inline-editable: click it to enter edit mode, then press **Enter** (or click outside) to save, or **Escape** to cancel.

The description is returned as `description` in `GET /api/v1/groups/{id}/` and is writable via `PUT /api/v1/groups/{id}/` (group admin required).

## Ancestor breadcrumb chain

When viewing a group with a parent, the group detail page shows a breadcrumb chain above the group name, listing every ancestor from the root down to the immediate parent as a clickable link — useful for orienting yourself and navigating back up deep hierarchies.

The full ancestor list is also available in the API: `GET /api/v1/groups/{id}/` returns an `ancestors` array (see [Groups API](../api/groups.md)).

## Structure

```
Acme Corp  (top-level group)
├── Engineering
│   ├── Backend Team
│   └── Frontend Team
└── Sales
```

## Membership

Each group has members with one of four roles:

| Role | What they can do |
|---|---|
| `admin` | Manage members, create subgroups and boards, delete the group |
| `member` | View boards and subgroups, create personal boards |
| `collaborator` | View boards in the group; can comment on cards but cannot create, edit, move, or delete them |
| `viewer` | Read-only access to all boards in the group — can view cards and card history but cannot create, edit, move, delete cards, or manage members |

Membership is **inherited** — a member of "Acme Corp" is automatically a member of "Engineering" and all its descendants, with no need to add users to each subgroup individually. See [Group Inheritance](rbac/inheritance.md) for full details.

## Board roles vs group roles

All four roles — `admin`, `member`, `collaborator`, and `viewer` — are valid at both the group and board level. A group role is inherited by every board in the group. A board admin can override a user's role on a specific board from the **Members** button in the board toolbar. See [Roles & Permissions](rbac/roles.md).

## Boards inside groups

Boards belonging to a group are visible to all group members. Group admins can create new boards from the group detail page, or **import** a board from a previously exported JSON or CSV file directly into the group. Boards can be moved between groups (or back to personal) using the move button that appears on hover.

## Subgroups

Group admins can create subgroups. Nesting is unlimited (traversal is capped at 6 levels for performance). The group detail page shows subgroups and optionally lists all boards across subgroups via the "Show subgroup boards" toggle.

## Invite links

> **Added in 1.0**

Group admins can generate up to **5 active invite links** per group from the group detail page. Each link is configured independently:

| Setting | Options |
|---|---|
| **Name** | Optional label to identify the link's purpose |
| **Role** | `admin`, `member`, `collaborator`, or `viewer` (the role granted on join) |
| **Expiry** | 1 day, 7 days, 30 days, or Never |
| **Single-use** | When enabled, the link is deactivated after the first person uses it |

> **Added in 1.1** — single-use invite links (#689)

Anyone with the link joins with the role assigned to that link. Expired links show a visual indicator and can't be used to join. Used single-use links display a status badge and consumed-at timestamp in the invite links list. Each link can be revoked independently — existing members are not affected.

**How it works:**

- **Unauthenticated visitors** see a full authentication interface: a **Create an account** button (primary), a **Sign in** option, and social login buttons (Google / GitHub / GitLab) where configured. After authenticating, the invite is accepted automatically and they land on the group page with a confirmation banner.
- **Authenticated users** see a single **Join &lt;group name&gt;** button and are redirected to the group page right after joining. If already a member, they're silently redirected without re-joining.
- **Invalid or expired links** show a countdown timer and auto-redirect to the dashboard after 5 seconds — no manual action needed.

!!! tip
    Use invite links to onboard external collaborators without needing to know their username in advance. Create separate links for different roles (e.g. one `member` link for the team and one `viewer` link for stakeholders).

### Emailing an invite link

> **Added in 1.2** (#731)

Instead of copying a link into another tool, a group admin can send an invite straight to someone's email address. Visiban creates a **single-use** link for that one person (role of your choice, expiring in 1–30 days — default 7, never "never") and emails it from the instance's own sender address. The email is plain text and names the group, the join link, and the expiry date; there is no custom message.

- Emailed links show up in the invite links list marked as emailed, can be revoked like any other link, and **don't count against the 5 shareable links**. A group can have up to 50 pending emailed links.
- The address you typed is used for that one email and is **not stored**. The list shows the link, not who it was sent to.
- You get the same "Invite sent" confirmation whether the address belongs to an existing member, someone with an account, or nobody yet — Visiban never reveals which addresses have accounts.
- If the mail server rejects the message, you see an error and the link is revoked automatically, so nothing is left dangling. Try again once email is working.
- Sending is rate-limited: 10 per hour per admin, 30 per day per group, 200 per day across the instance. Sends that are refused or that the mail server rejects don't count.
- The option only appears when outbound email is configured (see [Email](../administration/configuration.md)) and the operator hasn't set `INVITE_EMAIL_ENABLED=false`. It is never available on a demo instance.

!!! note
    Following the emailed link does **not** verify the recipient's email address. If they create a new account from it, registration still follows the instance's normal email-verification setting. On an instance whose registration mode is **Invite-only** or **Closed**, a group invite link does not currently let a newcomer create an account (tracked in #1445) — invite people who already have one, or ask a site admin for a site invite.

## Moving boards between groups

Any board can move to a different group or back to personal boards, via **Move to group** in board settings (gear icon in the toolbar). Only board admins and site admins can move a board.

**API:** `POST /api/v1/boards/{id}/move-group/` with `{ "group_id": 5 }` or `{ "group_id": null }` for personal.

## Group shared labels

> **Added in 1.0**

Group admins can define a shared label library for the group. New boards created inside it automatically inherit these labels, so your team starts with a consistent tagging vocabulary without manual setup.

Manage labels from the **Settings** tab on the group detail page.

**Watch out:** inheritance is a one-time copy at board-creation time, not a live link. Renaming, recoloring, or deleting a group label only changes the group's shared library and future boards — boards that already inherited the label keep their own independent copy, unaffected by later edits or deletion.

**API:** `GET/POST /api/v1/groups/{id}/labels/`, `PATCH/DELETE /api/v1/groups/{id}/labels/{label_id}/`

## Group board defaults

Group admins can configure defaults for new boards created in the group. Neither setting is enforced yet:

| Setting | Description |
|---|---|
| **Default member role** | Intended role for group members on new boards (`admin`, `member`, `collaborator`, `viewer`). Defaults to `member`. **Not yet enforced** — the setting is saved, but group members' access to the group's boards currently comes from their group role. |
| **Allowed priorities** | Copied onto new boards created in the group. **Not yet enforced** — cards can still use any priority. An empty list `[]` (default) means all priorities. |

Board defaults are configured from the **Settings** tab on the group detail page.

**API:** `PATCH /api/v1/groups/{id}/board-defaults/`

## Transferring group ownership

Only the **current owner** of a group can transfer ownership, and only to an existing group **admin**. Confirm the transfer by typing the group name exactly as shown.

After transfer, the previous owner becomes a regular admin — not removed from the group.

**API:** `POST /api/v1/groups/{id}/transfer-ownership/` with `{ "new_owner_id": 42, "confirmation": "Group Name" }`

## Starring groups

The star button (☆/★) in the group detail page header lets you mark frequently-visited groups as favorites. Starred groups appear in a **Favorite Groups** section at the top of the sidebar for quick access. The star updates optimistically and rolls back on failure.

## Live board list

> **Added in 1.1**

The group detail page auto-refreshes its board list over WebSocket. Boards created, renamed, deleted, or moved into or out of the group appear and disappear in real time — no page refresh needed.

The group page subscribes to a per-group WebSocket channel (`ws/groups/<group_id>/`) that emits the following events:

| Event | Description |
|---|---|
| `board.created` | A new board was created in this group |
| `board.updated` | A board was renamed or its settings changed |
| `board.deleted` | A board was deleted or moved out of this group |

A **Live / Reconnecting… / Failed** connection status indicator in the group page header mirrors the board-view indicator — it reflects the same five states and uses the same `ConnectionStatus` component. The "Refresh board" button in the popover re-fetches the board list from the API.

## Dashboard

The persistent, collapsible left sidebar is the primary way to navigate between groups and boards — it shows the full group/board hierarchy and remembers each item's collapsed or expanded state across sessions.

The **+ New board** and **+ New group** buttons in the sidebar footer open their respective creation dialogs immediately — no navigation required.

### Create Group modal

The **Create Group** modal has two fields:

| Field | Notes |
|---|---|
| **Name** | Required. The group's display name. |
| **Description** | Optional. A short summary of the group's purpose. A character counter is shown below the field as you type. |

After creating a group or subgroup, the modal switches to a **post-creation state** where you can add subgroups immediately, without navigating away: type a name, click **+ Add** (or press Enter), and repeat. Each subgroup is created instantly. Click **Done** when finished.

This flow works at every level of the hierarchy — create "Engineering", add "Frontend" and "Backend" as subgroups, and even add sub-subgroups to those, all without leaving the modal.
