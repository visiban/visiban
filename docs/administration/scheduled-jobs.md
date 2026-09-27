# Scheduled Jobs

!!! note "Added in 1.2"
    Before 1.2, Visiban documented these commands but shipped nothing to run
    them — each needed a hand-written host cron line. 1.2 ships an opt-in
    scheduler for Docker Compose and native CronJobs for Kubernetes.

Visiban has four maintenance commands that must run on a schedule. None of them
runs on a web request, and Visiban has no task queue. If nothing schedules them:

- users who turn on **Due date approaching** or **Card has gone stale** in
  their notification preferences never receive those notifications, in the bell
  or by email;
- the `notifications` and `board_events` tables grow without bound.

| Command | What it does | Default time (UTC) | On by default when the scheduler is enabled |
|---|---|---|---|
| `notify_due_soon` | [Due-date notifications](../features/notifications.md#due-date-notifications) for opted-in assignees | 07:00 | Yes |
| `notify_stale_cards` | [Staleness notifications](../features/notifications.md#staleness-notifications) for opted-in users | 08:00 | Yes |
| `prune_board_events` | **Deletes** [change-feed](../api/events.md) events older than `BOARD_EVENT_RETENTION_DAYS` (default 30) | 03:00 | No |
| `prune_notifications` | **Deletes** notifications, read or unread, older than `NOTIFICATION_RETENTION_DAYS` (default 90) | 03:30 | No |

**The scheduler is off by default on both deployment paths**, so upgrading
changes nothing until you turn it on. Once it is on, the two notification scans
run, and they only act for users who switched the matching preference on. The
two prune jobs delete data, so each one stays off until you enable it on its own.

All four commands are idempotent, so running one twice in a day does no harm.
**Running two copies at the same moment is different.** If you already run any
of these from host cron, remove that cron line before you enable the shipped
scheduler. Two notification scans that start in the same minute can both pass
the "already notified" check and notify the same user twice.

## Docker Compose

`docker-compose.prod.yml` includes a `scheduler` service behind the `scheduler`
[Compose profile](https://docs.docker.com/compose/how-tos/profiles/). It runs
`python manage.py run_scheduler` in the backend image, with the same `.env` as
the backend.

Turn it on by adding the profile to `.env`. Keep `letsencrypt` in the list if
you use it:

```bash
# .env
COMPOSE_PROFILES=letsencrypt,scheduler
```

Then start it:

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f scheduler
```

At startup the service prints the schedule it loaded. It logs a line when each
job starts and when it finishes.

### Choosing jobs and times

Each job's time comes from an environment variable in `.env`. A value is
`HH:MM` (24-hour, **UTC**) or `off`:

| Variable | Default |
|---|---|
| `SCHEDULE_NOTIFY_DUE_SOON` | `07:00` |
| `SCHEDULE_NOTIFY_STALE_CARDS` | `08:00` |
| `SCHEDULE_PRUNE_BOARD_EVENTS` | `off` |
| `SCHEDULE_PRUNE_NOTIFICATIONS` | `off` |

For example, this keeps the notification scans at their defaults and turns on
both prune jobs:

```bash
# .env
SCHEDULE_PRUNE_BOARD_EVENTS=03:00
SCHEDULE_PRUNE_NOTIFICATIONS=03:30
```

Run `docker compose -f docker-compose.prod.yml up -d scheduler` again after
changing any of these variables.

### How the Compose scheduler behaves

- **Once a day per job, at or after its time.** If a check runs late (for
  example, the host was suspended), the job still runs that day.
- **No catch-up.** A job whose time already passed when the container started
  waits until the next day. This stops a restart loop from firing every job on
  every restart. A missed notification scan is a skipped day, not a backlog.
- **A failing job does not stop the others.** The error and traceback go to
  the service log, and the next day's run happens as normal.
- **Bad configuration stops the service at startup.** An invalid time, or
  every job set to `off`, is an error that names the variable.

Without the `scheduler` profile, you can still schedule the same commands from
host cron:

```bash
0 7 * * *  docker compose -f /opt/visiban/docker-compose.prod.yml run --rm backend python manage.py notify_due_soon
0 8 * * *  docker compose -f /opt/visiban/docker-compose.prod.yml run --rm backend python manage.py notify_stale_cards
0 3 * * *  docker compose -f /opt/visiban/docker-compose.prod.yml run --rm backend python manage.py prune_board_events
30 3 * * * docker compose -f /opt/visiban/docker-compose.prod.yml run --rm backend python manage.py prune_notifications
```

## Kubernetes (Helm)

The chart renders one `CronJob` for each enabled entry under `scheduledJobs`.
Each CronJob runs in the backend image, with the backend's environment and
runtime Secret.

```bash
helm upgrade visiban oci://ghcr.io/visiban/charts/visiban --reuse-values \
  --set scheduledJobs.enabled=true
```

To enable the prune jobs as well, put this in your values file:

```yaml
scheduledJobs:
  enabled: true
  pruneBoardEvents:
    enabled: true
  pruneNotifications:
    enabled: true
    # Optional: extra arguments appended to the command.
    args: ["--days", "180"]
```

| Key | Default | Meaning |
|---|---|---|
| `scheduledJobs.enabled` | `false` | Master switch. Nothing is rendered while it is off. |
| `scheduledJobs.timeZone` | `""` | IANA zone for every schedule (CronJob `.spec.timeZone`, Kubernetes 1.27+). Empty means the controller's zone, which is UTC on almost every cluster. |
| `scheduledJobs.<job>.enabled` | `true` for `notifyDueSoon` and `notifyStaleCards`; `false` for `pruneBoardEvents` and `pruneNotifications` | Per-job switch |
| `scheduledJobs.<job>.schedule` | See the table at the top of this page | Standard 5-field cron expression |
| `scheduledJobs.<job>.args` | `[]` | Extra arguments for `manage.py <command>` |
| `scheduledJobs.activeDeadlineSeconds` | `3600` | A run still going after this is killed and marked failed. |
| `scheduledJobs.backoffLimit` | `1` | Retries before a run is marked failed |
| `scheduledJobs.startingDeadlineSeconds` | `300` | A run that cannot start within this window is skipped, not started late. |
| `scheduledJobs.ttlSecondsAfterFinished` | `86400` | How long finished Jobs and their logs are kept |
| `scheduledJobs.resources` | 50m/128Mi requests, 500m/512Mi limits | Container resources |

Every CronJob uses `concurrencyPolicy: Forbid`, so a slow run is never joined by
the next one. The pods carry `app.kubernetes.io/component: scheduler`. With
`networkPolicy.enabled=true`, that label is allowed to reach PostgreSQL and
Valkey.

To check on the jobs:

```bash
kubectl get cronjobs -l app.kubernetes.io/component=scheduler
kubectl get jobs -l app.kubernetes.io/component=scheduler
kubectl logs job/<job-name>
```

To trigger a run by hand, for example to test SMTP delivery:

```bash
kubectl create job --from=cronjob/visiban-notify-due-soon notify-due-soon-manual
```

## Retention settings

| Variable | Default | Minimum | Enforced by |
|---|---|---|---|
| `BOARD_EVENT_RETENTION_DAYS` | `30` | 1 | `prune_board_events` |
| `NOTIFICATION_RETENTION_DAYS` | `90` | 14 | `prune_notifications` |

A retention window only takes effect once its prune job is scheduled. Until
then, nothing is deleted.

`prune_notifications` refuses a window shorter than 14 days. The notification
rows are also the scans' record of what they have already sent: pruning them
too soon would make `notify_due_soon` and `notify_stale_cards` notify, and
email, the same card again.

Before you enable a prune job on an existing install, preview what its first
run would delete:

```bash
docker compose -f docker-compose.prod.yml run --rm backend python manage.py prune_notifications --dry-run
docker compose -f docker-compose.prod.yml run --rm backend python manage.py prune_board_events --dry-run
```

The first run on a large, never-pruned table deletes in batches of 5,000 rows
(`--batch-size`), so it does not hold long locks.
