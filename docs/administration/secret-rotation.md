# Secret Rotation

This guide covers rotating the three most critical secrets in a Visiban deployment: `DJANGO_SECRET_KEY`, `DB_PASSWORD`, and `CORS_ALLOWED_ORIGINS`.

---

## DJANGO_SECRET_KEY

Django uses `SECRET_KEY` to sign cookies, sessions, CSRF tokens, and password reset links. Rotating it immediately invalidates all active sessions (all users are logged out) and any outstanding password reset / email confirmation links.

!!! note "Key strength is now a confidentiality control, not only an integrity one"
    Before Visiban stored secrets at rest, `SECRET_KEY` protected session and CSRF
    signatures — forgery, not disclosure. Now that it can encrypt a stored SMTP
    password, a weak or guessable key means anyone with a database dump or backup can
    recover that credential offline. Use a full-entropy value: the generator in step 1
    below produces one. Never shorten it, and never reuse it across environments.

!!! warning "Rotating this key invalidates a stored SMTP password"

    If you configured outbound email through **Admin → Settings → Email** (rather than
    the `EMAIL_*` environment variables), the SMTP password is encrypted at rest using a
    key derived from `SECRET_KEY`. Rotating `SECRET_KEY` makes that stored password
    permanently unrecoverable, and outbound email will stop working.

    This is recoverable in under a minute — step 5 below — but only if you know to do it.
    Otherwise the symptom (password-reset emails silently stop arriving) shows up days
    later with nothing pointing back to the rotation.

    To decouple the two, set a dedicated `VISIBAN_SECRET_ENCRYPTION_KEY` **before** you
    first store an SMTP password. See
    [Configuration → Email](configuration.md#email-smtp).

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

5. **If you configured SMTP in the admin UI, re-enter the password.** Open
   **Admin → Settings → Email**. If the stored password can no longer be decrypted the
   page says so explicitly and outbound mail is blocked until you re-enter it. Type the
   password again and save, then use **Send test email** to confirm delivery.

    Instances configured via the `EMAIL_*` environment variables are unaffected — skip
    this step.

6. Notify users that they will need to log in again.

---

## VISIBAN_SECRET_ENCRYPTION_KEY

Optional. When set, this key — rather than one derived from `SECRET_KEY` — encrypts
secrets Visiban stores at rest (today: the SMTP password set in **Admin → Settings →
Email**). Setting it lets you rotate `SECRET_KEY` on its own schedule without
invalidating stored secrets.

### Steps

1. Generate a key:

    ```bash
    python -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
    ```

2. Set `VISIBAN_SECRET_ENCRYPTION_KEY` in your `.env` and restart the backend. The
   backend refuses to start if the value is not 32 bytes of URL-safe base64.

3. Re-enter any stored SMTP password in **Admin → Settings → Email** — existing secrets
   were encrypted under the old key and are not migrated automatically.

!!! note "Set it before storing secrets, not after"

    Adding, changing, or removing this variable has the same effect on already-stored
    secrets as rotating `SECRET_KEY`: they become undecryptable and must be re-entered.
    There is no re-encryption command yet.

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
