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

| Action | Admin | Member | Collaborator | Viewer |
|---|:---:|:---:|:---:|:---:|
| **Board** | | | | |
| View board and cards | ✓ | ✓ | ✓ | ✓ |
| View card movement history | ✓ | ✓ | ✓ | ✓ |
| View archived cards | ✓ | ✓ | ✓ | ✓ |
| Export board (CSV / JSON) | ✓ | ✓ | ✓ | ✓ |
| Export analytics CSV | ✓ | — | — | — |
| **Cards** | | | | |
| Create cards | ✓ | ✓ | — | — |
| Edit cards (title, description, priority, due date, weight, labels) | ✓ | ✓ | — | — |
| Assign a card to a board member | ✓ | Mod† | — | — |
| Move cards (drag-and-drop, column / swimlane change) | ✓ | Move† | — | — |
| Archive / restore cards | ✓ | Own† | — | — |
| Delete cards | ✓ | Own† | — | — |
| Link / unlink related cards | ✓ | ✓ | — | — |
| **Collaboration** | | | | |
| Add comments | ✓ | ✓ | ✓ | — |
| Delete comments | ✓ | Own† | Own | — |
| Add attachments | ✓ | ✓ | ✓ | — |
| Delete attachments | ✓ | Own† | Own | — |
| Add checklist items | ✓ | ✓ | ✓ | — |
| Edit / check / uncheck checklist items‡ | ✓ | Own† | Own | — |
| Delete checklist items‡ | ✓ | Own† | Own | — |
| **Board structure** | | | | |
| Create / edit / delete columns | ✓ | — | — | — |
| Reorder columns | ✓ | — | — | — |
| Create / edit / delete swimlanes | ✓ | — | — | — |
| Reorder swimlanes | ✓ | — | — | — |
| Create / edit / delete labels | ✓ | — | — | — |
| **Membership** | | | | |
| Invite members | ✓ | — | — | — |
| Change member roles | ✓ | — | — | — |
| Grant / revoke moderator | ✓ | — | — | — |
| Remove members | ✓ | — | — | — |
| Delete board | ✓ (owner only) | — | — | — |

**Own†** Members can perform this action only on content they created (cards they own, comments/attachments/checklist items they added). Members with the **moderator** entitlement — and admins — can perform it on any content.

**Own** (no dagger) Collaborators can perform this action only on content they created. Collaborators can't hold the moderator entitlement, so this restriction is unconditional for them.

**‡** The ownership gate on editing, checking/unchecking, and deleting checklist items was added in 1.1 ([#692](https://gitlab.com/visiban/visiban/-/issues/692)) — before that release, any member or collaborator could act on any item.

**Mod†** Requires the **moderator** entitlement or Admin role. Plain members who didn't create the card can't perform it, even on cards assigned to them. See [Moderator entitlement](#moderator-entitlement) below.

**Move†** Members can freely move unassigned cards, cards assigned to themselves, and cards they created. Moving a card assigned to another member, that the moving user didn't create, requires the **moderator** entitlement or Admin role. When blocked, the card snaps back to its original position and an amber toast displays: "Moving a card assigned to another member requires Moderator or Admin access — ask a board admin."

!!! note "Card move permission rule"
    A Member can always move a card if it's unassigned, assigned to themselves, or if they created it. The restriction applies only when moving a card assigned to a different user that the member didn't create — that requires Moderator or Admin access.

!!! note "Viewer boundary enforced since 1.0"
    Before 1.0, the Viewer role wasn't fully enforced at the API level — Viewers could post comments, upload attachments, and modify checklist items. Corrected in [#248](https://gitlab.com/visiban/visiban/-/issues/248): all write operations now return `403 Forbidden` for Viewers.

!!! note "Board export default and per-board threshold"
    By default, any board member (including Viewers and Collaborators) can export the full CSV or JSON dump — a role that can already read every card via the paginated API can reconstruct the board, so an unrestricted default is consistent. Re-affirmed in [#800](https://gitlab.com/visiban/visiban/-/issues/800). Board admins can restrict exports to a higher minimum role using the `export_min_role` board setting (added in 1.1, [#807](https://gitlab.com/visiban/visiban/-/issues/807)) — set it to `member`, `collaborator`, or any other level; Owners and site admins always bypass the threshold. Every successful export is recorded in the board's export history (added in 1.1, [#806](https://gitlab.com/visiban/visiban/-/issues/806)), visible to board admins under **Board Settings → Export History**.

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
