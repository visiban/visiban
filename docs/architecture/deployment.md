# Deployment

## Docker Compose (recommended for self-hosting)

> **Tested:** The Docker Compose development stack has been verified end-to-end.

```bash
cp .env.example .env
# Fill in DJANGO_SECRET_KEY and DATABASE_URL (or leave default for bundled Postgres)
docker compose up --build
```

The `docker-compose.yml` starts four services: `db` (Postgres 17), `redis` (Redis 7), `backend` (daphne ASGI), and `frontend` (Vite dev server). The backend runs `migrate` and `ensure_site_admin` automatically on startup.

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

> **Note:** The Helm chart runs the backend with **gunicorn** (WSGI). If you need WebSocket support (real-time board updates) in Kubernetes, override the command to use daphne: `daphne -b 0.0.0.0 -p 8000 visiban.asgi:application`.

## Kubernetes / Helm

> **Tested:** The Helm chart has been deployed and verified on a live Kubernetes cluster.

A Helm chart is included under `helm/visiban/`. Images are pulled from the GitLab container registry — see [Production Docker images](#production-docker-images) above.

The Helm chart bundles the following database and cache dependencies:

| Component | Version | How deployed |
|---|---|---|
| PostgreSQL | 17 | Built-in StatefulSet using the official `postgres:17` image (default) |
| Redis | 8 | Bitnami `redis` subchart 25.x |

> **Note (Bitnami PostgreSQL):** The Bitnami `postgresql` subchart is disabled by default (`postgresql.subchartEnabled: false`) because Bitnami no longer publishes versioned Docker Hub tags for older chart releases, which caused image pull failures. The chart deploys PostgreSQL via its own StatefulSet instead. Set `postgresql.subchartEnabled: true` to revert to the Bitnami subchart if needed.

> **Note:** Both the Docker Compose and Kubernetes/Helm stacks run **PostgreSQL 17**. If you are migrating an existing deployment from an older release that used PostgreSQL 16, you must export your data first — PostgreSQL major version upgrades are not performed in-place. See [Upgrading PostgreSQL major versions](#upgrading-postgresql-major-versions).

### Install

```bash
# Redis still uses the Bitnami subchart — add the repo and fetch dependencies
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm dependency update helm/visiban

helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  --set ingress.host=boards.example.com \
  --set backend.settings.allowedHosts=boards.example.com \
  --set backend.settings.corsAllowedOrigins=https://boards.example.com \
  --set secret.djangoSecretKey=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --set postgresql.auth.password=<strong-password>
```

After the install, retrieve the one-time admin password:

```bash
kubectl exec -it -n visiban \
  $(kubectl get pods -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') \
  -- python manage.py ensure_site_admin
```

### TLS with cert-manager

If cert-manager and a `letsencrypt-prod` ClusterIssuer are installed, enable TLS:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
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
| `postgresql.enabled` | `true` | Use bundled PostgreSQL 17; set `false` to use `externalDatabase` |
| `postgresql.subchartEnabled` | `false` | Set `true` to use the Bitnami `postgresql` subchart instead of the built-in StatefulSet |
| `redis.enabled` | `true` | Use bundled Redis 8; set `false` to use `externalRedis.url` |
| `externalRedis.url` | `redis://redis:6379/0` | External Redis DSN (used when `redis.enabled: false`) |

### Post-install: create the admin account

The Helm init container only runs `migrate` — `ensure_site_admin` is not called automatically. After the first install, run it manually:

```bash
kubectl exec -it -n visiban $(kubectl get pod -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') -- python manage.py ensure_site_admin
```

See [First Boot](../getting-started/first-boot.md#kubernetes-helm) for details and password reset instructions.

### Upgrade

```bash
helm upgrade visiban helm/visiban --reuse-values
```

### Upgrading PostgreSQL major versions

The bundled PostgreSQL subchart does not perform in-place major version upgrades. If you have an existing deployment on PostgreSQL 16 and are upgrading to a chart version that bundles PostgreSQL 17, you must migrate your data manually:

1. **Export data from the running PostgreSQL 16 pod:**
   ```bash
   kubectl exec -n visiban visiban-postgresql-0 -- \
     pg_dump -U visiban visiban > visiban_backup.sql
   ```

2. **Delete the existing PersistentVolumeClaim** (this removes the old data volume):
   ```bash
   kubectl delete pvc -n visiban data-visiban-postgresql-0
   ```

3. **Upgrade the Helm release** — this provisions a fresh PostgreSQL 17 pod:
   ```bash
   helm upgrade visiban helm/visiban --reuse-values
   ```

4. **Wait for PostgreSQL to become ready**, then restore:
   ```bash
   kubectl wait pod -n visiban visiban-postgresql-0 --for=condition=Ready --timeout=120s
   kubectl exec -i -n visiban visiban-postgresql-0 -- \
     psql -U visiban visiban < visiban_backup.sql
   ```

5. **Restart the backend** to re-run migrations:
   ```bash
   kubectl rollout restart deployment -n visiban visiban-backend
   ```

## Rate limiting

In production (`DEBUG=False`), the API enforces the following request rate limits per client. In development (`DEBUG=True`), throttling is effectively disabled (9999/hour for all scopes).

| Scope | Limit | Notes |
|---|---|---|
| Anonymous requests | 300 / hour | Applies to unauthenticated API calls |
| Authenticated users | 5000 / hour | Polling endpoints (notifications, version check) each fire every 15–30 s, so a single active user easily uses 500+ per hour |
| User search (`/api/users/search/`) | 30 / minute | Tighter limit to prevent username enumeration |
| Invite link redemption (`/api/groups/.../join/`) | 10 / hour | Low ceiling to prevent invite token brute-force scanning |

Clients that exceed a limit receive `HTTP 429 Too Many Requests`. The standard `Retry-After` header is not set — clients should implement exponential backoff.

!!! note
    These limits are generous for normal interactive use. If you run a very large team or integrate Visiban with automation that makes frequent API calls, monitor your request volume and raise the `user` limit in `DEFAULT_THROTTLE_RATES` in `settings.py` if needed.
