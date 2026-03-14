# First Boot

## Automatic admin bootstrap

On the very first startup — when no site admin exists — Visiban creates an admin account and prints a one-time password to stdout:

```
============================================================
  VISIBAN INITIAL ADMIN CREDENTIALS
============================================================
  Created site admin: admin
  Password:           X7kR9mNpQs2wLvYt
============================================================
  You will be required to change this password on first login.
============================================================
```

### Docker

```bash
docker compose logs backend | grep -A6 "INITIAL ADMIN"
```

### Local

The password is printed directly in the terminal where you ran `python manage.py ensure_site_admin`.

### Kubernetes / Helm

The init container only runs `migrate` — `ensure_site_admin` must be run manually after the first deploy:

```bash
kubectl exec -it -n visiban <backend-pod> -- python manage.py ensure_site_admin
```

If the admin already exists (e.g. the pod restarted before you retrieved the password), reset the password with:

```bash
kubectl exec -it -n visiban <backend-pod> -- python manage.py changepassword admin
```

Get the backend pod name with `kubectl get pods -n visiban`.

## Changing the password

On first login you will be shown a password change screen. You cannot access the application until a new password (minimum 12 characters) is set. The temporary password cannot be reused.

## Customising the bootstrap account

Set these environment variables **before** the first boot:

```bash
DJANGO_SUPERUSER_USERNAME=admin
DJANGO_SUPERUSER_EMAIL=admin@example.com
```

## Subsequent boots

`ensure_site_admin` is a no-op once a site admin exists. Credentials are never printed again.

!!! warning
    If you lose the temporary password before changing it, reset it via the Django shell:
    ```python
    from accounts.models import User
    u = User.objects.get(username="admin")
    u.set_password("new-temporary-password")
    u.save()
    ```
