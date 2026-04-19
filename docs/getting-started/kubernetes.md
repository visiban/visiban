# Kubernetes (Helm)

Deploy Visiban to a Kubernetes cluster using the bundled Helm chart.

!!! tip "Docker Compose"
    If you are deploying to a single server, the [Docker Compose installation](installation.md) is simpler. This guide is for Kubernetes clusters.

## Prerequisites

| Requirement | Minimum version |
|---|---|
| Kubernetes cluster | 1.25+ |
| Helm | 3.12+ |
| kubectl | configured for your cluster |
| Ingress controller | nginx-ingress-controller recommended |
| cert-manager (optional) | 1.12+ — for automatic TLS certificates |
| CNI with NetworkPolicy support (optional) | Calico, Cilium, etc. — for network isolation |

## Quick start

### 1. Clone and update dependencies

```bash
git clone https://github.com/visiban/visiban.git
cd visiban
helm dependency update helm/visiban
```

### 2. Create a secrets file

```bash
cp helm/visiban/values.secret.yaml.example helm/visiban/values.secret.yaml
```

Edit `values.secret.yaml` with strong random values:

```yaml
secret:
  djangoSecretKey: ""  # python -c "import secrets; print(secrets.token_urlsafe(50))"

postgresql:
  auth:
    password: ""  # strong random password
```

!!! warning "Never commit `values.secret.yaml`"
    This file is gitignored. Keep secrets out of shell history — always use `-f values.secret.yaml` instead of `--set secret.djangoSecretKey=...`. The `--set` flag leaks values to shell history (`~/.bash_history`), `/proc/*/cmdline`, and process listings visible to other users on the host.

    To generate and insert secrets in one step:

    ```bash
    # Generate djangoSecretKey directly into values.secret.yaml
    DJANGO_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")
    sed -i "s|djangoSecretKey:.*|djangoSecretKey: \"${DJANGO_KEY}\"|" helm/visiban/values.secret.yaml

    # Generate PostgreSQL password
    PG_PASS=$(openssl rand -base64 32)
    sed -i "s|password:.*# strong random password|password: \"${PG_PASS}\"  # strong random password|" helm/visiban/values.secret.yaml
    ```

    For production clusters, use a secrets manager (Sealed Secrets, External Secrets Operator, Vault) and reference an `existingSecret` — see [Using a pre-existing Secret](#using-a-pre-existing-secret).

### 3. Install

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

Release-time tasks run automatically:

1. **migrate** — applies database migrations. Runs as a Helm `pre-install` / `pre-upgrade` Job (`templates/migrate-job.yaml`) so only **one** pod migrates per release, regardless of `backendReplicaCount`. Inspect with `kubectl get jobs -l app.kubernetes.io/component=migrate` and `kubectl logs job/<release>-visiban-migrate`.
2. **collectstatic** (init container) — bundles Django static assets.
3. **bootstrap** (init container, first install only) — creates the initial admin account.

### 4. Retrieve the admin password

```bash
kubectl exec -n visiban deploy/visiban-backend -- \
  cat /run/visiban/admin_password
```

The password is generated once and written to an emptyDir volume. Copy it, then log in at `https://boards.example.com/` with username `admin`.

!!! note
    Change this password immediately after first login. See [First Boot](first-boot.md).

### 5. Verify

```bash
# Pods should be Running
kubectl get pods -n visiban

# Backend health check
kubectl exec -n visiban deploy/visiban-backend -- \
  python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/api/health/readiness/').read().decode())"
```

## TLS with cert-manager

To enable automatic Let's Encrypt certificates:

1. Install cert-manager and create a `ClusterIssuer`:

    ```yaml
    # cluster-issuer.yaml
    apiVersion: cert-manager.io/v1
    kind: ClusterIssuer
    metadata:
      name: letsencrypt-prod
    spec:
      acme:
        server: https://acme-v02.api.letsencrypt.org/directory
        email: admin@example.com
        privateKeySecretRef:
          name: letsencrypt-prod
        solvers:
          - http01:
              ingress:
                class: nginx
    ```

2. Enable TLS in your Helm install:

    ```bash
    helm install visiban helm/visiban \
      --namespace visiban --create-namespace \
      -f helm/visiban/values.secret.yaml \
      --set ingress.host=boards.example.com \
      --set ingress.tls.enabled=true \
      --set ingress.tls.secretName=visiban-tls \
      --set 'ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt-prod' \
      --set backend.settings.allowedHosts=boards.example.com \
      --set backend.settings.corsAllowedOrigins=https://boards.example.com \
      --set backend.settings.frontendUrl=https://boards.example.com \
      --set backend.settings.siteDomain=boards.example.com
    ```

## Deploying without TLS

If TLS is terminated upstream (AWS ALB, Cloudflare, etc.) or you are running in an air-gapped network:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  -f helm/visiban/values.secret.yaml \
  --set ingress.host=boards.internal \
  --set ingress.tls.enabled=false \
  --set backend.settings.forceInsecureCookies=true \
  --set backend.settings.allowedHosts=boards.internal \
  --set backend.settings.corsAllowedOrigins=http://boards.internal \
  --set backend.settings.frontendUrl=http://boards.internal \
  --set backend.settings.siteDomain=boards.internal
```

!!! danger "Insecure cookies"
    `forceInsecureCookies: true` disables `Secure` flags on session and CSRF cookies. Only use this when the entire path from browser to Visiban is within a trusted network, or when an upstream proxy terminates TLS and sets `X-Forwarded-Proto: https`.

## Using a pre-existing Secret

For production clusters, create the Secret externally (e.g. via Sealed Secrets, External Secrets, or Vault) and reference it:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  --set secret.existingSecret=my-visiban-secret \
  --set postgresql.auth.existingSecret=my-visiban-pg-secret \
  ...
```

The chart skips creating its own Secret when `existingSecret` is set. Required keys in the Secret:

| Key | Description |
|---|---|
| `django-secret-key` | Django `SECRET_KEY` |
| `database-url` | Full `postgres://` connection string |
| `google-client-id` | Google OAuth client ID (empty string if unused) |
| `google-client-secret` | Google OAuth client secret (empty string if unused) |
| `github-client-id` | GitHub OAuth client ID (empty string if unused) |
| `github-client-secret` | GitHub OAuth client secret (empty string if unused) |
| `gitlab-client-id` | GitLab OAuth client ID (empty string if unused) |
| `gitlab-client-secret` | GitLab OAuth client secret (empty string if unused) |
| `oidc-client-id` | OIDC client ID (only if OIDC is enabled) |
| `oidc-client-secret` | OIDC client secret (only if OIDC is enabled) |

## External database and Redis

To use an existing PostgreSQL or Redis instance instead of the bundled ones:

```yaml
# values.override.yaml
postgresql:
  enabled: false

externalDatabase:
  host: "db.example.com"
  port: 5432
  database: visiban
  username: visiban
  password: "strong-password"

redis:
  enabled: false

externalRedis:
  url: "redis://redis.example.com:6379/0"
  cacheUrl: "redis://redis.example.com:6379/1"
```

## Network policies

Enable network policies to restrict pod-to-pod traffic to only the paths Visiban needs:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  --set networkPolicy.enabled=true \
  ...
```

This creates policies that allow:

- Ingress controller → frontend (port 80)
- Frontend → backend (port 8000)
- Backend → PostgreSQL (port 5432)
- Backend → Redis (port 6379)

All other ingress to Visiban pods is denied. Requires a CNI plugin that supports `NetworkPolicy` (Calico, Cilium, Weave, etc.).

## Media persistence

User-uploaded attachments are stored on a PersistentVolumeClaim (5 Gi by default):

```yaml
backend:
  mediaPersistence:
    enabled: true
    size: 10Gi
    accessModes:
      - ReadWriteOnce
    # storageClassName: "gp3"
```

If the backend and frontend pods run on **different nodes**, the PVC must support `ReadWriteMany` (RWX) — or use a pod affinity rule to co-locate them.

## Scaling

Increase replicas for the backend or frontend:

```yaml
backendReplicaCount: 3
frontendReplicaCount: 2
```

When `backendReplicaCount > 1`, the chart automatically:

- Creates a **PodDisruptionBudget** (`minAvailable: 1`) so node drains do not take all replicas offline
- Adds **pod anti-affinity** (preferred) to spread replicas across nodes

See the [Scaling guide](../architecture/scaling.md) for component-by-component tuning advice.

## Health check endpoints

The backend exposes two health endpoints used by liveness and readiness probes:

| Endpoint | Purpose | Checks |
|---|---|---|
| `/api/health/liveness/` | Is the process alive? | HTTP 200 if the ASGI server responds |
| `/api/health/readiness/` | Can the process serve traffic? | HTTP 200 if the database and Redis are reachable |

These are also suitable for external load balancer health checks. The readiness probe uses `initialDelaySeconds: 5` and `failureThreshold: 3`, so a pod is removed from the Service within ~35 seconds of a dependency failure.

## Upgrading

```bash
helm upgrade visiban helm/visiban \
  --namespace visiban \
  -f helm/visiban/values.secret.yaml \
  --set backend.image.tag=v1.1.0 \
  --set frontend.image.tag=v1.1.0
```

Init containers run `migrate` before the new backend pod becomes ready, so migrations are applied automatically. See the [Upgrade guide](../administration/upgrade.md) for version-specific notes and rollback procedures.

!!! warning "Always pin the image tag"
    The chart defaults `backend.image.tag` and `frontend.image.tag` to the current release (e.g. `v1.0.0`). **Never deploy with `tag: "latest"` or an empty tag** — pod restarts may silently pull a different image than the one you validated, and rollbacks cannot recover a known-good state. Pin to a specific release tag (`v1.0.0`, `v1.1.0`, etc.), or to an image digest (`sha256:...`) for maximum reproducibility. The chart prints a warning in `helm install` / `helm upgrade` output when it detects an unpinned tag.

## Django admin access

The Django admin panel (`/admin/`) is restricted to loopback at the Nginx layer. Access it via port-forward:

```bash
kubectl port-forward -n visiban svc/visiban-backend 8000:8000
# Then open http://localhost:8000/admin/
```

## Uninstalling

```bash
helm uninstall visiban --namespace visiban
```

This removes all Kubernetes resources created by the chart. **PersistentVolumeClaims are not deleted** — delete them manually if you want to remove all data:

```bash
kubectl delete pvc -n visiban -l app.kubernetes.io/instance=visiban
```
