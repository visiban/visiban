# Site Admins

## What is a site admin?

The term "site admin" covers two distinct privileges that are now tracked by separate flags:

| Flag | What it controls |
|---|---|
| `is_site_admin` | Access to the `/admin` admin panel and admin API (`/api/v1/admin/*`). Required to manage users, settings, and instance configuration. |
| `can_access_all_content` | Read/write access to **every board and group** on the instance, regardless of membership. This is the "omniscient" content access. |

Before Visiban 1.0.0-rc.9 (issue #247) these two were coupled — `is_site_admin` implied content access. They are now independent so operators can grant admin panel access without also granting board/group omniscience, and vice versa.

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

Go to `/django-admin/accounts/user/`, open the user, and enable the `Is site admin` checkbox.

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

Go to **Site Admin → Invite Links** to generate a new invite link. Send the link to the prospective user — they can follow it to complete self-registration. Each link can be configured with an expiry and optional use limit.

See [First Boot](../getting-started/first-boot.md) for a full walkthrough of the invite link workflow, and [Admin Panel](admin-panel.md) for the user management interface.
