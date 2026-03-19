# First Boot

## Automatic admin bootstrap

> **Added in 1.0.0-rc.6** — the one-time password is now written to a file instead of stdout to prevent it appearing in container log aggregators.

On the very first startup — when no site admin exists — Visiban creates an admin account and writes the one-time password to a file (`/tmp/visiban_admin_password` by default). The password is **not** printed to stdout to prevent it appearing in container log aggregators such as CloudWatch, Datadog, or the Docker log driver.

The stdout output looks like this:

```
============================================================
  VISIBAN INITIAL ADMIN CREDENTIALS
============================================================
  Created site admin: admin
  Password:           [REDACTED — written to /tmp/visiban_admin_password]
============================================================
  Retrieve the password, then delete the file.
  You will be required to change it on first login.
============================================================
```

### Retrieving the password

**Docker Compose (development):**

```bash
docker compose exec backend cat /tmp/visiban_admin_password
```

**Docker Compose (production):**

```bash
docker compose -f docker-compose.prod.yml exec backend cat /tmp/visiban_admin_password
```

Delete the file after retrieving it:

```bash
docker compose -f docker-compose.prod.yml exec backend rm /tmp/visiban_admin_password
```

**Local development (bare metal / venv):**

```bash
cat /tmp/visiban_admin_password
```

!!! tip
    The password is on its own line. If your shell displays a `%` immediately after it, that is a zsh prompt indicator — it is **not** part of the password. Copy only the characters before the `%`.

### Kubernetes / Helm

The init container only runs `migrate` — `ensure_site_admin` must be run manually after the first deploy:

```bash
kubectl exec -it -n visiban <backend-pod> -- python manage.py ensure_site_admin
```

Then retrieve the password from the file inside the pod:

```bash
kubectl exec -n visiban <backend-pod> -- cat /tmp/visiban_admin_password
```

Delete it once you have it:

```bash
kubectl exec -n visiban <backend-pod> -- rm /tmp/visiban_admin_password
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
