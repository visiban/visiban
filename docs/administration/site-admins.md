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
