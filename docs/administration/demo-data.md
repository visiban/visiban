# Seed a demo board in one command

Run `python manage.py seed_demo_data` to populate a board with realistic fake data for local development, staging demos, and CI.

**Why it matters:** never point it at a database with real data. See the guard below.

**The big picture:** the command has three levels.

- **Default:** one "Visiban Demo Board" (see [Overview](#overview)).
- **`--demo-site`:** the showcase content for a public demo (see [Hosted demo instance](#hosted-demo-instance)).
- **Helm:** a supported public deployment (see [Public demo mode (Helm)](#public-demo-mode-helm)).

> **Warning: development and staging only.** The command is guarded against running when `DEBUG=False` without `--force`, but `--force` must never be used on a live database. Demo boards, demo users, and dummy cards are indistinguishable from real data at the database level — there is no `is_demo` flag and no automated cleanup. See [Cleaning up accidental seeding](#cleaning-up-accidental-seeding) if this happens.

## Overview

> **Changed in 1.2** — the board also belongs to a demo Group, and a custom field value, a file attachment, a `SavedFilter`, a group invite link, and a group label are now seeded alongside the board and cards.

It creates a "Visiban Demo Board": five columns, ten swimlanes, ~80 cards, movement history, checklists, and comments. The board also belongs to a demo Group. One card carries a custom field value and a file attachment, and one `SavedFilter`, one group invite link, and one group label are seeded too, so every board- and group-scoped resource family has at least one real row. The non-owner demo users (`demo2` to `demo5`) are `MEMBER`s of the demo Group (`demo1` is its admin). `demo2` authored one card with its own attachment, comment, checklist item, and relation (used by the schema-fuzz CI job). Use it for:

- Local development to have a board ready without manual setup
- Staging environments used for product demos or sales calls
- CI pipelines that need a non-empty board for integration tests

Card due dates on the generic demo board count from the day the command runs (UTC), so a board reseeded by the hourly reset never drifts into overdue. `--seed` keeps titles, layout and day offsets identical; only the calendar day moves (#1948).

## Running the command

```bash
# Create the demo board (skip if it already exists). Requires DEBUG=True or --force.
python manage.py seed_demo_data

# Wipe and recreate from scratch. Requires DEBUG=True or --force.
python manage.py seed_demo_data --wipe

# Run on a staging/CI environment where DEBUG=False
python manage.py seed_demo_data --force
python manage.py seed_demo_data --wipe --force

# Use a specific random seed instead of the command's built-in default
python manage.py seed_demo_data --wipe --force --seed 42
```

!!! info "Large fixture for load testing"
    `--scale N` (replicate the swimlane layout N times), `--with-notifications` and
    `--extra-boards M` (M small extra boards owned by `demo3`, so that user can access M+1
    boards; requires `--scale` above 1) seed a
    much larger, separately-named **"Visiban Load Test Board"** instead of the normal demo
    board — This is CI-only, used by the
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

**Watch out:** even with the guard in place, do not expose `manage.py` on production servers in ways that allow arbitrary command execution. Make sure your deployment runbooks do not include `seed_demo_data` in any production provisioning step.

## Demo user accounts

The seed command creates five user accounts with unusable passwords (they cannot log in via password auth):

| Username | Email |
|---|---|
| `demo1` | `demo1@visiban.example` |
| `demo2` | `demo2@visiban.example` |
| `demo3` | `demo3@visiban.example` |
| `demo4` | `demo4@visiban.example` |
| `demo5` | `demo5@visiban.example` |

**Yes, but:** the `@visiban.example` domain is deliberately not a real domain. To use demo accounts for OAuth testing, adjust these emails to match your OAuth provider's allowed domains.

## Hosted demo instance

> **Added in 1.2** — for running a public demo such as try.visiban.com (#1034).

`seed_demo_data --demo-site` additionally seeds the content a public demo needs. It is opt-in; without the flag the command behaves exactly as described above.

```bash
python manage.py seed_demo_data --force --wipe --demo-site
```

`--wipe` deletes the showcase boards before recreating them, including the Marketing Campaigns and Hiring Pipeline boards that releases before #1389 seeded. Each deleted board gets a `board.deleted` entry in the [change feed](../api/events.md), as an API delete does, so a feed consumer is never left on a board that no longer exists (#1889).

It creates, alongside the normal demo board:

- seven showcase boards, each a different workflow with a different **swimlane entity** (#1389, #1412). The swimlane is the thing being managed (a property, a project, an account), with its own fields pinned to the row header:

    | Board | Swimlane is a… | Pinned row fields | On the cards | Question it answers |
    |---|---|---|---|---|
    | **Software Team** | service area | Service tier, Cost center | Story points, Target release | The familiar baseline |
    | **Property Management** | property | Property manager, Region, Unit count | Unit, Vendor, Cost estimate; issue-type labels (Plumbing, Electrical, HVAC, Pest, Appliance, Turnover) | Which properties have unresolved work? |
    | **Construction** | project | Project manager, Region, Phase | Subcontractor, Permit #, permit portal link; due dates | What is going to delay the project? |
    | **Sales Territory** | account | AE, SA, Region | Deal value, CRM record link, Stage | Which accounts are not getting attention? |
    | **Sales Territory (Overlay)** | account | AD, Coverage, AE, SA, OAE, OSA, SVC and Region pinned on the lane, seven more row fields (segment, install base ARR, renewal date, overlay products owned, account plan link, strategic account) in the field panel and an admin-only Executive sponsor; nine pipeline columns (Identify, Discover, Qualify, Shape, Validate, Commercial, Commit, then Won and Lost as closed outcomes). One account's overlay pod is Partial and one has a Gap | Every custom field type: deal value, forecast, win probability, expected close, overlay products, overlay engaged, champion, competitor, next step, services lead, CRM link; opportunity-type labels | Which accounts have a coverage gap, and which deals does it put at risk? |
    | **Content Moderation** | content queue | Moderator lead, Region, Policy tier | Report reasons (multi-select), Reporter count | What has waited longest for review? |
    | **Logistics Exceptions** | shipment | Carrier, Lane, Customer | Exception type, ETA, tracking link | Which shipments need intervention? |

    Software Team has 20 cards and the five other hand-built boards 16 each, with comments, assignees, labels, and movement history.

    **Sales Territory (Overlay) is the [Sales Overlay sample board](../getting-started/sample-boards.md)** (#1889). The command imports the shipped sample through the importer the gallery's **Create from sample** uses, named "Sales Territory (Overlay)". It carries what any imported board carries:

    - 46 cards over ten accounts
    - the sample's full history, credited to the importing admin, with each original name kept as **import provenance**
    - a Commercial column over its WIP limit, and a weight limit
    - closed deals (won and lost) already archived
    - a `board.created` entry in its change feed

    The sample's cast (`demo1`-`demo5`) and the demo accounts are members. Dates move as the gallery moves them: the sample's anchor date becomes the day of the reset, so ages and due dates count from the reset and nothing is dated in the future (every sample's newest event is a day before its anchor). The sample format carries no card relations yet ([#1448](https://gitlab.com/visiban/visiban/-/issues/1448)), so this board has none. Its URL is stable across resets: the reset restarts the id sequences and creates the boards in a fixed order, which puts it at `/boards/6`.

    The six other boards each also show off (#1363):

    - partly done **checklists**, such as a release checklist on Software Team and inspection steps on Construction
    - **card custom fields** with values on most cards, at most two pinned to the card face. They use number formatting (a `$` prefix on Cost estimate and Deal value), colored dropdown and multi-select choices, URL fields and a date field (#1390, #1391)
    - **swimlane custom fields**: on the five entity boards, three pinned row fields that the visitor can see, with a different value on every row, plus one admin-only field (for example Sales Territory's Executive sponsor). Software Team keeps one public field and one admin-only field
    - **card relations**: a few blocks / relates-to pairs, including at least one card still blocked by unfinished work
    - on Software Team, linked GitLab and GitHub **merge / pull requests**
    - on the six hand-built boards, a realistic **age mix**: most cards moved in the last few days, a few aging and a few stale, with due dates that are overdue, due today, upcoming, or unset. Stale and overdue cards are always in-flight work, never in the Done column. Ages, due dates and the Logistics ETAs are counted from the day of the reset, so the mix looks the same after every reset

    Every card on every demo board, the generic demo board included, has a **complete history** (#1889). Its first movement is its creation, each move starts where the previous one ended, and a lost deal never passes through Won. Everything a card holds is backed by the entry the API writes when a person makes that change:

    - a `+Label` activity for each label
    - an assignee, priority, weight and due-date change for each value set
    - a checklist-item added (and checked) entry for each item
    - a comment-added entry at each comment's time
    - an archive movement for each archived card

    Custom-field values and attachments have no card activity in Visiban yet ([#1909](https://gitlab.com/visiban/visiban/-/issues/1909)), so none is seeded for them.

    An eighth board, **Product Roadmap (Trello import)**, is a Trello export, imported ([#1908](https://gitlab.com/visiban/visiban/-/issues/1908)). The command feeds the Trello export under `backend/boards/tests/fixtures/` through the real [Trello importer](../features/trello-import.md), so the board carries genuine **import provenance**: each comment keeps the Trello author's name as text and starts "(imported from Trello)", and the cards keep their exported creation dates.

    - **Created last,** after every other board, so Sales Territory (Overlay) stays at `/boards/6`.
    - **History:** the importer deliberately writes no movement or activity history, so the seed adds what the API would have written (a creation movement per card, an archive movement for the archived card, and an activity for each value a card holds), credited to the importing admin. The board passes the same history check as the others.
    - **Dates are not moved** to the reset day: the cards keep the export's historical dates, so they read as old.
    - **Shape:** the importer's test fixture (`backend/boards/tests/fixtures/trello_export.json`), so editing that fixture changes the demo.
    - **Members:** the accounts seated on the other showcase boards are seated here too, the visitor as a plain member.

    Not on the hosted demo, by design: an MCP connection. The demo mints no tokens, so [ask your own agent](../features/mcp-demo-walkthrough.md) on a local instance instead.

    **Excluded: an Issue Board Lens board** ([#1908](https://gitlab.com/visiban/visiban/-/issues/1908)). The Lens derives its Backlog / To Do / Doing / Review / Done columns from the branches and merge requests of a live public repository, so it needs `GIT_LENS_ENABLED` and a live public repo on the demo deployment: a deployment-config decision outside the seed. The seed creates none.

    Every link (merge requests, permit portals, CRM records, tracking pages) points at a fictional `*.example.com` address. The links are decorative; they do not imply an integration. All names, companies and accounts are fictional.
- **saved filters** for the published visitor (#1889): Urgent and high, and Overdue, on Software Team; Coverage gaps and Exec escalations on Sales Territory (Overlay); Due this week on Logistics Exceptions. Saved filters are private to their owner, and the demo fence refuses creating one, so these are the visitor's whole list until the next reset
- Software Team uses the **Dense** card layout (#1889), so one board shows every badge, including the aging meter on idle cards; the others keep the Comfortable default
- a seeded **notification inbox** for the published visitor: seventeen unread notifications across the seven boards (@mentions, assignments, card moves, new comments, and stale and due-soon alerts), each from another account or from the system, never from the visitor. The demo fence refuses marking notifications read, so they stay unread until the next reset
- the **published visitor** account (username from `DEMO_LOGIN_USERNAME`, default `visitor`; password from `DEMO_LOGIN_PASSWORD`) — a plain MEMBER on every seeded board, never a site admin, board admin or moderator. While `DEMO_MODE` is on, this account may also edit cards other people created (every seeded card belongs to the admin), and the server permits archiving them too, though the demo UI does not offer Archive (see below). That exception is read from the setting at request time, so it vanishes when `DEMO_MODE` is turned off rather than living on as a stored permission
- a site **admin** account (`admin`, password from `DEMO_ADMIN_PASSWORD`, **never published**) that owns the seeded boards
- two member accounts, `maya` and `jordan` (password from `DEMO_MEMBER_PASSWORD`)

It also turns file uploads off and sets registration to **closed**.

Passwords come only from the environment and are re-applied on every run. For an account that already exists, a re-seed also revokes its personal access tokens and DRF auth token (a fresh account has none, and `--reset-database` recreates the accounts, so nothing is revoked there).

**The command refuses to run when:**

- `DEMO_MODE=true` is not set, or `DEMO_LOGIN_PASSWORD`, `DEMO_ADMIN_PASSWORD` or `DEMO_MEMBER_PASSWORD` is missing
- the admin password equals the published one
- `DEMO_LOGIN_USERNAME` names another seeded account
- it is combined with `--scale`

**Onboarding tour:** it is marked **completed** for the published visitor on every run. Finishing the tour saves a profile flag, which the demo fence refuses, so an auto-running tour would end every visitor's first minute on a refusal. The unpublished accounts have the flag reset on every run, so the tour starts on their first login after each reset.

### Resetting the whole database

```bash
python manage.py seed_demo_data --force --wipe --demo-site --reset-database
```

> **Added in 1.2** (#1180).

`--reset-database` empties **every table** first, using Django's `flush`, and then seeds. This is the hosted demo's reset; the Helm chart's seed hook and hourly reset CronJob run exactly this command. A per-board `--wipe` is not enough for a public demo: it leaves sessions behind (visitors would stay signed in across a reset the login page says signs them out), rows that deleting boards does not reach (`BoardEvent.board_id` is deliberately not a foreign key), and anything a visitor created elsewhere. After the flush the command re-applies the Sites domain from `SITE_DOMAIN`.

The flag is valid only with `--demo-site`, which refuses to run unless `DEMO_MODE=true`. The command therefore cannot empty the database of a normal install.

See [Demo mode](configuration.md#demo-mode) for the settings, and [Public demo mode (Helm)](#public-demo-mode-helm) for the supported deployment.

### Threat model

> **Added in 1.2** (#1179).

A public demo publishes a working login. Everything that account can do, the whole internet can do, and it can do it to every other visitor. Three facts shape the design:

- **Role is not a control.** `POST /api/v1/boards/` and `POST /api/v1/groups/{id}/boards/` make *any* authenticated caller the ADMIN of the board they create. A published credential of any role is therefore one request away from owning something. Seeding a harmless role cannot hold.
- **The guarantee is a deployment mode.** With `DEMO_MODE=true`, `DemoModeMiddleware` refuses every request whose method is not `GET`, `HEAD` or `OPTIONS` — including `TRACE` and unknown verbs — for **every caller**, a site admin and anonymous clients included, unless it is on a short, pinned allowlist. A route added in a later release is refused by construction until someone deliberately adds it. The same rule covers allauth's `/accounts/` tree, `/admin/`, and `/mcp` (every MCP write tool is refused).
- **A published credential turns a per-account lockout into a DoS lever.** The login endpoint locks an account out for 5 minutes after 5 failed passwords, a real defense on a normal install (see [Rate limiting](../architecture/deployment.md#rate-limiting)). On a demo instance the password is public, so *anyone* can send 5 wrong passwords and lock out every other visitor, repeatably. While `DEMO_MODE` is on, `accounts.serializers.LoginSerializer` exempts `DEMO_LOGIN_USERNAME` from the per-account lockout (#1199), whether the visitor types that username or the demo account's email address (#1206). The per-IP throttle still applies, and every other account (including a real user's, if one exists on a demo instance) keeps the full lockout.

A refusal is `403` with a stable body:

```json
{"code": "demo_read_only", "detail": "This is a shared demo — this change can't be saved here. ..."}
```

**What a visitor can do:** sign in and out, watch live updates, and create, edit (including custom-field values), move and restore cards (restoring from the **Archived** panel works), and add, tick and remove checklist items. Each move is recorded in the card's History, which is the point of the demo. Allowed writes still pass normal board permissions. Archive and Delete are not offered in the demo UI: the bulk toolbar, context menu and command palette dim them with the demo notice, and the card panel omits them. The restriction is client-side only; the server still permits archive.

**What a visitor cannot do:**

- create, rename or delete boards, columns, swimlanes, labels or custom fields
- delete cards, comments or attachments; comment; upload attachments
- add or remove card relations; star or unstar a board; mark a notification read
- change their profile, password or preferences; mint personal access tokens
- register, request a password reset (so the demo cannot be used as an email relay), or use invites and groups
- connect a lens; import; or reach anything under the admin API

The SPA disables every one of these controls up front with the reason ("This is a shared demo — …") rather than letting the click round-trip to a 403. `DemoWriteBlockedToast` remains as a shell-level safety net for whatever a future surface adds without its own affordance, not the primary mechanism. Since 1.3 it is a warning notice in the app's shared notification stack (see [Notifications](../features/board.md#notifications)). It still stays 5 seconds; whether it should follow the stack's 8-second warning default is an open decision (#2109).

> **Added in 1.2** (#1193). A completeness-check on #1179 found several refused writes that still fell through to `DemoWriteBlockedToast` with no up-front affordance: deleting a comment or an attachment (card delete was already hidden outright; see `frontend/CLAUDE.md` § Hosted demo surfaces), adding a card relation, starring or unstarring a board, and "Mark all read". Each now gets the same `aria-disabled` treatment, reason and copy template as the surfaces #1179 shipped. Three cases differ, because the write is not a control the visitor reached for:
> - **Clicking an individual notification** still navigates to the related card (its whole purpose) but silently skips the mark-read call rather than becoming aria-disabled, which would also block that navigation — the one explicit, standalone mark-read control ("Mark all read") gets the up-front affordance instead.
> - **The theme-preference sync** (`ThemeServerSync`) silently skips its PATCH; the local theme still applies via `localStorage`, only the cross-device sync is skipped.
> - **The onboarding tour's completion save** doesn't need a skip at all: `seed_demo_data` seeds the published visitor's `has_completed_tour` flag `true`, so the tour — and its completion save — never fires.
>
> Removing a card relation is refused by the fence too, and its control is hidden outright in demo mode, like card delete. When #1193 shipped no demo board had a relation, so that gate was defensive; since #1363 the seed adds relations, so it is what visitors actually see.

**The reset is containment, not a control.** Every hour, on the hour (`DEMO_RESET_SCHEDULE`), the reset job wipes the **whole database** and reseeds it (`--reset-database`). That also ends every session, because sessions are database-backed. Visitors are told on the login page and in the in-app demo bar, get a warning five minutes before, and land back on the login page with a "demo was reset" notice. The reset must stay a whole-database wipe: deleting boards does not clean some tables (for example `BoardEvent`, whose `board_id` is deliberately not a foreign key), so a per-row reset would leak rows across resets.

## Public demo mode (Helm)

> **Added in 1.2** (#1180). This replaces the Docker Compose demo stack (`deploy/demo/`), which was never released.

The Helm chart is the supported way to run a public demo. Enable the `demo:` block, starting from the shipped `helm/visiban/values-demo.yaml`. It is **off by default**, and with it off the chart renders exactly what it did before, so `helm upgrade` on an existing release changes nothing.

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
| `demo.throttle.userRate` | *(empty)* | `DEMO_THROTTLE_USER_RATE` (deprecated alias: `DEMO_USER_THROTTLE_RATE`). It re-aims the `user` throttle scope, which every visitor shares because they all use one account. `values-demo.yaml` sets `60000/hour` as a ceiling that protects the node, not a per-visitor limit. |
| `demo.resourceQuota.*` | off | A ResourceQuota and a LimitRange for the release's namespace, for a demo that shares a node. Only use it in a namespace dedicated to the demo. |
| `backend.settings.numProxies` | *required, ≥ 1* | `NUM_PROXIES`, [the client-IP depth](configuration.md#reverse-proxies-and-the-client-ip). `values-demo.yaml` sets `2` for a Cloudflare Tunnel. |

The chart **refuses to render** a demo that could publish a credential, reach out, or leave its per-visitor rate limits keyed on a shared address. It fails when:

- `loginHint` is set while the demo is off, or a `loginHint` half is missing or outside its character set
- SSO/OAuth or real SMTP is configured
- the media PVC is enabled
- `backend.settings.debug` is anything django-environ's parser treats as true: not just the literal `true`, but also `on`/`ok`/`y`/`yes` and any nonzero integer string like `1` or `-1`
- `networkPolicy.enabled` is off
- the bundled PostgreSQL or Valkey is replaced by an external one
- `backend.settings.numProxies` is unset or below `1`
- `backend.settings.allowUnsafeHosts` is `true` (a public demo never needs a catch-all or loopback `ALLOWED_HOSTS` entry, #1360)
- the schedule is one the backend cannot evaluate
- `demo.throttle.userRate` is malformed

### What the chart guarantees, and what it does not

- **The fence is the control.** `DEMO_MODE` arms `DemoModeMiddleware` (see [Threat model](#threat-model)). The chart's job is to guarantee that the variable reaches every container that imports Django settings: the backend and its init containers, the seed and reset pods, and scheduled jobs.
- **`helm test` proves it after every deploy.** Through the frontend Service (the path a visitor's request takes), it signs in with the published credential (expects `200`), creates a board (expects `403` with `demo_read_only` in the body; a `403` from a permission check does not count), moves a seeded card (expects `200`), and checks that `site-config` publishes `demo_next_reset_at` if and only if the reset runs. It does not check the tunnel or anything in front of the frontend.
- **The reset is containment, not a control.** The seed hook (post-install and post-upgrade) and the reset CronJob run the same pod: `migrate_with_lock`, then `seed_demo_data --force --wipe --demo-site --reset-database`. Every run signs every visitor out and re-applies the published password, so the login hint never points at a dead account. The CronJob uses `concurrencyPolicy: Forbid`. A failed run keeps its Job for `kubectl logs` and leaves the previous data up; it is never a readiness signal, so a failed reset cannot take the demo down. The seed runs in its own pod and demo mode has no shared media volume, so the one small attachment the base demo board seeds has no file on the serving pod and downloading it answers `404`.
- **Egress is denied at the pod.** A NetworkPolicy limits the backend, the seed and reset pods and the scheduled-job pods to DNS and the release's own PostgreSQL and Valkey. That closes every outbound path a visitor could reach through the app (the lens, mail, any future call site) at the network layer. It is real only if the cluster's CNI enforces NetworkPolicy. CI proves it on Calico; on your cluster, check it yourself (see the maintainer runbook's [enforcement check](../maintainers/demo-deploy.md#2-networkpolicy-is-enforced-on-the-node)).

### Preconditions outside the chart

These cannot be expressed in values, and no CI job can verify them:

- **Expose only the frontend Service**, for example through a Cloudflare Tunnel public hostname. The chart renders no Ingress in `values-demo.yaml`.
- **Count your proxies.** Behind a tunnel, set `backend.settings.numProxies` to the real number of hops that append to `X-Forwarded-For`, including this chart's own frontend nginx, which always adds one. The chart refuses to render below `1` (which would key every visitor's rate limits on one shared address) but cannot know your actual depth: get the count right, not just non-zero.
- **Per-visitor rate limiting after sign-in** has to come from in front of the host, such as a Cloudflare IP rate-limit rule. Every visitor shares one account, so the `user` throttle cannot tell them apart.
- **The host must not run CI jobs** (TruePPM ADR-1197 D10).
- **Kubernetes 1.27 or later**, for the CronJob `timeZone` field.

The runbook for try.visiban.com itself, including the deployment record, is [Hosted Demo](../maintainers/demo-deploy.md).

## Ask your own agent about the demo data

The hosted demo deliberately exposes no MCP and mints no tokens: publishing a credential on a public site is a security decision we chose not to make ([#1907](https://gitlab.com/visiban/visiban/-/issues/1907)). To point your own agent at the generic demo board (the hosted showcase boards need `--demo-site`, whose `DEMO_MODE` fence blocks creating tokens), follow [Ask Your Own Agent About the Demo Data](../features/mcp-demo-walkthrough.md), a local walkthrough with a read-only `mcp:read` token.

## Demo data and real data

Demo records carry no special marker. A demo card looks identical to a real card at the database level — same fields, same UID format, same `archived_at` behavior. This means:

- Archived demo cards show up alongside real archived cards in any query that reads `archived_at`
- Movement history generated by the seed command is stored in `CardMovement` alongside real movement records
- Deleting a demo board also deletes all its cards, movements, and comments via cascading FK deletes (deleting a single card keeps its movements; only deleting the board removes them) — swimlane and label objects tied to the board are removed too, but the demo user accounts (`demo1`–`demo5`) persist
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

The `seed-demo-data` GitLab CI job refreshes the demo board on demand. It is manual-only, runs from `main` pipelines, and has no weekly schedule. The public demo at try.visiban.com runs from the Helm chart's demo mode instead (see [Demo deployment](../maintainers/demo-deploy.md)), so you need this job only for a separate Compose-based demo environment. It needs three GitLab CI/CD variables.

### Required GitLab CI/CD variables

In your GitLab project, go to **Settings → CI/CD → Variables** and add the following. All three must be **Protected** and **Masked**, scoped to the `demo` environment.

| Variable | Description |
|---|---|
| `DEMO_SECRET_KEY` | Django secret key for the demo environment. Generate with: `python -c "import secrets; print(secrets.token_hex(50))"` |
| `DEMO_DATABASE_URL` | PostgreSQL connection string for the demo environment's database, e.g. `postgres://user:pass@host:5432/dbname` |
| `DEMO_REDIS_URL` | Valkey (or Redis-compatible) connection string for the demo environment, e.g. `redis://host:6379/0` |

!!! warning
    If any of these variables is missing or empty, the job fails immediately with `ImproperlyConfigured: DJANGO_SECRET_KEY must be set`. If you see this after clicking **Run** on the manual job in a `main` pipeline, check that all three are set and scoped to the `demo` environment in **Settings → CI/CD → Variables**.

### Optional: custom random seed

The job seeds randomness with today's date (`YYYYMMDD`), so each refresh varies but is reproducible within a day. To override it, set `SEED_VALUE` to any integer when triggering the job from the GitLab pipeline UI:

| Variable | Example value | Effect |
|---|---|---|
| `SEED_VALUE` | `42` | Uses seed 42 — same board layout every time |
| *(unset)* | — | Uses today's date — varies per run |

## Import files and test data

The board import endpoint (`POST /api/v1/boards/import/`) accepts the JSON and CSV format the board export produces. If you upload a hand-crafted file to simulate an import (for automation testing, template validation, etc.):

- **All objects receive fresh UIDs** — the import code ignores any `uid` field present in the source file and generates new UIDs for every board, column, swimlane, label, and card created
- **Imported records are not tagged as test data** — they are real database rows with no provenance marker
- **Column, swimlane, and label names drive the import** — duplicate names within the same file are merged into a single object; the card's `column` and `swimlane` fields must match a name defined in the file's `columns`/`swimlanes` arrays

**Watch out:** if you use the import endpoint to load test data, clean it up explicitly after the test. There is no bulk-delete-by-source-file operation; you need to delete the board that was created.

### Identifying test boards in development

If you create many imported boards for testing, use a recognizable name prefix (e.g. `TEST: My Board`) so you can find and delete them in bulk. Send the prefixed name in the import request's `name` field, which is used exactly as given. A prefix written only into the file's `name` lands behind the importer's default `Imported: ` prefix (`Imported: TEST: My Board`), and the filter below would miss it:

```python
Board.objects.filter(name__startswith="TEST:").delete()
```

**Yes, but:** this is a convention, not an enforced constraint. It relies on the person creating the test data using the prefix consistently.
