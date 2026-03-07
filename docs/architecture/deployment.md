# Deployment

## Docker Compose (recommended for self-hosting)

```bash
cp .env.example .env
# Fill in DJANGO_SECRET_KEY and DATABASE_URL (or leave default for bundled Postgres)
docker compose up --build
```

The `docker-compose.yml` starts three services: `db` (Postgres 16), `backend` (Django), and `frontend` (Vite/Nginx). The backend runs `migrate` and `ensure_site_admin` automatically on startup.

## Production Docker images

```bash
docker build -f backend/Dockerfile.prod -t registry/visiban/backend:latest backend/
docker build -f frontend/Dockerfile.prod -t registry/visiban/frontend:latest frontend/

docker push registry/visiban/backend:latest
docker push registry/visiban/frontend:latest
```

`Dockerfile.prod` runs `collectstatic`, then starts gunicorn with 2 workers. Adjust `--workers` for your CPU count.

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

### Upgrade

```bash
helm upgrade visiban helm/visiban --reuse-values
```
