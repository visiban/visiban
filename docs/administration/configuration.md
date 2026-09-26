# Required credentials reference

This page lists every secret and credential needed to run Visiban across its three environments: local development, the GitLab CI pipeline, and production.

---

## Local development

Copy `.env.example` to `.env` in the repository root and fill in the values below.

| Variable | Description | Example / default |
|---|---|---|
| `DJANGO_SECRET_KEY` | Django signing key. Generate with: `python -c "import secrets; print(secrets.token_urlsafe(50))"` | *generated value* |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://visiban:visiban@db:5432/visiban` |
| `POSTGRES_PASSWORD` | Must match the password in `DATABASE_URL` | `visiban` (dev only) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth — leave blank to disable | *optional* |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth — leave blank to disable | *optional* |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | GitLab OAuth — leave blank to disable | *optional* |
| `ALLOWED_HOSTS` | Comma-separated list of hostnames the backend will accept. Defaults to `localhost,127.0.0.1`. Must include your LAN IP or hostname if you access Visiban from another machine or a non-localhost address. | `localhost,127.0.0.1` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated list of origins allowed to make API requests. Must match the exact origin your browser uses (scheme + host + port). Defaults to `http://localhost:5173`. Also controls `CSRF_TRUSTED_ORIGINS` unless that is set separately. | `http://localhost:5173` |
| `VITE_API_URL` | Frontend env var for `npm run dev` — create `frontend/.env.local` (gitignored) and set to `http://localhost:8000`. Leave empty for Docker builds; the frontend falls back to `window.location.origin` and relies on nginx to proxy `/api/` and `/ws/`. | `http://localhost:8000` |

Valkey has no authentication in development — no variable needed.

### Frontend local override

When running the Vite dev server directly (`npm run dev`), create `frontend/.env.local` with:

```bash
VITE_API_URL=http://localhost:8000
```

This file is gitignored and excluded from Docker builds via `frontend/.dockerignore`. **Never set `VITE_API_URL` to a `localhost` value in a Docker image** — it will be baked into the JS bundle and break WebSocket connections for any client accessing from a non-localhost address. The correct value for all Docker builds (dev compose, prod compose, Helm) is an empty string, which makes the frontend resolve the API relative to `window.location.origin`.

---

## GitLab CI pipeline

Add these in **Settings → CI/CD → Variables**. The pipeline will fail or produce SAST warnings if any are missing.

| Variable | Used by | Masked | Notes |
|---|---|---|---|
| `CI_DJANGO_SECRET_KEY` | `backend-test`, `migration-check`, `schema-validation` | Yes | Any non-empty string; not a production secret |
| `CI_POSTGRES_PASSWORD` | `backend-test` | Yes | Ephemeral test DB; any non-empty string |
| `CI_POSTGRES_USER` | `backend-test` | No | e.g. `visiban` |
| `CI_POSTGRES_DB` | `backend-test` | No | e.g. `visiban_test` |
| `GHCR_TOKEN` | `backend-docker-push`, `frontend-docker-push` | Yes | GitHub PAT, `write:packages` scope |
| `GHCR_USER` | Same | No | `visiban` |
| `GITHUB_TOKEN` | `github-release` | Yes | GitHub PAT, `repo` scope |
| `DOCS_DEPLOY_TOKEN` | `docs-deploy` | Yes | GitLab project access token, `write_repository` scope |
| `MINIO_ENDPOINT` | Cache warm jobs | No | MinIO S3-compatible cache endpoint |
| `MINIO_ACCESS_KEY` | Cache warm jobs | Yes | |
| `MINIO_SECRET_KEY` | Cache warm jobs | Yes | |
| `MINIO_BUCKET` | Cache warm jobs | No | |

---

## Production deployment

### Docker Compose

Create a server-side `.env` file alongside `docker-compose.prod.yml`:

| Variable | Description |
|---|---|
| `APP_VERSION` | Image tag to pull, e.g. `v1.0.0`. Defaults to `latest` if unset. |
| `DB_PASSWORD` | PostgreSQL password — required, no default; the compose file will error on startup if missing |
| `REDIS_PASSWORD` | Valkey authentication password — required in production; the Valkey service starts with `--requirepass` and `REDIS_URL`/`REDIS_CACHE_URL` are built from this value. Generate with: `openssl rand -base64 32` |
| `DJANGO_SECRET_KEY` | Production Django signing key — must be unique and kept secret |
| `DOMAIN` | Your domain name for Nginx and Certbot, e.g. `app.visiban.com` |
| `CERTBOT_EMAIL` | Email address for Let's Encrypt expiry notifications |
| OAuth variables | As in the local dev table above — only needed for providers you enable |

### Helm

Pass sensitive values via a gitignored `values.secret.yaml` file — **never via `--set`** (leaks to shell history and process lists) and **never committed to version control**.

An example file is included at `helm/visiban/values.secret.yaml.example`. Copy it to `values.secret.yaml`, fill in values, and pass it with `-f`:

For production clusters, you can bring your own Kubernetes Secret instead of having the chart create one. Set `secret.existingSecret` to the Secret name and the chart will reference it directly. See [Deployment — Using an existing Kubernetes Secret](../architecture/deployment.md#using-an-existing-kubernetes-secret).

| Key | Description |
|---|---|
| `secret.existingSecret` | Name of a pre-existing K8s Secret — when set, the chart does not create its own |
| `secret.djangoSecretKey` | Production Django signing key (ignored when `existingSecret` is set) |
| `postgresql.auth.existingSecret` | Name of a pre-existing K8s Secret for the PG password (key: `password`) |
| `postgresql.auth.password` | PostgreSQL password (ignored when `existingSecret` is set) |
| `backend.settings.frontendUrl` | Full URL of the SPA — allauth redirects here after OAuth login/logout |
| `backend.settings.siteDomain` | Public hostname for OAuth callback URLs |
| `backend.oauth.google.*` | Google OAuth credentials |
| `backend.oauth.github.*` | GitHub OAuth credentials |
| `backend.oauth.gitlab.*` | GitLab OAuth credentials |
| `backend.oauth.oidc.serverUrl` | OIDC issuer URL — set all three OIDC fields to enable generic OIDC login |
| `backend.oauth.oidc.clientId` | OIDC client ID |
| `backend.oauth.oidc.clientSecret` | OIDC client secret |
| `backend.oauth.oidc.providerName` | Label on the OIDC login button (default: `SSO`) |
| `backend.image.tag` | Image tag to deploy, e.g. `v1.0.0` |
| `frontend.image.tag` | Image tag to deploy, e.g. `v1.0.0` |

Example using a values file:

```bash
helm upgrade --install visiban ./helm/visiban \
  -f helm/visiban/values.secret.yaml \
  --set backend.settings.frontendUrl="https://boards.example.com" \
  --set backend.settings.siteDomain="boards.example.com" \
  --set backend.image.tag="v1.0.0" \
  --set frontend.image.tag="v1.0.0"
```

---

## Email (SMTP)

Visiban uses Django's email backend for password resets, email verification and — since 1.2 — [notification email](../features/notifications.md#email-notifications).

There are two ways to configure it, and **exactly one of them is in effect at a time** —
settings are never merged across the two:

1. **Environment variables** (below) — the default, and unchanged from earlier releases.
2. **The admin UI** — *new in 1.2.* **Admin → Settings → Email** stores the same settings
   in the database, so you can configure and test SMTP without shell access or a restart.
   See [Configuring SMTP from the admin UI](#configuring-smtp-from-the-admin-ui).

An instance uses environment variables until an admin explicitly switches the source to
the stored configuration, so **upgrading changes nothing** about how your instance sends
mail.

### Environment variables

Configure these in `.env` (Docker Compose) or as environment variables in your Helm values:

| Variable | Description | Default |
|---|---|---|
| `EMAIL_BACKEND` | Django email backend class. Setting this explicitly pins the backend and **disables** the admin-UI configuration entirely. | *(unset — uses the source selected in the admin UI, falling back to these variables)* |
| `EMAIL_HOST` | SMTP server hostname | `localhost` |
| `EMAIL_PORT` | SMTP server port | `587` |
| `EMAIL_HOST_USER` | SMTP authentication username | *(empty — no auth)* |
| `EMAIL_HOST_PASSWORD` | SMTP authentication password | *(empty)* |
| `EMAIL_USE_TLS` | Use STARTTLS | `true` |
| `EMAIL_USE_SSL` | Use implicit TLS/SSL. Mutually exclusive with `EMAIL_USE_TLS`. *(new in 1.2)* | `false` |
| `EMAIL_TIMEOUT` | SMTP socket timeout, in seconds. *(new in 1.2)* | `10` |
| `NOTIFICATION_EMAIL_ENABLED` | Master switch for outbound **notification** email. Set to `false` to stop notification mail instance-wide without touching per-user preferences. Password resets and email verification are unaffected — silencing notifications must not lock anyone out of account recovery. *(new in 1.2)* | `true` |
| `NOTIFICATION_EMAIL_TIMEOUT` | Socket timeout floor, in seconds, for notification email only. Notification mail is sent from the card-mutation path, so an unreachable SMTP host would otherwise hang a worker; this bounds it. Applied only when neither `EMAIL_TIMEOUT` nor the admin-UI timeout is set, so a timeout you configured is never overridden. *(new in 1.2)* | `10` |
| `NOTIFICATION_EMAIL_ASYNC` | Send notification mail from a background thread rather than inline on the request. Keeps a slow or unreachable SMTP host from making card actions appear to hang, at the cost of delivery being best-effort — recycling a worker mid-send drops that batch. Set to `false` to send inline. *(new in 1.2)* | `true` |
| `DEFAULT_FROM_EMAIL` | Sender address for outgoing emails | `noreply@example.com` |
| `VISIBAN_SECRET_ENCRYPTION_KEY` | Optional dedicated key for secrets stored at rest. *(new in 1.2)* See [Secret rotation](secret-rotation.md#visiban_secret_encryption_key). | *(empty — derived from `DJANGO_SECRET_KEY`)* |

### Example: Gmail / Google Workspace

```bash
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_HOST_USER=noreply@yourdomain.com
EMAIL_HOST_PASSWORD=your-app-password
EMAIL_USE_TLS=true
DEFAULT_FROM_EMAIL=noreply@yourdomain.com
```

### Example: Amazon SES

```bash
EMAIL_HOST=email-smtp.us-east-1.amazonaws.com
EMAIL_PORT=587
EMAIL_HOST_USER=AKIAIOSFODNN7EXAMPLE
EMAIL_HOST_PASSWORD=your-ses-smtp-password
EMAIL_USE_TLS=true
DEFAULT_FROM_EMAIL=noreply@yourdomain.com
```

### Console backend (development)

To print emails to stdout instead of sending them (useful for development):

```bash
EMAIL_BACKEND=django.core.mail.backends.console.EmailBackend
```

!!! note
    The default value of `EMAIL_VERIFICATION` is `optional`, which sends a verification email on signup but allows login without verifying. SMTP should be configured so that verification emails are delivered. Set `EMAIL_VERIFICATION=none` to disable verification emails entirely (no SMTP needed). The old alias `ACCOUNT_EMAIL_VERIFICATION` was removed in 1.1 — only `EMAIL_VERIFICATION` is read.

### Configuring SMTP from the admin UI

*New in 1.2.*

Site admins can configure outbound email from **Admin → Settings → Email** without shell
access or a container restart — useful on managed and cloud deployments.

1. Fill in the server, port, sender address, and credentials.
2. Switch **Configuration source** to **Stored in this admin UI**.
3. Click **Send test email**. The test is delivered to your own account's email address.

Changes take effect on the next email sent — there is no restart and no cache to wait for.

**How the two sources interact:**

- The setting is **all-or-nothing**. When the source is *stored configuration*, every
  value comes from the database; when it is *environment variables*, every value comes
  from the environment. A single setting is never taken from the other source.
- You cannot switch to the stored configuration until it is complete (at minimum a host
  and a sender address, plus a password if you set a username). A partly-filled form is
  therefore harmless: it stays a draft and your existing email configuration keeps
  working.
- **Setting `EMAIL_BACKEND` explicitly overrides both.** If you pin that variable — to a
  third-party relay, or to the console backend in development — Visiban honors it and
  ignores the stored configuration entirely. The admin page says so when this is the case.

**Password storage.** The SMTP password is encrypted at rest and never returned by the
API. By default the encryption key is derived from `DJANGO_SECRET_KEY`, so **rotating
that key makes a stored password unrecoverable** and you must re-enter it. To decouple
the two, set `VISIBAN_SECRET_ENCRYPTION_KEY` before storing a password — see
[Secret rotation](secret-rotation.md#visiban_secret_encryption_key).

!!! warning "The test button connects to whatever host you enter"
    **Send test email** opens an outbound SMTP connection from the Visiban backend to
    the host and port in the form — including internal addresses the backend can reach
    but you cannot. That makes it a site-admin-only capability with real network reach,
    so grant `is_site_admin` accordingly. The action is limited to 5 attempts per hour
    per admin, always delivers to the requesting admin's own address, and every server
    change is recorded in the [admin action log](../api/admin.md#action-log).

!!! note "Notification email is off per user, not per instance"
    Configuring SMTP does not start sending notification email. Every per-user email
    preference defaults to **off**, so upgrading an instance that already has working SMTP
    mails nobody until a user opts in under **Settings → Notifications**. Use
    `NOTIFICATION_EMAIL_ENABLED=false` if you want to be certain no notification mail can
    leave the instance regardless of what users have chosen. See
    [Email notifications](../features/notifications.md#email-notifications).

!!! note "Sender address placeholder"
    Visiban refuses to send mail from the shipped `noreply@example.com` placeholder. In
    earlier releases this was checked at startup and a production instance would not boot
    until `DEFAULT_FROM_EMAIL` was set. Since 1.2 the check happens when mail is sent (and
    on save in the admin UI), so an instance can boot and be configured entirely through
    the UI. Startup logs a warning instead, and outbound mail is refused with a clear
    error until a real sender address is set — by either method.

---

## Health check endpoints

The backend exposes two health check endpoints for use by load balancers, monitoring systems, and Kubernetes probes:

| Endpoint | Method | Purpose | Checks | Success |
|---|---|---|---|---|
| `/api/health/liveness/` | GET | Is the process alive? | ASGI server responds | `200 {"status": "ok"}` |
| `/api/health/readiness/` | GET | Can the process serve traffic? | Database and Valkey are reachable | `200 {"status": "ok"}` |

Both endpoints are unauthenticated and do not require a valid `Host` header.

**Docker Compose** uses the liveness endpoint in the backend healthcheck. **Helm** uses both: liveness probe hits `/api/health/liveness/`, readiness probe hits `/api/health/readiness/`.

For external load balancers (AWS ALB, HAProxy, etc.), point your health check at `/api/health/readiness/` on the backend port (8000). This ensures traffic is only routed to instances with working database and Valkey connections.
