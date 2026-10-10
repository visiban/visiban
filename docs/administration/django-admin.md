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

Log in with any user that has `is_staff = True` or `is_superuser = True`. The site admin account created by `ensure_site_admin` has `is_staff` and `is_superuser` set, so it can sign in here once it has changed the generated password (see below). To give another account Django admin access, set `is_staff` on it:

```bash
python manage.py shell -c "
from accounts.models import User
u = User.objects.get(username='someone')
u.is_staff = True
u.save()
"
```

An account with a forced password or username change pending (`must_change_password` or `must_change_username`) cannot use the Django admin until it completes the change in the web app: `/admin/` redirects it to the app and refuses form submissions. Only **Log out** stays available. The account created by `ensure_site_admin` starts with `must_change_password` set, so it changes its password in the web app before it can use the Django admin.

## Passwords

- **Your own password:** the admin's **Change password** link opens the web app, where you change it like any other user.
- **Another user's password** (the user's **Password** form at `/admin/accounts/user/<id>/password/`): saving a new password, or disabling password sign-in, deletes that user's Personal Access Tokens and API token and ends their sessions. If a new password was set, the user must change it the next time they sign in.
- **Adding a user:** a user created here with a password must choose their own password the first time they sign in, the same as one created from the site-admin panel. A user created with password sign-in disabled is not asked to create one.

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
