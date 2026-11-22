"""The parent side of card links: ``Card.children_rollup`` and its pings (#2210, #2416).

The rollup is computed per viewer over REST and never broadcast (threat model
2026-11-14, risk 1). Child-side writes ping the parent's board with an
ids-only ``card.children_changed {parent_id}``; a parent container rename
pings each child board once with a bounded ``card.parent_changed`` (#2416).
"""

import json
from datetime import timedelta
from unittest import mock

from django.db import connection, transaction
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from boards.models import BoardEvent, BoardMembership, CardMovement, CardParentLink, CardRelation
from boards.serializers import PublicBoardSerializer
from boards.services import card_links
from boards.tests.conftest import _make_card, _make_column, _make_swimlane, _make_user
from boards.tests.test_card_parent_links import Role, _board_with_card, _LinkFixture

VISIBLE_KEYS = {"visible", "total", "done", "doing", "todo", "blocked", "last_moved_at"}


class _RollupFixture(_LinkFixture):
    """Parent board P with one parent; child board C with five children, one per state."""

    def _setup_rollup(self):
        self._setup_boards()
        c = self.cboard
        self.col_doing = _make_column(c, name="Doing", order=5)
        self.col_done = _make_column(c, name="Done", order=9, is_done=True)
        lane = self.lane_c
        self.todo = self.child  # first column
        self.doing = _make_card(self.col_doing, lane, title="doing SECRET-C")
        self.done = _make_card(self.col_done, lane, title="done SECRET-C")
        self.manual = _make_card(self.col_doing, lane, title="manual SECRET-C", blocked_at=timezone.now())
        self.by_rel = _make_card(self.col_done, lane, title="rel SECRET-C")
        blocker = _make_card(self.col_c, lane, title="blocker")
        CardRelation.objects.create(
            from_card=blocker, to_card=self.by_rel, relation_type=CardRelation.Type.BLOCKS, created_by=self.owner,
        )
        self.archived = _make_card(self.col_done, lane, title="gone", archived_at=timezone.now())
        for child in (self.todo, self.doing, self.done, self.manual, self.by_rel, self.archived):
            CardParentLink.objects.create(parent=self.parent, child=child, created_by=self.owner)
        self.lonely = _make_card(self.parent.column, self.parent.swimlane, title="no kids")

    def _cards(self, user, board=None):
        res = self._client(user).get(f"/api/v1/boards/{(board or self.pboard).pk}/full/")
        self.assertEqual(res.status_code, 200, res.content)
        return {c["id"]: c for c in res.json()["cards"]}


class RollupReadTests(_RollupFixture, TestCase):
    def setUp(self):
        self._setup_rollup()

    def test_visible_rollup_partitions_the_live_children(self):
        moved = timezone.now() - timedelta(days=2)
        CardMovement.objects.filter(card=self.doing).update(moved_at=moved)
        viewer = self._user("ru_vis", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        r = self._cards(viewer)[self.parent.pk]["children_rollup"]
        self.assertEqual(set(r), VISIBLE_KEYS)
        self.assertEqual(
            {k: r[k] for k in VISIBLE_KEYS - {"last_moved_at"}},
            # Blocked overrides the column (manual and relation); archived is out.
            {"visible": True, "total": 5, "done": 1, "doing": 1, "todo": 1, "blocked": 2},
        )

    def test_last_moved_at_is_the_latest_child_move(self):
        when = timezone.now() - timedelta(days=1)
        for card, at in ((self.todo, when - timedelta(days=3)), (self.doing, when), (self.archived, timezone.now())):
            m = CardMovement.objects.create(
                card=card, board=self.cboard, to_column=card.column, moved_by=self.owner,
            )
            # moved_at is set on insert; date it afterwards. The archived
            # child's later move must not count.
            CardMovement.objects.filter(pk=m.pk).update(moved_at=at)
        r = self._cards(self.owner)[self.parent.pk]["children_rollup"]
        self.assertEqual(r["last_moved_at"], when.isoformat().replace("+00:00", "Z"))

    def test_a_parent_with_no_children_reads_the_zero_rollup(self):
        r = self._cards(self.owner)[self.lonely.pk]["children_rollup"]
        self.assertEqual(r, {
            "visible": True, "total": 0, "done": 0, "doing": 0, "todo": 0, "blocked": 0, "last_moved_at": None,
        })

    def test_hidden_child_board_is_the_count_only(self):
        outsider = self._user("ru_hid", parent_role=Role.MEMBER)
        cards = self._cards(outsider)
        self.assertEqual(cards[self.parent.pk]["children_rollup"], {"visible": False, "total": 5})
        self.assertNotIn("SECRET-C", json.dumps(cards))

    def test_children_on_two_boards_report_only_the_first_links_board(self):
        """One parent, children on a viewable and an unviewable board (#2210).

        The rollup reads only the board of the parent's first link, so a later
        link on a board the viewer cannot open adds nothing at all: no count,
        no state, no title. The viewer sees the first board's states.
        """
        d_owner = _make_user("ru_d_owner")
        dboard, d_child = _board_with_card(d_owner, parent_tier=False, name="Hidden", title="Task SECRET-D")
        CardParentLink.objects.create(parent=self.parent, child=d_child, created_by=self.owner)
        viewer = self._user("ru_two", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        cards = self._cards(viewer)
        r = cards[self.parent.pk]["children_rollup"]
        self.assertEqual(
            {k: r[k] for k in VISIBLE_KEYS - {"last_moved_at"}},
            {"visible": True, "total": 5, "done": 1, "doing": 1, "todo": 1, "blocked": 2},
        )
        self.assertNotIn("SECRET-D", json.dumps(cards))

    def test_first_link_on_an_unviewable_board_is_the_count_only_whatever_the_second_board(self):
        """The mirror: the first-linked board is the hidden one, a later one is viewable."""
        d_owner = _make_user("ru_d2_owner")
        dboard, d_child = _board_with_card(d_owner, parent_tier=False, name="Hidden2", title="Task SECRET-D")
        parent = _make_card(self.parent.column, self.parent.swimlane, title="two-board parent")
        CardParentLink.objects.create(parent=parent, child=d_child, created_by=self.owner)
        visible_child = _make_card(self.col_doing, self.lane_c, title="visible child")
        CardParentLink.objects.create(parent=parent, child=visible_child, created_by=self.owner)
        viewer = self._user("ru_two_b", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        cards = self._cards(viewer)
        self.assertEqual(cards[parent.pk]["children_rollup"], {"visible": False, "total": 1})
        self.assertNotIn("SECRET-D", json.dumps(cards))

    def test_losing_the_child_board_hides_states_on_the_next_read(self):
        viewer = self._user("ru_lose", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        self.assertTrue(self._cards(viewer)[self.parent.pk]["children_rollup"]["visible"])
        BoardMembership.objects.filter(user=viewer, board=self.cboard).delete()
        self.assertFalse(self._cards(viewer)[self.parent.pk]["children_rollup"]["visible"])

    def test_absent_viewer_fails_closed(self):
        # #1075: no viewer, or an anonymous one, never sees a child's state.
        from django.contrib.auth.models import AnonymousUser

        for user in (None, AnonymousUser()):
            self.assertEqual(
                card_links.rollups_for_viewer([self.parent.pk], user)[self.parent.pk],
                {"visible": False, "total": 5},
            )
        self.assertEqual(card_links.rollups_for_viewer([], self.owner), {})

    def test_absent_context_omits_the_field(self):
        from boards.serializers import CardSerializer

        self.assertNotIn("children_rollup", CardSerializer(self.parent).data)

    def test_present_on_list_and_retrieve(self):
        base = f"/api/v1/boards/{self.pboard.pk}/cards/"
        c = self._client(self.owner)
        rows = {r["id"]: r for r in c.get(base).json()}
        self.assertEqual(rows[self.parent.pk]["children_rollup"]["total"], 5)
        self.assertEqual(c.get(f"{base}{self.parent.pk}/").json()["children_rollup"]["total"], 5)

    def test_absent_on_child_tier_boards_writes_and_share_links(self):
        self.assertNotIn("children_rollup", self._cards(self.owner, self.cboard)[self.child.pk])
        res = self._client(self.owner).patch(
            f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/", {"description": "x"}, format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertNotIn("children_rollup", res.json())
        # PublicBoardSerializer gets no rollup (threat model: its blocker_count
        # is justified as same-board only, which a rollup is not).
        public = PublicBoardSerializer(self.pboard).data
        self.assertNotIn("children_rollup", json.dumps(public))

    def test_full_query_count_does_not_grow_with_parents(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self._cards(self.owner)
            return len(ctx.captured_queries)

        before = count()
        for i in range(4):
            extra = _make_card(self.parent.column, self.parent.swimlane, title=f"p{i}")
            for _ in range(3):
                kid = _make_card(self.col_doing, self.lane_c, title="k")
                CardParentLink.objects.create(parent=extra, child=kid, created_by=self.owner)
        self.assertEqual(count(), before)

    def test_rollup_reads_cost_fixed_queries(self):
        with self.assertNumQueries(4):  # rows, boards + first column, two role queries
            card_links.rollups_for_viewer([self.parent.pk, self.lonely.pk], self.owner)


def _all_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _all_keys(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _all_keys(item)


class RollupAbsentSurfaceTests(_RollupFixture, TestCase):
    """``children_rollup`` is a per-viewer REST read: no other surface carries it.

    The feed (``/events/``) is the OSS webhook dispatcher's source (hooks.py:
    it polls the feed rather than serializing a card of its own), so the feed
    and persisted ``BoardEvent`` rows stand in for a webhook payload; there is
    no separate webhook serializer to exercise. Export and MCP are pinned by
    ``test_card_link_transport_parity.py`` (its key pattern matches
    ``children_rollup``; see ``test_link_key_pattern_names_the_rollup``).
    """

    def setUp(self):
        self._setup_rollup()
        self.client = self._client(self.owner)
        self.pbase = f"/api/v1/boards/{self.pboard.pk}/cards/"

    def _write_everything_on_the_parent_board(self):
        """Create, update, move, archive and restore a parent; return the broadcast calls."""
        self.parent.column.allow_card_creation = True
        self.parent.column.save(update_fields=["allow_card_creation"])
        with mock.patch("boards.broadcast.broadcast_board_event") as sent:
            with self.captureOnCommitCallbacks(execute=True):
                created = self.client.post(self.pbase, {
                    "title": "fresh parent", "column": self.parent.column_id, "swimlane": self.parent.swimlane_id,
                }, format="json")
                self.assertEqual(created.status_code, 201, created.content)
                for path, method, body in (
                    (f"{self.parent.pk}/", "patch", {"description": "x"}),
                    (f"{self.parent.pk}/archive/", "post", None),
                    (f"{self.parent.pk}/unarchive/", "post", None),
                ):
                    res = getattr(self.client, method)(f"{self.pbase}{path}", body, format="json")
                    self.assertEqual(res.status_code, 200, (path, res.content))
        return sent

    def test_link_key_pattern_names_the_rollup(self):
        # The export/MCP parity tests rely on this pattern to catch the field.
        from boards.tests.test_card_link_transport_parity import LINK_KEY

        self.assertTrue(LINK_KEY.search("children_rollup"))

    def test_broadcast_frames_and_persisted_rows_never_carry_the_rollup(self):
        sent = self._write_everything_on_the_parent_board()
        self.assertGreaterEqual(sent.call_count, 4)
        frames = [c.args + tuple(c.kwargs.values()) for c in sent.call_args_list]
        self.assertNotIn("children_rollup", set(_all_keys(frames)))
        rows = list(BoardEvent.objects.filter(board_id=self.pboard.pk).values_list("data", flat=True))
        self.assertTrue(rows)
        self.assertNotIn("children_rollup", set(_all_keys(rows)))

    def test_feed_rows_never_carry_the_rollup(self):
        self._write_everything_on_the_parent_board()
        viewer = self._user("ru_feed", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        for user in (self.owner, viewer):
            res = self._client(user).get(f"/api/v1/boards/{self.pboard.pk}/events/")
            self.assertEqual(res.status_code, 200, res.content)
            self.assertTrue(res.json()["results"] if "results" in res.json() else res.json())
            self.assertNotIn("children_rollup", set(_all_keys(res.json())))

    def test_archived_list_never_carries_the_rollup(self):
        res = self.client.post(f"{self.pbase}{self.parent.pk}/archive/")
        self.assertEqual(res.status_code, 200, res.content)
        res = self.client.get(f"{self.pbase}archived/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIn(self.parent.pk, [c["id"] for c in res.json()["results"]])
        self.assertNotIn("children_rollup", set(_all_keys(res.json())))


class ChildrenChangedPingTests(_RollupFixture, TestCase):
    def setUp(self):
        self._setup_rollup()
        self.client = self._client(self.owner)
        self.cbase = f"/api/v1/boards/{self.cboard.pk}/cards/"

    def _pings(self):
        return list(
            BoardEvent.objects.filter(event="card.children_changed").values_list("board_id", "data")
        )

    def _expect_one(self):
        self.assertEqual(self._pings(), [(self.pboard.pk, {"parent_id": self.parent.pk})])
        BoardEvent.objects.filter(event="card.children_changed").delete()

    def test_column_move_pings_and_lane_move_does_not(self):
        lane2 = _make_swimlane(self.cboard, name="lane two")
        move = f"{self.cbase}{self.todo.pk}/move/"
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(move, {"column_id": self.col_c.pk, "swimlane_id": lane2.pk, "position": 0}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._pings(), [])
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(move, {"column_id": self.col_doing.pk, "swimlane_id": lane2.pk, "position": 0}, format="json")
        self._expect_one()

    def test_archive_restore_block_and_unblock_ping(self):
        base = f"{self.cbase}{self.doing.pk}/"
        for path, body in (("archive/", None), ("unarchive/", None), ("block/", {"reason": "waiting"}), ("unblock/", {})):
            with self.captureOnCommitCallbacks(execute=True):
                res = self.client.post(f"{base}{path}", body, format="json")
            self.assertEqual(res.status_code, 200, (path, res.content))
            self._expect_one()

    def test_blocks_relation_and_blocker_archive_ping_the_blocked_childs_parent(self):
        other = _make_card(self.col_c, self.lane_c, title="other")
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(
                f"{self.cbase}{other.pk}/relations/", {"to_card": self.doing.pk, "direction": "blocks"}, format="json",
            )
        self.assertEqual(res.status_code, 201, res.content)
        self._expect_one()
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(f"{self.cbase}{other.pk}/archive/")
        self._expect_one()

    def test_parent_tier_writes_never_ping_children_changed(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/block/", {"reason": "r"}, format="json")
        self.assertEqual(self._pings(), [])

    def test_unlinked_child_board_card_pings_nothing(self):
        loose = _make_card(self.col_c, self.lane_c, title="loose")
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(f"{self.cbase}{loose.pk}/move/", {
                "column_id": self.col_doing.pk, "swimlane_id": self.lane_c.pk, "position": 0,
            }, format="json")
        self.assertEqual(self._pings(), [])

    def test_ping_is_deferred_and_rolls_back(self):
        with mock.patch("boards.broadcast.broadcast_board_event") as sent:
            with self.captureOnCommitCallbacks(execute=True), self.assertRaises(RuntimeError):
                with transaction.atomic():
                    card_links.announce_children_changed([self.doing.pk], actor_id=self.owner.pk)
                    raise RuntimeError
            sent.assert_not_called()
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                card_links.announce_children_changed([self.doing.pk, self.done.pk], actor_id=self.owner.pk)
            sent.assert_not_called()
            for cb in callbacks:
                cb()
        # Two children of one parent coalesce into one ping, plus (#2443) one
        # sibling ping to the child board.
        self.assertEqual(
            [(c.args[0], c.args[1]) for c in sent.call_args_list],
            [(self.pboard.pk, "card.children_changed"), (self.cboard.pk, "card.parent_changed")],
        )


class ContainerRenameTests(_RollupFixture, TestCase):
    """#2416: a parent board, column or lane rename pings each child board once."""

    def setUp(self):
        self._setup_rollup()
        self.client = self._client(self.owner)
        self.kids = sorted(CardParentLink.objects.filter(parent=self.parent).values_list("child_id", flat=True))

    def _pings(self):
        return list(
            BoardEvent.objects.filter(event="card.parent_changed").values_list("board_id", "data")
        )

    def test_board_column_and_lane_renames_ping_ids_only(self):
        p = self.pboard.pk
        for url, body in (
            (f"/api/v1/boards/{p}/", {"name": "Portfolio 2"}),
            (f"/api/v1/boards/{p}/columns/{self.parent.column_id}/", {"name": "Renamed col"}),
            (f"/api/v1/boards/{p}/swimlanes/{self.parent.swimlane_id}/", {"name": "Renamed lane"}),
        ):
            with self.captureOnCommitCallbacks(execute=True):
                res = self.client.patch(url, body, format="json")
            self.assertEqual(res.status_code, 200, (url, res.content))
            self.assertEqual(self._pings(), [(self.cboard.pk, {"card_ids": self.kids})], url)
            BoardEvent.objects.filter(event="card.parent_changed").delete()

    def test_unchanged_name_and_child_tier_renames_ping_nothing(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(f"/api/v1/boards/{self.pboard.pk}/", {"name": self.pboard.name, "description": "d"}, format="json")
        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(f"/api/v1/boards/{self.cboard.pk}/", {"name": "Delivery 2"}, format="json")
        self.assertEqual(self._pings(), [])

    def test_other_column_rename_pings_nothing(self):
        col2 = _make_column(self.pboard, name="Elsewhere", order=3)
        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(f"/api/v1/boards/{self.pboard.pk}/columns/{col2.pk}/", {"name": "x"}, format="json")
        self.assertEqual(self._pings(), [])

    def test_above_the_cap_one_reload_ping_per_board(self):
        other_board, other_parent = _board_with_card(self.owner, parent_tier=False, name="Ops", title="o")
        CardParentLink.objects.create(
            parent=_make_card(self.parent.column, self.parent.swimlane, title="p2"),
            child=other_parent, created_by=self.owner,
        )
        with mock.patch.object(card_links, "CONTAINER_RENAME_ID_CAP", 3), \
                CaptureQueriesContext(connection) as ctx, transaction.atomic():
            card_links.announce_parent_container_renamed(self.pboard, actor_id=None)
        # Two link reads however many parents; the rest are the two feed rows.
        reads = [q for q in ctx.captured_queries if "card_parent_links" in q["sql"]]
        self.assertEqual(len(reads), 2, reads)
        rows = sorted(self._pings())
        self.assertEqual(rows, sorted([
            (self.cboard.pk, {"card_ids": [], "reload": True}),
            (other_board.pk, {"card_ids": [other_parent.pk]}),
        ]))

    def test_plain_board_costs_zero_queries(self):
        with self.assertNumQueries(0):
            card_links.announce_parent_container_renamed(self.cboard, actor_id=None)


class AdminChildPingTests(_RollupFixture, TestCase):
    """#2500: Django-admin writes send the same pings as the REST paths.

    ``CardAdmin.save_model`` edits of a child's column or archived state ping
    the parent's board (``card.children_changed``); board, column and lane
    admin renames of a parent's container send the bounded
    ``card.parent_changed`` of #2416. Each has a negative control.
    """

    def setUp(self):
        from django.contrib import admin as django_admin
        from django.test import RequestFactory

        self._setup_rollup()
        self.site = django_admin.site
        self.request = RequestFactory().post("/")
        self.request.user = self.owner
        self.kids = sorted(CardParentLink.objects.filter(parent=self.parent).values_list("child_id", flat=True))

    def _rows(self, event):
        return list(BoardEvent.objects.filter(event=event).values_list("board_id", "data"))

    def _save(self, admin_cls, model, obj):
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            admin_cls(model, self.site).save_model(self.request, obj, None, True)

    def _card_save(self, card_id, **fields):
        from boards.admin import CardAdmin
        from boards.models import Card

        card = Card.objects.get(pk=card_id)
        for name, value in fields.items():
            setattr(card, name, value)
        self._save(CardAdmin, Card, card)

    def test_card_admin_column_and_archive_edits_ping_the_parent_board_once(self):
        for fields in (
            {"column": self.col_doing},
            {"archived_at": timezone.now()},
            {"archived_at": None},
        ):
            self._card_save(self.todo.pk, **fields)
            self.assertEqual(
                self._rows("card.children_changed"), [(self.pboard.pk, {"parent_id": self.parent.pk})], fields,
            )
            BoardEvent.objects.filter(event="card.children_changed").delete()

    def test_card_admin_no_op_title_and_lane_edits_ping_nothing(self):
        lane2 = _make_swimlane(self.cboard, name="lane two")
        self._card_save(self.doing.pk)
        self._card_save(self.doing.pk, title="renamed child")
        self._card_save(self.doing.pk, swimlane=lane2)
        self.assertEqual(self._rows("card.children_changed"), [])

    def test_card_admin_edit_of_an_unlinked_card_pings_nothing(self):
        loose = _make_card(self.col_c, self.lane_c, title="loose")
        self._card_save(loose.pk, column=self.col_doing)
        self.assertEqual(self._rows("card.children_changed"), [])

    def test_card_admin_ping_is_deferred_and_rolls_back(self):
        from boards.admin import CardAdmin
        from boards.models import Card

        card = Card.objects.get(pk=self.doing.pk)
        card.column = self.col_done
        with mock.patch("boards.broadcast.broadcast_board_event") as sent:
            with self.captureOnCommitCallbacks(execute=True), self.assertRaises(RuntimeError):
                with transaction.atomic():
                    CardAdmin(Card, self.site).save_model(self.request, card, None, True)
                    raise RuntimeError
            sent.assert_not_called()
            self.assertEqual(self._rows("card.children_changed"), [])
            card = Card.objects.get(pk=self.doing.pk)
            card.column = self.col_done
            with self.captureOnCommitCallbacks(execute=False) as callbacks, transaction.atomic():
                CardAdmin(Card, self.site).save_model(self.request, card, None, True)
            sent.assert_not_called()  # nothing before the commit
            for cb in callbacks:
                cb()
        published = [c.args[:2] for c in sent.call_args_list if c.args[1] == "card.children_changed"]
        self.assertEqual(published, [(self.pboard.pk, "card.children_changed")])

    def test_admin_board_column_and_lane_renames_ping_each_child_board_once(self):
        from boards.admin import BoardAdmin, ColumnAdmin, SwimlaneAdmin
        from boards.models import Board, Column, Swimlane

        for admin_cls, model, pk, name in (
            (BoardAdmin, Board, self.pboard.pk, "Portfolio 2"),
            (ColumnAdmin, Column, self.parent.column_id, "Renamed col"),
            (SwimlaneAdmin, Swimlane, self.parent.swimlane_id, "Renamed lane"),
        ):
            obj = model.objects.get(pk=pk)
            obj.name = name
            self._save(admin_cls, model, obj)
            self.assertEqual(self._rows("card.parent_changed"), [(self.cboard.pk, {"card_ids": self.kids})], model)
            BoardEvent.objects.filter(event="card.parent_changed").delete()

    def test_admin_unchanged_name_other_container_and_child_tier_renames_ping_nothing(self):
        from boards.admin import BoardAdmin, ColumnAdmin, SwimlaneAdmin
        from boards.models import Board, Column, Swimlane

        elsewhere = _make_column(self.pboard, name="Elsewhere", order=3)
        for admin_cls, model, pk, name in (
            (BoardAdmin, Board, self.pboard.pk, None),  # unchanged name
            (ColumnAdmin, Column, self.parent.column_id, None),
            (SwimlaneAdmin, Swimlane, self.parent.swimlane_id, None),
            (ColumnAdmin, Column, elsewhere.pk, "x"),  # no parent in it
            (BoardAdmin, Board, self.cboard.pk, "Delivery 2"),  # child tier
            (ColumnAdmin, Column, self.col_doing.pk, "Doing 2"),
            (SwimlaneAdmin, Swimlane, self.lane_c.pk, "lane c 2"),
        ):
            obj = model.objects.get(pk=pk)
            if name is not None:
                obj.name = name
            self._save(admin_cls, model, obj)
        self.assertEqual(self._rows("card.parent_changed"), [])

    def test_admin_rename_reads_links_a_fixed_number_of_times(self):
        from boards.admin import ColumnAdmin
        from boards.models import Column

        for i in range(3):
            parent = _make_card(self.parent.column, self.parent.swimlane, title=f"p{i}")
            CardParentLink.objects.create(
                parent=parent, child=_make_card(self.col_c, self.lane_c, title=f"k{i}"), created_by=self.owner,
            )
        col = Column.objects.get(pk=self.parent.column_id)
        col.name = "Renamed col"
        with CaptureQueriesContext(connection) as ctx:
            self._save(ColumnAdmin, Column, col)
        reads = [q for q in ctx.captured_queries if "card_parent_links" in q["sql"]]
        # The count, then the ids: two however many parents the column holds.
        self.assertEqual(len(reads), 2, reads)
        self.assertEqual(len(self._rows("card.parent_changed")), 1)


class ColumnBulkPingTests(_RollupFixture, TestCase):
    """#2500: a child-board column ``is_done`` toggle or first-column change.

    One bounded, ids-only ``card.children_bulk_changed`` per PARENT board,
    deferred to commit, from the REST update and reorder and the Django admin,
    and only when a child's rollup bucket actually changed.
    """

    EVT = "card.children_bulk_changed"

    def setUp(self):
        self._setup_rollup()
        self.client = self._client(self.owner)
        self.cols = f"/api/v1/boards/{self.cboard.pk}/columns/"

    def _pings(self):
        return list(BoardEvent.objects.filter(event=self.EVT).order_by("pk").values_list("board_id", "data"))

    def _expect_one(self, parent_ids=None):
        self.assertEqual(self._pings(), [(self.pboard.pk, {"parent_ids": parent_ids or [self.parent.pk]})])
        BoardEvent.objects.filter(event=self.EVT).delete()

    def _patch(self, column, body, board=None):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.patch(f"/api/v1/boards/{(board or self.cboard).pk}/columns/{column.pk}/", body, format="json")
        self.assertEqual(res.status_code, 200, res.content)

    def _reorder(self, cols):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(f"{self.cols}reorder/", {"order": [c.pk for c in cols]}, format="json")
        self.assertEqual(res.status_code, 200, res.content)

    def test_is_done_toggle_pings_the_parent_board_once(self):
        self._patch(self.col_doing, {"is_done": True})
        self._expect_one()
        self._patch(self.col_doing, {"is_done": False})
        self._expect_one()
        # The per-parent event is not sent for a column-wide change.
        self.assertFalse(BoardEvent.objects.filter(event="card.children_changed").exists())

    def test_unchanged_is_done_other_fields_and_unlinked_columns_ping_nothing(self):
        self._patch(self.col_done, {"is_done": True})  # already done
        self._patch(self.col_doing, {"name": "Doing 2", "color": "#123456"})
        loose = _make_column(self.cboard, name="Loose", order=7)
        _make_card(loose, self.lane_c, title="unlinked")
        self._patch(loose, {"is_done": True})  # no linked child
        only_archived = _make_column(self.cboard, name="Old", order=8)
        self.archived.column = only_archived
        self.archived.save(update_fields=["column"])
        self._patch(only_archived, {"is_done": True})  # archived children leave the rollup
        other_board, other_card = _board_with_card(self.owner, parent_tier=False, name="Solo", title="s")
        self._patch(other_card.column, {"is_done": True}, board=other_board)  # no parent links at all
        self.assertEqual(self._pings(), [])

    def test_reorder_that_changes_the_first_column_pings_once(self):
        self._reorder([self.col_c, self.col_doing, self.col_done])  # same order
        self._reorder([self.col_c, self.col_done, self.col_doing])  # first column kept
        self.assertEqual(self._pings(), [])
        self._reorder([self.col_doing, self.col_c, self.col_done])
        self._expect_one()

    def test_parent_tier_column_writes_ping_nothing_and_read_nothing(self):
        self._patch(self.parent.column, {"is_done": True}, board=self.pboard)
        self.assertEqual(self._pings(), [])
        with self.assertNumQueries(0):
            self.assertIsNone(card_links.column_rollup_state(self.pboard))
            card_links.announce_columns_children_changed(self.pboard, [self.parent.column_id], actor_id=None)

    def test_absent_input_sends_and_reads_nothing(self):
        # #1075: no snapshot, no columns, or only a missing id fail safe.
        with self.assertNumQueries(0):
            card_links.announce_column_rollup_changed(self.cboard, None, actor_id=None)
            card_links.announce_columns_children_changed(self.cboard, [], actor_id=None)
            card_links.announce_columns_children_changed(self.cboard, [None], actor_id=None)
        self.assertEqual(self._pings(), [])

    def test_scoped_to_each_affected_parent_board_and_its_readers(self):
        pboard2, parent2 = _board_with_card(self.owner, parent_tier=True, name="Portfolio 2", title="p2")
        CardParentLink.objects.create(
            parent=parent2, child=_make_card(self.col_done, self.lane_c, title="c2"), created_by=self.owner,
        )
        with mock.patch("boards.broadcast.broadcast_board_event") as sent:
            self._patch(self.col_doing, {"is_done": True})
        # Only the parent with a child in the toggled column; never the child board.
        self.assertEqual(self._pings(), [(self.pboard.pk, {"parent_ids": [self.parent.pk]})])
        self.assertEqual(
            sorted({c.args[0] for c in sent.call_args_list if c.args[1] == self.EVT}), [self.pboard.pk],
        )
        BoardEvent.objects.filter(event=self.EVT).delete()
        self._patch(self.col_done, {"is_done": False})
        self.assertEqual(sorted(self._pings()), sorted([
            (self.pboard.pk, {"parent_ids": [self.parent.pk]}), (pboard2.pk, {"parent_ids": [parent2.pk]}),
        ]))
        # A reader with no role on the parent board cannot read its feed; a
        # parent-board viewer reads only ids.
        child_only = self._user("bulk_child_only", child_role=Role.VIEWER)
        res = self._client(child_only).get(f"/api/v1/boards/{self.pboard.pk}/events/")
        self.assertIn(res.status_code, (403, 404))
        child_feed = self._client(child_only).get(f"/api/v1/boards/{self.cboard.pk}/events/")
        self.assertNotIn(self.EVT, json.dumps(child_feed.json()))
        viewer = self._user("bulk_parent_viewer", parent_role=Role.VIEWER)
        feed = json.dumps(self._client(viewer).get(f"/api/v1/boards/{self.pboard.pk}/events/").json())
        self.assertIn(self.EVT, feed)
        self.assertNotIn("SECRET-C", feed)

    def _parents_with_children_in(self, column, n):
        pboard, first = _board_with_card(self.owner, parent_tier=True, name=f"Wide {n}", title="w0")
        parents = [first] + [_make_card(first.column, first.swimlane, title=f"w{i}") for i in range(1, n)]
        CardParentLink.objects.bulk_create([
            CardParentLink(parent=p, child=_make_card(column, self.lane_c, title=f"k{p.pk}"), created_by=self.owner)
            for p in parents
        ])
        return pboard, sorted(p.pk for p in parents)

    def test_cap_boundary_lists_100_ids_and_101_reloads_in_one_fixed_read(self):
        self.assertEqual(card_links.CONTAINER_RENAME_ID_CAP, 100)
        col_a = _make_column(self.cboard, name="A", order=11)
        col_b = _make_column(self.cboard, name="B", order=12)
        board_100, ids_100 = self._parents_with_children_in(col_a, 100)
        board_101, _ids = self._parents_with_children_in(col_b, 101)
        for cols, expected in (
            ([col_a], [(board_100.pk, {"parent_ids": ids_100})]),
            ([col_b], [(board_101.pk, {"parent_ids": [], "reload": True})]),
        ):
            with CaptureQueriesContext(connection) as ctx, transaction.atomic():
                card_links.announce_columns_children_changed(self.cboard, [c.pk for c in cols], actor_id=None)
            reads = [q for q in ctx.captured_queries if "card_parent_links" in q["sql"]]
            self.assertEqual(len(reads), 1, reads)
            self.assertEqual(self._pings(), expected)
            BoardEvent.objects.filter(event=self.EVT).delete()

    def test_read_count_does_not_grow_with_parents_or_children(self):
        col_a = _make_column(self.cboard, name="A", order=11)
        col_b = _make_column(self.cboard, name="B", order=12)
        self._parents_with_children_in(col_a, 2)
        self._parents_with_children_in(col_b, 20)
        counts = []
        for col in (col_a, col_b):
            with CaptureQueriesContext(connection) as ctx, transaction.atomic():
                card_links.announce_columns_children_changed(self.cboard, [col.pk], actor_id=None)
            counts.append(len(ctx.captured_queries))
        self.assertEqual(counts[0], counts[1])

    def test_ping_is_deferred_and_rolls_back(self):
        with mock.patch("boards.broadcast.broadcast_board_event") as sent:
            with self.captureOnCommitCallbacks(execute=True), self.assertRaises(RuntimeError):
                with transaction.atomic():
                    card_links.announce_columns_children_changed(self.cboard, [self.col_doing.pk], actor_id=None)
                    raise RuntimeError
            sent.assert_not_called()
            self.assertEqual(self._pings(), [])
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                card_links.announce_columns_children_changed(
                    self.cboard, [self.col_doing.pk, self.col_done.pk], actor_id=None,
                )
            sent.assert_not_called()
            for cb in callbacks:
                cb()
        # Children of one parent in two columns coalesce into one frame.
        self.assertEqual([c.args[1:3] for c in sent.call_args_list], [(self.EVT, {"parent_ids": [self.parent.pk]})])

    def _admin_save(self, column, change=True, **fields):
        from django.contrib import admin as django_admin
        from django.test import RequestFactory

        from boards.admin import ColumnAdmin
        from boards.models import Column

        request = RequestFactory().post("/")
        request.user = self.owner
        for name, value in fields.items():
            setattr(column, name, value)
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            ColumnAdmin(Column, django_admin.site).save_model(request, column, None, change)

    def test_admin_is_done_position_and_add_ahead_ping_and_no_ops_do_not(self):
        from boards.models import Column

        self._admin_save(Column.objects.get(pk=self.col_doing.pk))  # no-op save
        self._admin_save(Column.objects.get(pk=self.col_done.pk), position=40)  # still not first
        self._admin_save(Column.objects.get(pk=self.col_doing.pk), name="Doing 3")
        self.assertEqual(self._pings(), [])
        self._admin_save(Column.objects.get(pk=self.col_doing.pk), is_done=True)
        self._expect_one()
        self._admin_save(Column.objects.get(pk=self.col_c.pk), position=50)  # col_doing becomes first
        self._expect_one()
        # An admin add ahead of the first column re-buckets its children.
        self._admin_save(Column(board=self.cboard, name="Inbox", position=-1), change=False)
        self._expect_one()

    def test_admin_column_moved_to_another_board_pings_its_old_boards_parents(self):
        from boards.models import Column

        elsewhere, _card = _board_with_card(self.owner, parent_tier=False, name="Elsewhere", title="e")
        # col_c (the first column, holding the "to do" child) leaves: col_doing
        # becomes the old board's first column.
        self._admin_save(Column.objects.get(pk=self.col_c.pk), board=elsewhere, position=60)
        self._expect_one()

    def test_below_admin_column_writes_are_refused_and_ping_nothing(self):
        for role in (Role.MEMBER, Role.VIEWER):
            client = self._client(self._user(f"bulk_{role}", child_role=role))
            with self.captureOnCommitCallbacks(execute=True):
                patched = client.patch(f"{self.cols}{self.col_doing.pk}/", {"is_done": True}, format="json")
                reordered = client.post(
                    f"{self.cols}reorder/", {"order": [self.col_doing.pk, self.col_c.pk, self.col_done.pk]},
                    format="json",
                )
                deleted = client.delete(f"{self.cols}{self.col_c.pk}/")
            self.assertEqual(
                (patched.status_code, reordered.status_code, deleted.status_code), (403, 403, 403), role
            )
        self.assertEqual(self._pings(), [])
        from boards.models import Column

        self.assertTrue(Column.objects.filter(pk=self.col_c.pk).exists())


class ColumnDeleteBulkPingTests(_RollupFixture, TestCase):
    """#2500: deleting a child board's FIRST column promotes the next one.

    The next column's live children re-bucket into "to do" with no card write
    to ping on, so the delete sends one ``card.children_bulk_changed``. The
    deleted column's own children are gone by cascade, so only the promoted
    column's parents are named. Deleting any other column sends nothing.
    """

    EVT = "card.children_bulk_changed"

    def setUp(self):
        self._setup_rollup()
        self.client = self._client(self.owner)

    def _pings(self):
        return list(BoardEvent.objects.filter(event=self.EVT).order_by("pk").values_list("board_id", "data"))

    def _delete(self, column, board=None):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.delete(f"/api/v1/boards/{(board or self.cboard).pk}/columns/{column.pk}/")
        self.assertEqual(res.status_code, 204, res.content)

    def _admin(self):
        from django.contrib import admin as django_admin
        from django.test import RequestFactory

        from boards.admin import ColumnAdmin
        from boards.models import Column

        request = RequestFactory().post("/")
        request.user = self.owner
        return request, ColumnAdmin(Column, django_admin.site)

    def test_deleting_the_first_column_pings_the_promoted_columns_parents_once(self):
        self._delete(self.col_c)
        self.assertEqual(self._pings(), [(self.pboard.pk, {"parent_ids": [self.parent.pk]})])

    def test_deleting_a_middle_or_last_column_pings_nothing(self):
        self._delete(self.col_doing)
        self._delete(self.col_done)
        self.assertEqual(self._pings(), [])

    def test_no_links_ping_nothing(self):
        other_board, other_card = _board_with_card(self.owner, parent_tier=False, name="Solo", title="s")
        second = _make_column(other_board, name="Second", order=50)
        _make_card(second, other_card.swimlane, title="kid")
        self._delete(other_card.column, board=other_board)
        self.assertEqual(self._pings(), [])

    def test_rollback_sends_nothing(self):
        from boards.services import card_links

        with mock.patch("boards.broadcast.broadcast_board_event") as sent:
            with self.captureOnCommitCallbacks(execute=True), self.assertRaises(RuntimeError):
                with transaction.atomic():
                    before = card_links.column_rollup_state(self.cboard)
                    self.col_c.delete()
                    card_links.announce_column_rollup_changed(self.cboard, before, actor_id=None)
                    raise RuntimeError
            sent.assert_not_called()
        self.assertEqual(self._pings(), [])

    def test_admin_delete_pings_for_the_first_column_only(self):
        from boards.models import Column

        request, model_admin = self._admin()
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            model_admin.delete_model(request, Column.objects.get(pk=self.col_doing.pk))
        self.assertEqual(self._pings(), [])
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            model_admin.delete_model(request, Column.objects.get(pk=self.col_c.pk))
        # col_doing is gone, so col_done is promoted: its live child re-buckets.
        self.assertEqual(self._pings(), [(self.pboard.pk, {"parent_ids": [self.parent.pk]})])

    def test_admin_bulk_delete_snapshots_each_board_once(self):
        from boards.models import Column

        other_board, other_card = _board_with_card(self.owner, parent_tier=False, name="Solo", title="s")
        request, model_admin = self._admin()
        qs = Column.objects.filter(pk__in=[self.col_c.pk, other_card.column_id])
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            model_admin.delete_queryset(request, qs)
        self.assertEqual(self._pings(), [(self.pboard.pk, {"parent_ids": [self.parent.pk]})])
        BoardEvent.objects.filter(event=self.EVT).delete()
        # A middle column alone sends nothing.
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            model_admin.delete_queryset(request, Column.objects.filter(pk=self.col_done.pk))
        self.assertEqual(self._pings(), [])
