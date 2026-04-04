# Required credentials reference

This page lists every secret and credential needed to run Visiban across its three environments: local development, the GitLab CI pipeline, and production.

---

## Local development

Copy `.env.example` to `.env` in the repository root and fill in the values below.

| Variable | Description | Example / default |
|---|---|---|
| `DJANGO_SECRET_KEY` | Django signing key. Generate with: `python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"` | *generated value* |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://visiban:visiban@db:5432/visiban` |
| `POSTGRES_PASSWORD` | Must match the password in `DATABASE_URL` | `visiban` (dev only) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth — leave blank to disable | *optional* |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth — leave blank to disable | *optional* |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | GitLab OAuth — leave blank to disable | *optional* |

Redis has no authentication in development — no variable needed.

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
| `APP_VERSION` | Image tag to pull, e.g. `v1.0.0-rc.11`. Defaults to `latest` if unset. |
| `DB_PASSWORD` | PostgreSQL password — required, no default; the compose file will error on startup if missing |
| `DJANGO_SECRET_KEY` | Production Django signing key — must be unique and kept secret |
| `DOMAIN` | Your domain name for Nginx and Certbot, e.g. `app.visiban.com` |
| `CERTBOT_EMAIL` | Email address for Let's Encrypt expiry notifications |
| OAuth variables | As in the local dev table above — only needed for providers you enable |

### Helm

Pass sensitive values via `--set` or a `values.secret.yaml` file. **Never commit secret values.**

| Key | Description |
|---|---|
| `secret.djangoSecretKey` | Production Django signing key |
| `postgresql.auth.password` | PostgreSQL password |
| `backend.oauth.google.*` | Google OAuth credentials |
| `backend.oauth.github.*` | GitHub OAuth credentials |
| `backend.oauth.gitlab.*` | GitLab OAuth credentials |
| `backend.image.tag` | Image tag to deploy, e.g. `v1.0.0-rc.11` |
| `frontend.image.tag` | Image tag to deploy, e.g. `v1.0.0-rc.11` |

Example:

```bash
helm upgrade --install visiban ./helm/visiban \
  --set secret.djangoSecretKey="your-secret-key" \
  --set postgresql.auth.password="your-db-password" \
  --set backend.image.tag="v1.0.0-rc.11" \
  --set frontend.image.tag="v1.0.0-rc.11"
```
