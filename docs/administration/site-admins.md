# Site Admins

## What is a site admin?

A site admin has unrestricted access to every board and group on the instance. They are protected — no regular admin can remove or demote them.

See [Roles & Permissions](../features/rbac/roles.md) for the full permission table.

## First site admin

On first boot, the `ensure_site_admin` management command creates an admin account automatically and prints a one-time password. See [First Boot](../getting-started/first-boot.md).

## Granting site admin

**Management command**

```bash
python manage.py set_site_admin <username>

# Docker
docker compose run --rm backend python manage.py set_site_admin <username>
```

**Django admin panel**

Go to `/admin/accounts/user/`, open the user, and enable the `Is site admin` checkbox.

## Revoking site admin

```bash
python manage.py set_site_admin <username> --revoke
```

Or uncheck `Is site admin` in the Django admin panel.

!!! note
    A site admin can revoke their own site admin status. Ensure at least one site admin remains on the instance.

## Restricting registration (invite-only mode)

> **Added in v1.0.0-rc.6**

By default, anyone can create an account on a Visiban instance. You can restrict this so that only users created directly by a site admin can log in.

**To enable invite-only mode:**

1. Go to `/admin/accounts/sitesetting/1/change/`
2. Enable **Require invite for registration**
3. Click **Save**

The change takes effect immediately — no restart required.

**What changes when enabled:**

- `POST /api/auth/registration/` returns `403 Forbidden` for new sign-ups
- OAuth sign-up flows (Google, GitHub, GitLab) are also blocked — existing OAuth-linked accounts can still log in, but new OAuth accounts cannot be created
- The login page shows: *"An invite link is required to create an account."*
- Existing users are unaffected

**Creating accounts when invite-only is on:**

Go to `/admin/accounts/user/add/` and create the account manually. The new user can then set a password or link an OAuth provider on first login.
