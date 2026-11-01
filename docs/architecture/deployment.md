# Deploy with Docker Compose or Helm

Two supported paths: Docker Compose for a single server, Helm for Kubernetes. Both run the same images and the same daphne/ASGI backend.

**Why it matters:** Docker Compose is the recommended path for self-hosting a single server; Helm is the path for Kubernetes.

**The minimum (Compose):** fill in `DJANGO_SECRET_KEY` and `DATABASE_URL` in `.env` (leave the default for bundled Postgres), then start the stack:

```bash
cp .env.example .env
# Fill in DJANGO_SECRET_KEY and DATABASE_URL (or leave default for bundled Postgres)
docker compose up --build
```

**Yes, but:** this is the development stack. For production use `docker-compose.prod.yml` ([below](#docker-compose-recommended-for-self-hosting)) or Helm.

**Go deeper:** [Scaling](scaling.md) for load, [Rate limiting](#rate-limiting) for API limits.

## Docker Compose (recommended for self-hosting)

> **Tested:** The Docker Compose development stack has been verified end-to-end.

**How it works:** `docker-compose.yml` starts four services:

- `db`: Postgres 17
- `valkey`: Valkey 8
- `backend`: daphne ASGI, not gunicorn, so WebSocket connections work for real-time board updates. It runs `migrate` and `ensure_site_admin` on startup.
- `frontend`: Vite dev server

**Ports:** the backend (8000) is exposed directly. The Vite dev server on port 5173 does **not** proxy `/api/` requests. The [OpenAPI schema](../api/openapi.md) is at `http://localhost:8000/api/schema/swagger-ui/`; it requires an authenticated session or PAT (a scoped PAT needs the `read` scope; see [OpenAPI](../api/openapi.md)), so anonymous callers can't see the full API surface.

**Production:** `docker-compose.prod.yml` adds nginx, TLS via certbot, and a `scheduler` service for daily notification jobs, with no bind-mounted source. See [Installation](../getting-started/installation.md).

## Production Docker images

CI publishes pre-built images to the GitLab container registry. `:latest` is the newest **stable** release: only a stable release-tag pipeline writes it, as a multi-arch (linux/amd64 + linux/arm64) manifest list. A pre-release tag (`-alpha`/`-beta`/`-rc`) publishes its own exact version tag and never touches `:latest`. Every merge to `main` pushes an amd64-only `:main` and short-SHA tag instead:

| Image | Stable release (multi-arch) | Latest `main` build (amd64 only) |
|---|---|---|
| Backend | `registry.gitlab.com/visiban/visiban/backend:latest` | `registry.gitlab.com/visiban/visiban/backend:main` |
| Frontend | `registry.gitlab.com/visiban/visiban/frontend:latest` | `registry.gitlab.com/visiban/visiban/frontend:main` |

Each `main` merge also pushes a short-SHA tag (e.g. `registry.gitlab.com/visiban/visiban/backend:a1b2c3d4`) for rollback.

!!! warning "GitLab-registry `:main` and short-SHA tags are amd64-only and unvetted"
    The GitLab-registry `:main` and short-SHA tags built on `main` are **linux/amd64 only** and have not been through a release's gates. Use `:latest` or a pinned release tag (for example `v1.2.0`) for anything you run in production; both are multi-arch, so they work on arm64 hosts (Apple Silicon, Graviton, Raspberry Pi). GHCR's `ghcr.io/visiban/visiban/backend:latest` / `frontend:latest` behave the same way. Before 1.2, GitLab `:latest` tracked `main` builds; if you relied on that, switch to `:main`. See [Container image retention](../administration/container-image-retention.md#gitlab-registry-latest-is-stable-only-main-publishes-main).

To build images manually:

```bash
docker build -f backend/Dockerfile -t registry.gitlab.com/visiban/visiban/backend:latest backend/
docker build -f frontend/Dockerfile -t registry.gitlab.com/visiban/visiban/frontend:latest frontend/
```

!!! note
    The Helm chart runs the backend with **daphne** (ASGI server) by default, like Compose. WebSockets and real-time features need no extra configuration in Kubernetes.

## Kubernetes / Helm

> **Tested:** The Helm chart has been deployed and verified on a live Kubernetes cluster.

The chart lives in `helm/visiban/` and pulls images from the GitLab container registry ([Production Docker images](#production-docker-images)). It bundles:

| Component | Version | How deployed |
|---|---|---|
| PostgreSQL | 17 | Built-in StatefulSet using the official `postgres:17` image (default) |
| Valkey | 8 | Built-in StatefulSet using the official `valkey/valkey:8-alpine` image (the same major as `docker-compose.prod.yml`) |

> **Note (Bitnami PostgreSQL):** Chart 0.8.0 removed the opt-in Bitnami `postgresql` subchart (`postgresql.subchartEnabled`), which never rendered with the chart's values; `postgresql.subchartEnabled: true` now fails the render. The chart has no subchart dependencies (#1911). See the [upgrade note](../administration/upgrade.md#upgrading-to-13x) if a release still runs it.

> **Note:** Compose and Helm both run **PostgreSQL 17**. Coming from a release that used PostgreSQL 16, export your data first: major version upgrades are not performed in-place. See [Upgrading PostgreSQL major versions](#upgrading-postgresql-major-versions).

### Install

The chart has no subchart dependencies, so there is no `helm dependency update` step.

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

Then retrieve the one-time admin password:

```bash
kubectl exec -n visiban \
  $(kubectl get pods -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') \
  -- cat /run/visiban/admin_password
```

### Using an existing Kubernetes Secret

With Sealed Secrets, External Secrets Operator, or Vault, bring your own Secret instead of letting the chart create one:

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

**Required keys:** `django-secret-key`, `database-url`, plus OAuth provider keys (empty strings for unused providers). The PostgreSQL Secret needs a `password` key.

### TLS with cert-manager

With cert-manager and a `letsencrypt-prod` ClusterIssuer installed:

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

For staging or internal use, point cert-manager's self-signed issuer at the ingress:

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

If TLS is terminated upstream (e.g. by a cloud load balancer) or not needed (air-gapped network), set `ingress.tls.enabled=false` and enable insecure cookies:

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
    If your load balancer or ingress controller terminates TLS and sets `X-Forwarded-Proto: https`, you do **not** need `forceInsecureCookies: true`. Django reads the header and treats the request as secure. Keep `forceInsecureCookies: false` (the default) and set `corsAllowedOrigins` to `https://...` as usual. Also make sure `backend.settings.numProxies` matches your proxy chain: the chart renders `2` (this chart's frontend nginx plus the ingress controller) when the ingress is enabled and the frontend Service is `ClusterIP`; set it explicitly if another proxy, such as the load balancer, also appends to `X-Forwarded-For`. See [Reverse proxies and the client IP](../administration/configuration.md#reverse-proxies-and-the-client-ip).

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
| `backend.settings.mcpServerEnabled` | `false` | Renders `MCP_SERVER_ENABLED=true` so the [MCP server](../api/mcp.md) is mounted at `/mcp` (added in 1.3) |
| `backend.settings.gitLensEnabled` | `false` | Renders `GIT_LENS_ENABLED=true`, enabling the [Issue Board Lens](../features/issue-board-lens.md) (adds the `git_lens` tables; added in 1.3) |
| `backend.settings.numProxies` | unset (renders `2` with the ingress enabled and a `ClusterIP` frontend Service, otherwise the backend default of `1`) | `NUM_PROXIES`: trusted proxy hops that append to `X-Forwarded-For`, so per-client rate limits and the `/admin/` allowlist see the real client address. An explicit value always wins |
| `backend.oauth.oidc.serverUrl` | `""` | OIDC issuer URL (e.g. `https://sso.example.com/realms/my-realm`) — set all three OIDC fields to enable |
| `backend.oauth.oidc.clientId` | `""` | OIDC client ID |
| `backend.oauth.oidc.clientSecret` | `""` | OIDC client secret |
| `backend.oauth.oidc.providerName` | `SSO` | Label shown on the OIDC login button |
| `backend.mediaPersistence.enabled` | `true` | Persist user-uploaded media (attachments) on a PVC |
| `backend.mediaPersistence.size` | `5Gi` | Size of the media PVC |
| `secret.existingSecret` | `""` | Name of a pre-existing K8s Secret — when set, the chart does not create its own |
| `secret.djangoSecretKey` | `change-me-in-production` | Django `SECRET_KEY` (ignored when `existingSecret` is set) |
| `postgresql.auth.existingSecret` | `""` | Name of a pre-existing K8s Secret for the PG password (key: `password`). The bundled PostgreSQL and the backend (via `DATABASE_URL_PASSWORD`) both read the password from it (#1910) |
| `postgresql.auth.password` | `visiban` | Database password. The default is a placeholder: the render fails until you set your own password, unless `postgresql.auth.existingSecret` supplies it |
| `backend.image.tag` | current release tag (e.g. `vX.Y.Z`) | Backend image tag — bumped by `scripts/release.sh` on every release |
| `frontend.image.tag` | current release tag (e.g. `vX.Y.Z`) | Frontend image tag — bumped by `scripts/release.sh` on every release |
| `postgresql.enabled` | `true` | Use bundled PostgreSQL 17; set `false` to use `externalDatabase` |
| `postgresql.subchartEnabled` | `false` | Removed in chart 0.8.0 (#1911). Must stay `false`; `true` fails the render |
| `valkey.enabled` | `true` | Use bundled Valkey 8; set `false` to use `externalRedis.url` |
| `valkey.image.tag` | `8-alpine` | Official `valkey/valkey` image tag. Never `latest` or empty — the chart refuses both |
| `valkey.primary.persistence.enabled` | `false` | Keep Valkey's AOF in a PVC across restarts. Not needed: Valkey holds only rebuildable data |
| `valkey.auth.enabled` | `false` | Require a password on the bundled Valkey (#1211). Needs exactly one of the two keys below |
| `valkey.auth.password` | `""` | Chart-managed Valkey password, stored in the `<fullname>-valkey-auth` Secret |
| `valkey.auth.existingSecret` / `valkey.auth.existingSecretPasswordKey` | `""` / `valkey-password` | A Secret you manage instead, and the key holding the password |
| `externalRedis.url` | `""` | External Valkey (or Redis-compatible) DSN (used when `valkey.enabled: false`) — **must be set** when using an external instance |
| `externalRedis.existingSecret` / `externalRedis.existingSecretPasswordKey` | `""` / `redis-password` | Secret holding the external instance's password, instead of in the URL (#1361). Leave the password out of `url`/`cacheUrl` |
| `redis.enabled` | unset | **Deprecated** 1.1 alias for `valkey.enabled`; `false` wins over `valkey.enabled`. Any other `redis.*` key fails the render. Not in `values.yaml`; removed no earlier than 1.3 |
| `networkPolicy.enabled` | `false` | Create NetworkPolicy resources restricting pod-to-pod traffic |

On Helm installs the frontend's Content-Security-Policy names `ingress.host` for WebSocket connections (`wss://`, plus `ws://` when `ingress.tls.enabled` is `false`), and nothing is added when the ingress is disabled or no host is set, so WebSocket connections then rely on `'self'` (as does reaching the app through a different host name or `kubectl port-forward`); set `ingress.host` if your browser does not map `'self'` to `ws`/`wss`; the frame policy is `X-Frame-Options: DENY` and the referrer policy is `Referrer-Policy: same-origin` (so share and invite tokens in URLs are never sent to another origin), matching the Compose templates.

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

1. **migrate** — `python manage.py migrate_with_lock` (takes a lock so concurrent rollouts do not race, then runs `migrate`). Since 1.2 every index and constraint Visiban adds is built without an `ACCESS EXCLUSIVE` lock, so this init container does not block the running pods it is replacing — see [Database migrations](../development/database-migrations.md).
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

Attachments live on a PersistentVolumeClaim (`<release>-visiban-media`). The backend pod mounts it read-write; the frontend nginx pod mounts it read-only (for X-Accel-Redirect).

**Watch out:** with the default **ReadWriteOnce (RWO)**, both pods must land on the same node. If they may run on different nodes, use a **ReadWriteMany (RWX)** storage class or add a pod affinity rule to co-locate them.

To use an emptyDir instead (data lost on pod restart):

```bash
--set backend.mediaPersistence.enabled=false
```

### OpenAPI schema

The nginx ingress proxies `/api/` to the backend, so the schema endpoints work at your ingress host with no extra configuration. Sign in first: they require an authenticated session or PAT (a scoped PAT needs the `read` scope; see [OpenAPI](../api/openapi.md)).

```
https://<ingress-host>/api/schema/swagger-ui/
https://<ingress-host>/api/schema/redoc/
https://<ingress-host>/api/schema/
```

The backend port is **not** exposed outside the cluster. To debug directly:

```bash
kubectl port-forward -n visiban svc/<release-name>-backend 8000:8000
# then: http://localhost:8000/api/schema/swagger-ui/
# (send the real Host header, or put `localhost` in backend.settings.allowedHosts
#  together with backend.settings.allowUnsafeHosts=true)
```

### Upgrade

```bash
helm upgrade visiban helm/visiban -f my-values.yaml
```

Pass your values file on each upgrade. `--reuse-values` starts from the previous
release's stored values, which lack keys a newer chart added, so it cannot move
you off the 1.1 chart (see below).

An install that still uses the default PostgreSQL password (`visiban`, or an empty
one) must change the database role's password and set `postgresql.auth.password`
first, or the render fails. See the
[upgrade guide](../administration/upgrade.md#upgrading-to-12x).

Coming from the 1.1 chart, translate the `redis:` block in your values file to
`valkey:` (it is not a plain rename: drop `redis.image.tag`, and
`master.persistence` becomes `primary.persistence`) and upgrade with
`-f my-values.yaml` instead of `--reuse-values`: the previous release's stored
values lack the keys 1.2 added, so the render fails. The 1.1
`redis.enabled` key is still honored as a deprecated alias for `valkey.enabled`
(removed no earlier than 1.3). See the
[upgrade guide](../administration/upgrade.md#upgrading-to-12x).

### Upgrading PostgreSQL major versions

The bundled PostgreSQL does not upgrade major versions in place. To move from PostgreSQL 16 to a chart that bundles 17, migrate your data with a dump and restore. The user and database names below are the chart defaults (`postgresql.auth.username` and `postgresql.auth.database`).

1. **Set the names once, and stop the writers:** scale the backend to zero, and suspend the scheduled-job CronJobs if you enabled them:
   ```bash
   NS=visiban
   RELEASE=visiban
   BACKEND=visiban-backend   # the backend Deployment (kubectl -n "$NS" get deploy)
   kubectl -n "$NS" scale deployment/"$BACKEND" --replicas=0
   for cj in $(kubectl -n "$NS" get cronjob -o name); do
     kubectl -n "$NS" patch "$cj" -p '{"spec":{"suspend":true}}'
   done
   ```

2. **Export data from the running PostgreSQL 16 pod.** `--no-owner --no-privileges` keeps the dump restorable as a different database user:
   ```bash
   kubectl -n "$NS" exec "$RELEASE-postgresql-0" -- \
     pg_dump --no-owner --no-privileges -U visiban -d visiban > visiban_backup.sql
   ```

3. **Verify the dump before deleting anything.** A failed `pg_dump` leaves an empty or truncated file, and the next step deletes the only other copy:
   ```bash
   if [ -s visiban_backup.sql ] && grep -q 'PostgreSQL database dump complete' visiban_backup.sql; then
     echo "dump OK"
   else
     echo "DUMP INCOMPLETE: stop here and fix the dump"
   fi
   ```
   Continue only on `dump OK`.

4. **Delete the StatefulSet and its PersistentVolumeClaim** (this removes the old data volume). Deleting the StatefulSet first lets the claim go away instead of staying in `Terminating` under a running pod; the next upgrade recreates both:
   ```bash
   kubectl -n "$NS" delete statefulset "$RELEASE-postgresql"
   kubectl -n "$NS" delete pvc "data-$RELEASE-postgresql-0"
   ```

5. **Upgrade the Helm release with the backend still at zero.** This provisions a fresh PostgreSQL 17 pod, and keeps the backend from migrating and seeding the empty database before the restore. The new data directory takes its password from `postgresql.auth.password`, which must be your own value (the placeholder fails the render):
   ```bash
   helm upgrade "$RELEASE" helm/visiban --namespace "$NS" -f my-values.yaml \
     --set-string postgresql.auth.password="$PG_PASSWORD" \
     --set backendReplicaCount=0
   kubectl -n "$NS" rollout status statefulset/"$RELEASE-postgresql" --timeout=180s
   ```

6. **Restore, then start the backend.** `psql -1 -v ON_ERROR_STOP=1` runs the whole file as one transaction, so a failure rolls everything back and leaves the database empty; `ON_ERROR_STOP` alone would not, because each statement of a plain dump commits on its own. The final upgrade (without `backendReplicaCount=0`) runs only if `psql` exits 0. If it does not, the backend stays at zero: fix the cause and run this block again, which recreates the database first:
   ```bash
   kubectl -n "$NS" exec "$RELEASE-postgresql-0" -- dropdb -U visiban --force --if-exists visiban
   kubectl -n "$NS" exec "$RELEASE-postgresql-0" -- createdb -U visiban visiban
   kubectl -n "$NS" exec -i "$RELEASE-postgresql-0" -- \
     psql -U visiban -d visiban -1 -v ON_ERROR_STOP=1 < visiban_backup.sql \
     && helm upgrade "$RELEASE" helm/visiban --namespace "$NS" -f my-values.yaml \
          --set-string postgresql.auth.password="$PG_PASSWORD"
   ```
   The upgrade does not resume CronJobs suspended in step 1; resume each one with `kubectl -n "$NS" patch cronjob <name> -p '{"spec":{"suspend":false}}'`.

## Scaling out

If a single server shows latency under load, follow the sequence in [Scaling](scaling.md): worker tuning, S3 for attachments, connection pooling, horizontal replicas, read replicas.

## Rate limiting

With `DEBUG=False` (production) the API enforces the per-client limits below.

**By the numbers:**

- **Development (`DEBUG=True`):** most scopes rise to 9999/hour, a finite budget rather than true disabling. The public share-link scopes (`share_link`, `share_link_token`) have no development bypass.
- **`VISIBAN_DISABLE_THROTTLING=True`:** a CI-only switch (used by the schema-fuzz job) that lifts every throttle rate. It requires `DEBUG=True`; the app refuses to start otherwise.

| Scope | Limit | Notes |
|---|---|---|
| Anonymous requests | 300 / hour | Applies to unauthenticated API calls |
| Authenticated users | 5000 / hour | Polling endpoints (notifications, version check) each fire every 15–30 s, so a single active user can reach 500+ per hour |
| Login (`/api/v1/auth/login/`) (1.1+) | 20 / hour per IP | This DRF throttle wraps only the SPA/API endpoint. The allauth `login_failed` gate below applies on top |
| Password change (`/api/v1/auth/change-password/`, `/api/v1/auth/password/change/`) | 10 / hour per user | One `password_change` bucket shared by both endpoints. Failed current-password checks here also count toward the same per-account and per-IP `login_failed` budgets as sign-in |
| User search (`/api/v1/users/`) | 30 / minute | Tighter limit to prevent username enumeration |
| Cross-board card query (`GET /api/v1/cards/`) (1.2+) | 120 / minute per user | `card_query` scope; bounds scraping of a member's whole accessible-card corpus while leaving room for incremental sync |
| Registration (`/api/v1/auth/registration/`) | 10 / minute per IP | `register` scope; anonymous requests only. Slows invite-token guessing and mass account creation |
| Choose username (`/api/v1/auth/choose-username/`) | 10 / minute per user | `choose_username` scope; also drawn on by a username or email change through `PATCH /api/v1/auth/me/` and `PUT`/`PATCH /api/v1/auth/user/` |
| Password reset confirm (`/api/v1/auth/password/reset/confirm/`) | 10 / hour per IP | `password_reset_confirm` scope; prevents token-stuffing |
| Email-confirm redirect (`/accounts/confirm-email/<key>/`) | 60 / hour per IP | `email_confirm_redirect` scope; generous because the endpoint only redirects |
| Invite link redemption (`/api/v1/groups/join/.../` and, 1.2+, `/api/v1/boards/join/.../`) | 10 / hour per IP | Low ceiling to prevent invite token brute-force scanning. One `join_group` bucket shared by group and board join requests, preview and redeem alike |

Exceeding a DRF throttle scope returns `HTTP 429 Too Many Requests`. DRF sets the standard `Retry-After` header (seconds) on the response; clients should wait that long before retrying.

**Login lockout (allauth `login_failed`):** `ACCOUNT_RATE_LIMITS = "10/m/ip,5/300s/key"`. It is not a DRF throttle and applies to **both** `/api/v1/auth/login/` (the SPA goes through allauth's rate-limited adapter, #1199) and allauth's own HTML view at `/accounts/login/`, which the DRF throttle does not wrap at all. The gate is two rates, both enforced everywhere it applies:

- 10 failed attempts / minute per IP (across any accounts)
- 5 failed attempts / 5 min per account (across any IPs)

**What the client sees:** at login either lockout returns `HTTP 400 Bad Request` with `{"non_field_errors": ["Too many failed login attempts. Try again later."]}`. The wording is identical, so the response doesn't say which rate tripped. The password-change endpoints draw on the same budgets and return `HTTP 429 Too Many Requests`. See [API Authentication](../api/authentication.md#1-obtain-a-token) for the full set of login error responses.

!!! note
    These limits suit normal interactive use. For a very large team or frequent automation, monitor request volume and raise the `user` limit in `DEFAULT_THROTTLE_RATES` in `settings.py`.

!!! note
    The per-IP `login_failed` rate (10 failed attempts/minute) is shared across every account tried from that IP. Behind a shared NAT (an office, a school, a carrier-grade NAT), it can trip for accounts that never failed a login: a correct password from that IP is refused for up to the ~1-minute window. The tradeoff closes the SPA credential-stuffing gap (many accounts, one IP) that the per-account rate alone doesn't cover. It is allauth's own default shape for this rate.

!!! note
    While the per-account lockout is active, even the **correct** password is refused: the lockout is on the account, not on wrong guesses. A locked-out user waits out the 5-minute window unless they use one of two early-recovery paths (#1203):

    - **A successful password reset clears it.** The reset-confirm endpoint (dj-rest-auth's `PasswordResetConfirmSerializer`) bypasses allauth's own reset flow, so it gets no built-in lockout-clearing. Visiban's `VisibanPasswordResetConfirmSerializer` clears it explicitly. Since 1.2 (#1206), every attempt naming an existing account, by username or email, counts against one lockout keyed on the account, and that bucket is cleared. The username- and email-string buckets are cleared too, for identifiers that don't resolve to exactly one account and for lockouts recorded before the upgrade.
    - **A site admin can clear it directly**, with no reset needed: `POST /api/v1/admin/users/{id}/clear-lockout/` (site-admin only). See [API Authentication](../api/authentication.md#1-obtain-a-token) for the endpoint contract.
