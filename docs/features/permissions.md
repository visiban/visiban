# Board Role Permissions

Visiban uses four board-level roles to control what each member can do on a board. Site admins are a separate designation covered at the end of this page.

## The four board roles

| Role | Intended for |
|---|---|
| **Admin** | Board owners and team leads who need full control: structure, members, and all card operations. |
| **Member** | Active contributors who create, edit, move, and delete cards day-to-day. |
| **Collaborator** | External stakeholders or reviewers who participate in discussion (comments, checklists, attachments) but should not create or move cards. |
| **Viewer** | Auditors or read-only observers who need visibility into the board without making any changes. |

## Permission matrix

| Action | Admin | Member | Collaborator | Viewer |
|---|:---:|:---:|:---:|:---:|
| **Board** | | | | |
| View board and cards | ✓ | ✓ | ✓ | ✓ |
| View card movement history | ✓ | ✓ | ✓ | ✓ |
| View archived cards | ✓ | ✓ | ✓ | ✓ |
| Export board (CSV / JSON) | ✓ | ✓ | ✓ | ✓ |
| **Cards** | | | | |
| Create cards | ✓ | ✓ | — | — |
| Edit cards (title, description, priority, due date, weight, labels, assignee) | ✓ | ✓ | — | — |
| Move cards (drag-and-drop, column / swimlane change) | ✓ | ✓ | — | — |
| Archive / restore cards | ✓ | ✓ | — | — |
| Delete cards | ✓ | ✓ | — | — |
| **Collaboration** | | | | |
| Add comments | ✓ | ✓ | ✓ | — |
| Add attachments | ✓ | ✓ | ✓ | — |
| Delete attachments | ✓ | ✓ | ✓ | — |
| Add checklist items | ✓ | ✓ | ✓ | — |
| Check / uncheck checklist items | ✓ | ✓ | ✓ | — |
| Delete checklist items | ✓ | ✓ | ✓ | — |
| **Board structure** | | | | |
| Create / edit / delete columns | ✓ | — | — | — |
| Reorder columns | ✓ | — | — | — |
| Create / edit / delete swimlanes | ✓ | — | — | — |
| Reorder swimlanes | ✓ | — | — | — |
| Create / edit / delete labels | ✓ | — | — | — |
| **Membership** | | | | |
| Invite members | ✓ | — | — | — |
| Change member roles | ✓ | — | — | — |
| Remove members | ✓ | — | — | — |
| Delete board | ✓ (owner only) | — | — | — |

!!! note "Viewer boundary enforced since 1.0"
    Prior to the 1.0 release, the Viewer role was not fully enforced at the API level — Viewers could post comments, upload attachments, and modify checklist items. This was corrected in [#248](https://gitlab.com/visiban/visiban/-/issues/248): all write operations now return `403 Forbidden` for Viewers.

## How to set roles

1. Open the board and click the **Settings** button (gear icon) in the toolbar.
2. Go to the **Members** tab.
3. To add a new member: type their username or email in the invite field, choose a role from the dropdown, and click **Invite**.
4. To change an existing member's role: click the role badge next to their name and select a new role.
5. To remove a member: click the trash icon next to their name.

Only board Admins (and site admins) can perform these actions.

## Site admin and content access

Visiban tracks two independent flags on the User model:

| Flag | What it controls |
|---|---|
| `is_site_admin` | Access to the admin panel (`/admin`) and admin API (`/api/admin/*`). Does **not** grant board or group access on its own. |
| `can_access_all_content` | Read/write access to every board and group on the instance, regardless of membership. This is the flag that bypasses board-level role checks. |

When a user with `can_access_all_content` accesses a board, the permission system treats them as a site-level admin role — they can view and modify any board without an explicit membership.

A user who is `is_site_admin=True` but `can_access_all_content=False` can manage the admin panel (users, settings, instance configuration) but **cannot** see boards they are not a member of. This separation lets operators grant admin panel access without granting board omniscience.

!!! tip
    The `set_site_admin` management command sets **both** flags together for convenience. To manage them independently, use the admin panel. See [Site Admins](../administration/site-admins.md) for details.
