# Roles & Permissions

Visiban has five roles that control access at the group, board, and site level. **Why it matters:** this page is the single source of truth for what each role can and can't touch — check it before granting or denying access. It supersedes any other permission table in these docs; if another page's description ever disagrees with this one, this page is correct.

## Role hierarchy

| Role | Scope | Description |
|---|---|---|
| `site_admin` | Site-wide | Computed board/group role — full access to everything, granted when the user has `can_access_all_content` enabled. The separate `is_site_admin` flag protects the *user account* from demotion by anyone but another site admin. |
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
| Create personal board | ✓ | ✓ | ✓ | ✓ | ✓ |
| Import board from file | ✓ | ✓ | ✓ | ✓ | ✓ |
| Delete board | ✓ | owner only | — | — | — |
| Create / edit / delete columns | ✓ | ✓ | — | — | — |
| Reorder columns | ✓ | ✓ | — | — | — |
| Create / edit / delete swimlanes | ✓ | ✓ | — | — | — |
| Reorder swimlanes | ✓ | ✓ | — | — | — |
| Create / edit / delete labels | ✓ | ✓ | — | — | — |
| Invite members | ✓ | ✓ | — | — | — |
| Change member roles | ✓ | ✓ | — | — | — |
| Grant / revoke moderator | ✓ | ✓ | — | — | — |
| Remove members | ✓ | ✓ | — | — | — |
| **Cards** | | | | | |
| View cards & movement history | ✓ | ✓ | ✓ | ✓ | ✓ |
| View archived cards | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create card | ✓ | ✓ | ✓ | — | — |
| Edit own card (title, description, priority, due date, weight, labels) | ✓ | ✓ | ✓ | — | — |
| Edit any card | ✓ | ✓ | mod† | — | — |
| Move card (drag-and-drop, column / swimlane change) | ✓ | ✓ | move† | — | — |
| Assign card to member | ✓ | ✓ | mod† | — | — |
| Delete own card | ✓ | ✓ | ✓ | — | — |
| Delete any card | ✓ | ✓ | mod† | — | — |
| Archive / restore own card | ✓ | ✓ | ✓ | — | — |
| Archive / restore any card | ✓ | ✓ | mod† | — | — |
| Link / unlink related cards | ✓ | ✓ | ✓ | — | — |
| **Collaboration** | | | | | |
| Comment on cards | ✓ | ✓ | ✓ | ✓ | — |
| Delete own comment | ✓ | ✓ | ✓ | ✓ | — |
| Delete any comment | ✓ | ✓ | mod† | — | — |
| Upload attachments | ✓ | ✓ | ✓ | ✓ | — |
| Delete own attachment | ✓ | ✓ | ✓ | ✓ | — |
| Delete any attachment | ✓ | ✓ | mod† | — | — |
| Add checklist items‡ | ✓ | ✓ | ✓ | ✓ | — |
| Edit / check / uncheck own checklist item‡ | ✓ | ✓ | ✓ | ✓ | — |
| Edit / check / uncheck any checklist item‡ | ✓ | ✓ | mod† | — | — |
| Delete own checklist item‡ | ✓ | ✓ | ✓ | ✓ | — |
| Delete any checklist item‡ | ✓ | ✓ | mod† | — | — |
| **Export & Import** | | | | | |
| Export board (CSV / JSON)§ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Analytics** | | | | | |
| View analytics & summary | ✓ | ✓ | ✓ | ✓ | ✓ |
| Export analytics CSV | ✓ | ✓ | — | — | — |

**†** `mod` = only members with the moderator entitlement. Regular members can only perform these actions on content they created. See [Moderator entitlement](#moderator-entitlement) below.

**†** `move` = Members can freely move unassigned cards, cards assigned to themselves, and cards they created. Moving a card assigned to another member that the moving user did not create requires the moderator entitlement or Admin role. When blocked, the card snaps back to its original position and an amber toast displays: "Moving a card assigned to another member requires Moderator or Admin access — ask a board admin."

**‡** The ownership gate on adding, editing, checking/unchecking, and deleting checklist items was added in 1.1 ([#692](https://gitlab.com/visiban/visiban/-/issues/692)) — before that release, any member or collaborator could act on any item.

**§** Every role can export by default — a board admin can raise the minimum required role with the `export_min_role` board setting. See the "Board export default and per-board threshold" note below.

!!! note "Personal boards"
    Any authenticated user can create a personal board regardless of their group-level role. The "Create personal board" row above reflects this — personal boards aren't scoped to a group, so group-level permissions don't apply. The permission table above reflects group-level permissions for all other rows.

!!! note "Viewer boundary enforced since 1.0"
    Before 1.0, the Viewer role wasn't fully enforced at the API level — Viewers could post comments, upload attachments, and modify checklist items. Corrected in [#248](https://gitlab.com/visiban/visiban/-/issues/248): all write operations now return `403 Forbidden` for Viewers.

!!! note "Board export default and per-board threshold"
    By default, any board member (including Viewers and Collaborators) can export the full CSV or JSON dump — a role that can already read every card via the paginated API can reconstruct the board, so an unrestricted default is consistent. Re-affirmed in [#800](https://gitlab.com/visiban/visiban/-/issues/800). Board admins can restrict exports to a higher minimum role using the `export_min_role` board setting (added in 1.1, [#807](https://gitlab.com/visiban/visiban/-/issues/807)) — set it to `member`, `collaborator`, or any other level; Owners and site admins always bypass the threshold. Every successful export is recorded in the board's export history (added in 1.1, [#806](https://gitlab.com/visiban/visiban/-/issues/806)), visible to board admins under **Board Settings → Export History**.

!!! note "Export analytics CSV is a UI convenience, not an API boundary"
    The analytics CSV is generated client-side from data already returned by the `summary`/`analytics` endpoints, which any board member (including Viewers) can read. Hiding the **Export CSV** button for non-Admins keeps the action consistent with the board-structure permissions above; it is not a data-access restriction, since a Member could already read the same numbers through the API.

## How to set board roles

See [Board Permissions — How to set roles](../permissions.md#how-to-set-roles) for the board-toolbar UI steps.

## Moderator entitlement

Board admins can grant the **moderator** entitlement to any member or admin via the Members tab in Board Settings. A moderator can assign, edit, delete, and archive cards created by other users, and delete comments, attachments, and checklist items created by other users — normally a member can only do this on their own content.

Moderator is a boolean flag (`is_moderator`) on the board membership, not a separate role. It appears as a checkbox next to the role dropdown. Demoting a moderator to collaborator or viewer automatically clears the flag. The checkbox is only available for members and admins — collaborators and viewers can't be designated as moderators.

See [Board Permissions — Moderator entitlement](../permissions.md#moderator-entitlement) for how to grant it in the board UI and the assignee-dropdown gating behavior.

## Site admin protection

Site admins can't be demoted or removed by anyone but another site admin. A role-change or remove-member call on a group or board that **targets a user with `is_site_admin=True`** returns `403 Forbidden` unless the caller is also a site admin.

The board **Members** settings follow the same rule: for a board admin who is not a site admin, a member with `is_site_admin=True` shows their role as plain text, with no role dropdown and no remove button. A member who has only `can_access_all_content` (listed with the **Site admin** board role) can still be assigned a board role, but their effective access stays full for as long as they have `can_access_all_content`. *(Since 1.2.)*

**Watch out:** manage `is_site_admin` and `can_access_all_content` together (the `set_site_admin` command does this for you). Separate them only when you have a specific reason — see the tip below.

Users with `can_access_all_content` see all boards and groups regardless of explicit membership — this is the flag that controls board-level omniscience. `is_site_admin` alone doesn't grant it.

!!! note "Two flags, two purposes"
    `is_site_admin` gates admin panel access and protection from demotion. `can_access_all_content` gates implicit board/group access. The `set_site_admin` management command sets both together, but they can be managed independently via the admin panel. See [Site Admins](../../administration/site-admins.md) for details.

See [Managing Roles](managing.md) for how to grant site admin status.
