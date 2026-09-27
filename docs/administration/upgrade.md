# Upgrading Visiban

!!! note "Available from 1.0"
    This guide covers upgrades from Visiban 1.0 onward. If you are migrating from a pre-1.0 release, follow the [1.0 release notes](#upgrading-to-100) below first.

This page explains how to safely upgrade a self-hosted Visiban instance between releases.

## Version compatibility quick-reference

| Upgrading from | Upgrading to | Standard upgrade? | Notes |
|---|---|---|---|
| Any pre-1.0 beta or RC | 1.0.x | **No — maintenance window required** | Run the `groups/0003_placeholder` SQL fix first; `boards/0005` and `groups/0012` both require stopping backends before migration. See [Upgrading to 1.0.0](#upgrading-to-100). |
| 1.0.x | 1.0.x (patch) | Yes — zero-downtime | Follow the [standard upgrade steps](#standard-upgrade-steps). |
| 1.0.x | 1.1.x (minor) | Yes — zero-downtime | Follow the [standard upgrade steps](#standard-upgrade-steps). Check the [release-specific notes](#release-specific-upgrade-notes) for any migration-window exceptions. |

Skipping minor versions (e.g. 1.0 → 1.2 directly) is supported — run all intermediate migrations in sequence. The standard upgrade command (`manage.py migrate`) handles this automatically. The standard path is: pull the new image, run database migrations, restart. The sections below cover what makes each step safe and what to watch out for in more complex deployments.

---

## Standard upgrade steps

These steps apply to a single-server Docker Compose deployment.

!!! tip "Optional: freeze writes for the duration"
    These steps are safe to run with the instance live — that's the whole point of the
    zero-downtime migration rules below. If you'd still rather nobody move a card while you
    migrate, turn on [maintenance mode](maintenance-mode.md) before step 1 and off again after
    step 5. It rejects non-admin writes with `503` while leaving reads, and your own admin
    access, working throughout.

### 1. Back up the database

Always take a snapshot before upgrading. If a migration fails partway through, you will need this to recover.

```bash
docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U visiban visiban > visiban-backup-$(date +%Y%m%d%H%M%S).sql
```

Store the backup outside the container. A local file on the host is sufficient for most deployments; offsite storage is recommended for production.

### 2. Point `APP_VERSION` at the new release and pull it

The production stack runs the released images named by `APP_VERSION` in `.env`
and builds nothing locally, so changing that line is what selects the new
version — without it, `pull` fetches the version you already run.

```bash
# In .env: APP_VERSION=vX.Y.Z   (the release you are upgrading to)
docker compose -f docker-compose.prod.yml pull
```

### 3. Run migrations

```bash
docker compose -f docker-compose.prod.yml run --rm backend python manage.py migrate
```

This starts a one-off container, applies all pending migrations, and exits. The running backend container is not restarted yet, so the old code is still serving traffic while migrations run. Because Visiban enforces additive-only migration rules (see [Zero-downtime migration rules](#zero-downtime-migration-rules) below), the old code is safe to run against the new schema during this window.

### 4. Restart the services

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate backend
```

This replaces the running backend container with the new image. Nginx and the database are unaffected.

### 5. Verify

```bash
docker compose -f docker-compose.prod.yml logs backend --tail 40
```

Look for the `daphne` startup line. An `ImproperlyConfigured` or migration error here means the new container did not start cleanly — check the logs for the specific error before proceeding.

Check migration status:

```bash
docker compose -f docker-compose.prod.yml run --rm backend python manage.py showmigrations
```

All migrations should show `[X]`. Any `[ ]` entry means a migration was not applied.

---

## Zero-downtime migration rules

Visiban enforces strict migration authoring rules that make the upgrade sequence above safe. Understanding these rules helps you evaluate whether a third-party migration or a local customization is safe to run without downtime.

### Why these rules exist

During the upgrade window (between step 3 and step 4 above), two versions of the application code are running against the same database schema: the old code reading the migrated schema, and the new code starting up against it. For zero-downtime upgrades to work, the schema after migration must be fully compatible with both versions simultaneously.

Four patterns break this compatibility — or block the upgrade outright — and are therefore prohibited:

### Rule 1 — Every new column must be nullable or have a default

A `NOT NULL` column without a default added to an existing table blocks any `INSERT` from the old code that does not know about the new column. The old container cannot supply a value for a column it does not know about.

**Safe:** `nullable=True` or a `default=` value on the field. The old code omits the column from its `INSERT`; PostgreSQL fills in `NULL` or the default.

**Unsafe:** `NOT NULL` with no default. Every `INSERT` from the old code fails with a constraint violation.

If a column genuinely must be `NOT NULL` with no default, the migration must be split across releases:

1. Release N: add the column as nullable.
2. Backfill data (can be done in the same migration or a data migration).
3. Release N+1: add the `NOT NULL` constraint as a separate migration.

### Rule 2 — Never drop a column in the same migration that removes the ORM reference

When a field is removed from a Django model, the ORM stops referencing it. If the column is also dropped in the same migration, the old code will crash on startup trying to `SELECT` a column that no longer exists.

**Safe sequence:**

1. Release N: remove the field from the model. Do **not** drop the column in the migration — Django will generate `migrations.RemoveField()`, which does drop the column. Replace the `RemoveField` with a no-op (or a `SeparateDatabaseAndState` operation) so the column is retained in the database but ignored by the ORM.
2. Release N+1: drop the column for real.

### Rule 3 — Column rename = add + copy + drop across three releases

Renaming a column in a single migration causes the old code to fail on every query that references the old name.

**Safe sequence:**

1. Release N: add the new column (nullable), start populating it alongside the old one.
2. Release N+1: switch all reads and writes to the new column. Retain the old column.
3. Release N+2: drop the old column.

### Rule 4 — Every index and constraint is built concurrently

The first three rules keep the *schema* compatible across the upgrade window. This one keeps
`migrate` itself from being the outage.

A plain `CREATE INDEX` or `ALTER TABLE ... ADD CONSTRAINT` holds an `ACCESS EXCLUSIVE` lock on
its table for the entire build — every read and every write to that table blocks until it
finishes. On `cards` that is the whole product, and on a large instance an index build is
minutes, not milliseconds.

Since 1.2, every index Visiban adds is built with `CREATE INDEX CONCURRENTLY` and every check
constraint is added `NOT VALID` and validated separately. Neither takes a lock that blocks
readers or writers, so step 3 of the upgrade above can run while the old containers are still
serving traffic. A CI gate fails the build on any migration that regresses to the blocking
form — see [Database migrations](../development/database-migrations.md) for the pattern and
the authoring rules.

!!! note "Migrations added before 1.2"
    Fourteen migrations predate this rule and still build their indexes with a lock. If you are
    replaying them against an already-populated database — the restore-then-migrate case, for
    example loading a pre-1.1 dump into a 1.2 deployment — you can build those indexes by hand
    with `CONCURRENTLY` first and then `migrate --fake` past them. The full list and the exact
    procedure are in
    [Database migrations](../development/database-migrations.md#the-pre-1081-migrations-decision-and-reasoning).

---

## Multi-replica deployments

!!! tip "Rolling a Helm deployment with zero downtime"
    This section explains why running migrations separately from replica startup matters. For
    a full step-by-step rolling-upgrade procedure on Helm/Kubernetes — pre-upgrade checklist,
    watching the migrate hook Job, verifying a partial rollout, and rolling back mid-upgrade —
    see the [Zero-Downtime Upgrade Playbook](zero-downtime-upgrade.md).

!!! warning
    Running `migrate` inside the container startup command is unsafe when `backendReplicaCount > 1`.

`docker-compose.prod.yml` already keeps migrations out of the backend container: the
one-shot `backend-init` service runs `migrate` and `collectstatic`, and `backend` starts only
after it exits successfully. The backend container itself runs only the idempotent
`ensure_site_admin` bootstrap before `daphne`. The risk below applies if you replace that
layout with a startup command that migrates — for example on Docker Swarm, a second Compose
host, or a hand-written Kubernetes manifest — because then every replica races to apply the
same migrations on startup. Django's migration executor is not safe to run concurrently: two containers applying the same migration at the same time will conflict at the database level and may leave the schema in an inconsistent state.

**Recommended approach for multi-replica deployments:**

Run migrations as a dedicated pre-deploy step before scaling up any application replicas.

=== "Docker Compose"

    ```bash
    # 1. Run migrations once, in a separate container, before any replicas start.
    docker compose -f docker-compose.prod.yml run --rm backend python manage.py migrate

    # 2. Start (or restart) application replicas.
    docker compose -f docker-compose.prod.yml up -d --scale backend=3 --no-deps backend
    ```

    The `--no-deps` flag prevents Compose from restarting `db` and `valkey`.

=== "Kubernetes"

    Define a Kubernetes `Job` (or an init container on the `Deployment`) that runs `python manage.py migrate`. Set the `Deployment` to depend on the `Job` completing successfully, or use a deployment pipeline step that runs the job before updating the `Deployment` image tag.

    A minimal job manifest:

    ```yaml
    apiVersion: batch/v1
    kind: Job
    metadata:
      name: visiban-migrate
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: migrate
              image: registry.example.com/visiban-backend:v1.1.0
              command: ["python", "manage.py", "migrate"]
              envFrom:
                - secretRef:
                    name: visiban-env
    ```

    Run this job to completion before applying the updated `Deployment`.

    !!! tip "The Helm chart already handles this"
        If you deploy with the bundled chart you do not need any of the above.
        Each backend pod runs `python manage.py migrate_with_lock` as an init
        container, which serializes concurrent replicas on a PostgreSQL advisory
        lock: exactly one replica applies migrations, the others wait for it and
        then start. The lock is session-scoped, so a pod killed mid-migration
        releases it instead of blocking the next deploy. See
        [Kubernetes (Helm)](../getting-started/kubernetes.md). The same command
        works for hand-rolled manifests — use it in place of bare `migrate`.

---

## Rollback guidance

### Reversible vs. irreversible migrations

Not all migrations can be safely reversed.

| Migration type | Reversible? | Notes |
|---|---|---|
| Add a table | Yes | `migrate <app> <prev>` drops the table |
| Add a nullable column | Yes | `migrate <app> <prev>` drops the column |
| Add an index | Yes | Index is dropped on reverse |
| Data transform / `RunPython` | Only if backward function is implemented | Check the migration for a `reverse_code` argument |
| Drop a column | No | Data is gone; must restore from backup |
| Drop a table | No | Data is gone; must restore from backup |
| `NOT NULL` constraint added to existing column | No | Reversing removes the constraint but not the data loss from failed inserts |

### Rolling back to a specific migration

Identify the target migration — the last known-good state — using `showmigrations`:

```bash
docker compose -f docker-compose.prod.yml run --rm backend \
  python manage.py showmigrations
```

Then migrate backwards to it:

```bash
docker compose -f docker-compose.prod.yml run --rm backend \
  python manage.py migrate <app_label> <migration_name>
```

For example, to roll back the `boards` app to migration `0042`:

```bash
docker compose -f docker-compose.prod.yml run --rm backend \
  python manage.py migrate boards 0042_some_migration_name
```

After rolling back, restart the backend container with the previous image version.

!!! warning
    If the migration sequence includes any irreversible operation (a destructive `RunPython`, a column drop, or a `NOT NULL` constraint on existing data), Django will raise `django.db.migrations.exceptions.IrreversibleError` and abort. In that case the only recovery path is to restore the database from the backup taken before the upgrade.

---

## Release-specific upgrade notes

### Upgrading to 1.2.x

Migration `accounts/0027_maintenance_mode` adds two nullable-by-default columns
(`maintenance_mode`, `maintenance_message`) to the `site_settings` singleton for the new
[maintenance mode](maintenance-mode.md) feature. It is a plain `AddField` migration — no index,
no constraint, no data backfill — and `maintenance_mode` defaults to `False`, so an existing
install behaves exactly as before until an operator deliberately turns it on.

Migration `boards/0059_add_swimlane_custom_fields` adds two new tables
(`swimlane_custom_field_definitions`, `swimlane_custom_field_values`) for the new
[swimlane (row) custom fields](../features/custom-fields.md#swimlane-row-custom-fields)
feature. Both operations are `CreateModel` — no existing table, index, or constraint is
touched — so it is zero-downtime and requires no operator action.

!!! warning "Helm values are now schema-validated — an unknown key fails the upgrade"
    Chart 0.4.0 ships `values.schema.json` with `additionalProperties: false` on
    the chart's own blocks. A values key the chart does not read — a typo, or a
    name lifted from another chart's documentation — now fails `helm upgrade`
    with a message naming the key and its path:

    ```
    Error: values don't meet the specifications of the schema(s) in the following chart(s):
    visiban:
    - at '/backend/settings': additional properties 'allowedHost' not allowed
    ```

    **This is not a regression in what the chart supports.** Such a key was never
    being applied; it was accepted in silence and changed nothing on the pod,
    which is indistinguishable from the setting having no effect. The upgrade now
    stops instead of continuing to ignore it.

    **What to do:** correct the spelling, or delete the key. To find them ahead
    of the upgrade, run the schema check without deploying anything:

    ```bash
    helm template visiban oci://ghcr.io/visiban/charts/visiban -f my-values.yaml >/dev/null
    ```

    Blocks handed to a subchart or to `toYaml` stay open and accept any key:
    `global`, `postgresql`, `valkey`, `ingress.annotations`,
    `backend.resources`, `frontend.resources`, `backend.securityContext.pod` /
    `.container`, `postgresql.securityContext.pod` / `.container` (chart
    0.6.0, #1210).

!!! note "Upload limits are now derived from one value"
    `backend.settings.maxUploadSizeBytes` (default 10 MB) now drives the
    application cap, the frontend nginx `client_max_body_size`, and the ingress
    `nginx.ingress.kubernetes.io/proxy-body-size` annotation — the last two with
    10 MB of multipart-framing headroom.

    With only this change, all three resolve to exactly what 1.1 shipped at the
    chart defaults. The Trello import cap below raises the two transport limits
    to 35 MB; the application's attachment cap is unchanged. If you previously raised the limit, set
    `backend.settings.maxUploadSizeBytes` instead of editing the annotation and
    the nginx config separately; a hand-set `ingress.annotations` entry of the
    same name still overrides the derived one.

!!! note "Default transport body limit raised from 20 MB to 35 MB (Trello import)"
    1.2 adds a [Trello import](../features/trello-import.md) that accepts exports
    up to `VISIBAN_IMPORT_MAX_SIZE` (default 25 MB, Helm:
    `backend.settings.importMaxSizeBytes`). So those uploads reach Visiban
    instead of dying at the edge, the transport limits are now derived from the
    **larger** of `maxUploadSizeBytes` and `importMaxSizeBytes` plus 10 MB:

    - **Helm:** nginx `client_max_body_size` and the ingress `proxy-body-size`
      annotation go from `20M` to `35M` at the chart defaults.
    - **Docker Compose:** `nginx/app.conf.template` and
      `nginx/app-http.conf.template` now set `client_max_body_size 35M`.

    Attachment uploads are still capped at `MAX_UPLOAD_SIZE_BYTES` (10 MB) by
    the application, so this does not let larger attachments through. If you
    run your own reverse proxy in front of Visiban, raise its body limit to at
    least 35 MB for Trello imports to work — see
    [Import limits](configuration.md#import-limits).

!!! note "Service renamed: Redis → Valkey (container and Helm chart)"
    Visiban 1.2 replaces the Redis container with **Valkey** (the BSD-3-licensed, Linux Foundation fork of Redis). Valkey is wire-compatible with Redis 7+ — the RESP protocol is identical — so **no env var changes are required**.

    **What changes:**

    | Component | Before 1.2 | After 1.2 |
    |---|---|---|
    | Docker Compose service name | `redis` | `valkey` |
    | Docker image | `redis:7-alpine` | `valkey/valkey:8-alpine` |
    | Helm chart | `bitnami/redis` subchart | Built-in StatefulSet on `valkey/valkey:8-alpine` (see below) |
    | Helm values key | `redis:` | `valkey:` |
    | In-cluster service DNS | `<release>-redis-master:6379` | `<release>-valkey-primary:6379` |

    **What stays the same:**

    - `REDIS_URL`, `REDIS_CACHE_URL`, `REDIS_PASSWORD` — env var names are unchanged
    - `redis://` URL scheme — unchanged; Valkey speaks the same protocol
    - `externalRedis` Helm values key — unchanged for backward compatibility
    - `/api/health/readiness/` response field `"redis"` — unchanged (it is a published API contract)

    **No data migration required** — Valkey holds only ephemeral channel-layer and cache data (WebSocket group subscriptions and short-lived rate-limit keys). All of this is rebuilt automatically on startup. Simply redeploy:

    === "Docker Compose"

        ```bash
        docker compose -f docker-compose.prod.yml pull
        docker compose -f docker-compose.prod.yml up -d
        ```

        The old `redis` container is replaced by the new `valkey` container. Any in-flight WebSocket connections will reconnect automatically.

    === "Kubernetes / Helm"

        ```bash
        helm repo update
        helm dependency update helm/visiban
        helm upgrade visiban helm/visiban --reuse-values \
          --set valkey.image.repository=valkey/valkey \
          --set valkey.image.tag=8-alpine
        ```

        The two `--set` flags are needed only with `--reuse-values`; see
        "Helm: bundled Valkey is no longer the Bitnami subchart" below.

        If you previously set `redis.enabled: false` and pointed `externalRedis.url` at an external Redis instance, no change is needed — the `externalRedis` key is unchanged and your external instance continues to work.

        If you used the bundled subchart, the in-cluster service DNS changes from `<release>-redis-master:6379` to `<release>-valkey-primary:6379`. The Helm chart sets `REDIS_URL` automatically from the new service name — no manual update is required unless you overrode `REDIS_URL` in your values file.

!!! note "Helm: bundled Valkey is no longer the Bitnami subchart"
    Chart 0.5.0 runs the bundled Valkey as the chart's own StatefulSet on the
    official, versioned `valkey/valkey:8-alpine` image — the same major as
    `docker-compose.prod.yml` — instead of the Bitnami `valkey` subchart. That
    subchart's default image was `bitnami/valkey:latest` (Bitnami no longer
    publishes versioned tags), so every pod reschedule could move a Helm install
    to a different Valkey major with no diff (#1200).

    **What stays the same:** the Service name `<release>-valkey-primary`, so
    `REDIS_URL` and `REDIS_CACHE_URL` do not change; `valkey.enabled`;
    `externalRedis`; and the NetworkPolicy rule that admits only the backend,
    scheduler and demo-seed pods to port 6379.

    **What `helm upgrade` does:** Helm creates a new StatefulSet,
    `<release>-valkey`, re-points the `<release>-valkey-primary` Service at it,
    and deletes the subchart's StatefulSet `<release>-valkey-primary`, its
    headless Service, ConfigMaps, ServiceAccount and PodDisruptionBudget. The
    new name is deliberate: a StatefulSet's selector, service name and volume
    templates cannot be changed in place, so reusing the old name would fail the
    upgrade. Upgrading straight from the 1.1 chart (`bitnami/redis` subchart)
    works the same way.

    **Data:** none that matters. Valkey holds only the real-time (Channels)
    layer and the Django cache — no sessions, no job queue — and the chart ran
    it without persistence. Open WebSocket connections drop once and reconnect,
    cached settings are re-read from the database, and rate-limit and
    login-lockout counters start again from zero (as they already did on any
    Valkey pod restart). No backup or migration step is needed.

    **If you enabled Valkey (or Redis) persistence**, the old claim is left
    behind, as Kubernetes does for every StatefulSet volume. It holds only
    rebuildable data; delete it once the upgrade is healthy:

    ```bash
    kubectl -n <namespace> get pvc | grep -E 'valkey-data|redis-data'
    kubectl -n <namespace> delete pvc valkey-data-<release>-valkey-primary-0
    ```

    **Values that no longer apply.** The chart now reads `valkey.enabled`,
    `valkey.image.repository`, `valkey.image.tag`, `valkey.image.pullPolicy`,
    `valkey.primary.persistence.enabled`, `.size`, `.storageClass`,
    `valkey.primary.resources` and `valkey.commonConfiguration`. Three leftover
    subchart settings would change what runs if they were ignored, so the
    upgrade **fails with an explanation** instead:

    | Value | Why it is refused | What to do |
    |---|---|---|
    | `valkey.architecture: replication` | The backend only ever used the primary; the replicas did nothing | Remove it, or use `externalRedis` |
    | `valkey.auth.enabled: true` | `REDIS_URL` never carried a password, so this has never worked | Remove it (NetworkPolicy restricts access), or use `externalRedis` with the password in the URL |
    | A `bitnami/*` `valkey.image.repository`, or an empty or `latest` `valkey.image.tag` | A Bitnami image does not start under the new configuration, and `latest` is the drift this change removes | `--set valkey.image.repository=valkey/valkey --set valkey.image.tag=8-alpine` |
    | A `valkey.image.registry` other than Docker Hub | The chart no longer reads the key, so the image would silently come from Docker Hub | Drop it (`--set valkey.image.registry=null`) and put the mirror in `valkey.image.repository` |

    A Docker Hub `valkey.image.registry` (`docker.io`, `registry-1.docker.io`)
    is accepted and ignored, because the official image lives there too.

    **`helm upgrade --reuse-values` needs two extra flags.** `--reuse-values`
    carries the previous release's values forward, and for a release made with
    the subchart those include the subchart's own image defaults
    (`bitnami/valkey`, tag `latest`). The upgrade therefore stops at the image
    check above. Either pass the official image explicitly:

    ```bash
    helm upgrade visiban helm/visiban --reuse-values \
      --set valkey.image.repository=valkey/valkey \
      --set valkey.image.tag=8-alpine
    ```

    or, on Helm 3.14 or later, use `--reset-then-reuse-values` instead of
    `--reuse-values`. It starts from this chart's defaults and re-applies only
    the values you set yourself. An upgrade that passes `-f my-values.yaml`
    without `--reuse-values` needs neither.

    Every other Bitnami-only key (for example `valkey.primary.resourcesPreset`,
    `valkey.primary.podLabels`, `valkey.networkPolicy.*`, `valkey.metrics.*`) is
    accepted and ignored. Check what your values file sets before upgrading:

    ```bash
    helm get values <release> -n <namespace> | yq '.valkey'
    ```

    **Rolling back** with `helm rollback` to a pre-0.5.0 revision recreates the
    subchart's StatefulSet; a persistence claim you have not deleted is
    reattached.

!!! warning "Helm: backend and PostgreSQL pods now run hardened, like Valkey (chart 0.6.0)"
    Chart 0.6.0 brings the backend Deployment (its `migrate`, `collectstatic`
    and `bootstrap` init containers included) and the bundled PostgreSQL
    StatefulSet up to the same hardening the bundled Valkey StatefulSet has run
    with since chart 0.5.0 (#1200): a non-root user, `seccompProfile:
    RuntimeDefault`, `allowPrivilegeEscalation: false`, a **read-only root
    filesystem**, every Linux capability dropped, and no mounted
    ServiceAccount token (#1210). See
    [Pod security](../getting-started/kubernetes.md#pod-security) for the full
    list and the values that control it.

    **This is a default change for existing installs, not an opt-in.** A
    `helm upgrade` to chart 0.6.0 replaces every backend and PostgreSQL pod
    with one running under the new `securityContext` — no values change
    required to pick it up.

    **What could break:** a custom backend image that writes somewhere other
    than `/tmp`, `STATIC_ROOT` (`/app/staticfiles`) or the already-mounted
    media/admin-password volumes, or a custom PostgreSQL image that writes
    somewhere other than `PGDATA`, `/var/run/postgresql` or `/tmp`, will fail
    to start under a read-only root filesystem. The stock images ship with the
    chart do not do this — the chart's own `scripts/helm-install-drill.sh` and
    `scripts/helm-netpol-drill.sh` boot both hardened pods on a real cluster —
    but an overridden `backend.image` or `postgresql.image` should be verified
    against a staging release first.

    **If your image cannot run under this hardening**, relax just the field
    that conflicts rather than disabling the whole block — for example, to
    keep a writable root filesystem on a custom PostgreSQL image:

    ```bash
    helm upgrade visiban helm/visiban --reuse-values \
      --set postgresql.securityContext.container.readOnlyRootFilesystem=false
    ```

    Helm deep-merges nested maps, so a single-leaf `--set` like the one above
    (or a `-f` file that sets only `readOnlyRootFilesystem`) keeps the chart's
    other defaults (`allowPrivilegeEscalation`, `capabilities.drop`) for the
    rest of the `container` block — you never need to repeat every key. To
    remove a key the chart sets rather than change its value, set it to
    `null` explicitly (`--set postgresql.securityContext.container.foo=null`);
    an override file that simply omits a key leaves the chart default in
    place, it does not clear it.

!!! note "Scheduled jobs ship in 1.2 — off by default"
    1.2 adds a scheduler for `notify_due_soon`, `notify_stale_cards`,
    `prune_board_events` and the new `prune_notifications`: an opt-in `scheduler`
    service (Compose profile `scheduler`) in `docker-compose.prod.yml`, and
    `scheduledJobs` CronJobs in the Helm chart. **Neither is on after an
    upgrade**, and no data is pruned until you enable a prune job yourself.

    - If you **already schedule these commands from host cron**, either keep
      doing that or switch to the shipped scheduler. Do not do both: two
      notification scans started in the same minute can notify a user twice.
      Remove the cron line before you enable the shipped job.
    - If you **never scheduled them**, users who turned on due-date or staleness
      notifications have received nothing. Enable the scheduler to fix that.
    - `NOTIFICATION_RETENTION_DAYS` (default 90, minimum 14) is new. It has no
      effect until `prune_notifications` is scheduled. Preview the first run
      with `python manage.py prune_notifications --dry-run`.

    See [Scheduled Jobs](scheduled-jobs.md).

!!! note "Data integrity check — cards pointing at another board's column/swimlane"
    1.2 closes a security hole where `PATCH`/`PUT .../cards/{id}/` accepted a `column` or
    `swimlane` id from a different board, silently detaching the card from both boards'
    `/full/` views and skipping WIP/weight enforcement and the `CardMovement` audit trail
    (see the changelog security entry for this release). The API now rejects such requests
    with `400`, but rows written by a client that exploited this before upgrading are not
    fixed automatically.

    Run the new read-only management command after upgrading to find any already-corrupted
    cards:

    ```bash
    docker compose -f docker-compose.prod.yml run --rm backend \
      python manage.py find_cross_board_cards
    ```

    It lists every card whose `column.board_id` or `swimlane.board_id` does not match the
    card's own `board_id`. It makes no changes — repair each reported card manually (move it
    back to a column/swimlane on its own board via the API or admin, or archive it) since the
    correct destination cannot be inferred automatically.

!!! warning "`APP_VERSION` is now required in `.env` — no more silent `latest` fallback"
    `docker-compose.prod.yml` previously resolved `${APP_VERSION:-latest}` on the `backend`,
    `backend-init`, `scheduler` and `frontend-build` services when `.env` did not set
    `APP_VERSION`. 1.2 makes it fail-closed instead
    (`${APP_VERSION:?APP_VERSION must be set in .env — see .env.example}`), matching the
    `DB_PASSWORD`/`REDIS_PASSWORD`/`DOMAIN` pattern the rest of the file already uses. This
    closes the gap TruePPM's audit named directly (#1074): the documented production path
    pulled a mutable tag that could not be verified or rolled back. Release images are
    content-addressed by digest, but are not yet scanned, SBOM'd, or signed against that
    digest — that work is tracked separately in
    [#1153](https://gitlab.com/visiban/visiban/-/issues/1153).

    **If your `.env` already sets `APP_VERSION`** — the documented path since `.env.example`
    has always shipped one — this changes nothing; `docker compose pull`/`up` resolve to the
    exact same tag as before. `GET /api/v1/version/` now always returns bare semver
    (`1.2.0`) even when `APP_VERSION=v1.2.0` (#1174) — previously it echoed `APP_VERSION`
    verbatim, so a `v`-pinned install got `v1.1.0` back — so a script comparing the
    endpoint's response to `$APP_VERSION` should strip a leading `v` before comparing.

    **If your `.env` does not set `APP_VERSION`** (a hand-rolled `.env` that skipped this line,
    or one where it was later removed), `docker compose pull`/`up -d` and `init-prod.sh` now
    fail immediately with a message telling you to set it, instead of silently resolving to
    whatever `latest` currently points at. Add the line before upgrading:

    ```bash
    echo "APP_VERSION=v1.2.0" >> .env   # pin to the release you are deploying
    ```

    A scheduled CI job (`check-release-images`) now also runs on every scheduled CI pipeline
    to verify that the newest released `backend`/`frontend` image tag is still pullable from
    both the GitLab registry and GHCR — see
    [Container image retention](container-image-retention.md). How often that actually is
    depends on the project's configured pipeline schedule(s), not on this code.

!!! note "`TLS_MODE=selfsigned` no longer sends a 2-year HSTS header"
    The bundled `nginx/app.conf.template` used to hardcode
    `Strict-Transport-Security: max-age=63072000; includeSubDomains` for **both**
    `TLS_MODE=letsencrypt` and `TLS_MODE=selfsigned`, contradicting the docs (which have always
    said selfsigned disables HSTS by default) and ignoring an operator-set `SECURE_HSTS_SECONDS`.
    `init-prod.sh` now renders the header itself from `SECURE_HSTS_SECONDS`, and nginx hides
    Django's own copy of the header on every proxied path so exactly one is ever sent (#1201).

    **What changes for an existing install:**

    - **`TLS_MODE=letsencrypt`** — no change if you don't set `SECURE_HSTS_SECONDS`: the header
      still defaults to 2 years with `includeSubDomains`. If you already set
      `SECURE_HSTS_SECONDS` in `.env`, nginx now actually honors it (previously it was silently
      ignored in favor of the hardcoded 2-year value).
    - **`TLS_MODE=selfsigned`** — the 2-year header is **removed**; no `Strict-Transport-Security`
      header is sent by default. This is the intended fix, not a regression: browsers only
      enforce HSTS on a connection they already trust, so the practical effect was limited to
      operators who manually trust the self-signed cert (a common staging setup) — those browsers
      were being pinned to HTTPS for two years, including on all subdomains, with no documented
      way to back out early. Set `SECURE_HSTS_SECONDS` explicitly in `.env` if you want the
      header on a selfsigned deployment anyway.

    **This step is required, not optional.** After upgrading, re-run `./init-prod.sh` to
    re-render `nginx/active.conf.template`, then
    `docker compose -f docker-compose.prod.yml up -d --force-recreate nginx` — a plain
    `up -d`/`pull` does not notice that the bind-mounted nginx config content changed, so nginx
    keeps running whatever it already had on disk from before the upgrade.

    If you skip this step, both problems this release fixes silently persist, with no error and
    no visible difference until someone inspects the response headers directly: nginx keeps
    serving its **old** rendered config — the one still carrying the original hardcoded
    `max-age=63072000` line unconditionally on both modes, and none of the new
    `proxy_hide_header Strict-Transport-Security` lines. So `TLS_MODE=selfsigned` keeps sending
    the 2-year header exactly as before (the docs mismatch this release exists to fix stays
    unfixed), and every proxied path (`/api/`, `/admin/`, `/media/`, etc.) keeps stacking
    nginx's hardcoded header on top of Django's own independently-computed one — two
    `Strict-Transport-Security` headers on the same response, which per RFC 6797 §8.1 means
    browsers ignore HSTS entirely on those paths. Pulling the new backend/frontend images and
    restarting those containers has no effect on this: nginx's config is a bind-mounted file
    this repo's `init-prod.sh` renders once, on the host, not something baked into the nginx
    image the containers pull.

### Upgrading to 1.1.x

!!! warning "Removed env-var aliases — rename before upgrading"
    Two deprecated environment variable aliases were **removed** in 1.1. Operators who still set the old names will get silent failures — OIDC will be deactivated and email verification will have no effect:

    | Old name (removed) | Canonical name (use this) |
    |---|---|
    | `OIDC_SECRET` | `OIDC_CLIENT_SECRET` |
    | `ACCOUNT_EMAIL_VERIFICATION` | `EMAIL_VERIFICATION` |

    Before upgrading, search your `.env` file and any CI/CD secret stores for these old names and rename them. From 1.1 on, setting either removed alias logs a startup deprecation warning naming the canonical replacement — but the old name is no longer read, so that warning is your only signal that SSO or email verification has silently stopped working. If neither alias appears anywhere in your config, no action is required.

!!! note "Card density migration — existing boards default to Dense"
    In 1.1, card display is controlled by a per-board **Card density** setting (Comfortable / Standard / Dense) that replaces the previous per-user per-field hide toggles.

    Existing boards are automatically migrated to the **Dense** tier, which reproduces the pre-1.1 card layout. New boards default to **Comfortable**.

    The previous per-user preferences (`hideLabels`, `hideDueDate`, `hideAssignee`, `hidePriority`, `hideLastMoved`) stored in `localStorage` are silently ignored after the upgrade — they are not migrated. Board admins can adjust the density for their board at any time from **Board Settings → Display**.

!!! warning "Breaking change — Valkey authentication is now required in production"
    `docker-compose.prod.yml` now starts Valkey with `--requirepass` and constructs `REDIS_URL` and `REDIS_CACHE_URL` using the password. **The stack will fail to start if `REDIS_PASSWORD` is not set in your `.env`.**

    Before running `docker compose -f docker-compose.prod.yml up`, add `REDIS_PASSWORD` to your `.env`:

    ```bash
    # Generate a strong random password and insert it into .env
    sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -hex 32)|" .env
    ```

    Or generate a value manually and add it:

    ```bash
    openssl rand -hex 32   # hex, not base64: a "/" in the password breaks the redis:// URL
    # Copy the output, then add to .env:
    REDIS_PASSWORD=<generated value>
    ```

    Existing deployments that used the default unauthenticated Valkey (or Redis) will continue to work after setting this variable — Valkey data in the container is ephemeral (it holds only WebSocket channel state and short-lived cache keys), so no migration of data is required.

!!! note "Migration window — GIN trigram indexes (`boards/0030`)"
    Migration `boards/0030` creates full-text GIN indexes on the `cards` table using `CREATE INDEX` (not `CREATE INDEX CONCURRENTLY`). On PostgreSQL, a standard index build holds an `AccessShareLock` on the table for the duration of the build, blocking writes to `cards`.

    For most self-hosted deployments the index build completes in seconds and is not noticeable. For installations with **millions of cards**, this may cause a brief write outage on board operations during the migration window.

    **If you have a large `cards` table and need zero-downtime index creation**, pre-create the indexes manually before running `migrate`:

    ```sql
    CREATE INDEX CONCURRENTLY IF NOT EXISTS boards_card_title_trgm
      ON boards_card USING gin (title gin_trgm_ops);
    CREATE INDEX CONCURRENTLY IF NOT EXISTS boards_card_description_trgm
      ON boards_card USING gin (description gin_trgm_ops);
    ```

    Then run `python manage.py migrate` as normal — the migration's `CREATE INDEX IF NOT EXISTS` will detect the indexes exist and skip creation.

!!! warning "Pre-1.0 installs upgrading directly to 1.1 — `groups/0003_placeholder`"
    If your database was created from any pre-1.0 release **and you are upgrading directly to 1.1.x without first running 1.0.x**, you must apply the same `groups/0003_placeholder` reconciliation step described under [Upgrading to 1.0.0](#upgrading-to-100) below before running `manage.py migrate`. Without it, Django's `InconsistentMigrationHistory` check aborts the upgrade and the schema is not advanced.

    Equivalent management-command form (run inside the backend container):

    ```bash
    docker compose -f docker-compose.prod.yml run --rm backend \
      python manage.py migrate groups 0003_placeholder --fake
    ```

    Instances that already ran 1.0.x are unaffected — the reconciliation row is already present in `django_migrations`.

!!! warning "Irreversible migration — `boards/0050` (BoardExportLog audit table)"
    Migration `boards/0050` creates the `BoardExportLog` table that records who ran a board export, the format, the row count, and the role the actor held at export time. The table is permanent audit storage and the migration has **no safe reverse** — rolling it back drops the table and destroys the audit history.

    Take a database backup before applying `boards/0050` if you need a rollback path. After the migration applies, the only way to retain audit rows is to restore from that backup; reverting the migration cannot recover them.

!!! note "Migration window — column name deduplication (`boards/0043`)"
    Migration `boards/0043` adds a unique constraint on `(board, name)` for columns. Before applying the constraint, it runs a Python loop to deduplicate any existing column names within the same board (e.g. renaming a second "Done" column to "Done (2)").

    For deployments with a very large number of boards and columns, this deduplication loop may take several seconds. The subsequent `ADD CONSTRAINT` then issues a brief table lock to build the unique index.

    **If you have many thousands of columns**, you can run the deduplication ahead of the migration window by executing it as a one-off management command before upgrading:

    ```bash
    docker compose -f docker-compose.prod.yml run --rm backend \
      python manage.py shell -c "
    from boards.models import Column
    from django.db.models import Count
    for board_id in Column.objects.values_list('board_id', flat=True).distinct():
        seen = {}
        for col in Column.objects.filter(board_id=board_id).order_by('position'):
            base = col.name
            if base in seen:
                seen[base] += 1
                col.name = f'{base} ({seen[base]})'
                col.save(update_fields=['name'])
            else:
                seen[base] = 1
    print('Done')
    "
    ```

    After this runs, `boards/0043` will find no duplicates and the constraint add will complete quickly.

### Upgrading to 1.0.0

!!! warning "Required pre-deploy step for any instance that ran a pre-1.0 beta"
    If your database was created from any pre-1.0 release (including any release candidate), you **must** run the following SQL against your database **before** running `manage.py migrate` or starting the 1.0 backend container:

    ```sql
    INSERT INTO django_migrations (app, name, applied)
    VALUES ('groups', '0003_placeholder', NOW())
    ON CONFLICT DO NOTHING;
    ```

    **Why:** Migration `groups/0003_placeholder` was added to the 1.0 release to fill a gap in the `groups` migration sequence. Because `groups/0004` was already applied in pre-1.0 releases, Django's startup check (`InconsistentMigrationHistory`) will prevent `manage.py migrate` from running if `0003` is not already marked applied. The SQL above registers it as applied so Django accepts the history as consistent. The migration itself is a no-op — it contains no schema changes.

    Fresh installs (where no pre-1.0 migrations have ever been applied) are not affected.

!!! warning "Maintenance window required for groups/0012 (plaintext token column drop)"
    Migration `groups/0012` drops the `token` column from the `groupinvitelinks` table. This column was replaced by `token_hash` + `prefix` in migrations `0010`/`0011`. All invite link lookups have read `token_hash` exclusively since that point (#605).

    Because this is a column drop, it is **irreversible** — if you apply this migration and need to roll back, you must restore from a backup.

    **Required upgrade procedure for instances running a version prior to `groups/0012`:**

    1. Stop all backend container(s) before running migrations — the old code references `token` at the ORM level; running it against the post-0012 schema will cause startup errors.
    2. Run `python manage.py migrate`.
    3. Start backend container(s) with the new image.

    Instances that are already on a release that includes `groups/0012` are not affected.

!!! warning "Maintenance window required for boards/0005 (Customer → Swimlane rename)"
    Migration `boards/0005` renames the `customers` table to `swimlanes` and renames four columns (`customer_id`, `from_customer_id`, `to_customer_id`) to their `swimlane` equivalents. This is a **single-step rename** — there is no intermediate schema state where both the old code (reading `customer`) and the new code (reading `swimlane`) can run simultaneously.

    **Required upgrade procedure for pre-1.0 instances:**

    1. Stop all backend container(s) — do **not** leave them running during migration.
    2. Run `python manage.py migrate` to apply `boards/0005` and any subsequent migrations.
    3. Start backend container(s) with the new image.

    This is a one-time requirement for the 1.0 upgrade. All subsequent releases follow the standard zero-downtime upgrade path described above.

---

## Checking migration status

At any time you can inspect which migrations have been applied:

```bash
docker compose -f docker-compose.prod.yml run --rm backend \
  python manage.py showmigrations
```

`[X]` means applied. `[ ]` means pending. A pending migration after a deployment indicates the migration step was skipped or failed silently — run `migrate` manually and check the output for errors before serving traffic.
