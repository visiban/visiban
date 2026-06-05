# Deployment

## Docker Compose (recommended for self-hosting)

> **Tested:** The Docker Compose development stack has been verified end-to-end.

```bash
cp .env.example .env
# Fill in DJANGO_SECRET_KEY and DATABASE_URL (or leave default for bundled Postgres)
docker compose up --build
```

The `docker-compose.yml` starts four services: `db` (Postgres 17), `valkey` (Valkey 8), `backend` (daphne ASGI), and `frontend` (Vite dev server). The backend runs `migrate` and `ensure_site_admin` automatically on startup.

> **Note:** The backend uses **daphne** (ASGI server) instead of gunicorn to support WebSocket connections for real-time board updates.

The backend port (8000) is exposed directly in the dev stack. The Vite dev server on port 5173 does **not** proxy `/api/` requests. Access the [OpenAPI schema](../api/openapi.md) at `http://localhost:8000/api/schema/swagger-ui/`.

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

!!! note
    The Helm chart runs the backend with **daphne** (ASGI server) by default — the same as the Docker Compose stack. WebSocket connections and all real-time features work out of the box in Kubernetes with no extra configuration required.

## Kubernetes / Helm

> **Tested:** The Helm chart has been deployed and verified on a live Kubernetes cluster.

A Helm chart is included under `helm/visiban/`. Images are pulled from the GitLab container registry — see [Production Docker images](#production-docker-images) above.

The Helm chart bundles the following database and cache dependencies:

| Component | Version | How deployed |
|---|---|---|
| PostgreSQL | 17 | Built-in StatefulSet using the official `postgres:17` image (default) |
| Valkey | 8 | Bitnami `valkey` subchart (pinned) |

> **Note (Bitnami PostgreSQL):** The Bitnami `postgresql` subchart is disabled by default (`postgresql.subchartEnabled: false`) because Bitnami no longer publishes versioned Docker Hub tags for older chart releases, which caused image pull failures. The chart deploys PostgreSQL via its own StatefulSet instead. Set `postgresql.subchartEnabled: true` to revert to the Bitnami subchart if needed.

> **Note:** Both the Docker Compose and Kubernetes/Helm stacks run **PostgreSQL 17**. If you are migrating an existing deployment from an older release that used PostgreSQL 16, you must export your data first — PostgreSQL major version upgrades are not performed in-place. See [Upgrading PostgreSQL major versions](#upgrading-postgresql-major-versions).

### Install

```bash
# Valkey uses the Bitnami subchart — add the repo and fetch dependencies
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm dependency update helm/visiban
```

Create a secret values file (never committed — `values.secret.yaml` is gitignored):

```bash
cp helm/visiban/values.secret.yaml.example helm/visiban/values.secret.yaml
# Edit values.secret.yaml — set djangoSecretKey and postgresql.auth.password
```

Then install:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  -f helm/visiban/values.secret.yaml \
  --set ingress.host=boards.example.com \
  --set backend.settings.allowedHosts=boards.example.com \
  --set backend.settings.corsAllowedOrigins=https://boards.example.com \
  --set backend.settings.frontendUrl=https://boards.example.com \
  --set backend.settings.siteDomain=boards.example.com
```

!!! warning "Never pass secrets via `--set`"
    Using `--set secret.djangoSecretKey=...` exposes the value in shell history and the process list. Use a gitignored values file (`-f values.secret.yaml`) or a pre-created Kubernetes Secret (`secret.existingSecret`) instead.

After the install, retrieve the one-time admin password:

```bash
kubectl exec -n visiban \
  $(kubectl get pods -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') \
  -- cat /run/visiban/admin_password
```

### Using an existing Kubernetes Secret

For production clusters managed by Sealed Secrets, External Secrets Operator, or Vault, you can bring your own Secret instead of having the chart create one:

```bash
# Create the Secret outside Helm (or via your secrets manager)
kubectl create secret generic visiban-credentials -n visiban \
  --from-literal=django-secret-key="$(python3 -c 'import secrets; print(secrets.token_urlsafe(50))')" \
  --from-literal=database-url="postgres://visiban:PASSWORD@HOST:5432/visiban" \
  --from-literal=google-client-id="" \
  --from-literal=google-client-secret="" \
  --from-literal=github-client-id="" \
  --from-literal=github-client-secret="" \
  --from-literal=gitlab-client-id="" \
  --from-literal=gitlab-client-secret=""

# Tell the chart to use it
helm install visiban helm/visiban \
  --namespace visiban \
  --set secret.existingSecret=visiban-credentials \
  --set postgresql.auth.existingSecret=visiban-pg-password \
  --set ingress.host=boards.example.com \
  --set backend.settings.allowedHosts=boards.example.com \
  --set backend.settings.corsAllowedOrigins=https://boards.example.com \
  --set backend.settings.frontendUrl=https://boards.example.com \
  --set backend.settings.siteDomain=boards.example.com
```

The existing Secret must contain the same keys the chart expects: `django-secret-key`, `database-url`, plus OAuth provider keys (empty strings for unused providers). The PostgreSQL Secret must contain a `password` key.

### TLS with cert-manager

If cert-manager and a `letsencrypt-prod` ClusterIssuer are installed, enable TLS:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  -f helm/visiban/values.secret.yaml \
  --set ingress.host=boards.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=boards-example-tls \
  --set "ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt-prod" \
  --set backend.settings.allowedHosts=boards.example.com \
  --set backend.settings.corsAllowedOrigins=https://boards.example.com \
  --set backend.settings.frontendUrl=https://boards.example.com \
  --set backend.settings.siteDomain=boards.example.com
```

### TLS with self-signed certificates

For staging or internal deployments, use cert-manager's built-in self-signed issuer:

```yaml
# self-signed-issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
```

```bash
kubectl apply -f self-signed-issuer.yaml
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  --set ingress.host=boards.internal \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=visiban-selfsigned-tls \
  --set "ingress.annotations.cert-manager\.io/cluster-issuer=selfsigned-issuer" \
  --set backend.settings.allowedHosts=boards.internal \
  --set backend.settings.corsAllowedOrigins=https://boards.internal \
  --set secret.djangoSecretKey=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --set postgresql.auth.password=<strong-password>
```

!!! warning
    Browsers will show a certificate warning with self-signed certs. This is expected and suitable only for internal or staging environments.

### Deploying without TLS

When TLS is terminated upstream (e.g. by a cloud load balancer) or not needed (air-gapped network), deploy with `ingress.tls.enabled=false` and enable insecure cookies:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  --set ingress.host=boards.internal \
  --set ingress.tls.enabled=false \
  --set backend.settings.forceInsecureCookies=true \
  --set backend.settings.allowedHosts=boards.internal \
  --set backend.settings.corsAllowedOrigins=http://boards.internal \
  --set secret.djangoSecretKey=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --set postgresql.auth.password=<strong-password>
```

!!! warning
    `forceInsecureCookies: true` disables `SESSION_COOKIE_SECURE` and `CSRF_COOKIE_SECURE`. Do not enable this when the application is reachable from the public internet without TLS termination upstream.

!!! tip "TLS terminated upstream?"
    If your load balancer or ingress controller terminates TLS and sets `X-Forwarded-Proto: https`, you do **not** need `forceInsecureCookies: true`. Django reads the header and treats the request as secure. Keep `forceInsecureCookies: false` (the default) and set `corsAllowedOrigins` to `https://...` as usual.

### Key Helm values

| Value | Default | Description |
|---|---|---|
| `ingress.host` | `visiban.example.com` | Public hostname — **must be set** |
| `ingress.tls.enabled` | `false` | Enable TLS (requires cert-manager or a pre-existing secret) |
| `ingress.tls.secretName` | `visiban-tls` | Secret name for the TLS certificate |
| `backend.settings.allowedHosts` | `visiban.example.com` | Django `ALLOWED_HOSTS` — **must match `ingress.host`** |
| `backend.settings.corsAllowedOrigins` | `https://visiban.example.com` | CORS allowed origins — **must match the public URL** |
| `backend.settings.frontendUrl` | `https://visiban.example.com` | Full URL of the SPA — allauth redirects here after OAuth login/logout |
| `backend.settings.siteDomain` | `visiban.example.com` | Public hostname for OAuth callback URLs |
| `backend.settings.forceInsecureCookies` | `false` | Disable secure cookie flags for plain-HTTP deployments |
| `backend.oauth.oidc.serverUrl` | `""` | OIDC issuer URL (e.g. `https://sso.example.com/realms/my-realm`) — set all three OIDC fields to enable |
| `backend.oauth.oidc.clientId` | `""` | OIDC client ID |
| `backend.oauth.oidc.clientSecret` | `""` | OIDC client secret |
| `backend.oauth.oidc.providerName` | `SSO` | Label shown on the OIDC login button |
| `backend.mediaPersistence.enabled` | `true` | Persist user-uploaded media (attachments) on a PVC |
| `backend.mediaPersistence.size` | `5Gi` | Size of the media PVC |
| `secret.existingSecret` | `""` | Name of a pre-existing K8s Secret — when set, the chart does not create its own |
| `secret.djangoSecretKey` | `change-me-in-production` | Django `SECRET_KEY` (ignored when `existingSecret` is set) |
| `postgresql.auth.existingSecret` | `""` | Name of a pre-existing K8s Secret for the PG password (key: `password`) |
| `postgresql.auth.password` | `visiban` | Database password (ignored when `existingSecret` is set) |
| `backend.image.tag` | `v1.0.0` | Backend image tag |
| `frontend.image.tag` | `v1.0.0` | Frontend image tag |
| `postgresql.enabled` | `true` | Use bundled PostgreSQL 17; set `false` to use `externalDatabase` |
| `postgresql.subchartEnabled` | `false` | Set `true` to use the Bitnami `postgresql` subchart instead of the built-in StatefulSet |
| `valkey.enabled` | `true` | Use bundled Valkey 8; set `false` to use `externalRedis.url` |
| `externalRedis.url` | `""` | External Valkey (or Redis-compatible) DSN (used when `valkey.enabled: false`) — **must be set** when using an external instance |
| `networkPolicy.enabled` | `false` | Create NetworkPolicy resources restricting pod-to-pod traffic |

### Ingress annotations

The chart ships with default annotations for nginx-ingress that match the Docker Compose Nginx configuration:

| Annotation | Default | Why |
|---|---|---|
| `nginx.ingress.kubernetes.io/proxy-body-size` | `20m` | Matches the `client_max_body_size` in the Docker Compose Nginx config. Without this, the ingress controller's default (1m) rejects file uploads before they reach the backend. |
| `nginx.ingress.kubernetes.io/proxy-read-timeout` | `86400` | WebSocket connections idle for up to 24 hours. The default (60s) kills idle WebSocket connections. |
| `nginx.ingress.kubernetes.io/proxy-send-timeout` | `86400` | Matches the read timeout for symmetry on WebSocket connections. |

To add additional annotations (e.g. cert-manager):

```bash
--set 'ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt-prod'
```

For non-nginx ingress controllers (Traefik, AWS ALB, etc.), override the annotations in a values file:

```yaml
ingress:
  className: "traefik"
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: default-upload-limit@kubernetescrd
```

### Network policies

When `networkPolicy.enabled: true`, the chart creates a default-deny ingress policy and explicit allowlists:

- Ingress controller → frontend (port 80)
- Frontend → backend (port 8000)
- Backend → PostgreSQL (port 5432)
- Backend → Valkey (port 6379)

Requires a CNI plugin that supports NetworkPolicy (Calico, Cilium, Weave, etc.).

### Init containers

The Helm chart runs three init containers on every deploy:

1. **migrate** — `python manage.py migrate --noinput`
2. **collectstatic** — `python manage.py collectstatic --noinput` (populates whitenoise static files)
3. **bootstrap** — `python manage.py ensure_site_admin` (creates the admin account on first install and writes the one-time password to `/run/visiban/admin_password`)

After the first install, retrieve the one-time admin password:

```bash
kubectl exec -n visiban \
  $(kubectl get pod -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') \
  -- cat /run/visiban/admin_password
```

See [First Boot](../getting-started/first-boot.md#kubernetes-helm) for details and password reset instructions.

### Media persistence

User-uploaded attachments are stored on a PersistentVolumeClaim (`<release>-visiban-media`). Both the backend pod (read-write) and the frontend nginx pod (read-only, for X-Accel-Redirect) mount this volume.

If the backend and frontend pods may run on different nodes, use a **ReadWriteMany (RWX)** storage class or add a pod affinity rule to co-locate them. With the default **ReadWriteOnce (RWO)**, both pods must land on the same node.

To disable the PVC and use an emptyDir instead (data lost on pod restart):

```bash
--set backend.mediaPersistence.enabled=false
```

### OpenAPI schema

The nginx ingress proxies `/api/` to the backend, so the schema endpoints are accessible at your ingress host with no additional configuration:

```
https://<ingress-host>/api/schema/swagger-ui/
https://<ingress-host>/api/schema/redoc/
https://<ingress-host>/api/schema/
```

The backend port is **not** exposed outside the cluster. For direct backend access during debugging:

```bash
kubectl port-forward -n visiban svc/<release-name>-backend 8000:8000
# then: http://localhost:8000/api/schema/swagger-ui/
```

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

## Scaling out

When a single-server deployment starts to show latency under load, see [Scaling](scaling.md) for the recommended sequence — worker tuning, S3 for attachments, connection pooling, horizontal replicas, and read replicas — with concrete guidance on when each step is warranted.

## Rate limiting

In production (`DEBUG=False`), the API enforces the following request rate limits per client. In development (`DEBUG=True`), throttling is effectively disabled (9999/hour for all scopes).

| Scope | Limit | Notes |
|---|---|---|
| Anonymous requests | 300 / hour | Applies to unauthenticated API calls |
| Authenticated users | 5000 / hour | Polling endpoints (notifications, version check) each fire every 15–30 s, so a single active user easily uses 500+ per hour |
| Login (`/api/v1/auth/login/`) (1.1+) | 20 / hour per IP | Defense-in-depth on top of the allauth gate (5 failed attempts / 5 min per IP). Stops an attacker rotating across many usernames within the global anon ceiling |
| User search (`/api/v1/users/search/`) | 30 / minute | Tighter limit to prevent username enumeration |
| Invite link redemption (`/api/v1/groups/.../join/`) | 10 / hour | Low ceiling to prevent invite token brute-force scanning |

Clients that exceed a limit receive `HTTP 429 Too Many Requests`. The standard `Retry-After` header is not set — clients should implement exponential backoff.

!!! note
    These limits are generous for normal interactive use. If you run a very large team or integrate Visiban with automation that makes frequent API calls, monitor your request volume and raise the `user` limit in `DEFAULT_THROTTLE_RATES` in `settings.py` if needed.
