"""Query-count benchmark for the most performance-sensitive endpoints.

Run with:
    python manage.py benchmark

What it measures:
    - GET /api/boards/{id}/cards/           (CardSerializer over ``_card_queryset``;
                                             a subset of the CardViewSet list, no viewset)
    - GET /api/boards/{id}/full/            (BoardFullSerializer)
    - GET /api/boards/{id}/summary/         (per-swimlane aggregation)
    - GET /api/boards/{id}/analytics/       (heatmap, stalled cards, blocked time)
    - GET /api/boards/{id}/metrics/*/       (the four flow metrics, #448)

For each endpoint the command reports the number of SQL queries issued and
a ≤-budget verdict.  It creates a throw-away board, drives full/ and summary/
through DRF's ``APIClient`` (cards/ serializes the queryset directly), then
deletes the board.

The summary, analytics and flow endpoints replay movement history, so the
fixture gives every card a real one: a creation row, then transitions, and for
some cards a completion and a reopen. A query count still cannot see the replay's
latency (that is nightly-load-test's job), but it does catch per-card queries
that only appear once a card has history.

Budgets are set conservatively — a regression that adds an N+1 will immediately
exceed the budget and the command exits non-zero (with ``--fail-on-budget``). CI runs it
that way in the ``backend-benchmark`` job (#1341).

A non-2xx response from any endpoint is always a hard failure (``CommandError``,
exit code 1) regardless of ``--fail-on-budget`` — a rejected request makes the
query count meaningless, so it must never be reported as "✅ OK" (#1330).
Running with DEBUG off is likewise a hard failure (#1341).
"""
import secrets

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import connection, reset_queries
from django.core.management.base import BaseCommand, CommandError
from django.test import RequestFactory, override_settings

from boards.models import (
    Board, BoardMembership, Column, Swimlane, Label,
    Card, CardMovement, CardAttachment, CardChecklist,
)

User = get_user_model()

# The Django/DRF test clients default to a "testserver" Host header. A
# restrictive ALLOWED_HOSTS (e.g. the dev container's "localhost,127.0.0.1")
# rejects that with a 400 DisallowedHost before any query runs. Scoping
# "testserver" onto ALLOWED_HOSTS just for the request each _bench_* helper
# issues avoids that 400 without reaching for
# django.test.utils.setup_test_environment(), which would also swap the
# email backend and template rendering for the whole process (#1330).
_BENCH_HOST = "testserver"

# ── fixture dimensions ────────────────────────────────────────────────────────
COLUMNS   = 5
SWIMLANES = 10
CARDS_PER_CELL = 2   # cards per (column × swimlane) cell → 5×10×2 = 100 cards


# Replay endpoints. Measured on Postgres (2026-11-03, #448) on this fixture, where
# no card has an assignee: 8, 4, 4, 4, 6. A board with assignees adds one query to
# the responses with a card directory. Budgets are that plus 4 for framework
# overhead. Whether the count stays flat as history grows is
# EndpointQueryCountTests' job (test_flow_metrics.py).
_HISTORY_ENDPOINTS = (
    ("GET /api/boards/{id}/analytics/", "analytics/", 12),
    ("GET /api/boards/{id}/metrics/cycle-time/", "metrics/cycle-time/", 9),
    ("GET /api/boards/{id}/metrics/throughput/", "metrics/throughput/", 9),
    ("GET /api/boards/{id}/metrics/cumulative-flow/", "metrics/cumulative-flow/", 8),
    ("GET /api/boards/{id}/metrics/wip-age/", "metrics/wip-age/", 11),
)


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
            # Hard-fail, never ``return``: a silent exit 0 here would let a CI
            # job with DEBUG unset report green without measuring anything
            # (#1341) -- the same false-pass class as #1330.
            raise CommandError(
                "DEBUG must be True to count queries.  "
                "Set DEBUG=True in your .env or override via environment."
            )

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
            for name, path, budget in _HISTORY_ENDPOINTS:
                results.append(self._bench_history_endpoint(user, board, name, path, budget))
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
        # NOTE: this serializes ``_card_queryset`` directly and never goes
        # through the viewset, so it measures LESS than
        # test_query_counts.py (CardListQueryCountTests.BUDGET = 14, which
        # drives the real endpoint on Postgres). Its budget of 12 is
        # intentionally different. It is a coarse smoke check, not a
        # duplicate guard.
        # Measured on Postgres 2026-10-14 (#1341): 9 queries.
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
        budget = 20  # 17 measured on Postgres (#1341); deliberately 1 looser than BoardFullQueryCountTests.BUDGET (19) in test_query_counts.py

        # Drive the endpoint through APIClient instead of constructing a raw
        # WSGIRequest and calling the serializer directly (#996).  The
        # serializer reads ``request.query_params`` via ``_expand_requested``,
        # which only exists on DRF's ``Request`` wrapper — calling it with a
        # bare WSGIRequest crashes with AttributeError before any query runs.
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(user=user)

        reset_queries()
        with override_settings(ALLOWED_HOSTS=[*settings.ALLOWED_HOSTS, _BENCH_HOST]):
            response = client.get(f"/api/v1/boards/{board.pk}/full/")
        count = len(connection.queries)

        if not (200 <= response.status_code < 300):
            # A non-2xx means the query count below is meaningless (often 0,
            # because the view rejected the request before touching the DB) —
            # hard-fail instead of reporting a false "✅ OK" (#1330).
            raise CommandError(
                f"{name} returned HTTP {response.status_code} (expected 2xx) — "
                f"query count is not meaningful. Body: {response.content[:500]!r}"
            )

        self._dump_queries(name, count, budget)
        return name, count, budget

    def _bench_summary(self, factory, user, board):
        name = "GET /api/boards/{id}/summary/"
        # Budget equals SummaryQueryCountTests.BUDGET (10) in test_query_counts.py.
        # The real endpoint runs ~6 queries (board load, columns, swimlanes,
        # card counts, velocity, cycle-time × 2); 10 gives auth-middleware headroom.
        budget = 10  # 4 measured on Postgres (#1341)

        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(user=user)

        reset_queries()
        with override_settings(ALLOWED_HOSTS=[*settings.ALLOWED_HOSTS, _BENCH_HOST]):
            response = client.get(f"/api/v1/boards/{board.pk}/summary/")
        count = len(connection.queries)

        if not (200 <= response.status_code < 300):
            # See _bench_full: a non-2xx makes the query count meaningless,
            # so this hard-fails rather than reporting a false "✅ OK" (#1330).
            raise CommandError(
                f"{name} returned HTTP {response.status_code} (expected 2xx) — "
                f"query count is not meaningful. Body: {response.content[:500]!r}"
            )

        self._dump_queries(name, count, budget)
        return name, count, budget

    def _bench_history_endpoint(self, user, board, name, path, budget):
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(user=user)

        reset_queries()
        with override_settings(ALLOWED_HOSTS=[*settings.ALLOWED_HOSTS, _BENCH_HOST]):
            response = client.get(f"/api/v1/boards/{board.pk}/{path}")
        count = len(connection.queries)

        if not (200 <= response.status_code < 300):
            # See _bench_full: a non-2xx makes the query count meaningless (#1330).
            raise CommandError(
                f"{name} returned HTTP {response.status_code} (expected 2xx) — "
                f"query count is not meaningful. Body: {response.content[:500]!r}"
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

        # The last column is a done column, so completions and cycle times exist.
        columns = [
            Column.objects.create(board=board, name=f"Col {i}", position=i, is_done=i == COLUMNS - 1)
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
                    self._seed_history(card, columns, col, sw, user, reopen=n == 1)
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

    def _seed_history(self, card, columns, current, swimlane, user, *, reopen):
        """Created in the first column, then walked to ``current``, through done if ``reopen``."""
        path = [columns[0], *columns[1:columns.index(current) + 1]]
        if reopen and not current.is_done and len(path) > 1:
            path = [columns[0], columns[-1], current]
        source = None
        for target in path:
            CardMovement.objects.create(
                card=card,
                to_column=target, to_column_name=target.name, to_column_uid=target.uid,
                to_swimlane=swimlane, to_swimlane_name=swimlane.name, to_swimlane_uid=swimlane.uid,
                from_column=source, from_column_name=source.name if source else "",
                from_column_uid=source.uid if source else "",
                from_swimlane=swimlane if source else None,
                from_swimlane_name=swimlane.name if source else "",
                from_swimlane_uid=swimlane.uid if source else "",
                moved_by=user,
            )
            source = target
