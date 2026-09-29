# Board Role Permissions

Visiban uses four board-level roles to control what each member can do on a board. Site admins are a separate designation, covered at the end of this page. **Why it matters:** getting a role wrong either blocks a contributor from doing their job or gives a reviewer write access they shouldn't have.

This page is the detailed board-action reference. For how the same roles work at the group level, how group membership cascades down to boards, and how to assign roles, see [Roles & Access Control](rbac/index.md).

## The four board roles

| Role | Intended for |
|---|---|
| **Admin** | Board owners and team leads who need full control: structure, members, and all card operations. |
| **Member** | Active contributors who create, edit, move, and delete cards day-to-day. |
| **Collaborator** | External stakeholders or reviewers who participate in discussion (comments, checklists, attachments) but should not create or move cards. |
| **Viewer** | Auditors or read-only observers who need visibility into the board without making any changes. |

## Permission matrix

The full board action matrix — including the group and site scopes the same four roles carry — now lives in one place: [Roles & Permissions — Permission table](rbac/roles.md#permission-table). This page used to keep its own copy; the two drifted apart more than once, so this page links to the single source instead of maintaining a second copy.

Quick pointers into that table:

- **Own vs. any** — most card/comment/attachment/checklist actions split into an "own" row (any Member or Collaborator who created the content) and an "any" row (requires the **moderator** entitlement or Admin role). See [Moderator entitlement](#moderator-entitlement) below for what that entitlement grants and how to assign it.
- **Card move** — see the **move†** footnote on the permission table for the unassigned/self-assigned/self-created exception.
- **Export defaults and thresholds** — see the "Board export default and per-board threshold" note on the permission table for the `export_min_role` setting and export history.
- **Viewer enforcement history** — see the "Viewer boundary enforced since 1.0" note on the permission table.

## How to set roles

1. Open the board and click the **Settings** button (gear icon) in the toolbar.
2. Go to the **Members** tab.
3. To add a member: type their username or email in the invite field, choose a role, and click **Invite**.
4. To change a member's role: click the role badge next to their name and select a new one.
5. To remove a member: click the trash icon next to their name.

Only board Admins (and site admins) can do this.

## Moderator entitlement

The **moderator** entitlement lets an admin delegate content-moderation rights to a specific member without granting full admin access. A moderator can:

- **Assign** cards created by other users to any board member
- **Edit** cards created by other users
- **Delete** cards created by other users
- **Archive and restore** cards created by other users
- **Delete** comments authored by other users

Without the moderator flag, members can only assign and edit cards they created, delete/archive cards they created, and delete comments they authored.

!!! note "Assignee dropdown gating"
    The assignee field in the card detail panel is disabled for members without moderator (or admin) access who didn't create the card. A tooltip explains why it's locked. If a non-moderator member reaches the assignment API endpoint directly, the server returns `403 Forbidden` with the message: "Assigning cards requires Moderator or Admin access — ask a board admin."

To grant moderator rights, open Board Settings → Members and check the **Moderator** checkbox next to the member's name. Only admins can toggle this. The checkbox is only available for members and admins — collaborators and viewers can't be designated as moderators.

!!! note "Moderator is an entitlement, not a role"
    Moderator is a boolean flag on the membership, not a fifth role. A member with moderator rights still appears as "Member" in the role dropdown. Demoting a moderator to collaborator or viewer automatically revokes the flag.

## Site admin and content access

Visiban tracks two independent flags on the User model:

| Flag | What it controls |
|---|---|
| `is_site_admin` | Access to the admin panel (`/admin`) and admin API (`/api/v1/admin/*`). Does **not** grant board or group access on its own. |
| `can_access_all_content` | Read/write access to every board and group on the instance, regardless of membership. This is the flag that bypasses board-level role checks. |

When a user with `can_access_all_content` accesses a board, the permission system treats them as a site-level admin role — they can view and modify any board without an explicit membership.

A user who is `is_site_admin=True` but `can_access_all_content=False` can manage the admin panel (users, settings, instance configuration) but **cannot** see boards they aren't a member of. This separation lets operators grant admin panel access without granting board omniscience.

!!! tip
    The `set_site_admin` management command sets **both** flags together for convenience. To manage them independently, use the admin panel. See [Site Admins](../administration/site-admins.md) for details.

A board admin cannot change the role of, or remove, a member with `is_site_admin=True` unless the admin is also a site admin — see [Roles & Permissions — Site admin protection](rbac/roles.md#site-admin-protection).
