# Required credentials reference

Every secret and credential Visiban needs, across its three environments: local development, the GitLab CI pipeline, and production.

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

> Secret values (`DJANGO_SECRET_KEY`, OAuth/OIDC client IDs and secrets, `EMAIL_HOST_PASSWORD`, `DEMO_ADMIN_PASSWORD`, `DEMO_MEMBER_PASSWORD`) are used verbatim, including when they start with `$`; they are never treated as references to other variables.

| Variable | Description |
|---|---|
| `APP_VERSION` | Image tag to pull, e.g. `v1.1.0`. **Required** — the compose file fails to start if unset; it no longer falls back to the mutable `latest` tag (see [Container image retention](container-image-retention.md)). `.env.example` ships a pinned value. The backend strips only a leading `v` before serving it back — `GET /api/v1/version/` reports bare semver (e.g. `1.1.0`) when `APP_VERSION` is pinned to a release tag; a non-release value such as `latest` or `dev` is served back verbatim (see [Version API](../api/version.md)). |
| `DB_PASSWORD` | PostgreSQL password — required, no default; the compose file will error on startup if missing |
| `REDIS_PASSWORD` | Valkey authentication password — required in production; the Valkey service starts with `--requirepass` and `REDIS_URL`/`REDIS_CACHE_URL` are built from this value. Generate with: `openssl rand -hex 32` (base64 output can contain `/`, which breaks the URL) |
| `REDIS_URL_PASSWORD` | Not set under Compose: Compose puts the password into `REDIS_URL`/`REDIS_CACHE_URL` itself (from `REDIS_PASSWORD`). Set by the Helm chart from a Secret when `valkey.auth.enabled` is true, or when `externalRedis.existingSecret` is set. The backend percent-encodes it into both URLs, so any character is safe. A username in the URL (`redis://user@host:6379/0`, a Redis ACL user) is kept. The backend refuses to start if a URL already carries a password as well, because the two would be competing sources. |
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

## Reverse proxies and the client IP

> **Added in 1.2** (#1180).

Per-IP rate limits (the login throttle, the anonymous request ceiling, allauth's failed-login lockout) and the `/admin/` IP allowlist all need the visitor's real address. Behind proxies, Visiban reads it from `X-Forwarded-For`, trusting the entry that the configured number of proxies appended. Everything to the left of those entries is client-supplied.

| Variable | Default | Description |
|---|---|---|
| `NUM_PROXIES` | `1` | Number of reverse proxies in front of the backend that append to `X-Forwarded-For`. The default of `1` counts this chart's own frontend nginx, which is correct for Docker Compose and for a bare Helm install with nothing else in front of the frontend Service. A non-negative integer. Anything else refuses to start. Helm: `backend.settings.numProxies`. |

Set it to the real depth of your proxy chain:

- **Too low**: every client appears to come from the nearest proxy. One client exhausts the login and anonymous throttles for everyone.
- **Too high**: a client can choose its own address by sending its own `X-Forwarded-For`, and so escape per-IP limits.

**Behind an ingress controller, `1` is too low.** This chart's frontend nginx always appends one hop (`proxy_add_x_forwarded_for`); an ingress controller in front of it appends its own, so the real chain is two hops deep, not one. Count every proxy between the internet and the frontend Service, including the frontend nginx itself.

The hosted demo behind a Cloudflare Tunnel uses `2` (Cloudflare appends the visitor, then the frontend nginx appends the tunnel pod). See [Public demo mode](demo-data.md#public-demo-mode-helm).

---

## Import limits

| Variable | Description | Default |
|---|---|---|
| `VISIBAN_IMPORT_MAX_SIZE` | Maximum size, **in bytes**, of a Trello JSON export accepted by the [Trello import wizard](../features/trello-import.md). Oversized uploads get `413`. Separate from `MAX_UPLOAD_SIZE_BYTES`, which caps attachments and native board imports. Helm: `backend.settings.importMaxSizeBytes`. *(new in 1.2)* | `26214400` (25 MB) |

The import runs synchronously inside the request, so every hop in front of
Django must accept a body this large and wait long enough for the board to be
created:

- **Docker Compose nginx** (`nginx/*.conf.template`): `client_max_body_size`
  is `35M` (25 MB + 10 MB multipart headroom). Raise it if you raise
  `VISIBAN_IMPORT_MAX_SIZE`. `proxy_read_timeout` on `/api/` is `90s`, well
  above the few seconds a capped import takes.
- **Helm**: nginx `client_max_body_size` and the ingress `proxy-body-size`
  annotation are derived automatically from the larger of
  `maxUploadSizeBytes` and `importMaxSizeBytes`.
- **Your own reverse proxy / load balancer**: nginx defaults to a 1 MB body
  limit and returns its own `413` before Visiban sees the request. Allow at
  least `VISIBAN_IMPORT_MAX_SIZE` + 10 MB.
- The application server (daphne) and the web client set no request timeout
  of their own.

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
| `INVITE_EMAIL_ENABLED` | Lets group admins and site admins send invite links straight to an email address instead of copying them. Set to `false` to remove the option instance-wide; the send endpoints then return `403` with `code: "invite_email_disabled"`. Always off when `DEMO_MODE` is on. Uses the same mail configuration as everything else, with `NOTIFICATION_EMAIL_TIMEOUT` as its socket timeout floor. *(new in 1.2)* | `true` |
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

## Demo mode

> **Added in 1.2** — for public demo instances only.

Demo mode turns an instance into a public, shared demo: the login page offers a one-click "Explore the demo" sign-in with a published account, an in-app bar counts down to the next reset, and a deny-by-default write fence refuses every change except creating, editing and moving cards. It is **off by default**; existing installs are unaffected.

| Variable | Default | Description |
|---|---|---|
| `DEMO_MODE` | `false` | Arm demo mode and its write fence. Parsed strictly: an unrecognized value such as `ture` refuses to start rather than silently leaving the fence off. |
| `DEMO_LOGIN_USERNAME` | `visitor` | The **published** account. `seed_demo_data --demo-site` creates it as a non-admin member on every seeded board. Must not be `admin`, `maya` or `jordan`. |
| `DEMO_LOGIN_PASSWORD` | *(empty)* | Password of the published account, shown on the login page. With no value no credential is shown. |
| `DEMO_ADMIN_PASSWORD` | *(empty)* | Password of the seeded site admin (`admin`). **Never published**, and must differ from `DEMO_LOGIN_PASSWORD`. Required by `seed_demo_data --demo-site`. |
| `DEMO_MEMBER_PASSWORD` | *(empty)* | Password for the two seeded member accounts. Never published. Required by `seed_demo_data --demo-site`. |
| `DEMO_RESET_SCHEDULE` | `0 * * * *` | Cron expression (UTC) of the reset job. Drives the countdown on the login page and in the app. Only minute and hour fields are evaluated; the other three must be `*`. An expression the backend cannot evaluate refuses to start while `DEMO_MODE` is on. Set but **empty** means no reset is scheduled: the login page and the demo bar then promise no reset and show no countdown. The Helm chart renders it empty when `demo.reset.enabled` is false. |
| `DEMO_USER_THROTTLE_RATE` | *(empty)* | Replaces the rate of the `user` throttle scope while `DEMO_MODE` is on, e.g. `60000/hour`. Every visitor signs in as the one published account, so this scope is a single budget shared by all of them. Format `<n>/<second\|minute\|hour\|day>`; anything else refuses to start. Ignored when `DEMO_MODE` is off. |

If `DEMO_LOGIN_USERNAME` or `DEMO_LOGIN_PASSWORD` is set while `DEMO_MODE` is off, startup logs a warning: nothing is published, but the fence is not armed either.

!!! danger "The credentials are public by design"
    When `DEMO_MODE` is on, `DEMO_LOGIN_USERNAME` and `DEMO_LOGIN_PASSWORD` are returned to anyone by `GET /api/v1/auth/site-config/`. Enable it only on a dedicated, throwaway instance with its own database, no SSO or real SMTP, and a scheduled reset. Never enable it on an instance with real data.

See [Demo data](demo-data.md#hosted-demo-instance) for seeding, and [Public demo mode](demo-data.md#public-demo-mode-helm) for the Helm deployment that sets all of these.

## Health check endpoints

The backend exposes two health check endpoints for use by load balancers, monitoring systems, and Kubernetes probes:

| Endpoint | Method | Purpose | Checks | Success |
|---|---|---|---|---|
| `/api/health/liveness/` | GET | Is the process alive? | ASGI server responds | `200 {"status": "ok"}` |
| `/api/health/readiness/` | GET | Can the process serve traffic? | Database and Valkey are reachable | `200 {"status": "ok"}` |

Both endpoints are unauthenticated and do not require a valid `Host` header.

**Docker Compose** uses the liveness endpoint in the backend healthcheck. **Helm** uses both: liveness probe hits `/api/health/liveness/`, readiness probe hits `/api/health/readiness/`.

For external load balancers (AWS ALB, HAProxy, etc.), point your health check at `/api/health/readiness/` on the backend port (8000). This ensures traffic is only routed to instances with working database and Valkey connections.
