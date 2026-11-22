"""Child-link service follow-ups for 1.3 (#2447, #2443, #2449).

* #2447: no new child under an ARCHIVED parent, on both writes (``create_link``
  and Add child's ``create_child``), with the coded 400 ``parent_archived``;
  re-saving the link a child already has keeps answering ``link_exists``.
  The parent-side pickers say so before the write does.
* #2443: ``Card.parent`` carries ``siblings_total`` / ``siblings_done`` for a
  visible parent, counted per viewer over the child's own board only, and
  nothing for a hidden parent.
* #2449: the two options lists are capped at ``CHILD_BOARD_OPTIONS_LIMIT``
  with ``boards_total``. Their query-count pins live in ``test_query_counts``.
"""
import asyncio
import json
from unittest.mock import AsyncMock, patch

from django.db import connection, transaction
from django.test.utils import CaptureQueriesContext
from django.test import TestCase
from django.utils import timezone

from boards import consumers
from boards.consumers import BoardConsumer, _now as board_now
from boards.models import BoardEvent, BoardMembership, Card, CardParentLink, CardRelation, Column
from boards.permissions import audience_gate
from boards.services import card_links
from boards.tests.conftest import _make_card
from boards.tests.test_card_children_rollup_2210 import _RollupFixture
from boards.tests.test_default_child_board_2208 import (
    PATCH_BROADCAST,
    AddChildFixture,
    add_card,
    client_for,
    make_board,
)

Role = BoardMembership.Role


def _archive(card):
    Card.objects.filter(pk=card.pk).update(archived_at=timezone.now())
    card.refresh_from_db()


class ArchivedParentWriteTests(AddChildFixture):
    """#2447: both write paths refuse an archived parent with one code."""

    def link(self, user, child, parent):
        with patch(PATCH_BROADCAST):
            return client_for(user).post(
                f"/api/v1/boards/{child.board_id}/cards/{child.pk}/parent/",
                {"parent_id": parent.pk}, format="json",
            )

    def test_link_to_an_archived_parent_is_a_coded_400(self):
        child = add_card(self.child, "Task")
        _archive(self.parent_card)
        r = self.link(self.member, child, self.parent_card)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["code"], "parent_archived")
        self.assertFalse(CardParentLink.objects.exists())

    def test_add_child_under_an_archived_parent_is_a_coded_400_and_creates_nothing(self):
        _archive(self.parent_card)
        r = self.add_child(self.member)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["code"], "parent_archived")
        self.assertFalse(Card.objects.filter(board=self.child).exists())

    def test_live_parent_still_links(self):
        child = add_card(self.child, "Task")
        self.assertEqual(self.link(self.member, child, self.parent_card).status_code, 201)

    def test_re_saving_an_existing_link_is_not_refused_as_archived(self):
        """The exception: a child already linked to it keeps its link and its old answer."""
        child = add_card(self.child, "Task")
        CardParentLink.objects.create(parent=self.parent_card, child=child, created_by=self.admin)
        _archive(self.parent_card)
        r = self.link(self.member, child, self.parent_card)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "link_exists")
        self.assertTrue(CardParentLink.objects.filter(parent=self.parent_card, child=child).exists())

    def test_restoring_the_parent_lifts_the_refusal(self):
        _archive(self.parent_card)
        self.assertEqual(self.add_child(self.member).json()["code"], "parent_archived")
        Card.objects.filter(pk=self.parent_card.pk).update(archived_at=None)
        self.assertEqual(self.add_child(self.member).status_code, 201)


class ArchivedParentPickerTests(AddChildFixture):
    """#2447: the pickers name the refusal before the write does."""

    def test_child_board_options_disabled_reason(self):
        url = f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/"
        self.assertIsNone(client_for(self.member).get(url).json()["disabled_reason"])
        _archive(self.parent_card)
        self.assertEqual(client_for(self.member).get(url).json()["disabled_reason"], "parent_archived")

    def test_child_candidates_disabled_reason_keeps_the_link_codes_first(self):
        linked = add_card(self.child, "Linked task")
        free = add_card(self.child, "Free task")
        CardParentLink.objects.create(parent=self.parent_card, child=linked, created_by=self.admin)
        _archive(self.parent_card)
        rows = card_links.child_candidates_for_viewer(self.member, self.parent_card, self.child, "task")
        reasons = {r["id"]: r["disabled_reason"] for r in rows}
        self.assertEqual(reasons, {linked.pk: "link_exists", free.pk: "parent_archived"})


class SiblingCountTests(AddChildFixture):
    """#2443: ``Card.parent.siblings_total`` / ``siblings_done``, per viewer."""

    def setUp(self):
        super().setUp()
        done = Column.objects.get(board=self.child, name="Done")
        Column.objects.filter(pk=done.pk).update(is_done=True)
        lane = self.child.swimlanes.first()
        todo = self.child.columns.order_by("position").first()
        self.kids = [add_card(self.child, f"k{i}") for i in range(3)]
        self.kids.append(Card.objects.create(board=self.child, column=done, swimlane=lane, title="done"))
        archived = Card.objects.create(board=self.child, column=todo, swimlane=lane, title="gone")
        self.kids.append(archived)
        for k in self.kids:
            CardParentLink.objects.create(parent=self.parent_card, child=k, created_by=self.admin)
        _archive(archived)

    def parent_of(self, user, card):
        r = client_for(user).get(f"/api/v1/boards/{self.child.pk}/full/")
        self.assertEqual(r.status_code, 200, r.content)
        return {c["id"]: c for c in r.json()["cards"]}[card.pk]["parent"]

    def test_counts_live_siblings_on_this_board_including_the_card(self):
        p = self.parent_of(self.member, self.kids[0])
        self.assertEqual((p["siblings_total"], p["siblings_done"]), (4, 1))

    def test_hidden_parent_carries_no_sibling_data(self):
        outsider = self.user_with("sib_out", child=Role.MEMBER)
        self.assertEqual(self.parent_of(outsider, self.kids[0]), {"hidden": True})

    def test_a_child_on_another_board_is_never_counted(self):
        """One child board per parent has no DB constraint: count only this board."""
        stray_board = make_board(self.admin, "Stray")
        stray = add_card(stray_board, "stray")
        CardParentLink.objects.create(parent=self.parent_card, child=stray, created_by=self.admin)
        self.assertEqual(self.parent_of(self.member, self.kids[0])["siblings_total"], 4)

    def test_no_role_on_the_child_board_gives_null_counts(self):
        """Absent input (#1075): the child's own board unresolved -> nothing counted."""
        parent_only = self.user_with("sib_po", parent=Role.MEMBER)
        out = card_links.parents_for_viewer([self.kids[0].pk], parent_only)[self.kids[0].pk]
        self.assertFalse(out["hidden"])
        self.assertIsNone(out["siblings_total"])
        self.assertIsNone(out["siblings_done"])

    def test_no_viewer_is_hidden_without_counts(self):
        out = card_links.parents_for_viewer([self.kids[0].pk], None)
        self.assertEqual(out, {self.kids[0].pk: {"hidden": True}})

    def test_a_blocked_child_in_a_done_column_is_not_done(self):
        """Same partition as the parent rollup: blocked wins over the done column (#2443)."""
        done_kid = self.kids[3]
        Card.objects.filter(pk=done_kid.pk).update(blocked_at=timezone.now())
        p = self.parent_of(self.member, self.kids[0])
        self.assertEqual((p["siblings_total"], p["siblings_done"]), (4, 0))
        rollup = card_links.rollups_for_viewer([self.parent_card.pk], self.member)[self.parent_card.pk]
        self.assertEqual((rollup["done"], rollup["blocked"]), (0, 1))

    def test_an_open_blocks_relation_from_a_live_same_board_card_is_not_done(self):
        done_kid = self.kids[3]
        blocker = add_card(self.child, "blocker")
        rel = CardRelation.objects.create(
            from_card=blocker, to_card=done_kid, relation_type=CardRelation.Type.BLOCKS, created_by=self.admin,
        )
        self.assertEqual(self.parent_of(self.member, self.kids[0])["siblings_done"], 0)
        # An archived blocker no longer blocks: done again, as in the rollup.
        _archive(blocker)
        self.assertEqual(self.parent_of(self.member, self.kids[0])["siblings_done"], 1)
        rel.delete()

    def test_counts_are_clamped_to_the_children_cap(self):
        lane = self.child.swimlanes.first()
        col = self.child.columns.order_by("position").first()
        extra = Card.objects.bulk_create([
            Card(board=self.child, column=col, swimlane=lane, title=f"x{i}", position=i)
            for i in range(card_links.CHILDREN_PER_PARENT_LIMIT)
        ])
        CardParentLink.objects.bulk_create([CardParentLink(parent=self.parent_card, child=k) for k in extra])
        out = card_links.parents_for_viewer([self.kids[0].pk], self.member)[self.kids[0].pk]
        self.assertEqual(out["siblings_total"], card_links.CHILDREN_PER_PARENT_LIMIT)


class OptionsListCapTests(AddChildFixture):
    """#2449: both options lists stop at the cap and report the full total."""

    def setUp(self):
        super().setUp()
        for name in ("Delivery 2", "Delivery 3"):
            b = make_board(self.admin, name)
            BoardMembership.objects.create(board=b, user=self.admin, role=Role.ADMIN)

    def test_add_child_options_are_capped_and_keep_the_default(self):
        # The default sorts last by name, beyond the page: still resolved.
        last = make_board(self.admin, "Zeta")
        BoardMembership.objects.create(board=last, user=self.admin, role=Role.ADMIN)
        type(self.parent).objects.filter(pk=self.parent.pk).update(default_child_board=last)
        with patch.object(card_links, "CHILD_BOARD_OPTIONS_LIMIT", 2):
            out = client_for(self.admin).get(
                f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/",
            ).json()
        self.assertEqual(len(out["boards"]), 2)
        self.assertEqual(out["boards_total"], 4)
        self.assertEqual(out["default"], {"id": last.pk, "name": "Zeta"})
        # The default is IN the page, in the last slot, so the chooser can preselect it.
        self.assertEqual(out["boards"][-1]["id"], last.pk)
        names = [b["name"] for b in out["boards"]]
        self.assertEqual(names, sorted(names, key=str.lower))

    def test_a_default_inside_the_page_leaves_it_unchanged(self):
        first_page = card_links.child_board_options_for_viewer(self.parent_card, self.admin)["boards"][:2]
        type(self.parent).objects.filter(pk=self.parent.pk).update(default_child_board=first_page[0]["id"])
        self.parent_card.refresh_from_db()
        self.parent_card.board.refresh_from_db()
        with patch.object(card_links, "CHILD_BOARD_OPTIONS_LIMIT", 2):
            out = card_links.child_board_options_for_viewer(self.parent_card, self.admin)
        self.assertEqual(out["boards"], first_page)

    def test_default_child_board_options_are_capped(self):
        with patch.object(card_links, "CHILD_BOARD_OPTIONS_LIMIT", 2):
            out = client_for(self.admin).get(
                f"/api/v1/boards/{self.parent.pk}/default-child-board-options/",
            ).json()
        self.assertEqual(len(out["boards"]), 2)
        self.assertEqual(out["boards_total"], 3)

    def test_default_child_board_options_keep_the_current_default(self):
        last = make_board(self.admin, "Zeta")
        BoardMembership.objects.create(board=last, user=self.admin, role=Role.ADMIN)
        type(self.parent).objects.filter(pk=self.parent.pk).update(default_child_board=last)
        with patch.object(card_links, "CHILD_BOARD_OPTIONS_LIMIT", 2):
            out = client_for(self.admin).get(
                f"/api/v1/boards/{self.parent.pk}/default-child-board-options/",
            ).json()
        self.assertEqual(out["boards_total"], 4)
        self.assertEqual(len(out["boards"]), 2)
        self.assertEqual(out["boards"][-1], {"id": last.pk, "name": "Zeta"})

    def test_no_viewer_gets_an_empty_total(self):
        out = card_links.child_board_options_for_viewer(self.parent_card, None)
        self.assertEqual((out["boards"], out["boards_total"]), ([], 0))
        out = card_links.default_child_board_options_for_admin(self.parent, None)
        self.assertEqual(out, {"boards": [], "boards_total": 0})

    def test_boards_total_counts_only_boards_the_caller_may_use(self):
        """A board below the needed role is neither listed nor counted (rbac-check, #2449)."""
        other = self.user_with("cap_other")
        viewer_only = make_board(other, "Viewer only")
        member_only = make_board(other, "Member only")
        BoardMembership.objects.create(board=viewer_only, user=self.admin, role=Role.VIEWER)
        BoardMembership.objects.create(board=member_only, user=self.admin, role=Role.MEMBER)
        add = client_for(self.admin).get(
            f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/",
        ).json()
        names = {b["name"] for b in add["boards"]}
        self.assertNotIn("Viewer only", names)
        self.assertIn("Member only", names)  # member is enough for Add child
        self.assertEqual(add["boards_total"], len(add["boards"]))
        default = client_for(self.admin).get(
            f"/api/v1/boards/{self.parent.pk}/default-child-board-options/",
        ).json()
        names = {b["name"] for b in default["boards"]}
        self.assertFalse({"Viewer only", "Member only"} & names)  # a default needs admin
        self.assertEqual(default["boards_total"], len(default["boards"]))

    def test_no_role_on_the_parent_board_or_below_admin_gets_an_empty_total(self):
        """#1075: a caller the guard cannot authorize gets nothing, not the full count."""
        outsider = self.user_with("cap_out", child=Role.ADMIN)
        out = card_links.child_board_options_for_viewer(self.parent_card, outsider)
        self.assertEqual((out["boards"], out["boards_total"]), ([], 0))
        member = self.user_with("cap_mem", parent=Role.MEMBER, child=Role.ADMIN)
        out = card_links.default_child_board_options_for_admin(self.parent, member)
        self.assertEqual(out, {"boards": [], "boards_total": 0})


class SiblingPingTests(_RollupFixture, TestCase):
    """#2443: a write to one child pings its SIBLINGS so their "N of M siblings done" refreshes.

    Frame: ``card.parent_changed {card_ids, siblings: true}`` on the child board
    only, ids of the parent's live children there, never a parent id or count.
    Broadcast only (never a feed row), gated to the parent's board by
    ``audience_board_id`` beside the envelope. ``frames()`` reads what was
    published, in publish order, the child's own (persisted) frame included.
    """

    def setUp(self):
        self._setup_rollup()
        self.client = self._client(self.owner)
        self.cbase = f"/api/v1/boards/{self.cboard.pk}/cards/"
        # Live children: todo, doing, done, manual, by_rel (archived is not one).
        self.live = sorted(c.pk for c in (self.todo, self.doing, self.done, self.manual, self.by_rel))
        self.sent = []
        patcher = patch(
            "boards.broadcast.broadcast_board_event",
            side_effect=lambda *a, **k: self.sent.append((a, k)),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def reset(self):
        self.sent.clear()
        BoardEvent.objects.all().delete()

    def frames(self):
        rows = [(a[0], a[2]) for a, _k in self.sent if a[1] == "card.parent_changed"]
        self.reset()
        return rows

    def sibling_frame(self, ids):
        return (self.cboard.pk, {"card_ids": sorted(ids), "siblings": True})

    def post(self, path, body=None):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(f"{self.cbase}{path}", body, format="json")
        self.assertIn(res.status_code, (200, 201), (path, res.content))
        return res

    def test_moving_a_child_into_and_out_of_a_done_column_pings_its_siblings(self):
        self.reset()
        move = {"column_id": self.col_done.pk, "swimlane_id": self.lane_c.pk, "position": 0}
        self.post(f"{self.doing.pk}/move/", move)
        self.assertEqual(self.frames(), [self.sibling_frame(self.live)])
        self.post(f"{self.doing.pk}/move/", {**move, "column_id": self.col_c.pk})
        self.assertEqual(self.frames(), [self.sibling_frame(self.live)])

    def test_a_reorder_or_lane_move_pings_no_sibling(self):
        self.reset()
        self.post(f"{self.doing.pk}/move/", {"column_id": self.col_doing.pk, "swimlane_id": self.lane_c.pk, "position": 1})
        self.assertEqual(self.frames(), [])

    def test_archive_restore_block_and_unblock_ping_the_siblings(self):
        self.reset()
        others = [pk for pk in self.live if pk != self.doing.pk]
        for path, body, expected in (
            ("archive/", None, others),  # the archived card is no longer a sibling
            ("unarchive/", None, self.live),
            ("block/", {"reason": "waiting"}, self.live),
            ("unblock/", {}, self.live),
        ):
            self.post(f"{self.doing.pk}/{path}", body)
            frames = self.frames()
            self.assertIn(self.sibling_frame(expected), frames, path)
            self.assertTrue(all(b == self.cboard.pk for b, _ in frames), path)

    def test_link_and_unlink_ping_the_other_siblings_after_the_childs_own_frame(self):
        new = _make_card(self.col_c, self.lane_c, title="new")
        self.reset()
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self._link(self.client, child=new).status_code, 201)
        self.assertEqual(self.frames(), [(self.cboard.pk, {"card_ids": [new.pk]}), self.sibling_frame(self.live)])
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.delete(f"{self.cbase}{new.pk}/parent/").status_code, 204)
        self.assertEqual(self.frames(), [(self.cboard.pk, {"card_ids": [new.pk]}), self.sibling_frame(self.live)])

    def test_deleting_a_child_pings_the_surviving_siblings(self):
        self.reset()
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.delete(f"{self.cbase}{self.doing.pk}/").status_code, 204)
        self.assertEqual(self.frames(), [self.sibling_frame([pk for pk in self.live if pk != self.doing.pk])])

    def test_a_lone_child_pings_no_sibling(self):
        """The line shows for two or more; a parent's only child has nobody to tell."""
        CardParentLink.objects.exclude(child=self.todo).delete()
        self.reset()
        self.post(f"{self.todo.pk}/move/", {"column_id": self.col_done.pk, "swimlane_id": self.lane_c.pk, "position": 0})
        self.assertEqual(self.frames(), [])

    def test_sibling_ping_is_deferred_and_rolls_back(self):
        with patch("boards.broadcast.broadcast_board_event") as sent:
            with self.captureOnCommitCallbacks(execute=True), self.assertRaises(RuntimeError):
                with transaction.atomic():
                    card_links.announce_children_changed([self.doing.pk], actor_id=self.owner.pk)
                    raise RuntimeError
            sent.assert_not_called()
            self.assertFalse(BoardEvent.objects.filter(event="card.parent_changed").exists())
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                card_links.announce_children_changed([self.doing.pk], actor_id=self.owner.pk)
            sent.assert_not_called()
            for cb in callbacks:
                cb()
        self.assertIn(
            (self.cboard.pk, "card.parent_changed", {"card_ids": self.live, "siblings": True}),
            [(c.args[0], c.args[1], c.args[2]) for c in sent.call_args_list],
        )

    def test_sibling_ids_are_one_parents_children_on_one_board(self):
        """Two parents' children on one board get one frame each, never merged."""
        other_parent = _make_card(self.parent.column, self.parent.swimlane, title="P2")
        a, b = (_make_card(self.col_c, self.lane_c, title=t) for t in ("a", "b"))
        for k in (a, b):
            CardParentLink.objects.create(parent=other_parent, child=k, created_by=self.owner)
        self.reset()
        with self.captureOnCommitCallbacks(execute=True):
            card_links.announce_children_changed([self.doing.pk, a.pk], actor_id=self.owner.pk)
        frames = self.frames()
        self.assertIn(self.sibling_frame(self.live), frames)
        self.assertIn(self.sibling_frame([a.pk, b.pk]), frames)
        self.assertEqual(len(frames), 2)

    def test_sibling_frame_is_capped_at_the_per_parent_limit(self):
        with patch.object(card_links, "CHILDREN_PER_PARENT_LIMIT", 3):
            self.reset()
            with self.captureOnCommitCallbacks(execute=True):
                card_links.announce_children_changed([self.doing.pk], actor_id=self.owner.pk)
            self.assertEqual(self.frames(), [self.sibling_frame(self.live[:3])])

    def test_admin_unlink_all_skips_the_sibling_frame_for_the_parent_end_only(self):
        """The parent end leaving unlinks every child (each has its own frame); a child end leaves siblings."""
        self.reset()
        with self.captureOnCommitCallbacks(execute=True):
            card_links.unlink_all(self.parent, actor=self.owner)
        frames = self.frames()
        self.assertFalse(any(d.get("siblings") for _, d in frames), frames)
        self.assertTrue(frames)
        CardParentLink.objects.get_or_create(parent=self.parent, child=self.todo)
        CardParentLink.objects.get_or_create(parent=self.parent, child=self.doing)
        self.reset()
        with self.captureOnCommitCallbacks(execute=True):
            card_links.unlink_all(self.todo, actor=self.owner)
        self.assertTrue(any(d.get("siblings") for _, d in self.frames()))

    def test_sibling_frame_is_gated_to_the_parent_board_and_never_a_feed_row(self):
        """The audience rides beside the envelope; the wire data is unchanged; nothing is persisted."""
        self.reset()
        self.post(f"{self.doing.pk}/move/", {"column_id": self.col_done.pk, "swimlane_id": self.lane_c.pk, "position": 0})
        sibling = [(a, k) for a, k in self.sent if a[1] == "card.parent_changed" and a[2].get("siblings")]
        self.assertEqual(len(sibling), 1, self.sent)
        (args, kwargs), = sibling
        self.assertEqual(args[2], {"card_ids": self.live, "siblings": True})
        self.assertEqual(kwargs.get("audience_board_id"), self.pboard.pk)
        self.assertNotIn("event_id", kwargs)
        self.assertFalse(
            [d for d in BoardEvent.objects.values_list("data", flat=True) if isinstance(d, dict) and d.get("siblings")]
        )

    def test_sibling_pings_are_flat_in_the_number_of_siblings(self):
        """Move and delete of a child: the sibling read is one query, and no feed row, however many siblings."""
        def cost(n_extra):
            extra = [_make_card(self.col_c, self.lane_c, title=f"x{n_extra}-{i}") for i in range(n_extra)]
            CardParentLink.objects.bulk_create([CardParentLink(parent=self.parent, child=k) for k in extra])
            move = {"column_id": self.col_done.pk, "swimlane_id": self.lane_c.pk, "position": 0}
            with CaptureQueriesContext(connection) as moved, self.captureOnCommitCallbacks(execute=True):
                self.assertEqual(self.client.post(f"{self.cbase}{self.todo.pk}/move/", move, format="json").status_code, 200)
            victim = extra[0]
            with CaptureQueriesContext(connection) as deleted, self.captureOnCommitCallbacks(execute=True):
                self.assertEqual(self.client.delete(f"{self.cbase}{victim.pk}/").status_code, 204)
            # Put the moved card back for the next round.
            Card.objects.filter(pk=self.todo.pk).update(column=self.col_c)
            return len(moved), len(deleted)

        cost(2)  # warm the per-process caches the first request fills
        self.assertEqual(cost(2), cost(30))


def _deliver(consumer, message, lookup=None):
    """Run the real ``board_event`` on *message*.

    The audience lookup is the real sync ``consumers.audience_role``, run here,
    before the event loop: inside it, the ORM would open a second connection
    that cannot see the test transaction. ``lookup`` replaces it (a mock).
    """
    if lookup is None:
        _gated, audience = audience_gate(
            message["payload"].get("event"), message["payload"].get("data"), message.get("audience_board_id"),
        )
        role = consumers.audience_role(consumer.scope, audience) if audience is not None else None
        lookup = AsyncMock(return_value=role)
    consumer._audience_role = lookup
    consumer.send.reset_mock()
    asyncio.run(consumer.board_event(message))
    if not consumer.send.called:
        return None
    return json.loads(consumer.send.call_args.kwargs["text_data"])


def _consumer_on(board, user):
    consumer = BoardConsumer()
    consumer.board_id = board.id
    consumer.room = f"board_{board.id}"
    consumer.channel_name = "test-channel"
    consumer.channel_layer = AsyncMock()
    consumer.send = AsyncMock()
    consumer.close = AsyncMock()
    consumer.scope = {"url_route": {"kwargs": {"board_id": board.id}}, "user": user}
    consumer._role = "member"
    # The subscriber's own access is served from the cache: only the audience
    # check reads the DB (see _deliver).
    consumer._access_verified_at = board_now()
    return consumer


def _fresh_user(scope):
    """``load_live_ws_user`` without a handshake credential: the account row only."""
    from accounts.models import User

    return User.objects.filter(pk=scope["user"].id, is_active=True).first()


class SiblingFrameAudienceTests(_RollupFixture, TestCase):
    """#2443 (owner decision 2026-11-22): the sibling frame reaches only subscribers of the
    CHILD board who can also open the PARENT's board; nothing else about delivery changes.

    The publish is real (``broadcast_board_event`` into a capturing channel
    layer); the consumer is the real ``board_event`` and the real audience
    lookup (see ``_deliver``).
    """

    def setUp(self):
        self._setup_rollup()
        self.both = self._user("aud_both", parent_role=Role.VIEWER, child_role=Role.MEMBER)
        self.child_only = self._user("aud_child", child_role=Role.MEMBER)
        self.live = sorted(c.pk for c in (self.todo, self.doing, self.done, self.manual, self.by_rel))
        self.messages = []
        layer = AsyncMock()
        layer.group_send.side_effect = lambda group, message: self.messages.append((group, message))
        for target, value in (
            ("boards.broadcast.get_channel_layer", lambda: layer),
            ("boards.consumers.load_live_ws_user", _fresh_user),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def sibling_message(self):
        self.messages.clear()
        with self.captureOnCommitCallbacks(execute=True):
            card_links.announce_children_changed([self.doing.pk], actor_id=self.owner.pk)
        found = [m for g, m in self.messages if m["payload"]["data"].get("siblings")]
        self.assertEqual(len(found), 1, self.messages)
        self.assertEqual(self.messages[[m for _g, m in self.messages].index(found[0])][0], f"board_{self.cboard.pk}")
        return found[0]

    def test_a_subscriber_who_can_open_the_parent_board_gets_the_frame_unchanged(self):
        message = self.sibling_message()
        self.assertEqual(message["audience_board_id"], self.pboard.pk)
        sent = _deliver(_consumer_on(self.cboard, self.both), message)
        self.assertEqual(sent, {"event": "card.parent_changed", "data": {"card_ids": self.live, "siblings": True}})

    def test_a_subscriber_with_a_role_only_on_the_child_board_does_not(self):
        consumer = _consumer_on(self.cboard, self.child_only)
        self.assertIsNone(_deliver(consumer, self.sibling_message()))
        consumer.close.assert_not_called()  # withheld, not an eviction
        # The child's own ping is not gated: the same subscriber still gets it.
        own = {"type": "board_event", "payload": {"event": "card.parent_changed", "data": {"card_ids": [self.doing.pk]}}}
        self.assertEqual(_deliver(consumer, own), own["payload"])

    def test_a_lost_parent_role_stops_the_frame(self):
        message = self.sibling_message()
        BoardMembership.objects.filter(board=self.pboard, user=self.both).delete()
        self.assertIsNone(_deliver(_consumer_on(self.cboard, self.both), message))

    def test_absent_inputs_drop_the_frame(self):
        """#1075: no audience, a malformed one, no live user or a failed check: nobody gets it."""
        message = self.sibling_message()
        for audience in (None, 0, -1, True, "1", str(self.pboard.pk)):
            with self.subTest(audience=audience):
                m = {k: v for k, v in message.items() if k != "audience_board_id"}
                if audience is not None:
                    m["audience_board_id"] = audience
                lookup = AsyncMock(return_value="admin")
                self.assertIsNone(_deliver(_consumer_on(self.cboard, self.both), m, lookup))
                lookup.assert_not_awaited()  # dropped before any lookup, whatever it would say
        with patch("boards.consumers.load_live_ws_user", lambda scope: None):
            self.assertIsNone(_deliver(_consumer_on(self.cboard, self.both), message))
        consumer = _consumer_on(self.cboard, self.both)
        self.assertIsNone(_deliver(consumer, message, AsyncMock(side_effect=RuntimeError("db down"))))
        consumer.close.assert_not_called()
        missing = {**message, "audience_board_id": self.pboard.pk + 10_000}
        self.assertIsNone(_deliver(_consumer_on(self.cboard, self.both), missing))

    def test_a_rolled_back_write_publishes_nothing(self):
        self.messages.clear()
        with self.captureOnCommitCallbacks(execute=True), self.assertRaises(RuntimeError):
            with transaction.atomic():
                card_links.announce_children_changed([self.doing.pk], actor_id=self.owner.pk)
                raise RuntimeError
        self.assertEqual(self.messages, [])

    def test_gate_rule(self):
        """The rule itself: the sibling frame is always gated; other frames only when an audience is named."""
        sib = {"card_ids": [1], "siblings": True}
        self.assertEqual(audience_gate("card.parent_changed", sib, 7), (True, 7))
        self.assertEqual(audience_gate("card.parent_changed", sib, None), (True, None))
        self.assertEqual(audience_gate("card.parent_changed", {"card_ids": [1]}, None), (False, None))
        self.assertEqual(audience_gate("card.updated", {"siblings": True}, None), (False, None))
        self.assertEqual(audience_gate("card.updated", {}, 7), (True, 7))
        self.assertEqual(audience_gate("card.parent_changed", None, None), (False, None))
