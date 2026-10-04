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

> A chart signing gap (#1284, fixed after `v1.2.0-alpha.2`) means any chart published at or
> before that tag is unsigned — `cosign verify` against those versions fails with no signature
> found, not a tampering warning. Check `docs/maintainers/known-ci-failures.md` if verification
> fails against a version you expect to be signed.

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

Since 1.2, `backend.email.backend` defaults to `""` (unset) rather than `"smtp"`, so you can leave `backend.email.*` blank and install first — a site admin can then configure SMTP afterward from **Admin → Settings → Email**, without a redeploy. The chart's render-time check for a placeholder `fromAddress` (e.g. `noreply@example.com`) only fires when `backend.email.host` is set, so an install with the whole block blank passes.

Set `backend.email.*` explicitly only if you want env-only email configuration — doing so pins the backend and **disables** the Admin → Settings → Email UI.

- **SMTP:** fill in `host`, `port`, `user`, `password`, and `fromAddress`, and set `backend.email.backend: "smtp"`. Use `backend.email.useSsl` instead of `useTls` for implicit TLS (port 465).
- **Console (no SMTP):** set `backend.email.backend=console` and leave the other fields blank — emails log to stdout.

!!! warning "Never commit `values.secret.yaml`"
    This file is gitignored. Keep secrets out of shell history — always use `-f values.secret.yaml` instead of `--set secret.djangoSecretKey=...`. The `--set` flag leaks values to shell history (`~/.bash_history`), `/proc/*/cmdline`, and process listings visible to other users on the host.

    To generate and insert secrets in one step:

    ```bash
    # Generate djangoSecretKey directly into values.secret.yaml
    DJANGO_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")
    sed -i "s|djangoSecretKey:.*|djangoSecretKey: \"${DJANGO_KEY}\"|" helm/visiban/values.secret.yaml

    # Generate PostgreSQL password
    PG_PASS=$(openssl rand -hex 32)
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
  python -c "import urllib.request as u; print(u.urlopen(u.Request('http://localhost:8000/api/health/readiness/', headers={'Host': '<your host>'})).read().decode())"
```

`<your host>` is the first entry of `backend.settings.allowedHosts` (for example `boards.example.com`). The chart no longer adds `localhost` to `ALLOWED_HOSTS`, so a request that says `Host: localhost` gets HTTP 400. Adding `localhost` (or `*`, `127.0.0.1` and the other catch-all or loopback entries) to `allowedHosts` fails the render unless you also set `backend.settings.allowUnsafeHosts=true`; see [Upgrade notes](../administration/upgrade.md#upgrading-to-12x).

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
  # The chart percent-encodes the username and password when it builds the
  # connection URL, so give them verbatim. (Before this was fixed, a password
  # containing "/" broke the URL; if you percent-encoded yours by hand to work
  # around that, put the plain value back before upgrading, or it is encoded twice.)
  password: "strong-password"

valkey:
  enabled: false

externalRedis:
  url: "redis://valkey.example.com:6379/0"
  cacheUrl: "redis://valkey.example.com:6379/1"
```

### Password for an external Valkey or Redis

If the external instance requires a password, keep it in a Secret rather than
in `externalRedis.url`. The chart renders `url` and `cacheUrl` as plain
environment values, so a password inside them is visible to anyone who can
read the Deployment or run `helm get manifest`.

```bash
kubectl -n <namespace> create secret generic visiban-redis \
  --from-literal=redis-password='<the instance password>'
```

```yaml
valkey:
  enabled: false

externalRedis:
  # No password in either URL. An ACL username may stay:
  # rediss://visiban@valkey.example.com:6380/0
  url: "redis://valkey.example.com:6379/0"
  cacheUrl: "redis://valkey.example.com:6379/1"
  existingSecret: visiban-redis
  # existingSecretPasswordKey: redis-password  # the default
```

The backend reads the password as `REDIS_URL_PASSWORD` and percent-encodes it
into both URLs itself, so it can contain any character, including `/`, `@`,
`:` and `$`. If the URL has a username (a Redis 6+ ACL user, as on most
managed services), the username is kept and the password is added to it.

| Key | Default | Description |
|---|---|---|
| `externalRedis.existingSecret` | empty | Secret holding the external instance's password. Only with `valkey.enabled: false`. |
| `externalRedis.existingSecretPasswordKey` | `redis-password` | Key in that Secret that holds the password. |

The install fails with an explanation if `existingSecret` is set and either
URL also carries a password, because the two would compete. It also fails if
`existingSecret` is set while the bundled Valkey is on, because the setting
would be ignored. The bundled Valkey's password is `valkey.auth.*`; see
[Valkey password](#valkey-password).

**Existing installs keep working unchanged.** With `existingSecret` empty (the
default), a password embedded in `externalRedis.url` is used exactly as before.
To move it into a Secret, create the Secret, then in one `helm upgrade` set
`externalRedis.existingSecret` and remove the password from both URLs. If the
password contains `/`, `@`, `%` or other reserved characters, put the plain
value in the Secret, not the percent-encoded form from your old URL, or it is
encoded twice.

As with the bundled Valkey, changing the password in the Secret does not
restart anything by itself. Run
`kubectl -n <namespace> rollout restart deployment -l app.kubernetes.io/instance=<release>,app.kubernetes.io/component=backend`
after you rotate it. Scheduled jobs pick up the new value on their next run.

## Bundled Valkey

With `valkey.enabled: true` (the default) the chart runs Valkey itself: a
single-replica StatefulSet on the official `valkey/valkey:8-alpine` image, the
same major as `docker-compose.prod.yml`, as a non-root user with a read-only
root filesystem and no Linux capabilities. The backend reaches it at
`<release>-valkey-primary:6379`. See [Pod security](#pod-security) below —
the bundled PostgreSQL and the backend Deployment run with this same
hardening.

Valkey holds only the real-time (Channels) layer and the Django cache, so it
runs without persistence by default. The values it reads:

| Key | Default | Purpose |
|---|---|---|
| `valkey.image.repository` / `valkey.image.tag` | `valkey/valkey` / `8-alpine` | The image. The chart refuses an empty or `latest` tag. |
| `valkey.primary.persistence.enabled` / `.size` / `.storageClass` | `false` / `1Gi` / unset | Keep the append-only file in a PVC across restarts. |
| `valkey.primary.resources` | 100m / 128Mi requests, 150m / 192Mi limits | Container resources. |
| `valkey.commonConfiguration` | AOF on, RDB snapshots off | Extra `valkey.conf` lines. |
| `valkey.auth.enabled` | `false` | Require a password. See [Valkey password](#valkey-password) below. |
| `valkey.auth.password` | empty | Chart-managed password, stored in the `<fullname>-valkey-auth` Secret (`visiban-valkey-auth` for a release named `visiban`, `my-release-visiban-valkey-auth` for `my-release`). |
| `valkey.auth.existingSecret` / `.existingSecretPasswordKey` | empty / `valkey-password` | A Secret you manage instead, and the key that holds the password. |

### Valkey password

By default the bundled Valkey has no password. Access to it is restricted only
by the [network policies](#network-policies) below, and those are off by
default and enforced only by a CNI that implements them. On a shared cluster,
turn password authentication on. (`docker-compose.prod.yml` always runs Valkey
with a password.)

Set `valkey.auth.enabled=true` and **exactly one** password source. The install
fails with an explanation if you set neither or both. The chart does not
generate a password for you, because a generated one would change on every
render under `helm template` and GitOps tools.

=== "Chart-managed password"

    ```bash
    helm upgrade --install visiban helm/visiban -f my-values.yaml \
      --set valkey.auth.enabled=true \
      --set-string valkey.auth.password="$(openssl rand -hex 32)"
    ```

    The chart stores the password in the `<fullname>-valkey-auth` Secret.
    `<fullname>` is the release name when it already contains `visiban`
    (`visiban`, `visiban-prod`), and `<release>-visiban` otherwise
    (`my-release-visiban`), unless `fullnameOverride` is set. The Secret is
    part of the Helm release record like every chart-managed credential.

=== "Your own Secret"

    ```bash
    kubectl -n <namespace> create secret generic visiban-valkey \
      --from-literal=valkey-password="$(openssl rand -hex 32)"
    helm upgrade --install visiban helm/visiban -f my-values.yaml \
      --set valkey.auth.enabled=true \
      --set valkey.auth.existingSecret=visiban-valkey
    ```

    Use `valkey.auth.existingSecretPasswordKey` if the password is under a key
    other than `valkey-password`. This works with or without
    `secret.existingSecret`. The password never passes through Helm.

**Rotating the password.** With either source, a new password does not
restart anything by itself. The chart deliberately adds no checksum
annotation for it, because a hash of the password on a pod could be cracked
offline by anyone who can read pods but not Secrets. After you change the
password (a `helm upgrade` with a new `valkey.auth.password`, or an edit to
your own Secret), restart Valkey and the backend together:

```bash
kubectl -n <namespace> rollout restart statefulset,deployment \
  -l 'app.kubernetes.io/instance=<release>,app.kubernetes.io/component in (valkey,backend)'
```

The label selector matches the Valkey StatefulSet (`<release>-valkey`) and the
backend Deployment (`<fullname>-backend`: `visiban-backend` for a release
named `visiban`, `my-release-visiban-backend` for `my-release`), and nothing
else, whatever the release is called.

Until both restart, the backend cannot reach Valkey, so do this in a quiet
moment. Scheduled jobs pick up the new password on their next run. Turning
auth on or off, or switching between the two sources, changes the pod specs,
so that `helm upgrade` restarts both without this step.

The password can contain any character, including `/`, `@`, `:` and `$`. It never
appears in a ConfigMap, a plain environment value or a URL the chart renders.
Valkey gets it from the Secret as `--requirepass`, and its health probes
authenticate with the same Secret value. The backend reads it into
`REDIS_URL_PASSWORD` and percent-encodes it into `REDIS_URL` and
`REDIS_CACHE_URL` itself. Those two variables keep their password-free values.
If the Secret's value is empty, Valkey refuses to start rather than run
without a password.

To use a password-protected Valkey or Redis outside the cluster instead, see
[Password for an external Valkey or Redis](#password-for-an-external-valkey-or-redis).

!!! note "Chart 0.5.0 replaced the Bitnami subchart"
    Earlier development builds of the 1.2 chart ran Valkey through the Bitnami
    `valkey` subchart, whose default image was the floating
    `bitnami/valkey:latest`. See the
    [upgrade note](../administration/upgrade.md#upgrading-to-12x) for what
    `helm upgrade` does to an existing install.

## Pod security

Every long-running or scheduled workload the chart renders — the backend
Deployment (its `migrate`, `collectstatic` and `bootstrap` init containers
included), the frontend (nginx) Deployment, the bundled PostgreSQL and Valkey
StatefulSets, the [scheduled jobs](#scheduled-jobs) CronJobs, and the demo
seed Job/CronJob — runs:

- as a non-root user (`runAsNonRoot: true`, a numeric `runAsUser`/`runAsGroup`)
- with `seccompProfile: RuntimeDefault`
- with `allowPrivilegeEscalation: false`
- with a read-only root filesystem
- with every Linux capability dropped (`capabilities.drop: [ALL]`)
- with no mounted ServiceAccount token (`automountServiceAccountToken: false`)

Scratch space each image still needs to write — `/tmp` on the backend's four
containers, on PostgreSQL and on the frontend; PostgreSQL's
`/var/run/postgresql` socket directory; the backend's `collectstatic` output
(`STATIC_ROOT`); and nginx's `/var/cache/nginx` (its client/proxy/fastcgi
buffering temp dirs) and `/run` (`nginx.pid`, `nginx.lock`) — is an `emptyDir`
volume, never the read-only root filesystem itself. (The bundled Valkey needs
no `/tmp` mount — it only ever writes to `/data` and `/etc/valkey`, both
already `emptyDir`/`ConfigMap` mounts from #1200.)

The bundled Valkey's hardening (chart 0.5.0, #1200) is fixed. The backend
Deployment's, the bundled PostgreSQL StatefulSet's (chart 0.6.0, #1210), and
the frontend Deployment's (chart 0.7.0, #1224) are overridable:

| Key | Default | Purpose |
|---|---|---|
| `backend.securityContext.pod` | `runAsNonRoot: true`, `runAsUser`/`runAsGroup: 1001`, `seccompProfile: RuntimeDefault` | Pod-level `securityContext` for the backend Deployment. |
| `backend.securityContext.container` | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]` | Container-level `securityContext`, applied to every backend container (init and app). |
| `postgresql.securityContext.pod` | `runAsNonRoot: true`, `runAsUser`/`runAsGroup`/`fsGroup: 999`, `seccompProfile: RuntimeDefault` | Pod-level `securityContext` for the bundled PostgreSQL StatefulSet. Not read when `postgresql.subchartEnabled` is true. |
| `postgresql.securityContext.container` | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]` | Container-level `securityContext` for the `postgresql` container. |
| `frontend.securityContext.pod` | `runAsNonRoot: true`, `runAsUser`/`runAsGroup: 101`, `seccompProfile: RuntimeDefault` | Pod-level `securityContext` for the frontend (nginx) Deployment. `101` is `nginx:1.27-alpine`'s built-in `nginx` user/group. |
| `frontend.securityContext.container` | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]` | Container-level `securityContext` for the `frontend` container. |

All three blocks are passed through with `toYaml`, like `backend.resources` —
the chart does not validate their contents, so an operator running a base
image that cannot run as the chart's numeric UID, or that needs a writable
root filesystem, can override any block wholesale. For example, to run the
bundled PostgreSQL with a writable root filesystem on an image that writes
somewhere this chart does not mount an `emptyDir` for:

```yaml
# values.override.yaml
postgresql:
  securityContext:
    container:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: false
      capabilities:
        drop: ["ALL"]
```

`scripts/helm-structure-check.sh` asserts `runAsNonRoot` and a full capability
drop on every rendered pod, with no exclusions.

!!! note "The frontend container listens on 8080, not 80 (chart 0.7.0)"
    `nginx:1.27-alpine` cannot bind a port below 1024 as the non-root
    `frontend.securityContext.pod.runAsUser` without `CAP_NET_BIND_SERVICE` —
    and that capability is not usable here either: Docker/containerd's
    runc-based container runtimes do not add a capability to an already
    non-root process's effective/ambient set from `capabilities.add` alone
    (verified empirically against `nginx:1.27-alpine`, #1224), so the process
    can never actually use it. The frontend container's own listen port moved
    to 8080 to sidestep this entirely — a non-privileged port needs no
    capability. This does **not** change the frontend **Service**'s port
    (`frontend.service.port`, `80` by default): the Service targets the
    container by its named `http` port, which follows automatically. The one
    place this is user-visible is a `kubectl port-forward <frontend-pod>
    8080:80` run directly against the pod (bypassing the Service) — the NOTES
    printed after `helm install`/`helm upgrade` already reflect the new
    `8080:8080`, but a script or alias built from an older NOTES output needs
    updating.

## Network policies

Enable network policies to restrict pod-to-pod traffic to only the paths Visiban needs:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  --set networkPolicy.enabled=true \
  ...
```

This creates policies that allow:

- Ingress controller → frontend (port 8080 — the frontend container's own
  listen port, #1224; the frontend Service itself still fronts port 80 by
  default)
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

**Watch out:** the policies name allowed clients by `app.kubernetes.io/component`.
If you add a workload that opens a PostgreSQL or Valkey connection, add its
component to the allow-lists at the top of `templates/networkpolicy.yaml` —
otherwise it is denied, and that usually shows up as an install that hangs, not
as an explicit error.

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

## Scheduled jobs

The due-date and staleness notification scans, and the retention prunes, run as
Kubernetes CronJobs rendered from `scheduledJobs` in `values.yaml`. They are
**off by default**, so an install that has not enabled them sends no due-date or
staleness notifications:

```bash
helm upgrade visiban helm/visiban --namespace visiban --reuse-values \
  --set scheduledJobs.enabled=true
```

That schedules `notify_due_soon` (07:00) and `notify_stale_cards` (08:00). The
two prune jobs delete data and are enabled individually. See
[Scheduled Jobs](../administration/scheduled-jobs.md) for every key, and for how
to check and trigger runs.

## Health check endpoints

The backend exposes two health endpoints used by liveness and readiness probes:

| Endpoint | Purpose | Checks |
|---|---|---|
| `/api/health/liveness/` | Is the process alive? | HTTP 200 if the ASGI server responds |
| `/api/health/readiness/` | Can the process serve traffic? | HTTP 200 if the database and Valkey are reachable |

These are also suitable for external load balancer health checks. The readiness probe uses `initialDelaySeconds: 5` and `failureThreshold: 3`, so a pod is removed from the Service within ~35 seconds of a dependency failure.

## Sample data

The chart does not bundle the sample boards. Download them from
[`backend/boards/sample_boards/`](https://gitlab.com/visiban/visiban/-/tree/main/backend/boards/sample_boards) in the
repository and import one from **Dashboard → Import**. See [Sample Boards](sample-boards.md).

## Upgrading

```bash
helm upgrade visiban helm/visiban \
  --namespace visiban \
  -f helm/visiban/values.secret.yaml \
  --set backend.image.tag=v1.2.0-alpha.4 \
  --set frontend.image.tag=v1.2.0-alpha.4
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
# (send the real Host header; a `localhost` entry in backend.settings.allowedHosts
#  also needs backend.settings.allowUnsafeHosts=true, the chart no longer adds it)
```

**IP allowlist** — for persistent access from a bastion or VPN host, set `backend.settings.adminAllowedIPs` to a comma-separated list of IPs and/or CIDR ranges:

```bash
helm upgrade visiban helm/visiban --reuse-values \
  --set backend.settings.adminAllowedIPs="10.0.0.0/8,192.168.42.7"
```

The allowlist is enforced by both the frontend Nginx config and the Django `AdminIPRestrictionMiddleware` for defense in depth.

Both Nginx and the Django middleware accept CIDR ranges (e.g. `10.0.0.0/8`) as well as individual IPs for this value. See [Secret Rotation](../administration/secret-rotation.md#helm).

## Uninstalling

```bash
helm uninstall visiban --namespace visiban
```

This removes all Kubernetes resources created by the chart — the chart declares no Helm install hooks, and hook resources are the ones Helm would leave behind. **PersistentVolumeClaims are not deleted** — delete them manually if you want to remove all data:

```bash
kubectl delete pvc -n visiban -l app.kubernetes.io/instance=visiban
```
