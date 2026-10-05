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
    A site admin cannot demote themselves — this prevents accidentally locking yourself out of the instance. To revoke your own status, ask another site admin to do it. The last active site admin on the instance cannot be demoted by anyone.

## Restricting registration

By default, anyone can create an account on a Visiban instance. The **Settings** tab in the admin panel (`/admin`) lets you change this:

| Mode | Effect |
|---|---|
| **Open** | Anyone can register |
| **Invite-only** | New users must present a valid invite link to register. Existing users are unaffected. |
| **Closed** | All registration is disabled |

The change takes effect immediately — no restart required.

**What changes when invite-only or closed is enabled:**

- `POST /api/v1/auth/registration/` returns `403 Forbidden` for new sign-ups
- OAuth sign-up flows (Google, GitHub, GitLab) are also blocked — existing OAuth-linked accounts can still log in, but new OAuth accounts cannot be created
- The login page shows: *"An invite link is required to create an account."*
- Existing users are unaffected

**Inviting users when invite-only is on:**

Go to **Site Admin → Invite Links** to generate a new invite link. Send the link to the prospective user — they can follow it to complete self-registration. Each link can be configured with an expiry and optional use limit. Up to 50 shareable links can be active at once.

*(New in 1.2)* Site admins can also have Visiban **email an invite** straight to an address: under **Site Admin → Invite Links**, enter the address in **Invite by email** and select **Send invite** (also available as `POST /api/v1/admin/invite-links/send/`; see the [Admin API](../api/admin.md)). If emailing isn't available — email isn't set up, or `INVITE_EMAIL_ENABLED` is off — the section points you to **Settings → Email** instead; on a demo site it just says email invites are disabled. Visiban creates a single-use link that expires in 1, 7 (default) or 30 days and sends it from the instance's sender address. Emailed links have their own limit — 200 pending — and don't count against the 50 shareable links. The address is not stored; the `202` response includes `already_registered`, saying whether it already belongs to an account (the email is sent either way), and never the raw token. If the mail server rejects the message, the endpoint returns `502` with a sanitized error `code` and revokes the link automatically. `invite_email_available` on `GET /api/v1/auth/site-config/` tells clients whether sending is currently possible. Emailing requires working outbound email and can be switched off with `INVITE_EMAIL_ENABLED=false` (see [Configuration](configuration.md)). Following the link does not verify the recipient's address — registration still follows the normal email-verification setting.

See [First Boot](../getting-started/first-boot.md) for a full walkthrough of the invite link workflow, and [Admin Panel](admin-panel.md) for the user management interface.
