# Secret Rotation

This guide covers rotating the three most critical secrets in a Visiban deployment: `DJANGO_SECRET_KEY`, `DB_PASSWORD`, and `CORS_ALLOWED_ORIGINS`.

---

## DJANGO_SECRET_KEY

Django uses `SECRET_KEY` to sign cookies, sessions, CSRF tokens, and password reset links. Rotating it immediately invalidates all active sessions (all users are logged out) and any outstanding password reset / email confirmation links.

### When to rotate

- Suspected or confirmed compromise of the key
- After any accidental exposure (e.g. committed to a public repository, leaked in logs)
- As part of a periodic security review

### Steps

1. Generate a new key:

    ```bash
    python -c "import secrets; print(secrets.token_hex(50))"
    ```

2. Open your `.env` file and replace the value of `DJANGO_SECRET_KEY`.

3. Restart the backend:

    ```bash
    # Docker Compose (production)
    docker compose -f docker-compose.prod.yml up -d --build backend

    # Kubernetes
    kubectl rollout restart deployment/visiban-backend -n visiban
    ```

4. Verify startup — the backend will raise `ImproperlyConfigured` immediately if the new key is empty or matches the placeholder:

    ```bash
    docker compose -f docker-compose.prod.yml logs backend | tail -20
    ```

5. Notify users that they will need to log in again.

---

## DB_PASSWORD

The database password is used by the Django backend to connect to PostgreSQL. Rotating it requires a coordinated update of both the database and the application config.

### Steps

1. Generate a new password:

    ```bash
    python -c "import secrets; print(secrets.token_urlsafe(32))"
    ```

2. Update the PostgreSQL user password **inside the database container** (replace `<new-password>` with your generated value):

    ```bash
    docker compose -f docker-compose.prod.yml exec db \
      psql -U visiban -c "ALTER USER visiban PASSWORD '<new-password>';"
    ```

3. Update `DB_PASSWORD` in your `.env` file.

4. Restart the backend so it picks up the new `DATABASE_URL`:

    ```bash
    docker compose -f docker-compose.prod.yml up -d backend
    ```

5. Verify the backend can connect:

    ```bash
    docker compose -f docker-compose.prod.yml logs backend | tail -20
    ```

    Look for the `daphne` startup line — a connection error means the password was not updated correctly in one of the two places.

---

## CORS_ALLOWED_ORIGINS

`CORS_ALLOWED_ORIGINS` controls which origins the browser permits when making cross-origin requests to the API. It also defaults `CSRF_TRUSTED_ORIGINS` unless that variable is set independently.

### When to update

- Changing the frontend domain
- Adding a new frontend deployment (staging, mirror)
- Removing a domain that is no longer in use

### Steps

1. Open `.env` and update `CORS_ALLOWED_ORIGINS` (comma-separated, no trailing slash):

    ```bash
    CORS_ALLOWED_ORIGINS=https://yourdomain.com,https://staging.yourdomain.com
    ```

2. If you also need `CSRF_TRUSTED_ORIGINS` to differ (e.g. you use a separate API subdomain), set it explicitly:

    ```bash
    CSRF_TRUSTED_ORIGINS=https://api.yourdomain.com
    ```

3. Restart the backend:

    ```bash
    docker compose -f docker-compose.prod.yml up -d backend
    ```

No user action is required — CORS policy is enforced per-request, not per-session.

---

## Admin interface access

Since v1.0 the Django admin interface (`/admin/`) is restricted to loopback addresses at both the Nginx layer and via `AdminIPRestrictionMiddleware`. External requests return 403.

To access admin from your local machine:

```bash
# Open an SSH tunnel to the server — forwards local port 8080 to loopback on the server
ssh -L 8080:127.0.0.1:443 user@yourserver
```

Then visit `https://localhost:8080/admin/` in your browser.

To allow access from a specific non-loopback IP (e.g. an internal bastion host), set `DJANGO_ADMIN_ALLOWED_IPS` in your `.env`:

```bash
DJANGO_ADMIN_ALLOWED_IPS=10.0.1.20,10.0.1.21
```

This extends — not replaces — the loopback addresses. Restart the backend after changing this variable.

!!! warning
    Operators upgrading from a release prior to the v1.0 security hardening must apply the Nginx `/admin/` block manually if they manage the Nginx config outside of the bundled template. Add the following to the `/admin/` location block:

    ```nginx
    allow 127.0.0.1;
    allow ::1;
    deny all;
    ```
