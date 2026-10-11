# Site Admins

Two independent flags control what a "site admin" can do on your instance: who can manage it, and who can see every board and group on it.

## What is a site admin?

"Site admin" covers two distinct privileges, tracked by separate flags:

| Flag | What it controls |
|---|---|
| `is_site_admin` | Access to the `/admin` admin panel and admin API (`/api/v1/admin/*`). Required to manage users, settings, and instance configuration. |
| `can_access_all_content` | Read/write access to **every board and group** on the instance, regardless of membership. This is the "omniscient" content access. |

Before Visiban 1.0.0 these two were coupled — `is_site_admin` implied content access. They are now independent so operators can grant admin panel access without also granting board/group omniscience, and vice versa.

!!! note
    Existing site admins are **automatically migrated**: the database migration sets `can_access_all_content=True` for every row where `is_site_admin=True`, so no access is lost on upgrade.

See [Roles & Permissions](../features/rbac/roles.md) for the full permission table.

## Granting and revoking content access separately

If you want a user to manage the admin panel **without** seeing all boards and groups, grant `is_site_admin` but leave `can_access_all_content` off:

```bash
# Grant admin panel access only — board/group access unchanged
python manage.py set_site_admin <username>
# Then immediately revoke content access if the user should not have it:
# (use the admin panel toggle, or Django admin to uncheck can_access_all_content)
```

If you want a user to see all boards (e.g. a support engineer) **without** admin panel access, you can enable `can_access_all_content` via the admin panel (**Site Admin → Users → Grant all-content**) without enabling `is_site_admin`.

The `set_site_admin` management command always sets **both** flags together for convenience:

```bash
# Grant both flags
python manage.py set_site_admin <username>

# Revoke both flags
python manage.py set_site_admin <username> --revoke
```

To manage the flags independently, use **Site Admin → Users** in the admin panel.

## First site admin

On first boot, the `ensure_site_admin` management command creates an admin account automatically and prints a one-time password. See [First Boot](../getting-started/first-boot.md).

## Granting site admin

**Admin panel (recommended)**

Go to **Site Admin → Users** (`/admin`), find the user, and click **Make admin** in their row.

**Management command**

```bash
python manage.py set_site_admin <username>

# Docker
docker compose run --rm backend python manage.py set_site_admin <username>
```

**Django admin panel (advanced)**

Go to `/admin/accounts/user/` (the Django admin — see [Django Admin](django-admin.md) for why this differs from the `/admin` site-admin panel above), open the user, and enable the `Is site admin` checkbox.

## Revoking site admin

**Admin panel (recommended)**

Go to **Site Admin → Users** (`/admin`), find the user, and click **Remove admin** in their row.

**Management command**

```bash
python manage.py set_site_admin <username> --revoke
```

!!! note
    A site admin cannot demote themselves — this prevents accidentally locking yourself out of the instance. To revoke your own status, ask another site admin to do it. The last active site admin on the instance cannot be demoted through the admin API or the site-admin panel.

## Restricting registration

By default, anyone can create an account on a Visiban instance. The **Settings** tab in the admin panel (`/admin`) lets you change this:

| Mode | Effect |
|---|---|
| **Open** | Anyone can register |
| **Invite-only** | New users must present a valid invite link to register. Existing users are unaffected. |
| **Closed** | All registration is disabled |

The change takes effect immediately — no restart required.

**What changes when invite-only or closed is enabled:**

- **Invite-only:** `POST /api/v1/auth/registration/` refuses a sign-up without a valid invite token with `400 Bad Request`, and OAuth sign-up (Google, GitHub, GitLab, OIDC) is refused the same way. With a valid invite — a site invite link, or *(1.2+)* an emailed group or board invite sent by a site admin — both work.
- **Closed:** `POST /api/v1/auth/registration/` returns `403 Forbidden` for every new sign-up, invite or not, and new OAuth accounts cannot be created. The only way to add a user is **Admin → Users → Add user**.
- Existing users, including OAuth-linked accounts, can still log in either way.
- The login page shows: *"An invite link is required to create an account."*

**Inviting users when invite-only is on:**

Go to **Site Admin → Invite Links** to generate a new invite link. Send the link to the prospective user — they can follow it to complete self-registration. Each link can be configured with an expiry and optional use limit. Up to 50 shareable links can be active at once. *(1.2+)* A site invite link creates accounts only while the admin who created it is still an active site admin. Deactivating or deleting that admin (by any means, including the Django admin's **Active** checkbox), or removing their site admin status (**Remove admin** in the admin panel, `set_site_admin --revoke`, or removing their superuser status in the Django admin), stops their links from working, and **Site Admin → Invite Links** then lists those links as **Revoked** and no longer counts them toward the 50-link limit. **Remove admin**, `set_site_admin --revoke`, removing superuser status and deactivation from the admin panel also mark the pending links revoked. A link shown as **Revoked** only because its creator lost standing is not permanently revoked: if the creator's standing is restored, it becomes usable again. To retire such a link for good, revoke it explicitly while its creator is in good standing (the **Revoke** action is shown only for pending links), or at any time through `DELETE /api/v1/admin/invite-links/{id}/` (see the [Admin API](../api/admin.md)).

**Who can admit new accounts on an invite-only instance:** only site admins. Besides site invite links, *(New in 1.2)* an invite a **site admin** emails from a group's invite panel lets its recipient create an account (password or OAuth) and joins them to that group with the invite's role. It is single-use and expires in 7 days by default. It stops creating accounts if its sender is deactivated, is no longer a site admin, or is no longer an admin of the group, and when email invites are turned off (`INVITE_EMAIL_ENABLED=false`, see [Configuration](configuration.md)) — including invites already sent. Emailed invites from group admins who are not site admins, and every shareable group link, only work for people who already have an account; the group panel tells those senders so. See [Groups](../features/groups.md#new-users-on-invite-only-instances).

*(New in 1.2)* **Board invites follow the same rule.** An invite a **site admin** emails from a board's **Board Settings → Members → Invite by email** lets its recipient create an account and adds them to that board with the invite's role (member, collaborator or viewer). It stops creating accounts if its sender is deactivated, loses site admin, or is no longer an admin of the board, and when `INVITE_EMAIL_ENABLED` is off. A board admin who is not a site admin can invite only people who already have an account; their pending invites show an **Existing accounts only** tag. There is no separate setting for this. On a **closed** instance no invite creates an account; on an **open** one anyone can sign up and the invite then adds them to the board.

*(New in 1.2)* **Shareable board invite links never create accounts on an invite-only instance** — not even one a site admin created. They let people who already have an account join the board; on an **open** instance a newcomer can sign up first and then joins. Their create form says which applies. Site admins can see and revoke every board's invites, emailed and shareable, under **Site Admin → Board Invites** (see [Admin Panel](admin-panel.md#board-invites-tab)).

*(New in 1.2)* Site admins can also have Visiban **email an invite** straight to an address: under **Site Admin → Invite Links**, enter the address in **Invite by email** and select **Send invite** (also available as `POST /api/v1/admin/invite-links/send/`; see the [Admin API](../api/admin.md)). If emailing isn't available — email isn't set up, or `INVITE_EMAIL_ENABLED` is off — the section points you to **Settings → Email** instead; on a demo site it just says email invites are disabled. Visiban creates a single-use link that expires in 7 days (the API also accepts 1 or 30) and sends it from the instance's sender address. Emailed links have their own limit — 200 pending — and don't count against the 50 shareable links. The address is not stored; the `202` response includes `already_registered`, saying whether it already belongs to an account (the email is sent either way), and never the raw token. If the mail server rejects the message, the endpoint returns `502` with a sanitized error `code` and revokes the link automatically. `invite_email_available` on `GET /api/v1/auth/site-config/` tells clients whether sending is currently possible. Emailing requires working outbound email and can be switched off with `INVITE_EMAIL_ENABLED=false` (see [Configuration](configuration.md)). Following the link does not verify the recipient's address — registration still follows the normal email-verification setting.

See [First Boot](../getting-started/first-boot.md) for a full walkthrough of the invite link workflow, and [Admin Panel](admin-panel.md) for the user management interface.
