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
| 1.1.x | 1.2.x (minor) | Yes — zero-downtime | Follow the [standard upgrade steps](#standard-upgrade-steps). See [Upgrading to 1.2.x](#upgrading-to-12x) — most changes are additive and need no operator action, but read the `!!!` callouts (Compose `ALLOWED_HOSTS`/`DOMAIN`, Helm `ALLOWED_HOSTS` no longer includes `localhost`, Helm catch-all/loopback `allowedHosts` entries fail the render (**this one can stop `helm upgrade`**; opt out with `backend.settings.allowUnsafeHosts=true`), Helm values-schema validation, PAT scopes and the MCP server). |

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

---

## Release-specific upgrade notes

### Upgrading to 1.2.x

!!! warning "GitLab registry `:latest` no longer tracks `main` builds"
    Previously every `main` merge overwrote `registry.gitlab.com/visiban/visiban/backend:latest`
    and `frontend:latest` with an amd64-only build. `:latest` on the GitLab registry is now
    written only by stable release tags (multi-arch), matching GHCR, so it stays on the last
    stable release until the next stable tag. If you tracked GitLab `:latest` to follow `main`,
    switch to `:main` (amd64 only); short-SHA tags are still pushed for rollback. Pinned release
    tags and GHCR are unaffected. See [Container image retention](container-image-retention.md#gitlab-registry-latest-is-stable-only-main-publishes-main).

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
    - **Existing tokens are refused by the MCP server**, which now requires the `mcp:read`
      scope. Any MCP client authenticating with a pre-1.2 token stops connecting after the
      upgrade — create a new token with `mcp:read` to reconnect it.
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
        helm upgrade visiban helm/visiban --reuse-values \
          --set valkey.image.repository=valkey/valkey \
          --set valkey.image.tag=8-alpine
        ```

        The two `--set` flags are needed only with `--reuse-values`; see
        "Helm: bundled Valkey is no longer the Bitnami subchart" below.

        If you previously set `redis.enabled: false` and pointed `externalRedis.url` at an external Redis instance, no change is needed — the `externalRedis` key is unchanged and your external instance continues to work.

        If you used the bundled subchart, the in-cluster service DNS changes from `<release>-redis-master:6379` to `<release>-valkey-primary:6379`. The Helm chart sets `REDIS_URL` automatically from the new service name — no manual update is required unless you overrode `REDIS_URL` in your values file.

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
    helm upgrade visiban helm/visiban --reuse-values \
      --set frontend.securityContext.container.readOnlyRootFilesystem=false
    ```

    As with `backend.securityContext` and `postgresql.securityContext`, Helm
    deep-merges nested maps, so a single-leaf `--set` keeps the chart's other
    `frontend.securityContext.container` defaults in place.

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

!!! warning "`POST /api/v1/auth/password/change/` now requires `old_password`"
    This dj-rest-auth endpoint previously changed the password for any authenticated caller
    without checking the current one (#1257). Any script or integration that calls it must now
    send `old_password`; requests without it return `400`. The endpoint also now clears a
    pending forced password change on success (#1259). The Visiban web app does not use this
    endpoint and is unaffected. See
    [Authentication API](../api/authentication.md#post-apiv1authpasswordchange).

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
