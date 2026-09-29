# Hosted Demo (try.visiban.com)

How the public demo is deployed, and what an operator must verify by hand — the preconditions
no CI job can check. The chart side (values, guards, seed and reset, egress policy,
`helm test`) is documented for everyone in
[Public demo mode](../administration/demo-data.md#public-demo-mode-helm); what follows is
the one real deployment.

!!! warning "Nothing below is verified by CI"
    CI proves the chart on kind: it installs `values-demo.yaml`, runs `helm test`, runs a
    reset, and on Calico proves the egress policy denies outbound traffic
    (`helm-install` and `helm-netpol`). CI cannot see the real node, the Cloudflare
    Tunnel, or the Cloudflare dashboard. Every "verify" step on this page is a human
    check. Record the result in [Deployment record](#deployment-record).

## Where it runs

| | |
|---|---|
| Node | The single k3s node that also runs try.trueppm.com (decided 2026-09-27, #1180) |
| Namespace | `visiban-demo`, used only by this release |
| Release | `visiban-demo`. The chart collapses the name, so Services are `visiban-demo-frontend`, `visiban-demo-backend` |
| Exposure | The node's existing Cloudflare Tunnel (`cloudflared`, TruePPM ADR-0658 D9). No Ingress, no ingress controller, no cert-manager |
| Values | `helm/visiban/values-demo.yaml` plus an uncommitted secrets file |

Nothing is shared with TruePPM's release except the node and the tunnel. The frontend
NetworkPolicy admits port 80 from any peer, so the tunnel reaches it. The backend and the
datastores admit only this release's own components, so TruePPM's namespace cannot reach
them. Keep it that way: do not widen those policies for convenience.

## Preconditions

Check these before the first install, and again whenever the node is rebuilt.

### 1. The node is not a CI-runner host

TruePPM ADR-1197 D10: a host that serves a published login must not also run CI jobs,
because a runner holds credentials and caches a demo visitor must never be near. This is
already true for try.trueppm.com and applies to this deployment unchanged. No CI job can
check it. Confirm that the node is not in the runner inventory
([CI Runners](ci-runners.md)) and that no `gitlab-runner` service runs on it:

```bash
# on the node
systemctl list-units --all | grep -i gitlab-runner || echo "no gitlab-runner unit"
```

### 2. NetworkPolicy is enforced on the node

The demo egress policy (backend, seed and reset pods may reach DNS and their own
PostgreSQL and Valkey, and nothing else) is only a claim if the CNI enforces it. k3s
enforces NetworkPolicy with its embedded kube-router controller unless it was installed
with `--disable-network-policy`.

Configuration check, on the node (expect no output):

```bash
sudo grep -rs -- 'disable-network-policy' /etc/rancher/k3s/ /etc/systemd/system/k3s*.service
```

Behavioral check after the install, from any machine with cluster access. This is the
one-line `kubectl` check. A pod carrying the backend's labels must NOT reach the internet:

```bash
kubectl -n visiban-demo run egress-check --rm -i --restart=Never --image=busybox:1.36 \
  --labels=app.kubernetes.io/name=visiban,app.kubernetes.io/instance=visiban-demo,app.kubernetes.io/component=backend \
  -- nc -z -w 5 1.1.1.1 443 && echo "NOT ENFORCED: egress is open" || echo "OK: egress denied"
```

Then the control, so "denied" means the policy and not a node without internet. An
unlabeled pod SHOULD connect:

```bash
kubectl -n visiban-demo run egress-control --rm -i --restart=Never --image=busybox:1.36 \
  -- nc -z -w 5 1.1.1.1 443 && echo "OK: control connects" || echo "control failed: check node egress first"
```

If the first command prints `NOT ENFORCED`, stop and fix the node before exposing the demo.

### 3. Cloudflare: bot and abuse reduction, not security controls

The maintainer decided (2026-09-27) that there is **no Cloudflare Access or email gate**.
Visitors give no email, so nothing needs to be disclosed. Configure only Cloudflare
free-plan features that collect nothing. As TruePPM ADR-1197 D8 says, none of them is a
security control; the write fence (#1179) is.

- The tunnel itself, plus Cloudflare's automatic DDoS protection.
- A WAF **Managed Challenge** on the `/login` **page**, not the API endpoint (completeness
  -check, #1180: the SPA calls `POST /api/v1/auth/login/` with `fetch`, and a Cloudflare
  challenge cannot be solved by an XHR/fetch request — it needs a full-page navigation to
  render and complete. Challenging the API path would silently make sign-in impossible for
  anyone the challenge fires on, and `helm test` — an in-cluster request — would never
  catch it). Configure it in Cloudflare Zero Trust → WAF → Custom rules:
  - **Rule name**: `visiban-demo-login-challenge`
  - **Expression**: `(http.host eq "try.visiban.com" and http.request.uri.path eq "/login")`
  - **Action**: Managed Challenge
- An **IP rate-limit rule** on `try.visiban.com/api/`. After sign-in, this is the only
  per-visitor bound: every visitor shares one account, so the `user` throttle is a
  shared-fate ceiling (`demo.throttle.userRate`), and DRF's per-IP `anon` scope does not
  apply to signed-in requests. Configure it in Cloudflare Zero Trust → Security → WAF →
  Rate limiting rules:
  - **Rule name**: `visiban-demo-api-rate-limit`
  - **Expression**: `(http.host eq "try.visiban.com" and starts_with(http.request.uri.path, "/api/"))`
  - **Rate**: e.g. 300 requests per 1 minute, per IP (tune to the node's actual capacity;
    this is a DoS backstop, not the throttle itself — the throttle values above are the
    real per-endpoint limits)
  - **Action**: Block for the rate period

Record both rule names and their live status in [Deployment record](#deployment-record)
when first configured — Cloudflare dashboard config is not visible to CI or to `git log`,
so the deployment record is the only durable trace that these were actually set up.

## Install or upgrade

1. Create the secrets file outside the repository (never commit it):

    ```yaml
    # ~/visiban-demo-secrets.yaml
    secret:
      djangoSecretKey: "<python3 -c 'import secrets; print(secrets.token_hex(50))'>"
    postgresql:
      auth:
        password: "<openssl rand -hex 24>"
    demo:
      loginHint:
        password: "<openssl rand -base64 18 | tr -d '=+/'>"   # PUBLISHED on the login page
      adminPassword: "<openssl rand -base64 24>"              # never published
      memberPassword: "<openssl rand -base64 24>"             # not published
    ```

2. Install or upgrade. Pin both image tags to a release that contains #1179 and #1180
   (1.2.0 or later):

    ```bash
    helm upgrade --install visiban-demo ./helm/visiban \
      --namespace visiban-demo --create-namespace \
      -f helm/visiban/values-demo.yaml \
      -f ~/visiban-demo-secrets.yaml \
      --set backend.image.tag=vX.Y.Z --set frontend.image.tag=vX.Y.Z \
      --wait --timeout 12m
    ```

    Every install and every upgrade runs the seed hook, which **empties the database and
    reseeds it**. Visitors are signed out, just as they are by a scheduled reset.

3. Prove the fence:

    ```bash
    helm test visiban-demo -n visiban-demo --logs
    ```

    Expect `signed in as visitor ... (200)`, `board create refused 403 demo_read_only`,
    `moved seeded card ... (200)` and a `demo_next_reset_at`. A failure here means do not
    expose the instance.

4. Run the NetworkPolicy behavioral check from [Precondition 2](#2-networkpolicy-is-enforced-on-the-node).

## Expose it through the tunnel

Add a public hostname to the node's existing tunnel. It must point at the **frontend**
Service, never the backend.

- **Dashboard-managed tunnel** (Zero Trust → Networks → Tunnels → the node's tunnel →
  Public Hostname → Add): hostname `try.visiban.com`, service type `HTTP`, URL
  `visiban-demo-frontend.visiban-demo.svc.cluster.local:80`.
- **Config-file tunnel**: add an ingress rule before the catch-all:

    ```yaml
    - hostname: try.visiban.com
      service: http://visiban-demo-frontend.visiban-demo.svc.cluster.local:80
    ```

**Confirm which mode this node's `cloudflared` runs in before choosing an approach, and
record it in [Deployment record](#deployment-record)** — do not assume either way:

```bash
# on the node
if [ -n "$(kubectl get pods -A -l app=cloudflared -o name 2>/dev/null)" ]; then
  echo "in-cluster pod"
elif systemctl is-active --quiet cloudflared 2>/dev/null; then
  echo "host service"
else
  echo "neither found — check how this tunnel is actually run before proceeding"
fi
```

The in-cluster DNS name (`visiban-demo-frontend.visiban-demo.svc.cluster.local:80`) works
only if `cloudflared` runs as a pod (TruePPM's `values-demo.yaml` runs it this way on this
same node, but confirm rather than assume it wasn't changed). If it runs on the host,
it cannot resolve cluster DNS. Use `kubectl -n visiban-demo port-forward` or a NodePort
Service instead, and adjust `backend.settings.numProxies` if the hop count changes (see
below).

## The client IP behind the tunnel

`values-demo.yaml` sets `backend.settings.numProxies: 2`. It assumes this chain:
visitor → Cloudflare edge (appends the visitor to `X-Forwarded-For`) → `cloudflared` →
frontend nginx (appends the `cloudflared` pod) → backend. If the chain changes, for
example a second proxy is added or `cloudflared` moves, recount. A value that is too low
puts every visitor in one throttle bucket, so one crawler locks the demo for everyone. A
value that is too high lets a visitor choose their own bucket.

**The frontend access log cannot verify this** (completeness-check, #1180): nginx's default
log format records `$http_x_forwarded_for`, the header exactly as *received* — one address,
the real visitor's, forwarded unchanged through Cloudflare and `cloudflared`. The hop nginx
itself *appends* (`$proxy_add_x_forwarded_for`, what the backend actually sees) is never
logged by the default format, so "two addresses in the log" is not something you will
observe here even when the chain is configured correctly.

Verify with the backend's own test suite instead, against the live deployment: sign in from
two different real client IPs (or `curl --resolve` through two different intermediate
addresses if you control any) and confirm each gets an independent login-throttle bucket
rather than one shared one — the equivalent of
`backend/accounts/tests/test_proxy_depth.py`'s `SeparateThrottleBucketsTests`, but against
the real deployed chain rather than a Django test client. A cheaper partial check: confirm
`$remote_addr` in the frontend log is the `cloudflared` pod's cluster-internal IP (proving
requests genuinely arrive through the tunnel, not directly):

```bash
kubectl -n visiban-demo logs deploy/visiban-demo-frontend --tail=20
```

## Operating it

- **Reset schedule.** Every hour, on the hour, UTC (`demo.reset.schedule`). The same value
  drives the countdown visitors see. To pause resets, set `demo.reset.enabled=false` and
  upgrade. The login page then stops promising a reset.
- **A failed reset** leaves the previous seed up. It is never a readiness signal, so the
  demo keeps serving stale data. Find it with
  `kubectl -n visiban-demo get jobs -l app.kubernetes.io/component=demo-seed` and read it
  with `kubectl -n visiban-demo logs job/<name> --all-containers`. The last three failed
  runs are kept.
- **Run a reset now**: `kubectl -n visiban-demo create job --from=cronjob/visiban-demo-demo-reset reset-now`.
  `concurrencyPolicy: Forbid` only stops the *scheduled* CronJob from overlapping itself —
  it does not know about a manually created Job, so a manual reset that lands within a few
  seconds of the top of the hour could run alongside the scheduled one (completeness-check,
  #1180). The flush-and-reseed is one transaction (see the chart docs), so a concurrent run
  serializes on the database rather than corrupting data, but suspend the CronJob first to
  avoid the wasted work and the confusing double-reset log:
  `kubectl -n visiban-demo patch cronjob visiban-demo-demo-reset -p '{"spec":{"suspend":true}}'`,
  run the manual reset, then `kubectl -n visiban-demo patch cronjob visiban-demo-demo-reset -p '{"spec":{"suspend":false}}'`.
- **Node sharing.** `values-demo.yaml` enables `demo.resourceQuota` (a ResourceQuota plus a
  LimitRange for the namespace). Check headroom with
  `kubectl -n visiban-demo describe resourcequota`. TruePPM's namespace should carry its own
  quota for the reverse direction.
- **Rotate a password**: change it in the secrets file and upgrade. The backend pods roll,
  because the demo Secret is checksummed into the pod template, and the seed hook
  re-applies the new password.

## Deployment record

Fill this in on every (re)deploy. An empty cell is an unverified claim.

| Date | Chart / image | Not a CI-runner host | NetworkPolicy enforced (both checks) | Tunnel hostname | `helm test` | By |
|---|---|---|---|---|---|---|
| — | not yet deployed | | | | | |
