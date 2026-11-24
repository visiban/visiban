"""Query-count benchmark for the most performance-sensitive endpoints.

Run with:
    python manage.py benchmark

What it measures:
    - GET /api/boards/{id}/cards/           (CardSerializer over ``_card_queryset``;
                                             a subset of the CardViewSet list, no viewset)
    - GET /api/boards/{id}/full/            (BoardFullSerializer)
    - GET /api/boards/{id}/summary/         (per-swimlane aggregation)
    - GET /api/boards/{id}/analytics/       (heatmap, stalled cards, blocked time)
    - GET /api/boards/{id}/metrics/*/       (the eight flow metrics, #448, #2260, #2266)

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
import json
import secrets
import statistics
import time

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import connection, reset_queries
from django.core.management.base import BaseCommand, CommandError
from django.test import RequestFactory, override_settings

from ._load_test_fixtures import seed_linked_boards
from boards.models import (
    Board, BoardMembership, Column, Swimlane, Label,
    Card, CardMovement, CardAttachment, CardChecklist,
    SwimlaneCustomFieldDefinition, SwimlaneCustomFieldValue,
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

# Budgets shared with boards/tests/test_query_counts.py, which asserts it still
# holds the same numbers (#1886). They are the measured count plus headroom for
# middleware, not two separate judgments: when they disagreed (cards 12 vs 14,
# full 20 vs 19) a regression could pass one guard and fail the other.
CARD_LIST_BUDGET = 14  # 9 measured here on Postgres (#1341)
# The main fixture has no card parent links, so FULL_BUDGET describes the
# no-link case; the with-links case costs 2 more queries and is pinned by
# CardParentQueryCountTests. The linked fixture (#2424) has its own budgets below.
FULL_BUDGET = 23  # +1 #2570 custom_field_sets prefetch; 17 measured on Postgres (#1341); +1 #1104 card-parent link lookup; +1 #2211 swimlanes__team_members; +1 #2446 leftover-parent ids lookup on a flag-off board
# #2424: the 500-card child board, every card linked to a parent on one of 5 parent
# boards. Kept apart from the no-link budgets above so those, and the flat
# query-count tests they are shared with, are untouched. Both are driven through
# the endpoint, so the card list count is not comparable with CARD_LIST_BUDGET
# (which serializes the queryset directly).
FULL_LINKED_BUDGET = 25  # 22 measured on Postgres (2026-11-20, #2424): 20 + the 2 role-batch queries; 23 on 2026-11-21 after #2211's +1; 24 on 2026-11-22 after #2443's sibling count; +1 headroom
CARD_LIST_LINKED_BUDGET = 18  # 16 measured on Postgres (2026-11-20, #2424); 17 on 2026-11-22 after #2443's sibling count; +1 headroom
# #2210: the parent-tier board of that fixture (5 parent cards, each with 20 children),
# whose reads also resolve ``children_rollup`` (``card_links.rollups_for_viewer``).
FULL_ROLLUP_BUDGET = 27  # 25 measured on Postgres (2026-11-21, #2210): the linked board's 23 + 2 rollup queries; +2 headroom
CARD_LIST_ROLLUP_BUDGET = 19  # 17 measured on Postgres (2026-11-21, #2210); +2 headroom
SUMMARY_BUDGET = 10  # 4 measured on Postgres (#1341)

# ── fixture dimensions ────────────────────────────────────────────────────────
COLUMNS   = 5
SWIMLANES = 10
CARDS_PER_CELL = 2   # cards per (column × swimlane) cell → 5×10×2 = 100 cards


# Replay endpoints. Measured on Postgres (2026-11-03, #448) on this fixture, where
# no card has an assignee: 8, 4, 4, 4, 6. A board with assignees adds one query to
# the responses with a card directory. Budgets are that plus 4 for framework
# overhead. dwell, blocked and attention (#2260) were counted with
# EndpointQueryCountTests on its seeded board (4, 6, 6; attention includes the
# assignee directory query), not on Postgres. swimlanes (#2266) was counted the same way: 6 plain, 8 grouped by a swimlane field (budget covers the plain request). Whether the count stays flat as history grows is
# EndpointQueryCountTests' job (test_flow_metrics.py).
_HISTORY_ENDPOINTS = (
    ("GET /api/boards/{id}/analytics/", "analytics/", 12),
    ("GET /api/boards/{id}/metrics/cycle-time/", "metrics/cycle-time/", 9),
    ("GET /api/boards/{id}/metrics/throughput/", "metrics/throughput/", 9),
    ("GET /api/boards/{id}/metrics/cumulative-flow/", "metrics/cumulative-flow/", 8),
    ("GET /api/boards/{id}/metrics/wip-age/", "metrics/wip-age/", 11),
    ("GET /api/boards/{id}/metrics/dwell/", "metrics/dwell/", 8),
    ("GET /api/boards/{id}/metrics/blocked/", "metrics/blocked/", 10),
    ("GET /api/boards/{id}/metrics/attention/", "metrics/attention/", 10),
    ("GET /api/boards/{id}/metrics/swimlanes/", "metrics/swimlanes/", 10),
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
        parser.add_argument(
            "--swimlane-fields",
            type=int,
            default=0,
            metavar="N",
            help=(
                "Seed N swimlane field definitions (cycling the seven types) and a value "
                "for every field on every lane (#2438). Runs cards, full and summary only, "
                "and reports the /full/ payload size and p50/p95 latency."
            ),
        )
        parser.add_argument(
            "--swimlanes",
            type=int,
            default=SWIMLANES,
            metavar="N",
            help="Number of swimlanes to seed (default %(default)s; 100 is the import ceiling).",
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

        field_count = options["swimlane_fields"]
        if field_count < 0 or field_count > SwimlaneCustomFieldDefinition.MAX_PER_BOARD:
            raise CommandError(
                f"--swimlane-fields must be 0..{SwimlaneCustomFieldDefinition.MAX_PER_BOARD}."
            )
        user, board = self._seed(options["swimlanes"], field_count)
        factory = RequestFactory()

        results = []
        linked_boards = []
        try:
            results.append(self._bench_cards(factory, user, board))
            results.append(self._bench_full(factory, user, board))
            results.append(self._bench_summary(factory, user, board))
            if field_count:
                self._bench_full_latency(user, board, field_count)
            else:
                linked_board, parent_boards, _ = seed_linked_boards(user, self._create_columns)
                linked_boards = [linked_board, *parent_boards]
                results.append(self._bench_history_endpoint(
                    user, linked_board, "GET /api/boards/{id}/full/ (linked)", "full/", FULL_LINKED_BUDGET,
                ))
                results.append(self._bench_history_endpoint(
                    user, linked_board, "GET /api/boards/{id}/cards/ (linked)", "cards/",
                    CARD_LIST_LINKED_BUDGET,
                ))
                results.append(self._bench_history_endpoint(
                    user, parent_boards[0], "GET /api/boards/{id}/full/ (rollup)", "full/",
                    FULL_ROLLUP_BUDGET,
                ))
                results.append(self._bench_history_endpoint(
                    user, parent_boards[0], "GET /api/boards/{id}/cards/ (rollup)", "cards/",
                    CARD_LIST_ROLLUP_BUDGET,
                ))
                for name, path, budget in _HISTORY_ENDPOINTS:
                    results.append(self._bench_history_endpoint(user, board, name, path, budget))
        finally:
            # No announce_cards_removal: the board and its cards are this
            # command's own throwaway fixture, never linked to another card.
            board.delete()
            # By identity, never by name: a real load-test fixture in this database
            # uses the same board names.
            for fixture_board in linked_boards:
                fixture_board.delete()
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
        # through the viewset, so it measures LESS than the endpoint-driven
        # CardListQueryCountTests (9 here on Postgres, 2026-10-14, #1341). It
        # still shares that test's budget, so the two cannot disagree (#1886):
        # a coarse smoke check with the same ceiling, not a tighter one.
        budget = CARD_LIST_BUDGET

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
        budget = FULL_BUDGET  # same value as BoardFullQueryCountTests.BUDGET (#1886)

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

    def _bench_full_latency(self, user, board, field_count, runs=20):
        """Payload bytes and p50/p95 of GET /full/ over ``runs`` warm requests (#2438).

        The first request (counted above) warms connections; these are the
        steady-state numbers. The query count is re-read per run so a count that
        grows with the data would show here too.
        """
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(user=user)
        times, counts, size = [], set(), 0
        with override_settings(ALLOWED_HOSTS=[*settings.ALLOWED_HOSTS, _BENCH_HOST]):
            for _ in range(runs):
                reset_queries()
                t0 = time.perf_counter()
                response = client.get(f"/api/v1/boards/{board.pk}/full/")
                times.append((time.perf_counter() - t0) * 1000)
                counts.add(len(connection.queries))
                size = len(response.content)
        times.sort()
        p95 = times[min(len(times) - 1, int(round(0.95 * len(times))) - 1)]
        self.stdout.write(
            f"  full/ with {field_count} swimlane fields: {size} bytes, "
            f"p50 {statistics.median(times):.1f} ms, p95 {p95:.1f} ms over {runs} runs, "
            f"queries per run {sorted(counts)}"
        )

    def _bench_summary(self, factory, user, board):
        name = "GET /api/boards/{id}/summary/"
        # Equals SummaryQueryCountTests.BUDGET in test_query_counts.py (asserted
        # there). The real endpoint runs ~6 queries (board load, columns,
        # swimlanes, card counts, velocity, cycle-time x 2); the budget leaves
        # auth-middleware headroom.
        budget = SUMMARY_BUDGET

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

    def _seed_swimlane_fields(self, board, swimlanes, field_count):
        """``field_count`` swimlane field definitions, every one valued on every lane (#2438).

        Cycles the seven types so the payload carries realistic value shapes; the
        tiers stay NULL (a legacy board), which the /full/ query count does not read.
        """
        shapes = [
            ("text", [], "Acme Corp"),
            ("number", [], "125000"),
            ("date", [], "2026-06-30"),
            ("dropdown", ["Gold", "Silver"], "Gold"),
            ("checkbox", [], "true"),
            ("url", [], "https://example.com/accounts/1234"),
            ("multi_select", ["EMEA", "APAC", "AMER"], json.dumps(["EMEA", "APAC"])),
        ]
        definitions = []
        for i in range(field_count):
            field_type, choices, _ = shapes[i % len(shapes)]
            definitions.append(SwimlaneCustomFieldDefinition.objects.create(
                board=board, name=f"Field {i}", field_type=field_type, position=i,
                choices_json=choices,
            ))
        SwimlaneCustomFieldValue.objects.bulk_create([
            SwimlaneCustomFieldValue(swimlane=sw, field_definition=d, value=shapes[i % len(shapes)][2])
            for sw in swimlanes
            for i, d in enumerate(definitions)
        ])

    @staticmethod
    def _create_columns(board):
        return [
            Column.objects.create(board=board, name=f"Col {i}", position=i, is_done=i == COLUMNS - 1)
            for i in range(COLUMNS)
        ]

    def _seed(self, swimlane_count=SWIMLANES, field_count=0):
        """Create a throw-away board with COLUMNS × swimlanes × CARDS_PER_CELL cards."""
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
            for i in range(swimlane_count)
        ]
        if field_count:
            self._seed_swimlane_fields(board, swimlanes, field_count)
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
            f"  Seeded: {COLUMNS} cols × {swimlane_count} lanes × {CARDS_PER_CELL} cards/cell "
            f"= {len(cards)} cards, {field_count} swimlane fields\n"
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
