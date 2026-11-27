# Onboard a team by adding one group

<a id="groups"></a>

> **Added in 1.0**

Create a group, add people with a role, and they get that role on every board in it and in its subgroups.

**Why it matters:** Membership and shared settings inherit down the tree, so a manager can onboard a whole team by adding one group instead of every board.

**The big picture:** groups organize boards and users into a hierarchy.

- A board belongs to one group; a group has one parent group.
- Group trees are walked **up to 6 levels deep**. Creating a subgroup, or moving a group to a new parent, is refused when the result would be deeper.

```
Acme Corp  (top-level group)
├── Engineering
│   ├── Backend Team
│   └── Frontend Team
└── Sales
```

## Structure

The tree above shows a top-level group with two subgroups, one of which has two team groups of its own.

## Membership

Each group has members with one of four roles:

| Role | What they can do |
|---|---|
| `admin` | Manage members, create subgroups and boards |
| `member` | View boards and subgroups, create personal boards |
| `collaborator` | View boards in the group; can comment on cards but cannot create, edit, move, or delete them |
| `viewer` | Read-only access to all boards in the group — can view cards and card history but cannot create, edit, move, delete cards, or manage members |

Only the group owner or a site administrator can delete a group; other group admins see a note naming the owner in **Group settings → Danger zone** instead of the Delete button. The owner confirms by typing the group's name.

The group owner's row in **Group settings → Members** shows the role as plain text, with no role dropdown or Remove button; transfer ownership first to change the owner. If the server refuses a member removal or role change (for example the last remaining admin), the panel shows the server's reason instead of a generic error.

Membership is **inherited**: a member of "Acme Corp" is automatically a member of "Engineering" and all its descendants, with no need to add users to each subgroup. See [Group Inheritance](rbac/inheritance.md).

## Board roles vs group roles

All four roles (`admin`, `member`, `collaborator`, `viewer`) are valid at both the group and board level. A group role is inherited by every board in the group. A board admin can raise or narrow a user's role on a specific board from the **Members** button in the board toolbar, except below `admin` for someone who is an admin through the group. See [Roles & Permissions](rbac/roles.md).

## Group description

Each group has an optional **description**: a short free-text summary of its purpose. It appears on the group detail page, under the name. Group admins click it to edit inline, then press **Enter** (or click outside) to save, or **Escape** to cancel.

The description is returned as `description` in `GET /api/v1/groups/{id}/` and is writable via `PUT /api/v1/groups/{id}/` (group admin required).

## The group page and Group settings

*(1.3+, #2478)* The group page uses the same Overview layout as [Home](navigation.md#home). The header shows the breadcrumb **Home / ancestors / the group**, with the group's name as the page title, and **Import** and **New board** for anyone who can place boards in the group. Under it:

- the group's name (admins click it or the pencil to rename), its health status, a star, and the description (admins click it to edit);
- "N members · N boards · N subgroups" and the live connection status;
- **Invite** and **Group settings** (group admins only; on a phone they are in the **⋯** menu);
- **Boards**, with **Show subgroup boards**. Each row shows the name, description, card count and health status. The **⋯** menu holds **Move to another group** (group admins) and **Delete** (the board's owner or a user with all-content access). A board owner who is not a group admin sees the menu with **Delete** only;
- **Subgroups**, as cards with board and member counts and the "Not reviewed in N days" cue, plus **+ New subgroup** for group admins;
- **Members**, a side column (below the content on a phone) that everyone in the group sees, with role chips. **Manage** (group admins only) opens Group settings → Members.

Group admins reach **Group settings** from the header, or at `/groups/{id}?tab=settings`. It lists six sections, with **Find a setting** above them: **Members**, **Invite links**, **Health status review**, **Board defaults**, **Shared labels** and **Danger zone**. A section has its own address, for example `?tab=settings&section=danger-zone`. People who are not group admins who open a settings link see the group page instead.

A group you can see only because you belong to one of its subgroups (a navigation-only group) shows its name and nothing else: no counts, health status or members.

## Ancestor breadcrumb chain

For a group with a parent, the header's breadcrumb shows every ancestor from the root down to the immediate parent, each a clickable link. It orients you and lets you navigate up deep hierarchies.

The full ancestor list is also in the API: `GET /api/v1/groups/{id}/` returns an `ancestors` array (see [Groups API](../api/groups.md)).

## Boards inside groups

Boards in a group are visible to all group members. This includes `viewer` members, who get read access to every board in the group; see [Group membership implies board access](rbac/roles.md#group-membership-board-visibility). Group admins can create boards from the group detail page, or **import** a board from a previously exported JSON or CSV file directly into the group. Move a board between groups (or back to personal) with the move button that appears on hover.

## Subgroups

Group admins can create subgroups. Access is inherited through up to 6 levels of nesting; creating a subgroup, or moving a group under a new parent, is refused when the resulting tree would be deeper than 6 levels. Trees that were already deeper before this limit applied to creation are left as they are.

The group detail page shows subgroups, and the "Show subgroup boards" toggle optionally lists all boards across subgroups. *(1.3+)* Those boards load 50 at a time: the list ends with "Showing N of M subgroup boards" and a **Load more** button, which keeps the boards already shown if a page fails to load and offers **Retry**. The total excludes boards already shown in the group's own list, so "M" counts only boards that belong in this list. The boards are listed oldest first (by when they were created); before 1.3 the list showed the most recently updated board first. When a change arrives in real time, the page refreshes up to the first four pages it has loaded; boards loaded beyond those stay on screen and can show stale details, or a board deleted elsewhere, until the list is next loaded in full (turn the toggle off and on, or reload the page).

## Invite links

> **Added in 1.0**

Group admins generate up to **5 active invite links** per group from the group detail page. Anyone with the link joins with the role assigned to that link. Each link is configured independently:

| Setting | Options |
|---|---|
| **Name** | Optional label to identify the link's purpose |
| **Role** | `member`, `collaborator`, or `viewer` (the role granted on join) |
| **Expiry** | 1 day, 7 days (the default), or 30 days |
| **Single-use** | When enabled, the link is deactivated after the first person uses it |

> **Added in 1.1** — single-use invite links (#689)

> **Changed in 1.2** — a shareable link can no longer grant `admin` and always expires (#1727)

A shareable link works for anyone who holds it, wherever it ends up being pasted, so it cannot make someone a group admin (which would make them an admin of every board in the group and its subgroups) and it cannot live forever. An [emailed invite](#emailing-an-invite-link) cannot grant admin either, since a forwarded or misdirected email would do the same. To make someone an admin, change their role after they join. Upgrading to 1.2 revokes unused shareable links that had the `admin` role and gives unused links with no expiry an expiry 7 days after the upgrade. An emailed invite with the `admin` role sent before the upgrade stops working (it answers like a revoked link); send a new one as a member.

**Link status:**

- Expired links show a visual indicator and can't be used to join.
- Used single-use links display a status badge and consumed-at timestamp in the invite links list.
- Each link can be revoked independently. Existing members are not affected.

> **Added in 1.2**

**Creator must stay an admin.** A link only works while the person who created it is an active user and still an admin of the group (or of a parent group).

- **Creator deactivated:** a site admin deactivating their account revokes all of their active, unused group invite links at once. Consumed single-use links are left alone, so they keep showing as used. The links disappear from the group's invite panel in real time.
- **Creator demoted or removed from the group:** the link stops working at the next preview or join, and it is revoked so it drops off the active list and frees its slot toward the 5-link cap. Links that lapsed before this fix are cleaned up by an upgrade migration.
- In both cases the link answers like any revoked link (`404 Not found`); the response does not say why.

**How it works:**

- **Unauthenticated visitors** see a full authentication interface: a **Create account and join** button (primary), an **I already have an account** button, and the sign-in providers this instance has turned on (your SSO provider first, then Google / GitHub / GitLab). *(1.3+)* The page shows only the group or board name and the role, never who sent the invite or when it expires. *(1.2+)* When the link can't create an account on this instance, they see a sign-in-only view instead, with no **Create account and join** option — see [New users on invite-only instances](#new-users-on-invite-only-instances). After authenticating, the invite is accepted automatically and they land on the group page with a "You've joined" notification at the bottom of the screen.
- **Authenticated users** join automatically: the page shows "Joining…" and then redirects to the group page. If already a member, they're silently redirected without re-joining.
- **Invalid or expired links** show a countdown timer and auto-redirect after 5 seconds (to Home when signed in, to sign in when signed out) — no manual action needed.

!!! tip
    Use invite links to onboard external collaborators without needing to know their username in advance. Create separate links for different roles (e.g. one `member` link for the team and one `viewer` link for stakeholders).

### Emailing an invite link

> **Added in 1.2** (#731)

Group admins can have Visiban email an invite straight to someone's address. In the group's **Invite links** panel, type the address under **Invite by email**, pick a role (Member, Collaborator or Viewer; never Admin), and select **Send invite** (the same action is available through `POST /api/v1/groups/{id}/invite-links/send/`; see the [Groups API](../api/groups.md)). The section only appears when sending is possible. Visiban creates a **single-use** link for that one person (role of your choice, expiring in 7 days; the API accepts 1–30, never "never") and emails it from the instance's own sender address. The email is plain text and names the group, the join link, and the expiry date; there is no custom message.

- Emailed links carry an **Emailed** badge in the panel, never show a copyable link (the token exists only in the email), and are returned by `GET /api/v1/groups/{id}/invite-links/` with `delivery: "email"`, can be revoked like any other link, and **don't count against the 5 shareable links**. A group can have up to 50 pending emailed links.
- The address itself is **not stored**. *(1.2+)* Visiban keeps only a keyed fingerprint of it, so the link works only for an account with that address. Someone signed in with a different account is told *"This invite was sent to a different email address…"* and the link stays unused. Shareable links are not tied to anyone. See [Site admins](../administration/site-admins.md) for which addresses count.
- The endpoint returns the same `202` response (`{"detail": "Invite sent", "sent_to": ...}`) whether the address belongs to an existing member, someone with an account, or nobody yet — it never reveals which addresses have accounts. The raw token is never returned; it exists only in the email.
- If the mail server rejects the message, the endpoint returns `502` with a sanitized error `code` and revokes the link automatically, so nothing is left dangling.
- Sending is rate-limited: 10 per hour per admin, 30 per day per group, 200 per day across the instance. Sends that are refused or that the mail server rejects don't count.
- Whether sending is possible is published as `invite_email_available` on the public `GET /api/v1/auth/site-config/` endpoint: it is `true` only when outbound email is configured (see [Configuration](../administration/configuration.md)), `INVITE_EMAIL_ENABLED` is not `false`, and the instance is not a demo. When the feature is switched off the endpoint returns `403` with `code: "invite_email_disabled"`.

!!! note
    Following the emailed link does **not** verify the recipient's email address. If they create a new account from it, registration still follows the instance's normal email-verification setting. *(1.2+)* With `EMAIL_VERIFICATION=mandatory`, the new account joins the group when the invited address is verified, not at sign-up; see [Site Admins](../administration/site-admins.md).

### New users on invite-only instances

<span class="vb-version" title="Added in 1.2">1.2+</span>

On an instance whose registration mode is **Invite-only**, an invite **emailed by a site admin** also lets a newcomer create an account: they select **Create account and join** (or an OAuth provider) on the join page, and the new account is added to the group with the invite's role. With `EMAIL_VERIFICATION=mandatory` and the invited address not yet verified, the account is added, and the invite used up, when that address is confirmed instead (see [Site Admins](../administration/site-admins.md)). Registering uses up (or, until confirmation, holds) the invite, so it creates one account (for OAuth sign-up this is best-effort, as it is for site invites: two simultaneous OAuth sign-ups with one link could both create an account, but only one joins the group). *(1.2+)* The sign-up address (or the address the OAuth provider reports) must be the one the invite was sent to; a different address is refused and the invite stays unused. The invite stops creating accounts if the person who sent it is deactivated, is no longer a site admin, or is no longer an admin of the group, or if email invites are turned off (`INVITE_EMAIL_ENABLED=false`); revoke it in the panel to stop it sooner.

Only site admins' emailed invites do this — admitting new people to an invite-only instance stays a site-admin decision, since any user can create a group and become its admin. An emailed invite from a group admin who is not a site admin, and any **shareable** link from the panel (single-use or not), still only work for people who already have an account. A newcomer who tries one is told: *"This invite link can't be used to create an account on this site. Ask a site admin for an invite."*

> **Added in 1.2**

The join page now says so up front. When the link can't create an account — a shareable link or a non-site-admin's invite on an invite-only instance, an invite whose sender no longer qualifies, email invites turned off, or any link on a **Closed** instance — a signed-out visitor sees *"This invite link can't be used to create a new account. Sign in with an existing account to join."* with only a **Sign in** button (plus any OAuth buttons, which sign in an existing account; a new OAuth sign-up from such a link is still refused), and no **Create account and join** option. The page deliberately doesn't say which of these reasons applies. Visitors who are already signed in are unaffected and join automatically. The check is a hint, not a guarantee: the server still decides at sign-up time, so a link can stop qualifying between the page loading and the form being submitted.

The **Invite by email** section shows which case applies. A site admin on an invite-only instance sees: *"New people can join this site only from invites you email, not from a shareable link."* Everyone else on an invite-only instance, and everyone on a **Closed** instance (where no invite creates an account), sees the warning: *"New users can't sign up on this site. Only people who already have an account can join from this invite."*

## Moving boards between groups

Move a board to a different group, or back to personal boards, from the **Move board** dialog. Open it with the move icon that appears when you hover over or tab to a board row:

- on Home, **Move to group** in the **...** menu of any row in **All boards** (see [Home](navigation.md#home));
- on a group page, **Move to another group** on a board in the group's **Boards** list.

Only board admins and site admins can move a board, and moving a board into a group also requires being an admin of that group (or of one of its parent groups). Importing or creating a board in a group needs the same group role.

> **Added in 1.2**

The dialog lists every group you can see, but groups you can't place boards in are shown disabled, with **Group admins only** next to the name. Their subgroups stay listed, and a parent group opens automatically when a subgroup you can use sits under it. If the board's current group is one you can't place boards in, it is not disabled; it shows **Current group** so you can switch back to it. If you can't place boards in any group, the dialog says so. On a group page, **New board** and **Import** appear only when you can place boards in that group.

**API:** `POST /api/v1/boards/{id}/move-group/` with `{ "group_id": 5 }` or `{ "group_id": null }` for personal.

## Group shared labels

> **Added in 1.0**

Group admins define a shared label library in **Group settings → Shared labels**. New boards created in the group inherit these labels, so your team starts with a consistent tagging vocabulary.

Each label's color is a preset swatch or a [custom color](board.md#custom-colors).

**Watch out:** inheritance is a one-time copy at board-creation time, not a live link. Renaming, recoloring, or deleting a group label only changes the group's shared library and future boards — boards that already inherited the label keep their own independent copy, unaffected by later edits or deletion.

**API:** `GET/POST /api/v1/groups/{id}/labels/`, `PATCH/DELETE /api/v1/groups/{id}/labels/{label_id}/`

## Group board defaults

Group admins see the defaults for new boards in **Group settings → Board defaults**. The default member role is deprecated and has no effect. Allowed priorities is also deprecated (#1429): it is copied onto new boards but not enforced, and since 1.3 the page no longer shows it (the API field is unchanged).

| Setting | Description |
|---|---|
| **Default member role** | **Deprecated (#1430).** Saved for API compatibility but has no effect: group members get their group role on every group board. Values: `admin`, `member`, `collaborator`, `viewer`; defaults to `member`. |
| **Allowed priorities** | **Deprecated.** Copied onto new boards created in the group, but not enforced — cards can use any priority. Kept for API compatibility and removed only in a future major release. An empty list `[]` (default) means all priorities. |

**API:** `PATCH /api/v1/groups/{id}/board-defaults/`

## Transferring group ownership

Only the **current owner** can transfer ownership, and only to an existing group **admin**. Open **Group settings → Danger zone → Transfer ownership**; the form opens in place below the button. Confirm by typing the group name exactly as shown. The previous owner becomes a regular admin and is not removed from the group.

If the owner has left or been deactivated, a superuser can transfer the group from the Django admin; see [Transferring a group's ownership](../administration/django-admin.md#transferring-a-groups-ownership).

**API:** `POST /api/v1/groups/{id}/transfer-ownership/` with `{ "new_owner_id": 42, "confirmation": "Group Name" }`

## Starring groups

The star button (☆/★) in the group detail page header marks a group as a favorite. Since 1.3 the navigation drawer's **Starred** section lists starred boards only, so a starred group is not listed there (#2473). The star updates optimistically and rolls back on failure.

## Live board list

<span class="vb-version" title="Added in 1.1">1.1+</span>

The group detail page auto-refreshes its board list over WebSocket. Boards created, renamed, deleted, or moved into or out of the group appear and disappear in real time, with no page refresh.

The page subscribes to a per-group WebSocket channel (`ws/groups/<group_id>/`) that emits:

| Event | Description |
|---|---|
| `board.created` | A new board was created in this group, or a board was moved into it (with move-group, by changing the board's `group` with `PATCH`/`PUT`, or by changing its group in the Django admin) |
| `board.updated` | A board was renamed or its settings changed |
| `board.deleted` | A board was deleted or moved out of this group |

A **Live / Reconnecting… / Offline** status indicator in the group page header uses the same `ConnectionStatus` component as the board view and reflects the same five states; the group page keeps **Reconnecting…** while it retries, where a board reads **Offline**. The group page does not wire a **Refresh board** action into the popover; its lists are re-read when the connection reconnects (see [Real-time updates](realtime.md)).

## Dashboard

The navigation drawer, opened from the header's menu button or `[`, lists your groups as a tree with their board counts, alongside your starred and personal boards (1.3+, replacing the persistent sidebar; see [Navigation](navigation.md)). Create boards and groups from Home (see [Home](navigation.md#home)) and the group page.

### Create Group modal

The **Create Group** modal has two fields:

| Field | Notes |
|---|---|
| **Name** | Required. The group's display name. |
| **Description** | Optional. A short summary of the group's purpose. A character counter is shown below the field as you type. |

After you create a group or subgroup, the modal switches to a **post-creation state** where you can add subgroups right away: type a name, click **+ Add** (or press Enter), and repeat. Each subgroup is created instantly. Click **Done** when finished.

This works at every level of the hierarchy: create "Engineering", add "Frontend" and "Backend" as subgroups, and even add sub-subgroups to those, all without leaving the modal.
