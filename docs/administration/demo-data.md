# Demo Data

> **Warning: development and staging only.** The command is guarded against running when `DEBUG=False` without `--force`, but `--force` must never be used on a live database. Demo boards, demo users, and dummy cards are indistinguishable from real data at the database level — there is no `is_demo` flag and no automated cleanup. See [Cleaning up accidental seeding](#cleaning-up-accidental-seeding) if this happens.

## Overview

> **Changed in 1.2** — the board also belongs to a demo Group, and a custom field value, a file attachment, a `SavedFilter`, a group invite link, and a group label are now seeded alongside the board and cards.

The `seed_demo_data` management command creates a "Visiban Demo Board" populated with realistic-looking data: five columns, ten swimlanes, ~80 cards, movement history, checklists, and comments. The board also belongs to a demo Group, and one card carries a custom field value and a file attachment; one `SavedFilter`, one group invite link, and one group label are seeded as well, so every board- and group-scoped resource family has at least one real row. It is intended for:

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

- **Software Team** (Backlog / In Progress / Review / Done), **Marketing Campaigns**, and **Hiring Pipeline** boards, 20 cards each, with comments, assignees, labels, and movement history
- the **published visitor** account (username from `DEMO_LOGIN_USERNAME`, default `visitor`; password from `DEMO_LOGIN_PASSWORD`) — a plain MEMBER on every seeded board, never a site admin, board admin or moderator. While `DEMO_MODE` is on, this one account may also edit and archive cards other people created (every seeded card belongs to the admin); that exception is read from the setting at request time, so it disappears the moment `DEMO_MODE` is turned off rather than living on as a stored permission
- a site **admin** account (`admin`, password from `DEMO_ADMIN_PASSWORD`, **never published**) that owns the seeded boards
- two member accounts, `maya` and `jordan` (password from `DEMO_MEMBER_PASSWORD`)

It also turns file uploads off and sets registration to **closed**.

Passwords come only from the environment and are re-applied on every run. The command refuses to run unless `DEMO_MODE=true` and `DEMO_LOGIN_PASSWORD`, `DEMO_ADMIN_PASSWORD` and `DEMO_MEMBER_PASSWORD` are all set, refuses an admin password equal to the published one, refuses a `DEMO_LOGIN_USERNAME` that names another seeded account, and cannot be combined with `--export` or `--scale`. The onboarding tour is marked **completed** for the published visitor on every run: finishing the tour saves a profile flag, which the demo fence refuses, so an auto-running tour would end every visitor's first minute on a refusal. The unpublished accounts have the flag reset on every run, so the tour starts on their first login after each reset.

See [Demo mode](configuration.md#demo-mode) for the settings. The deployment itself — the hourly reset CronJob, the egress NetworkPolicy and the post-deploy fence check — ships in the Helm chart (#1180).

### Threat model

> **Added in 1.2** (#1179).

A public demo publishes a working login. Everything that account can do, the whole internet can do, and it can do it to every other visitor. Two facts shape the design:

- **Role is not a control.** `POST /api/v1/boards/` and `POST /api/v1/groups/{id}/boards/` make *any* authenticated caller the ADMIN of the board they create. A published credential of any role is therefore one request away from owning something. Seeding a harmless role cannot hold.
- **The guarantee is a deployment mode.** With `DEMO_MODE=true`, `DemoModeMiddleware` refuses every request whose method is not `GET`, `HEAD` or `OPTIONS` — including `TRACE` and unknown verbs — for **every caller**, a site admin and anonymous clients included, unless it is on a short, pinned allowlist. A route added in a later release is refused by construction until someone deliberately adds it. The same rule covers allauth's `/accounts/` tree, `/admin/`, and `/mcp` (every MCP write tool is refused).

A refusal is `403` with a stable body:

```json
{"code": "demo_read_only", "detail": "This is a shared demo — this change can't be saved here. ..."}
```

**What a visitor can do:** sign in and out, watch live updates, and create, edit (including custom-field values), move, archive and restore cards, and add, tick and remove checklist items. Each move is recorded in the card's History, which is the point of the demo. Allowed writes still pass normal board permissions.

**What a visitor cannot do:** create, rename or delete boards, columns, swimlanes, labels or custom fields; delete cards; comment; upload attachments; add card relations; change their profile, password or preferences; mint personal access tokens; register, request a password reset (so the demo cannot be used as an email relay), or use invites and groups; connect a lens; import; or reach anything under the admin API. The SPA disables the most visible of these controls up front with the reason ("This is a shared demo — …"), and shows a toast if any other refusal reaches it.

**The reset is containment, not a control.** Every hour, on the hour (`DEMO_RESET_SCHEDULE`), the reset job wipes the **whole database** and reseeds it. That also ends every session, because sessions are database-backed — visitors are told so on the login page and in the in-app demo bar, get a warning five minutes before, and land back on the login page with a "demo was reset" notice. The reset must stay a whole-database wipe: some tables (for example `BoardEvent`, whose `board_id` is deliberately not a foreign key) are not cleaned up by deleting boards, so a per-row reset would leak rows across resets.

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
