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

Each group has members with one of two roles:

| Role | What they can do |
|---|---|
| `admin` | Manage members, create subgroups and boards, delete the group |
| `member` | View boards and subgroups, create personal boards |

Membership is **inherited** — a member of "Acme Corp" is automatically a member of "Engineering" and all its descendants. You don't need to add users to each subgroup individually. See [Group Inheritance](rbac/inheritance.md) for full details.

## Board roles vs group roles

Group roles (`admin` / `member`) control access to the group itself. Once inside a board, finer-grained board roles apply: **admin**, **member**, **collaborator**, and **viewer**.

By default a group member gets the `member` board role. A board admin can override this per-user from the **Members** button in the board toolbar. See [Roles & Permissions](rbac/roles.md).

## Boards inside groups

Boards belonging to a group are visible to all group members. Group admins can create new boards from the group detail page, or **import** a board from a previously exported JSON or CSV file directly into the group. Boards can be moved between groups (or back to personal) using the move button that appears on hover.

## Subgroups

Group admins can create subgroups. Nesting is unlimited (traversal is capped at 6 levels for performance). The group detail page shows subgroups and optionally lists all boards across subgroups via the "Show subgroup boards" toggle.

## Invite links

Group admins can generate a shareable invite link from the group detail page. Anyone with the link joins as a `member`. Links can be deactivated at any time — existing members are not affected.

!!! tip
    Use invite links to onboard external collaborators without needing to know their username in advance.

## Dashboard

The dashboard shows all groups the user belongs to in a collapsible tree. Groups are collapsed by default; click the chevron to expand. Boards that belong to a group appear under it; personal boards appear at the top level.
