# Visiban Helm chart

Self-hosted Kanban board with customer swimlanes and a card movement audit
trail. This chart deploys the Django/daphne backend, the React SPA behind nginx,
and — optionally — an in-cluster PostgreSQL and Valkey.

`helm show readme` renders this file, which is why it lives here rather than
only in `docs/`: an operator who pulls the published OCI chart has no access to
the repository's documentation tree.

Full operator documentation: <https://visiban.gitlab.io/visiban/getting-started/kubernetes/>

## Install

From the published OCI chart:

```bash
helm install visiban oci://ghcr.io/visiban/charts/visiban \
  --namespace visiban --create-namespace \
  --set-string secret.djangoSecretKey="$(python3 -c 'import secrets; print(secrets.token_hex(50))')" \
  --set ingress.host=boards.example.com \
  --set backend.settings.allowedHosts=boards.example.com \
  --set backend.settings.corsAllowedOrigins=https://boards.example.com \
  --set backend.settings.frontendUrl=https://boards.example.com \
  --set backend.settings.siteDomain=boards.example.com
```

Release tags are Cosign-signed. Verify before installing:

```bash
cosign verify ghcr.io/visiban/charts/visiban:<version> \
  --certificate-identity-regexp 'gitlab\.com/visiban/visiban' \
  --certificate-oidc-issuer https://gitlab.com
```

## Verify the install

```bash
helm test visiban --namespace visiban --logs
```

`helm test` probes the backend's liveness and readiness endpoints, then the same
readiness endpoint *through the frontend's nginx*, then the SPA itself. Reaching
readiness proves the pod's `migrate` init container completed; reaching it through
nginx proves the proxy upstream resolves. CI runs this identical hook, so an
operator and the pipeline verify the same invariant.

## Values overlays

Three shipped overlays, all linted and rendered through kubeconform in CI:

| File | For |
|---|---|
| `values-dev.yaml` | Single-node evaluation. No TLS, no persistence, emails to the pod log. Not for real data. |
| `values-prod.yaml` | The production shape. HA replicas, TLS via cert-manager, mandatory email verification, NetworkPolicies on. Carries no secrets. |
| `values-demo.yaml` | A public demo such as try.visiban.com: a published login behind the demo write fence, a database that resets every hour, egress denied. **Never for real data.** Carries no secrets. See [Public demo mode](#public-demo-mode). |

```bash
helm install visiban oci://ghcr.io/visiban/charts/visiban \
  -f values-prod.yaml -f my-secrets.yaml ...
```

## Values

`values.yaml` documents every key inline. Two things worth knowing before you
edit it:

**The values schema is closed.** `values.schema.json` declares
`additionalProperties: false` at the root and on every chart-owned object, so a
misspelled or invented key is rejected by `helm install` instead of being
silently accepted and doing nothing. Blocks handed to a subchart or to `toYaml`
— `global`, `postgresql`, `ingress.annotations`, `*.resources`,
`backend.securityContext.pod` / `.container`, `postgresql.securityContext.pod`
/ `.container`, `frontend.securityContext.pod` / `.container` — stay open,
because the chart is not the authority on what is valid inside them.
`valkey` also stays open, so a values file written for the Bitnami subchart the
chart used before 0.5.0 still upgrades; see [Bundled Valkey](#bundled-valkey).

## Bundled Valkey

`valkey.enabled=true` (the default) runs Valkey as this chart's own StatefulSet
on the official `valkey/valkey:8-alpine` image — the same major as
`docker-compose.prod.yml`. Until chart 0.5.0 it was the Bitnami `valkey`
subchart, whose default image was the floating `bitnami/valkey:latest`, so a
Helm install silently changed Valkey major on any pod reschedule (#1200).

- The Service is still `<release>-valkey-primary`, so `REDIS_URL` and
  `REDIS_CACHE_URL` are unchanged across the upgrade.
- Valkey holds only the Channels layer and the Django cache, so the upgrade's
  pod replacement loses nothing that is not rebuilt on its own.
- `valkey.architecture=replication` and a Bitnami `valkey.image` fail the
  render with an explanation rather than being ignored. Other Bitnami-only keys
  are no longer read.
- `valkey.auth.enabled=true` (off by default) requires a password, from
  `valkey.auth.password` or `valkey.auth.existingSecret` (+
  `existingSecretPasswordKey`, default `valkey-password`) — exactly one (#1211).
  The password reaches Valkey and the backend only through that Secret; the
  backend percent-encodes it into `REDIS_URL` / `REDIS_CACHE_URL`, so any
  character is safe. See "Valkey password" in
  `docs/getting-started/kubernetes.md`.

`scripts/helm-structure-check.sh` fails any rendered image that has no tag or
is tagged `latest`.

**Upload limits are derived, not set in three places.**
`backend.settings.maxUploadSizeBytes` (attachments and native board imports) and
`backend.settings.importMaxSizeBytes` (Trello imports, `VISIBAN_IMPORT_MAX_SIZE`,
default 25 MB) set the application caps; the larger of the two *also* drives
the nginx `client_max_body_size` and the ingress `proxy-body-size` annotation,
each with 10 MB of multipart-framing headroom. Raise the one value and the whole
path moves with it; a transport limit below the app cap would 413 uploads at the
edge before Django could return a message naming the real limit.

## Pod security

Every long-running or scheduled workload the chart renders — the backend
Deployment (its migrate/collectstatic/bootstrap init containers included), the
frontend (nginx) Deployment, the bundled PostgreSQL and Valkey StatefulSets,
the scheduledJobs CronJobs, and the demo seed Job/CronJob — runs as a non-root
user with a read-only root filesystem, `seccompProfile: RuntimeDefault`, no
privilege escalation, every Linux capability dropped, and no mounted
ServiceAccount token. Scratch space each image needs to write (`/tmp`,
PostgreSQL's `/var/run/postgresql`, the backend's `STATIC_ROOT`, nginx's
`/var/cache/nginx` and `/run`) is an `emptyDir`, never the root filesystem.

The Valkey StatefulSet's hardening (#1200) is not overridable. The backend
Deployment's, the bundled PostgreSQL StatefulSet's, and the frontend
Deployment's are, via `backend.securityContext.pod` / `.container`,
`postgresql.securityContext.pod` / `.container` (#1210), and
`frontend.securityContext.pod` / `.container` (#1224) — for an operator on a
base image that cannot run as the chart's numeric UID, or that needs a
writable root filesystem. `scripts/helm-structure-check.sh` asserts
`runAsNonRoot` and a full capability drop on every rendered workload, with no
exclusions.

As a non-root user, the frontend container cannot bind a port below 1024
(`CAP_NET_BIND_SERVICE` is not usable here — see
[Pod security](../../docs/getting-started/kubernetes.md#pod-security)), so it
listens on 8080 internally; the frontend **Service** still fronts port 80 by
default (`frontend.service.port`), unaffected.

## Scheduled jobs

`scheduledJobs.enabled=true` renders Kubernetes CronJobs for the daily
maintenance commands: the due-date and staleness notification scans (on
within the switch), plus the `board_events` and `notifications` retention prunes
(off unless enabled individually, because they delete data). The switch is
**off by default**, so upgrading the chart creates nothing. With it off, no
due-date or staleness notification is ever sent. See `scheduledJobs` in
`values.yaml`, and <https://visiban.gitlab.io/visiban/administration/scheduled-jobs/>.

## NetworkPolicies

`networkPolicy.enabled=true` restricts pod-to-pod traffic to the paths Visiban
actually needs. It requires a CNI that **enforces** NetworkPolicy — Calico,
Cilium, or a managed equivalent.

kind's default CNI (kindnetd) does not implement NetworkPolicy at all: the
objects are admitted, reported by `kubectl get netpol`, and ignored. A clean
install on kind is therefore not evidence that these policies work. CI's
`helm-netpol` job builds a dedicated Calico cluster for exactly this reason.

The scheduled-job pods (`component: scheduler`) are already on those lists, as
are the public-demo seed and reset pods (`component: demo-seed`) while demo mode is on.
If you add a workload that opens a PostgreSQL or Valkey connection, add its
`app.kubernetes.io/component` to the allow-lists at the top of
`templates/networkpolicy.yaml` — the policies name their clients by that label,
so a new template breaks isolation without touching the policy file.

## Public demo mode

`demo.enabled=true` (start from `values-demo.yaml`) turns a release into a public,
shared demo. It is **off by default**, and with it off the chart renders exactly
what it rendered before (`scripts/helm-structure-check.sh` section 9 asserts that),
so `helm upgrade` on an existing release changes nothing.

- **The control is the backend's write fence.** `demo.enabled` renders
  `DEMO_MODE=true` into every container that imports Django settings, which arms
  `DemoModeMiddleware`. Every unsafe request is refused with `403 demo_read_only`
  except sign-in/out and card-content edits.
- **Seed and reset.** A post-install/post-upgrade hook Job and a CronJob
  (`demo.reset.schedule`, default hourly, always UTC) run the same pod:
  `migrate_with_lock`, then `seed_demo_data --force --wipe --demo-site --reset-database`.
  That **empties every table**, signs every visitor out, and re-applies the
  published password. The schedule is also rendered as the backend's
  `DEMO_RESET_SCHEDULE`, which drives the visitor countdown. When
  `demo.reset.enabled=false` it is rendered empty, so the login page stops
  promising a reset. A failed reset keeps its Job for `kubectl logs` and is never
  a readiness signal. The reset is containment, not a control.
- **Egress.** A NetworkPolicy limits the backend, seed/reset and scheduled-job
  pods to DNS and the release's own PostgreSQL and Valkey. Demo mode therefore
  requires `networkPolicy.enabled=true` and the bundled datastores.
- **`helm test`** adds a probe that goes through the frontend Service: the
  published sign-in answers 200, an authenticated `POST /api/v1/boards/` answers
  403 with `demo_read_only`, a seeded card move answers 200, and `site-config`
  publishes `demo_next_reset_at` exactly when the reset runs.
- **Render guards** (`templates/_validate.tpl`) refuse a `loginHint` without
  `demo.enabled`, a demo without both `loginHint` halves or with unsafe
  characters in them, SSO/OAuth, real SMTP, a media PVC, any truthy `debug`
  (not just the literal `true`), NetworkPolicy off, external datastores, and
  `backend.settings.numProxies` unset or below `1`.
- **Client IP.** Behind a tunnel or another proxy, set `backend.settings.numProxies`
  (`NUM_PROXIES`) to the real hop count — including this chart's own frontend
  nginx, which always adds one. The chart refuses to render below `1`, but it
  cannot know your actual proxy depth: get the count right, not just non-zero.
  `values-demo.yaml` sets `2` for a Cloudflare Tunnel.

Operator guide: <https://visiban.gitlab.io/visiban/administration/demo-data/#public-demo-mode-helm>.
The try.visiban.com runbook, with the preconditions CI cannot check, is
`docs/maintainers/demo-deploy.md`.

## What CI checks

| Job | Proves |
|---|---|
| `helm-lint` | Templates parse; values conform to `values.schema.json`; every overlay is valid; every settings module the chart names exists |
| `helm-template` | Every rendered object is valid Kubernetes (`kubeconform -strict`), including the demo overlay with and without its reset; the deploy contract holds (`scripts/helm-structure-check.sh`), including the demo invariants and a failing render for every demo guard |
| `helm-install` | The chart boots on kind, `helm test` passes, a placeholder SECRET_KEY is rejected, and secrets rotate in a single `helm upgrade`; then `values-demo.yaml` installs, its `helm test` proves the fence, and a reset run leaves the published login working |
| `helm-netpol` | The NetworkPolicies are actually enforced on Calico, allow exactly the intended clients, and deny the rest; in demo mode, the backend and seed pods cannot reach anything outside the pod network |
| `helm-publish` | On a release tag: `appVersion` matches the tag, and the chart is pushed to GHCR and Cosign-signed |

Run the static ones locally:

```bash
bash scripts/helm-structure-check.sh --self-test helm/visiban   # prove the gate can fail
bash scripts/helm-structure-check.sh helm/visiban               # assert the contract
```

The drills need Docker and kind:

```bash
bash scripts/helm-install-drill.sh
bash scripts/helm-netpol-drill.sh
```
