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

### 1. Back up the database

Always take a snapshot before upgrading. If a migration fails partway through, you will need this to recover.

```bash
docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U visiban visiban > visiban-backup-$(date +%Y%m%d%H%M%S).sql
```

Store the backup outside the container. A local file on the host is sufficient for most deployments; offsite storage is recommended for production.

### 2. Pull the new image and rebuild

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml build --no-cache backend frontend-build
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

Three patterns break this compatibility and are therefore prohibited:

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

---

## Multi-replica deployments

!!! warning
    Running `migrate` inside the container startup command is unsafe when `backendReplicaCount > 1`.

The default `docker-compose.prod.yml` backend command is:

```yaml
command: >
  sh -c "python manage.py migrate &&
         python manage.py ensure_site_admin &&
         daphne -b 0.0.0.0 -p 8000 visiban.asgi:application"
```

This is convenient for single-server deployments: the one backend container migrates and then starts. However, if you scale the backend to more than one replica — whether via Docker Swarm, Kubernetes, or a second Compose host — every replica races to apply the same migrations on startup. Django's migration executor is not safe to run concurrently: two containers applying the same migration at the same time will conflict at the database level and may leave the schema in an inconsistent state.

**Recommended approach for multi-replica deployments:**

Run migrations as a dedicated pre-deploy step before scaling up any application replicas.

=== "Docker Compose"

    ```bash
    # 1. Run migrations once, in a separate container, before any replicas start.
    docker compose -f docker-compose.prod.yml run --rm backend python manage.py migrate

    # 2. Start (or restart) application replicas.
    docker compose -f docker-compose.prod.yml up -d --scale backend=3 --no-deps backend
    ```

    The `--no-deps` flag prevents Compose from restarting `db` and `redis`.

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
              image: registry.example.com/visiban-backend:1.1.0
              command: ["python", "manage.py", "migrate"]
              envFrom:
                - secretRef:
                    name: visiban-env
    ```

    Run this job to completion before applying the updated `Deployment`.

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

### Upgrading to 1.1.x

!!! warning "Breaking change — Redis authentication is now required in production"
    `docker-compose.prod.yml` now starts Redis with `--requirepass` and constructs `REDIS_URL` and `REDIS_CACHE_URL` using the password. **The stack will fail to start if `REDIS_PASSWORD` is not set in your `.env`.**

    Before running `docker compose -f docker-compose.prod.yml up`, add `REDIS_PASSWORD` to your `.env`:

    ```bash
    # Generate a strong random password and insert it into .env
    sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -base64 32)|" .env
    ```

    Or generate a value manually and add it:

    ```bash
    openssl rand -base64 32
    # Copy the output, then add to .env:
    REDIS_PASSWORD=<generated value>
    ```

    Existing deployments that used the default unauthenticated Redis will continue to work after setting this variable — Redis data in the container is ephemeral (it holds only WebSocket channel state and short-lived cache keys), so no migration of Redis data is required.

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
