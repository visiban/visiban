"""
Generate and load realistic demo data for Visiban.

Creates a "Visiban Demo Board" with 5 columns, 10 swimlanes, ~120 cards,
checklists, comments, movement history, and activity records suitable for
product demos, sales calls, and integration testing.

Uses random.seed(42) by default so output is deterministic and git-diffable.
Pass --seed N to override (e.g. for generating alternate datasets in CI).


Usage:
    python manage.py seed_demo_data
        Create the demo board (skip silently if it already exists).
        Requires DEBUG=True or --force to prevent accidental runs on production.

    python manage.py seed_demo_data --wipe
        Delete the existing demo board and recreate from scratch.
        Requires DEBUG=True or --force to prevent accidental use on production data.

    python manage.py seed_demo_data --wipe --force
        Override the DEBUG=True guard. Intended for CI/CD pipelines where
        DEBUG=False but you still need a clean board refresh.

    python manage.py seed_demo_data --force
        Run on a production-like environment where DEBUG=False.
        Only safe on dedicated demo environments — never on a live database.

    python manage.py seed_demo_data --export
        After seeding, write canonical JSON and CSV snapshots to
        sample-boards/demo_board.json and sample-boards/demo_board.csv.
        Commit the result when the board structure changes so the CI
        seed-export-check job does not fail.

    python manage.py seed_demo_data --seed N
        Override the random seed (integer). The default seed (42) produces a
        fixed, deterministic dataset that is safe to commit and diff.

        To generate data that varies by day (e.g. in a CI refresh job),
        pass today's date as an integer:
            --seed $(date +%Y%m%d)
        This yields a different board layout each calendar day while still
        being reproducible for the same day across runs.

        Note: changing the seed changes card titles, descriptions, and
        ordering — the committed scripts/seed/ files were generated with the
        default seed (42) and will diverge if you run --export with a
        different seed. Only use a non-default seed for the live demo
        environment refresh, not for --export commits.

    python manage.py seed_demo_data --force --scale 20 --with-notifications
        Seed a SEPARATE, larger "Visiban Load Test Board" (#1082) instead of
        the normal demo board: --scale replicates the 10 swimlanes that many
        times (20 -> 200 swimlanes, ~2,400 cards), and --with-notifications
        also seeds unread Notification rows for 'demo2' so the notification-
        poll endpoints have realistic data. Used by the nightly-load-test CI
        job (see docs/development/nightly-load-test.md) — never combine
        --scale > 1 with --export.

    python manage.py seed_demo_data --force --wipe --demo-site
        Hosted demo instance (#1034, try.visiban.com). In addition to the
        normal demo board, seeds six showcase boards, each with a different
        swimlane entity (#1389): Software Team, Property Management,
        Construction, Sales Territory, Content Moderation and Logistics
        Exceptions (16-20 cards each, with comments, assignees, labels,
        movement history, checklists, card and swimlane custom fields, card
        relations and, on Software Team, MR/PR links; #1363 also gives them a
        fresh/aging/stale and due-date mix and seeds the visitor's
        notification inbox) plus a site admin, the published visitor account
        and two member accounts. Passwords come from the DEMO_LOGIN_PASSWORD
        (visitor, published), DEMO_ADMIN_PASSWORD (admin, never published) and
        DEMO_MEMBER_PASSWORD environment variables (never from source); the
        command refuses to run without all three. #1179: the visitor is a
        MEMBER on every board, never a site or board admin, and the instance
        is seeded with uploads off and registration closed. See
        docs/administration/demo-data.md.

    python manage.py seed_demo_data --force --wipe --demo-site --reset-database
        The hosted demo's reset (#1180: the Helm chart's demo seed hook and
        hourly reset CronJob run exactly this). Empties EVERY table first
        (Django's ``flush``), which also deletes every session, so each
        visitor is signed out, and removes rows a per-board ``--wipe`` cannot
        reach (``BoardEvent.board_id`` is deliberately not a foreign key).
        Only valid with --demo-site, which itself refuses to run unless
        DEMO_MODE is on.
"""

import csv
import datetime
import json
import os
import random
from django.conf import settings
from django.contrib.sites.models import Site
from django.core.management import call_command
from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError as DRFValidationError

from accounts.models import SiteSetting, User
from boards.notifications_email import suppress_notification_email
from boards.serializers import _normalize_custom_field_value
from boards.services.notifications import quoted_card_verb
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardActivity,
    CardAttachment,
    CardChecklist,
    CardComment,
    CardExternalRef,
    CardMovement,
    CardRelation,
    Column,
    CustomFieldDefinition,
    CustomFieldValue,
    Label,
    Notification,
    SavedFilter,
    Swimlane,
    SwimlaneCustomFieldDefinition,
    SwimlaneCustomFieldValue,
)
from groups.models import Group, GroupInviteLink, GroupLabel

from ._demo_site_data import (
    BOARDS as DEMO_SITE_BOARDS,
    DEMO_SITE_USERS,
    RETIRED_BOARD_NAMES as RETIRED_DEMO_SITE_BOARD_NAMES,
    VISITOR_NOTIFICATIONS as DEMO_SITE_VISITOR_NOTIFICATIONS,
)

BOARD_NAME = "Visiban Demo Board"
# Distinct name for the --scale > 1 fixture (#1082) so a large-fixture run can
# never collide with, or be mistaken for, the real demo board — most visibly
# on the shared "demo" environment, where the weekly seed-demo-data refresh
# job must keep operating on BOARD_NAME regardless of what other scale this
# command has ever been invoked with elsewhere.
LOAD_TEST_BOARD_NAME = "Visiban Load Test Board"
DEMO_GROUP_NAME = "Visiban Demo Workspace"
RANDOM_SEED = 42
# Fixed reference date for due-date calculations — keeps the exported JSON/CSV
# files git-stable regardless of when the command is run.
SEED_ANCHOR_DATE = datetime.date(2026, 4, 1)

# ── Demo users ────────────────────────────────────────────────────────────────

DEMO_USERS = [
    {"username": "demo1", "email": "demo1@visiban.example", "first_name": "Alex",   "last_name": "Rivera"},
    {"username": "demo2", "email": "demo2@visiban.example", "first_name": "Sam",    "last_name": "Chen"},
    {"username": "demo3", "email": "demo3@visiban.example", "first_name": "Jordan", "last_name": "Patel"},
    {"username": "demo4", "email": "demo4@visiban.example", "first_name": "Morgan", "last_name": "Wu"},
    {"username": "demo5", "email": "demo5@visiban.example", "first_name": "Casey",  "last_name": "Osei"},
]

# ── Board structure ───────────────────────────────────────────────────────────

COLUMNS = [
    {"name": "Backlog",  "color": "#6B7280", "allow_card_creation": True},
    {"name": "To Do",    "color": "#3B82F6", "allow_card_creation": False},
    {"name": "Doing",    "color": "#F59E0B", "allow_card_creation": False},
    {"name": "Review",   "color": "#8B5CF6", "allow_card_creation": False},
    {"name": "Done",     "color": "#10B981", "allow_card_creation": False, "is_done": True},
]

SWIMLANES = [
    {"name": "Acme Corp",        "color": "#EF4444", "contact_email": "dev@acme.example",       "notes": "Enterprise client — SLA 4h response"},
    {"name": "Beta Team",        "color": "#F97316", "contact_email": "beta@visiban.example",    "notes": "Internal feature team"},
    {"name": "Cloudstride Ltd",  "color": "#EAB308", "contact_email": "tech@cloudstride.example","notes": "Migrating from Jira"},
    {"name": "DevOps Guild",     "color": "#22C55E", "contact_email": "infra@visiban.example",   "notes": "Platform and infrastructure work"},
    {"name": "Ember Studio",     "color": "#14B8A6", "contact_email": "pm@ember.example",        "notes": "Design-heavy track"},
    {"name": "Frontier AI",      "color": "#3B82F6", "contact_email": "ml@frontier.example",     "notes": "ML pipeline integrations"},
    {"name": "Growth Squad",     "color": "#6366F1", "contact_email": "growth@visiban.example",  "notes": "Marketing and analytics"},
    {"name": "Hardrock Systems", "color": "#8B5CF6", "contact_email": "ops@hardrock.example",    "notes": "Hardware integrations"},
    {"name": "Indigo Labs",      "color": "#EC4899", "contact_email": "api@indigo.example",      "notes": "API-first customer"},
    {"name": "Just Ship It",     "color": "#F43F5E", "contact_email": "lead@justship.example",   "notes": "Startup — moves fast"},
]

LABELS = [
    {"name": "Bug",         "color": "#EF4444"},
    {"name": "Feature",     "color": "#3B82F6"},
    {"name": "Improvement", "color": "#10B981"},
]

# ── Card data corpus ──────────────────────────────────────────────────────────

CARD_TITLES = [
    # Bug fixes
    "Fix login redirect loop on mobile",
    "Fix WebSocket reconnect on token refresh",
    "Fix drag-and-drop on touch screens",
    "Fix stale WebSocket after board rename",
    "Fix broken avatar URL for OAuth users",
    "Fix CSV import skipping blank description",
    "Fix swimlane collapse state not persisting",
    "Fix notification bell count mismatch",
    "Fix date picker timezone offset",
    "Fix due-date badge color for overdue cards",
    "Fix column separator drag on Firefox",
    "Fix empty state not showing on fresh board",
    "Fix checklist item delete losing position",
    "Fix XSS via card title in notifications",
    "Fix pagination cursors on Safari",
    "Fix Dockerfile layer caching regression",
    "Fix Google OAuth callback 500 on new user",
    "Fix column WIP limit badge wrapping",
    "Fix card z-index overlap during drag",
    "Fix board settings not saving on blur",
    "Fix comment timestamp showing UTC instead of local",
    "Fix label color picker not closing on click-outside",
    "Fix card weight not updating in swimlane rollup",
    "Fix keyboard navigation skipping collapsed swimlanes",
    "Fix OAuth state param not validated on callback",
    "Fix mobile layout overflow on narrow screens",
    "Fix dark mode contrast on disabled buttons",
    "Fix SSE reconnect flooding server after wake",
    "Fix archived cards still appearing in search results",
    "Fix board member removal not revoking WebSocket access",
    # Features
    "Add CSV export for board activity",
    "Implement due-date reminder notifications",
    "Refactor swimlane reorder endpoint",
    "Add keyboard shortcut to create card",
    "Support dark mode in email notifications",
    "Write API docs for /boards/{id}/full/",
    "Add bulk archive action to card list",
    "Add attachment preview for PDFs",
    "Add pagination to movement history endpoint",
    "Implement board-level search",
    "Add invite-only registration toggle",
    "Support @mentions in card descriptions",
    "Add priority filter to FilterBar",
    "Add Prometheus metrics endpoint",
    "Implement card weight rollup per swimlane",
    "Add group-level board visibility setting",
    "Support emoji in card titles",
    "Add time-in-stage heatmap to analytics",
    "Add card duplication action",
    "Add read-only viewer role enforcement",
    "Add column-level WIP enforcement",
    "Add label filter to board view",
    "Add OAuth2 PKCE flow for mobile clients",
    "Implement rate limiting on auth endpoints",
    "Add board activity feed",
    "Add card quick-add shortcut to swimlane",
    "Add bulk label assignment",
    "Implement card template system",
    "Add swimlane color picker to edit modal",
    "Add read receipt to comments",
    "Add offline mode banner",
    "Add card age indicator",
    "Implement board copy feature",
    "Add card position audit log",
    "Add export to Markdown option",
    "Add column archival (soft delete)",
    "Add SAML SSO support (enterprise)",
    "Add multi-board dashboard view",
    "Add card dependency linking",
    "Add swimlane WIP limits",
    "Add board-level custom fields",
    "Add recurring card automation",
    "Add email-to-card creation via unique board address",
    "Add card timer for time tracking",
    "Add board export to PDF",
    "Add card voting and prioritization",
    "Add global search across all boards",
    "Add user activity heatmap to profile",
    "Add custom notification rules per board",
    "Add card subtasks with progress bar",
    "Add personal card favorites list",
    "Add column auto-archive after N days",
    "Add drag-to-select multiple cards",
    "Add board access audit log for admins",
    # Infrastructure / DevOps
    "Investigate slow card load on large boards",
    "Increase test coverage for CardMovement",
    "Optimize full-board query with select_related",
    "Migrate CI from Docker-in-Docker to kaniko",
    "Investigate memory leak in frontend bundle",
    "Write runbook for on-call rotation",
    "Benchmark board load with 1000+ cards",
    "Write integration test for card move API",
    "Create Helm chart for staging deployment",
    "Document card weight feature",
    "Set up MinIO for local dev attachments",
    "Integrate Sentry for frontend error tracking",
    "Write migration guide from v0.9 to v1.0",
    "Investigate flaky test in test_concurrent_moves",
    "Write performance test for /boards/{id}/full/",
    "Review and update CONTRIBUTING.md",
    "Set up weekly demo data refresh job",
    "Clean up unused CSS utility classes",
    "Update Python dependencies to latest patch",
    "Improve accessibility of drag handles",
    "Audit all endpoints for IDOR vulnerabilities",
    "Remove deprecated /api/v1/ aliases",
    "Set up staging environment seed job",
    "Improve error messages on 403 responses",
    "Improve onboarding empty state copy",
    "Add database connection pooling via pgBouncer",
    "Reduce frontend bundle size below 200 KB gzipped",
    "Set up canary deploys in Kubernetes",
    "Write load test for WebSocket connections at scale",
    "Upgrade PostgreSQL from 15 to 16",
    "Add structured JSON logging for backend",
    "Configure automated database backups to S3",
    "Set up preview environments for MRs",
    "Profile and optimize N+1 queries in analytics endpoint",
    "Add health check endpoint for load balancer",
    "Document disaster recovery runbook",
    "Set up Renovate for automated dependency PRs",
    "Add Redis cache layer for board state",
    "Migrate from REST polling to Server-Sent Events",
    "Write end-to-end Playwright test suite",
    "Add Terraform module for production infrastructure",
    "Set up OpenTelemetry tracing for API requests",
    "Configure rate limiting on public API endpoints",
    "Implement graceful shutdown for background workers",
    "Add Dependabot alerts to Slack channel",
]

CARD_DESCRIPTIONS = [
    """\
## Problem

The login flow redirects to `/dashboard` even when the user came from a protected \
route like `/boards/42`.

## Steps to reproduce

1. Open a board URL while logged out
2. Log in via OAuth
3. Observe redirect goes to dashboard, not the original URL

## Expected

Redirect to the originally requested URL after auth.

## Fix

Store the pre-auth route in `sessionStorage` and restore on callback.""",

    """\
## Goal

Allow board admins to download a CSV of all card movements for external reporting.

## Acceptance criteria

- Columns: card ID, title, from column, to column, from swimlane, to swimlane, moved by, moved at
- Scoped to the requesting user's visible boards
- File name: `{board_slug}-activity-{date}.csv`

## Notes

Reuse the existing `/api/boards/{id}/export/` infrastructure.""",

    """\
## Observed

Loading `/api/boards/{id}/full/` takes 2–3 s on a board with 800+ cards and 15 members.

## Root cause (hypothesis)

The `get_members()` method in `BoardFullSerializer` runs a separate query per member \
to resolve group-inherited roles. This is O(n) on member count.

## Investigation needed

- Profile with `django-silk` on staging
- Check if `select_related` / `prefetch_related` is missing anywhere in `BoardFullViewSet`""",

    """\
## Background

Users frequently miss due dates because there is no proactive notification. Currently \
they only see the overdue badge after loading the board.

## Proposed solution

- Daily cron job (similar to `notify_stale_cards`) that finds cards due in ≤ 24 h
- Creates a `Notification` for the assignee and board admins
- Idempotent: skips cards already notified today

## Out of scope

Email/push notifications (follow-up issue).""",

    """\
## What

The `POST /api/boards/{board_id}/swimlanes/reorder/` endpoint re-fetches all swimlanes \
inside the view rather than relying on the serializer's validated data. This causes an \
extra query per reorder and complicates the test setup.

## Refactor goal

Move reorder logic into a dedicated `SwimlaneReorderSerializer` that validates positions \
and bulk-updates in a single query using `Case/When`.""",

    """\
Keyboard shortcut `N` (when focus is outside an input) should open a quick-add modal \
pre-scoped to the last focused column/swimlane cell. This mirrors Jira's quick-add \
behavior and was frequently requested in the user survey.

Implementation notes:

- Listen for `keydown` in `BoardView`
- Track last focused cell in a ref
- Open `CreateCardModal` with column + swimlane pre-filled""",

    """\
The WebSocket connection silently dies when the Django backend rotates the JWT access \
token (every 15 min). `useBoardSocket` detects the close but doesn't attempt re-auth \
before reconnecting, so the first reconnect fails with 401 and the hook backs off for 30 s.

Fix: on 4401/1008 close code, call `refreshAccessToken()` first, then reconnect.""",

    """\
Dark-mode email templates should match the app's dark theme (`bg-gray-900` palette). \
Currently all transactional emails use a white background which looks jarring when the \
OS is in dark mode.

Scope: notification emails only. OAuth welcome emails are out of scope for now.""",

    """\
The `/api/boards/{id}/full/` endpoint is the most-called endpoint in production but is \
only described in a one-liner in the README. Add a full OpenAPI-style doc block covering:

- Response schema (columns, swimlanes, cards, labels, members)
- Performance characteristics (typical payload size, query count)
- When to use this vs incremental WebSocket updates""",

    """\
Add a "Archive selected" action to the bulk action toolbar. Archived cards should be \
hidden from the main board view but remain accessible via a filter toggle ("Show archived").

Model change: add `is_archived` BooleanField to `Card` (default False, db_index=True).

Migration: nullable, safe to deploy without downtime.""",

    """\
Touch-based drag-and-drop is broken on iOS Safari 17. The `@dnd-kit/core` pointer sensor \
requires a 250 ms press delay on touch which conflicts with iOS's native scroll.

Fix: configure `TouchSensor` with `activationConstraint: { delay: 250, tolerance: 5 }` \
and ensure the scroll lock is applied only to the dragged card's container, not the full \
viewport.""",

    """\
Current coverage for `CardMovement` creation and the `from_*_name` denormalization is \
only at integration level (through the move endpoint). Add dedicated unit tests that:

- Verify `from_column_name` and `to_column_name` are written at move time
- Verify they are preserved if the column is later deleted
- Verify movement ordering (`-moved_at`)""",
]

COMMENT_BODIES = [
    "Taking a look at this now — I can reproduce it on iOS 16 as well.",
    "Pushed a first draft to the branch. The main challenge is the scroll lock interaction.",
    "Reviewed. Two nits: the `delay` should be `300` not `250` per the dnd-kit docs, and the tolerance should be `8` for fat-finger friendliness. Otherwise LGTM.",
    "Confirmed fixed on my iPhone 14 after pulling the latest.",
    "This has been sitting in Backlog for 3 weeks — can we prioritise it? It's blocking the Acme Corp demo.",
    "Blocked on the auth token rotation ticket (#184). Can't fix the reconnect without a stable refresh API.",
    "I'll pick this up after the rc.5 release. Assigning to myself.",
    "The `django-silk` profile is attached. The N+1 is in `get_members()` as suspected — 14 extra queries for a 14-member board.",
    "Added `prefetch_related('memberships__user__groups')` — query count dropped from 28 to 4 on the large test board.",
    "Can we scope this to the current quarter? It's a nice-to-have but not blocking anything.",
    "Agreed. Moving to Backlog for now.",
    "The CSV format question: should we include card description or just metadata? Description can be very long.",
    "Metadata only for the first version. We can add description as an opt-in column later.",
    "Opened a follow-up: #221 — CSV export: add optional description column.",
    "The Helm chart change needs a review from DevOps before we ship this.",
    "@demo3 can you take a pass at the Helm config?",
    "Done. Left two comments on the chart — nothing blocking, just housekeeping.",
    "Merged the Helm review comments. Ready for QA.",
    "QA sign-off. Deploying to staging.",
    "Deployed. Monitoring Sentry for regressions.",
    "This is a P0 for the Frontier AI integration. Their pipeline ingests board data daily.",
    "Filed a hotfix MR. ETA 2h.",
    "Hotfix deployed. Frontier AI confirmed their pipeline is healthy again.",
    "I reproduced this on Firefox 124. The column separator drag stops working after the first drop.",
    "Root cause: Firefox handles `pointermove` differently when a CSS transition is active. Workaround: disable the resize transition during drag.",
    "Scope question: should this also cover the row separator?",
    "Yes, same root cause. Fixing both in the same MR.",
]

CHECKLIST_SETS = [
    ["Read existing code and write notes", "Identify all affected tests", "Implement fix", "Update docs", "Request review"],
    ["Reproduce issue locally", "Add failing test", "Fix root cause", "Verify test passes", "Add regression test"],
    ["Draft API design doc", "Get team sign-off", "Implement endpoint", "Write tests", "Update OpenAPI spec"],
    ["Profile query performance", "Add select_related / prefetch", "Measure improvement", "Add comment explaining why"],
    ["Design mockup approved", "Implement component", "Add unit test", "Verify on mobile", "Accessibility check"],
    ["Write migration", "Test rollback", "Deploy to staging", "Monitor error rate", "Deploy to prod"],
    ["Update CHANGELOG", "Bump version", "Tag release", "Push Docker images", "Post release notes"],
    ["Identify affected endpoints", "Add permission check", "Write test", "Security review"],
    ["Scope defined", "Dependencies checked", "Implementation started", "Code review done"],
    ["Create feature branch", "Implement", "Write tests", "Open MR"],
]


class Command(BaseCommand):
    help = "Seed the Visiban Demo Board with realistic demo/test data."

    def add_arguments(self, parser):
        parser.add_argument(
            "--wipe",
            action="store_true",
            help=(
                "Delete the existing demo board and recreate from scratch. "
                "Requires DEBUG=True unless --force is also passed."
            ),
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help=(
                "Override the DEBUG=True guard (CI / dedicated demo environments only). "
                "Applies to both plain runs and --wipe."
            ),
        )
        parser.add_argument(
            "--export",
            action="store_true",
            help="Write JSON and CSV snapshots to scripts/seed/ after seeding.",
        )
        parser.add_argument(
            "--seed",
            type=int,
            default=RANDOM_SEED,
            help=f"Random seed for data generation (default: {RANDOM_SEED}).",
        )
        parser.add_argument(
            "--scale",
            type=int,
            default=1,
            help=(
                "Swimlane-replication factor for a large-fixture board (#1082). "
                "1 (default) seeds the normal 'Visiban Demo Board' unchanged — "
                "identical output to every prior release, byte-for-byte with "
                "--export. Any value > 1 seeds a SEPARATE board named "
                f"'{LOAD_TEST_BOARD_NAME}' instead, replicating the 10 swimlanes "
                "--scale times (so --scale 20 yields 200 swimlanes, ~2,400 cards) "
                "for the nightly load-test job. Never combine --scale > 1 with "
                "--export — the large fixture is not meant to be committed."
            ),
        )
        parser.add_argument(
            "--demo-site",
            action="store_true",
            help=(
                "Also seed the hosted-demo content (#1034, #1389): six showcase "
                "boards (Software Team, Property Management, Construction, Sales "
                "Territory, Content Moderation, Logistics Exceptions) plus a site "
                "admin, the published visitor account and two member accounts. Passwords are read from "
                "DEMO_LOGIN_PASSWORD / DEMO_ADMIN_PASSWORD / "
                "DEMO_MEMBER_PASSWORD. Off by default — the default output "
                "(and the committed --export snapshot) is unchanged."
            ),
        )
        parser.add_argument(
            "--reset-database",
            action="store_true",
            help=(
                "Hosted demo reset (#1180): empty EVERY table (Django's flush — "
                "sessions included, so every visitor is signed out) before "
                "seeding. Only valid with --demo-site, which requires "
                "DEMO_MODE=true. Never use on an instance holding real data."
            ),
        )
        parser.add_argument(
            "--with-notifications",
            action="store_true",
            help=(
                "Also seed unread Notification rows for 'demo2' so the "
                "notification-poll endpoints (list/unread-count) have realistic "
                "data. Off by default: the weekly demo-board refresh job's "
                "existing behavior is left untouched unless this is passed "
                "explicitly (used by the nightly load-test job, #1082)."
            ),
        )

    def handle(self, *args, **options):
        # Seeding creates hundreds of card movements and notifications through the
        # same funnel real events use (#356), and card movements fire their
        # notification receiver outside any atomic block — so on a machine with
        # working SMTP configured, seeding would send hundreds of real emails to
        # whatever addresses the demo data contains. Nobody asked to be told
        # about fixtures.
        demo_site = options.get("demo_site")
        if demo_site:
            # Validate before touching the database: a demo site with a blank
            # admin password would be an open admin account, and --export /
            # --scale are for committed / CI fixtures, not the public demo.
            # Require DEMO_MODE so the command can never take over (reset the
            # password of, and promote) a pre-existing "admin" account on an
            # ordinary install that merely has DEMO_LOGIN_PASSWORD set.
            if not settings.DEMO_MODE:
                raise CommandError("--demo-site requires DEMO_MODE=true.")
            if not settings.DEMO_LOGIN_PASSWORD:
                raise CommandError(
                    "--demo-site requires the DEMO_LOGIN_PASSWORD environment variable."
                )
            # The demo promises two usable member accounts; an unusable
            # password would silently ship two accounts nobody can sign in to.
            if not settings.DEMO_MEMBER_PASSWORD:
                raise CommandError(
                    "--demo-site requires the DEMO_MEMBER_PASSWORD environment variable."
                )
            # #1179: the site admin has its own, unpublished password. Refuse a
            # missing one (an open admin account) and one equal to the
            # published password (which would publish the admin credential).
            if not settings.DEMO_ADMIN_PASSWORD:
                raise CommandError(
                    "--demo-site requires the DEMO_ADMIN_PASSWORD environment variable."
                )
            if settings.DEMO_ADMIN_PASSWORD == settings.DEMO_LOGIN_PASSWORD:
                raise CommandError(
                    "DEMO_ADMIN_PASSWORD must differ from DEMO_LOGIN_PASSWORD: "
                    "the login password is published on the login page."
                )
            # The published username must not be one of the other seeded
            # accounts, or the seeder would publish (and re-password) the site
            # admin or a member under the visitor's name.
            reserved = {
                username.lower()
                for key, (username, *_rest) in DEMO_SITE_USERS.items()
                if key != "visitor"
            }
            if settings.DEMO_LOGIN_USERNAME.lower() in reserved:
                raise CommandError(
                    f"DEMO_LOGIN_USERNAME={settings.DEMO_LOGIN_USERNAME!r} collides with a "
                    "seeded non-visitor account; use a dedicated name such as 'visitor'."
                )
            if options["export"] or options["scale"] != 1:
                raise CommandError("--demo-site cannot be combined with --export or --scale.")
        if options.get("reset_database"):
            # Scoped to the demo so a copy-pasted command can never empty a real
            # install: --demo-site (validated above) already demands DEMO_MODE.
            if not demo_site:
                raise CommandError("--reset-database is only valid with --demo-site.")
            # --force is required unconditionally (not just when DEBUG is False):
            # DEBUG-gating this was a latent foot-gun (security-review, #1180) — a
            # destructive flush should never be one flag away from running just
            # because DEBUG happens to be on, on any deployment shape.
            if not options["force"]:
                raise CommandError(
                    "Refusing to reset the database: --reset-database requires --force "
                    "(only safe on a dedicated demo instance)."
                )
            # completeness-check (#1180): the flush and the reseed must be one
            # transaction, or a failure between them (an OOM kill, the Job's
            # activeDeadlineSeconds, any exception in _seed/_seed_demo_site)
            # leaves the database flushed but not reseeded — the published
            # login dead and most boards missing, exactly the "reset takes the
            # demo down" outcome the docs promise cannot happen. Wrapping in
            # atomic() means a mid-run failure rolls back to the PRE-reset
            # state (the old data, the old still-working login) rather than a
            # half-flushed one. PostgreSQL TRUNCATE (what `flush` issues) is
            # fully transactional and nests under an outer atomic() as a
            # savepoint, so this does not change flush's own behavior.
            # suppress_notification_email() must be the OUTER context manager
            # (re-check of the first fix, #1180): atomic()'s on_commit callbacks
            # fire at the moment the transaction commits, which is when the
            # atomic() block exits. If suppress_notification_email() were
            # nested inside atomic() instead, it would reset _suppressed to
            # False on its own __exit__ before atomic() commits and fires
            # those callbacks, so any notification queued via on_commit during
            # the seed would send for real. Wrapping it outside keeps
            # suppression active through the commit.
            with suppress_notification_email():
                with transaction.atomic():
                    self._reset_database()
                    self._seed(*args, **options)
                    if demo_site:
                        self._seed_demo_site(options)
        else:
            with suppress_notification_email():
                self._seed(*args, **options)
                if demo_site:
                    self._seed_demo_site(options)

    def _seed(self, *args, **options):
        random.seed(options["seed"])
        # Movement timestamps use today's date in normal runs so analytics
        # windows (7d, 30d, 90d) always show recent data. The --export path
        # keeps SEED_ANCHOR_DATE so the committed JSON/CSV snapshots are
        # git-stable and the CI seed-export-check job does not fail.
        self._movement_anchor = SEED_ANCHOR_DATE if options["export"] else datetime.date.today()

        # Production guard: refuse to run on any non-DEBUG environment unless
        # --force is explicitly passed. This applies to both plain runs (which
        # create demo users and a demo board) and --wipe runs (which delete
        # existing data). Running against a live database would corrupt it.
        if not settings.DEBUG and not options["force"]:
            raise CommandError(
                "Refusing to seed: DEBUG is False. "
                "Pass --force to override (only safe on dedicated demo environments)."
            )

        scale = options["scale"]
        if scale < 1:
            raise CommandError("--scale must be >= 1.")
        if scale > 1 and options["export"]:
            raise CommandError(
                "--export is only valid with --scale 1 — the large-fixture board "
                "is generated for the nightly load-test job, not for committed "
                "sample-boards/ snapshots."
            )
        board_name = BOARD_NAME if scale == 1 else LOAD_TEST_BOARD_NAME

        if options["wipe"]:
            deleted, _ = Board.objects.filter(name=board_name).delete()
            if board_name == BOARD_NAME:
                # Board.group uses on_delete=SET_NULL, so deleting the board does
                # NOT cascade to the demo Group created by _create_demo_group()
                # (#1125) — that direction of the FK only nulls Board.group when
                # the *Group* is deleted, not the reverse. Without this, every
                # --wipe leaves an orphaned "Visiban Demo Workspace" behind and
                # the next seed creates another one — an unbounded leak on the
                # CI cronjob that reseeds daily with --wipe --force. Scoped to
                # the real demo board only — the --scale load-test board (#1082)
                # has no associated demo Group to clean up.
                Group.objects.filter(name=DEMO_GROUP_NAME).delete()
            if deleted:
                self.stdout.write(f"Deleted existing '{board_name}' and all related data.")

        if Board.objects.filter(name=board_name).exists():
            self.stdout.write(
                self.style.WARNING(
                    f"'{board_name}' already exists — skipping. Use --wipe to recreate."
                )
            )
            return

        users = self._ensure_demo_users()
        board = self._create_board(users[0], board_name)
        columns = self._create_columns(board)
        swimlanes = self._create_swimlanes(board, scale)
        if board_name == BOARD_NAME:
            # Row-level custom field schema (#1140) — scoped to the real demo
            # board for the same reason as the #1125 fixtures below: the
            # --scale load-test board (#1082) is regenerated fresh in an
            # ephemeral CI database purely to measure card/swimlane-volume
            # latency, and its committed budget file was derived without this
            # feature present — adding it here would be an unrelated fixture
            # change riding along with an unrelated feature.
            self._create_swimlane_custom_fields(board, swimlanes)
        labels = self._create_labels(board)
        self._add_members(board, users)
        cards = self._create_cards(board, columns, swimlanes, labels, users)
        n_archived = self._archive_some_cards(cards)

        if board_name == BOARD_NAME:
            # ── #1125: fixtures for resource families schemathesis_hooks.py
            # (#1120) otherwise has no seeded row to pull a real id from.
            # Deliberately run *after* card/movement/archival generation and
            # use fixed literals rather than `random.*` — inserting these
            # earlier, or drawing from the shared `random` stream, would shift
            # every subsequent random draw and silently change the committed
            # sample-boards/demo_board.json/.csv snapshot's card corpus for
            # reasons unrelated to this fixture set. Scoped to the real demo
            # board only — the --scale load-test board (#1082) is ephemeral
            # CI fixture data with no schemathesis route dependency on these
            # rows.
            self._create_demo_group(board, users[0])
            self._create_custom_field(board, cards)
            self._create_saved_filter(board, users[0])
            self._create_attachment(cards, users[0])

        if options["with_notifications"]:
            n_notifications = len(self._create_notifications(board, cards, users))
        else:
            n_notifications = 0

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded '{board_name}': "
                f"{len(columns)} columns, {len(swimlanes)} swimlanes, "
                f"{len(labels)} labels, {len(cards)} cards "
                f"({n_archived} archived, {n_notifications} notifications)."
            )
        )

        if options["export"]:
            self._export(board, columns, swimlanes, labels, cards)

    # ── Hosted demo site (#1034) ───────────────────────────────────────────────

    def _reset_database(self):
        """Empty every table, then restore the one row the seed does not create.

        Why a whole-database flush rather than ``--wipe`` alone (#1180): the
        hosted demo's reset must end every session (sessions are
        database-backed, and the login page promises visitors they will be
        signed out) and must not leak rows across resets — ``--wipe`` deletes
        the seeded boards by name, which leaves sessions, ``BoardEvent`` rows
        (``board_id`` is deliberately not a foreign key) and anything a
        visitor created elsewhere. The retired Compose demo got the same
        effect from ``docker compose down -v``.

        ``flush`` re-runs post_migrate, which restores content types, the
        board templates and a placeholder Site. The Site's domain is what
        ``ensure_site_admin`` keeps in sync with SITE_DOMAIN at pod start, so
        it is re-applied here rather than left as example.com until the next
        backend restart.
        """
        call_command("flush", interactive=False, verbosity=0)
        Site.objects.update_or_create(
            id=settings.SITE_ID,
            defaults={"domain": os.environ.get("SITE_DOMAIN", "localhost:8000"), "name": "Visiban"},
        )
        self.stdout.write("Reset the database: every table emptied, every session ended.")

    def _seed_demo_site(self, options):
        """Seed the try.visiban.com boards and accounts.

        Runs after the normal seed and never draws from ``random`` — it is
        fully deterministic and cannot perturb the default dataset. The
        production guard already ran in ``_seed``.
        """
        if options["wipe"]:
            Board.objects.filter(
                name__in=[b["name"] for b in DEMO_SITE_BOARDS] + list(RETIRED_DEMO_SITE_BOARD_NAMES)
            ).delete()

        users = self._ensure_demo_site_users()
        self._lock_down_site_settings()
        # Let the demo accounts see the main demo board too, alongside the
        # showcase boards.
        main = Board.objects.filter(name=BOARD_NAME).first()
        if main:
            for key, user in users.items():
                BoardMembership.objects.get_or_create(
                    board=main, user=user, defaults=self._demo_site_membership(key),
                )

        seeded = {}
        for spec in DEMO_SITE_BOARDS:
            if Board.objects.filter(name=spec["name"]).exists():
                self.stdout.write(
                    self.style.WARNING(f"'{spec['name']}' already exists — skipping. Use --wipe to recreate.")
                )
                continue
            board, cards = self._create_demo_site_board(spec, users)
            seeded[spec["name"]] = (board, cards)
            self.stdout.write(self.style.SUCCESS(f"Seeded '{spec['name']}': {len(cards)} cards."))
        n = self._create_demo_site_notifications(seeded, users)
        if n:
            self.stdout.write(self.style.SUCCESS(f"Seeded {n} notifications for the published visitor."))

    def _ensure_demo_site_users(self):
        """Create/refresh the admin and member accounts; return {key: User}.

        Passwords are re-applied on every run so a rotated env value takes
        effect at the next nightly reset. Never printed or logged.
        """
        users = {}
        for key, (username, first, last, is_admin) in DEMO_SITE_USERS.items():
            if key == "visitor":
                # The one PUBLISHED account (#1179): SiteConfigView prints
                # exactly this pair, so seed from the same settings.
                username = settings.DEMO_LOGIN_USERNAME
                password = settings.DEMO_LOGIN_PASSWORD
            elif is_admin:
                password = settings.DEMO_ADMIN_PASSWORD
            else:
                password = settings.DEMO_MEMBER_PASSWORD
            user, _ = User.objects.get_or_create(
                username=username,
                defaults={
                    "email": f"{username}@visiban.example",
                    "first_name": first,
                    "last_name": last,
                },
            )
            user.is_site_admin = is_admin
            user.set_password(password)
            # The published visitor (#1179) is seeded with the tour already
            # completed: finishing the tour saves via PATCH /api/v1/auth/me/,
            # which the demo fence refuses (it is not on DEMO_ALLOWED_WRITES), so
            # an auto-running tour would end every visitor's first minute on a
            # refusal toast. A visitor is evaluating the product, not onboarding
            # onto a team. The unpublished accounts keep the old behavior: reset
            # on every run, since --wipe deletes boards, not users, and an
            # account that finished the tour yesterday would otherwise never see
            # it again.
            user.has_completed_tour = key == "visitor"
            user.save()
            users[key] = user
        return users

    @staticmethod
    def _demo_site_membership(key):
        """Membership fields for a demo-site account on a seeded board.

        The visitor (#1179) is a plain MEMBER — never ADMIN, and deliberately
        not a moderator. Editing the admin-created seeded cards is granted by
        the DEMO_MODE-gated carve-out in boards.permissions._is_demo_visitor
        instead, so the grant disappears the moment DEMO_MODE is off rather
        than persisting as a row in this database.
        """
        if key == "admin":
            return {"role": BoardMembership.Role.ADMIN}
        return {"role": BoardMembership.Role.MEMBER}

    def _lock_down_site_settings(self):
        """Uploads off, registration closed (#1179).

        Uploads would let the demo's domain host arbitrary files until the next
        reset, and self-registration is how a visitor would mint an account the
        seeder did not create. DemoModeMiddleware refuses both writes anyway;
        seeding the settings too makes the SPA hide the affordances instead of
        offering them and refusing.
        """
        setting = SiteSetting.get()
        setting.uploads_enabled = False
        setting.registration_mode = SiteSetting.RegistrationMode.CLOSED
        # SiteSetting.save() invalidates the cached reads of both values.
        setting.save()

    def _create_demo_site_board(self, spec, users):
        admin = users["admin"]
        board = Board.objects.create(
            name=spec["name"], description=spec["description"], owner=admin, staleness_threshold_days=7,
        )
        for user_key, user in users.items():
            BoardMembership.objects.create(
                board=board, user=user, **self._demo_site_membership(user_key),
            )
        columns = [
            Column.objects.create(
                board=board, position=i, name=name, color=color,
                allow_card_creation=(i == 0), is_done=is_done,
            )
            for i, (name, color, is_done) in enumerate(spec["columns"])
        ]
        lanes = [
            Swimlane.objects.create(board=board, position=i, name=name, color=color)
            for i, (name, color) in enumerate(spec["swimlanes"])
        ]
        labels = {
            name: Label.objects.create(board=board, name=name, color=color)
            for name, color in spec["labels"]
        }

        today = timezone.localdate()
        anchor = self._demo_site_anchor()
        visitor_name = users["visitor"].username
        positions = {}
        cards = {}
        for idx, (title, desc, col_i, lane_i, priority, assignee, label_names, comments,
                  last_moved, due_offset) in enumerate(spec["cards"]):
            column, lane = columns[col_i], lanes[lane_i]
            pos = positions.get(column.id, 0)
            positions[column.id] = pos + 1
            card = Card.objects.create(
                board=board, column=column, swimlane=lane, title=title, description=desc,
                priority=priority, assignee=users[assignee] if assignee else None,
                # Explicit per card in _demo_site_data (#1363): overdue, due
                # today, upcoming and undated, never overdue in a Done column.
                due_date=(today + datetime.timedelta(days=due_offset)) if due_offset is not None else None,
                weight=(idx % 5) + 1, position=pos, created_by=admin,
            )
            if label_names:
                card.labels.set([labels[n] for n in label_names])
            created_age = self._add_demo_site_history(card, columns, col_i, anchor, idx, last_moved, users)
            for c_i, (author, body) in enumerate(comments):
                comment = CardComment.objects.create(
                    card=card, author=users[author], body=body.replace("{visitor}", visitor_name),
                )
                # The last comment lands on the day of the card's last move and
                # earlier ones a day apart before it, never before the card existed.
                age = min(last_moved + len(comments) - 1 - c_i, created_age)
                CardComment.objects.filter(pk=comment.pk).update(
                    created_at=anchor - datetime.timedelta(days=age)
                )
            cards[title] = card
        self._add_demo_site_extras(board, spec, cards, lanes, users)
        return board, cards

    @staticmethod
    def _demo_site_anchor():
        """Today's midnight (UTC): the instant every demo-site age counts back from.

        The UTC date (timezone.now() is UTC-aware) rather than date.today():
        the host's local date can run a day ahead of UTC, which would put the
        anchor — and every "0 days ago" move and notification — in the future.
        """
        today = timezone.now().date()
        return datetime.datetime(today.year, today.month, today.day, tzinfo=datetime.timezone.utc)

    def _add_demo_site_history(self, card, columns, col_i, anchor, idx, last_moved, users):
        """Backdated created + one movement per stage the card has passed.

        Every card gets a created event so the History tab is never empty.
        Mirrors _add_movement_history but with deterministic offsets. The most
        recent movement lands exactly ``last_moved`` days before ``anchor`` —
        that one value drives the staleness tint, so it is authored per card
        (#1363); the earlier stages are spaced back from it by a 3-6 day dwell.
        Returns the card's age in days (its created event).
        """
        # The visitor is excluded: it is every visitor at once, so seeded
        # history attributed to it would read as the current visitor's moves.
        people = [u for key, u in users.items() if key != "visitor"]
        mover = people[idx % len(people)]
        lane = card.swimlane
        dwell = 3 + idx % 4
        created_age = last_moved + dwell * col_i
        created = CardMovement.objects.create(
            card=card, from_column=None, to_column=columns[0], from_swimlane=None, to_swimlane=lane,
            from_column_name="", to_column_name=columns[0].name, from_column_uid="",
            to_column_uid=columns[0].uid, from_swimlane_name="", to_swimlane_name=lane.name,
            from_swimlane_uid="", to_swimlane_uid=lane.uid, moved_by=mover, notes="",
        )
        CardMovement.objects.filter(pk=created.pk).update(moved_at=anchor - datetime.timedelta(days=created_age))
        for i in range(col_i):
            src, dst = columns[i], columns[i + 1]
            mv = CardMovement.objects.create(
                card=card, from_column=src, to_column=dst, from_swimlane=lane, to_swimlane=lane,
                from_column_name=src.name, to_column_name=dst.name, from_column_uid=src.uid,
                to_column_uid=dst.uid, from_swimlane_name=lane.name, to_swimlane_name=lane.name,
                from_swimlane_uid=lane.uid, to_swimlane_uid=lane.uid, moved_by=mover, notes="",
            )
            CardMovement.objects.filter(pk=mv.pk).update(
                moved_at=anchor - datetime.timedelta(days=last_moved + dwell * (col_i - 1 - i))
            )
        return created_age

    def _add_demo_site_extras(self, board, spec, cards, lanes, users):
        """Custom fields, row fields, checklists, relations and MR/PR links (#1363).

        Everything is read from the board spec, so a typo in a card title or
        field name raises a KeyError at seed time (and in the tests) instead of
        silently seeding less than the demo promises.
        """
        admin = users["admin"]
        definitions = {}
        for pos, (name, field_type, choices, show_on_card, help_text, *display) in enumerate(spec["card_fields"]):
            definitions[name] = CustomFieldDefinition.objects.create(
                board=board, name=name, field_type=field_type, choices_json=list(choices),
                position=pos, show_on_card=show_on_card, help_text=help_text,
                **(display[0] if display else {}),
            )
        for title, values in spec["card_field_values"].items():
            for name, value in values.items():
                definition = definitions[name]
                CustomFieldValue.objects.create(
                    card=cards[title], field_definition=definition,
                    value=self._demo_site_field_value(definition, value),
                )

        # Same shape as _create_swimlane_custom_fields on the generic board: a
        # public field everyone sees plus an admin-only one, so both visibility
        # modes are on show. Row fields the visitor must see (#1389) carry
        # is_admin_only=False explicitly: the model default is True.
        row_definitions = {}
        for pos, (name, field_type, choices, show_on_row, admin_only, help_text, *display) in enumerate(
            spec["swimlane_fields"]
        ):
            row_definitions[name] = SwimlaneCustomFieldDefinition.objects.create(
                board=board, name=name, field_type=field_type, choices_json=list(choices),
                position=pos, show_on_row=show_on_row, is_admin_only=admin_only, help_text=help_text,
                **(display[0] if display else {}),
            )
        lanes_by_name = {lane.name: lane for lane in lanes}
        for lane_name, values in spec["swimlane_field_values"].items():
            for name, value in values.items():
                definition = row_definitions[name]
                SwimlaneCustomFieldValue.objects.create(
                    swimlane=lanes_by_name[lane_name], field_definition=definition,
                    value=self._demo_site_field_value(definition, value),
                )

        for title, items in spec["checklists"].items():
            card = cards[title]
            for pos, (text, checked) in enumerate(items):
                CardChecklist.objects.create(
                    card=card, text=text, is_checked=checked, position=pos,
                    created_by=card.assignee or admin,
                )

        for from_title, relation_type, to_title in spec["relations"]:
            low, high = cards[from_title], cards[to_title]
            # Symmetric types are stored with the lower card id first, the
            # same normalization CardRelationSerializer applies, so the seeded
            # rows look exactly like ones created through the API.
            if relation_type in CardRelation.SYMMETRIC_TYPES and low.pk > high.pk:
                low, high = high, low
            CardRelation.objects.create(
                from_card=low, to_card=high, relation_type=relation_type, created_by=low.assignee or admin,
            )

        for title, (provider, ref, url) in spec["external_refs"].items():
            link = CardExternalRef(card=cards[title], provider=provider, ref=ref, url=url)
            # The model's docstring: writers outside the API must run the field
            # validators themselves.
            link.full_clean()
            link.save()

    @staticmethod
    def _demo_site_field_value(definition, value):
        """Return the stored form of one spec value, validated like an API write.

        Runs the API's own normalizer (#1389) so a URL, number, date or
        multi-select value the API would refuse fails the seed instead of
        reaching the demo, and a multi-select list is stored in its canonical
        JSON encoding. A ``days_from_today(n)`` marker becomes an ISO date
        relative to the day of the reset.
        """
        if isinstance(value, tuple) and value[:1] == ("days_from_today",):
            value = (timezone.localdate() + datetime.timedelta(days=value[1])).isoformat()
        try:
            return _normalize_custom_field_value(definition, value)
        except DRFValidationError as exc:
            raise CommandError(f"Demo field {definition.name!r} rejects {value!r}: {exc.detail}") from None

    def _create_demo_site_notifications(self, seeded, users):
        """Seed the published visitor's inbox (#1363); return the row count.

        Every actor and timestamp is derived from the seeded card (see the
        VISITOR_NOTIFICATIONS docstring), so a notification can never disagree
        with the card it points at. The actor is never the visitor: the product
        does not notify anyone about their own action.
        """
        visitor = users["visitor"]
        anchor = self._demo_site_anchor()
        ActionType = Notification.ActionType
        count = 0
        for board_name, title, action_type, assigned_by in DEMO_SITE_VISITOR_NOTIFICATIONS:
            if board_name not in seeded:
                continue  # board skipped (already existed without --wipe)
            board, cards = seeded[board_name]
            card = cards[title]
            last_move = card.movements.order_by("-moved_at").first()
            if action_type == ActionType.MENTIONED:
                mention = f"@{visitor.username}"
                comment = next(c for c in card.comments.order_by("created_at") if mention in c.body)
                actor, at = comment.author, comment.created_at
                verb = quoted_card_verb(f"{actor.username} mentioned you in", card.title)
            elif action_type == ActionType.COMMENT_ADDED:
                comment = card.comments.order_by("-created_at").first()
                actor, at = comment.author, comment.created_at
                verb = quoted_card_verb(f"{actor.username} commented on", card.title)
            elif action_type == ActionType.CARD_MOVED:
                actor, at = last_move.moved_by, last_move.moved_at
                verb = f"{actor.username} moved \"{card.title}\" to {last_move.to_column_name}"
            elif action_type == ActionType.ASSIGNED:
                actor, at = users[assigned_by], last_move.moved_at
                verb = f"You were assigned to \"{card.title}\""
            elif action_type == ActionType.STALE:
                actor, at = None, anchor
                days = (anchor - last_move.moved_at).days
                verb = f"\"{card.title}\" hasn't moved in {days} days (board: {board.name})"
            elif action_type == ActionType.DUE_SOON:
                actor, at = None, anchor
                verb = f'"{card.title}" is due soon'
            else:
                raise CommandError(f"Unsupported demo notification type {action_type!r}.")
            if actor is not None and actor.pk == visitor.pk:
                raise CommandError(f"Demo notification on {title!r} would credit the visitor's own action.")
            notification = Notification.objects.create(
                recipient=visitor, actor=actor, action_type=action_type, verb=verb,
                card=card, board=board, read=False,
            )
            # auto_now_add ignores a value passed to create().
            Notification.objects.filter(pk=notification.pk).update(created_at=at)
            count += 1
        return count

    # ── Private helpers ────────────────────────────────────────────────────────

    def _ensure_demo_users(self):
        users = []
        for u in DEMO_USERS:
            user, created = User.objects.get_or_create(
                username=u["username"],
                defaults={
                    "email": u["email"],
                    "first_name": u["first_name"],
                    "last_name": u["last_name"],
                },
            )
            if created:
                # Demo accounts are not for login — password intentionally unusable.
                user.set_unusable_password()
                user.save()
            users.append(user)
        return users

    def _create_board(self, owner, board_name=BOARD_NAME):
        return Board.objects.create(
            name=board_name,
            description=(
                "Demo board pre-loaded with realistic data for product demos, "
                "sales calls, and integration testing."
                if board_name == BOARD_NAME
                else "Large fixture board for the nightly load-test job (#1082). "
                "Not for demos — regenerated fresh in an ephemeral CI database "
                "on every run."
            ),
            owner=owner,
            staleness_threshold_days=7,
        )

    def _create_columns(self, board):
        cols = []
        for i, c in enumerate(COLUMNS):
            cols.append(Column.objects.create(board=board, position=i, **c))
        return cols

    def _create_swimlanes(self, board, scale=1):
        """Create `scale` replicas of SWIMLANES so a large fixture (#1082) has

        proportionally more rows to spread cards across, instead of stuffing an
        unrealistic card count into 10 swimlanes. scale=1 (the default) creates
        exactly SWIMLANES with no name suffix, unchanged from every prior
        release, so the committed --export snapshot stays byte-stable.
        """
        lanes = []
        position = 0
        for replica in range(scale):
            for s in SWIMLANES:
                data = dict(s)
                if replica > 0:
                    # Swimlane names are unique-per-board in the UI; suffix
                    # replicas so multiple copies of "Acme Corp" etc. don't
                    # collide. Replica 0 is untouched — see docstring above.
                    data["name"] = f"{s['name']} ({replica + 1})"
                lanes.append(Swimlane.objects.create(board=board, position=position, **data))
                position += 1
        return lanes

    def _create_swimlane_custom_fields(self, board, lanes):
        """Seed the row field schema and a value per lane (#1140).

        Two definitions rather than one, and deliberately one of each
        visibility: the admin-only default is what the schemathesis fuzz job
        and any manual poke at the API will meet first, and a demo board with
        only admin-only fields would look empty to every non-admin viewer.
        """
        region = SwimlaneCustomFieldDefinition.objects.create(
            board=board, name="Region", field_type="dropdown",
            choices_json=["EMEA", "AMER", "APAC"], position=0,
            show_on_row=True, is_admin_only=False,
            help_text="Sales region for this account",
        )
        owner = SwimlaneCustomFieldDefinition.objects.create(
            board=board, name="Account owner", field_type="text", position=1,
            show_on_row=True, is_admin_only=True,
        )
        regions = ["EMEA", "AMER", "APAC"]
        owners = ["J. Rivera", "P. Okafor", "L. Nakamura", "S. Brandt"]
        for i, lane in enumerate(lanes):
            SwimlaneCustomFieldValue.objects.create(
                swimlane=lane, field_definition=region, value=regions[i % len(regions)]
            )
            SwimlaneCustomFieldValue.objects.create(
                swimlane=lane, field_definition=owner, value=owners[i % len(owners)]
            )

    def _create_labels(self, board):
        return [Label.objects.create(board=board, **lbl) for lbl in LABELS]

    def _add_members(self, board, users):
        BoardMembership.objects.create(board=board, user=users[0], role=BoardMembership.Role.ADMIN)
        for user in users[1:]:
            BoardMembership.objects.create(board=board, user=user, role=BoardMembership.Role.MEMBER)

    def _create_cards(self, board, columns, swimlanes, labels, users):
        today = SEED_ANCHOR_DATE
        titles = list(CARD_TITLES)
        random.shuffle(titles)

        pipeline = list(columns)  # Backlog → To Do → Doing → Review → Done
        cards = []
        title_idx = 0
        col_positions = {c.id: 0 for c in columns}

        for swimlane in swimlanes:
            n_cards = random.randint(11, 13)

            for _ in range(n_cards):
                if title_idx < len(titles):
                    # Corpus not yet exhausted: unique title, unchanged from
                    # every prior release (scale=1 never reaches the else
                    # branch — 10 swimlanes x <=13 cards < len(titles) — so
                    # the committed --export snapshot stays byte-stable).
                    title = titles[title_idx]
                else:
                    # Large-fixture (--scale > 1) corpus exhaustion: cycle the
                    # corpus with a numeric suffix rather than breaking early,
                    # so a --scale N run reaches its intended card count
                    # instead of silently truncating at len(titles) cards.
                    title = f"{titles[title_idx % len(titles)]} (#{title_idx})"
                title_idx += 1

                description = random.choice(CARD_DESCRIPTIONS)
                priority = random.choices(
                    ["low", "medium", "high", "urgent"],
                    weights=[15, 40, 30, 15],
                )[0]

                # Due dates: 20% overdue, 30% no date, 50% near-term future
                due_roll = random.random()
                if due_roll < 0.20:
                    due_date = today - datetime.timedelta(days=random.randint(1, 30))
                elif due_roll < 0.50:
                    due_date = None
                else:
                    due_date = today + datetime.timedelta(days=random.randint(1, 30))

                # Weight distribution toward Backlog and Done
                current_col = random.choices(columns, weights=[25, 20, 20, 15, 20])[0]
                assignee = random.choice([None] + users)

                card = Card.objects.create(
                    board=board,
                    column=current_col,
                    swimlane=swimlane,
                    title=title,
                    description=description,
                    priority=priority,
                    assignee=assignee,
                    due_date=due_date,
                    weight=random.randint(1, 8),
                    position=col_positions[current_col.id],
                    created_by=random.choice(users),
                )
                col_positions[current_col.id] += 1

                n_labels = random.choices([0, 1, 2], weights=[40, 40, 20])[0]
                if n_labels:
                    card.labels.set(random.sample(labels, n_labels))

                # Checklist: ~40% of cards
                if random.random() < 0.40:
                    items = random.choice(CHECKLIST_SETS)
                    n_items = random.randint(2, min(5, len(items)))
                    for pos, text in enumerate(items[:n_items]):
                        CardChecklist.objects.create(
                            card=card,
                            text=text,
                            is_checked=random.random() < 0.5,
                            position=pos,
                        )

                # Comments: ~60% of cards
                if random.random() < 0.60:
                    n_comments = random.randint(1, 3)
                    for body in random.sample(COMMENT_BODIES, min(n_comments, len(COMMENT_BODIES))):
                        comment = CardComment.objects.create(
                            card=card,
                            author=random.choice(users),
                            body=body,
                        )
                        anchor = datetime.datetime(
                            self._movement_anchor.year, self._movement_anchor.month, self._movement_anchor.day,
                            tzinfo=datetime.timezone.utc,
                        )
                        comment_at = anchor - datetime.timedelta(days=random.randint(1, 60))
                        CardComment.objects.filter(pk=comment.pk).update(created_at=comment_at)

                # Movement history for cards not in Backlog
                self._add_movement_history(card, current_col, pipeline, users)

                # Activity records: ~30% of cards
                if random.random() < 0.30:
                    self._add_activity(card, users)

                cards.append(card)

        return cards

    def _add_movement_history(self, card, current_col, pipeline, users):
        """
        Simulate the card having progressed through pipeline stages to reach its
        current column. Cards in Backlog (index 0) are new and get no history.
        Each stage transition gets a backdated CardMovement record.

        auto_now_add=True ignores explicit values at create time, so moved_at is
        back-filled with update() after creation.

        Date anchoring: movements are calculated relative to SEED_ANCHOR_DATE (not
        timezone.now()) so that regenerated exports are git-stable across run dates.

        Spread: each stage occupies 5–18 days so that:
          - cards in mid-pipeline show realistic dwell times across a 30–90 day window
          - ~half the active cards have their last movement >7 days ago, populating
            the stalled-cards list in the analytics endpoint
        """
        col_idx = pipeline.index(current_col)

        # Anchor movements to self._movement_anchor (today in live runs,
        # SEED_ANCHOR_DATE in --export runs) so analytics windows stay fresh.
        anchor = datetime.datetime(
            self._movement_anchor.year,
            self._movement_anchor.month,
            self._movement_anchor.day,
            tzinfo=datetime.timezone.utc,
        )
        # Build cumulative days_ago from the anchor working backwards through stages.
        # Each stage takes 5–18 days; the most-recent transition lands 3–10 days
        # before the anchor so roughly half of active cards appear stalled.
        cumulative_days = random.randint(3, 10)
        stage_offsets = []
        for _ in range(col_idx):
            stage_offsets.append(cumulative_days)
            cumulative_days += random.randint(5, 18)
        # stage_offsets[0] = days_ago for the most recent transition, so reverse
        # so that i=0 corresponds to the earliest (largest days_ago) transition.
        stage_offsets.reverse()

        # Always create a "card created" movement (from_column=None) so that
        # the History tab is never empty — even for cards still in Backlog.
        created_days_ago = (
            cumulative_days + random.randint(5, 15) if col_idx > 0 else random.randint(10, 60)
        )
        created_at = anchor - datetime.timedelta(days=created_days_ago)
        mv = CardMovement.objects.create(
            card=card,
            from_column=None,
            to_column=pipeline[0],
            from_swimlane=None,
            to_swimlane=card.swimlane,
            from_column_name="",
            to_column_name=pipeline[0].name,
            from_column_uid="",
            to_column_uid=pipeline[0].uid,
            from_swimlane_name="",
            to_swimlane_name=card.swimlane.name,
            from_swimlane_uid="",
            to_swimlane_uid=card.swimlane.uid,
            moved_by=random.choice(users),
            notes="",
        )
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=created_at)

        for i in range(col_idx):
            from_col = pipeline[i]
            to_col = pipeline[i + 1]
            moved_at = anchor - datetime.timedelta(days=stage_offsets[i])

            mv = CardMovement.objects.create(
                card=card,
                from_column=from_col,
                to_column=to_col,
                from_swimlane=card.swimlane,
                to_swimlane=card.swimlane,
                from_column_name=from_col.name,
                to_column_name=to_col.name,
                from_column_uid=from_col.uid,
                to_column_uid=to_col.uid,
                from_swimlane_name=card.swimlane.name,
                to_swimlane_name=card.swimlane.name,
                from_swimlane_uid=card.swimlane.uid,
                to_swimlane_uid=card.swimlane.uid,
                moved_by=random.choice(users),
                notes="",
            )
            # Back-fill moved_at; auto_now_add=True ignores values at create time.
            CardMovement.objects.filter(pk=mv.pk).update(moved_at=moved_at)

    def _add_activity(self, card, users):
        """Add one field-change activity record.

        Covers priority, assignee, label, comment, and weight changes so that
        the history panel shows a realistic mix of event types. (#364)

        created_at is anchored to SEED_ANCHOR_DATE so regenerated exports are
        git-stable — auto_now_add=True ignores explicit values, so we back-fill
        with filter().update() after creation, same pattern as movements.
        """
        actor = random.choice(users)
        event = random.choice([
            CardActivity.EventType.PRIORITY_CHANGE,
            CardActivity.EventType.ASSIGNEE_CHANGE,
            CardActivity.EventType.LABEL_CHANGE,
            CardActivity.EventType.COMMENT_ADDED,
            CardActivity.EventType.WEIGHT_CHANGE,
        ])
        anchor = datetime.datetime(
            self._movement_anchor.year,
            self._movement_anchor.month,
            self._movement_anchor.day,
            tzinfo=datetime.timezone.utc,
        )
        activity_at = anchor - datetime.timedelta(days=random.randint(1, 30))

        if event == CardActivity.EventType.PRIORITY_CHANGE:
            old_priority = random.choice(["low", "medium", "high"])
            act = CardActivity.objects.create(
                card=card,
                event_type=event,
                from_value=old_priority,
                to_value=card.priority,
                actor=actor,
            )
        elif event == CardActivity.EventType.ASSIGNEE_CHANGE:
            old_user = random.choice(users)
            act = CardActivity.objects.create(
                card=card,
                event_type=event,
                from_value=old_user.username,
                to_value=card.assignee.username if card.assignee else "",
                actor=actor,
            )
        elif event == CardActivity.EventType.LABEL_CHANGE:
            sample_labels = ["Bug", "Feature", "Urgent", "Review", "Blocked"]
            act = CardActivity.objects.create(
                card=card,
                event_type=event,
                from_value="",
                to_value=random.choice(sample_labels),
                actor=actor,
            )
        elif event == CardActivity.EventType.COMMENT_ADDED:
            sample_comments = [
                "Looks good — moving forward.",
                "Needs another review pass.",
                "Blocked on dependencies.",
                "Updated per feedback.",
                "Ready for QA.",
            ]
            act = CardActivity.objects.create(
                card=card,
                event_type=event,
                from_value="",
                to_value=random.choice(sample_comments),
                actor=actor,
            )
        else:  # WEIGHT_CHANGE
            old_weight = random.randint(1, 8)
            new_weight = random.randint(1, 8)
            act = CardActivity.objects.create(
                card=card,
                event_type=event,
                from_value=str(old_weight),
                to_value=str(new_weight),
                actor=actor,
            )
        # Back-fill created_at; auto_now_add=True ignores values at create time.
        CardActivity.objects.filter(pk=act.pk).update(created_at=activity_at)

    def _archive_some_cards(self, cards):
        """
        Archive 7–10 randomly selected cards to populate the Archived panel on
        the demo board. Archived dates are back-filled between 3 and 45 days ago
        so the panel shows a realistic spread of recently-archived work.
        """
        n = random.randint(7, 10)
        to_archive = random.sample(cards, min(n, len(cards)))
        anchor = datetime.datetime(
            self._movement_anchor.year, self._movement_anchor.month, self._movement_anchor.day,
            tzinfo=datetime.timezone.utc,
        )
        for card in to_archive:
            days_ago = random.randint(3, 45)
            archived_at = anchor - datetime.timedelta(days=days_ago)
            Card.objects.filter(pk=card.pk).update(archived_at=archived_at)
            card.archived_at = archived_at  # keep in-memory object consistent
        return len(to_archive)

    def _create_notifications(self, board, cards, users, count=60):
        """Seed unread Notification rows for 'demo2' (--with-notifications only).

        NotificationListView and NotificationUnreadCountView both cap their
        query at 50 rows, so `count` deliberately exceeds that: it exercises
        the same "more unread than the cap" path a real busy inbox hits,
        rather than a queryset that always returns everything it filters.

        'demo2' is the fixed recipient because it is also the default
        --username for provision_fuzz_token, which the nightly load-test job
        (#1082) reuses unchanged to mint its bearer token — this keeps that
        token's owner and the notification-poll fixture data pointed at the
        same account without wiring a second convention through the job.
        """
        recipient = next((u for u in users if u.username == "demo2"), users[0])
        actors = [u for u in users if u.pk != recipient.pk] or list(users)
        anchor = datetime.datetime(
            self._movement_anchor.year, self._movement_anchor.month, self._movement_anchor.day,
            tzinfo=datetime.timezone.utc,
        )
        sample = random.sample(cards, min(count, len(cards)))
        created = []
        for card in sample:
            actor = random.choice(actors)
            action_type = random.choice([
                Notification.ActionType.ASSIGNED,
                Notification.ActionType.MENTIONED,
                Notification.ActionType.CARD_MOVED,
                Notification.ActionType.STALE,
            ])
            if action_type == Notification.ActionType.ASSIGNED:
                verb = f"assigned you to \"{card.title}\""
            elif action_type == Notification.ActionType.MENTIONED:
                verb = f"mentioned you on \"{card.title}\""
            elif action_type == Notification.ActionType.CARD_MOVED:
                verb = f"moved \"{card.title}\" to {card.column.name}"
            else:
                verb = f"\"{card.title}\" has had no activity in {random.randint(7, 21)} days"
            notif = Notification.objects.create(
                recipient=recipient,
                actor=actor,
                action_type=action_type,
                verb=verb,
                card=card,
                board=board,
                read=False,
            )
            # Back-fill created_at; auto_now_add=True ignores values at create time.
            created_at = anchor - datetime.timedelta(hours=random.randint(1, 240))
            Notification.objects.filter(pk=notif.pk).update(created_at=created_at)
            created.append(notif)
        return created

    def _create_demo_group(self, board, owner):
        """Create a demo Group and attach the demo board to it (#1125).

        `seed_demo_data` previously left `Board.group` null, so the
        `map_path_parameters` schemathesis hook (#1120) had no seeded Group id
        to reach `/api/v1/groups/{id}/...` routes with — every one of those
        operations 404ed under fuzzing. Attaching the *existing* demo board to
        a new group (rather than building an unrelated second board) keeps the
        seeded data self-consistent: `GroupViewSet.boards`/`descendant_boards`
        surface a real board, matching what an actual workspace looks like.

        A `GroupLabel` and a `GroupInviteLink` are added too so those
        sub-resource routes (`labels/{label_id}`, `invite-links/{link_id}`)
        have a real row as well. `GroupInviteLink.generate()` hashes a
        `secrets.token_hex()` token — per this repo's token-generation rule,
        tokens are never `random`-derived — so the token itself is
        non-deterministic across runs. That's fine: the token is not part of
        the committed `sample-boards/` snapshot, only the Group/label/link
        *rows existing* matters for schemathesis reachability.
        """
        group = Group.objects.create(
            name=DEMO_GROUP_NAME,
            description=(
                "Demo workspace bundling the demo board and its group-scoped "
                "sub-resources (labels, invite links, subgroups)."
            ),
            owner=owner,
        )
        board.group = group
        board.save(update_fields=["group"])
        GroupLabel.objects.create(group=group, name="Demo", color="#6366F1")
        GroupInviteLink.generate(
            group=group,
            created_by=owner,
            name="Demo invite link",
            role=GroupInviteLink.Role.MEMBER,
        )
        return group

    def _create_custom_field(self, board, cards):
        """Create one board-scoped CustomFieldDefinition and a value on one
        card (#371, #1125), so `/boards/{board_pk}/custom-fields/{id}/` has a
        real definition id to seed for schemathesis (#1120)."""
        field = CustomFieldDefinition.objects.create(
            board=board,
            name="Story Points",
            field_type=CustomFieldDefinition.FieldType.NUMBER,
            position=0,
            show_on_card=True,
            help_text="Estimated relative effort for this card.",
        )
        if cards:
            CustomFieldValue.objects.create(
                card=cards[0],
                field_definition=field,
                value="5",
            )
        return field

    def _create_saved_filter(self, board, owner):
        """Create one SavedFilter on the demo board (#1125) so
        `/boards/{id}/saved-filters/{filter_pk}/` has a real row for
        schemathesis (#1120) to reach."""
        return SavedFilter.objects.create(
            user=owner,
            board=board,
            name="High priority, overdue",
            state_json={
                "search": "",
                "assigneeIds": [],
                "labelIds": [],
                "priorities": ["high", "urgent"],
                "dueDate": "overdue",
            },
        )

    def _create_attachment(self, cards, uploaded_by):
        """Attach one small, deterministic file to a card (#1125) so
        `/boards/{board_pk}/cards/{id}/attachments/{attachment_pk}/` has a
        real row for schemathesis (#1120) to reach.

        Kept tiny and fixed-content (not `--export`ed — attachments are not
        part of the committed JSON/CSV snapshot, only DB rows for the fuzz job)."""
        if not cards:
            return None
        content = b"Demo attachment seeded by seed_demo_data (#1125).\n"
        return CardAttachment.objects.create(
            card=cards[0],
            file=ContentFile(content, name="demo-notes.txt"),
            filename="demo-notes.txt",
            size=len(content),
            uploaded_by=uploaded_by,
        )

    # ── Export ─────────────────────────────────────────────────────────────────

    def _export(self, board, columns, swimlanes, labels, cards):
        """Write JSON and CSV snapshots to scripts/seed/.

        Path resolution handles two layouts:
          - Local checkout: BASE_DIR = .../visiban/backend/, so repo root is BASE_DIR.parent
          - Docker (./backend:/app): BASE_DIR = /app/, parent is filesystem root.
            In this case the repo-level scripts/ dir is not mounted, so we write
            inside /app/scripts/seed/ and the caller can docker cp the files out.
        """
        # Re-fetch cards with all related data prefetched so that _export_json
        # and _export_csv don't issue N+1 queries for labels, checklist items,
        # comments, column, swimlane, assignee, movements, and activities.
        # Export only active (non-archived) cards — the snapshot represents the
        # live board view, not the archived history.
        card_ids = [c.pk for c in cards if c.archived_at is None]
        cards = (
            board.cards
            .filter(pk__in=card_ids)
            .select_related("column", "swimlane", "assignee")
            .prefetch_related(
                "labels",
                "checklist_items",
                "comments__author",
                "movements__moved_by",
                "activities__actor",
            )
            .order_by("swimlane__position", "column__position", "position")
        )

        # Export path: write to the top-level sample-boards/ directory so
        # users can discover importable board files at the repo root.
        # BASE_DIR = .../backend/, so repo root is BASE_DIR.parent.
        seed_dir = settings.BASE_DIR.parent / "sample-boards"
        seed_dir.mkdir(parents=True, exist_ok=True)

        self._export_json(board, columns, swimlanes, labels, cards, seed_dir)
        self._export_csv(cards, seed_dir)
        self.stdout.write(self.style.SUCCESS(f"Exported seed files to {seed_dir}/"))

    def _export_json(self, board, columns, swimlanes, labels, cards, seed_dir):
        # Structure must match the canonical export format consumed by _import_json
        # (flat top-level keys: schema_version, name, description, columns, swimlanes, labels, cards).
        data = {
            "schema_version": 2,
            "name": board.name,
            "description": board.description,
            "columns": [
                {
                    "name": c.name,
                    "position": c.position,
                    "color": c.color,
                    "wip_limit": c.wip_limit,
                    "weight_limit": c.weight_limit,
                    "allow_card_creation": c.allow_card_creation,
                    "is_done": c.is_done,
                }
                for c in columns
            ],
            "swimlanes": [
                {
                    "name": s.name,
                    "position": s.position,
                    "color": s.color,
                    "contact_email": s.contact_email,
                    "notes": s.notes,
                }
                for s in swimlanes
            ],
            "labels": [
                {"name": lbl.name, "color": lbl.color}
                for lbl in labels
            ],
            "cards": [
                {
                    "title": card.title,
                    "description": card.description,
                    "priority": card.priority,
                    "column": card.column.name,
                    "swimlane": card.swimlane.name,
                    "due_date": card.due_date.isoformat() if card.due_date else None,
                    "weight": card.weight,
                    "assignee": card.assignee.username if card.assignee else None,
                    "archived_at": card.archived_at.isoformat() if card.archived_at else None,
                    "labels": [lbl.name for lbl in card.labels.order_by("name")],
                    "checklist": [
                        {"text": item.text, "is_checked": item.is_checked}
                        for item in card.checklist_items.all()
                    ],
                    "comments": [
                        {
                            "body": comment.body,
                            "author": comment.author.username if comment.author else None,
                            "created_at": comment.created_at.isoformat(),
                        }
                        for comment in sorted(card.comments.all(), key=lambda c: (c.created_at, c.body))
                    ],
                    "movements": [
                        {
                            "from_column": mv.from_column_name,
                            "to_column": mv.to_column_name,
                            "from_swimlane": mv.from_swimlane_name,
                            "to_swimlane": mv.to_swimlane_name,
                            "moved_at": mv.moved_at.isoformat(),
                            "moved_by": mv.moved_by.username if mv.moved_by else None,
                            "notes": mv.notes,
                            "movement_type": mv.movement_type,
                        }
                        for mv in card.movements.order_by("moved_at")
                    ],
                    "activities": [
                        {
                            "event_type": act.event_type,
                            "from_value": act.from_value,
                            "to_value": act.to_value,
                            "actor": act.actor.username if act.actor else None,
                            "created_at": act.created_at.isoformat(),
                        }
                        for act in card.activities.order_by("created_at")
                    ],
                }
                for card in cards
            ],
        }
        out = seed_dir / "demo_board.json"
        out.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        self.stdout.write(f"  → {out}")

    def _export_csv(self, cards, seed_dir):
        fieldnames = [
            "title", "column", "swimlane", "priority", "due_date",
            "weight", "labels", "assignee", "checklist_total",
            "checklist_done", "comment_count", "description_preview",
        ]
        out = seed_dir / "demo_board.csv"
        with out.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for card in cards:
                # Use list() to consume the prefetch cache — avoids N+1 queries.
                checklist = list(card.checklist_items.all())
                comments = list(card.comments.all())
                writer.writerow({
                    "title": card.title,
                    "column": card.column.name,
                    "swimlane": card.swimlane.name,
                    "priority": card.priority,
                    "due_date": card.due_date.isoformat() if card.due_date else "",
                    "weight": card.weight,
                    "labels": ",".join(lbl.name for lbl in card.labels.order_by("name")),
                    "assignee": card.assignee.username if card.assignee else "",
                    "checklist_total": len(checklist),
                    "checklist_done": sum(1 for i in checklist if i.is_checked),
                    "comment_count": len(comments),
                    "description_preview": card.description[:80].replace("\n", " "),
                })
        self.stdout.write(f"  → {out}")
