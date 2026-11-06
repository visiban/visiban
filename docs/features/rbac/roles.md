# Check what each role can and can't touch

<a id="roles-permissions"></a>

Five roles control access at the group, board, and site level; the tables below are the single source of truth.

**Why it matters:** Check this page before granting or denying access. It supersedes any other permission table in these docs; if another page's description ever disagrees with this one, this page is correct.

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
| Move group under another group | ✓ | owner, or admin of a current parent group; plus admin of the new parent | — | — | — |
| Make a subgroup top-level | ✓ | owner, or admin of a current parent group | — | — | — |
| Delete group | ✓ | owner only | — | — | — |
| Manage group members | ✓ | ✓ | — | — | — |
| View group & boards | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Boards** | | | | | |
| Create board in group | ✓ | ✓ | — | — | — |
| Create personal board | ✓ | ✓ | ✓ | ✓ | ✓ |
| Import board from file (personal) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Import board into a group | ✓ | ✓ | — | — | — |
| Move board into a group | ✓ | ✓ | — | — | — |
| Delete board¶ | ✓ | owner only | — | — | — |
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

**¶** Deleting a board is permanent and removes every card on it, including archived cards, so it is limited to the board's **owner** and to users with `can_access_all_content` (the computed `site_admin` role). A board admin who is not the owner can manage the board's members, structure and settings but gets `403 Forbidden` on `DELETE /api/v1/boards/{id}/`. This is intentional. The web app matches: the dashboard, the board switcher and the **Danger Zone** in Board Settings offer **Delete board** only to the owner or a user with `can_access_all_content`. A non-owner board admin still sees the Danger Zone, with a note naming the owner instead of a delete button. If a delete is refused anyway (for example, ownership changed since the page loaded), the app shows why, keeps Board Settings open, and refreshes your role. Group admins and the separate `is_site_admin` account flag don't grant it either, unless the user is also the owner or has `can_access_all_content`.

**†** `mod` = only members with the moderator entitlement. Regular members can only perform these actions on content they created. See [Moderator entitlement](#moderator-entitlement) below.

**†** `move` = Members can freely move unassigned cards, cards assigned to themselves, and cards they created. Moving a card assigned to another member that the moving user did not create requires the moderator entitlement or Admin role. When blocked, the card snaps back to its original position and an amber toast displays: "Moving a card assigned to another member requires Moderator or Admin access — ask a board admin."

**‡** The ownership gate on adding, editing, checking/unchecking, and deleting checklist items was added in 1.1 ([#692](https://gitlab.com/visiban/visiban/-/issues/692)) — before that release, any member or collaborator could act on any item.

**§** Every role can export by default — a board admin can raise the minimum required role with the `export_min_role` board setting. See the "Board export default and per-board threshold" note below.

!!! note "Personal boards"
    Any authenticated user can create a personal board regardless of their group-level role. The "Create personal board" row above reflects this — personal boards aren't scoped to a group, so group-level permissions don't apply. The permission table above reflects group-level permissions for all other rows.

!!! note "Viewer boundary enforced since 1.0"
    Before 1.0, the Viewer role wasn't fully enforced at the API level — Viewers could post comments, upload attachments, and modify checklist items. Corrected in [#248](https://gitlab.com/visiban/visiban/-/issues/248): all write operations now return `403 Forbidden` for Viewers.

!!! note "Board export default and per-board threshold"
    By default, any board member (including Viewers and Collaborators) can export the full CSV or JSON dump — a role that can already read every card via the paginated API can reconstruct the board, so an unrestricted default is consistent. Re-affirmed in [#800](https://gitlab.com/visiban/visiban/-/issues/800). Board admins can restrict exports to a higher minimum role using the `export_min_role` board setting (added in 1.1, [#807](https://gitlab.com/visiban/visiban/-/issues/807)) — set it to `member`, `collaborator`, or any other level; Owners and site admins always bypass the threshold. **Scope:** `export_min_role` limits only the export action and its file formats (board CSV/JSON and movement-history exports). It does not change what a member can read through the board, card list, `/api/v1/cards/`, `full`, timeline, or MCP read endpoints — those follow board membership. Every successful export is recorded in the board's export history (added in 1.1, [#806](https://gitlab.com/visiban/visiban/-/issues/806)), visible to board admins under **Board Settings → Export History**.

!!! note "Export analytics CSV is a UI convenience, not an API boundary"
    The analytics CSV is generated client-side from data already returned by the `summary`/`analytics` endpoints, which any board member (including Viewers) can read. Hiding the **Export CSV** button for non-Admins keeps the action consistent with the board-structure permissions above; it is not a data-access restriction, since a Member could already read the same numbers through the API.

## Group membership implies board access

<a id="group-membership-board-visibility"></a>

Adding a user to a group, at any role including `viewer`, gives them access to every board in that group and in all of its sub-groups. This is by design: group membership implies board access. It is more than seeing board names. The user gets their group role on each of those boards, so a `viewer` can read all cards, comments, and movement history, and a `member` can create and move cards.

**Watch out:** a per-board `BoardMembership` row doesn't hide a board from someone who is already in the group. It only changes the role they hold on that one board (for example, a group `admin` set to `viewer` on a sensitive board), and every other board in the group stays visible to them. To keep a user out of some boards in a group:

- Don't add them to the group (or to any parent group). Give them `BoardMembership` rows on only the boards they need.
- Or move the sensitive boards into a separate group the user isn't in.

Users with `can_access_all_content` see every board regardless of group. See [Group Inheritance](inheritance.md) for the full resolution order and how sub-group visibility works.

## How to set board roles

See [Board Permissions — How to set roles](../permissions.md#how-to-set-roles) for the board-toolbar UI steps.

## Moderator entitlement

Board admins can grant the **moderator** entitlement to any member or admin via the Members tab in Board Settings. A moderator can assign, edit, delete, and archive cards created by other users, and delete comments, attachments, and checklist items created by other users — normally a member can only do this on their own content.

Moderator is a boolean flag (`is_moderator`) on the board membership, not a separate role. It appears as a checkbox next to the role dropdown. Demoting a moderator to collaborator or viewer automatically clears the flag. The checkbox is only available for members and admins — collaborators and viewers can't be designated as moderators. Even if a flagged collaborator or viewer row exists (for example one written through the Django admin), the flag is ignored: moderation rights apply only to members and admins. Promoting such a collaborator or viewer to member or admin through the Members tab (the members API) clears the stale flag unless the same change sets the moderator flag. A role changed directly in the Django admin does not clear it, so check the moderator box there deliberately.

See [Board Permissions — Moderator entitlement](../permissions.md#moderator-entitlement) for how to grant it in the board UI and the assignee-dropdown gating behavior.

## Site admin protection

Site admins can't be demoted or removed by anyone but another site admin. A role-change or remove-member call on a group or board that **targets a user with `is_site_admin=True`** returns `403 Forbidden` unless the caller is also a site admin. The refusal applies to a user who already has a membership in that group or board; a user with no membership gets the same response as any other user with no membership.

> **Added in 1.2**

The board **Members** settings follow the same rule, for a board admin who is not a site admin:

- A member with `is_site_admin=True` and a membership on the board (a row with a numeric `id`) shows their role as plain text, with no role dropdown and no remove button. When the member also has all-content access, the row instead shows the **Full access** chip (below) with the stored role line and no dropdown, and a visible line, "This membership is managed at the instance level and cannot be removed here", says why there is no **Remove board role** action: the server refuses to change that membership.
- Members who belong through the board's group, and a board owner without a membership, are editable even when their row carries `is_site_admin=True`, because the server accepts a role change for a user with no membership on the board: the first role change creates a board membership for them.
- The lock keys on a membership-backed row plus the site-admin flag, so it does not depend on which readers receive the flag.
- Which readers get the instance-wide roster is unchanged: a reader with `can_access_all_content` already resolves to the `site_admin` board role and gets it, as does a reader with `is_site_admin`.
- From then on that row carries the member's site-admin flag, and if they are a site admin it is locked for that board admin like any other site-admin membership.

> **Added in 1.2**

The board member list shows the board's own members: direct members, members inherited from the board's group, and the owner.

A site admin (or a user with `can_access_all_content`) viewing the board also sees every user with `can_access_all_content` who has no other role on it, listed with the `site_admin` role in the API. In the board's **Members** settings, a member with all-content access shows a **Full access** chip (a key icon and the words) instead of a role picker, because a board role cannot change what the member can do. Hovering the chip, or reading its description, says: "Full access to all boards. This account's board role doesn't apply." This also applies to a member who has all-content access and an explicit board membership, or who is listed through the board's group. The panel never shows a role that differs from a member's effective access without saying so. Board admins and site admins see this; other members do not see the Members controls.

- If the member has an explicit board membership, a line under their name reads "Board role: Viewer — not in effect while this account has all-content access." (using the stored role). The stored role is kept: it takes effect if the member's all-content access is later revoked.
- A row with no explicit membership shows the chip and no extra line.
- **Remove board role** (only when an explicit membership exists) asks "Remove this board role? Full access is not affected." and deletes only the stored membership; Escape dismisses the prompt. Afterward the member keeps full access. The action is not offered for a site admin whose membership you cannot change (see above).
- Site admins also see a **Manage in Admin → Users** link on the row, since the all-content setting is changed there, not per board.

The panel keeps the row listed until the board is next re-read; a re-read then lists the member only if you see the all-content roster, or they are also in the board's group or its owner. Their effective access stays full for as long as they have `can_access_all_content`. Anyone on the board can still @mention such a user by typing their username.

**Watch out:** manage `is_site_admin` and `can_access_all_content` together (the `set_site_admin` command does this for you). Separate them only when you have a specific reason — see the tip below.

Users with `can_access_all_content` see all boards and groups regardless of explicit membership — this is the flag that controls board-level omniscience. `is_site_admin` alone doesn't grant it.

!!! note "Two flags, two purposes"
    `is_site_admin` gates admin panel access and protection from demotion. `can_access_all_content` gates implicit board/group access. The `set_site_admin` management command sets both together, but they can be managed independently via the admin panel for accounts that are not superusers (a superuser always has both). *(1.3+)* Only a superuser can grant `can_access_all_content` there; any site admin can revoke it. See [Site Admins](../../administration/site-admins.md) for details.

See [Managing Roles](managing.md) for how to grant site admin status.
