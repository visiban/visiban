# Site Admins

## What is a site admin?

A site admin has unrestricted access to every board and group on the instance. They are protected — no regular admin can remove or demote them.

See [Roles & Permissions](../features/rbac/roles.md) for the full permission table.

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
| **Invite-only** | Only accounts created by a site admin can log in; self-registration and OAuth sign-up are blocked |
| **Closed** | All registration is disabled |

The change takes effect immediately — no restart required.

**What changes when invite-only or closed is enabled:**

- `POST /api/auth/registration/` returns `403 Forbidden` for new sign-ups
- OAuth sign-up flows (Google, GitHub, GitLab) are also blocked — existing OAuth-linked accounts can still log in, but new OAuth accounts cannot be created
- The login page shows: *"An invite link is required to create an account."*
- Existing users are unaffected

**Creating accounts when invite-only is on:**

Use **Site Admin → Users → Add user** in the admin panel. Set a temporary password and enable **Force password reset** so the user is prompted to choose their own password on first login.

!!! warning
    Copy the temporary password before closing the Create User dialog — it is not shown again. Share it with the new user via a secure channel. If lost, deactivate the account and create a new one.

See [Admin Panel](admin-panel.md) for a full walkthrough of the user management interface.
