"""
Generate and load realistic demo data for Visiban.

Creates a "Visiban Demo Board" with 5 columns, 10 swimlanes, ~80 cards,
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
        scripts/seed/demo_board.json and scripts/seed/demo_board.csv.
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
"""

import csv
import datetime
import json
import random
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from accounts.models import User
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardActivity,
    CardChecklist,
    CardComment,
    CardMovement,
    Column,
    Label,
    Swimlane,
)

BOARD_NAME = "Visiban Demo Board"
RANDOM_SEED = 42
# Fixed reference date for due-date calculations — keeps the exported JSON/CSV
# files git-stable regardless of when the command is run.
SEED_ANCHOR_DATE = datetime.date(2026, 3, 15)

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
    {"name": "To Do",    "color": "#3B82F6", "allow_card_creation": True},
    {"name": "Doing",    "color": "#F59E0B", "allow_card_creation": False},
    {"name": "Review",   "color": "#8B5CF6", "allow_card_creation": False},
    {"name": "Done",     "color": "#10B981", "allow_card_creation": False},
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
    "Fix login redirect loop on mobile",
    "Add CSV export for board activity",
    "Investigate slow card load on large boards",
    "Implement due-date reminder notifications",
    "Refactor swimlane reorder endpoint",
    "Add keyboard shortcut to create card",
    "Fix WebSocket reconnect on token refresh",
    "Support dark mode in email notifications",
    "Write API docs for /boards/{id}/full/",
    "Add bulk archive action to card list",
    "Fix drag-and-drop on touch screens",
    "Increase test coverage for CardMovement",
    "Add attachment preview for PDFs",
    "Optimise full-board query with select_related",
    "Migrate CI from Docker-in-Docker to kaniko",
    "Add pagination to movement history endpoint",
    "Fix column WIP limit badge wrapping",
    "Implement board-level search",
    "Add invite-only registration toggle",
    "Support @mentions in card descriptions",
    "Fix stale WebSocket after board rename",
    "Add priority filter to FilterBar",
    "Investigate memory leak in frontend bundle",
    "Add Prometheus metrics endpoint",
    "Write runbook for on-call rotation",
    "Implement card weight rollup per swimlane",
    "Fix broken avatar URL for OAuth users",
    "Add group-level board visibility setting",
    "Support emoji in card titles",
    "Audit all endpoints for IDOR vulnerabilities",
    "Add time-in-stage heatmap to analytics",
    "Fix CSV import skipping blank description",
    "Improve error messages on 403 responses",
    "Add card duplication action",
    "Remove deprecated /api/v1/ aliases",
    "Set up staging environment seed job",
    "Add read-only viewer role enforcement",
    "Fix swimlane collapse state not persisting",
    "Benchmark board load with 1000+ cards",
    "Add SAML SSO support (enterprise)",
    "Improve onboarding empty state copy",
    "Fix notification bell count mismatch",
    "Add column-level WIP enforcement",
    "Write integration test for card move API",
    "Add archive board action",
    "Fix date picker timezone offset",
    "Create Helm chart for staging deployment",
    "Add label filter to board view",
    "Document card weight feature",
    "Set up MinIO for local dev attachments",
    "Fix due-date badge color for overdue cards",
    "Add OAuth2 PKCE flow for mobile clients",
    "Implement rate limiting on auth endpoints",
    "Fix column separator drag on Firefox",
    "Add board activity feed",
    "Integrate Sentry for frontend error tracking",
    "Write migration guide from v0.9 to v1.0",
    "Add card quick-add shortcut to swimlane",
    "Fix empty state not showing on fresh board",
    "Investigate flaky test in test_concurrent_moves",
    "Add bulk label assignment",
    "Fix checklist item delete losing position",
    "Implement card template system",
    "Add swimlane color picker to edit modal",
    "Write performance test for /boards/{id}/full/",
    "Fix XSS via card title in notifications",
    "Add read receipt to comments",
    "Review and update CONTRIBUTING.md",
    "Add offline mode banner",
    "Fix pagination cursors on Safari",
    "Set up weekly demo data refresh job",
    "Add card age indicator",
    "Implement board copy feature",
    "Fix Dockerfile layer caching regression",
    "Add card position audit log",
    "Clean up unused CSS utility classes",
    "Add export to Markdown option",
    "Fix Google OAuth callback 500 on new user",
    "Update Python dependencies to latest patch",
    "Add column archival (soft delete)",
    "Improve accessibility of drag handles",
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

    def handle(self, *args, **options):
        random.seed(options["seed"])

        # Production guard: refuse to run on any non-DEBUG environment unless
        # --force is explicitly passed. This applies to both plain runs (which
        # create demo users and a demo board) and --wipe runs (which delete
        # existing data). Running against a live database would corrupt it.
        if not settings.DEBUG and not options["force"]:
            raise CommandError(
                "Refusing to seed: DEBUG is False. "
                "Pass --force to override (only safe on dedicated demo environments)."
            )

        if options["wipe"]:
            deleted, _ = Board.objects.filter(name=BOARD_NAME).delete()
            if deleted:
                self.stdout.write(f"Deleted existing '{BOARD_NAME}' and all related data.")

        if Board.objects.filter(name=BOARD_NAME).exists():
            self.stdout.write(
                self.style.WARNING(
                    f"'{BOARD_NAME}' already exists — skipping. Use --wipe to recreate."
                )
            )
            return

        users = self._ensure_demo_users()
        board = self._create_board(users[0])
        columns = self._create_columns(board)
        swimlanes = self._create_swimlanes(board)
        labels = self._create_labels(board)
        self._add_members(board, users)
        cards = self._create_cards(board, columns, swimlanes, labels, users)
        n_archived = self._archive_some_cards(cards)

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded '{BOARD_NAME}': "
                f"{len(columns)} columns, {len(swimlanes)} swimlanes, "
                f"{len(labels)} labels, {len(cards)} cards "
                f"({n_archived} archived)."
            )
        )

        if options["export"]:
            self._export(board, columns, swimlanes, labels, cards)

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

    def _create_board(self, owner):
        return Board.objects.create(
            name=BOARD_NAME,
            description=(
                "Demo board pre-loaded with realistic data for product demos, "
                "sales calls, and integration testing."
            ),
            owner=owner,
            staleness_threshold_days=7,
        )

    def _create_columns(self, board):
        cols = []
        for i, c in enumerate(COLUMNS):
            cols.append(Column.objects.create(board=board, position=i, **c))
        return cols

    def _create_swimlanes(self, board):
        lanes = []
        for i, s in enumerate(SWIMLANES):
            lanes.append(Swimlane.objects.create(board=board, position=i, **s))
        return lanes

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
            n_cards = random.randint(6, 10)

            for _ in range(n_cards):
                title = titles[title_idx % len(titles)]
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
                        CardComment.objects.create(
                            card=card,
                            author=random.choice(users),
                            body=body,
                        )

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
        """
        col_idx = pipeline.index(current_col)
        if col_idx == 0:
            return

        now = timezone.now()
        for i in range(col_idx):
            from_col = pipeline[i]
            to_col = pipeline[i + 1]
            days_ago = (col_idx - i) * random.randint(1, 5)
            moved_at = now - datetime.timedelta(days=days_ago)

            mv = CardMovement.objects.create(
                card=card,
                from_column=from_col,
                to_column=to_col,
                from_swimlane=card.swimlane,
                to_swimlane=card.swimlane,
                from_column_name=from_col.name,
                to_column_name=to_col.name,
                from_swimlane_name=card.swimlane.name,
                to_swimlane_name=card.swimlane.name,
                moved_by=random.choice(users),
                notes="",
            )
            # Back-fill moved_at; auto_now_add=True ignores values at create time.
            CardMovement.objects.filter(pk=mv.pk).update(moved_at=moved_at)

    def _add_activity(self, card, users):
        """Add one field-change activity record (priority or assignee change)."""
        actor = random.choice(users)
        event = random.choice([
            CardActivity.EventType.PRIORITY_CHANGE,
            CardActivity.EventType.ASSIGNEE_CHANGE,
        ])
        if event == CardActivity.EventType.PRIORITY_CHANGE:
            old_priority = random.choice(["low", "medium", "high"])
            CardActivity.objects.create(
                card=card,
                event_type=event,
                from_value=old_priority,
                to_value=card.priority,
                actor=actor,
            )
        else:
            old_user = random.choice(users)
            CardActivity.objects.create(
                card=card,
                event_type=event,
                from_value=old_user.username,
                to_value=card.assignee.username if card.assignee else "",
                actor=actor,
            )

    def _archive_some_cards(self, cards):
        """
        Archive 7–10 randomly selected cards to populate the Archived panel on
        the demo board. Archived dates are back-filled between 3 and 45 days ago
        so the panel shows a realistic spread of recently-archived work.
        """
        n = random.randint(7, 10)
        to_archive = random.sample(cards, min(n, len(cards)))
        now = timezone.now()
        for card in to_archive:
            days_ago = random.randint(3, 45)
            archived_at = now - datetime.timedelta(days=days_ago)
            Card.objects.filter(pk=card.pk).update(archived_at=archived_at)
            card.archived_at = archived_at  # keep in-memory object consistent
        return len(to_archive)

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
        # comments, column, swimlane, and assignee.
        # Export only active (non-archived) cards — the snapshot represents the
        # live board view, not the archived history.
        card_ids = [c.pk for c in cards if c.archived_at is None]
        cards = (
            board.cards
            .filter(pk__in=card_ids)
            .select_related("column", "swimlane", "assignee")
            .prefetch_related("labels", "checklist_items", "comments__author")
            .order_by("swimlane__position", "column__position", "position")
        )

        repo_root = settings.BASE_DIR.parent
        # When BASE_DIR.parent does not contain a backend/ subdirectory we are
        # running inside a container where the backend dir IS the mount root.
        if not (repo_root / "backend").exists():
            repo_root = settings.BASE_DIR
        seed_dir = repo_root / "scripts" / "seed"
        seed_dir.mkdir(parents=True, exist_ok=True)

        self._export_json(board, columns, swimlanes, labels, cards, seed_dir)
        self._export_csv(cards, seed_dir)
        self.stdout.write(self.style.SUCCESS(f"Exported seed files to {seed_dir}/"))

    def _export_json(self, board, columns, swimlanes, labels, cards, seed_dir):
        # Structure must match the canonical export format consumed by _import_json
        # (flat top-level keys: name, description, columns, swimlanes, labels, cards).
        data = {
            "name": board.name,
            "description": board.description,
            "columns": [
                {
                    "name": c.name,
                    "position": c.position,
                    "color": c.color,
                    "wip_limit": c.wip_limit,
                    "allow_card_creation": c.allow_card_creation,
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
                    "labels": [lbl.name for lbl in card.labels.order_by("name")],
                    "checklist": [
                        {"text": item.text, "is_checked": item.is_checked}
                        for item in card.checklist_items.all()
                    ],
                    "comments": [
                        {
                            "body": comment.body,
                            "author": comment.author.username if comment.author else None,
                        }
                        for comment in card.comments.all()
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
                    "labels": ";".join(lbl.name for lbl in card.labels.order_by("name")),
                    "assignee": card.assignee.username if card.assignee else "",
                    "checklist_total": len(checklist),
                    "checklist_done": sum(1 for i in checklist if i.is_checked),
                    "comment_count": len(comments),
                    "description_preview": card.description[:80].replace("\n", " "),
                })
        self.stdout.write(f"  → {out}")
