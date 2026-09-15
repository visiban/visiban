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
readiness proves the migrate hook completed; reaching it through nginx proves the
proxy upstream resolves. CI runs this identical hook, so an operator and the
pipeline verify the same invariant.

## Values overlays

Two shipped overlays, both linted in CI:

| File | For |
|---|---|
| `values-dev.yaml` | Single-node evaluation. No TLS, no persistence, emails to the pod log. Not for real data. |
| `values-prod.yaml` | The production shape. HA replicas, TLS via cert-manager, mandatory email verification, NetworkPolicies on. Carries no secrets. |

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
— `global`, `postgresql`, `valkey`, `ingress.annotations`, `*.resources` — stay
open, because the chart is not the authority on what is valid inside them.

**Upload limits are derived, not set in three places.**
`backend.settings.maxUploadSizeBytes` sets the application cap and *also* drives
the nginx `client_max_body_size` and the ingress `proxy-body-size` annotation,
each with 10 MB of multipart-framing headroom. Raise the one value and the whole
path moves with it; a transport limit below the app cap would 413 uploads at the
edge before Django could return a message naming the real limit.

## NetworkPolicies

`networkPolicy.enabled=true` restricts pod-to-pod traffic to the paths Visiban
actually needs. It requires a CNI that **enforces** NetworkPolicy — Calico,
Cilium, or a managed equivalent.

kind's default CNI (kindnetd) does not implement NetworkPolicy at all: the
objects are admitted, reported by `kubectl get netpol`, and ignored. A clean
install on kind is therefore not evidence that these policies work. CI's
`helm-netpol` job builds a dedicated Calico cluster for exactly this reason.

If you add a workload that opens a PostgreSQL or Valkey connection, add its
`app.kubernetes.io/component` to the allow-lists at the top of
`templates/networkpolicy.yaml` — the policies name their clients by that label,
so a new template breaks isolation without touching the policy file.

## What CI checks

| Job | Proves |
|---|---|
| `helm-lint` | Templates parse; values conform to `values.schema.json`; every overlay is valid; every settings module the chart names exists |
| `helm-template` | Every rendered object is valid Kubernetes (`kubeconform -strict`); the deploy contract holds (`scripts/helm-structure-check.sh`) |
| `helm-install` | The chart boots on kind, `helm test` passes, a placeholder SECRET_KEY is rejected, and secrets rotate in a single `helm upgrade` |
| `helm-netpol` | The NetworkPolicies are actually enforced on Calico, allow exactly the intended clients, and deny the rest |
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
