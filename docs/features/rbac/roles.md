# Roles & Permissions

Visiban has five roles that control access at both the group and board level.

## Role hierarchy

| Role | Scope | Description |
|---|---|---|
| `site_admin` | Site-wide | Full access to everything. Granted when the user has `can_access_all_content` enabled. Cannot be removed or demoted by any other admin. |
| `admin` | Group or Board | Manages the group/board: members, structure, settings. |
| `member` | Group or Board | Standard contributor — creates and moves cards. |
| `collaborator` | Group or Board | Can comment on cards, upload attachments, and manage checklist items but cannot create, edit, move, or delete cards. |
| `viewer` | Group or Board | Read-only access to cards and movement history. |

## Permission table

| Right | site_admin | admin | member | collaborator | viewer |
|---|:---:|:---:|:---:|:---:|:---:|
| **Site** | | | | | |
| See all boards & groups | ✓ | — | — | — | — |
| Grant / revoke site admin | ✓ | — | — | — | — |
| **Groups** | | | | | |
| Create top-level group | ✓ | ✓ | ✓ | — | — |
| Create subgroup | ✓ | ✓ *(of parent)* | — | — | — |
| Delete group | ✓ | owner only | — | — | — |
| Manage group members | ✓ | ✓ | — | — | — |
| View group & boards | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Boards** | | | | | |
| Create board in group | ✓ | ✓ | — | — | — |
| Create personal board | ✓ | ✓ | ✓ | — | — |
| Delete board | ✓ | owner only | — | — | — |
| Edit board structure (columns, swimlanes, labels) | ✓ | ✓ | — | — | — |
| Manage board members | ✓ | ✓ | — | — | — |
| **Cards** | | | | | |
| Create / edit / move / delete card | ✓ | ✓ | ✓ | — | — |
| Comment on cards | ✓ | ✓ | ✓ | ✓ | — |
| Delete own comment | ✓ | ✓ | ✓ | ✓ | — |
| Delete any comment | ✓ | ✓ | ✓ | — | — |
| Upload / delete attachments | ✓ | ✓ | ✓ | ✓ | — |
| Add / edit / delete checklist items | ✓ | ✓ | ✓ | ✓ | — |
| View cards & movement history | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bulk card operations (move, assign, priority, delete) | ✓ | ✓ | ✓ | — | — |
| **Export & Import** | | | | | |
| Export board (CSV / JSON) | ✓ | ✓ | ✓ | — | — |
| Import board from file | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Analytics** | | | | | |
| View analytics & summary | ✓ | ✓ | ✓ | ✓ | ✓ |
| Export analytics CSV | ✓ | ✓ | — | — | — |

## Moderator entitlement

Board admins can grant the **moderator** entitlement to any member or admin via the Members tab in Board Settings. A moderator can delete and archive cards and comments created by other users — normally a member can only perform these actions on their own content.

Moderator is a boolean flag (`is_moderator`) on the board membership, not a separate role. It appears as a checkbox next to the role dropdown. Demoting a moderator to collaborator or viewer automatically clears the flag.

See [Board Permissions](../permissions.md#moderator-entitlement) for the full description.

## Site admin protection

Site admins are protected at the API level:

- A board or group admin calling any role-change or remove-member endpoint **targeting a user with `is_site_admin`** receives a `403 Forbidden`. This check uses the `is_site_admin` flag specifically, not `can_access_all_content`.
- Only another site admin can modify a site admin's membership.
- Users with `can_access_all_content` see all boards and groups regardless of explicit membership. This is the flag that controls board-level omniscience — `is_site_admin` alone does not grant it.

!!! note "Two flags, two purposes"
    `is_site_admin` gates admin panel access and protection from demotion. `can_access_all_content` gates implicit board/group access. The `set_site_admin` management command sets both together, but they can be managed independently via the admin panel. See [Site Admins](../../administration/site-admins.md) for details.

See [Managing Roles](managing.md) for how to grant site admin status.
