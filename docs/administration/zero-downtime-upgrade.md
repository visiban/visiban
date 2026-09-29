# Zero-Downtime Upgrade Playbook

!!! tip "Docker Compose or a single server?"
    This playbook is for a **Helm / Kubernetes** deployment with more than one backend
    replica. If you run Visiban with Docker Compose on a single host, follow the
    [Standard upgrade steps](upgrade.md#standard-upgrade-steps) in the main upgrade guide
    instead — that path already applies while the old container keeps serving traffic
    during migration, but there is no second replica to roll traffic across.

Roll a **1.x → 1.(x+1) minor or patch** upgrade across a multi-replica Helm deployment with no
downtime window: pre-flight checks, the rolling deploy itself, and how to roll back if
something goes wrong mid-rollout. It assumes the install path in
[Kubernetes (Helm)](../getting-started/kubernetes.md) and a `backendReplicaCount` of 2 or
more (the `values-prod.yaml` overlay default).

**Out of scope:** major version upgrades (`1.x → 2.0`) — those are covered per-release in the
[Release-specific upgrade notes](upgrade.md#release-specific-upgrade-notes) — and
multi-region coordination.

The migration-safety rules this playbook relies on — nullable-first columns, add-then-drop
column removal, add+copy+drop renames, concurrently-built indexes — are the same rules every
Visiban code change follows. They are documented in full in
[Zero-downtime migration rules](upgrade.md#zero-downtime-migration-rules) and enforced on every
migration by the `migration-check` CI job (see
[Database migrations](../development/database-migrations.md)). The release contract behind
them — never remove a field, never rename an env var, never change a WebSocket event shape —
is written down in the project's
[Backward compatibility rules](https://gitlab.com/visiban/visiban/-/blob/main/CLAUDE.md#backward-compatibility--always-on-from-10).
This playbook does not restate any of that; it is the operator-facing procedure that those
rules make possible.

---

## 1. Pre-upgrade checklist

Work through this before touching the cluster.

1. **Read the changelog for every version between your current release and the target.**
   Pay particular attention to `changed` and `security` entries — `added` entries are
   additive by definition and rarely affect an upgrade, but `changed` covers behavior shifts
   (an env var default, a WebSocket payload addition, a Helm values key) and `security`
   entries sometimes carry a required post-upgrade action, like the `find_cross_board_cards`
   command in the [1.2 data-integrity note](upgrade.md#upgrading-to-12x).

    ```bash
    # From a checkout at the target tag
    git log --oneline v<current>..v<target> -- changelog.d/
    ```

2. **Check the version-specific notes for a maintenance-window warning.** The
   [compatibility quick-reference](upgrade.md#version-compatibility-quick-reference) and the
   per-version notes under
   [Release-specific upgrade notes](upgrade.md#release-specific-upgrade-notes) call out every
   release that has ever required stopping backends first (`groups/0012`, `boards/0005`).
   None have since 1.0 shipped — every 1.x migration is additive-only by the rule above — but
   confirm the target release before assuming that holds for yours too. If a maintenance
   window is called for, stop here and follow that note instead of this playbook.

3. **Scan the target release's migration files yourself** if you want a second signal beyond
   the changelog, or if you're upgrading across several versions at once:

    ```bash
    git diff v<current>..v<target> -- 'backend/*/migrations/*.py' \
      | grep -E '^\+.*(RemoveField|DeleteModel|migrations\.RunSQL|AlterField.*null=False)'
    ```

    A hit here doesn't necessarily mean a maintenance window is required — Visiban's own
    column-removal and rename rules span *multiple releases* precisely so that no single
    upgrade needs one — but it tells you which release finishes a rename or drop that a
    prior release started, so you know what changes shape.

4. **Verify your most recent backup is current and restorable.** This playbook's rollback
   procedure (§4) covers rolling back a *deployment* — reverting to the previous image and,
   where possible, the previous migration. It does not recover data lost to an irreversible
   migration (a column or table drop). Take a fresh backup immediately before upgrading:

    ```bash
    kubectl exec -n visiban $(kubectl get pod -n visiban -l app.kubernetes.io/component=postgresql -o jsonpath='{.items[0].metadata.name}') \
      -- pg_dump -U visiban visiban > visiban-backup-$(date +%Y%m%d%H%M%S).sql
    ```

    If you use an external managed PostgreSQL instance instead of the bundled StatefulSet,
    use your provider's snapshot mechanism instead.

5. **Confirm the current rollout is healthy before starting a new one.**

    ```bash
    kubectl rollout status deployment/visiban-backend -n visiban --watch=false
    kubectl get pods -n visiban -l app.kubernetes.io/component=backend
    ```

    Starting a rolling upgrade on top of an already-degraded deployment makes it much harder
    to tell a pre-existing problem from a new one once you start verifying half-rolled state
    in step 3 below.

---

## 2. The rolling upgrade

These steps assume the release name `visiban` in namespace `visiban`, matching the
[Kubernetes install guide](../getting-started/kubernetes.md). Substitute your own release
name throughout.

### Step 1 — Run `helm upgrade`

```bash
helm upgrade visiban helm/visiban \
  --namespace visiban \
  -f helm/visiban/values.secret.yaml \
  --set backend.image.tag=v1.2.0 \
  --set frontend.image.tag=v1.2.0
```

Migrations run as a **`migrate` init container on the backend `Deployment` itself** — not a
separate Helm hook Job. (An earlier chart version used a `pre-install`/`pre-upgrade` hook Job;
that broke a fresh `helm install`, where the hook ran before the bundled PostgreSQL Service
existed. See [Upgrading to 1.2.x](upgrade.md#upgrading-to-12x) if you're coming from a chart
version old enough to have used it.) Each new pod the rolling update creates — one per replica,
in sequence — runs three init containers in order before its `backend` container starts:
`migrate`, `collectstatic`, then `bootstrap`.

Because `backendReplicaCount` can be more than 1, more than one new pod's `migrate` init
container can start around the same time. `manage.py migrate_with_lock` (not a plain
`manage.py migrate`) is what keeps that safe: it takes a session-scoped PostgreSQL advisory
lock before migrating. The first replica to acquire it runs the real migration; every other
replica blocks on the lock and, once it acquires it, runs `migrate` again — a no-op, since
`django_migrations` already records what the winner applied. No pod's `backend` container ever
starts against a schema that's still being changed.

Two tunables, both in seconds: `backend.migrate.connectTimeout` (default `300`) bounds how
long a pod waits for the database to accept a connection at all — generous, since on a fresh
install PostgreSQL may still be starting. `backend.migrate.lockTimeout` (default `900`) bounds
how long a replica waits for another replica's in-flight migration to finish before giving up.
Raise `lockTimeout` if your largest migration (an index build on `cards`, for example) can
plausibly run longer than 15 minutes.

Because the schema each `migrate` run leaves behind is safe for both the old and new backend
code to read (that's the whole point of the
[zero-downtime migration rules](upgrade.md#zero-downtime-migration-rules)), old pods keep
serving correctly the entire time new pods are migrating and starting.

### Step 2 — Watch the rollout's migrate init containers

```bash
kubectl get pods -n visiban -l app.kubernetes.io/component=backend
kubectl logs -n visiban <new-pod-name> -c migrate
```

A pod stuck at `Init:0/3` (or showing the `migrate` container as `Running` well past the time a
normal migration takes) is either still waiting out `connectTimeout` for the database, or
waiting on `lockTimeout` for another replica's migration — the log line tells you which
(`migrate_with_lock: another replica is migrating — waiting for it to finish` vs. still
retrying the database connection).

**Watch out:** unlike a hook Job, there is no separate "migration step" Helm blocks on before
touching the Deployment. `helm upgrade` returns once the updated `Deployment` manifest is
*applied*, not once any pod — let alone the migration inside it — is actually `Ready`. The
terminal returning promptly is not itself a signal that migrations finished.

### Step 3 — Verify a partial rollout before letting it finish

The backend `Deployment` has no custom `strategy:`, so it uses Kubernetes' default
`RollingUpdate` (`maxUnavailable: 25%`, `maxSurge: 25%`) — at `backendReplicaCount: 2` that
is effectively one pod replaced at a time. To check the new image's health on a subset of
replicas before the rest follow, pause the rollout right after triggering it and resume once
you're satisfied:

```bash
# Immediately after step 1, before the new pods finish starting:
kubectl rollout pause deployment/visiban-backend -n visiban

# Give the controller a moment to bring up the pods it had already started, then check them
kubectl get pods -n visiban -l app.kubernetes.io/component=backend \
  -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image,READY:.status.containerStatuses[0].ready

# Check readiness directly against a new pod
kubectl exec -n visiban <new-pod-name> -- \
  python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/api/health/readiness/').read().decode())"
```

!!! note "This checkpoint is approximate, not a guaranteed 50%"
    `kubectl rollout pause` stops the controller from replacing *further* pods, but it can't
    retroactively undo replacements already in flight when you run it — at low replica counts
    (2–4, which covers most self-hosted installs) the window between `helm upgrade` returning
    and your `pause` command landing is often enough for one pod to already be mid-replacement.
    Treat this as "verify on however many new pods are up so far," not as a precise 50/50
    canary gate. A true gated canary needs a progressive-delivery controller (e.g. Argo
    Rollouts), which is out of scope here.

If the new pods look healthy, resume the rollout to completion:

```bash
kubectl rollout resume deployment/visiban-backend -n visiban
kubectl rollout status deployment/visiban-backend -n visiban
```

If they don't — crash-looping, failing readiness, error logs — stop and go to §4 instead of
resuming.

### Step 4 — Verify the full rollout

```bash
helm test visiban --namespace visiban --logs
```

This runs the same liveness → readiness → readiness-through-nginx → SPA probe chain used in
CI (see [Kubernetes (Helm) § Verify](../getting-started/kubernetes.md#5-verify)). A green
`helm test` here is the same invariant a fresh install checks, run against the upgraded
release.

---

## 3. When this playbook doesn't apply

Stop and use a maintenance window instead of the rolling procedure above when any of these
are true for the release you're upgrading to:

- The changelog or version-specific upgrade notes call out a required maintenance window
  (search for "Maintenance window required" under
  [Release-specific upgrade notes](upgrade.md#release-specific-upgrade-notes) — every
  instance so far has been a pre-1.0 → 1.0 migration, not a 1.x → 1.x one).
- Your migration scan in checklist step 3 surfaces a `RemoveField`, `DeleteModel`, or raw
  `DROP` that the changelog doesn't explain — treat an unexplained destructive operation as a
  reason to ask before upgrading, not a reason to skip the question.
- You are skipping multiple minor versions in one upgrade and haven't confirmed that none of
  the intermediate releases required a window. `manage.py migrate` will apply the whole chain
  in sequence regardless, but a window requirement three versions back still applies to you.

A maintenance window, for this deployment shape, means: scale `backendReplicaCount` to the
values that stop traffic (or put the ingress in maintenance mode), run `helm upgrade`, confirm
`helm test` is green, then scale back up.

!!! tip "A softer option: Visiban's own maintenance mode"
    If your reason for a window is "stop people writing while I migrate" rather than "stop all
    traffic", Visiban's built-in [maintenance mode](maintenance-mode.md) is usually a better fit
    than scaling to zero. It rejects every non-admin write with `503` while leaving reads — and
    your own admin access — working, and it shows users a notice you write. Turn it on before
    you migrate and off afterwards. It does not replace a window for the cases listed above,
    where the concern is the schema change itself rather than concurrent writes.

---

## 4. Rollback

### A new pod's `migrate` init container failed (§2 Step 1–2)

Traffic is unaffected — old pods are untouched by a new pod's init container failing, since
Kubernetes never routes Service traffic to a pod whose init containers haven't all succeeded.
The rollout stalls with the new pod stuck in `Init:Error` or `CrashLoopBackOff`, and
`kubectl rollout status` will not return until you intervene — there's no separate hook Job for
Helm to report as failed, so `helm upgrade` itself will have already returned successfully.

Read the failed container's logs and fix the underlying cause:

```bash
kubectl logs -n visiban <new-pod-name> -c migrate
```

Then either delete the stuck pod (the Deployment recreates it, and it retries `migrate` from
scratch) or roll back per below. A `CommandError` naming a lock or connection timeout, rather
than a Django migration error, means it never got to your schema change at all — see
`backend/boards/management/commands/migrate_with_lock.py` for what each message means.

If the migration itself was mid-way through an irreversible operation when it failed (rare,
since Visiban's rules keep every 1.x migration additive), see
[Rollback guidance](upgrade.md#rollback-guidance) in the main upgrade page for which
operations can be reversed with `manage.py migrate <app> <previous_migration>` and which
require restoring the backup taken in checklist step 4.

### The rollout itself is unhealthy (§2 Step 3 or 4)

The schema is already forward-compatible with the old code — that's what made the rolling
upgrade safe to start — so reverting the *Deployment* is enough; there is no matching
migration rollback to perform.

```bash
kubectl rollout undo deployment/visiban-backend -n visiban
kubectl rollout undo deployment/visiban-frontend -n visiban
kubectl rollout status deployment/visiban-backend -n visiban
```

If you paused the rollout (§2 Step 3) and are aborting rather than resuming, undo first —
`rollout undo` works on a paused rollout and un-pauses it as part of reverting.

For a full return to the previous release, including Helm's own record of values used:

```bash
helm history visiban --namespace visiban
helm rollback visiban <previous-revision> --namespace visiban
```

`helm rollback` recreates backend pods on the previous image, so their `migrate` init
containers run `manage.py migrate_with_lock` again — a no-op, since the schema is already at
whatever the failed upgrade left it at. That's safe precisely because that schema was built to
be readable by both versions; `helm rollback` does not and cannot revert a schema change
itself, only the Deployment/ConfigMap/Secret objects.

---

## Related pages

- [Upgrading Visiban](upgrade.md) — Docker Compose upgrade steps, the full zero-downtime
  migration rules, version-compatibility reference, and release-specific notes
- [Database migrations](../development/database-migrations.md) — index and constraint
  concurrency rules and the `migration-check` CI enforcement
- [Kubernetes (Helm)](../getting-started/kubernetes.md) — install, scaling, and the
  `backendReplicaCount` / `helm test` mechanics this playbook builds on
- An HA reference architecture guide (multiple replicas, shared Postgres/Valkey, WebSocket
  sticky sessions, failure modes) is planned but not yet published — this playbook will link
  to it once it lands.
