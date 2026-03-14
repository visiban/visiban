# Groups

Groups organize boards and users into a hierarchy. A board can belong to one group; a group can have one parent group (unlimited nesting, traversal capped at 6 levels).

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

Authenticated users who open an invite link see a single **Join &lt;group name&gt;** button and are redirected to the group page immediately after joining.

!!! tip
    Use invite links to onboard external collaborators without needing to know their username in advance. Create separate links for different roles (e.g. one `member` link for the team and one `viewer` link for stakeholders).

## Starring groups

The star button (☆/★) in the group detail page header lets you mark frequently-visited groups as favorites. Starred groups appear in a **Favorite Groups** section at the top of the sidebar for quick access. The star updates optimistically and rolls back on failure.

## Dashboard

The primary way to navigate between groups and boards is the persistent collapsible left sidebar, which shows the full group/board hierarchy. The sidebar remembers each item's collapsed or expanded state across sessions. The dashboard (`/`) is where you go to create new boards and groups.
