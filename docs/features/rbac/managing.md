# Managing Roles

How to assign, change, and revoke group, board, and site admin roles via the UI or API.

## Board membership

Board admins can add, change, or remove members via the board settings panel or the API.

```http
POST /api/v1/boards/{board_id}/members/
{ "user_id": 42, "role": "member" }

DELETE /api/v1/boards/{board_id}/members/42/
```

Valid board roles: `admin`, `member`, `collaborator`, `viewer`

### Inviting someone by email

*(New in 1.2)* To add someone who isn't on Visiban yet — or whose account you can't find — open **Board Settings → Members**. Under **Invite by email**, enter their address, pick a **Role** (Member, Collaborator or Viewer — never Admin) and when the invite **Expires** (1, 7 or 30 days), and select **Send invite**. If a search in **Add member** finds no one for an email address, **Invite by email** next to "No results" fills the form for you.

Visiban emails a single-use link. Following it shows what the invite grants; the recipient signs in (or creates an account, where the site allows it) and lands on the board with a "You've joined" notice. **Pending invites** lists what you have sent, newest first, with who sent each and when — Visiban doesn't store the address an invite went to, so tell them apart by date. Revoke an invite you no longer want; used, expired and revoked invites sit under **Show past invites**. An **Existing accounts only** tag means a new person couldn't create an account from that invite on this site right now (see [Site admins](../../administration/site-admins.md)).

!!! note "An explicit board role replaces a group role"
    A direct board membership **overrides** the role someone inherits from the board's group — it does not add to it. That is why redeeming an invite never touches an existing board membership and never lowers anyone: a group admin who follows a viewer invite stays an admin. Invites only create a membership for someone with no access, or whose inherited role is lower than the invite's. The same trap applies when you set roles by hand: giving a group admin a direct **Viewer** role on a board makes them a viewer there.

### Sharing an invite link

*(New in 1.2)* To invite several people at once — or anyone you can reach in a chat channel — select **New link** next to **Pending invites**. Pick a **Role** (Member, Collaborator or Viewer), when it **Expires** (1, 7 or 30 days; an invite link always expires), optionally a name and **Single use**, and select **Create link**. Copy the link straight away: it is shown **once**, and Visiban keeps only a fingerprint of it. Anyone holding it can join the board after signing in, until it expires or you revoke it; **1-use** links stop after the first person joins. A board can have up to 5 active invite links (emailed invites don't count).

An invite link is not the board's **Share link** (Settings → Sharing), which lets anyone *view* the board without signing in. Whether a newcomer can create an account from an invite link depends on the site: on an open site they sign up and then join; on an invite-only or closed site only people who already have an account can use it, and the form tells you so.

A board invite never adds the person to the board's group. The emailed invite needs working outbound email (`INVITE_EMAIL_ENABLED`); the API is documented in [Boards API — Board invites](../../api/boards.md#board-invites).

## Group membership

Group admins can change or remove members from the group detail page or the API.

```http
PATCH /api/v1/groups/{group_id}/members/42/
{ "role": "admin" }

DELETE /api/v1/groups/{group_id}/members/42/
```

Valid group roles: `admin`, `member`, `collaborator`, `viewer`

Group admins can also invite members without knowing their username in advance (invite links), delegate group ownership, and save a default member role for boards in the group (not yet enforced: group members keep their group role on every group board). See [Groups](../groups.md#invite-links), [Groups — Transferring group ownership](../groups.md#transferring-group-ownership), and [Groups — Group board defaults](../groups.md#group-board-defaults).

## Granting site admin

Site admin status is a field on the `User` model (`is_site_admin`). It can be set via:

**Management command (recommended)**

```bash
# Grant
python manage.py set_site_admin <username>

# Revoke
python manage.py set_site_admin <username> --revoke

# Docker
docker compose run --rm backend python manage.py set_site_admin <username>
```

**Django admin panel**

Navigate to `/admin/accounts/user/`, find the user, and toggle the `is_site_admin` checkbox.

!!! note "Two separate flags"
    The `set_site_admin` command sets both `is_site_admin` (admin panel access) and `can_access_all_content` (board/group omniscience) together. To manage them independently — for example, granting admin panel access without board omniscience — use the admin panel instead. See [Site Admins](../../administration/site-admins.md) for details.

!!! warning
    The `is_site_admin` flag protects the user from demotion: any group or board role-change or remove-member API call targeting a user with `is_site_admin=True` returns `403 Forbidden` unless the caller is also a site admin. The same protection applies to board membership — see [Site admin protection](roles.md#site-admin-protection).

    Grant site admin only to trusted operators.
