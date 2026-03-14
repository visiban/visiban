# Deployment

## Docker Compose (recommended for self-hosting)

```bash
cp .env.example .env
# Fill in DJANGO_SECRET_KEY and DATABASE_URL (or leave default for bundled Postgres)
docker compose up --build
```

The `docker-compose.yml` starts four services: `db` (Postgres 16), `redis` (Redis 7), `backend` (daphne ASGI), and `frontend` (Vite dev server). The backend runs `migrate` and `ensure_site_admin` automatically on startup.

> **Note:** The backend uses **daphne** (ASGI server) instead of gunicorn to support WebSocket connections for real-time board updates.

## Production Docker images

Pre-built images are published to the GitLab container registry automatically by CI on every merge to `main`:

| Image | Registry path |
|---|---|
| Backend | `registry.gitlab.com/visiban/visiban/backend:latest` |
| Frontend | `registry.gitlab.com/visiban/visiban/frontend:latest` |

Each merge also pushes a short-SHA tag (e.g. `registry.gitlab.com/visiban/visiban/backend:a1b2c3d4`) for rollback.

To build images manually:

```bash
docker build -f backend/Dockerfile -t registry.gitlab.com/visiban/visiban/backend:latest backend/
docker build -f frontend/Dockerfile -t registry.gitlab.com/visiban/visiban/frontend:latest frontend/
```

> **Important:** The Helm chart's backend deployment uses **daphne** (ASGI) for WebSocket support. If you run the image directly outside the Helm chart, use: `daphne -b 0.0.0.0 -p 8000 visiban.asgi:application`. Running gunicorn directly will disable real-time board updates.

## Kubernetes / Helm

A Helm chart is included under `helm/visiban/`. Images are pulled from the GitLab container registry — see [Production Docker images](#production-docker-images) above.

### Install

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm dependency update helm/visiban

helm install visiban helm/visiban \
  --set ingress.host=boards.example.com \
  --set backend.settings.allowedHosts=boards.example.com \
  --set backend.settings.corsAllowedOrigins=https://boards.example.com \
  --set secret.djangoSecretKey=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --set postgresql.auth.password=<strong-password>
```

### TLS with cert-manager

If cert-manager and a `letsencrypt-prod` ClusterIssuer are installed, enable TLS:

```bash
helm install visiban helm/visiban \
  --set ingress.host=boards.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=boards-example-tls \
  --set "ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt-prod" \
  --set backend.settings.allowedHosts=boards.example.com \
  --set backend.settings.corsAllowedOrigins=https://boards.example.com \
  --set secret.djangoSecretKey=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --set postgresql.auth.password=<strong-password>
```

### Key Helm values

| Value | Default | Description |
|---|---|---|
| `ingress.host` | `visiban.example.com` | Public hostname — **must be set** |
| `ingress.tls.enabled` | `false` | Enable TLS (requires cert-manager or a pre-existing secret) |
| `ingress.tls.secretName` | `visiban-tls` | Secret name for the TLS certificate |
| `backend.settings.allowedHosts` | `visiban.example.com` | Django `ALLOWED_HOSTS` — **must match `ingress.host`** |
| `backend.settings.corsAllowedOrigins` | `https://visiban.example.com` | CORS allowed origins — **must match the public URL** |
| `secret.djangoSecretKey` | `change-me-in-production` | Django `SECRET_KEY` |
| `postgresql.auth.password` | `visiban` | Database password |
| `backend.image.tag` | `latest` | Backend image tag |
| `frontend.image.tag` | `latest` | Frontend image tag |
| `postgresql.enabled` | `true` | Use bundled PostgreSQL; set `false` to use `externalDatabase` |
| `redis.enabled` | `true` | Use bundled Redis; set `false` to use `externalRedis.url` |
| `externalRedis.url` | `redis://redis:6379/0` | External Redis DSN (used when `redis.enabled: false`) |

### Upgrade

```bash
helm upgrade visiban helm/visiban --reuse-values
```
