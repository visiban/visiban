"""Cross-board parent/child card links (#1104): write path, read path, events.

The link crosses an authorization boundary that ``CardRelation`` deliberately
does not, so most of these tests are about what the OTHER board's role allows
and what a viewer without it is never shown.
"""

import json
import threading
from unittest import skipUnless
from unittest.mock import patch

from django.contrib import admin as django_admin
from django.db import connection, connections, transaction
from django.contrib.messages import get_messages
from django.test import Client, RequestFactory, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from rest_framework.test import APIClient

from boards.admin import BoardAdmin, CardAdmin, _FlagFlipRefused
from boards.models import Board, BoardEvent, BoardMembership, Card, CardActivity, CardParentLink
from boards.services import card_links
from boards.services.feed import feed_queryset, serialize_feed_rows
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user
from boards.tests.lock_wait import assert_blocked_on_lock
from boards.tests.test_admin_board_concurrent_edits import page_data

Role = BoardMembership.Role
HOLD_TIMEOUT = 10


def _board_with_card(owner, *, parent_tier, name, title):
    board = _make_board(owner, name=name, cards_can_have_children=parent_tier)
    col = _make_column(board, name=f"{name} col")
    lane = _make_swimlane(board, name=f"{name} lane")
    return board, _make_card(col, lane, title=title)


class _LinkFixture:
    def _setup_boards(self):
        self.owner = _make_user("cpl_owner")
        self.pboard, self.parent = _board_with_card(
            self.owner, parent_tier=True, name="Portfolio", title="Initiative SECRET-P",
        )
        self.cboard, self.child = _board_with_card(
            self.owner, parent_tier=False, name="Delivery", title="Task SECRET-C",
        )
        self.col_c = self.child.column
        self.lane_c = self.child.swimlane

    def _user(self, name, *, parent_role=None, child_role=None):
        u = _make_user(name)
        if parent_role:
            BoardMembership.objects.create(board=self.pboard, user=u, role=parent_role)
        if child_role:
            BoardMembership.objects.create(board=self.cboard, user=u, role=child_role)
        return u

    def _client(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def _link(self, client, child=None, parent_id=None):
        child = child or self.child
        return client.post(
            f"/api/v1/boards/{child.board_id}/cards/{child.pk}/parent/",
            {"parent_id": self.parent.pk if parent_id is None else parent_id},
            format="json",
        )


class LinkWriteTests(_LinkFixture, TestCase):
    def setUp(self):
        self._setup_boards()
        self.member = self._user("cpl_member", parent_role=Role.MEMBER, child_role=Role.MEMBER)

    def test_member_on_both_boards_links(self):
        res = self._link(self._client(self.member))
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json(), {"parent_id": self.parent.pk, "child_id": self.child.pk})
        self.assertTrue(CardParentLink.objects.filter(parent=self.parent, child=self.child).exists())
        # History on both cards, naming nothing of the other card, not even its id.
        child_act = CardActivity.objects.get(card=self.child, event_type="parent_linked")
        parent_act = CardActivity.objects.get(card=self.parent, event_type="child_linked")
        for act in (child_act, parent_act):
            self.assertEqual((act.from_value, act.to_value, act.item_text), ("", "", None))

    def test_missing_and_inaccessible_parent_ids_answer_identically(self):
        hidden_board, hidden = _board_with_card(
            _make_user("cpl_other"), parent_tier=True, name="Hidden", title="H",
        )
        client = self._client(self.member)
        missing = self._link(client, parent_id=hidden.pk + 10_000)
        inaccessible = self._link(client, parent_id=hidden.pk)
        garbage = self._link(client, parent_id="abc")
        for odd in (True, 1.5, -1, 2**70):
            self.assertEqual(self._link(client, parent_id=odd).content, missing.content)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(inaccessible.status_code, 404)
        self.assertEqual(garbage.status_code, 404)
        self.assertEqual(missing.content, inaccessible.content)
        self.assertEqual(missing.content, garbage.content)
        self.assertFalse(CardParentLink.objects.exists())

    def test_member_role_is_required_on_both_boards(self):
        cases = [
            ("cpl_cv", Role.MEMBER, Role.VIEWER, 403),
            ("cpl_cc", Role.MEMBER, Role.COLLABORATOR, 403),
            ("cpl_pv", Role.VIEWER, Role.MEMBER, 403),
            ("cpl_pc", Role.COLLABORATOR, Role.MEMBER, 403),
            ("cpl_pn", None, Role.MEMBER, 404),
            ("cpl_pa", Role.ADMIN, Role.ADMIN, 201),
        ]
        for name, prole, crole, expected in cases:
            with self.subTest(name):
                CardParentLink.objects.all().delete()
                res = self._link(self._client(self._user(name, parent_role=prole, child_role=crole)))
                self.assertEqual(res.status_code, expected, res.content)

    def test_two_tier_rules(self):
        client = self._client(self.member)
        other_parent_tier = _make_board(self.owner, name="P2", cards_can_have_children=True)
        BoardMembership.objects.create(board=other_parent_tier, user=self.member, role=Role.MEMBER)
        p2_card = _make_card(_make_column(other_parent_tier), _make_swimlane(other_parent_tier))
        # A card on a parent board cannot become a child.
        self.assertEqual(self._link(client, child=p2_card).json()["code"], "link_not_allowed")
        # A parent on a child-tier board is refused too.
        sibling = _make_card(self.col_c, self.lane_c, title="sib")
        res = self._link(client, child=sibling, parent_id=self.child.pk)
        self.assertEqual(res.json()["code"], "link_not_allowed")
        self.assertEqual(self._link(client, child=self.parent).status_code, 400)

    def test_defense_in_depth_child_is_parent(self):
        # A row that bypassed the board predicate (e.g. written before a fix):
        # the per-card check still refuses to build a third tier on it.
        grandchild = _make_card(self.col_c, self.lane_c, title="gc")
        CardParentLink.objects.create(parent=self.child, child=grandchild)
        res = self._link(self._client(self.member))
        self.assertEqual(res.json()["code"], "child_is_parent")

    def test_already_linked_and_already_has_parent(self):
        client = self._client(self.member)
        self.assertEqual(self._link(client).status_code, 201)
        self.assertEqual(self._link(client).json()["code"], "link_exists")
        p2 = _make_card(self.parent.column, self.parent.swimlane, title="P2")
        self.assertEqual(self._link(client, parent_id=p2.pk).json()["code"], "already_has_parent")

    def test_one_child_board_per_parent(self):
        client = self._client(self.member)
        self.assertEqual(self._link(client).status_code, 201)
        other_child_board, other_child = _board_with_card(
            self.owner, parent_tier=False, name="Onboarding", title="O",
        )
        BoardMembership.objects.create(board=other_child_board, user=self.member, role=Role.MEMBER)
        res = self._link(client, child=other_child)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "children_on_other_board")

    def test_children_limit(self):
        client = self._client(self.member)
        with patch.object(card_links, "CHILDREN_PER_PARENT_LIMIT", 1):
            self.assertEqual(self._link(client).status_code, 201)
            second = _make_card(self.col_c, self.lane_c, title="second")
            res = self._link(client, child=second)
        self.assertEqual(res.json()["code"], "children_limit")

    def test_self_link_and_non_object_body(self):
        client = self._client(self.member)
        url = f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/parent/"
        self.assertEqual(client.post(url, [1], format="json").status_code, 400)
        self.assertEqual(self._link(client, parent_id=self.child.pk).json()["code"], "self_link")

    def test_unlink_from_child_side_needs_no_parent_access(self):
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        child_only = self._user("cpl_childonly", child_role=Role.MEMBER)
        url = f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/parent/"
        viewer = self._user("cpl_cviewer", child_role=Role.VIEWER)
        self.assertEqual(self._client(viewer).delete(url).status_code, 403)
        self.assertEqual(self._client(child_only).delete(url).status_code, 204)
        self.assertFalse(CardParentLink.objects.exists())
        self.assertEqual(self._client(child_only).delete(url).status_code, 404)
        self.assertEqual(
            CardActivity.objects.get(card=self.child, event_type="parent_unlinked").from_value, "",
        )
        self.assertTrue(CardActivity.objects.filter(card=self.parent, event_type="child_unlinked").exists())

    def test_unlink_from_parent_side(self):
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        # MEMBER on the parent board plus any role on the child board.
        both = self._user("cpl_parentboth", parent_role=Role.MEMBER, child_role=Role.VIEWER)
        base = f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/children/"
        other = _make_card(self.parent.column, self.parent.swimlane, title="other parent")
        client = self._client(both)
        # A child id not linked to this parent is a 404.
        self.assertEqual(
            client.delete(f"/api/v1/boards/{self.pboard.pk}/cards/{other.pk}/children/{self.child.pk}/").status_code,
            404,
        )
        self.assertEqual(client.delete(f"{base}{self.child.pk}/").status_code, 204)
        self.assertFalse(CardParentLink.objects.exists())

    def test_parent_side_unlink_without_child_board_role_is_the_missing_id_404(self):
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        parent_only = self._user("cpl_parentonly", parent_role=Role.MEMBER)
        base = f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/children/"
        missing_id = Card.objects.order_by("-pk").values_list("pk", flat=True).first() + 1000
        client = self._client(parent_only)
        missing = client.delete(f"{base}{missing_id}/")
        hidden = client.delete(f"{base}{self.child.pk}/")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(hidden.status_code, 404)
        self.assertEqual(hidden.content, missing.content)
        self.assertEqual(hidden.headers.get("Content-Type"), missing.headers.get("Content-Type"))
        self.assertTrue(CardParentLink.objects.filter(parent=self.parent, child=self.child).exists())
        self.assertFalse(CardActivity.objects.filter(event_type__in=["child_unlinked", "parent_unlinked"]).exists())

    def test_deleting_either_card_removes_the_link(self):
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        self.child.delete()
        self.assertFalse(CardParentLink.objects.exists())

    def test_deleting_a_child_through_the_api_pings_the_parent_board(self):
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        with self.captureOnCommitCallbacks(execute=True):
            res = self._client(self.owner).delete(
                f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/"
            )
        self.assertEqual(res.status_code, 204, res.content)
        rows = list(BoardEvent.objects.filter(board_id=self.pboard.pk))
        self.assertEqual([(r.event, r.data) for r in rows], [("card.children_changed", {"parent_id": self.parent.pk})])
        self.assertTrue(CardActivity.objects.filter(card=self.parent, event_type="child_unlinked").exists())

    def test_deleting_a_parent_through_the_api_pings_the_child_board(self):
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        with self.captureOnCommitCallbacks(execute=True):
            res = self._client(self.owner).delete(
                f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/"
            )
        self.assertEqual(res.status_code, 204, res.content)
        rows = list(BoardEvent.objects.filter(board_id=self.cboard.pk))
        self.assertEqual([(r.event, r.data) for r in rows], [("card.parent_changed", {"card_ids": [self.child.pk]})])
        self.assertTrue(Card.objects.filter(pk=self.child.pk).exists())
        self.assertTrue(CardActivity.objects.filter(card=self.child, event_type="parent_unlinked").exists())


class ContainerDeleteLinkTests(_LinkFixture, TestCase):
    """Every path that deletes cards tells the surviving end of each link (#1104).

    The link rows CASCADE with the cards, so a path that skipped
    ``announce_cards_removal`` would lose the peer's history entry for good
    and leave the peer board's clients stale.
    """

    def setUp(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        self.request = RequestFactory().post("/")
        self.request.user = self.owner

    def _assert_parent_told(self, board_deleted=False):
        rows = list(BoardEvent.objects.filter(board_id=self.pboard.pk))
        self.assertEqual(
            [(r.event, r.data) for r in rows],
            [("card.children_changed", {"parent_id": self.parent.pk})],
        )
        # A whole-board delete records how many children were lost (#2208),
        # a count only: never the deleted board's name.
        if board_deleted:
            row = CardActivity.objects.get(card=self.parent, event_type="children_removed_board_deleted")
            self.assertEqual((row.from_value, row.to_value), ("", "1"))
            return
        row = CardActivity.objects.get(card=self.parent, event_type="child_unlinked")
        self.assertEqual((row.from_value, row.to_value), ("", ""))

    def _assert_child_told(self, board_deleted=True):
        self.assertTrue(Card.objects.filter(pk=self.child.pk).exists())
        rows = list(BoardEvent.objects.filter(board_id=self.cboard.pk))
        self.assertEqual(
            [(r.event, r.data) for r in rows],
            [("card.parent_changed", {"card_ids": [self.child.pk]})],
        )
        event_type = "parent_removed_board_deleted" if board_deleted else "parent_unlinked"
        row = CardActivity.objects.get(card=self.child, event_type=event_type)
        self.assertEqual((row.from_value, row.to_value), ("", ""))

    def test_rest_column_delete_tells_the_parent(self):
        _make_column(self.cboard, name="Spare", order=1)  # the board keeps a column
        with self.captureOnCommitCallbacks(execute=True):
            res = self._client(self.owner).delete(
                f"/api/v1/boards/{self.cboard.pk}/columns/{self.col_c.pk}/"
            )
        self.assertEqual(res.status_code, 204, res.content)
        self.assertFalse(Card.objects.filter(pk=self.child.pk).exists())
        self._assert_parent_told()

    def test_rest_child_board_delete_leaves_each_parent_a_history_entry(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self._client(self.owner).delete(f"/api/v1/boards/{self.cboard.pk}/")
        self.assertEqual(res.status_code, 204, res.content)
        self._assert_parent_told(board_deleted=True)

    def test_rest_parent_board_delete_leaves_children_as_ordinary_cards(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self._client(self.owner).delete(f"/api/v1/boards/{self.pboard.pk}/")
        self.assertEqual(res.status_code, 204, res.content)
        self.assertFalse(CardParentLink.objects.exists())
        self._assert_child_told()

    def test_admin_card_delete_tells_the_parent(self):
        with self.captureOnCommitCallbacks(execute=True):
            CardAdmin(Card, django_admin.site).delete_model(
                self.request, Card.objects.get(pk=self.child.pk),
            )
        self._assert_parent_told()

    def test_admin_board_delete_of_both_ends_records_nothing(self):
        with self.captureOnCommitCallbacks(execute=True):
            BoardAdmin(Board, django_admin.site).delete_queryset(
                self.request, Board.objects.filter(pk__in=[self.pboard.pk, self.cboard.pk]),
            )
        self.assertFalse(Card.objects.filter(pk__in=[self.parent.pk, self.child.pk]).exists())
        self.assertFalse(
            BoardEvent.objects.filter(
                event__in=["card.children_changed", "card.parent_changed"],
            ).exists()
        )

    def test_admin_parent_board_delete_tells_the_children(self):
        with self.captureOnCommitCallbacks(execute=True):
            BoardAdmin(Board, django_admin.site).delete_model(
                self.request, Board.objects.get(pk=self.pboard.pk),
            )
        self._assert_child_told()

    def test_seed_wipe_board_delete_tells_the_parent(self):
        # delete_boards_locked is the seed commands' --wipe path.
        from boards.services.cards import delete_boards_locked

        with self.captureOnCommitCallbacks(execute=True):
            delete_boards_locked(Board.objects.filter(pk=self.cboard.pk))
        self.assertFalse(Card.objects.filter(pk=self.child.pk).exists())
        self._assert_parent_told(board_deleted=True)


class ChildrenReadTests(_LinkFixture, TestCase):
    def setUp(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        self.url = f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/children/"

    def test_viewer_with_child_access_sees_titles(self):
        u = self._user("cpl_both", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        body = self._client(u).get(self.url).json()
        self.assertEqual(body["count"], 1)
        self.assertTrue(body["visible"])
        self.assertEqual(body["results"][0]["title"], "Task SECRET-C")
        self.assertEqual(body["results"][0]["column_name"], self.col_c.name)

    def test_child_on_a_second_board_is_neither_listed_nor_counted(self):
        # The write path keeps a parent's children on one board, but nothing
        # in the schema does: a row inserted directly must not ride the first
        # board's role check into the response.
        _other_board, stray = _board_with_card(
            self.owner, parent_tier=False, name="Elsewhere", title="Stray SECRET-X",
        )
        CardParentLink.objects.create(parent=self.parent, child=stray)
        u = self._user("cpl_second", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        res = self._client(u).get(self.url)
        body = res.json()
        self.assertEqual(body["count"], 1)
        self.assertEqual([r["id"] for r in body["results"]], [self.child.pk])
        self.assertNotIn(b"Stray SECRET-X", res.content)
        self.assertNotIn(stray.pk, [r["id"] for r in body["results"]])

    def test_viewer_without_child_access_gets_a_count_only(self):
        u = self._user("cpl_ponly", parent_role=Role.VIEWER)
        res = self._client(u).get(self.url)
        body = res.json()
        self.assertEqual(body, {"count": 1, "visible": False, "offset": 0, "limit": 50, "results": []})
        raw = res.content.decode()
        for leak in ("SECRET-C", "Delivery", self.col_c.name, self.lane_c.name):
            self.assertNotIn(leak, raw)

    def test_losing_child_access_hides_titles_on_the_next_request(self):
        u = self._user("cpl_revoke", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        client = self._client(u)
        self.assertTrue(client.get(self.url).json()["visible"])
        BoardMembership.objects.filter(board=self.cboard, user=u).delete()
        self.assertFalse(client.get(self.url).json()["visible"])

    def test_no_access_to_parent_board_is_404(self):
        u = self._user("cpl_conly", child_role=Role.ADMIN)
        self.assertEqual(self._client(u).get(self.url).status_code, 404)

    def test_paginates(self):
        for i in range(3):
            CardParentLink.objects.create(
                parent=self.parent, child=_make_card(self.col_c, self.lane_c, title=f"c{i}"),
            )
        u = self._user("cpl_page", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        with patch("boards.views.cards.CHILDREN_PAGE_SIZE", 2):
            first = self._client(u).get(self.url).json()
            second = self._client(u).get(self.url + "?offset=2").json()
        self.assertEqual(first["count"], 4)
        self.assertEqual(len(first["results"]), 2)
        self.assertEqual(len(second["results"]), 2)
        self.assertFalse({r["id"] for r in first["results"]} & {r["id"] for r in second["results"]})

    def test_query_count_is_flat_in_the_number_of_children(self):
        u = self._user("cpl_perf", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        client = self._client(u)
        one = _count_queries(client, self.url)
        for i in range(10):
            CardParentLink.objects.create(
                parent=self.parent, child=_make_card(self.col_c, self.lane_c, title=f"n{i}"),
            )
        self.assertEqual(_count_queries(client, self.url), one)


def _count_queries(client, url):
    from django.test.utils import CaptureQueriesContext

    with CaptureQueriesContext(connection) as ctx:
        client.get(url)
    return len(ctx.captured_queries)


class FlagFlipRefusalTests(_LinkFixture, TestCase):
    def setUp(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child)

    def test_hook_refuses_flips_under_live_links(self):
        self.assertEqual(card_links.links_blocking_flag_flip(self.pboard, False), 1)
        self.assertEqual(card_links.links_blocking_flag_flip(self.cboard, True), 1)
        self.assertEqual(card_links.links_blocking_flag_flip(self.pboard, True), 0)
        for board, value in ((self.pboard, False), (self.cboard, True)):
            res = self._client(self.owner).patch(
                f"/api/v1/boards/{board.pk}/", {"cards_can_have_children": value}, format="json",
            )
            self.assertEqual(res.status_code, 400, res.content)
            self.assertIn("cards_can_have_children", res.json())
            board.refresh_from_db()
            self.assertIs(board.cards_can_have_children, not value)

    def test_django_admin_save_refuses_the_flip(self):
        request = RequestFactory().post("/")
        request.user = self.owner
        self.pboard.cards_can_have_children = False
        with self.assertRaises(_FlagFlipRefused), transaction.atomic():
            BoardAdmin(Board, django_admin.site).save_model(request, self.pboard, None, True)
        self.pboard.refresh_from_db()
        self.assertTrue(self.pboard.cards_can_have_children)

    def test_django_admin_move_to_another_board_unlinks(self):
        other_board = _make_board(self.owner, name="Elsewhere")
        col, lane = _make_column(other_board), _make_swimlane(other_board)
        request = RequestFactory().post("/")
        request.user = self.owner
        child = Card.objects.get(pk=self.child.pk)
        child.board, child.column, child.swimlane = other_board, col, lane
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            CardAdmin(Card, django_admin.site).save_model(request, child, None, True)
        self.assertFalse(CardParentLink.objects.exists())
        # The ping goes to the board the child LEFT, whose clients showed the
        # link, and never to the board it moved to.
        self.assertTrue(
            BoardEvent.objects.filter(board_id=self.cboard.pk, event="card.parent_changed").exists()
        )
        self.assertFalse(
            BoardEvent.objects.filter(board_id=other_board.pk, event="card.parent_changed").exists()
        )
        self.assertTrue(CardActivity.objects.filter(card=self.parent, event_type="child_unlinked").exists())


    def test_django_admin_move_of_a_parent_unlinks_its_children(self):
        other_board = _make_board(self.owner, name="Elsewhere", cards_can_have_children=True)
        col, lane = _make_column(other_board), _make_swimlane(other_board)
        request = RequestFactory().post("/")
        request.user = self.owner
        parent = Card.objects.get(pk=self.parent.pk)
        parent.board, parent.column, parent.swimlane = other_board, col, lane
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            CardAdmin(Card, django_admin.site).save_model(request, parent, None, True)
        self.assertFalse(CardParentLink.objects.exists())
        self.assertTrue(Card.objects.filter(pk=self.child.pk, board=self.cboard).exists())
        # Both cards record it, with no value naming the other card.
        for card_id, event_type in ((self.child.pk, "parent_unlinked"), (self.parent.pk, "child_unlinked")):
            row = CardActivity.objects.get(card_id=card_id, event_type=event_type)
            self.assertEqual((row.from_value, row.to_value), ("", ""))
        # The parent-side ping goes to the board the parent LEFT; the child's
        # board gets its parent_changed.
        self.assertEqual(
            list(BoardEvent.objects.filter(board_id=self.pboard.pk).values_list("event", "data")),
            [("card.children_changed", {"parent_id": self.parent.pk})],
        )
        self.assertEqual(
            list(BoardEvent.objects.filter(board_id=self.cboard.pk).values_list("event", "data")),
            [("card.parent_changed", {"card_ids": [self.child.pk]})],
        )
        self.assertFalse(
            BoardEvent.objects.filter(
                board_id=other_board.pk, event__in=["card.children_changed", "card.parent_changed"],
            ).exists()
        )


@override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
)
class FlagFlipAdminFormTests(_LinkFixture, TestCase):
    """The Django-admin change form turns a refused flip into a message."""

    def setUp(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        root = _make_user("cpl_root")
        root.is_staff = root.is_superuser = True
        root.save()
        self.web = Client()
        self.web.force_login(root)
        # The same pre-existing form quirk the other board admin tests work around.
        Board.objects.filter(pk=self.pboard.pk).update(allowed_priorities=["low"])

    def test_change_form_refuses_the_flip_with_a_message(self):
        url = reverse("admin:boards_board_change", args=[self.pboard.pk])
        page = self.web.get(url)
        self.assertEqual(page.status_code, 200)
        res = self.web.post(url, page_data(page, cards_can_have_children=False, name="Renamed"))
        self.assertEqual(res.status_code, 302)
        self.assertEqual(res["Location"], url)
        [message] = list(get_messages(res.wsgi_request))
        self.assertIn("card link(s) depend on it", str(message))
        self.assertEqual(message.level_tag, "error")
        board = Board.objects.get(pk=self.pboard.pk)
        # The save rolled back whole: neither the flag nor the other field changed.
        self.assertTrue(board.cards_can_have_children)
        self.assertEqual(board.name, "Portfolio")
        self.assertTrue(CardParentLink.objects.exists())
        self.assertFalse(BoardEvent.objects.filter(board_id=self.pboard.pk).exists())


class LinkEventScopingTests(_LinkFixture, TestCase):
    """Link events are ids-only pings and the parent board never gets child events.

    Rule 8 row for #1104: webhooks and the change feed read these rows as the
    fixed ``role="viewer", reader_id=None`` reader, so whatever the payload
    carries reaches parent-board admins who cannot open the child board.
    """

    def setUp(self):
        self._setup_boards()
        self.member = self._user("cpl_ev", parent_role=Role.MEMBER, child_role=Role.MEMBER)

    def _rows(self, board):
        return list(BoardEvent.objects.filter(board_id=board.pk).order_by("id"))

    def test_link_and_unlink_events_carry_ids_only(self):
        client = self._client(self.member)
        with self.captureOnCommitCallbacks(execute=True):
            self._link(client)
        with self.captureOnCommitCallbacks(execute=True):
            client.delete(f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/parent/")
        p_rows, c_rows = self._rows(self.pboard), self._rows(self.cboard)
        self.assertEqual([r.event for r in p_rows], ["card.children_changed"] * 2)
        self.assertEqual([r.event for r in c_rows], ["card.parent_changed"] * 2)
        for r in p_rows:
            self.assertEqual(r.data, {"parent_id": self.parent.pk})
        for r in c_rows:
            self.assertEqual(r.data, {"card_ids": [self.child.pk]})

    def test_webhook_reader_sees_no_other_board_text(self):
        with self.captureOnCommitCallbacks(execute=True):
            self._link(self._client(self.member))
        for board, foreign in ((self.pboard, "SECRET-C"), (self.cboard, "SECRET-P")):
            rows = list(feed_queryset(board.pk, role="viewer", reader_id=None).order_by("id"))
            rendered = json.dumps(serialize_feed_rows(board.pk, rows, role="viewer", reader_id=None))
            self.assertNotIn(foreign, rendered)

    def test_child_card_events_never_reach_the_parent_board(self):
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        client = self._client(self.owner)
        with self.captureOnCommitCallbacks(execute=True):
            res = client.patch(
                f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/",
                {"title": "Task SECRET-C renamed"}, format="json",
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(self._rows(self.cboard))
        self.assertEqual(self._rows(self.pboard), [])

    def test_rolled_back_link_broadcasts_nothing(self):
        with patch("boards.broadcast.broadcast_board_event") as sent:
            with patch.object(CardParentLink.objects, "create", side_effect=RuntimeError):
                with self.captureOnCommitCallbacks(execute=True), self.assertRaises(RuntimeError):
                    card_links.create_link(
                        user=self.member, child=self.child, child_role=Role.MEMBER,
                        parent_id=self.parent.pk,
                    )
        sent.assert_not_called()


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class ConcurrentLinkTests(_LinkFixture, TransactionTestCase):
    """The rules that read other rows are decided under the link locks."""

    def setUp(self):
        self._setup_boards()
        self.member = self._user("cpl_cc", parent_role=Role.MEMBER, child_role=Role.MEMBER)

    def _thread(self, name, fn, results):
        def run():
            try:
                results[name] = fn()
            except Exception as exc:  # surfaced by the status assertions
                results[name] = exc
            finally:
                connections.close_all()

        t = threading.Thread(target=run, name=name)
        t.start()
        return t

    def _race(self, second_name, second_fn):
        """Hold a link create after its insert (locks taken, not committed),
        prove the second request waits on a lock, then let both finish."""
        paused, release, results = threading.Event(), threading.Event(), {}
        real = card_links._announce

        def held(*args, **kwargs):
            if threading.current_thread().name == "linker" and not paused.is_set():
                paused.set()
                release.wait(HOLD_TIMEOUT)
            return real(*args, **kwargs)

        with patch.object(card_links, "_announce", side_effect=held):
            linker = self._thread("linker", lambda: self._link(self._client(self.member)), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "link never reached its hold")
            second = self._thread(second_name, second_fn, results)
            assert_blocked_on_lock(self, second, f"{second_name} did not wait for the link")
            release.set()
            linker.join(HOLD_TIMEOUT)
            second.join(HOLD_TIMEOUT)
        for name in ("linker", second_name):
            if isinstance(results.get(name), Exception):
                self.fail(f"{name} raised {results[name]!r}")
        self.assertEqual(results["linker"].status_code, 201)
        return results[second_name]

    def test_flag_flip_waits_for_the_link_and_is_refused(self):
        res = self._race("flipper", lambda: self._client(self.owner).patch(
            f"/api/v1/boards/{self.pboard.pk}/", {"cards_can_have_children": False}, format="json",
        ))
        self.assertEqual(res.status_code, 400)
        self.assertTrue(Board.objects.get(pk=self.pboard.pk).cards_can_have_children)

    def test_second_parent_for_the_same_child_is_refused(self):
        p2 = _make_card(self.parent.column, self.parent.swimlane, title="P2")
        res = self._race("second", lambda: self._link(self._client(self.member), parent_id=p2.pk))
        self.assertEqual(res.json()["code"], "already_has_parent")
        self.assertEqual(CardParentLink.objects.count(), 1)

    def test_child_on_another_board_for_the_same_parent_is_refused(self):
        other_board, other_child = _board_with_card(
            self.owner, parent_tier=False, name="Onboarding", title="O",
        )
        BoardMembership.objects.create(board=other_board, user=self.member, role=Role.MEMBER)
        res = self._race("second", lambda: self._link(self._client(self.member), child=other_child))
        self.assertEqual(res.json()["code"], "children_on_other_board")
        self.assertEqual(CardParentLink.objects.count(), 1)

    def test_link_waits_on_the_card_lock_of_an_unlink_holding_no_board_lock(self):
        """The card-lock half of ``_lock_endpoints``.

        An unlink takes no board locks, so only the parent card's row lock
        makes this link wait. Without it the link reads the unlinked child's
        row before the unlink commits and refuses with children_on_other_board;
        with it, it reads after the commit and succeeds.
        """
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        other_board, other_child = _board_with_card(
            self.owner, parent_tier=False, name="Onboarding", title="O",
        )
        BoardMembership.objects.create(board=other_board, user=self.member, role=Role.MEMBER)
        paused, release, results = threading.Event(), threading.Event(), {}
        real = card_links._announce

        def held(*args, **kwargs):
            if threading.current_thread().name == "unlinker" and not paused.is_set():
                paused.set()
                release.wait(HOLD_TIMEOUT)
            return real(*args, **kwargs)

        with patch.object(card_links, "_announce", side_effect=held):
            unlinker = self._thread("unlinker", lambda: self._client(self.member).delete(
                f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/parent/"
            ), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "unlink never reached its hold")
            linker = self._thread(
                "linker", lambda: self._link(self._client(self.member), child=other_child), results,
            )
            assert_blocked_on_lock(self, linker, "the link did not wait for the unlink's card lock")
            release.set()
            unlinker.join(HOLD_TIMEOUT)
            linker.join(HOLD_TIMEOUT)
        for name in ("unlinker", "linker"):
            if isinstance(results.get(name), Exception):
                self.fail(f"{name} raised {results[name]!r}")
        self.assertEqual(results["unlinker"].status_code, 204)
        self.assertEqual(results["linker"].status_code, 201, results["linker"].content)
        self.assertEqual(
            list(CardParentLink.objects.values_list("parent_id", "child_id")),
            [(self.parent.pk, other_child.pk)],
        )
