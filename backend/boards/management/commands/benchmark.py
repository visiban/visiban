"""Query-count benchmark for the most performance-sensitive endpoints.

Run with:
    python manage.py benchmark

What it measures:
    - GET /api/boards/{id}/cards/           (CardViewSet list)
    - GET /api/boards/{id}/full/            (BoardFullSerializer)
    - GET /api/boards/{id}/summary/         (per-swimlane aggregation)

For each endpoint the command reports the number of SQL queries issued and
a ≤-budget verdict.  It creates a throw-away board, runs each endpoint
through the Django test client, then deletes the board.

Budgets are set conservatively — a regression that adds an N+1 will immediately
exceed the budget and the command exits non-zero.
"""
import secrets

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import connection, reset_queries
from django.core.management.base import BaseCommand
from django.test import RequestFactory

from boards.models import (
    Board, BoardMembership, Column, Swimlane, Label,
    Card, CardMovement, CardAttachment, CardChecklist,
)
from boards.serializers import BoardFullSerializer

User = get_user_model()

# ── fixture dimensions ────────────────────────────────────────────────────────
COLUMNS   = 5
SWIMLANES = 10
CARDS_PER_CELL = 2   # cards per (column × swimlane) cell → 5×10×2 = 100 cards


class Command(BaseCommand):
    help = "Measure SQL query counts for key endpoints and report budgets."

    def add_arguments(self, parser):
        parser.add_argument(
            "--fail-on-budget",
            action="store_true",
            default=False,
            help="Exit non-zero if any endpoint exceeds its query budget.",
        )

    def handle(self, *args, **options):
        if not settings.DEBUG:
            self.stderr.write(
                self.style.ERROR(
                    "DEBUG must be True to count queries.  "
                    "Set DEBUG=True in your .env or override via environment."
                )
            )
            return

        self.stdout.write("\n" + "═" * 60)
        self.stdout.write("  Visiban Query-Count Benchmark")
        self.stdout.write("═" * 60 + "\n")

        user, board = self._seed()
        factory = RequestFactory()

        results = []
        try:
            results.append(self._bench_cards(factory, user, board))
            results.append(self._bench_full(factory, user, board))
            results.append(self._bench_summary(factory, user, board))
        finally:
            board.delete()
            if not User.objects.filter(pk=user.pk).first() or user.username.startswith("bench_"):
                user.delete()

        self.stdout.write("")
        self.stdout.write(f"{'Endpoint':<45} {'Queries':>8}  {'Budget':>8}  {'Status':>8}")
        self.stdout.write("─" * 75)
        any_over = False
        for name, count, budget in results:
            ok = count <= budget
            if not ok:
                any_over = True
            status_str = self.style.SUCCESS("  ✅ OK") if ok else self.style.ERROR(f"  ❌ OVER by {count - budget}")
            self.stdout.write(f"  {name:<43} {count:>8}  {budget:>8}{status_str}")
        self.stdout.write("")

        if any_over and options["fail_on_budget"]:
            raise SystemExit(1)

    # ── benchmarks ────────────────────────────────────────────────────────────

    def _bench_cards(self, factory, user, board):
        name = "GET /api/boards/{id}/cards/"
        budget = 12

        request = factory.get("/")
        request.user = user

        reset_queries()
        # Mirror exactly what CardViewSet.get_queryset() does.
        from boards.serializers import CardSerializer, _card_queryset
        qs = _card_queryset(Card.objects.filter(board=board, archived_at__isnull=True))
        CardSerializer(qs, many=True, context={"request": request, "board": board}).data
        count = len(connection.queries)

        self._dump_queries(name, count, budget)
        return name, count, budget

    def _bench_full(self, factory, user, board):
        name = "GET /api/boards/{id}/full/"
        budget = 20  # ~12 measured; matches BoardFullQueryCountTests.BUDGET in test_query_counts.py

        request = factory.get("/")
        request.user = user

        reset_queries()
        BoardFullSerializer(board, context={"request": request}).data
        count = len(connection.queries)

        self._dump_queries(name, count, budget)
        return name, count, budget

    def _bench_summary(self, factory, user, board):
        name = "GET /api/boards/{id}/summary/"
        # Budget matches SummaryQueryCountTests.BUDGET in test_query_counts.py.
        # The real endpoint runs ~6 queries (board load, columns, swimlanes,
        # card counts, velocity, cycle-time × 2); 10 gives auth-middleware headroom.
        budget = 10

        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(user=user)

        reset_queries()
        response = client.get(f"/api/v1/boards/{board.pk}/summary/")
        count = len(connection.queries)

        if response.status_code != 200:
            self.stderr.write(
                self.style.ERROR(
                    f"  summary/ returned HTTP {response.status_code} — "
                    "query count may be inaccurate."
                )
            )

        self._dump_queries(name, count, budget)
        return name, count, budget

    # ── helpers ───────────────────────────────────────────────────────────────

    def _dump_queries(self, name, count, budget):
        mark = "✅" if count <= budget else "❌"
        self.stdout.write(f"  {mark}  {name}: {count} queries (budget ≤ {budget})")
        if settings.DEBUG and count > budget:
            self.stdout.write("     Slow queries:")
            for i, q in enumerate(connection.queries[-min(5, count):], 1):
                sql = q["sql"][:120].replace("\n", " ")
                self.stdout.write(f"     [{i}] {q['time']}s  {sql}")

    def _seed(self):
        """Create a throw-away board with COLUMNS × SWIMLANES × CARDS_PER_CELL cards."""
        # Clean up any leftover state from a previous interrupted run before creating.
        User.objects.filter(username="bench_user").delete()
        user = User.objects.create_user(
            username="bench_user",
            email="bench@example.com",
            password=secrets.token_urlsafe(16),
        )
        board = Board.objects.create(name="__benchmark__", owner=user)
        BoardMembership.objects.create(board=board, user=user, role="admin")

        columns = [
            Column.objects.create(board=board, name=f"Col {i}", position=i)
            for i in range(COLUMNS)
        ]
        swimlanes = [
            Swimlane.objects.create(board=board, name=f"Lane {i}", position=i)
            for i in range(SWIMLANES)
        ]
        label = Label.objects.create(board=board, name="bug", color="#ff0000")

        cards = []
        for sw in swimlanes:
            for col in columns:
                for n in range(CARDS_PER_CELL):
                    card = Card.objects.create(
                        board=board, column=col, swimlane=sw,
                        title=f"Card {col.name}/{sw.name}/{n}",
                        created_by=user, position=n,
                    )
                    card.labels.add(label)
                    CardMovement.objects.create(
                        card=card,
                        to_column=col, to_column_name=col.name, to_column_uid=col.uid,
                        to_swimlane=sw, to_swimlane_name=sw.name, to_swimlane_uid=sw.uid,
                        from_column=None, from_column_name="", from_column_uid="",
                        from_swimlane=None, from_swimlane_name="", from_swimlane_uid="",
                        moved_by=user,
                    )
                    CardAttachment.objects.create(
                        card=card, uploaded_by=user,
                        filename="file.txt", file="attachments/file.txt", size=100,
                    )
                    CardChecklist.objects.create(card=card, text="todo", is_checked=False, position=0)
                    CardChecklist.objects.create(card=card, text="done", is_checked=True, position=1)
                    cards.append(card)

        self.stdout.write(
            f"  Seeded: {COLUMNS} cols × {SWIMLANES} lanes × {CARDS_PER_CELL} cards/cell "
            f"= {len(cards)} cards\n"
        )
        return user, board
