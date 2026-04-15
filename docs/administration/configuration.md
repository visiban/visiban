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

Redis has no authentication in development — no variable needed.

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
| `REDIS_PASSWORD` | Redis authentication password — required in production; the Redis service starts with `--requirepass` and `REDIS_URL`/`REDIS_CACHE_URL` are built from this value. Generate with: `openssl rand -base64 32` |
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

Visiban uses Django's email backend for password resets and email verification. Configure these variables in `.env` (Docker Compose) or as environment variables in your Helm values:

| Variable | Description | Default |
|---|---|---|
| `EMAIL_BACKEND` | Django email backend class | `django.core.mail.backends.smtp.EmailBackend` |
| `EMAIL_HOST` | SMTP server hostname | `localhost` |
| `EMAIL_PORT` | SMTP server port | `587` |
| `EMAIL_HOST_USER` | SMTP authentication username | *(empty — no auth)* |
| `EMAIL_HOST_PASSWORD` | SMTP authentication password | *(empty)* |
| `EMAIL_USE_TLS` | Use STARTTLS | `true` |
| `DEFAULT_FROM_EMAIL` | Sender address for outgoing emails | `noreply@localhost` |

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
    The default value of `EMAIL_VERIFICATION` is `optional`, which sends a verification email on signup but allows login without verifying. SMTP should be configured so that verification emails are delivered. Set `EMAIL_VERIFICATION=none` to disable verification emails entirely (no SMTP needed). `ACCOUNT_EMAIL_VERIFICATION` is a deprecated alias and will be removed in a future release.

---

## Health check endpoints

The backend exposes two health check endpoints for use by load balancers, monitoring systems, and Kubernetes probes:

| Endpoint | Method | Purpose | Checks | Success |
|---|---|---|---|---|
| `/api/health/liveness/` | GET | Is the process alive? | ASGI server responds | `200 {"status": "ok"}` |
| `/api/health/readiness/` | GET | Can the process serve traffic? | Database and Redis are reachable | `200 {"status": "ok"}` |

Both endpoints are unauthenticated and do not require a valid `Host` header.

**Docker Compose** uses the liveness endpoint in the backend healthcheck. **Helm** uses both: liveness probe hits `/api/health/liveness/`, readiness probe hits `/api/health/readiness/`.

For external load balancers (AWS ALB, HAProxy, etc.), point your health check at `/api/health/readiness/` on the backend port (8000). This ensures traffic is only routed to instances with working database and Redis connections.
