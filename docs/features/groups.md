# Groups

Groups organize boards and users into a hierarchy. A board can belong to one group; a group can have one parent group (unlimited nesting, traversal capped at 6 levels).

## Group description

Each group has an optional **description** field — a short free-text summary of the group's purpose. The description appears on the group detail page and is inline-editable: click it to enter edit mode, then press **Enter** (or click outside) to save, or press **Escape** to cancel.

The description is returned as `description` in `GET /api/groups/{id}/` and is writable via `PUT /api/groups/{id}/` (group admin required).

## Ancestor breadcrumb chain

When viewing a group that has a parent, the group detail page shows a breadcrumb chain above the group name listing all ancestor groups from the root down to the immediate parent. Each ancestor is a clickable link. This makes it easy to orient yourself and navigate back up deep hierarchies.

The full ancestor list is also available in the API: `GET /api/groups/{id}/` returns an `ancestors` array (see [Groups API](../api/groups.md)).

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

Membership is **inherited** — a member of "Acme Corp" is automatically a member of "Engineering" and all its descendants. You don't need to add users to each subgroup individually. See [Group Inheritance](rbac/inheritance.md) for full details.

## Board roles vs group roles

All four roles — `admin`, `member`, `collaborator`, and `viewer` — are valid at both the group and board level. A group role is inherited by every board in the group. A board admin can override a user's role on a specific board from the **Members** button in the board toolbar. See [Roles & Permissions](rbac/roles.md).

## Boards inside groups

Boards belonging to a group are visible to all group members. Group admins can create new boards from the group detail page, or **import** a board from a previously exported JSON or CSV file directly into the group. Boards can be moved between groups (or back to personal) using the move button that appears on hover.

## Subgroups

Group admins can create subgroups. Nesting is unlimited (traversal is capped at 6 levels for performance). The group detail page shows subgroups and optionally lists all boards across subgroups via the "Show subgroup boards" toggle.

## Invite links

Group admins can generate up to **5 active invite links** per group from the group detail page. Each link can be configured independently:

| Setting | Options |
|---|---|
| **Name** | Optional label to identify the link's purpose |
| **Role** | `admin`, `member`, `collaborator`, or `viewer` (the role granted on join) |
| **Expiry** | 1 day, 7 days, 30 days, or Never |

Anyone with the link joins with the role assigned to that link. Expired links show a visual indicator and cannot be used to join. Each link can be revoked independently — existing members are not affected.

Unauthenticated visitors who open an invite link are shown a full authentication interface: a **Create an account** button (primary), a **Sign in** option, and social login buttons (Google / GitHub / GitLab) if those providers are configured. After authenticating, the invite is accepted automatically and the user is redirected to the group page with a confirmation banner.

Authenticated users who open an invite link see a single **Join &lt;group name&gt;** button and are redirected to the group page immediately after joining. If the user is already a member they are silently redirected without re-joining.

If the link is invalid or expired, a countdown timer is shown and the user is automatically redirected to the dashboard after 5 seconds — no manual action required.

!!! tip
    Use invite links to onboard external collaborators without needing to know their username in advance. Create separate links for different roles (e.g. one `member` link for the team and one `viewer` link for stakeholders).

## Moving boards between groups

Any board can be moved to a different group or back to personal boards. Use the **Move to group** option in the board settings (gear icon in the toolbar). Only board admins and site admins can move a board.

**API:** `POST /api/boards/{id}/move-group/` with `{ "group_id": 5 }` or `{ "group_id": null }` for personal.

## Group shared labels

Group admins can define a shared label library for the group. New boards created inside the group automatically inherit these labels, so your team starts with a consistent tagging vocabulary without manual setup.

Labels are managed from the **Settings** tab on the group detail page. Changes to a group label (rename, recolor) propagate to all boards that inherited it; deletions only remove the label from the group library — boards that already have the label keep it.

**API:** `GET/POST /api/groups/{id}/labels/`, `PATCH/DELETE /api/groups/{id}/labels/{label_id}/`

## Group board defaults

Group admins can configure defaults that apply to every new board created in the group:

| Setting | Description |
|---|---|
| **Default member role** | Role granted to group members on new boards (`admin`, `member`, `collaborator`, `viewer`). Defaults to `member`. |
| **Allowed priorities** | Restricts which priority values are available on new boards. `null` (default) allows all priorities. |

Board defaults are configured from the **Settings** tab on the group detail page.

**API:** `PATCH /api/groups/{id}/board-defaults/`

## Transferring group ownership

Only the **current owner** of a group can transfer ownership to another user. The recipient must already be a group **admin**. To confirm the transfer, type the group name exactly as shown.

After transfer, the previous owner becomes a regular admin — they are not removed from the group.

**API:** `POST /api/groups/{id}/transfer-ownership/` with `{ "new_owner_id": 42, "confirmation": "Group Name" }`

## Starring groups

The star button (☆/★) in the group detail page header lets you mark frequently-visited groups as favorites. Starred groups appear in a **Favorite Groups** section at the top of the sidebar for quick access. The star updates optimistically and rolls back on failure.

## Dashboard

The primary way to navigate between groups and boards is the persistent collapsible left sidebar, which shows the full group/board hierarchy. The sidebar remembers each item's collapsed or expanded state across sessions.

The **+ New board** and **+ New group** buttons in the sidebar footer open their respective creation dialogs immediately — no navigation required.

### Create Group modal

The **Create Group** modal has two fields:

| Field | Notes |
|---|---|
| **Name** | Required. The group's display name. |
| **Description** | Optional. A short summary of the group's purpose. A character counter is shown below the field as you type. |

After creating a top-level group, the modal transitions to a **post-creation state** where you can immediately add subgroups without navigating away. Type a subgroup name, click **+ Add** (or press Enter), and repeat as needed. Each subgroup is created instantly. Click **Done** when finished.

When creating a **subgroup** from a group's detail page, the modal closes immediately after creation — you are already on the parent group page and can see the new subgroup in the list.

This flow lets you set up an entire group hierarchy (e.g. "Engineering" with "Frontend", "Backend", "Platform" subgroups) in a single session.
