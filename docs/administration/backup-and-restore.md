# Back up and restore a self-hosted install

Schedule `scripts/backup.sh` (Docker Compose) or the chart's backup CronJob (Kubernetes), copy each backup off the host, and keep a copy of your `.env` or Secrets. Restore with `scripts/restore.sh` onto a fresh install.

**Why it matters:** Visiban keeps no backups of its own. Board deletion is permanent, and the bundled PostgreSQL is a single instance with no replica. If the disk or volume is lost, the only copy of your boards is the last backup you took.

!!! note "Added in 1.3"
    Before 1.3, backups were manual `pg_dump` and `tar` commands. 1.3 ships `scripts/backup.sh`, `scripts/restore.sh`, an opt-in Compose scheduler (the `backup` profile), and an opt-in Helm CronJob (`backup.enabled`). CI backs up a seeded Compose install, restores it into a fresh one and checks that boards, cards, movements and attachments come back (#2626, #1464).

## What to back up

| What | Where it lives | Covered by the backup |
|---|---|---|
| Database: boards, cards, movement history, users, settings | PostgreSQL (`pgdata` volume, or the chart's PostgreSQL PVC, or your managed database) | Yes: `database.sql.gz` |
| Media: card attachments, avatars | `MEDIA_ROOT`, `/app/media` in the backend container (`mediafiles` volume, or the `<release>-media` PVC) | Yes: `media.tar.gz` |
| Secrets: `DJANGO_SECRET_KEY`, `VISIBAN_SECRET_ENCRYPTION_KEY`, `DB_PASSWORD`, `REDIS_PASSWORD`, OAuth client secrets | `.env` (Compose) or your Kubernetes Secrets / `values.secret.yaml` | **No.** Copy them yourself, separately |
| Valkey | tmpfs, in memory | Not needed: it holds only the real-time layer and a cache |

**Watch out: the secrets matter.** Stored SMTP passwords and webhook secrets are encrypted with `VISIBAN_SECRET_ENCRYPTION_KEY`, or with a key derived from `DJANGO_SECRET_KEY` when that is unset. Restore a database with a different key and those values can't be decrypted; you must re-enter them. Keep the `.env` or Secret copy apart from the backups, in a password manager or secret store: it is what lets someone read them.

## What a backup is

Each run writes one directory, a **backup set**:

```text
backups/visiban-20261126T021700Z/
  database.sql.gz   plain-SQL pg_dump (--no-owner --no-privileges), gzip
  media.tar.gz      tar of /app/media, gzip
  SHA256SUMS        checksums of both archives
  MANIFEST          when it ran, which mode, the dump size
```

The dump is **plain SQL**, so it restores with `psql`, not `pg_restore`. Compose and Helm write the same layout with the same script, so a set from either restores on either.

**A failed backup is a failure, not a file.** The run exits non-zero and keeps nothing if `pg_dump` fails, the dump is empty, the dump lacks pg_dump's completion trailer (truncated), the dump has no Visiban tables, or either archive fails its integrity test. A set is written to a hidden `.partial` directory and renamed only when every check has passed, so any `visiban-*` directory is complete. A `.partial` directory left by a run that was killed outright is removed by the first run more than 12 hours later.

**Retention:** after each **successful** run, sets older than `--retention-days` (default 14) are deleted. A failing schedule never prunes the last good sets.

**Permissions:** sets are created `0700` and their files `0600`. They hold every board, card and attachment. No password is printed or logged.

**Watch out: restore only sets you made.** A dump is SQL run as the database owner, so a set from an unknown source can run commands on the database server. The checksums prove a set is intact, not where it came from. If you need that proof, keep each set's `SHA256SUMS` somewhere the backups are not.

## Cadence and off-host copies

- **Daily** is the default schedule and suits most teams. Back up hourly if losing a day of card moves would hurt; the dump is small next to the media archive.
- **Before every upgrade**, run a one-off backup ([Upgrading](upgrade.md#1-back-up-the-database)).
- **Copy every set off the host.** A backup on the same disk as the database is lost with it. Copy `backups/` to another machine or to object storage with `rsync`, `rclone` or your existing backup tool. Visiban does not upload anywhere itself.
- **Encrypt the off-host copies.** A set is not encrypted: anyone who can read it can read every board, card and attachment. Store the copies encrypted at rest, for example with a bucket's server-side encryption, an `rclone crypt` remote, `restic` or `borg`, or `age`/`gpg` on each set before upload. Keep the decryption key apart from the backups and with your `.env` copy, or a restore is impossible.
- **Test a restore.** Restore a recent set onto a scratch install once a quarter. A backup you have never restored is a guess.

**RPO and RTO.** With the shipped daily schedule you can lose up to 24 hours of changes (recovery point). A restore takes about as long as the dump took plus a `migrate` and a stack restart: minutes for a typical team (recovery time). For a smaller recovery point, run the backup more often or use [point-in-time recovery](#managed-postgresql-and-point-in-time-recovery).

## Docker Compose

Run the commands from the directory that holds `docker-compose.prod.yml` and `.env`.

### Back up now

```bash
scripts/backup.sh --output-dir ./backups --retention-days 14
```

**How it works:** the script streams the dump out of the `db` container (`docker compose exec`) and the media archive out of a one-off container that mounts the media volume (`docker compose run` with `tar` as the entrypoint). It needs `db` running, but not a healthy Django app. Exit status `0` means a complete set was written.

### Schedule it

Start the opt-in `backup` service. It runs the same script in a container every day at `BACKUP_TIME` (UTC):

```bash
docker compose -f docker-compose.prod.yml --profile backup up -d backup
```

Set these in `.env` if the defaults don't suit:

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_TIME` | `02:17` | Daily run time, `HH:MM` in UTC |
| `BACKUP_DIR` | `./backups` | Host directory the sets are written to |
| `BACKUP_RETENTION_DAYS` | `14` | Delete sets older than this after a successful run; `0` keeps all |

The `backup` container runs as root, so the sets it writes to `BACKUP_DIR` are owned by root with mode `0600`: copy them off the host as root (or with `sudo`).

**Watch out:** a failed scheduled run is logged and marks the container **unhealthy** until a later run succeeds. Check it with `docker compose -f docker-compose.prod.yml --profile backup ps backup` and `logs backup`, or alert on the container's health. Then copy `BACKUP_DIR` off the host with your own job.

**Tip:** add `backup` to `COMPOSE_PROFILES` in `.env` (for example `COMPOSE_PROFILES=letsencrypt,scheduler,backup`) so every `docker compose up -d`, including `init-prod.sh`, starts it too.

**Yes, but:** if you prefer host cron, schedule `scripts/backup.sh` there instead and leave the profile off. Don't run both.

### Restore

`scripts/restore.sh` **replaces** all data in the target install with the set's contents.

1. Install Visiban on the new host as usual ([Installation](../getting-started/installation.md#production-deployment)), with the **same secrets** in `.env` as the original install (at least `DJANGO_SECRET_KEY` and `VISIBAN_SECRET_ENCRYPTION_KEY`). Pin `APP_VERSION` to the release the backup was taken on, or a newer one.
2. Copy the backup set to the host and restore it:

    ```bash
    sudo scripts/restore.sh backups/visiban-20261126T021700Z
    ```

    Type `restore` to confirm, or pass `--yes` in a script. Sets are `0700`, and the scheduled `backup` service writes them as root, so run the restore with `sudo` or as the user that owns the set. Otherwise it stops with "cannot read set dir (run as root/owner)".

**How it works:** the script first checks `SHA256SUMS` and the dump's completion trailer, and touches nothing if either fails. It then stops every running service except `db` (the `scheduler` and `backup` profiles included), loads the dump with `psql` in **one transaction** that drops and re-creates the `public` schema, empties the media volume and unpacks the archive into it, and starts the stack again. `backend-init` runs `migrate`, so a backup from an older release is upgraded on the way up. If any SQL statement fails, the whole transaction rolls back and the database is left as it was.

Use `--skip-media` to restore the database only. The restore needs Docker Compose 2.20 or newer.

## Kubernetes (Helm)

### Turn on the backup CronJob

```yaml
backup:
  enabled: true
  schedule: "17 2 * * *"
  retentionDays: 14
  persistence:
    size: 20Gi
    # existingClaim: my-backup-pvc
```

**How it works:** each run is a Job that runs the chart's copy of `scripts/backup.sh` in a `postgres:17` container. It reads `DATABASE_URL` from the chart's Secret, mounts the media PVC **read-only**, and writes sets to the `<release>-backup` PVC. A failed backup fails the Job and is not retried (`backoffLimit: 0`), so alert on failed Jobs. With a `ReadWriteOnce` media PVC the Job pod is scheduled on the backend pod's node, and stays Pending while the backend is scaled to zero.

**Watch out:**

- Keep `backup.image` on the same PostgreSQL major as your server, or newer. `pg_dump` refuses a newer server.
- With `networkPolicy.enabled`, the backup pod (`app.kubernetes.io/component: backup`) is already allowed to reach the bundled PostgreSQL.
- Set `backup.includeMedia: false` when `backend.mediaPersistence.enabled` is false; there is no media volume to read.
- The backups live on a PVC in the same cluster. Copy them off-cluster, for example with a CronJob of your own that mounts the backup PVC and runs `rclone`.

### Restore on Kubernetes

Run the restore in a one-off pod that mounts the backup PVC and the media PVC, with everything that writes stopped. Replace `visiban` with your release name (both the namespace and the `app.kubernetes.io/instance` label).

Everything that writes means: the backend, the backend HorizontalPodAutoscaler if `backendAutoscaling.enabled` is on (it would scale the backend straight back up), the webhook dispatcher if `webhooks.dispatcher.enabled` is on, and every CronJob of the release: the backup CronJob, the `scheduledJobs` maintenance jobs, and the demo reset job if you run one. Suspending a CronJob does not stop a Job it has already started, so wait for those to finish.

```bash
# 1. Stop everything that writes
# The HPA cannot scale to zero, so remove it; `helm upgrade` re-creates it in step 3.
kubectl -n visiban delete hpa visiban-backend --ignore-not-found
kubectl -n visiban scale deployment visiban-backend --replicas=0
# The webhook dispatcher, if enabled (NotFound otherwise is fine)
kubectl -n visiban scale deployment visiban-webhook-dispatcher --replicas=0
# Every CronJob of the release: backup, scheduledJobs, demo reset
for cj in $(kubectl -n visiban get cronjob -l app.kubernetes.io/instance=visiban -o name); do
  kubectl -n visiban patch "$cj" -p '{"spec":{"suspend":true}}'
done
# Wait until no Job of the release is still running (ACTIVE is 0 or empty)
kubectl -n visiban get jobs -l app.kubernetes.io/instance=visiban
kubectl -n visiban get pods -l app.kubernetes.io/instance=visiban   # only PostgreSQL (and Valkey) left

# 2. List the sets on the backup PVC
kubectl -n visiban run backup-ls --rm -i --restart=Never --image=postgres:17 \
  --overrides='{"spec":{"securityContext":{"runAsUser":1001,"runAsGroup":1001},"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"visiban-backup"}}],"containers":[{"name":"ls","image":"postgres:17","command":["ls","/backups"],"volumeMounts":[{"name":"b","mountPath":"/backups"}]}]}}'
```

Save this as `restore-pod.yaml`, set the set name in `args`, and apply it:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: visiban-restore
  namespace: visiban
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1001
    runAsGroup: 1001
    fsGroup: 1001
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: restore
      image: postgres:17   # the same image as backup.image
      command: ["/bin/sh", "/opt/visiban/restore.sh", "--yes"]
      args: ["/backups/visiban-20261126T021700Z"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: ["ALL"] }
      env:
        - { name: VISIBAN_BACKUP_MODE, value: container }
        - { name: MEDIA_DIR, value: /app/media }
        - { name: HOME, value: /tmp }
        - name: DATABASE_URL
          valueFrom: { secretKeyRef: { name: visiban, key: database-url } }
        # Only with postgresql.auth.existingSecret:
        # - name: DATABASE_URL_PASSWORD
        #   valueFrom: { secretKeyRef: { name: <that secret>, key: password } }
      volumeMounts:
        - { name: scripts, mountPath: /opt/visiban, readOnly: true }
        - { name: backups, mountPath: /backups, readOnly: true }
        - { name: media, mountPath: /app/media }
        - { name: tmp, mountPath: /tmp }
  volumes:
    - name: tmp
      emptyDir: {}
    - name: scripts
      configMap: { name: visiban-backup-scripts }
    - name: backups
      persistentVolumeClaim: { claimName: visiban-backup }
    - name: media
      persistentVolumeClaim: { claimName: visiban-media }
```

```bash
kubectl apply -f restore-pod.yaml
kubectl -n visiban logs -f visiban-restore    # ends with "OK: restored ..."
kubectl -n visiban delete pod visiban-restore

# 3. Start again, in reverse: the backend's migrate init container runs first
kubectl -n visiban scale deployment visiban-backend --replicas=1   # your backendReplicaCount, or the HPA's minReplicas
kubectl -n visiban scale deployment visiban-webhook-dispatcher --replicas=1   # if enabled
for cj in $(kubectl -n visiban get cronjob -l app.kubernetes.io/instance=visiban -o name); do
  kubectl -n visiban patch "$cj" -p '{"spec":{"suspend":false}}'
done
# Only if you use backendAutoscaling: re-create the HPA with the same chart version and values
helm upgrade visiban <chart> --version <the installed chart version> --reuse-values
```

If any CronJob was suspended **before** the restore on purpose, leave it suspended in step 3: the loop un-suspends every CronJob of the release.

The Secret holding `database-url` is named after the release (`visiban` here) unless you set `secret.existingSecret`. The same restore runs in one transaction and refuses a damaged set, as on Compose.

### What `helm uninstall` keeps

- **The media PVC is kept** (`helm.sh/resource-policy: keep`, on by default through `backend.mediaPersistence.keepOnUninstall`). Before 1.3 it was deleted with the release, taking every attachment with it.
- **The backup PVC is kept** (`backup.persistence.keepOnUninstall`), so uninstalling never deletes the data and its backups together.
- **The bundled PostgreSQL PVC is kept.** It comes from the StatefulSet's `volumeClaimTemplates`, and Kubernetes never deletes those with the StatefulSet.

A reinstall under the same release name and namespace picks all three up again. To delete the data for good, delete the PVCs by hand ([Uninstalling](../getting-started/kubernetes.md#uninstalling)).

## Managed PostgreSQL and point-in-time recovery

The bundled PostgreSQL has no WAL archiving, so its recovery point is your last backup. If you need a recovery point of minutes, run Visiban on a managed PostgreSQL (`externalDatabase` in Helm) and turn on the provider's point-in-time recovery, or set up WAL archiving with a tool such as pgBackRest or WAL-G. Keep the media backups either way: point-in-time recovery covers only the database.

**What the backup scripts support:**

- **Docker Compose:** the bundled `db` service only. Host mode runs `pg_dump` and `psql` inside `db` as the `visiban` user, and the `backup` service connects to `db`. A Compose install pointed at another database is not covered: back that database up with your provider's tools, and the `mediafiles` volume yourself.
- **Helm:** the backup CronJob and the restore pod run in container mode against whatever `DATABASE_URL` the chart renders, so the bundled PostgreSQL and `externalDatabase` both work. The restore needs only the database owner's rights, not a superuser.

## After a restore: checks

1. `GET /api/health/readiness/` reports `"status": "ok"`.
2. Sign in with an account that existed when the backup was taken.
3. Open a board: cards are in the expected columns and **History** shows the movements.
4. Open a card with an attachment and download it.
5. Create a card and move it to another column. That proves the restored database accepts writes.
6. Open the same board in a second browser tab, move a card in one, and check that the other updates without a reload. That proves the WebSocket connects (through your reverse proxy or Ingress) and that Valkey is reachable.
7. If you use stored SMTP or webhook secrets, send a test email from **Site admin → Email**. A decryption error means the restored install has a different `VISIBAN_SECRET_ENCRYPTION_KEY` or `DJANGO_SECRET_KEY`.
8. Turn the backup schedule back on and check that its next run succeeds.

## Related

- [Installation](../getting-started/installation.md#backing-up-and-restoring)
- [Kubernetes](../getting-started/kubernetes.md#backups)
- [Upgrading](upgrade.md)
- [Secret rotation](secret-rotation.md)
