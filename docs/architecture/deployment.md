# Deployment

Two supported paths: Docker Compose for a single server, Helm for Kubernetes. Both run the same images and the same daphne/ASGI backend.

## Docker Compose (recommended for self-hosting)

> **Tested:** The Docker Compose development stack has been verified end-to-end.

```bash
cp .env.example .env
# Fill in DJANGO_SECRET_KEY and DATABASE_URL (or leave default for bundled Postgres)
docker compose up --build
```

The `docker-compose.yml` starts four services: `db` (Postgres 17), `valkey` (Valkey 8), `backend` (daphne ASGI), and `frontend` (Vite dev server). The backend runs `migrate` and `ensure_site_admin` automatically on startup.

> **Note:** The backend uses **daphne** (ASGI server) instead of gunicorn to support WebSocket connections for real-time board updates.

The backend port (8000) is exposed directly in the dev stack. The Vite dev server on port 5173 does **not** proxy `/api/` requests. Access the [OpenAPI schema](../api/openapi.md) at `http://localhost:8000/api/schema/swagger-ui/` — the schema endpoints require an authenticated session or PAT, to avoid exposing the full API surface to anonymous callers.

For a production-oriented Docker Compose stack (nginx, TLS via certbot, a `scheduler` service for daily notification jobs, no bind-mounted source), see `docker-compose.prod.yml` and [Installation](../getting-started/installation.md).

## Production Docker images

Pre-built images are published to the GitLab container registry automatically by CI. Every merge to `main` pushes an amd64-only `:latest` and short-SHA tag; multi-arch (linux/amd64 + linux/arm64) `:latest` comes from a **stable** release-tag pipeline only — a pre-release tag (`-alpha`/`-beta`/`-rc`) publishes its own exact version tag and never touches `:latest`:

| Image | Registry path |
|---|---|
| Backend | `registry.gitlab.com/visiban/visiban/backend:latest` |
| Frontend | `registry.gitlab.com/visiban/visiban/frontend:latest` |

Each merge also pushes a short-SHA tag (e.g. `registry.gitlab.com/visiban/visiban/backend:a1b2c3d4`) for rollback.

!!! warning "GitLab-registry `:latest` is amd64-only between releases"
    The GitLab-registry `:latest` and short-SHA tags built on `main` are **linux/amd64 only**. `:latest` is multi-arch (linux/amd64 + linux/arm64) only right after a release tag's pipeline runs, and the next `main` merge overwrites it with an amd64-only image again. On arm64 hosts (Apple Silicon, Graviton, Raspberry Pi), pull a pinned release tag (for example `v1.2.0`) or GHCR's `ghcr.io/visiban/visiban/backend:latest` / `frontend:latest`, which only release tags update and which stay multi-arch. See [Container image retention](../administration/container-image-retention.md#gitlab-registry-latest-is-amd64-only-between-releases).

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
| Valkey | 8 | Built-in StatefulSet using the official `valkey/valkey:8-alpine` image (the same major as `docker-compose.prod.yml`) |

> **Note (Bitnami PostgreSQL):** The Bitnami `postgresql` subchart is disabled by default (`postgresql.subchartEnabled: false`) because Bitnami no longer publishes versioned Docker Hub tags for older chart releases, which caused image pull failures. The chart deploys PostgreSQL via its own StatefulSet instead. Set `postgresql.subchartEnabled: true` to revert to the Bitnami subchart if needed.

> **Note:** Both the Docker Compose and Kubernetes/Helm stacks run **PostgreSQL 17**. If you are migrating an existing deployment from an older release that used PostgreSQL 16, you must export your data first — PostgreSQL major version upgrades are not performed in-place. See [Upgrading PostgreSQL major versions](#upgrading-postgresql-major-versions).

### Install

```bash
# The only remaining subchart is the opt-in Bitnami PostgreSQL one
# (postgresql.subchartEnabled). Valkey is part of the chart itself since 0.5.0.
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
| `backend.settings.allowedHosts` | `visiban.example.com` | Django `ALLOWED_HOSTS` — **must match `ingress.host`**. Comma-separated; rendered verbatim (the chart no longer appends `localhost`/`127.0.0.1`). A catch-all or loopback entry (`*`, `localhost`, `localhost.localdomain`, `ip6-localhost`, `127.0.0.1`, `0.0.0.0`, `[::ffff:127.0.0.1]`, the IPv6 loopback or unspecified address in any spelling (`[::1]`, `::1`, `[::]`, `[0:0:0:0:0:0:0:1]`), or a leading-dot form of any of these (`.localhost`)) fails the render unless `backend.settings.allowUnsafeHosts` is `true` |
| `backend.settings.allowUnsafeHosts` | `false` | Opt-in for the catch-all/loopback `allowedHosts` entries above, e.g. to browse through `kubectl port-forward`. Prefer sending the real `Host` header. Refused when `demo.enabled` is true |
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
| `backend.image.tag` | current release tag (e.g. `vX.Y.Z`) | Backend image tag — bumped by `scripts/release.sh` on every release |
| `frontend.image.tag` | current release tag (e.g. `vX.Y.Z`) | Frontend image tag — bumped by `scripts/release.sh` on every release |
| `postgresql.enabled` | `true` | Use bundled PostgreSQL 17; set `false` to use `externalDatabase` |
| `postgresql.subchartEnabled` | `false` | Set `true` to use the Bitnami `postgresql` subchart instead of the built-in StatefulSet |
| `valkey.enabled` | `true` | Use bundled Valkey 8; set `false` to use `externalRedis.url` |
| `valkey.image.tag` | `8-alpine` | Official `valkey/valkey` image tag. Never `latest` or empty — the chart refuses both |
| `valkey.primary.persistence.enabled` | `false` | Keep Valkey's AOF in a PVC across restarts. Not needed: Valkey holds only rebuildable data |
| `valkey.auth.enabled` | `false` | Require a password on the bundled Valkey (#1211). Needs exactly one of the two keys below |
| `valkey.auth.password` | `""` | Chart-managed Valkey password, stored in the `<fullname>-valkey-auth` Secret |
| `valkey.auth.existingSecret` / `valkey.auth.existingSecretPasswordKey` | `""` / `valkey-password` | A Secret you manage instead, and the key holding the password |
| `externalRedis.url` | `""` | External Valkey (or Redis-compatible) DSN (used when `valkey.enabled: false`) — **must be set** when using an external instance |
| `externalRedis.existingSecret` / `externalRedis.existingSecretPasswordKey` | `""` / `redis-password` | Secret holding the external instance's password, instead of in the URL (#1361). Leave the password out of `url`/`cacheUrl` |
| `networkPolicy.enabled` | `false` | Create NetworkPolicy resources restricting pod-to-pod traffic |

### Ingress annotations

The chart ships with default annotations for nginx-ingress that match the Docker Compose Nginx configuration:

| Annotation | Default | Why |
|---|---|---|
| `nginx.ingress.kubernetes.io/proxy-body-size` | `35m` (derived) | Derived from the larger of `backend.settings.maxUploadSizeBytes` and `backend.settings.importMaxSizeBytes` plus 10 MB, matching the `client_max_body_size` in the Docker Compose Nginx config (`35M`). Without this, the ingress controller's default (1m) rejects file uploads and Trello imports before they reach the backend. |
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

- Ingress controller → frontend (port 8080 — the frontend container's own
  listen port, #1224; the frontend Service itself still fronts port 80 by
  default)
- Frontend → backend (port 8000)
- Backend → PostgreSQL (port 5432)
- Backend → Valkey (port 6379)

Requires a CNI plugin that supports NetworkPolicy (Calico, Cilium, Weave, etc.).

### Init containers

The Helm chart runs three init containers on every deploy:

1. **migrate** — `python manage.py migrate --noinput`. Since 1.2 every index and constraint Visiban adds is built without an `ACCESS EXCLUSIVE` lock, so this init container does not block the running pods it is replacing — see [Database migrations](../development/database-migrations.md).
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

The nginx ingress proxies `/api/` to the backend, so the schema endpoints are accessible at your ingress host with no additional configuration — sign in first, since these endpoints require an authenticated session or PAT:

```
https://<ingress-host>/api/schema/swagger-ui/
https://<ingress-host>/api/schema/redoc/
https://<ingress-host>/api/schema/
```

The backend port is **not** exposed outside the cluster. For direct backend access during debugging:

```bash
kubectl port-forward -n visiban svc/<release-name>-backend 8000:8000
# then: http://localhost:8000/api/schema/swagger-ui/
# (send the real Host header, or put `localhost` in backend.settings.allowedHosts
#  together with backend.settings.allowUnsafeHosts=true)
```

### Upgrade

```bash
helm upgrade visiban helm/visiban --reuse-values
```

The first `--reuse-values` upgrade onto chart 0.5.0 or later, from a release that
used the Bitnami Valkey subchart, also needs
`--set valkey.image.repository=valkey/valkey --set valkey.image.tag=8-alpine`
(or `--reset-then-reuse-values` on Helm 3.14+). Otherwise the subchart's reused
`bitnami/valkey:latest` defaults stop the render. See the
[upgrade guide](../administration/upgrade.md#upgrading-to-12x).

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
| Authenticated users | 5000 / hour | Polling endpoints (notifications, version check) each fire every 15–30 s, so a single active user can reach 500+ per hour |
| Login (`/api/v1/auth/login/`) (1.1+) | 20 / hour per IP | This DRF throttle only wraps the SPA/API endpoint. Alongside it, allauth's own `login_failed` gate (`ACCOUNT_RATE_LIMITS = "10/m/ip,5/300s/key"`) applies to **both** `/api/v1/auth/login/` (the SPA goes through allauth's rate-limited adapter, #1199) and allauth's own HTML view at `/accounts/login/` (which this DRF throttle does not wrap at all — the allauth gate is its only rate limit). That gate is two rates, both enforced everywhere it applies: 10 failed attempts / minute per IP (across any accounts), and 5 failed attempts / 5 min per account (across any IPs) |
| User search (`/api/v1/users/search/`) | 30 / minute | Tighter limit to prevent username enumeration |
| Invite link redemption (`/api/v1/groups/.../join/`) | 10 / hour | Low ceiling to prevent invite token brute-force scanning |

Clients that exceed one of the DRF throttle scopes above receive `HTTP 429 Too Many Requests`. The standard `Retry-After` header is not set — clients should implement exponential backoff. Neither `login_failed` lockout above is a DRF throttle, and neither follows this shape: either one returns `HTTP 400 Bad Request` with `{"non_field_errors": ["Too many failed login attempts. Try again later."]}` — identical wording, so the response alone doesn't say which rate tripped. See [API Authentication](../api/authentication.md#1-obtain-a-token) for the full set of login error responses.

!!! note
    These limits are generous for normal interactive use. If you run a very large team or integrate Visiban with automation that makes frequent API calls, monitor your request volume and raise the `user` limit in `DEFAULT_THROTTLE_RATES` in `settings.py` if needed.

!!! note
    Because the per-IP `login_failed` rate (10 failed attempts/minute) is shared across every account attempted from that IP, a shared-NAT deployment (an office, a school, a carrier-grade NAT) can trip it on behalf of accounts that never failed a login themselves — a correct password from that IP is refused alongside the ones that were actually wrong, for up to the ~1-minute window. This is the tradeoff for closing the SPA credential-stuffing gap the per-account rate alone doesn't cover (many accounts, one IP); it is allauth's own default shape for this rate.

!!! note
    While the per-account login lockout is active, even the **correct** password is refused — the lockout is on the account, not on wrong guesses specifically, so a locked-out legitimate user must wait out the 5-minute window unless they use one of the two early-recovery paths below (#1203).

    - **A successful password reset clears it.** Visiban's reset-confirm endpoint (dj-rest-auth's `PasswordResetConfirmSerializer`) doesn't go through allauth's own reset flow, so it doesn't get allauth's built-in lockout-clearing for free — Visiban's `VisibanPasswordResetConfirmSerializer` clears it explicitly after a successful reset instead. Since 1.2 (#1206), every attempt that names an existing account — by username or by email — counts against one lockout keyed on the account itself, and that is the bucket cleared; the username- and email-string buckets are cleared too, for identifiers that don't resolve to exactly one account and for lockouts recorded before the upgrade.
    - **A site admin can clear it directly**, without the user needing to complete a reset at all — `POST /api/v1/admin/users/{id}/clear-lockout/` (site-admin only). See [API Authentication](../api/authentication.md#1-obtain-a-token) for the endpoint contract.
