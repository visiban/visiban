# Demo Data

`seed_demo_data` populates a board with realistic fake data for local development, staging demos, and CI. **Why it matters:** never point it at a database with real data — see the guard below.

> **Warning: development and staging only.** The command is guarded against running when `DEBUG=False` without `--force`, but `--force` must never be used on a live database. Demo boards, demo users, and dummy cards are indistinguishable from real data at the database level — there is no `is_demo` flag and no automated cleanup. See [Cleaning up accidental seeding](#cleaning-up-accidental-seeding) if this happens.

## Overview

> **Changed in 1.2** — the board also belongs to a demo Group, and a custom field value, a file attachment, a `SavedFilter`, a group invite link, and a group label are now seeded alongside the board and cards.

It creates a "Visiban Demo Board": five columns, ten swimlanes, ~80 cards, movement history, checklists, and comments. The board also belongs to a demo Group, and one card carries a custom field value and a file attachment; one `SavedFilter`, one group invite link, and one group label are seeded as well, so every board- and group-scoped resource family has at least one real row. Use it for:

- Local development to have a board ready without manual setup
- Staging environments used for product demos or sales calls
- CI pipelines that need a non-empty board for integration tests

## Running the command

```bash
# Create the demo board (skip if it already exists). Requires DEBUG=True or --force.
python manage.py seed_demo_data

# Wipe and recreate from scratch. Requires DEBUG=True or --force.
python manage.py seed_demo_data --wipe

# Run on a staging/CI environment where DEBUG=False
python manage.py seed_demo_data --force
python manage.py seed_demo_data --wipe --force

# After seeding, write canonical JSON and CSV snapshots to scripts/seed/
# Run this and commit the result whenever the board structure changes
python manage.py seed_demo_data --export

# Use a specific random seed instead of the command's built-in default
python manage.py seed_demo_data --wipe --force --seed 42
```

!!! info "Large fixture for load testing"
    `--scale N` (replicate the swimlane layout N times) and `--with-notifications` seed a
    much larger, separately-named **"Visiban Load Test Board"** instead of the normal demo
    board — never combine `--scale > 1` with `--export`. This is CI-only, used by the
    `nightly-load-test` job; see
    [Nightly load test](../development/nightly-load-test.md) for the full contract.

## Production guard

Both the plain run and the `--wipe` flag are guarded: the command raises an error if `DEBUG` is `False` and `--force` is not passed.

```
CommandError: Refusing to seed: DEBUG is False.
Pass --force to override (only safe on dedicated demo environments).
```

Use `--force` only on dedicated demo or staging environments — never against a live database:

```bash
# Allowed on staging where DEBUG=False
python manage.py seed_demo_data --force
python manage.py seed_demo_data --wipe --force
```

Even with the guard in place, do not expose `manage.py` on production servers in ways that allow arbitrary command execution, and ensure your deployment runbooks do not include `seed_demo_data` in any production provisioning step.

## Demo user accounts

The seed command creates five user accounts with unusable passwords (they cannot log in via password auth):

| Username | Email |
|---|---|
| `demo1` | `demo1@visiban.example` |
| `demo2` | `demo2@visiban.example` |
| `demo3` | `demo3@visiban.example` |
| `demo4` | `demo4@visiban.example` |
| `demo5` | `demo5@visiban.example` |

The `@visiban.example` domain is deliberately not a real domain. If you need to use demo accounts for OAuth testing, you will need to adjust these emails to match your OAuth provider's allowed domains.

## Hosted demo instance

> **Added in 1.2** — for running a public demo such as try.visiban.com (#1034).

`seed_demo_data --demo-site` additionally seeds the content a public demo needs. It is opt-in; without the flag the command behaves exactly as described above.

```bash
python manage.py seed_demo_data --force --wipe --demo-site
```

It creates, alongside the normal demo board:

- **Software Team** (Backlog / In Progress / Review / Done), **Marketing Campaigns**, and **Hiring Pipeline** boards, 20 cards each, with comments, assignees, labels, and movement history. Each board also shows off (#1363):
    - partly done **checklists** — a release checklist on Software Team, interview loops on Hiring Pipeline
    - **card custom fields** with values on most cards, at least one pinned to the card face — Story points and Target release; Budget and Channel; Source, Interview score and Offer stage
    - **swimlane custom fields** — one visible to everyone and one admin-only per board (for example Hiring Pipeline's Salary band)
    - **card relations** — a few blocks / relates-to pairs, including at least one card still blocked by unfinished work
    - on Software Team, linked GitLab and GitHub **merge / pull requests** (fictional `*.example.com` URLs)
    - a realistic **age mix**: most cards moved in the last few days, a few aging and a few stale, with due dates that are overdue, due today, upcoming, or unset. Stale and overdue cards are always in-flight work, never in the Done column. Ages are counted back from the day of the reset, so the mix looks the same after every reset
- a seeded **notification inbox** for the published visitor: twelve unread notifications across the three boards (@mentions, assignments, card moves, a new comment, and stale and due-soon alerts), each from another account or from the system, never from the visitor. The demo fence refuses marking notifications read, so they stay unread until the next reset
- the **published visitor** account (username from `DEMO_LOGIN_USERNAME`, default `visitor`; password from `DEMO_LOGIN_PASSWORD`) — a plain MEMBER on every seeded board, never a site admin, board admin or moderator. While `DEMO_MODE` is on, this one account may also edit and archive cards other people created (every seeded card belongs to the admin); that exception is read from the setting at request time, so it disappears the moment `DEMO_MODE` is turned off rather than living on as a stored permission
- a site **admin** account (`admin`, password from `DEMO_ADMIN_PASSWORD`, **never published**) that owns the seeded boards
- two member accounts, `maya` and `jordan` (password from `DEMO_MEMBER_PASSWORD`)

It also turns file uploads off and sets registration to **closed**.

Passwords come only from the environment and are re-applied on every run. The command refuses to run unless `DEMO_MODE=true` and `DEMO_LOGIN_PASSWORD`, `DEMO_ADMIN_PASSWORD` and `DEMO_MEMBER_PASSWORD` are all set, refuses an admin password equal to the published one, refuses a `DEMO_LOGIN_USERNAME` that names another seeded account, and cannot be combined with `--export` or `--scale`. The onboarding tour is marked **completed** for the published visitor on every run: finishing the tour saves a profile flag, which the demo fence refuses, so an auto-running tour would end every visitor's first minute on a refusal. The unpublished accounts have the flag reset on every run, so the tour starts on their first login after each reset.

### Resetting the whole database

```bash
python manage.py seed_demo_data --force --wipe --demo-site --reset-database
```

> **Added in 1.2** (#1180).

`--reset-database` empties **every table** first, using Django's `flush`, and then seeds. This is the hosted demo's reset. The Helm chart's seed hook and hourly reset CronJob run exactly this command. A per-board `--wipe` is not enough for a public demo. It leaves sessions behind, so visitors would stay signed in across a reset the login page says signs them out. It also leaves rows that deleting boards does not reach (`BoardEvent.board_id` is deliberately not a foreign key) and anything a visitor created elsewhere. After the flush the command re-applies the Sites domain from `SITE_DOMAIN`.

The flag is valid only with `--demo-site`, which refuses to run unless `DEMO_MODE=true`. The command therefore cannot empty the database of a normal install.

See [Demo mode](configuration.md#demo-mode) for the settings, and [Public demo mode (Helm)](#public-demo-mode-helm) for the supported deployment.

### Threat model

> **Added in 1.2** (#1179).

A public demo publishes a working login. Everything that account can do, the whole internet can do, and it can do it to every other visitor. Two facts shape the design:

- **Role is not a control.** `POST /api/v1/boards/` and `POST /api/v1/groups/{id}/boards/` make *any* authenticated caller the ADMIN of the board they create. A published credential of any role is therefore one request away from owning something. Seeding a harmless role cannot hold.
- **The guarantee is a deployment mode.** With `DEMO_MODE=true`, `DemoModeMiddleware` refuses every request whose method is not `GET`, `HEAD` or `OPTIONS` — including `TRACE` and unknown verbs — for **every caller**, a site admin and anonymous clients included, unless it is on a short, pinned allowlist. A route added in a later release is refused by construction until someone deliberately adds it. The same rule covers allauth's `/accounts/` tree, `/admin/`, and `/mcp` (every MCP write tool is refused).
- **A published credential turns a per-account lockout into a DoS lever.** The login endpoint locks an account out for 5 minutes after 5 failed passwords — a real defense on a normal install (see [Rate limiting](../architecture/deployment.md#rate-limiting)), but on a demo instance the published account's password is public, so *anyone* can send 5 wrong passwords and lock out every other visitor sharing that credential, repeatably. `accounts.serializers.LoginSerializer` exempts `DEMO_LOGIN_USERNAME` specifically — whether the visitor types that username or the demo account's email address (#1206) — from the per-account lockout while `DEMO_MODE` is on (#1199) — the per-IP throttle still applies, and every other account (including a real user's, if one exists on a demo instance) keeps the full lockout.

A refusal is `403` with a stable body:

```json
{"code": "demo_read_only", "detail": "This is a shared demo — this change can't be saved here. ..."}
```

**What a visitor can do:** sign in and out, watch live updates, and create, edit (including custom-field values), move, archive and restore cards, and add, tick and remove checklist items. Each move is recorded in the card's History, which is the point of the demo. Allowed writes still pass normal board permissions.

**What a visitor cannot do:** create, rename or delete boards, columns, swimlanes, labels or custom fields; delete cards, comments or attachments; comment; upload attachments; add or remove card relations; star or unstar a board; mark a notification read; change their profile, password or preferences; mint personal access tokens; register, request a password reset (so the demo cannot be used as an email relay), or use invites and groups; connect a lens; import; or reach anything under the admin API. The SPA disables every one of these controls up front with the reason ("This is a shared demo — …") rather than letting the click round-trip to a 403 — `DemoWriteBlockedToast` remains as a shell-level safety net for whatever a future surface adds without its own affordance, not the primary mechanism.

> **Added in 1.2** (#1193). A completeness-check on #1179 found several refused writes that still fell through to `DemoWriteBlockedToast` with no up-front affordance: deleting a comment or an attachment (card delete was already hidden outright, not merely toast-caught — see `frontend/CLAUDE.md` § Hosted demo surfaces); adding a card relation; starring or unstarring a board; and the "Mark all read" notification action. Each now gets the same `aria-disabled` treatment, reason and copy template as the surfaces #1179 shipped. Three cases are handled differently, because the write is not a control the visitor reached for:
> - **Clicking an individual notification** still navigates to the related card (its whole purpose) but silently skips the mark-read call rather than becoming aria-disabled, which would also block that navigation — the one explicit, standalone mark-read control ("Mark all read") gets the up-front affordance instead.
> - **The theme-preference sync** (`ThemeServerSync`) silently skips its PATCH; the local theme still applies via `localStorage`, only the cross-device sync is skipped.
> - **The onboarding tour's completion save** doesn't need a skip at all: `seed_demo_data` seeds the published visitor's `has_completed_tour` flag `true`, so the tour — and its completion save — never fires.
>
> Removing a card relation is refused by the fence too, and its control is hidden outright in demo mode, like card delete. When #1193 shipped no demo board had a relation, so that gate was defensive; since #1363 the seed adds relations, so it is what visitors actually see.

**The reset is containment, not a control.** Every hour, on the hour (`DEMO_RESET_SCHEDULE`), the reset job wipes the **whole database** and reseeds it (`--reset-database`). That also ends every session, because sessions are database-backed — visitors are told so on the login page and in the in-app demo bar, get a warning five minutes before, and land back on the login page with a "demo was reset" notice. The reset must stay a whole-database wipe: some tables (for example `BoardEvent`, whose `board_id` is deliberately not a foreign key) are not cleaned up by deleting boards, so a per-row reset would leak rows across resets.

## Public demo mode (Helm)

> **Added in 1.2** (#1180). This replaces the Docker Compose demo stack (`deploy/demo/`), which was never released.

The Helm chart is the supported way to run a public demo. Enable it with the `demo:` block, starting from the shipped `helm/visiban/values-demo.yaml`. The block is **off by default**, and with it off the chart renders exactly what it did before, so `helm upgrade` on an existing release changes nothing.

```bash
helm upgrade --install visiban-demo ./helm/visiban \
  --namespace visiban-demo --create-namespace \
  -f helm/visiban/values-demo.yaml \
  -f demo-secrets.yaml          # never committed: see the SECRETS block in values-demo.yaml
helm test visiban-demo -n visiban-demo --logs
```

!!! danger "Never on an instance with real data"
    The seed hook and the reset **empty every table** on every install, every upgrade and every scheduled run.

### Values

| Key | Default | Description |
|---|---|---|
| `demo.enabled` | `false` | Renders `DEMO_MODE=true` on every backend container, which arms the write fence. Also renders the seed hook, the reset CronJob, the demo Secret, the egress NetworkPolicy and the demo `helm test`. |
| `demo.loginHint.username` / `.password` | *(empty)* | The **published** visitor credential shown on the login page. Both are required when the demo is on, and refused when it is off. Username: letters, digits and `. _ @ + -`, not `admin`, `maya` or `jordan`. Password: 8 to 128 characters of letters, digits and `. _ @ + ~ ! * = : , ; ? -`. |
| `demo.adminPassword` | *(empty)* | The demo site admin's password. **Never published.** Required, and must differ from the published password. |
| `demo.memberPassword` | *(empty)* | The two seeded member accounts' password. Required, and must differ from the published password. |
| `demo.reset.enabled` | `true` | Renders the reset CronJob. When `false`, `DEMO_RESET_SCHEDULE` is rendered empty and the login page promises no reset. |
| `demo.reset.schedule` | `0 * * * *` | When to reset, always in UTC. The same value becomes the backend's `DEMO_RESET_SCHEDULE`, which drives the countdown visitors see, so the two cannot drift. Minute and hour fields only; the other three must be `*`. |
| `demo.reset.*` | | `startingDeadlineSeconds`, `activeDeadlineSeconds`, `backoffLimit`, `successfulJobsHistoryLimit`, `failedJobsHistoryLimit` (at least 1, so a failed run stays visible). |
| `demo.seed.*` | | `activeDeadlineSeconds` and `backoffLimit` of the install/upgrade seed hook. |
| `demo.throttle.userRate` | *(empty)* | `DEMO_USER_THROTTLE_RATE`. It re-aims the `user` throttle scope, which every visitor shares because they all use one account. `values-demo.yaml` sets `60000/hour` as a ceiling that protects the node, not a per-visitor limit. |
| `demo.resourceQuota.*` | off | A ResourceQuota and a LimitRange for the release's namespace, for a demo that shares a node. Only use it in a namespace dedicated to the demo. |
| `backend.settings.numProxies` | *required, ≥ 1* | `NUM_PROXIES`, [the client-IP depth](configuration.md#reverse-proxies-and-the-client-ip). `values-demo.yaml` sets `2` for a Cloudflare Tunnel. |

The chart **refuses to render** a demo that could publish a credential, reach out, or silently collapse its per-visitor throttles. It fails when `loginHint` is set while the demo is off, when a `loginHint` half is missing or outside its character set, when SSO/OAuth or real SMTP is configured, when the media PVC is enabled, when `backend.settings.debug` is anything django-environ's parser treats as true — not just the literal `true`, but also `on`/`ok`/`y`/`yes` and any nonzero integer string like `1` or `-1` — when `networkPolicy.enabled` is off, when the bundled PostgreSQL or Valkey is replaced by an external one, when `backend.settings.numProxies` is unset or below `1`, when the schedule is one the backend cannot evaluate, and when `demo.throttle.userRate` is malformed.

### What the chart guarantees, and what it does not

- **The fence is the control.** `DEMO_MODE` arms `DemoModeMiddleware` (see [Threat model](#threat-model)). The chart's job is to guarantee that the variable reaches every container that imports Django settings: the backend and its init containers, the seed and reset pods, and scheduled jobs.
- **`helm test` proves it after every deploy.** Through the frontend Service, the path a visitor's request takes, it signs in with the published credential (expects `200`), creates a board (expects `403` with `demo_read_only` in the body; a `403` from a permission check does not count), moves a seeded card (expects `200`), and checks that `site-config` publishes `demo_next_reset_at` if and only if the reset runs. It does not check the tunnel or anything else in front of the frontend.
- **The reset is containment, not a control.** The seed hook (post-install and post-upgrade) and the reset CronJob run the same pod: `migrate_with_lock`, then `seed_demo_data --force --wipe --demo-site --reset-database`. Every run signs every visitor out and re-applies the published password, so the login hint never points at a dead account. The CronJob runs with `concurrencyPolicy: Forbid`. A failed run keeps its Job for `kubectl logs` and leaves the previous data up. It is never a readiness signal, so a failed reset cannot take the demo down. The seed runs in its own pod, and demo mode has no shared media volume. The one small attachment the base demo board seeds therefore has no file on the serving pod, and downloading it answers `404`.
- **Egress is denied at the pod.** A NetworkPolicy limits the backend, the seed and reset pods and the scheduled-job pods to DNS and the release's own PostgreSQL and Valkey. That closes, at the network layer, every outbound path a visitor could reach through the app: the lens, mail, and any future call site. It is only real if the cluster's CNI enforces NetworkPolicy. CI proves it on Calico. On your cluster, check it yourself (see the maintainer runbook's [enforcement check](../maintainers/demo-deploy.md#2-networkpolicy-is-enforced-on-the-node)).

### Preconditions outside the chart

These cannot be expressed in values, and no CI job can verify them:

- **Expose only the frontend Service**, for example through a Cloudflare Tunnel public hostname. The chart renders no Ingress in `values-demo.yaml`.
- **Count your proxies.** Behind a tunnel, set `backend.settings.numProxies` to the real number of hops that append to `X-Forwarded-For` — including this chart's own frontend nginx, which always adds one. The chart refuses to render below `1` (every visitor sharing one login/anonymous throttle bucket is caught at render time, not left as a silent risk), but it cannot know your actual proxy depth: get the count right, not just non-zero.
- **Per-visitor rate limiting after sign-in** has to come from in front of the host, such as a Cloudflare IP rate-limit rule. Every visitor shares one account, so the `user` throttle cannot tell them apart.
- **The host must not run CI jobs** (TruePPM ADR-1197 D10).
- **Kubernetes 1.27 or later**, for the CronJob `timeZone` field.

The runbook for try.visiban.com itself, including the deployment record, is [Hosted Demo](../maintainers/demo-deploy.md).

## Demo data and real data

Demo records carry no special marker. A demo card looks identical to a real card at the database level — same fields, same UID format, same `archived_at` behavior. This means:

- Archived demo cards show up alongside real archived cards in any query that reads `archived_at`
- Movement history generated by the seed command is stored in `CardMovement` alongside real movement records
- Deleting a demo board also deletes all its cards, movements, and comments via cascading FK deletes — swimlane and label objects tied to the board are removed too, but the demo user accounts (`demo1`–`demo5`) persist
- The demo board's Group (`Board.group` uses `on_delete=SET_NULL`) is **not** removed by deleting the board — deleting the Group directly (see below) is required to avoid leaving an orphaned "Visiban Demo Workspace" behind

## Cleaning up accidental seeding

If `seed_demo_data` is run against a production database by mistake:

```python
# In a Django shell (python manage.py shell)
from boards.models import Board
from groups.models import Group
Board.objects.filter(name="Visiban Demo Board").delete()
Group.objects.filter(name="Visiban Demo Workspace").delete()
```

This cascade-deletes all columns, swimlanes, labels, custom fields, saved filters, attachments, cards, movements, and comments associated with the demo board, and the Group delete cascade-removes its invite links and group labels. Neither step removes the demo user accounts. To remove those:

```python
from accounts.models import User
User.objects.filter(username__in=["demo1", "demo2", "demo3", "demo4", "demo5"]).delete()
```

Run both steps inside a transaction if you want to roll back on failure:

```python
from django.db import transaction
with transaction.atomic():
    from boards.models import Board
    from accounts.models import User
    Board.objects.filter(name="Visiban Demo Board").delete()
    User.objects.filter(username__startswith="demo", email__endswith="@visiban.example").delete()
```

## GitLab CI setup for automated demo refresh

The `seed-demo-data` GitLab CI job refreshes the demo board on a weekly schedule and can also be triggered manually from the GitLab pipeline UI. It requires three GitLab CI/CD variables and a pipeline schedule to be configured before it will work.

### Required GitLab CI/CD variables

In your GitLab project, go to **Settings → CI/CD → Variables** and add the following. All three must be **Protected** and **Masked**, scoped to the `demo` environment.

| Variable | Description |
|---|---|
| `DEMO_SECRET_KEY` | Django secret key for the demo environment. Generate with: `python -c "import secrets; print(secrets.token_hex(50))"` |
| `DEMO_DATABASE_URL` | PostgreSQL connection string for the demo environment's database, e.g. `postgres://user:pass@host:5432/dbname` |
| `DEMO_REDIS_URL` | Valkey (or Redis-compatible) connection string for the demo environment, e.g. `redis://host:6379/0` |

!!! warning
    If any of these variables are missing or empty, the GitLab CI job fails immediately with `ImproperlyConfigured: DJANGO_SECRET_KEY must be set`. The job appears in all pipelines as a manual trigger — if you see this error after clicking **Run**, check that all three variables are set and scoped correctly to the `demo` environment in **Settings → CI/CD → Variables**.

### Setting up the weekly GitLab CI schedule

1. In your GitLab project, go to **CI/CD → Schedules** and click **New schedule**.
2. Set the cron to `0 4 * * 1` (Mondays at 04:00 UTC).
3. Set the target branch to `main`.
4. Add a schedule variable: `SEED_SCHEDULE` = `true`.
5. Save the schedule.

The schedule variable `SEED_SCHEDULE=true` is what activates the job — without it the scheduled GitLab pipeline runs but `seed-demo-data` is skipped.

### Optional: custom random seed

The job uses today's date (`YYYYMMDD`) as the random seed by default, so each weekly refresh produces a naturally varied board while remaining reproducible within the same day. To override this, set `SEED_VALUE` to any integer when triggering the job manually via the GitLab pipeline UI:

| Variable | Example value | Effect |
|---|---|---|
| `SEED_VALUE` | `42` | Uses seed 42 — same board layout every time |
| *(unset)* | — | Uses today's date — varies weekly |

## Import files and test data

The board import endpoint (`POST /api/v1/boards/import/`) accepts the same JSON and CSV format produced by the board export. If someone uploads a hand-crafted file to simulate a board import (for automation testing, template validation, etc.):

- **All objects receive fresh UIDs** — the import code ignores any `uid` field present in the source file and generates new UIDs for every board, column, swimlane, label, and card created
- **Imported records are not tagged as test data** — they are real database rows with no provenance marker
- **Column, swimlane, and label names drive the import** — duplicate names within the same file are merged into a single object; the card's `column` and `swimlane` fields must match a name defined in the file's `columns`/`swimlanes` arrays

If you are using the import endpoint to load test data, clean it up explicitly after the test. There is no bulk-delete-by-source-file operation; you will need to delete the board that was created.

### Identifying test boards in development

If your development workflow involves creating many imported boards for testing, consider using a recognizable name prefix (e.g. `TEST: My Board`) so they can be found and deleted in bulk:

```python
Board.objects.filter(name__startswith="TEST:").delete()
```

This is a convention, not an enforced constraint, and relies on the person creating the test data using the prefix consistently.
