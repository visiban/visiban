# Roles & Permissions

Visiban has five roles that control access at both the group and board level.

## Role hierarchy

| Role | Scope | Description |
|---|---|---|
| `site_admin` | Site-wide | Full access to everything. Cannot be removed or demoted by any other admin. |
| `admin` | Group or Board | Manages the group/board: members, structure, settings. |
| `member` | Group or Board | Standard contributor — creates and moves cards. |
| `collaborator` | Board only | Can comment on cards but cannot create, edit, move, or delete them. |
| `viewer` | Board only | Read-only access to cards and movement history. |

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
| View group & boards | ✓ | ✓ | ✓ | — | — |
| **Boards** | | | | | |
| Create board in group | ✓ | ✓ | — | — | — |
| Create personal board | ✓ | ✓ | ✓ | — | — |
| Delete board | ✓ | owner only | — | — | — |
| Edit board structure (columns, swimlanes, labels) | ✓ | ✓ | — | — | — |
| Manage board members | ✓ | ✓ | — | — | — |
| **Cards** | | | | | |
| Create / edit / move / delete card | ✓ | ✓ | ✓ | — | — |
| Comment on cards | ✓ | ✓ | ✓ | ✓ | — |
| View cards & movement history | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bulk card operations (move, assign, priority, delete) | ✓ | ✓ | ✓ | — | — |
| **Export & Import** | | | | | |
| Export board (CSV / JSON) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Import board from file | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Analytics** | | | | | |
| View analytics & summary | ✓ | ✓ | ✓ | ✓ | ✓ |
| Export analytics CSV | ✓ | ✓ | — | — | — |

## Site admin protection

Site admins are protected at the API level:

- A board or group admin calling any role-change or remove-member endpoint **targeting a site admin** receives a `403 Forbidden`
- Only another site admin can modify a site admin's membership
- Site admins see all boards and groups regardless of explicit membership

See [Managing Roles](managing.md) for how to grant site admin status.
