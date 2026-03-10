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

```bash
docker build -f backend/Dockerfile.prod -t registry/visiban/backend:latest backend/
docker build -f frontend/Dockerfile.prod -t registry/visiban/frontend:latest frontend/

docker push registry/visiban/backend:latest
docker push registry/visiban/frontend:latest
```

`backend/Dockerfile.prod` runs `collectstatic` and defaults to gunicorn (WSGI) with 2 workers — suitable for pushing a versioned image to a registry.

> **Important:** `docker-compose.prod.yml` overrides the backend `command` to use **daphne** (ASGI) instead of gunicorn, which is required for WebSocket support. If you run the image directly (e.g. in Kubernetes without the Helm chart), use daphne: `daphne -b 0.0.0.0 -p 8000 visiban.asgi:application`. Running gunicorn directly will disable real-time board updates.

## Kubernetes / Helm

A Helm chart is included under `helm/visiban/`.

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm dependency update helm/visiban

helm install visiban helm/visiban \
  --set ingress.host=visiban.example.com \
  --set secret.djangoSecretKey=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --set postgresql.auth.password=<strong-password>
```

### Key Helm values

| Value | Default | Description |
|---|---|---|
| `ingress.host` | `visiban.example.com` | Public hostname |
| `ingress.tls.enabled` | `false` | Enable TLS (requires cert-manager or manual secret) |
| `secret.djangoSecretKey` | `change-me-in-production` | Django `SECRET_KEY` |
| `postgresql.auth.password` | `visiban` | Database password |
| `backend.image.tag` | `latest` | Backend image tag |
| `frontend.image.tag` | `latest` | Frontend image tag |
| `postgresql.enabled` | `true` | Use bundled PostgreSQL; set `false` to use `externalDatabase` |
| `redis.enabled` | `true` | Use bundled Redis; set `false` to use `externalRedis.url` |
| `externalRedis.url` | `redis://redis:6379/0` | External Redis DSN (used when `redis.enabled: false`) |
| `backend.settings.allowedHosts` | `visiban.example.com` | `ALLOWED_HOSTS` value |
| `backend.settings.corsAllowedOrigins` | `https://visiban.example.com` | Comma-separated CORS origins |

### Upgrade

```bash
helm upgrade visiban helm/visiban --reuse-values
```
