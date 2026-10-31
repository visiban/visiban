# Upgrading Visiban

!!! note "Available from 1.0"
    Covers upgrades from Visiban 1.0 onward. Migrating from a pre-1.0 release? Follow the [1.0 release notes](#upgrading-to-100) below first.

Upgrade a self-hosted Visiban instance between releases with zero downtime, using the standard steps below.

## Version compatibility quick-reference

| Upgrading from | Upgrading to | Standard upgrade? | Notes |
|---|---|---|---|
| Any pre-1.0 beta or RC | 1.0.x | **No — maintenance window required** | Run the `groups/0003_placeholder` SQL fix first; `boards/0005` and `groups/0012` both require stopping backends before migration. See [Upgrading to 1.0.0](#upgrading-to-100). |
| 1.0.x | 1.0.x (patch) | Yes — zero-downtime | Follow the [standard upgrade steps](#standard-upgrade-steps). |
| 1.0.x | 1.1.x (minor) | Yes — zero-downtime | Follow the [standard upgrade steps](#standard-upgrade-steps). Check the [release-specific notes](#release-specific-upgrade-notes) for any migration-window exceptions. |
| 1.1.x | 1.2.x (minor) | Yes — zero-downtime | Follow the [standard upgrade steps](#standard-upgrade-steps). See [Upgrading to 1.2.x](#upgrading-to-12x) — most changes are additive and need no operator action, but read the `!!!` callouts (Compose `ALLOWED_HOSTS`/`DOMAIN`, Helm `NUM_PROXIES` is now 2 behind the chart's Ingress (can change `/admin/` access if only the ingress range was allowlisted), Helm `ALLOWED_HOSTS` no longer includes `localhost`, Helm catch-all/loopback `allowedHosts` entries fail the render (**this one can stop `helm upgrade`**; opt out with `backend.settings.allowUnsafeHosts=true`), Helm values-schema validation, PAT scopes and the MCP server). |

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
docker compose -f docker-compose.prod.yml exec -T db \
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
docker compose -f docker-compose.prod.yml up -d
```

This recreates every service whose image changed with `APP_VERSION` — `backend-init` (which
re-checks migrations), `backend`, `frontend-build` (which copies the new SPA into place) and, if
enabled, `scheduler`. **Watch out:** recreating only `backend` leaves the old frontend and
scheduler running against the new API. Nginx and the database are unaffected.

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

### Frontend caching and a blank page after a deploy

The bundled nginx sends `Cache-Control: no-cache` for `index.html`,
`theme-init.js`, `site.webmanifest`, the favicon and app-icon files, and everything under `/brand/`, and `Cache-Control: public, max-age=31536000, immutable`
for the content-hashed files under `/assets/`. A request for an `/assets/*` file that does not
exist returns a real `404`, not the SPA's `index.html`. Deploys therefore stop leaving returning
visitors on a stale entry page. Helm picks this up on `helm upgrade`; Docker Compose installs must
first re-render the nginx config (see
[Upgrading to 1.2.x](#upgrading-to-12x)).

If you put your own reverse proxy or CDN in front of Visiban:

- Do **not** cache `index.html` (or any non-`/assets/` path) beyond revalidation. Cache-busting
  depends on the browser fetching a fresh `index.html` that names the new hashed `/assets/*` files.
- Pass the `Cache-Control` header through unchanged, and do not rewrite `404` responses for
  `/assets/*` into the SPA fallback.

A blank page after a deploy with a console error such as "Failed to load module script ...
MIME type of text/html" means a cached `index.html` is pointing at assets from the previous
build. A hard reload fixes it for that visitor; the headers above prevent it for everyone else.

---

## Zero-downtime migration rules

Visiban enforces strict migration authoring rules that make the upgrade sequence above safe. Understanding these rules helps you evaluate whether a third-party migration or a local customization is safe to run without downtime.

### Why these rules exist

During the upgrade window (between step 3 and step 4 above), two versions of the application code are running against the same database schema: the old code reading the migrated schema, and the new code starting up against it. For zero-downtime upgrades to work, the schema after migration must be fully compatible with both versions simultaneously.

Four patterns break this compatibility — or block the upgrade outright — and are therefore prohibited:

### Rule 1 — Every new column must be nullable or have a default

A `NOT NULL` column without a default added to an existing table blocks any `INSERT` from the old code that does not know about the new column. The old container cannot supply a value for a column it does not know about.

**Safe:** `null=True` or a `db_default=` value on the field (use `db_default=` alongside `default=`: on PostgreSQL a plain Python `default=` is dropped from the database after `AddField`, so old pods can still fail; see [Database migrations](../development/database-migrations.md)). The old code omits the column from its `INSERT`; PostgreSQL fills in `NULL` or the default.

**Unsafe:** `NOT NULL` with no `db_default=`, even if the field has a Python-level `default=` (PostgreSQL drops that after `AddField`). Every `INSERT` from the old code fails with a constraint violation.

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
    watching each new pod's `migrate` init container, verifying a partial rollout, and rolling
    back mid-upgrade — see the [Zero-Downtime Upgrade Playbook](zero-downtime-upgrade.md).

!!! warning
    Running `migrate` inside the container startup command is unsafe when `backendReplicaCount > 1`.

`docker-compose.prod.yml` already keeps migrations out of the backend container: the
one-shot `backend-init` service runs `migrate` and `collectstatic`, and `backend` starts only
after it exits successfully. The backend container itself runs only the idempotent
`ensure_site_admin` bootstrap before `daphne`. The risk below applies if you replace that
layout with a startup command that migrates — for example on Docker Swarm, a second Compose
host, or a hand-written Kubernetes manifest — because then every replica races to apply the
same migrations on startup. **Watch out:** Django's migration executor is not safe to run
concurrently — two containers applying the same migration at the same time will conflict at the
database level and may leave the schema in an inconsistent state.

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

### Restoring from backup

A database that a newer release has migrated cannot be run by the older release, so a restore always goes together with rolling the image tag back to the version the backup was taken on. The backup from [step 1](#1-back-up-the-database) is a plain SQL file, so it is restored with `psql`, not `pg_restore`. It contains no `DROP` statements, so restore into a freshly created, empty database. This is a minimal procedure; the full backup and restore playbook is tracked in [#861](https://gitlab.com/visiban/visiban/-/issues/861).

!!! danger "This replaces the live database"
    Everything written since the backup is lost, including cards moved and comments added after the upgrade. Keep a copy of the backup file, and take a fresh `pg_dump` of the current state first if there is any chance you will want it.

**Docker Compose**

```bash
# 1. Stop everything that writes to the database (nginx and the db stay up)
docker compose -f docker-compose.prod.yml stop backend scheduler

# 2. Drop and recreate the database (connect to the "postgres" maintenance database)
docker compose -f docker-compose.prod.yml exec db \
  dropdb -U visiban --force --if-exists visiban
docker compose -f docker-compose.prod.yml exec db \
  createdb -U visiban visiban

# 3. Load the backup
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U visiban -d visiban -v ON_ERROR_STOP=1 < visiban-backup-<timestamp>.sql

# 4. In .env set APP_VERSION back to the version the backup was taken on, then
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Use `-T` on the `psql` step so Compose does not allocate a TTY, which would break the `<` redirect.

**Helm** (bundled PostgreSQL StatefulSet, `postgresql.enabled=true`)

```bash
# 1. Stop the backend (and suspend any scheduledJobs CronJobs if you enabled them)
kubectl -n <namespace> scale deployment/<release>-visiban-backend --replicas=0

# 2. Drop, recreate and load. The StatefulSet is named <release>-postgresql
kubectl -n <namespace> exec <release>-postgresql-0 -- \
  dropdb -U visiban --force --if-exists visiban
kubectl -n <namespace> exec <release>-postgresql-0 -- createdb -U visiban visiban
kubectl -n <namespace> exec -i <release>-postgresql-0 -- \
  psql -U visiban -d visiban -v ON_ERROR_STOP=1 < visiban-backup-<timestamp>.sql

# 3. Roll the chart back to the revision that ran the backed-up version
helm -n <namespace> history <release>
helm -n <namespace> rollback <release> <revision>

# 4. Scale explicitly to the intended count (helm rollback may already have done so)
kubectl -n <namespace> scale deployment/<release>-visiban-backend --replicas=<backendReplicaCount>
```

The Deployment is named `<fullname>-backend`; `<fullname>` is the release name (plus `-visiban`, unless the release name already contains `visiban`), or `fullnameOverride`/`nameOverride` if you set either (run `kubectl get deploy` to confirm). The PostgreSQL StatefulSet is always `<release>-postgresql`. The user and database name above are the chart defaults (`postgresql.auth.username` and `postgresql.auth.database`). With an external database (`postgresql.enabled=false`), run the same `dropdb`, `createdb` and `psql` commands from a host that can reach it, using `psql -h <host> -U <user>` and the `externalDatabase` values. In both cases the rolled-back backend pods run the `migrate` init container against the restored database, which finds nothing to apply.

---

## Release-specific upgrade notes

### Upgrading to 1.2.x

!!! note "Four environment variables from the 1.2 pre-releases were renamed (old names still work)"
    If you ran a 1.2 alpha or beta, four names it introduced changed before GA to follow the
    naming convention of the variables around them. The pre-release names are **still read**
    as deprecated aliases, so nothing breaks, but each one now logs a startup warning. Rename
    them when convenient:

    | Pre-release name (deprecated) | Use instead |
    |---|---|
    | `VISIBAN_IMPORT_MAX_SIZE` | `IMPORT_MAX_SIZE_BYTES` |
    | `DEMO_USER_THROTTLE_RATE` | `DEMO_THROTTLE_USER_RATE` |
    | `VISIBAN_MIGRATE_CONNECT_TIMEOUT` | `MIGRATE_CONNECT_TIMEOUT_SECONDS` |
    | `VISIBAN_MIGRATE_LOCK_TIMEOUT` | `MIGRATE_LOCK_TIMEOUT_SECONDS` |

    If both names are set, the new one wins. The Helm chart already sets the new names. Its
    values keys (`backend.settings.importMaxSizeBytes`, `demo.throttle.userRate`,
    `backend.migrate.connectTimeout`, `backend.migrate.lockTimeout`) are unchanged. If you
    are upgrading from 1.1, none of these names existed, so no action is needed. See
    [Deprecated environment variable names](configuration.md#deprecated-environment-variable-names).

!!! note "Helm: NUM_PROXIES is 2 when the chart's Ingress is enabled"
    The chart now sets `NUM_PROXIES` to `2` when `ingress.enabled` is true,
    `frontend.service.type` is `ClusterIP` and `backend.settings.numProxies` is unset.
    Previously those installs rendered nothing and the backend used its default of `1`.
    The chain behind an ingress is two hops deep (the ingress controller, then this chart's
    frontend nginx), so per-IP limits, such as the login and anonymous request limits, now
    key on the client address rather than the ingress controller's address.

    - **Who is affected:** installs with the ingress enabled (the default) that never set
      `backend.settings.numProxies`. Upgrading rolls the backend pods.
    - **`/admin/` allowlist:** the allowlist is checked twice, and the two layers see
      different addresses. The frontend nginx `allow` rules match the ingress controller's
      pod address, while Django's middleware matches the client address. Behind the ingress,
      `backend.settings.adminAllowedIPs` needs both the ingress range (for nginx) and the
      client addresses (for Django). See
      [Helm admin allowlist](secret-rotation.md#helm).
    - **Keep the previous value:** set `backend.settings.numProxies: 1` explicitly.
    - **Set it by hand** when the frontend Service is exposed directly (use `1`), when
      another proxy such as a CDN sits in front of the ingress (the count must equal the number of trusted hops that append to `X-Forwarded-For`, and the ingress controller must be configured to preserve and append the upstream header; check its forwarded-header settings), or when
      your ingress controller does not add `X-Forwarded-For`.

!!! warning "Helm: use this chart with a backend image from the same release"
    From this release the chart sets only the new names above. An older backend image
    (for example a 1.2 pre-release pinned through `backend.image.tag`) does not read them and
    **silently** uses its defaults:

    - a custom `backend.settings.importMaxSizeBytes` is lost, and the Trello import cap goes
      back to 25 MB;
    - `demo.throttle.userRate` stops applying, so demo visitors share the normal `user`
      throttle limit again;
    - a custom `backend.migrate.connectTimeout` or `backend.migrate.lockTimeout` reverts to
      300 s or 900 s.

    Upgrade the chart and the image together. In a **released** chart (a tagged release or a
    published chart version), the default `backend.image.tag` is the matching release, so the
    skew only affects installs that override the tag. A chart taken from `main` between
    releases still defaults to the previous pre-release image, which does not read the new
    names. Set `backend.image.tag` to an image built from the same commit or later.

!!! note "Clear stale card assignees after upgrading"
    Assignable and notification member sets now follow the same role-resolution ladder as board
    access: an explicit board membership row takes precedence over group-inherited membership,
    and the nearest ancestor group decides a group-inherited role. Cards assigned before the
    upgrade are not changed automatically. Run the cleanup once, preview first, to clear
    assignees who have board access but are not assignable (viewers, for example):

    ```bash
    docker compose -f docker-compose.prod.yml run --rm backend \
      python manage.py clear_viewer_assignees --dry-run
    docker compose -f docker-compose.prod.yml run --rm backend \
      python manage.py clear_viewer_assignees
    ```

    Add `--board <id>` to limit it to one board. Assignees who are no longer members of a
    board are left in place (#1866).

!!! warning "Helm: the placeholder PostgreSQL password fails the render"
    As a deliberate default change before 1.2 GA, `helm install`, `helm upgrade`
    and `helm template` now **fail** while the bundled PostgreSQL
    (`postgresql.enabled=true`, the default) has an empty or placeholder
    (`visiban`) `postgresql.auth.password`. The check is skipped only when both
    `postgresql.auth.existingSecret` and `secret.existingSecret` are set. Earlier
    chart versions refused the placeholder only with `postgresql.subchartEnabled=true`
    (#1864). The subchart mode itself does not render at all today because of an
    unrelated values collision tracked in #1911.

    **Who is affected.** Installs that never set `postgresql.auth.password`. An
    external database (`postgresql.enabled=false`) and installs that already set
    their own password are not affected. If you are affected, `helm upgrade` stops
    before anything is applied and the running release keeps serving.

    **What to do, before upgrading.** PostgreSQL reads `POSTGRES_PASSWORD` only
    when it first initializes an empty data directory, so changing the value in
    Helm alone would leave the database on the old password and the backend
    unable to connect. Work in this order:

    1. Back up the database:

        ```bash
        kubectl -n visiban exec <release>-postgresql-0 -- \
          pg_dump -U visiban visiban > visiban-backup-$(date +%Y%m%d%H%M%S).sql
        ```

    2. Prove the new render passes **before** touching the database. Use the new
       password and every other change this section lists (for example the
       `redis:` to `valkey:` translation, below). Use your values file with
       `-f`, not `--reuse-values`:

        ```bash
        NEW_PW="$(openssl rand -hex 24)"
        helm upgrade <release> helm/visiban -n visiban -f my-values.yaml --dry-run \
          --set-string postgresql.auth.password="$NEW_PW" <your other flags>
        ```

    3. Change the database role, then upgrade with the same value and flags:

        ```bash
        kubectl -n visiban exec -i <release>-postgresql-0 -- \
          psql -U visiban -d visiban -v pw="$NEW_PW" <<'SQL'
        ALTER ROLE visiban PASSWORD :'pw';
        SQL
        helm upgrade <release> helm/visiban -n visiban -f my-values.yaml \
          --set-string postgresql.auth.password="$NEW_PW" <your other flags>
        ```

    Use the role name from `postgresql.auth.username` if you changed it, and
    prefer a gitignored values file to `--set-string` for the password.

    **The window.** Between the `ALTER ROLE` and the end of the `helm upgrade`
    rollout, running backend pods still hold the old password in their
    environment, so any new database connection (a new worker, a restart, a
    scheduled-job pod) fails. Run both steps back to back.

    **Rollback.** If the upgrade fails, restore the previous password with
    `ALTER ROLE <username> PASSWORD '<previous>'`; the existing pods keep working.
    The same applies if you use `helm upgrade --atomic` (which rolls the release
    back on failure) or run `helm rollback` later: both put the chart-managed
    `database-url` back to the old password, so change the role back to match
    first.

    **`postgresql.auth.existingSecret`** does not feed the backend's database URL:
    the chart builds it from `postgresql.auth.password`. It clears the check only
    together with `secret.existingSecret` supplying a matching `database-url` (see
    [Kubernetes](../getting-started/kubernetes.md)). Chart behavior is tracked in
    #1910.

!!! note "Deactivate-user `transfers` errors are now keyed by item index"
    On `POST /api/v1/admin/users/{id}/deactivate/`, a `400` for a malformed `transfers` item now
    returns `transfers` as an object keyed by zero-based item index, listing only the invalid
    items, for example `{"transfers": {"1": {"board_id": ["A valid integer is required."]}}}`.
    Through 1.2.0-beta.1 it was an array with one entry per item, with `{}` for valid items. Valid
    requests and every other endpoint are unchanged. This is a deliberate exception to the
    1.x response-compatibility rule: Django REST framework 3.18 makes the object shape its
    default and removes the array shape in 3.20, so it changes in a 1.2 pre-release rather than
    in a later minor. Scripts that read these errors by array position must read them by
    index key instead; see [Admin API](../api/admin.md#post-apiv1adminusersiddeactivate) (#1846).

!!! note "Attachment files are now removed when their card, column, swimlane or board is deleted"
    Before 1.2, deleting a card (or its column, swimlane or board) left its attachment files in
    media storage. From 1.2 they are removed once the delete commits. Files already left behind
    by earlier deletes are not touched by the upgrade. To find and remove them, run
    `purge_orphaned_attachments` (a dry run unless you pass `--yes`); see
    [Removing orphaned attachment files](media-security.md#removing-orphaned-attachment-files)
    (#1817).

!!! note "OpenAPI component names changed for `/auth/user/` and the dj-rest-auth responses"
    The rename itself changes no field, but a client generated from the OpenAPI schema names these
    types differently, so regenerating one renames them. Other 1.2 changes to these shapes are in
    the changelog and the API docs. The 1.2 names are the contract from
    1.2.0 on; the 1.1 names are not pinned back (#1834).

    | 1.1 component | 1.2 component | Used by |
    |---|---|---|
    | `User` | `CurrentUser` | `GET`/`PUT`/`PATCH /api/v1/auth/user/` response |
    | `UserRequest` | `CurrentUserRequest` | `PUT /api/v1/auth/user/` body |
    | `PatchedUserRequest` | `PatchedCurrentUserRequest` | `PATCH /api/v1/auth/user/` body |
    | `Login`, `Registration` | `Token` | `POST /api/v1/auth/login/` and `registration/` response |
    | `VisibanPasswordReset` | `PasswordResetResponse` | `POST /api/v1/auth/password/reset/` response |
    | `PasswordResetConfirm` | `PasswordResetConfirmResponse` | `POST /api/v1/auth/password/reset/confirm/` response |

    `User` still exists in 1.2 as the `POST /api/v1/auth/choose-username/` response; it is just
    no longer what `/auth/user/` returns. Request component names for login, registration, and
    password reset are unchanged.

!!! note "Instance flags: read them from `site-config`"
    `GET /api/v1/auth/site-config/` now returns `git_lens_enabled`, `maintenance_mode` and
    `maintenance_message`, alongside the `demo_mode` and `demo_next_reset_at` it already had.
    The `/auth/user/` copies of `maintenance_mode`, `maintenance_message`, `demo_mode` and
    `demo_next_reset_at` are still returned, but they are deprecated. A client built against a
    1.2 beta should read them from `site-config`. `git_lens_enabled` stays on `/auth/user/` as a
    normal field. See [Frozen instance flags](../api/authentication.md#frozen-instance-flags-on-authuser)
    (#1872).

!!! warning "Status codes changed on board-scoped and member routes"
    Requests from a caller with no access to a board now return `404 Not Found` on every
    board-scoped route, the same answer as for a board that does not exist; `403 Forbidden`
    stays for a caller whose role is too low on a board they can see. A `DELETE` of a member
    who has no membership on the board or group returns `404` instead of `204`. User search
    and adding a board member match active users only.

    **Check any integration, script, or automation** that treats `403` as "no access" on a
    board route, or that relies on `DELETE .../members/{user_id}/` succeeding for a user who
    is not a member. See [Security Invariants](../development/security-invariants.md)
    (Rules 5 and 7) (#1670).

!!! warning "Behavior change: registering an address that is already in use returns 201 from the API with mandatory verification"
    With `EMAIL_VERIFICATION=mandatory`, `POST /api/v1/auth/registration/` now answers a
    registration for an address that is already in use (another account's email or username,
    or an address another account has verified) with `201 Created` and
    `{"detail": "Verification e-mail sent."}`, the same response as any other registration.
    Earlier releases answered `400`. The server-rendered `/accounts/signup/` form likewise
    behaves as it does for a new address (the usual "verify your email" page) instead of
    showing an "already in use" error. No account is created or changed, and the address
    receives an "account already exists" email with a password-reset link instead of a
    confirmation link. With `EMAIL_VERIFICATION=optional` (the default) or `none`, the
    existing `400` response is unchanged.

    **Check any integration, script, or client** that treats `400` as "this email is already
    registered" in `mandatory` mode, or that treats `201` as proof a new account was created.
    Neither holds any more. See
    [An address that is already in use](../api/authentication.md#an-address-that-is-already-in-use)
    (#1877).

!!! warning "Group and board placement now require group admin; emailed invites are bound to an address"
    - **Group create with a `parent` you do not administer** (`POST /api/v1/groups/`) now
      returns `400` with a `parent` error instead of `403`; an unknown parent id returns the
      same `400`. Changing `parent` on `PATCH`/`PUT /api/v1/groups/{id}/` and setting `group`
      on a board follow the same rule: admin of the target group is required, and an unknown
      group and an unauthorized one get the same `400`.
    - **Moving or importing a board into a group now requires group admin**, matching board
      creation in a group. A group the caller cannot see (or that does not exist) returns
      `404`; a visible group the caller does not administer returns `403`. Site admins with
      all-content access may still move boards into groups without a membership.
    - **Emailed invites are bound to the address they were sent to.** Redeeming one requires
      an account with that address (under `EMAIL_VERIFICATION=mandatory`, a verified one); a
      mismatch is refused with `invite_recipient_mismatch` and the invite stays unused.
      Shareable invite links and emailed invites sent before upgrading are unchanged.

    **Check any script or integration** that treats `403` as the answer for an unadministered
    `parent` group (now `400`), or that moves or imports boards into groups without being an
    admin of them (now `403` for a visible group, `404` for one the caller cannot see) (#1678,
    #1703).

!!! warning "Shareable group invite links can no longer grant admin and always expire"
    A shareable group invite link is a bearer credential: anyone who holds it can join with its
    role. Creating one (`POST /api/v1/groups/{id}/invite-links/` and the **New link** form) now
    follows the same rule as board invite links:

    - **`role: "admin"` is refused** with `400`. A group admin is board admin on every board in
      the group and its subgroups, so no invite grants admin any more, shareable or
      [emailed](../features/groups.md#emailing-an-invite-link). Change a member's role after they
      join.
    - **Every new link expires.** `expiry_days` is 1 to 30 and defaults to 7 when omitted;
      `null` (never expires) and values over 30 are refused with `400`. The form offers 1, 7 or
      30 days and no longer offers **Never**.

    Emailed invites cannot grant admin either. An emailed invite with the `admin` role that was
    sent before the upgrade is not revoked by the migration but is refused when opened, joined or
    used to register; send a new one as a member. Group admins who joined through an emailed admin invite before the upgrade keep their role; review your group admins if that matters to you. **Upgrading also cleans up links created earlier**
    (migration `groups.0023`, #1940), so no operator step is needed. Only shareable links that are
    still active and have not been used are touched:

    - An existing **admin** link is **revoked**. It is not downgraded to member. To give someone
      admin, change their role after they join.
    - An existing link with **no expiry** now expires **7 days after the upgrade**. Create a
      fresh link if you need one beyond that, up to 30 days.

    Links that already have an expiry keep it. People who already joined through a link keep
    their role. A link that already expires more than 30 days out keeps that expiry and can outlive
    the 30-day cap on new links; the upgrade only caps links with no expiry. Revoked links do not
    appear in a group's **Invite links** panel. To list the revoked admin links across the
    instance:

    ```bash
    docker compose -f docker-compose.prod.yml run --rm backend \
      python manage.py shell -c "
    from groups.models import GroupInviteLink
    links = GroupInviteLink.objects.filter(delivery='link', role='admin', is_active=False, used_at__isnull=True)
    for group_name, prefix in links.values_list('group__name', 'prefix'):
        print(group_name, prefix)
    "
    ```

    **Check any script or integration** that creates group invite links with `role: "admin"`,
    `expiry_days: null` or `expiry_days` over 30 (#1727).

!!! note "Checklist items with no recorded creator are now moderator-only"
    Collaborators and members can edit or delete only the checklist items they created, the
    same rule comments and attachments follow. Items with no recorded creator used to be open
    to every collaborator; since 1.2 only admins and moderators can edit or delete them. This
    affects items created before migration 0044 and items whose creator's account was deleted.
    No operator action is needed. Imported items now record the importing user as creator.
    See [checklist items](../api/cards.md) in the API reference (#1943).

!!! warning "Analytics extension panels without `min_role` are now admin-only"
    Panels registered through `ANALYTICS_EXTENSIONS` (enterprise or third-party analytics
    add-ons) now declare the lowest board role that may see them with a `min_role` attribute.
    The board summary drops every panel above the caller's role before calling it. A panel
    with no `min_role`, or an invalid one, is shown to board admins (and users with
    all-content access) only. Before 1.2 every member, viewers included, received every panel
    unless the panel checked the role itself.

    **If you run an analytics extension**, upgrade it to a version that sets `min_role`, or
    set it yourself (`my_panel.min_role = "viewer"` for a panel every member should see).
    Until then, non-admin members stop seeing its panels. Installs with no extensions are
    unaffected. See [panel visibility by role](../api/boards.md#panel-visibility-by-role)
    (#1826).

!!! note "A board with an unrecognized export setting is now admin-only for export"
    A board's `export_min_role` setting accepts `viewer`, `collaborator`, `member` or `admin`.
    Before 1.2 a stored value outside that set (written directly to the database, never through
    the API) let every role with read access export. It now means admins only, and migration
    `0086` rewrites such a value to `admin` (a blank value becomes `viewer`). **On an affected
    board, export narrows from everyone with read access to board admins.** Boards set through the
    API or the Board Settings dialog are not affected. Owners and site admins can always export.
    To restore wider access, set the threshold again in Board Settings (#1725).

!!! note "Deleted cards keep their movement history; movements are read-only in the admin"
    Hard-deleting a card (or the column or swimlane it is in) no longer deletes its movement
    history. The records stay on the board's **History** view under the card's original UID
    and title; deleting the whole board still removes them. In the Django admin, movement
    records can now only be viewed — add, edit and delete are gone. Summary and Analytics
    numbers are unchanged. See [Card History](../features/card-history.md#deleted-cards-keep-their-history) (#1469).
    A deleted card's title and movement notes now stay visible to the board's members until
    the board is deleted. Since 1.2, a superuser can erase them on request with the
    `purge_card_history` management command; see
    [Card History Retention](card-history-retention.md) (#1797).

    Migrations `boards/0078`–`0081` add three columns to `card_movements`, make `card_id`
    nullable without rebuilding its foreign key, backfill the new columns in committed batches
    of 5,000 rows (`0080`, resumable if interrupted), and build one index concurrently
    (`0081`). None of them takes a long table lock. The backfill takes time proportional to
    the size of `card_movements`.

    **Installs that migrate while the old release is still serving:** this covers the
    documented Docker Compose steps and Helm (the new pod migrates in its init container while
    the old pod serves), not only multi-replica setups. The old release can record a move after
    `0080` has run. That move still appears in the board's History view, but it has no stored
    board or card snapshot yet. Once the rollout completes, run
    `python manage.py backfill_card_movement_snapshots` once. It is idempotent. If such a card
    is hard-deleted by the new release before the command runs, the delete fills in the record
    itself, so nothing is left behind. A card deleted by a pod still on the previous release
    takes its history with it, as before the upgrade.

    **During the rollout, deleting a board** from a pod still on the previous release may fail
    with a server error when the board holds history of cards the new release already
    hard-deleted. Nothing is lost; retry once the rollout completes.

    **Rolling back past `boards/0079`** is refused while any deleted card's history exists,
    because restoring `card_id NOT NULL` would mean deleting that history. The error message
    names the `DELETE` that lets the rollback proceed, if you intend that.

!!! note "Secrets are read verbatim — a leading `$` is no longer a variable reference"
    `DJANGO_SECRET_KEY`, OAuth/OIDC client IDs and secrets, `EMAIL_HOST_PASSWORD`,
    `VISIBAN_SECRET_ENCRYPTION_KEY`, `DEMO_ADMIN_PASSWORD`, and `DEMO_MEMBER_PASSWORD` are now
    used exactly as written. Before 1.2, a value starting with `$` was treated as a reference
    to another environment variable and silently replaced by that variable's value (or an
    empty string). If you relied on that substitution, set the real value instead; a secret
    that merely starts with `$` now works as written (#1362). See
    [Configuration](configuration.md#docker-compose).

!!! note "New `DEMO_*` variables are opt-in"
    1.2 adds demo mode (`DEMO_MODE`, `DEMO_LOGIN_USERNAME`, `DEMO_RESET_SCHEDULE`, and
    related variables). `DEMO_MODE` defaults to `false`, so existing installs are unchanged
    and need no action. Never enable it on an instance with real data. See
    [Demo mode](configuration.md#demo-mode).

!!! warning "Edits to seeded system board templates are overwritten"
    `boards/0054` (#1115) rewrites `columns_json` for the built-in system templates, matched by
    slug, to correct drift in `project_delivery` and `legal_compliance` and to add `is_done`
    flags. Any admin edit to a seeded system template's columns is lost on upgrade, and
    rolling the migration back restores the original constants, not your previous values.
    Board templates have no admin page and no write API (`GET /api/v1/boards/templates/` is
    read-only). Before upgrading, save the `columns_json` of any customized system template from
    that endpoint, only as a reference for which columns you changed. Do not re-apply it
    verbatim: it lacks the `is_done` flags and the corrected `project_delivery` and
    `legal_compliance` columns that `boards/0054` adds. After upgrading, read the new
    `columns_json` (from the endpoint or `manage.py shell`), re-apply only your own edits on top
    of it, and keep `is_done: true` on terminal columns. In `manage.py shell`:
    `t = BoardTemplate.objects.get(slug="..."); t.columns_json = [...]; t.save()` (import
    `BoardTemplate` from `boards.models`). Existing boards are not affected; only
    future board creations and the template preview use these rows.

!!! note "Very large `users` tables"
    `accounts/0030` runs an `UPDATE` on `users` in the same transaction as its column
    additions, so the table lock (`ACCESS EXCLUSIVE`) is held while the update runs. This is
    fast at typical sizes. `accounts/0036` is a standalone data migration that only
    row-locks superuser rows, which is negligible. On installs with millions of user rows, run
    `migrate` during a maintenance window.

!!! warning "Browser WebSocket connections check the Origin header"
    A WebSocket handshake that carries an `Origin` header must match `CORS_ALLOWED_ORIGINS`,
    `CSRF_TRUSTED_ORIGINS`, or an exact host listed in `ALLOWED_HOSTS` (scheme and port are
    ignored). `ALLOWED_HOSTS` entries of `*` or with a leading dot (such as `.example.com`) are
    not applied to this check. **If your `ALLOWED_HOSTS` uses one of those entries, list your
    public origin (for example `https://boards.example.com`) in `CORS_ALLOWED_ORIGINS` or
    `CSRF_TRUSTED_ORIGINS` before upgrading; otherwise browser WebSocket connections are
    refused.** Clients that send no `Origin` header are unaffected. See the
    [WebSocket API](../api/websockets.md#connecting).

    With `DEBUG` off, `manage.py check` / `check --deploy` emits system-check warning
    `accounts.W002` when `ALLOWED_HOSTS` contains `*` or a leading-dot entry, no public
    origin is listed in `CORS_ALLOWED_ORIGINS` or `CSRF_TRUSTED_ORIGINS`, and no exact public host is
    listed in `ALLOWED_HOSTS`. Listing the origin clears it. Add `"accounts.W002"` to `SILENCED_SYSTEM_CHECKS` to accept the configuration.

!!! note "Group owners and last active admins cannot be removed or demoted"
    Removing a group member, or changing their role, now answers `400 Bad Request` when the
    member is the group's owner or its last active admin (deactivated admins do not count). Transfer ownership first, or make another
    member an admin. The response carries a machine-readable `code`: `group_owner_protected`
    for the owner, `group_last_admin` for the last active admin. Clients that remove or demote
    members should branch on `code` and show the response's `detail` message to people.
    See the [Groups API](../api/groups.md#members).

!!! note "Bad query parameters answer `code: \"invalid_query_param\"`"
    Refused query parameters (listed under [Error responses](../api/index.md#error-responses))
    now answer `400` with `{detail, code}` and `code: "invalid_query_param"`. On endpoints
    that existed in 1.1 the change is additive:
    a bad filter value on `GET /api/v1/boards/{id}/cards/` (`?assignee=x`) keeps its
    field-keyed entry (`{"assignee": ["Enter a number."]}`) and gains `detail` and `code`,
    and an unknown `event_types` group on the card timeline keeps `detail` and gains `code`.
    An `offset` above `2^62`, which was a `500` in 1.1, is now this `400`. Clients should
    branch on `code`. See [Error responses](../api/index.md#error-responses).

!!! note "`is_starred` omitted from WebSocket board and group events"
    `board.created`, `board.updated`, `group.created` and `group.updated` payloads now carry
    `is_starred` only for the user who made the change; every other subscriber receives the
    payload without the key. REST responses still always include it. Custom WebSocket clients
    must treat the key as optional and keep their local value when it is absent. See the
    [WebSocket API](../api/websockets.md).

!!! note "Superuser accounts normalized"
    `manage.py migrate` runs a one-time data migration (`accounts/0036`). On upgrade, existing
    superuser accounts are set to site admin with all-content access, matching how the
    application already treats superusers. All existing superuser accounts have both flags set
    after migrating. The migration is idempotent.

!!! warning "Docker Compose: re-render the nginx config to get the stale-`index.html` fix"
    The cache headers and the real-404 for missing `/assets/*` live in
    `nginx/active.conf.template`, which is a gitignored copy that only `./init-prod.sh` refreshes
    from `nginx/app.conf.template` / `nginx/app-http.conf.template`. A plain `git pull` +
    `pull` + `up -d` leaves nginx running the **old** config, so the fix is not active. After
    upgrading, run `./init-prod.sh` to re-render `nginx/active.conf.template`, then
    `docker compose -f docker-compose.prod.yml up -d --force-recreate nginx` (a plain `up -d`
    does not notice that the bind-mounted config content changed). Helm installs need no extra
    step.

    A browser that already holds a pre-fix `index.html` (browsers may reuse it heuristically
    without asking) can still show a blank page once after this upgrade. A hard reload fixes it
    for that visitor.

!!! note "Housekeeping for inactive accounts"
    `manage.py migrate` runs a one-time data migration (`groups/0018`) that removes personal
    access tokens and unused invite links belonging to inactive accounts. No operator action
    is needed; it is idempotent. A companion migration (`accounts/0039`) likewise removes the
    API auth tokens of inactive accounts.

!!! warning "WIP and weight limits now apply to card create, restore, and weight changes"
    Before 1.2, a column's `wip_limit` and `weight_limit` were checked only when a card was
    **moved** into it. They are now also checked when a card is created in the column
    (`POST /api/v1/boards/{id}/cards/` and the MCP `create_card` tool), restored into it from
    the archive (`POST .../cards/{id}/unarchive/`), or has its `weight` raised with `PATCH`,
    and when a card is saved in the Django admin. A request that used to return `201` or `200`
    into a full column now returns `409` with the same body a blocked move returns
    (`wip_limit_exceeded`, `wip_hard_blocked`, or `weight_limit_exceeded`), and nothing is
    written. Board admins can override a soft limit with the optional `?force=true` query
    parameter, exactly as on a move; with **Enforce WIP hard** on, nobody can. Lowering a
    card's weight, and editing any other field, is never blocked.

    **Check any integration, script, or automation that creates or restores cards** in columns
    with a WIP or weight limit: handle the `409`, raise the limit, turn enforcement off for
    that board, or (for a board admin's token) send `?force=true`. Board import (JSON, CSV,
    Trello) is not affected — it restores a board as exported, over its limits or not.
    Existing over-limit columns are left as they are. See
    [Field Enforcement](../architecture/field-enforcement.md) (#1428).

!!! warning "GitLab registry `:latest` no longer tracks `main` builds"
    Previously every `main` merge overwrote `registry.gitlab.com/visiban/visiban/backend:latest`
    and `frontend:latest` with an amd64-only build. `:latest` on the GitLab registry is now
    written only by stable release tags (multi-arch), matching GHCR, so it stays on the last
    stable release until the next stable tag. If you tracked GitLab `:latest` to follow `main`,
    switch to `:main` (amd64 only); short-SHA tags are still pushed for rollback. Pinned release
    tags and GHCR are unaffected. See [Container image retention](container-image-retention.md#gitlab-registry-latest-is-stable-only-main-publishes-main).

!!! warning "PostgreSQL driver: `psycopg2-binary` is replaced by `psycopg[binary]` (psycopg 3)"
    The backend now uses `psycopg[binary]` 3.3.6 instead of `psycopg2-binary`. No setting,
    environment variable, or `DATABASE_URL` value changes: Django selects the driver on its own.
    **Docker Compose and Helm installs need no action**, because the new image carries the new
    driver. Act only if you build your own image or run from source:

    - A custom image or virtualenv that pins `psycopg2-binary` in its own requirements file
      must switch to `psycopg[binary]`; `psycopg2` is no longer installed by
      `backend/requirements.txt` or `backend/requirements.lock`.
    - Reinstall `backend/requirements.txt` (or `requirements.lock`) in the virtualenv before
      you start the new release (#1252).

!!! warning "Sample board JSON files moved to `backend/boards/sample_boards/`"
    The sample board `.json` files moved from `sample-boards/` to `backend/boards/sample_boards/`
    so the backend image ships them. Raw links and `curl` commands that point at
    `sample-boards/<name>.json` (including copies of the examples from older docs) now return
    `404`; use `backend/boards/sample_boards/<name>.json` instead. The `.csv` files stay in
    `sample-boards/`. The files are also named without the
    "Template:" prefix, so an import is named "Imported: Sales Pipeline". See
    [Sample Boards](../getting-started/sample-boards.md#where-to-get-the-files) (#1452, #1450).

!!! note "Group nesting is capped at 6 levels (HTTP 400)"
    Creating a subgroup (`POST /api/v1/groups/`), or moving a group under a new `parent`
    (`PATCH`/`PUT /api/v1/groups/{id}/`), is refused with `400` when the resulting tree would
    be more than 6 levels deep. The body is a `parent` error: `Groups can be nested at most 6
    levels deep.` Group trees that were already deeper are left as they are, but cannot be
    extended. Check any script that builds deep group hierarchies. See
    [Subgroups](../features/groups.md#subgroups) (#1690).

!!! note "Emailed invites under `EMAIL_VERIFICATION=mandatory` are held until the address is verified"
    With `EMAIL_VERIFICATION=mandatory`, an account created from an emailed group or board invite
    now joins the group or board when the invited address is **verified**, not at sign-up. Until
    then the invite is held for that account and is not used up. An invite that is revoked or
    expires before the address is confirmed grants nothing. `optional` and `none` are unchanged. Only invites bound to an address that is not yet verified
    are held: emailed invites sent before the upgrade, and sign-ups whose OAuth provider reports the invited address as verified, still join at sign-up.
    Tell invitees to confirm their email address: they will not have that access until they do (#1704).

!!! note "Board cards list: `X-Total-Count` and `X-Truncated` headers, and `imported_from_username` on comments"
    - `GET /api/v1/boards/{id}/cards/` returns at most 200 cards per request, as before, but it
      no longer truncates silently. Every response carries `X-Total-Count` (the number of
      matching cards) and `X-Truncated` (`true` when more exist), and the optional `limit` and
      `offset` query parameters page past the cap. The body is still a plain JSON array, and a
      client that sends no paging parameters sees the same body. A client that must see every
      card should check `X-Truncated` and keep paging. A negative or non-integer `limit` returns
      `400` with `"code": "invalid_query_param"`. See the [Cards API](../api/cards.md) (#1724).
    - Comments created by a Trello or JSON board import are now posted under the user who ran the
      import, keep their original time, and keep the source's author name as text in the new
      `imported_from_username` field. The comments API, the MCP card resource, and JSON export
      carry the field, so a re-imported export keeps the original name (#1702).

!!! note "MCP SDK upgrade: some protocol-level responses changed"
    The MCP SDK behind `/mcp` moved from `mcp` 1.30.0 to 2.3.0. The URL, authentication, tools,
    and resources are unchanged, but a client that parses protocol errors will see these
    differences (MCP 2.3.0 was already in v1.2.0-beta.1, so this affects only people coming from a
    1.2 alpha):

    - An unknown method returns JSON-RPC error `-32601` (it was `-32602`).
    - A failed `resources/read` returns `-32603` (or `-32602` for an unknown URI) instead of `0`.
    - A request body over 4 MiB is rejected with `413`.
    - Transport-level errors carry `id: null` instead of `"server-error"`.

    The main changes are listed in the [MCP API reference](../api/mcp.md#protocol-errors-and-limits).

!!! note "MCP tool errors now set `isError`, and `assignee_email` left the schema"
    Both changes are new since v1.2.0-beta.1, so clients written against any 1.2 pre-release see
    them (#2004):

    - A tool error (a WIP limit, a permission or scope denial, a not-found id, a validation
      error, a throttle denial) now comes back with `isError: true`. It was `isError: false`. The
      `{"error": {...}}` payload is unchanged and still in `structuredContent.result` and the text
      block. An agent framework that checks `isError` now sees these as failures. See
      [Result envelope](../api/mcp.md#result-envelope).
    - `create_card` and `update_card` no longer list `assignee_email` in their input schema.
      Coming from v1.2.0-beta.2 through rc.1, nothing else changes: a non-null value (including
      `""`) is still rejected with a `validation_error`, now as an `isError: true` result, and an
      explicit `null` is still ignored. Coming from v1.2.0-beta.1 or earlier, where
      `assignee_email` looked up the assignee by email, that lookup is gone: a non-null value is
      rejected and nothing is written. Send `assignee` (a username) instead.

!!! note "Board import default name changed"
    `POST /api/v1/boards/import/` called without a `name` field now names the new board
    `Imported: <name>` — the `name` in a JSON file, or the filename without its extension
    for a CSV file — and appends ` - 1`, ` - 2`, ... when that name is already taken.
    Previously a JSON import used the file's `name` unchanged and every CSV import was
    named `Imported Board`. Any script or test that finds an imported board by the file's
    name must now send `name` explicitly, which is still used exactly as given. See
    [Default board name](../api/boards.md#default-board-name) (#1446).

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

!!! warning "Personal access tokens now carry scopes — pre-1.2 tokens keep full authority until rotated"
    Migration `accounts/0026_pat_scopes` adds two nullable columns (`scopes`,
    `last_used_scope`) to personal access tokens for the new
    [token scopes](../features/personal-access-tokens.md#scopes) feature. It is a
    metadata-only `AddField` migration with no backfill, so it is zero-downtime — but
    unlike the other 1.2 migrations, what it enables changes real request-time behavior:

    - **Existing tokens keep working unchanged across the entire REST API**, including the
      admin endpoints if the owner is a site administrator. Their `scopes` column is `NULL`
      ("legacy" authority), not an empty scope list, and upgrading does not narrow or break
      a running integration.
    - **A token can no longer change a profile's email address.** `PATCH /api/v1/auth/me/`
      and `PATCH`/`PUT /api/v1/auth/user/` refuse an `email` change with `403 Forbidden` when
      the request is authenticated with a personal access token or the login API token; an
      interactive (signed-in) session is required. Other profile fields are unaffected, and a
      request that omits `email` or sends the current value unchanged still succeeds.
    - **A session also needs the current password to change the email** of an account that
      has a password: the same requests must include the new optional `current_password`
      field, or they get `400` with a `current_password` error. Accounts that sign in only
      through an identity provider are not asked (they need a recent provider sign-in
      instead, below), and requests that don't change `email` are
      unaffected. Custom clients that let users change their email should send the field
      (see [Authentication API](../api/authentication.md#patch-apiv1authme)).
    - **The previous address is notified of an email change.** Whenever an account's email
      changes to a different address, by any route, the previous address receives a short
      notice. Make sure outbound email is configured if you rely on it.
    - **Accounts without a password get address and first-password notices.** On an
      account that signs in only through an identity provider, adding or confirming an
      email address sends a short notice to the account's current email, and setting a
      first password, from a reset link or by the signed-in user, sends one to the account's email address and every
      verified address on the account.
    - **Connecting a sign-in provider asks for the password first.** When an account that
      has a password connects a provider from Settings, it is asked to confirm that password
      once, on allauth's `/accounts/reauthenticate/` page. In the Visiban app the user then
      clicks **Continue** on the next page and goes through the provider a second time; no
      second **Connect** click in Settings is needed. These pages are served by the backend and are unbranded. Accounts without a password are not asked; their primary address receives a
      short fixed-text notice when a provider is connected. Signing in with a provider is
      unaffected (see [Connected accounts](authentication.md#connected-accounts-and-email-collisions)).
    - **Setting a first password needs a recent provider sign-in.** On an account without
      a password, `POST /api/v1/auth/change-password/` and `POST /api/v1/auth/password/change/`
      set a first password only when the session signed in through one of the account's
      providers in the last five minutes; otherwise they answer `403` with
      `"code": "recent_login_required"`.
      The same applies to changing the email of an account without a password
      (`PATCH /api/v1/auth/me/`, `PATCH`/`PUT /api/v1/auth/user/`, and adding or making
      an address primary on `/accounts/email/`, #1932). Addresses already on an account are
      not changed by the upgrade; an operator who wants to review them can do so under
      **Email addresses** in the Django admin.
      Accounts with a password are unaffected (see
      [Connected accounts](authentication.md#connected-accounts-and-email-collisions)).
    - **Existing tokens are refused by the MCP server**, which now requires the `mcp:read`
      scope. Any MCP client authenticating with a pre-1.2 token stops connecting after the
      upgrade — create a new token with `mcp:read` (tick it in Settings > Access Tokens, or call
      `POST /api/v1/auth/tokens/` with `"scopes": ["mcp:read"]`) to reconnect it.
      The MCP server is also **off by default**: `/mcp` returns `404` until an operator sets
      `MCP_SERVER_ENABLED=true` on the backend. Request throttles are tunable with
      `MCP_THROTTLE_READ_RATE` (default `300/min`), `MCP_THROTTLE_COMPUTE_RATE` (default
      `30/min`), and `MCP_THROTTLE_PREAUTH_RATE` (default `30/min`). See the
      [MCP server guide](../features/mcp-server.md).
    - **New tokens default to `["read", "write"]`** when `POST /api/v1/auth/tokens/` is
      called without a `scopes` list — previously a newly created token silently carried
      its owner's full authority, including `admin` for a site administrator. Any script or
      pipeline that creates its own tokens and relies on that inherited admin authority must
      now request the `admin` scope explicitly.

    See [Personal Access Tokens → Scopes](../features/personal-access-tokens.md#scopes) for
    the full scope table and non-hierarchical scope semantics.

Migration `accounts/0028_admin_action_log` creates the `admin_action_logs` table for the new
[admin action log](admin-panel.md), which records who changed maintenance mode, registration
mode, or the uploads switch, and when. It is a single `CreateModel` (including its two
indexes) against a brand-new table, so it needs no concurrent build and is zero-downtime.

Migration `accounts/0029_site_email_settings` creates the `site_email_settings` singleton
table backing **Admin → Settings → Email** and adds a `help_text`-only `AlterField` to
`AdminActionLog.action` (no schema change). Every column defaults to a value equivalent to
"unset," and `config_source` defaults to `env`, so an upgraded instance keeps reading SMTP
settings from environment variables until an admin explicitly switches the source over in the
UI (#306).

Migration `accounts/0030_notification_email_preferences` adds five nullable-default boolean
columns to the user table for per-event [email notifications](../features/notifications.md)
(`notif_stale` plus four `email_notif_*` toggles), all defaulting to `False`. A same-migration
data backfill copies each user's existing `notif_due_soon` value into the new `notif_stale`
column — before 1.2 that flag only ever gated staleness alerts, so this preserves everyone's
existing opt-in under its new, more accurately named field. Companion migration
`boards/0060_notification_due_soon_action_type` adds the `"due_soon"` value to
`Notification.action_type`'s choices; `choices` is enforced by Django/DRF only, so this emits
no DDL. One behavior change worth flagging to users, not the database: because
`email_notif_due_soon` now drives the real due-date email, anyone who previously had **Due
date approaching** on (which historically only produced staleness alerts) starts receiving the
24-hour due-date email too — see the note in
[Notifications](../features/notifications.md) if you need to tell your users.

Migration `accounts/0031_user_pending_email_address` adds a nullable foreign key,
`pending_email_address`, to the user table for the new
[pending email-change tracking](../features/index.md#user-settings) feature (#1273). It is a
plain `AddField` with `db_index=False` — no index is built under this migration's table lock.
Companion migration `accounts/0032_user_pending_email_addr_idx` adds the partial index backing
that column, using `CREATE INDEX CONCURRENTLY` (via `visiban.db_operations`, `atomic = False`)
so it does not block reads or writes while it builds, per the
[zero-downtime migration rules](#zero-downtime-migration-rules) above. Every existing account
starts with no pending change, so neither migration alters existing behavior.

Migration `accounts/0033_add_user_email_upper_index` adds a functional index on
`Upper(email)` to the user table, closing a case-insensitive email-collision gap (#1222) —
two accounts could otherwise register emails that differ only by case. Because `users` is a
populated table, it is hand-edited to use `CREATE INDEX CONCURRENTLY` (via
`visiban.db_operations`, `atomic = False`) instead of the autodetector's plain `AddIndex`, so
it does not lock reads or writes while it builds.

Migration `accounts/0034_user_email_notif_comment_added` adds one more defaulted boolean
column, `email_notif_comment_added`, to the user table — the email opt-in for the
**Comment on a watched card** notification (#1295). It defaults to `False` for every user,
so an upgrade does not start emailing anyone; like the other `email_notif_*` columns it is a
metadata-only `ADD COLUMN` on PostgreSQL 11+ with no index to build.

Migration `boards/0052_board_show_wip_at_limit` adds one nullable-default boolean column
(`show_wip_at_limit`) to `boards`. It is off by default, so existing boards render exactly as
before; board admins opt in per board from **Board Settings → Rules → Limit enforcement**
(#973).

Migration `boards/0054_fix_board_template_drift` is a data migration that overwrites the
`columns_json` (and adds the previously-missing `is_done` flags) on the built-in
`BoardTemplate` rows, correcting two templates whose stored preview had drifted from what
board creation actually produced (#1115). It touches only the template rows read by `GET
/api/v1/boards/templates/` and by template selection at board-creation time — no existing
board, column, or card is altered, since boards have no foreign key back to the template they
were created from.

Migration `boards/0055_add_card_board_updated_idx` adds a partial index on `Card(board,
-updated_at)` backing the new [`GET /api/v1/cards/`](../api/cards.md) cross-board query
endpoint (#1112). Unlike most 1.2 migrations, this one touches the existing, likely-large
`cards` table — it uses `CREATE INDEX CONCURRENTLY` (via `visiban.db_operations`,
`atomic = False`) specifically so it does not take a lock that blocks reads or writes while it
builds, per the [zero-downtime migration rules](#zero-downtime-migration-rules) above.

Migration `boards/0056_board_event_feed` creates the `board_events` append-only table backing
`GET /boards/{id}/events/`, the new [board change feed](../api/events.md) that lets an
external consumer resume after a dropped WebSocket instead of re-fetching `/full/` (#1114). It
is a `CreateModel` of a brand-new table (both indexes built with it), so it needs no
concurrent build. Nothing on `boards` or `cards` is touched. Events are retained for
`BOARD_EVENT_RETENTION_DAYS` days (default 30) — see `prune_board_events` under
[Scheduled Jobs](scheduled-jobs.md) below.

Migration `boards/0057_add_custom_fields` creates the `custom_field_definitions` and
`custom_field_values` tables for the new [custom fields](../features/custom-fields.md)
feature (#371). Migration `boards/0058_add_card_relations` creates the `card_relations` table
for the new [card relations](../features/card-relations.md) (**blocks** / **relates to**)
feature (#449). Migration `boards/0061_add_card_external_ref` creates the
`card_external_refs` table for the new
[pull/merge request link](../features/card-links.md) feature (#352). All three are
`CreateModel` operations — including their indexes, unique constraints, and check
constraints — against brand-new tables, so none needs a concurrent build and none touches
`boards` or `cards`. All three ship backend-only in 1.2 unless their linked feature page says
otherwise.

Migration `boards/0062_notification_comment_added_action_type` adds the `"comment_added"`
value to `Notification.action_type`'s choices (#1277). As with `0060` (`due_soon`), `choices`
is enforced by Django/DRF only, so this is a state-only `AlterField` that emits no DDL at
all — `sqlmigrate boards 0062` prints `(no-op)`. No existing value changes meaning or
disappears; see [Notifications](../features/notifications.md) if you need to tell API clients
that switch on `action_type` to fall through to a generic rendering for an unrecognized value.

Migration `boards/0069_board_show_row_chip_field_names` adds one boolean column,
`show_row_chip_field_names`, to `boards` (#1418). It defaults to `True` with a database-level
default as well as the Django one, so existing boards keep showing field names on swimlane row
chips, and a not-yet-upgraded pod that creates a board during a rolling deploy (its `INSERT`
omits the column) still succeeds. It is a metadata-only `ADD COLUMN` on PostgreSQL 11+ with no
index to build. Board admins can turn names off per board from **Board Settings → Swimlane
fields**.

Migrations `git_lens/0001_initial` and `git_lens/0002_alter_lensconnection_column_dim`
create the entirely new `git_lens` app and its `LensConnection` table for
[Issue Board Lens](../features/issue-board-lens.md) (experimental, off by default —
enabled per instance with `GIT_LENS_ENABLED=true`). `0001` is a single `CreateModel`
against a new table; `0002` only changes the `column_dim` field's Python-level default
(`"status"` → `"pipeline"`), which is a state-only `AlterField` with no DDL. Neither
migration touches `boards` or `cards`, and an instance that leaves `GIT_LENS_ENABLED` unset
(the default) sees no behavior change from either.

!!! warning "Compose: `DOMAIN` must be listed in `ALLOWED_HOSTS`"
    The production Compose backend healthcheck now sends `Host: $DOMAIN` instead
    of `Host: localhost`. An install whose `ALLOWED_HOSTS` holds `localhost` or
    an alias but not the exact `DOMAIN` value never turns healthy after the
    upgrade, and nginx (which waits on it) does not start. Check that
    `ALLOWED_HOSTS` in `.env` contains `DOMAIN` before running `up -d`.

!!! warning "Helm: `ALLOWED_HOSTS` no longer includes `localhost` / `127.0.0.1`"
    The chart used to append `127.0.0.1,localhost` to `backend.settings.allowedHosts`.
    The frontend nginx accepts any `Host` and forwards it, so that let any client
    reaching the frontend Service directly (NodePort, LoadBalancer, or a host-less
    Ingress rule) send `Host: localhost` and be accepted, which defeats pinning
    `ALLOWED_HOSTS` to your public domain. The rendered `ALLOWED_HOSTS` is now
    exactly `backend.settings.allowedHosts`. The chart's own probes and `helm test`
    pods now send the first configured host as their `Host` header, so they need
    no change. One thing you may notice: reaching the app through
    `kubectl port-forward` and browsing `http://localhost:...` returns HTTP 400
    (`DisallowedHost`). Send the real host instead:
    `curl -H "Host: boards.example.com" http://localhost:8080/`. Adding
    `localhost` back to `allowedHosts` now also needs an explicit opt-in; see the
    next note.

!!! warning "Helm: catch-all and loopback `allowedHosts` entries fail the render"
    `helm install`, `helm upgrade` and `helm template` now **fail** when
    `backend.settings.allowedHosts` contains any of these entries, matched
    per whole comma-separated entry and case-insensitively: `*`, `localhost`,
    `localhost.localdomain`, `ip6-localhost`, `127.0.0.1`, `0.0.0.0`,
    `[::ffff:127.0.0.1]`, the IPv6 loopback or unspecified address in any
    spelling (`[::1]`, `::1`, `[::]`, `[0:0:0:0:0:0:0:1]`), and a leading-dot
    form of any of these (`.localhost`, `.127.0.0.1`), which Django treats as
    matching the bare name too. The check is a best-effort list of the names
    copy-pasted dev configs carry, not a proof that every entry is public:
    other 127.0.0.0/8 addresses and broad suffixes such as `.local` are not
    checked, so keep the list to your real hostnames. A hostname that merely
    contains one of them, such as `localhost.example.com`, is not affected (#1360).

    **Why.** The frontend nginx accepts any `Host` and forwards it. With `*`,
    Django accepts every `Host`. With a loopback entry, any client that reaches
    the frontend Service directly (NodePort, LoadBalancer, or a host-less Ingress
    rule) can send `Host: localhost` and be accepted. Either way the
    password-reset links Visiban emails and its cache keys can be poisoned. That
    is the same exposure the previous note closed for the entries the chart used
    to append. This note covers the entries an operator adds themselves.

    **Who is affected.** Only values files that list one of those entries. The
    chart's default and shipped values files do not. If yours does, `helm upgrade`
    stops before anything is applied, the running release keeps serving, and the
    error names the offending entries. Fix it one of two ways:

    - Remove the entry and list only your real hostname(s). For
      `kubectl port-forward`, send the real `Host` header instead of adding `localhost`.
    - If you knowingly need the entry, for example to browse the app through
      `kubectl port-forward`, or because a strict Ingress already rejects every
      other host, opt in explicitly:
      `--set backend.settings.allowUnsafeHosts=true`. The install and upgrade
      notes then print a warning that names the entries on every run. The opt-in
      is refused when `demo.enabled` is true, because a public demo has no reason
      to need it.

    **Why a hard fail and not a warning.** The chart already fails the render on
    an empty or placeholder `allowedHosts`, and this check follows that rule.
    A warning would appear only in Helm's install/upgrade notes, which GitOps
    tools (Argo CD, Flux) and `helm template | kubectl apply` never show, so
    those installs would keep the entry without anyone seeing a message. The
    explicit opt-in keeps the upgrade a one-flag change for anyone who needs the
    entry. Chart 1.1.0 already appended `localhost`/`127.0.0.1` itself, so a 1.1
    values file had no reason to list them. Adding them yourself was the
    documented port-forward workaround only in the 1.2.0 pre-releases
    (alpha.3 onward), so the fail mainly reaches pre-release installs and
    values files that use `*`.

!!! warning "Helm: give `externalDatabase.password` verbatim"
    The chart now percent-encodes the database username and password when it
    builds the connection URL, so a password containing `/` no longer breaks it.
    If you percent-encoded `externalDatabase.password` (or
    `postgresql.auth.password`) by hand to work around that, put the plain value
    back before `helm upgrade` — otherwise it is encoded twice and
    authentication fails.

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
    0.6.0, #1210), `frontend.securityContext.pod` / `.container` (chart
    0.7.0, #1224).

!!! note "Helm: migrations now run in an init container, not a hook Job"
    Database migrations moved from a `pre-install`/`pre-upgrade` hook Job to a `migrate` init
    container on the backend `Deployment`, serialized across replicas by a PostgreSQL advisory
    lock (`manage.py migrate_with_lock`). This fixes a fresh `helm install` on the chart's
    default values, which the hook Job broke — Helm runs pre-install hooks before creating any
    release resource, so the hook tried to reach the bundled PostgreSQL Service before it
    existed.

    No values change is required — `helm upgrade` on an existing release picks this up
    automatically. What changes is how you **watch** an upgrade in progress: there is no
    longer a separate `visiban-migrate` Job to `kubectl logs`. See the
    [Zero-Downtime Upgrade Playbook](zero-downtime-upgrade.md#2-the-rolling-upgrade) for the
    new commands. Two new tunables, `backend.migrate.connectTimeout` (default 300s) and
    `backend.migrate.lockTimeout` (default 900s), replace anything you may have set for the
    old Job's `activeDeadlineSeconds`.

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
    up to `IMPORT_MAX_SIZE_BYTES` (default 25 MB, Helm:
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

    **No data migration required** — Valkey holds only ephemeral channel-layer and cache data (WebSocket group subscriptions and short-lived rate-limit keys). All of this is rebuilt automatically on startup. Redeploy:

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
        helm upgrade visiban helm/visiban -f my-values.yaml
        ```

        From a 1.1 release, upgrade with your values file rather than
        `--reuse-values`, after translating its `redis:` block as described
        below (it is not a plain rename). `--reuse-values` starts from the
        previous release's stored values, which have none of the keys 1.2 added;
        the 1.2 templates fail to render against them (a `nil pointer` error). See "Helm: values key `redis`
        renamed to `valkey`" and "Helm: bundled Valkey is no longer the Bitnami
        subchart" below.

        If you previously set `redis.enabled: false` and pointed `externalRedis.url` at an external Redis instance, the `externalRedis` key is unchanged, but the switch that turns the bundled cache off was renamed: set `valkey.enabled: false` (leaving `redis.enabled: false` also works, as a deprecated alias). See "Helm: values key `redis` renamed to `valkey`" below.

        If you used the bundled subchart, the in-cluster service DNS changes from `<release>-redis-master:6379` to `<release>-valkey-primary:6379`. The Helm chart sets `REDIS_URL` automatically from the new service name — no manual update is required unless you overrode `REDIS_URL` in your values file.

!!! note "Helm: values key redis renamed to valkey"
    Chart 1.1 configured its bundled cache under a top-level `redis:` block
    (`enabled`, `auth`, `image`, `master`, `commonConfiguration`). Chart 1.2
    renamed the block to `valkey:`. What this means for a 1.1 values file:

    - **`redis.enabled` still works, as a deprecated alias.** Setting
      `redis.enabled: false` turns the bundled Valkey off, and the backend uses
      `externalRedis.url` and `externalRedis.cacheUrl`, exactly as in 1.1.
      `redis.enabled: true` keeps the bundled Valkey. The `NOTES.txt` printed by
      `helm install` and `helm upgrade` carries a deprecation warning while
      `redis` is set. The alias is **deprecated in 1.2 and removed no earlier
      than 1.3**; switch to `valkey.enabled` now.
    - **Any other `redis.*` key fails the render** (`auth`, `image`, `master`,
      `architecture`, `commonConfiguration`, and so on). They configured the old
      Redis subchart and nothing reads them now, so ignoring them would silently
      drop a password or an image pin. The error names the rename. Move the
      settings you still need under `valkey:` (see `helm/visiban/values.yaml` for
      the supported keys); an external instance is configured with
      `externalRedis`.
    - **`redis.enabled: true` together with an explicit `valkey.enabled: false`
      fails the render** as a contradiction. Remove `redis.enabled`.
    - **`redis.enabled: false` wins over `valkey.enabled`**, both when
      `valkey.enabled` is left at its default and when you set it to `true`
      explicitly (as `values-prod.yaml` does). The chart cannot tell an untouched
      default from an explicit `true`, so check that a values file that sets both
      means what it says.

    **How to upgrade from 1.1.** Do not copy the `redis:` block over as
    `valkey:`. The keys differ, and a blind rename breaks the bundled Valkey. The
    mapping, derived from the 1.1 `values.yaml` and this chart's templates:

    | 1.1 `redis.` key | What to do in 1.2 |
    |---|---|
    | `enabled` | `valkey.enabled`, same meaning. With an external instance: `valkey.enabled: false` plus `externalRedis.url` and `externalRedis.cacheUrl`. If that is all you set, leaving `redis.enabled: false` also works (deprecated alias) |
    | `image.tag` (for example `"7.4.3"`) | **Drop it.** It is a Redis tag. `valkey/valkey:7.4.3` does not exist, so the pod would sit in `ImagePullBackOff`. The default is `valkey/valkey:8-alpine`; set `valkey.image.*` only to mirror or pin an official Valkey tag |
    | `master.persistence.enabled`, `.size`, `.storageClass` | `valkey.primary.persistence.*`. The name changed from `master` to `primary`; `valkey.master.*` is accepted by the schema and silently ignored |
    | `master.resources` | `valkey.primary.resources` |
    | `auth.enabled`, `auth.password` | `valkey.auth.enabled`, `valkey.auth.password`; turning auth on needs exactly one password source |
    | `auth.existingSecret`, `auth.existingSecretPasswordKey` | `valkey.auth.existingSecret`, `valkey.auth.existingSecretPasswordKey`. The Bitnami default key was `redis-password` and this chart's default is `valkey-password`, so when you keep an existing Secret set `valkey.auth.existingSecretPasswordKey: redis-password` |
    | `architecture` | Drop it (`standalone` is the only supported value; `replication` fails the render) |
    | `commonConfiguration` | Drop it unless you customized it; the default in `valkey.commonConfiguration` already enables AOF and disables RDB |
    | any other key | No equivalent. Drop it |

    Then upgrade with the edited file, without `--reuse-values`:

    ```bash
    helm upgrade visiban helm/visiban -f my-values.yaml
    ```

    `--reuse-values` does not work for this upgrade. It starts from the previous
    release's stored values instead of this chart's defaults, so keys that 1.2
    added are missing and the render fails with a `nil pointer` error before the
    chart's own checks run. On Helm 3.14 or later, `--reset-then-reuse-values`
    starts from this chart's defaults and re-applies the previous release's own
    values, which still include the old `redis` keys. We have not run a real
    `helm upgrade` from a 1.1 release for either flag; the chart's render checks
    cover the values-file route.

!!! note "Helm: backend.email.backend now defaults to empty"
    Chart 1.1 defaulted `backend.email.backend` to `"smtp"`. Chart 1.2 defaults it
    to `""`, which leaves `EMAIL_BACKEND` unset so the backend reads email
    settings from the `EMAIL_*` variables **or** from **Admin → Settings →
    Email**, whichever the admin selects.

    **A 1.1 values file keeps working.** If it sets `backend.email.host`,
    `user` and `password` but not `backend`, the chart still wires
    `EMAIL_HOST_PASSWORD` (from the `email-password` key, or from
    `backend.email.existingSecret`), so SMTP authentication continues after
    `helm upgrade`. No change is needed.
    If you supply your own `secret.existingSecret`, it must contain an
    `email-password` key (or the key named by `backend.email.passwordKey`)
    whenever `host` is set, as it already did for `backend: smtp`.

    **Pinning is optional.** Set `backend.email.backend: smtp` explicitly only if
    you want env-only email: it sets `EMAIL_BACKEND`, which **disables** the
    Admin → Settings → Email page. With `backend` empty and `host` empty, no SMTP
    password is rendered and email is configured from the admin page.

!!! note "Helm: optional password for the bundled Valkey"
    The bundled Valkey can now require a password (#1211). **Nothing changes
    unless you turn it on**: `valkey.auth.enabled` stays `false` by default, so
    an existing install renders the same workloads after `helm upgrade`.
    Only a comment in the Valkey ConfigMap changes, and nothing restarts.
    Without a password, access to Valkey is restricted only by the chart's
    NetworkPolicy (`networkPolicy.enabled`, off by default). We recommend
    turning auth on, especially on a shared cluster.

    To turn it on, set `valkey.auth.enabled=true` and exactly one of
    `valkey.auth.password` or `valkey.auth.existingSecret`. The full steps are
    in [Valkey password](../getting-started/kubernetes.md#valkey-password).
    The upgrade that turns it on restarts Valkey and the backend together. As
    on any Valkey restart, open WebSocket connections reconnect once and
    cached values are rebuilt. A later password rotation does not restart
    them on its own; run `kubectl rollout restart` on both, as described
    there.

!!! note "Helm: external Valkey/Redis password from a Secret"
    A password-protected external Valkey or Redis can now take its password
    from a Secret (`externalRedis.existingSecret`, #1361) instead of from
    `externalRedis.url`, where the chart rendered it as a plain environment
    value. **Nothing changes unless you set it**: a password embedded in
    `externalRedis.url` and `externalRedis.cacheUrl` keeps working exactly as
    before, and the rendered manifests are unchanged. To move the password
    into a Secret, see
    [Password for an external Valkey or Redis](../getting-started/kubernetes.md#password-for-an-external-valkey-or-redis).

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
    | `valkey.auth.enabled: true` with no `valkey.auth.password` or `valkey.auth.existingSecret` | A password is required to turn auth on. This setting was refused outright before #1211, because `REDIS_URL` carried no password | Set one password source (see "Helm: optional password for the bundled Valkey" above), or remove the setting |
    | A `bitnami/*` `valkey.image.repository`, or an empty or `latest` `valkey.image.tag` | A Bitnami image does not start under the new configuration, and `latest` is the drift this change removes | `--set valkey.image.repository=valkey/valkey --set valkey.image.tag=8-alpine` |
    | A `valkey.image.registry` other than Docker Hub | The chart no longer reads the key, so the image would silently come from Docker Hub | Drop it (`--set valkey.image.registry=null`) and put the mirror in `valkey.image.repository` |

    A Docker Hub `valkey.image.registry` (`docker.io`, `registry-1.docker.io`)
    is accepted and ignored, because the official image lives there too.

    **Upgrade with your values file, not `--reuse-values`.** `--reuse-values`
    carries the previous release's values forward, and for a release made with
    an earlier chart those include that chart's own image defaults and lack the
    keys this chart added, so the render stops. Pass your values file:

    ```bash
    helm upgrade visiban helm/visiban -f my-values.yaml
    ```

    On Helm 3.14 or later, `--reset-then-reuse-values` starts from this chart's
    defaults and re-applies the values you set yourself. We did not test it
    against a live release. If you set `valkey.image.*` yourself, keep it on an
    official `valkey/valkey` tag, as in the table above.

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
    helm upgrade visiban helm/visiban -f my-values.yaml \
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

!!! warning "Helm: frontend (nginx) pod now runs hardened, and listens on 8080 internally (chart 0.7.0)"
    Chart 0.7.0 brings the frontend (nginx) Deployment up to the same
    hardening the bundled Valkey StatefulSet (#1200) and the backend/
    PostgreSQL pods (#1210) already run with: a non-root user,
    `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, a
    **read-only root filesystem**, every Linux capability dropped, and no
    mounted ServiceAccount token (#1224). See
    [Pod security](../getting-started/kubernetes.md#pod-security) for the full
    list and the values that control it.

    **This is a default change for existing installs, not an opt-in.** A
    `helm upgrade` to chart 0.7.0 replaces the frontend pod with one running
    under the new `securityContext` — no values change required to pick it up.

    **The frontend container's internal listen port also changes, from 80 to
    8080.** A non-root user cannot bind a port below 1024 without
    `CAP_NET_BIND_SERVICE`, and that capability cannot actually be used here
    (see the note in [Pod security](../getting-started/kubernetes.md#pod-security)),
    so nginx now listens on the non-privileged 8080 instead. **The frontend
    Service's own port is unchanged** (`frontend.service.port`, `80` by
    default) — it targets the container by its named `http` port, which moves
    with it automatically, so `helm install`/`helm upgrade`,
    `kubectl port-forward svc/<release>-visiban-frontend`, and the Ingress all
    need no changes. The one place this is visible: a `kubectl port-forward
    <frontend-pod-name> 8080:80` run directly against the pod (bypassing the
    Service) must become `8080:8080` — the NOTES printed after `helm
    install`/`helm upgrade` already show the updated command, but a script or
    shell alias built from an older NOTES output needs updating by hand.

    **What could break:** a custom frontend image built on something other
    than `nginx:1.27-alpine`, or one that writes somewhere other than
    `/var/cache/nginx`, `/run` or `/tmp`, may fail to start under a read-only
    root filesystem or may not have the `101:101` `nginx` user/group this
    chart defaults to. Verify an overridden `frontend.image` against a staging
    release first.

    **If your image cannot run under this hardening**, relax just the field
    that conflicts — for example, to keep a writable root filesystem on a
    custom frontend image:

    ```bash
    helm upgrade visiban helm/visiban -f my-values.yaml \
      --set frontend.securityContext.container.readOnlyRootFilesystem=false
    ```

    As with `backend.securityContext` and `postgresql.securityContext`, Helm
    deep-merges nested maps, so a single-leaf `--set` keeps the chart's other
    `frontend.securityContext.container` defaults in place.

!!! warning "Frontend image now runs as non-root and listens on 8080; reset the dev `node_modules` volume"
    The `ghcr.io/visiban/visiban/frontend` image (and `frontend/Dockerfile.prod`) now runs as
    the non-root `nginx` user and nginx listens on **8080** instead of 80.

    - **Direct `docker run` users** must publish the new container port:
      `docker run -p 80:8080 ghcr.io/visiban/visiban/frontend:<tag>`. The old `-p 80:80`
      mapping no longer reaches nginx.
    - **The image's default config now matches the bundled templates' response headers.**
      The image installs `frontend/nginx.default.conf` as its default server config. It
      still serves only the static files (no `/api/` or `/ws/` proxying), and it now sends
      the same `Content-Security-Policy`, `X-Frame-Options: DENY` and
      `X-Content-Type-Options: nosniff` headers as `nginx/app.conf.template`,
      `nginx/app-http.conf.template` and the Helm chart's frontend ConfigMap. Its
      `connect-src` is `'self'` only; to name your hostname for the WebSocket, or to
      proxy `/api/` and `/ws/`, mount one of those configs over
      `/etc/nginx/conf.d/default.conf`.
    - **Production Compose and the Helm chart are unaffected.** Production Compose only copies
      the static files out of the image and serves them from the stock `nginx` service on
      80/443, and the chart already used 8080 (see the chart 0.7.0 note above).
    - **Development Compose checkouts must reset the frontend volume.** The dev frontend now
      runs as the `node` user (uid 1000). An existing checkout keeps a root-owned anonymous
      `/app/node_modules` volume, so the dev command (`rm -rf /app/node_modules/.vite && npm run dev`)
      fails and the dev server never starts. Recreate it with `docker compose down -v`, or
      `docker compose up --build --renew-anon-volumes` (`down -v` also deletes the database
      volume; the second command only renews the anonymous volumes). On Linux hosts whose user
      is not uid 1000, the `./frontend:/app` bind mount may also need to be writable by uid 1000.

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
    content-addressed by digest, and since 1.2 each one is cosign-signed and carries a
    CycloneDX SBOM attestation against that digest (#1153) — see
    [Verifying release images](image-verification.md).

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

!!! note "12-character password minimum now applies to every password-set path"
    1.2 raises Django's `MinimumLengthValidator` from its default of 8 to 12 characters
    (`PASSWORD_MIN_LENGTH` in `visiban/settings.py`), so the 12-character policy that the
    in-app change-password form and the admin "create user" form already enforced now also
    applies to self-registration, invite-link registration, the password-reset link,
    `POST /api/v1/auth/password/change/`, the Django admin's set-password form, and the
    interactive `createsuperuser` / `changepassword` management commands (#1258). It is not configurable.
    **No one is locked out:** the rule is checked only when a password is *set*, so existing
    accounts with a shorter password keep logging in and are asked for 12+ characters only the
    next time they change it. No migration is involved.

!!! note "Startup checks guard the `changepassword` and `createsuperuser` overrides"
    Visiban replaces Django's `changepassword` and `createsuperuser` commands with its own
    (`operator_commands`) so operator password changes revoke credentials and are written to the
    admin action log. A settings include that replaces `INSTALLED_APPS` and drops the app now
    fails `manage.py check` with `accounts.E008` (`changepassword`) or `accounts.E009`
    (`createsuperuser`) (#1801, #1824). Fix the `INSTALLED_APPS` order rather than silencing
    the check; if you must, each ID can be listed in `SILENCED_SYSTEM_CHECKS` independently.
    1.2.0-beta.3 used `accounts.E008` for both overrides, so if you listed `accounts.E008` in
    `SILENCED_SYSTEM_CHECKS` to waive a replaced `createsuperuser` override, `accounts.E009` now
    fires and blocks startup until you add it to `SILENCED_SYSTEM_CHECKS` as well.

!!! warning "`POST /api/v1/auth/password/change/` now requires `old_password`"
    This dj-rest-auth endpoint previously changed the password for any authenticated caller
    without checking the current one (#1257). Any script or integration that calls it must now
    send `old_password`; requests without it return `400`. The endpoint also now clears a
    pending forced password change on success (#1259). The Visiban web app does not use this
    endpoint and is unaffected. See
    [Authentication API](../api/authentication.md#post-apiv1authpasswordchange).

!!! warning "Column and swimlane `reorder/` now require the board's full `order` list"
    In 1.1, `POST /api/v1/boards/{id}/columns/reorder/` and `.../swimlanes/reorder/` read
    `order` with a default of an empty list, so a missing or partial `order` was a `200` no-op,
    a partial apply, or (columns) a `500` from a `unique_together(board, position)` collision. Since 1.2 (#1302), `order` must be exactly the board's current column
    (or swimlane) IDs: every one once, no duplicates, and no ID from another board. A missing
    or partial `order`, a duplicate or foreign ID, a non-integer entry, or an empty list on a
    board that has columns (or swimlanes) returns `400` with a body such as
    `{"order": ["order must contain exactly this board's column IDs, no more and no fewer."]}`,
    and nothing is changed. An empty `order` is accepted only when the board has none of that
    resource. Any script or integration that sends a partial or empty `order` must now `GET`
    the board's current IDs and send the complete list in the new order. The Visiban web app
    already sends the full list and is unaffected. See
    [Columns API](../api/boards.md#post-apiv1boardsidcolumnsreorder) and
    [Swimlanes API](../api/boards.md#post-apiv1boardsidswimlanesreorder).

!!! warning "`PATCH`/`PUT` can no longer change `position`"
    Since 1.2, a `PATCH` or `PUT` on a card, column, or swimlane that changes `position`
    returns `400` instead of silently applying it (#1275), and so does a `PATCH` on a checklist
    item (#1292). The old behavior bypassed the WIP and weight limits, the card movement audit
    trail, and the reorder broadcast, which only the dedicated endpoints evaluate. A request
    that echoes the current `position` back unchanged (for example a full-object round-trip)
    is still accepted. Scripts that reorder this way must switch to
    `POST .../cards/{id}/move/` for cards, `POST .../columns/reorder/` or
    `POST .../swimlanes/reorder/` for columns and swimlanes, and
    `POST .../cards/{id}/checklist/reorder/` for checklist items. See the
    [Columns API](../api/boards.md#columns), the [Swimlanes API](../api/boards.md#swimlanes),
    and the [checklist item reference](../api/cards.md).

!!! warning "Share links with no recorded enabling admin must be turned on again"
    From 1.2 a board's public share link records the board admin who enabled it, and lasts only
    while that account is active and still an admin of the board (#1865). A link enabled
    before the enabler was recorded (for example under 1.1, or 1.2.0-beta.3 and earlier) has no
    recorded admin, so from the upgrade on it no longer opens: visitors get `404 Not Found` and the same "This
    board is no longer shared" page as for a link that was turned off (#1939). No admin is
    filled in for these links at upgrade. The **Sharing** tab shows sharing as off on such a
    board (and `share_link_active` reads `false`), and the first time the old link is opened it
    is also cleared from the board.

    **To restore public sharing on such a board**, a board admin opens
    **Board Settings → Sharing** and turns **Enable public share link** on. This creates a new
    link recorded against that admin and shows it once; send the new URL to anyone who needs
    it. The previous URL does not come back. (**Rotate link** also creates a new link, but the
    tab offers it only for an active link, which such a board does not have.) API clients call
    `POST /api/v1/boards/{id}/share/`, which creates a new link whether or not one is set.

    The same applies to a link that a backend pod still on the previous version creates or
    re-enables during a rolling upgrade: it records no admin, so turn it on again once every
    pod runs 1.2.

    To list the boards whose link has no recorded admin (after migrating):

    ```bash
    docker compose -f docker-compose.prod.yml run --rm backend \
      python manage.py shell -c "
    from boards.models import Board
    boards = Board.objects.filter(share_token__isnull=False, share_enabled_by__isnull=True)
    for pk, name in boards.order_by('pk').values_list('pk', 'name'):
        print(pk, name)
    "
    ```

!!! note "Public share links are now looked up by a hash of their token"
    Board share links are now resolved by a SHA-256 hash of the share token, as invite links
    already are (#1880). Migrations `boards/0087`–`0089` add the hash column, fill it in for every
    existing share link, and build its unique index concurrently. This change needs no action for
    links created before the upgrade (but see the note above on links enabled before the enabler was recorded). During a rolling upgrade, a backend pod still
    on the previous version writes the token without its hash. A share link that such a pod
    creates, regenerates or re-enables after migration `0088` has run answers `404 Not Found`,
    and so does the link it replaced, until a board admin regenerates it under
    **Board Settings → Sharing**. A link such a pod revokes stays revoked.

!!! note "The share link is shown once; `share_token` on board reads is deprecated"
    From 1.2 the **Sharing** tab shows a board's public link only once, right after it is
    created, and offers **Rotate link** for a link created earlier (#1935). This needs no action:
    links that record the admin who enabled them keep working (a link enabled before the
    enabler was recorded must be turned on again; see the note above). For API clients, `share_token` on
    `GET /api/v1/boards/{id}/full/` is **deprecated** and will be removed in 2.0. It is still
    returned in 1.2, except that a link with no recorded admin reads as no link (`null`). Read the token from the `POST /api/v1/boards/{id}/share/` response
    instead, and use the new `share_link_active` field to tell whether a link is set. See the
    [Boards API](../api/boards.md#get-apiv1boardsidfull).

### Upgrading to 1.1.x

!!! warning "Removed env-var aliases — rename before upgrading"
    Two deprecated environment variable aliases were **removed** in 1.1. Operators who still set the old names will get silent failures — OIDC will be deactivated and email verification will have no effect:

    | Old name (removed) | Canonical name (use this) |
    |---|---|
    | `OIDC_SECRET` | `OIDC_CLIENT_SECRET` |
    | `ACCOUNT_EMAIL_VERIFICATION` | `EMAIL_VERIFICATION` |

    Before upgrading, search your `.env` file and any CI/CD secret stores for these old names and rename them. The old names are no longer read, so SSO or email verification stops working **silently**. Do not count on a startup warning to tell you:

    - **1.1.x** raises only a Python `DeprecationWarning`, which Python hides by default, so nothing appears in the container log.
    - **From 1.2**, setting either name logs a visible startup warning: `OIDC_SECRET is no longer read and has no effect; replace it with OIDC_CLIENT_SECRET` (and the same for `ACCOUNT_EMAIL_VERIFICATION`).

    If neither alias appears anywhere in your config, no action is required.

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
