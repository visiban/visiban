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

### 1. Get the chart

Since 1.2 the chart is published as a signed OCI artifact, so a clone is only
needed if you want to modify it:

```bash
# Verify the signature first (optional but recommended)
cosign verify ghcr.io/visiban/charts/visiban:<version> \
  --certificate-identity-regexp 'gitlab\.com/visiban/visiban' \
  --certificate-oidc-issuer https://gitlab.com

helm show values oci://ghcr.io/visiban/charts/visiban
```

Every `helm install helm/visiban` below also works as
`helm install oci://ghcr.io/visiban/charts/visiban`.

To work from a checkout instead:

```bash
git clone https://github.com/visiban/visiban.git
cd visiban
helm dependency update helm/visiban
```

!!! tip "Start from an overlay"
    `helm/visiban/values-dev.yaml` and `helm/visiban/values-prod.yaml` carry the
    evaluation and production shapes respectively, and both are linted in CI.
    Pass one with `-f` rather than assembling a dozen `--set` flags by hand.

### 2. Create a secrets file

```bash
cp helm/visiban/values.secret.yaml.example helm/visiban/values.secret.yaml
```

Edit `values.secret.yaml` with strong random values:

```yaml
secret:
  djangoSecretKey: ""  # python3 -c "import secrets; print(secrets.token_hex(50))"

postgresql:
  auth:
    password: ""  # strong random password

backend:
  email:
    host: "smtp.yourprovider.com"
    port: 587
    user: "smtp-username"
    password: ""           # SMTP password
    fromAddress: "noreply@yourdomain.com"
    useTls: true
```

The `backend.email.*` block is required when sending password-reset and email-verification messages. To skip SMTP entirely (logs emails to stdout), set `backend.email.backend=console` and leave the other fields blank.

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

That single command is all a fresh install needs — including the bundled
PostgreSQL, which the chart creates and waits for as part of the same release.

Three init containers run in order inside each backend pod, before its
application container starts:

1. **migrate** — applies database migrations. It waits for the database to accept
   connections, then takes a PostgreSQL advisory lock so that concurrent replicas
   apply migrations one at a time; a replica that loses the race waits for the
   winner rather than starting against a half-migrated schema. Inspect with
   `kubectl logs -n visiban deploy/visiban-backend -c migrate`.
2. **collectstatic** — bundles Django static assets.
3. **bootstrap** (first install only) — creates the initial admin account.

!!! info "Tuning the migrate waits"
    `backend.migrate.connectTimeout` (default 300s) bounds the wait for the
    database to come up, and `backend.migrate.lockTimeout` (default 900s) bounds
    the wait for another replica's migration. Raise the second one if your
    migrations legitimately take longer than that to apply. Both fail with a
    named error rather than hanging.

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
helm test visiban --namespace visiban --logs
```

`helm test` is the chart's own end-to-end probe. It checks, in order, the
backend's liveness endpoint, its readiness endpoint, that same readiness
endpoint *through the frontend's nginx*, and the SPA itself. Each step
distinguishes a different failure:

| Step fails | What it means |
|---|---|
| liveness | The backend container is not running — check the init containers |
| readiness | It runs but cannot reach PostgreSQL or Valkey |
| through nginx | The frontend cannot resolve its backend upstream |
| SPA | nginx proxies correctly but serves no bundle |

CI runs this identical hook (`helm-install`), so your install and the pipeline
verify the same invariant.

Lower-level checks, if you need them:

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

## External database and Valkey

To use an existing PostgreSQL or Valkey (or Redis-compatible) instance instead of the bundled ones:

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

valkey:
  enabled: false

externalRedis:
  url: "redis://valkey.example.com:6379/0"
  cacheUrl: "redis://valkey.example.com:6379/1"
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
- Frontend (and the `helm test` probe) → backend (port 8000)
- Backend → PostgreSQL (port 5432)
- Backend → Valkey (port 6379)

The backend entry covers migrations too: they run as an init container of the
backend pod and so carry the backend pod's labels.

All other ingress to Visiban pods is denied.

!!! warning "Your CNI must *enforce* NetworkPolicy, not just accept it"
    Requires Calico, Cilium, or a managed equivalent. A CNI that does not
    implement NetworkPolicy — including **kind's default `kindnetd`** — will
    admit these objects, list them under `kubectl get netpol`, and then ignore
    them completely. There is no warning and no error. A clean install on such a
    cluster is not evidence that the policies work.

    Confirm enforcement rather than assuming it: run a pod with no Visiban
    labels and check that it cannot reach the database.

    ```bash
    kubectl run netpol-probe -n visiban --rm -i --restart=Never \
      --image=busybox:1.36 -- nc -z -w 5 visiban-postgresql 5432
    ```

    This must **fail**. If it succeeds, your policies are not being enforced.

The policies name their allowed clients by `app.kubernetes.io/component`. If you
add a workload that opens a PostgreSQL or Valkey connection, add its component to
the allow-lists at the top of `templates/networkpolicy.yaml` — otherwise it is
denied, and that usually presents as an install that hangs rather than as an
error.

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
| `/api/health/readiness/` | Can the process serve traffic? | HTTP 200 if the database and Valkey are reachable |

These are also suitable for external load balancer health checks. The readiness probe uses `initialDelaySeconds: 5` and `failureThreshold: 3`, so a pod is removed from the Service within ~35 seconds of a dependency failure.

## Upgrading

```bash
helm upgrade visiban helm/visiban \
  --namespace visiban \
  -f helm/visiban/values.secret.yaml \
  --set backend.image.tag=v1.1.0 \
  --set frontend.image.tag=v1.1.0
```

Each new backend pod runs the `migrate` init container before its application container starts, so migrations are applied automatically and no pod serves traffic against a schema it has not migrated. See the [Upgrade guide](../administration/upgrade.md) for version-specific notes and rollback procedures.

!!! note "Rotating `secret.djangoSecretKey` in-flight"
    A `--set-string secret.djangoSecretKey=...` override applied during `helm upgrade` takes effect for that same upgrade. The backend pod template carries a checksum over the chart-managed Secret, so rotating any value in it replaces the running pods — which is what puts the new key in front of both the application and the `migrate` init container. Chart versions before 1.2 used a hook-managed bootstrap Secret to achieve the same thing for a separate migrate Job; that Job and that Secret are gone.

!!! warning "Always pin the image tag"
    The chart defaults `backend.image.tag` and `frontend.image.tag` to the current release (e.g. `v1.0.0`). **Never deploy with `tag: "latest"` or an empty tag** — pod restarts may silently pull a different image than the one you validated, and rollbacks cannot recover a known-good state. Pin to a specific release tag (`v1.0.0`, `v1.1.0`, etc.), or to an image digest (`sha256:...`) for maximum reproducibility. The chart prints a warning in `helm install` / `helm upgrade` output when it detects an unpinned tag.

## Django admin access

The Django admin panel (`/admin/`) is restricted to loopback at both the Nginx and Django layers. Two access patterns:

**Port-forward (default)** — for occasional access from a single workstation:

```bash
kubectl port-forward -n visiban svc/visiban-backend 8000:8000
# Then open http://localhost:8000/admin/
```

**IP allowlist** — for persistent access from a bastion or VPN range, set `backend.settings.adminAllowedIPs` to a comma-separated list of CIDRs:

```bash
helm upgrade visiban helm/visiban --reuse-values \
  --set backend.settings.adminAllowedIPs="10.0.0.0/8,192.168.42.0/24"
```

The allowlist is enforced by both the frontend Nginx config and the Django `AdminAllowedIPsMiddleware` for defense in depth.

## Uninstalling

```bash
helm uninstall visiban --namespace visiban
```

This removes all Kubernetes resources created by the chart — the chart declares no Helm install hooks, and hook resources are the ones Helm would leave behind. **PersistentVolumeClaims are not deleted** — delete them manually if you want to remove all data:

```bash
kubectl delete pvc -n visiban -l app.kubernetes.io/instance=visiban
```
