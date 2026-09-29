# Django Admin Panel

Django's built-in admin — for direct database record editing, not day-to-day
administration — lives at `/admin/` (**with** a trailing slash) on the backend
server (port 8000 in development).

Why it matters: this is a different page from the React **site-admin panel**
at `/admin` (**no** trailing slash — see [Admin Panel](admin-panel.md)), which
is what most day-to-day tasks (users, registration mode, maintenance mode)
should go through. The two share a URL prefix by coincidence of routing, not
by design — Nginx and the SPA router tell them apart by the trailing slash.

## Access

Log in with any user that has `is_staff = True` or `is_superuser = True`. The site admin account created by `ensure_site_admin` does **not** automatically have `is_staff` — set it manually if you need Django admin access:

```bash
python manage.py shell -c "
from accounts.models import User
u = User.objects.get(username='admin')
u.is_staff = True
u.save()
"
```

## What you can manage

- **Users** — view/edit all user accounts, set `is_site_admin`, `must_change_password`, `is_staff`
- **Site settings** — instance-wide configuration (registration mode, file uploads, [maintenance mode](maintenance-mode.md)); clicking the entry goes directly to the settings form — there is always exactly one row
- **Boards, columns, swimlanes** — direct database access for debugging
- **Group memberships** — view and correct membership records
- **Social accounts** — inspect OAuth-linked accounts

## Production note

**Restricted to loopback by default** — both the bundled Nginx config and
`AdminIPRestrictionMiddleware` block any client IP that isn't `127.0.0.1` or
`::1`, unless you widen the allowlist. See [Secret Rotation → Admin interface
access](secret-rotation.md#admin-interface-access) for the Compose and Helm
steps, and why they differ.
