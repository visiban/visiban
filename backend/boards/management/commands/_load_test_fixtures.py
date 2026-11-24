"""Load-test fixture builders that sit beside ``seed_demo_data`` (#2430, #2424).

Two shapes the nightly load test could not see before:

* an **aged** board (#2430): the same active cards plus years of archived
  history. Analytics breaks on board *age*, not on the nightly fixture's shape
  (2026-11-20 stress run: the same 2.4k active cards cost 8-10x more per
  ``metrics/*`` request with three years of archived cards behind them);
* a **linked** child board (#2424): cards that each have a parent on one of
  several parent boards, so ``Card.parent``'s role batch runs.

Both belong to a dedicated user (``LOAD_TEST_ANALYTICS_USERNAME``) and to
boards only that user can open. The committed p95 budgets for the existing
scenarios were derived without these boards, and ``card_search`` as ``demo2``
or ``demo3`` filters on the viewer's accessible board ids, so giving either of
them access would change a gated plan. Keeping the fixtures on their own
account means what viewers can see is unchanged. Row counts still grow
(``cards`` from about 4k to about 16.5k, movements about 5x, when the aged
fixture is on; about 67.5k with the linked and children-view fixtures, #2538), which can shift query plans and timings for the existing gated
scenarios, so their budgets may move: expected, not proven (#1810 did the same
to the cards table).

The isolation guarantee is about board ACCESS (memberships and ownership), not
authorship: ``seed_demo_data._create_cards`` still makes demo1-5 the assignees
and creators of the aged board's cards, and archived copies inherit
``assignee_id``. No scenario filters by assignee or author; the test suite pins
this so a change is deliberate.

Known limits of the aged copy: movements are copied but block history
(``CardBlock``, read by ``metrics/blocked/``) is not, and ``blocked_at`` /
``due_date`` on copies are not shifted, so ``aged_flow_blocked`` is not an
aged-history measurement.
"""

import datetime

from django.contrib.auth import get_user_model
from django.db import transaction

from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardGateTransition,
    CardMovement,
    CardParentLink,
    SubColumn,
    Swimlane,
)
from boards.services.card_links import CHILDREN_PER_PARENT_LIMIT, link_allowed

LOAD_TEST_ANALYTICS_USERNAME = "loadtest_analytics"
LOAD_TEST_AGED_BOARD_NAME = "Visiban Load Test Aged Board"
LOAD_TEST_LINKED_BOARD_NAME = "Visiban Load Test Linked Board"
LOAD_TEST_PARENT_BOARD_PREFIX = "Visiban Load Test Parent Board"
#: #2538: the parent-tier board Children mode reads, and its child board.
LOAD_TEST_CHILDREN_VIEW_BOARD_NAME = "Visiban Load Test Children View Board"
LOAD_TEST_CHILDREN_VIEW_CHILD_BOARD_NAME = "Visiban Load Test Children View Child Board"

#: Gap between archived generations. A generation is the board's active cards
#: copied back in time, so N generations at this spacing is a board that has
#: run roughly N quarters at the same throughput (the #2430 stress-run method).
GENERATION_SPACING_DAYS = 90

#: #2424 / the #1104 threat model's perf-bench case: a 500-card child board,
#: every card linked to a parent on one of 5 parent boards.
LINKED_CHILD_CARDS = 500
LINKED_PARENT_BOARDS = 5
LINKED_PARENTS_PER_BOARD = 5

#: #2538: ``children-view`` recomputes every live parent link on the board per page, so its
#: cost is parents x children. At least 500 parents with about 100 children each (the per-parent
#: cap), spread over 5 lanes. Module constants so a test can shrink them; the command reads
#: them at call time.
CHILDREN_VIEW_PARENTS = 500
CHILDREN_VIEW_CHILDREN_PER_PARENT = CHILDREN_PER_PARENT_LIMIT
CHILDREN_VIEW_LANES = 5

#: #2405: the gated stage on the load-test board. Three sub-columns make two gates.
GATE_STAGE_COLUMN_INDEX = 2  # "Doing"
GATE_SUB_COLUMN_NAMES = ("Build", "Test", "Ready")

_BULK_BATCH = 2000


def ensure_analytics_user():
    """The dedicated owner of the aged and linked fixture boards (unusable password)."""
    user, created = get_user_model().objects.get_or_create(
        username=LOAD_TEST_ANALYTICS_USERNAME,
        defaults={
            "email": f"{LOAD_TEST_ANALYTICS_USERNAME}@visiban.example",
            "first_name": "Load",
            "last_name": "Analytics",
        },
    )
    if created:
        user.set_unusable_password()
        user.save()
    return user


def copy_archived_generations(board, generations, anchor, spacing_days=GENERATION_SPACING_DAYS):
    """Copy ``board``'s active cards back in time as archived generations.

    Generation ``g`` (1..N) is every active card copied with its movements
    shifted ``g * spacing_days`` earlier and ``archived_at`` set to that same
    point, so the board ends up with N quarters of archived work behind the
    live cards. Bulk-written: the movement rows are the volume (about 10 per
    card), and ``CardMovement.save`` is append-only guard code that a bulk
    insert deliberately bypasses.

    ``auto_now_add`` / ``auto_now`` overwrite timestamps on insert, so the
    shifted values are written back with ``bulk_update`` afterwards (which does
    not call ``pre_save``). Returns ``(cards_created, movements_created)``.
    """
    if generations < 1:
        return 0, 0
    sources = list(Card.objects.filter(board=board, archived_at__isnull=True).order_by("id"))
    movements_by_card = {}
    for mv in CardMovement.objects.filter(card__in=sources).order_by("id"):
        movements_by_card.setdefault(mv.card_id, []).append(mv)

    card_fields = [
        f for f in Card._meta.concrete_fields
        if not f.primary_key and f.name not in ("uid", "archived_at")
    ]
    movement_fields = [
        f for f in CardMovement._meta.concrete_fields if not f.primary_key and f.name != "card"
    ]
    total_cards = total_movements = 0
    for gen in range(1, generations + 1):
        shift = datetime.timedelta(days=spacing_days * gen)
        archived_at = anchor - shift
        copies = []
        for src in sources:
            data = {f.attname: getattr(src, f.attname) for f in card_fields}
            data["created_at"] = src.created_at - shift
            data["updated_at"] = src.updated_at - shift
            data["archived_at"] = archived_at
            copies.append(Card(**data))
        with transaction.atomic():
            Card.objects.bulk_create(copies, batch_size=_BULK_BATCH)
            # bulk_create ran pre_save, which overwrote the shifted values on the instances
            # with "now"; restore them or the bulk_update below writes "now" straight back.
            for src, copy in zip(sources, copies):
                copy.created_at = src.created_at - shift
                copy.updated_at = src.updated_at - shift
            Card.objects.bulk_update(copies, ["created_at", "updated_at"], batch_size=_BULK_BATCH)
            moves, shifted = [], []
            for src, copy in zip(sources, copies):
                for mv in movements_by_card.get(src.id, ()):
                    mdata = {f.attname: getattr(mv, f.attname) for f in movement_fields}
                    mdata["card_id"] = copy.pk
                    # The copy has its own uid; this is the snapshot a deleted card's history reads.
                    mdata["card_uid"] = copy.uid
                    moves.append(CardMovement(**mdata))
                    shifted.append(mv.moved_at - shift)
            CardMovement.objects.bulk_create(moves, batch_size=_BULK_BATCH)
            # moved_at is auto_now_add, so the insert stamped "now"; write the shifted value back.
            for mv, moved_at in zip(moves, shifted):
                mv.moved_at = moved_at
            CardMovement.objects.bulk_update(moves, ["moved_at"], batch_size=_BULK_BATCH)
        total_cards += len(copies)
        total_movements += len(moves)
    return total_cards, total_movements


def seed_linked_boards(owner, create_columns):
    """Create the #2424 fixture: a 500-card child board linked across 5 parent boards.

    ``create_columns`` is the command's column factory, so these boards share the
    demo board's column shape. Links are written in bulk but only between boards
    that satisfy the two-tier rule (``link_allowed``), the same predicate
    ``card_links.create_link`` enforces, and no parent exceeds
    ``CHILDREN_PER_PARENT_LIMIT`` children (500 / 25 parents = 20 each).
    Returns ``(child_board, parent_boards, link_count)``; a caller that cleans up
    deletes those boards by identity, never by name, which a real fixture may share.
    """
    parent_cards = []
    parent_boards = []
    for i in range(1, LINKED_PARENT_BOARDS + 1):
        pboard = Board.objects.create(
            name=f"{LOAD_TEST_PARENT_BOARD_PREFIX} {i}",
            description="Parent-tier board for the linked-board load-test fixture (#2424).",
            owner=owner,
            staleness_threshold_days=7,
            cards_can_have_children=True,
        )
        BoardMembership.objects.create(board=pboard, user=owner, role=BoardMembership.Role.ADMIN)
        cols = create_columns(pboard)
        lane = Swimlane.objects.create(board=pboard, name="Parents", position=0)
        parent_boards.append(pboard)
        for pos in range(LINKED_PARENTS_PER_BOARD):
            parent_cards.append(Card.objects.create(
                board=pboard, column=cols[0], swimlane=lane,
                title=f"Parent {i}.{pos + 1}", position=pos, created_by=owner,
            ))

    child_board = Board.objects.create(
        name=LOAD_TEST_LINKED_BOARD_NAME,
        description="Child-tier board with every card linked to a parent (#2424). Not for demos.",
        owner=owner,
        staleness_threshold_days=7,
        cards_can_have_children=False,
    )
    BoardMembership.objects.create(board=child_board, user=owner, role=BoardMembership.Role.ADMIN)
    cols = create_columns(child_board)
    lane = Swimlane.objects.create(board=child_board, name="Linked", position=0)
    children = Card.objects.bulk_create([
        Card(board=child_board, column=cols[i % len(cols)], swimlane=lane,
             title=f"Child {i + 1}", position=i, created_by=owner)
        for i in range(LINKED_CHILD_CARDS)
    ])

    per_parent = LINKED_CHILD_CARDS // len(parent_cards)
    assert per_parent <= CHILDREN_PER_PARENT_LIMIT
    assert all(link_allowed(pb, child_board) for pb in parent_boards)
    # Interleave so consecutive children land on different parent boards.
    links = [
        CardParentLink(parent=parent_cards[i % len(parent_cards)], child=child, created_by=owner)
        for i, child in enumerate(children)
    ]
    CardParentLink.objects.bulk_create(links, batch_size=_BULK_BATCH)
    return child_board, parent_boards, len(links)


def seed_children_view_boards(owner, create_columns):
    """Create the #2538 fixture: a parent board with many parents, each with ~100 children.

    ``GET boards/{id}/children-view/`` reads the parent-tier board and recomputes every live
    link on it per page with correlated subqueries, so a board with 500 parents and about
    50,000 links is the shape where its cost shows. One child board holds every child, spread
    over the demo column shape so the rollup partition (done / doing / to do) has all states.
    Returns ``(parent_board, child_board, link_count)``. Both boards are owned by ``owner`` alone,
    like the other fixtures (see the module docstring).
    """
    parents_n = CHILDREN_VIEW_PARENTS
    per_parent = CHILDREN_VIEW_CHILDREN_PER_PARENT
    assert per_parent <= CHILDREN_PER_PARENT_LIMIT
    parent_board = Board.objects.create(
        name=LOAD_TEST_CHILDREN_VIEW_BOARD_NAME,
        description="Parent-tier board for the children-view load-test fixture (#2538). Not for demos.",
        owner=owner,
        staleness_threshold_days=7,
        cards_can_have_children=True,
    )
    BoardMembership.objects.create(board=parent_board, user=owner, role=BoardMembership.Role.ADMIN)
    pcols = create_columns(parent_board)
    lanes = [
        Swimlane.objects.create(board=parent_board, name=f"Lane {i + 1}", position=i)
        for i in range(CHILDREN_VIEW_LANES)
    ]
    parents = Card.objects.bulk_create([
        Card(board=parent_board, column=pcols[0], swimlane=lanes[i % len(lanes)],
             title=f"Parent {i + 1}", position=i, created_by=owner)
        for i in range(parents_n)
    ])

    child_board = Board.objects.create(
        name=LOAD_TEST_CHILDREN_VIEW_CHILD_BOARD_NAME,
        description="Child-tier board for the children-view load-test fixture (#2538). Not for demos.",
        owner=owner,
        staleness_threshold_days=7,
        cards_can_have_children=False,
    )
    BoardMembership.objects.create(board=child_board, user=owner, role=BoardMembership.Role.ADMIN)
    ccols = create_columns(child_board)
    lane = Swimlane.objects.create(board=child_board, name="Children", position=0)
    assert link_allowed(parent_board, child_board)
    total = 0
    for start in range(0, parents_n, 20):  # 20 parents (2,000 children) per batch
        batch = parents[start:start + 20]
        children = Card.objects.bulk_create([
            Card(board=child_board, column=ccols[(total + j) % len(ccols)], swimlane=lane,
                 title=f"Child {total + j + 1}", position=total + j, created_by=owner)
            for j in range(len(batch) * per_parent)
        ])
        CardParentLink.objects.bulk_create([
            CardParentLink(parent=batch[j // per_parent], child=child, created_by=owner)
            for j, child in enumerate(children)
        ], batch_size=_BULK_BATCH)
        total += len(children)
    return parent_board, child_board, total


def seed_gate_rows(board, columns):
    """Give the load-test board a gated stage with gate transitions (#2405).

    ``card_timeline`` reads a third source, ``CardGateTransition`` rows (#2365), and the
    seed had no sub-columns, so the budget measured no gate work. The "Doing" stage gets
    three sub-columns (two gates) and every active card in it a ``gates_passed`` of 0, 1 or 2
    in rotation. Each gate a card passed is a ``pass`` row; the first is linked to the card's
    move into the stage, when it has one, and the rest are not (the two shapes the timeline
    merges differently). Some two-gate cards are then reopened one gate. Deterministic (no
    ``random``), so the main fixture's seeded stream and every committed budget derived from
    it are unchanged. Bulk-written: ``CardGateTransition.save`` is the append-only guard.
    Returns ``(gate_rows, cards_with_gates)``.
    """
    stage = columns[GATE_STAGE_COLUMN_INDEX]
    subs = [
        SubColumn.objects.create(column=stage, position=i, name=name)
        for i, name in enumerate(GATE_SUB_COLUMN_NAMES)
    ]
    cards = list(Card.objects.filter(board=board, column=stage, archived_at__isnull=True).order_by("id"))
    entered = {}
    for mv in CardMovement.objects.filter(card__in=cards, to_column=stage).order_by("id"):
        entered[mv.card_id] = mv  # the latest move into the stage wins
    now = datetime.datetime.now(datetime.timezone.utc)
    rows = []
    for i, card in enumerate(cards):
        passed = i % 3
        reopened = passed == 2 and (i // 3) % 2 == 0
        mv = entered.get(card.id)
        base = mv.moved_at if mv else now - datetime.timedelta(days=1)

        def row(kind, frm, to, sub, minutes, movement=None):
            return CardGateTransition(
                card=card, board=board, card_uid=card.uid, card_title=card.title,
                column=stage, column_name=stage.name, column_uid=stage.uid,
                sub_column_name=sub.name, sub_column_uid=sub.uid,
                kind=kind, from_index=frm, to_index=to, movement=movement,
                created_at=base + datetime.timedelta(minutes=minutes),
            )

        for gate in range(1, passed + 1):
            rows.append(row(CardGateTransition.Kind.PASS, gate - 1, gate, subs[gate],
                            gate * 10, mv if gate == 1 else None))
        if reopened:
            rows.append(row(CardGateTransition.Kind.REOPEN, 2, 1, subs[1], 40))
            passed = 1
        card.gates_passed = passed
    Card.objects.bulk_update(cards, ["gates_passed"], batch_size=_BULK_BATCH)
    CardGateTransition.objects.bulk_create(rows, batch_size=_BULK_BATCH)
    return len(rows), sum(1 for c in cards if c.gates_passed)
