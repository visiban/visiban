# Django Admin Panel

The Django admin panel is available at `/admin/` on the backend server (port 8000 in development).

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
- **Site settings** — instance-wide configuration (registration toggle); clicking the entry goes directly to the settings form — there is always exactly one row
- **Boards, columns, swimlanes** — direct database access for debugging
- **Group memberships** — view and correct membership records
- **Social accounts** — inspect OAuth-linked accounts

## Production note

Restrict access to the Django admin in production via network policy or Nginx — it should not be publicly accessible.
