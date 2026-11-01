# Run Visiban on Kubernetes with one Helm command

One `helm install` brings up Visiban with its bundled PostgreSQL and Valkey. Then `helm test` proves the install end to end.

**Why it matters:** The chart runs migrations safely across replicas, hardens every pod by default, and ships as a signed OCI artifact. You don't have to assemble any of that yourself.

!!! tip "Single server? Use Docker Compose"
    If you are deploying to a single server, the [Docker Compose installation](installation.md) is simpler. This page is for Kubernetes clusters.

**The big picture:**

- **Five steps:** get the chart, write a secrets file, install, retrieve the admin password, and verify.
- **Then tune:** TLS, external databases, Valkey auth, network policies, scaling, and scheduled jobs.

<a id="prerequisites"></a>

**You need:**

| Requirement | Minimum version |
|---|---|
| Kubernetes cluster | 1.25+ |
| Helm | 3.12+ |
| kubectl | configured for your cluster |
| Ingress controller | nginx-ingress-controller recommended |
| cert-manager (optional) | 1.12+, for automatic TLS certificates |
| CNI with NetworkPolicy support (optional) | Calico, Cilium, etc., for network isolation |

## Quick start

### 1. Get the chart

Since 1.2, the chart is published as a signed OCI artifact. You only need a clone if you want to modify it.

```bash
# Verify the signature first (optional but recommended)
cosign verify ghcr.io/visiban/charts/visiban:<chart-version> \
  --certificate-identity-regexp '^https://gitlab\.com/visiban/visiban//\.gitlab-ci\.yml@refs/tags/v[0-9][^/]*$' \
  --certificate-oidc-issuer https://gitlab.com

helm show values oci://ghcr.io/visiban/charts/visiban
```

**The images are signed too.** The `backend` and `frontend` images the chart pulls are signed, and *(since 1.2)* each platform image carries a CycloneDX SBOM attestation. [Verifying release images and the Helm chart](../administration/image-verification.md) has the image and SBOM verification commands, and lists which older releases are unsigned.

**Yes, but: older charts are unsigned.** A chart signing gap (#1284, fixed after `v1.2.0-alpha.2`) means any chart published at or before that tag has no signature. `cosign verify` against those versions fails with "no signature found", not a tampering warning. If verification fails against a version you expect to be signed, check `docs/maintainers/known-ci-failures.md`.

**Every `helm install helm/visiban` below also works as `helm install oci://ghcr.io/visiban/charts/visiban`.** To work from a checkout instead:

```bash
git clone https://github.com/visiban/visiban.git
cd visiban
```

!!! tip "Start from an overlay"
    `helm/visiban/values-dev.yaml` and `helm/visiban/values-prod.yaml` carry the evaluation and production shapes, and CI lints both. Pass one with `-f` instead of assembling a dozen `--set` flags by hand.

### 2. Create a secrets file

```bash
cp helm/visiban/values.secret.yaml.example helm/visiban/values.secret.yaml
```

Fill `values.secret.yaml` with strong random values:

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

**Email can wait.** Since 1.2, `backend.email.backend` defaults to `""` (unset) instead of `"smtp"`. You can leave `backend.email.*` blank and install first. A site admin can then configure SMTP from **Admin → Settings → Email**, with no redeploy. The chart's render-time check for a placeholder `fromAddress` (for example `noreply@example.com`) fires only when `backend.email.host` is set, so an install with the whole block blank passes.

**Watch out: setting `backend.email.backend` locks the UI.** Set it only if you want env-only email configuration. Doing so pins the backend and **disables** the Admin → Settings → Email UI. Filling in `host`, `user`, and `password` alone doesn't pin it.

- **SMTP:** fill in `host`, `port`, `user`, `password`, and `fromAddress`. With `backend.email.backend` left empty, the password still reaches the backend and **Admin → Settings → Email** stays available. Set `backend.email.backend: "smtp"` to pin env-only configuration instead. For implicit TLS (port 465), use `backend.email.useSsl` instead of `useTls`.
- **Console (no SMTP):** set `backend.email.backend=console` and leave the other fields blank. Emails go to stdout.

!!! warning "Never commit `values.secret.yaml`"
    The file is gitignored. Keep secrets out of shell history: always use `-f values.secret.yaml`, never `--set secret.djangoSecretKey=...`. The `--set` flag leaks values to shell history (`~/.bash_history`), `/proc/*/cmdline`, and process listings visible to other users on the host.

    To generate and insert secrets in one step:

    ```bash
    # Generate djangoSecretKey directly into values.secret.yaml
    DJANGO_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")
    sed -i "s|djangoSecretKey:.*|djangoSecretKey: \"${DJANGO_KEY}\"|" helm/visiban/values.secret.yaml

    # Generate PostgreSQL password
    PG_PASS=$(openssl rand -hex 32)
    sed -i "s|password:.*# strong random password|password: \"${PG_PASS}\"  # strong random password|" helm/visiban/values.secret.yaml
    ```

    For production clusters, use a secrets manager (Sealed Secrets, External Secrets Operator, or Vault) and reference an `existingSecret`. See [Using a pre-existing Secret](#using-a-pre-existing-secret).

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

That single command is all a fresh install needs, including the bundled PostgreSQL. The chart creates it and waits for it as part of the same release.

**How it works:** three init containers run in order inside each backend pod, before the application container starts:

1. **migrate** applies database migrations. It waits for the database to accept connections, then takes a PostgreSQL advisory lock so concurrent replicas migrate one at a time. A replica that loses the race waits for the winner instead of starting against a half-migrated schema. Inspect it with `kubectl logs -n visiban deploy/visiban-backend -c migrate`.
2. **collectstatic** bundles Django static assets.
3. **bootstrap** (first install only) creates the initial admin account.

!!! note "Tuning the migrate waits"
    `backend.migrate.connectTimeout` (default 300s) bounds the wait for the database to come up. `backend.migrate.lockTimeout` (default 900s) bounds the wait for another replica's migration; raise it if your migrations legitimately take longer than that. Both fail with a named error instead of hanging.

### 4. Retrieve the admin password

```bash
kubectl exec -n visiban deploy/visiban-backend -- \
  cat /run/visiban/admin_password
```

The password is generated once and written to an emptyDir volume. Copy it, then log in at `https://boards.example.com/` as `admin`.

!!! note
    Change this password immediately after first login. See [First boot](first-boot.md).

### 5. Verify

```bash
helm test visiban --namespace visiban --logs
```

**How it works:** `helm test` is the chart's own end-to-end probe. In order, it checks the backend's liveness endpoint, its readiness endpoint, that same readiness endpoint *through the frontend's nginx*, and the SPA itself. Each step points to a different failure:

| Step fails | What it means |
|---|---|
| liveness | The backend container isn't running; check the init containers |
| readiness | It runs but can't reach PostgreSQL or Valkey |
| through nginx | The frontend can't resolve its backend upstream |
| SPA | nginx proxies correctly but serves no bundle |

CI runs this same hook (`helm-install`), so your install and the pipeline verify the same thing.

Lower-level checks, if you need them:

```bash
# Pods should be Running
kubectl get pods -n visiban

# Backend health check
kubectl exec -n visiban deploy/visiban-backend -- \
  python -c "import urllib.request as u; print(u.urlopen(u.Request('http://localhost:8000/api/health/readiness/', headers={'Host': '<your host>'})).read().decode())"
```

**Watch out:** `<your host>` is the first entry of `backend.settings.allowedHosts` (for example `boards.example.com`). The chart no longer adds `localhost` to `ALLOWED_HOSTS`, so a request that says `Host: localhost` gets HTTP 400. Adding `localhost` (or `*`, `127.0.0.1`, and the other catch-all or loopback entries) to `allowedHosts` fails the render unless you also set `backend.settings.allowUnsafeHosts=true`. See [Upgrade notes](../administration/upgrade.md#upgrading-to-12x).

## TLS with cert-manager

To get automatic Let's Encrypt certificates:

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

2. Turn on TLS in your Helm install:

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

Use this when TLS terminates upstream (AWS ALB, Cloudflare, etc.) or the cluster is air-gapped:

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

**Watch out: WebSockets and the Content-Security-Policy.** On Helm installs, the frontend's CSP names `ingress.host` for WebSocket connections: `wss://`, plus `ws://` when `ingress.tls.enabled` is `false`. Nothing is added when the ingress is disabled or no host is set. Then WebSocket connections rely on `'self'`, as does reaching the app through a different host name or `kubectl port-forward`. Set `ingress.host` if your browser doesn't map `'self'` to `ws`/`wss`. The frame policy is `X-Frame-Options: DENY` and the referrer policy is `Referrer-Policy: same-origin`, matching the Compose templates.

!!! danger "Insecure cookies"
    `forceInsecureCookies: true` removes the `Secure` flag from session and CSRF cookies. Use it only when the whole path from browser to Visiban is inside a trusted network, or when an upstream proxy terminates TLS and sets `X-Forwarded-Proto: https`.

## Using a pre-existing Secret

For production clusters, create the Secret outside the chart (for example with Sealed Secrets, External Secrets, or Vault) and reference it:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  --set secret.existingSecret=my-visiban-secret \
  --set postgresql.auth.existingSecret=my-visiban-pg-secret \
  ...
```

!!! note "`postgresql.auth.existingSecret` supplies the backend's database password too"
    With `postgresql.auth.existingSecret`, the bundled PostgreSQL starts with the `password` key of that Secret, and the backend reads the same key into `DATABASE_URL_PASSWORD`. The chart then renders `database-url` without a password, and the backend percent-encodes the password into it, so the password can contain any character and `postgresql.auth.password` is not used. If you also set `secret.existingSecret`, its `database-url` key is used as is and must carry the password itself (`postgres://<user>:<url-encoded-password>@<release>-postgresql:5432/<database>`); the chart then does not set `DATABASE_URL_PASSWORD`.

The chart skips creating its own Secret when `existingSecret` is set. The Secret needs these keys:

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
| `email-password` | SMTP password (only if `backend.email.host` is set or `backend.email.backend` is `smtp`, and `backend.email.existingSecret` is empty) |

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

Keep the instance's password in a Secret, not in `externalRedis.url`.

**Why it matters:** The chart renders `url` and `cacheUrl` as plain environment values. A password inside them is visible to anyone who can read the Deployment or run `helm get manifest`.

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

**How it works:** The backend reads the password as `REDIS_URL_PASSWORD` and percent-encodes it into both URLs itself, so it can contain any character, including `/`, `@`, `:`, and `$`. If the URL has a username (a Redis 6+ ACL user, as on most managed services), the username is kept and the password is added to it.

| Key | Default | Description |
|---|---|---|
| `externalRedis.existingSecret` | empty | Secret holding the external instance's password. Only with `valkey.enabled: false`. |
| `externalRedis.existingSecretPasswordKey` | `redis-password` | Key in that Secret that holds the password. |

**Guardrails:** The install fails with an explanation if `existingSecret` is set and either URL also carries a password, because the two would compete. It also fails if `existingSecret` is set while the bundled Valkey is on, because the setting would be ignored. The bundled Valkey's password is `valkey.auth.*`; see [Valkey password](#valkey-password).

**Existing installs keep working unchanged.** With `existingSecret` empty (the default), a password embedded in `externalRedis.url` is used exactly as before. To move it into a Secret, create the Secret, then in one `helm upgrade` set `externalRedis.existingSecret` and remove the password from both URLs. If the password contains `/`, `@`, `%`, or other reserved characters, put the plain value in the Secret, not the percent-encoded form from your old URL, or it is encoded twice.

**Rotating it:** As with the bundled Valkey, changing the password in the Secret restarts nothing by itself. After you rotate it, run `kubectl -n <namespace> rollout restart deployment -l app.kubernetes.io/instance=<release>,app.kubernetes.io/component=backend`. Scheduled jobs pick up the new value on their next run.

## Bundled Valkey

With `valkey.enabled: true` (the default), the chart runs Valkey itself.

**How it works:** It's a single-replica StatefulSet on the official `valkey/valkey:8-alpine` image, the same major as `docker-compose.prod.yml`. It runs as a non-root user with a read-only root filesystem and no Linux capabilities. The backend reaches it at `<release>-valkey-primary:6379`. The bundled PostgreSQL and the backend Deployment get the same hardening; see [Pod security](#pod-security).

**Why there's no persistence by default:** Valkey holds only the real-time (Channels) layer and the Django cache. The values it reads:

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

**Turn on Valkey auth on a shared cluster.** By default the bundled Valkey has no password.

**Why it matters:** The only thing restricting access is the [network policies](#network-policies) below. Those are off by default, and only a CNI that implements them enforces them. (`docker-compose.prod.yml` always runs Valkey with a password.)

**How it works:** Set `valkey.auth.enabled=true` and **exactly one** password source. The install fails with an explanation if you set neither or both. The chart doesn't generate a password for you, because a generated one would change on every render under `helm template` and GitOps tools.

=== "Chart-managed password"

    ```bash
    helm upgrade --install visiban helm/visiban -f my-values.yaml \
      --set valkey.auth.enabled=true \
      --set-string valkey.auth.password="$(openssl rand -hex 32)"
    ```

    The chart stores the password in the `<fullname>-valkey-auth` Secret. `<fullname>` is the release name when it already contains `visiban` (`visiban`, `visiban-prod`), and `<release>-visiban` otherwise (`my-release-visiban`), unless `fullnameOverride` is set. The Secret is part of the Helm release record, like every chart-managed credential.

=== "Your own Secret"

    ```bash
    kubectl -n <namespace> create secret generic visiban-valkey \
      --from-literal=valkey-password="$(openssl rand -hex 32)"
    helm upgrade --install visiban helm/visiban -f my-values.yaml \
      --set valkey.auth.enabled=true \
      --set valkey.auth.existingSecret=visiban-valkey
    ```

    Use `valkey.auth.existingSecretPasswordKey` if the password is under a key other than `valkey-password`. This works with or without `secret.existingSecret`. The password never passes through Helm.



**Rotating the password restarts nothing by itself,** with either source. The chart deliberately adds no checksum annotation for it: a hash of the password on a pod could be cracked offline by anyone who can read pods but not Secrets. After you change the password (a `helm upgrade` with a new `valkey.auth.password`, or an edit to your own Secret), restart Valkey and the backend together:

```bash
kubectl -n <namespace> rollout restart statefulset,deployment \
  -l 'app.kubernetes.io/instance=<release>,app.kubernetes.io/component in (valkey,backend)'
```

That label selector matches the Valkey StatefulSet (`<release>-valkey`) and the backend Deployment (`<fullname>-backend`: `visiban-backend` for a release named `visiban`, `my-release-visiban-backend` for `my-release`), and nothing else, whatever the release is called.

**Watch out:** Until both restart, the backend can't reach Valkey, so do this at a quiet moment. Scheduled jobs pick up the new password on their next run. Turning auth on or off, or switching between the two sources, changes the pod specs, so that `helm upgrade` restarts both without this step.

**Where the password goes:** It can contain any character, including `/`, `@`, `:`, and `$`. It never appears in a ConfigMap, a plain environment value, or a URL the chart renders. Valkey gets it from the Secret as `--requirepass`, and its health probes authenticate with the same Secret value. The backend reads it into `REDIS_URL_PASSWORD` and percent-encodes it into `REDIS_URL` and `REDIS_CACHE_URL` itself; those two variables keep their password-free values. If the Secret's value is empty, Valkey refuses to start rather than run without a password.

For a password-protected Valkey or Redis outside the cluster, see [Password for an external Valkey or Redis](#password-for-an-external-valkey-or-redis).

!!! note "Chart 0.5.0 replaced the Bitnami subchart"
    Earlier development builds of the 1.2 chart ran Valkey through the Bitnami `valkey` subchart, whose default image was the floating `bitnami/valkey:latest`. See the [upgrade note](../administration/upgrade.md#upgrading-to-12x) for what `helm upgrade` does to an existing install.

## Pod security

Every pod the chart renders runs non-root, read-only, and with no capabilities. That covers every long-running or scheduled workload:

- the backend Deployment, including its `migrate`, `collectstatic`, and `bootstrap` init containers
- the frontend (nginx) Deployment
- the bundled PostgreSQL and Valkey StatefulSets
- the [scheduled jobs](#scheduled-jobs) CronJobs
- the demo seed Job/CronJob

Each of them runs:

- as a non-root user (`runAsNonRoot: true`, a numeric `runAsUser`/`runAsGroup`)
- with `seccompProfile: RuntimeDefault`
- with `allowPrivilegeEscalation: false`
- with a read-only root filesystem
- with every Linux capability dropped (`capabilities.drop: [ALL]`)
- with no mounted ServiceAccount token (`automountServiceAccountToken: false`)

**Scratch space is `emptyDir`, never the root filesystem.** That covers:

- `/tmp` on the backend's four containers, on PostgreSQL, and on the frontend
- PostgreSQL's `/var/run/postgresql` socket directory
- the backend's `collectstatic` output (`STATIC_ROOT`)
- nginx's `/var/cache/nginx` (its client, proxy, and fastcgi buffering temp dirs) and `/run` (`nginx.pid`, `nginx.lock`)

The bundled Valkey needs no `/tmp` mount. It only ever writes to `/data` and `/etc/valkey`, which are already `emptyDir`/`ConfigMap` mounts from #1200.

**What you can override:** The bundled Valkey's hardening (chart 0.5.0, #1200) is fixed. You can override the backend Deployment's, the bundled PostgreSQL StatefulSet's (chart 0.6.0, #1210), and the frontend Deployment's (chart 0.7.0, #1224):

| Key | Default | Purpose |
|---|---|---|
| `backend.securityContext.pod` | `runAsNonRoot: true`, `runAsUser`/`runAsGroup: 1001`, `seccompProfile: RuntimeDefault` | Pod-level `securityContext` for the backend Deployment. |
| `backend.securityContext.container` | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]` | Container-level `securityContext`, applied to every backend container (init and app). |
| `postgresql.securityContext.pod` | `runAsNonRoot: true`, `runAsUser`/`runAsGroup`/`fsGroup: 999`, `seccompProfile: RuntimeDefault` | Pod-level `securityContext` for the bundled PostgreSQL StatefulSet. |
| `postgresql.securityContext.container` | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]` | Container-level `securityContext` for the `postgresql` container. |
| `frontend.securityContext.pod` | `runAsNonRoot: true`, `runAsUser`/`runAsGroup: 101`, `seccompProfile: RuntimeDefault` | Pod-level `securityContext` for the frontend (nginx) Deployment. `101` is `nginx:1.27-alpine`'s built-in `nginx` user and group. |
| `frontend.securityContext.container` | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]` | Container-level `securityContext` for the `frontend` container. |

**Yes, but: the chart doesn't validate these blocks.** All three are passed through with `toYaml`, like `backend.resources`. You can override any block wholesale, for example if your base image can't run as the chart's numeric UID or needs a writable root filesystem. To run the bundled PostgreSQL with a writable root filesystem, on an image that writes somewhere this chart doesn't mount an `emptyDir`:

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

`scripts/helm-structure-check.sh` asserts `runAsNonRoot` and a full capability drop on every rendered pod, with no exclusions.

!!! note "The frontend container listens on 8080, not 80 (chart 0.7.0)"
    The published frontend image now runs as the non-root `nginx` user (uid 101) and listens on 8080 by itself (#1528), so it needs no chart overrides.

    - **Direct `docker run` users** must publish `-p 80:8080`.
    - **The production Compose file is unaffected.** Its `frontend-build` job only copies the static files into a volume that the stock `nginx` service serves on 80/443.
    - **The frontend Service's port is unchanged** (`frontend.service.port`, `80` by default). The Service targets the container by its named `http` port, which follows automatically.
    - **The one visible change:** a `kubectl port-forward <frontend-pod> 8080:80` run directly against the pod, bypassing the Service. The NOTES printed after `helm install`/`helm upgrade` already show the new `8080:8080`, but a script or alias built from older NOTES output needs updating.

    **Why 8080:** `nginx:1.27-alpine` can't bind a port below 1024 as the non-root `frontend.securityContext.pod.runAsUser` without `CAP_NET_BIND_SERVICE`. That capability doesn't help either. Docker's and containerd's runc-based runtimes don't add a capability to an already non-root process's effective or ambient set from `capabilities.add` alone, so the process can never use it (verified empirically against `nginx:1.27-alpine`, #1224). Moving to an unprivileged port needs no capability at all.

## Network policies

Turn on network policies to restrict pod-to-pod traffic to only the paths Visiban needs:

```bash
helm install visiban helm/visiban \
  --namespace visiban --create-namespace \
  --set networkPolicy.enabled=true \
  ...
```

**What's allowed:**

- Ingress controller → frontend (port 8080, the frontend container's own listen port, #1224; the frontend Service itself still fronts port 80 by default)
- Frontend (and the `helm test` probe) → backend (port 8000)
- Backend → PostgreSQL (port 5432)
- Backend → Valkey (port 6379)

The backend entry covers migrations too, because they run as an init container of the backend pod and carry its labels. All other ingress to Visiban pods is denied.

!!! warning "Your CNI must *enforce* NetworkPolicy, not just accept it"
    You need Calico, Cilium, or a managed equivalent. A CNI that doesn't implement NetworkPolicy (including **kind's default `kindnetd`**) admits these objects, lists them under `kubectl get netpol`, and then ignores them completely. There's no warning and no error. A clean install on such a cluster is not evidence the policies work.

    Confirm enforcement instead of assuming it: run a pod with no Visiban labels and check that it can't reach the database.

    ```bash
    kubectl run netpol-probe -n visiban --rm -i --restart=Never \
      --image=busybox:1.36 -- nc -z -w 5 visiban-postgresql 5432
    ```

    This must **fail**. If it succeeds, your policies aren't being enforced.

**Watch out: new workloads are denied by default.** The policies name allowed clients by `app.kubernetes.io/component`. If you add a workload that opens a PostgreSQL or Valkey connection, add its component to the allow-lists at the top of `templates/networkpolicy.yaml`. Otherwise it's denied, and that usually shows up as an install that hangs, not as an explicit error.

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

**Watch out:** If the backend and frontend pods run on **different nodes**, the PVC must support `ReadWriteMany` (RWX), or use a pod affinity rule to put them on the same node.

## Scaling

Raise replicas for the backend or frontend:

```yaml
backendReplicaCount: 3
frontendReplicaCount: 2
```

When `backendReplicaCount > 1`, the chart automatically:

- creates a **PodDisruptionBudget** (`minAvailable: 1`) so node drains don't take all replicas offline
- adds **pod anti-affinity** (preferred) to spread replicas across nodes

**Go deeper:** The [Scaling guide](../architecture/scaling.md) has component-by-component tuning advice.

## Scheduled jobs

**Off by default.** An install that hasn't turned them on sends no due-date or staleness notifications.

**How it works:** The due-date and staleness notification scans, and the retention prunes, run as Kubernetes CronJobs rendered from `scheduledJobs` in `values.yaml`. Turn them on:

```bash
helm upgrade visiban helm/visiban --namespace visiban --reuse-values \
  --set scheduledJobs.enabled=true
```

That schedules `notify_due_soon` (07:00) and `notify_stale_cards` (08:00). The two prune jobs delete data, so you turn each on individually. [Scheduled Jobs](../administration/scheduled-jobs.md) covers every key, and how to check and trigger runs.

## Health check endpoints

The backend exposes two health endpoints for liveness and readiness probes:

| Endpoint | Purpose | Checks |
|---|---|---|
| `/api/health/liveness/` | Is the process alive? | HTTP 200 if the ASGI server responds |
| `/api/health/readiness/` | Can the process serve traffic? | HTTP 200 if the database and Valkey are reachable |

They also work for external load balancer health checks. The readiness probe uses `initialDelaySeconds: 5` and `failureThreshold: 3`, so a pod leaves the Service within about 35 seconds of a dependency failure.

## Sample data

The backend image ships the sample board JSON files. Import one with **Import** on the dashboard → **Start from a sample**. To import a file by hand, download it from [`backend/boards/sample_boards/`](https://gitlab.com/visiban/visiban/-/tree/main/backend/boards/sample_boards) and use **Dashboard → Import**. See [Sample boards](sample-boards.md).

## Upgrading

```bash
helm upgrade visiban helm/visiban \
  --namespace visiban \
  -f helm/visiban/values.secret.yaml \
  --set backend.image.tag=v1.2.0 \
  --set frontend.image.tag=v1.2.0
```

**How it works:** Each new backend pod runs the `migrate` init container before its application container starts. So migrations apply automatically, and no pod serves traffic against a schema it hasn't migrated. The [Upgrade guide](../administration/upgrade.md) has version-specific notes and rollback procedures.

!!! warning "Always pin the image tag"
    The chart defaults `backend.image.tag` and `frontend.image.tag` to the current release (for example `v1.0.0`). **Never deploy with `tag: "latest"` or an empty tag.** Pod restarts may silently pull a different image than the one you validated, and a rollback can't recover a known-good state. Pin a specific release tag (`v1.0.0`, `v1.1.0`, etc.), or an image digest (`sha256:...`) for maximum reproducibility. The chart prints a warning in `helm install`/`helm upgrade` output when it detects an unpinned tag.

!!! note "Rotating `secret.djangoSecretKey` in flight"
    A `--set-string secret.djangoSecretKey=...` override during `helm upgrade` takes effect in that same upgrade. The backend pod template carries a checksum over the chart-managed Secret, so rotating any value in it replaces the running pods. That's what puts the new key in front of both the application and the `migrate` init container. Chart versions before 1.2 used a hook-managed bootstrap Secret to do the same for a separate migrate Job; that Job and that Secret are gone.

## Django admin access

The Django admin panel (`/admin/`) is restricted to loopback at both the nginx and Django layers. There are two ways in.

**Port-forward (default):** for occasional access from one workstation.

```bash
kubectl port-forward -n visiban svc/visiban-backend 8000:8000
# Then open http://localhost:8000/admin/
# (send the real Host header; a `localhost` entry in backend.settings.allowedHosts
#  also needs backend.settings.allowUnsafeHosts=true, the chart no longer adds it)
```

**IP allowlist:** for persistent access from a bastion or VPN host. Set `backend.settings.adminAllowedIPs` to a comma-separated list of IPs and/or CIDR ranges:

```bash
helm upgrade visiban helm/visiban --reuse-values \
  --set backend.settings.adminAllowedIPs="10.0.0.0/8,192.168.42.7"
```

**How it works:** Both the frontend nginx config and Django's `AdminIPRestrictionMiddleware` enforce the allowlist, for defense in depth. Both accept CIDR ranges (for example `10.0.0.0/8`) as well as individual IPs. See [Secret Rotation](../administration/secret-rotation.md#helm).

## Uninstalling

```bash
helm uninstall visiban --namespace visiban
```

**What's removed:** every Kubernetes resource the chart created. The chart declares no Helm install hooks, and hook resources are the ones Helm would leave behind.

**Yes, but: PersistentVolumeClaims stay.** Delete them by hand to remove all data:

```bash
kubectl delete pvc -n visiban -l app.kubernetes.io/instance=visiban
```
