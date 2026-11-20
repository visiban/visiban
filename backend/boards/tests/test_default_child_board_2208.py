"""``Board.default_child_board`` (#2208 part 2): where "Add child" starts.

A preference, not a relationship (#2207): it never creates, moves or removes
a card link. Covers the model and migrations, the PATCH write (ADMIN on both
boards, one uniform refusal, lock-both-boards), the flag-flip blocker for a
board that is another board's default, the chooser read, the one-request Add
child, and the board-delete impact read and history.
"""
import importlib

from django.contrib.admin.sites import AdminSite
from django.test import RequestFactory, TestCase

from accounts.models import User
from boards.admin import BoardAdmin
from boards.models import Board, BoardMembership, Column, Swimlane

Role = BoardMembership.Role


def make_board(owner, name, *, parent_tier=False, first_column_creates=True):
    """A board with two columns and one lane; the first column's creation flag is set."""
    board = Board.objects.create(name=name, owner=owner, cards_can_have_children=parent_tier)
    Column.objects.create(board=board, name="To do", position=0, allow_card_creation=first_column_creates)
    Column.objects.create(board=board, name="Done", position=1, allow_card_creation=True)
    Swimlane.objects.create(board=board, name="Lane", position=0)
    return board


class DefaultChildBoardModelTests(TestCase):
    def test_add_field_is_nullable_set_null_without_an_inline_index(self):
        m = importlib.import_module("boards.migrations.0125_board_default_child_board")
        ops = m.Migration.operations
        self.assertEqual([op.__class__.__name__ for op in ops], ["AddField"])
        field = ops[0].field
        self.assertTrue(field.null)
        self.assertFalse(field.db_index)

    def test_index_migration_is_alone_and_non_atomic(self):
        m = importlib.import_module("boards.migrations.0126_board_default_child_idx")
        self.assertIs(m.Migration.atomic, False)
        self.assertEqual([op.__class__.__name__ for op in m.Migration.operations], ["AddIndexConcurrently"])

    def test_target_delete_clears_the_default(self):
        owner = User.objects.create_user(username="dcb_m_owner", password="pass")
        parent = make_board(owner, "Pipeline", parent_tier=True)
        child = make_board(owner, "Delivery")
        parent.default_child_board = child
        parent.save(update_fields=["default_child_board"])
        child.delete()
        parent.refresh_from_db()
        self.assertIsNone(parent.default_child_board_id)

    def test_django_admin_cannot_write_it(self):
        site_admin = User.objects.create_superuser(username="dcb_m_su", password="pass")
        request = RequestFactory().get("/")
        request.user = site_admin
        board = make_board(site_admin, "B")
        readonly = BoardAdmin(Board, AdminSite()).get_readonly_fields(request, board)
        self.assertIn("default_child_board", readonly)


from unittest.mock import patch  # noqa: E402

from rest_framework.test import APIClient  # noqa: E402

from boards.models import Card, CardParentLink  # noqa: E402
from boards.serializers import (  # noqa: E402
    DEFAULT_CHILD_BOARD_NOT_ALLOWED_MSG,
    BoardSerializer,
    PublicBoardSerializer,
)

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def client_for(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


class DefaultChildBoardFixture(TestCase):
    """Pipeline (parent tier) and Delivery (child tier), with an admin of both."""

    def setUp(self):
        self.admin = User.objects.create_user(username="dcb_admin", password="pass")
        self.parent = make_board(self.admin, "Pipeline", parent_tier=True)
        self.child = make_board(self.admin, "Delivery")
        for b in (self.parent, self.child):
            BoardMembership.objects.create(board=b, user=self.admin, role=Role.ADMIN)
        self.url = f"/api/v1/boards/{self.parent.pk}/"

    def user_with(self, name, **roles):
        u = User.objects.create_user(username=f"dcb_{name}", password="pass")
        for board, role in roles.items():
            BoardMembership.objects.create(board=getattr(self, board), user=u, role=role)
        return u

    def patch_board(self, user, body, url=None):
        with patch(PATCH_BROADCAST):
            return client_for(user).patch(url or self.url, body, format="json")

    def set_default(self):
        Board.objects.filter(pk=self.parent.pk).update(default_child_board=self.child)


class DefaultChildBoardWriteTests(DefaultChildBoardFixture):
    def test_admin_of_both_boards_sets_it_and_reads_it_back_as_an_id(self):
        r = self.patch_board(self.admin, {"default_child_board": self.child.pk})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["default_child_board"], self.child.pk)
        self.parent.refresh_from_db()
        self.assertEqual(self.parent.default_child_board_id, self.child.pk)
        full = client_for(self.admin).get(f"{self.url}full/").json()
        self.assertEqual(full["default_child_board"], self.child.pk)

    def test_every_refusal_is_one_body(self):
        member_on_target = self.user_with("mt", parent=Role.ADMIN, child=Role.MEMBER)
        no_access = self.user_with("na", parent=Role.ADMIN)
        parent_tier = make_board(self.admin, "Other parent", parent_tier=True)
        no_create = make_board(self.admin, "Locked", first_column_creates=False)
        for b in (parent_tier, no_create):
            BoardMembership.objects.create(board=b, user=self.admin, role=Role.ADMIN)
        cases = [
            ("member on target", member_on_target, self.child.pk),
            ("no access to target", no_access, self.child.pk),
            ("unknown id", self.admin, 999999),
            ("parent-tier target", self.admin, parent_tier.pk),
            ("first column refuses creation", self.admin, no_create.pk),
            ("itself", self.admin, self.parent.pk),
            ("not an id", self.admin, "abc"),
        ]
        for label, user, value in cases:
            with self.subTest(label):
                r = self.patch_board(user, {"default_child_board": value})
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json(), {"default_child_board": [DEFAULT_CHILD_BOARD_NOT_ALLOWED_MSG]})
        self.parent.refresh_from_db()
        self.assertIsNone(self.parent.default_child_board_id)

    def test_clear_and_echo_need_admin_on_this_board_only(self):
        self.set_default()
        source_admin = self.user_with("sa", parent=Role.ADMIN)
        self.assertEqual(self.patch_board(source_admin, {"default_child_board": self.child.pk}).status_code, 200)
        self.assertEqual(self.patch_board(source_admin, {"default_child_board": None}).status_code, 200)
        self.parent.refresh_from_db()
        self.assertIsNone(self.parent.default_child_board_id)

    def test_member_of_the_source_board_cannot_write_it(self):
        member = self.user_with("m", parent=Role.MEMBER, child=Role.ADMIN)
        self.assertEqual(self.patch_board(member, {"default_child_board": self.child.pk}).status_code, 403)

    def test_refused_while_the_source_board_cannot_have_children(self):
        Board.objects.filter(pk=self.parent.pk).update(cards_can_have_children=False)
        r = self.patch_board(self.admin, {"default_child_board": self.child.pk})
        self.assertEqual(r.status_code, 400)
        self.assertIn("default_child_board", r.json())

    def test_turning_the_flag_off_clears_it_in_the_same_write(self):
        self.set_default()
        r = self.patch_board(self.admin, {"cards_can_have_children": False})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["default_child_board"])
        self.parent.refresh_from_db()
        self.assertIsNone(self.parent.default_child_board_id)

    def test_echoing_the_default_while_turning_the_flag_off_clears_it(self):
        self.set_default()
        r = self.patch_board(
            self.admin, {"cards_can_have_children": False, "default_child_board": self.child.pk},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["default_child_board"])
        self.parent.refresh_from_db()
        self.assertIsNone(self.parent.default_child_board_id)
        self.assertFalse(self.parent.cards_can_have_children)

    def test_target_cannot_turn_its_flag_on_while_it_is_a_default(self):
        self.set_default()
        r = self.patch_board(self.admin, {"cards_can_have_children": True}, url=f"/api/v1/boards/{self.child.pk}/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("default child board", r.json()["cards_can_have_children"][0])
        self.child.refresh_from_db()
        self.assertFalse(self.child.cards_can_have_children)

    def test_create_refuses_a_default(self):
        with patch(PATCH_BROADCAST):
            r = client_for(self.admin).post("/api/v1/boards/", {
                "name": "New", "cards_can_have_children": True, "default_child_board": self.child.pk,
            }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_public_share_payload_has_no_default(self):
        self.set_default()
        self.parent.refresh_from_db()
        self.assertNotIn("default_child_board", PublicBoardSerializer(self.parent).data)

    def test_validator_without_a_request_refuses(self):
        """#1075: no caller to authorize means no default, not an unchecked one."""
        ser = BoardSerializer(self.parent, data={"default_child_board": self.child.pk}, partial=True, context={})
        self.assertFalse(ser.is_valid())
        self.assertIn("default_child_board", ser.errors)


class ChildrenSettingBlockersTests(DefaultChildBoardFixture):
    def blockers(self, user, board):
        return client_for(user).get(f"/api/v1/boards/{board.pk}/children-setting-blockers/")

    def test_lists_links_and_defaults_with_hidden_sources(self):
        self.set_default()
        hidden_source = make_board(self.admin, "Secret", parent_tier=True)
        Board.objects.filter(pk=hidden_source.pk).update(default_child_board=self.child)
        child_admin = self.user_with("ca", child=Role.ADMIN, parent=Role.VIEWER)
        lane = Swimlane.objects.get(board=self.parent)
        p = Card.objects.create(board=self.parent, column=self.parent.columns.first(), swimlane=lane, title="P")
        clane = Swimlane.objects.get(board=self.child)
        c = Card.objects.create(board=self.child, column=self.child.columns.first(), swimlane=clane, title="C")
        CardParentLink.objects.create(parent=p, child=c, created_by=self.admin)
        r = self.blockers(child_admin, self.child)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {
            "child_cards": 1, "parent_cards": 0,
            "default_of": [
                {"hidden": False, "id": self.parent.pk, "name": "Pipeline", "can_change": False},
                {"hidden": True},
            ],
        })
        self.assertEqual(self.blockers(self.admin, self.parent).json()["parent_cards"], 1)

    def test_non_admins_are_refused(self):
        member = self.user_with("bm", child=Role.MEMBER)
        self.assertEqual(self.blockers(member, self.child).status_code, 403)
        outsider = self.user_with("bo")
        self.assertEqual(self.blockers(outsider, self.child).status_code, 404)


class BoardQualifiesTests(TestCase):
    def test_absent_board_fails_closed(self):
        from boards.services.card_links import board_qualifies_as_child
        self.assertFalse(board_qualifies_as_child(None))


import threading  # noqa: E402
from unittest import skipUnless  # noqa: E402

from django.db import connection, connections  # noqa: E402
from django.test import TransactionTestCase  # noqa: E402

from boards.models import CardActivity  # noqa: E402
from boards.services import card_links  # noqa: E402
from boards.tests.lock_wait import assert_blocked_on_lock  # noqa: E402


def add_card(board, title="Card"):
    return Card.objects.create(
        board=board, column=board.columns.order_by("position").first(),
        swimlane=board.swimlanes.first(), title=title,
    )


class AddChildFixture(DefaultChildBoardFixture):
    def setUp(self):
        super().setUp()
        self.parent_card = add_card(self.parent, "Opportunity")
        self.member = self.user_with("mem", parent=Role.MEMBER, child=Role.MEMBER)

    def children_url(self, card=None):
        card = card or self.parent_card
        return f"/api/v1/boards/{card.board_id}/cards/{card.pk}/children/"

    def add_child(self, user, board_id=None, title="Task"):
        body = {"board_id": self.child.pk if board_id is None else board_id, "title": title}
        with patch(PATCH_BROADCAST):
            return client_for(user).post(self.children_url(), body, format="json")


class AddChildTests(AddChildFixture):
    def test_creates_the_card_in_the_first_column_and_lane_and_links_it(self):
        r = self.add_child(self.member)
        self.assertEqual(r.status_code, 201, r.content)
        child = Card.objects.get(pk=r.json()["id"])
        self.assertEqual(child.board_id, self.child.pk)
        self.assertEqual(child.column.position, 0)
        self.assertEqual(child.title, "Task")
        self.assertTrue(CardParentLink.objects.filter(parent=self.parent_card, child=child).exists())
        types = set(CardActivity.objects.filter(card__in=[child, self.parent_card]).values_list("event_type", flat=True))
        self.assertLessEqual({"parent_linked", "child_linked"}, types)

    def test_announces_ids_only_on_commit(self):
        with patch(PATCH_BROADCAST) as bc, self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.member).post(self.children_url(), {"board_id": self.child.pk, "title": "T"}, format="json")
        self.assertEqual(r.status_code, 201)
        events = {(c.args[0], c.args[1]) for c in bc.call_args_list}
        self.assertIn((self.child.pk, "card.created"), events)
        self.assertIn((self.parent.pk, "card.children_changed"), events)
        self.assertIn((self.child.pk, "card.parent_changed"), events)
        for c in bc.call_args_list:
            if c.args[1] == "card.children_changed":
                self.assertEqual(c.args[2], {"parent_id": self.parent_card.pk})

    def test_every_unusable_target_is_one_404(self):
        viewer_on_target = self.user_with("vt", parent=Role.MEMBER, child=Role.VIEWER)
        no_access = self.user_with("nt", parent=Role.MEMBER)
        no_create = make_board(self.admin, "Locked", first_column_creates=False)
        BoardMembership.objects.create(board=no_create, user=self.member, role=Role.MEMBER)
        cases = [
            (viewer_on_target, self.child.pk), (no_access, self.child.pk), (self.member, 999999),
            (self.member, no_create.pk), (self.member, self.parent.pk), (self.member, "x"),
            (self.member, True), (self.member, -1),
        ]
        bodies = set()
        for user, board_id in cases:
            with self.subTest(board_id=board_id):
                r = self.add_child(user, board_id=board_id)
                self.assertEqual(r.status_code, 404)
                bodies.add(r.content)
        self.assertEqual(len(bodies), 1)
        self.assertEqual(Card.objects.filter(board=self.child).count(), 0)

    def test_viewer_on_the_parent_board_is_403_before_the_body(self):
        viewer = self.user_with("vp", parent=Role.VIEWER, child=Role.MEMBER)
        with patch(PATCH_BROADCAST):
            r = client_for(viewer).post(self.children_url(), {"title": ""}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_blank_or_missing_title_is_400(self):
        for title in ("", "   ", None, 5):
            with self.subTest(title=title):
                self.assertEqual(self.add_child(self.member, title=title).status_code, 400)

    def test_never_splits_a_parent_across_boards(self):
        other = make_board(self.admin, "Onboarding")
        BoardMembership.objects.create(board=other, user=self.member, role=Role.MEMBER)
        self.assertEqual(self.add_child(self.member).status_code, 201)
        r = self.add_child(self.member, board_id=other.pk)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "children_on_other_board")
        self.assertEqual(Card.objects.filter(board=other).count(), 0)

    def test_parent_board_flag_off_is_refused_and_creates_nothing(self):
        Board.objects.filter(pk=self.parent.pk).update(cards_can_have_children=False)
        r = self.add_child(self.member)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "link_not_allowed")
        self.assertEqual(Card.objects.filter(board=self.child).count(), 0)

    def test_limit_is_enforced(self):
        lane = self.child.swimlanes.first()
        col = self.child.columns.order_by("position").first()
        kids = Card.objects.bulk_create([
            Card(board=self.child, column=col, swimlane=lane, title=f"k{i}", position=i)
            for i in range(card_links.CHILDREN_PER_PARENT_LIMIT)
        ])
        CardParentLink.objects.bulk_create([CardParentLink(parent=self.parent_card, child=k) for k in kids])
        r = self.add_child(self.member)
        self.assertEqual(r.json()["code"], "children_limit")

    def test_hard_wip_limit_of_the_first_column_applies(self):
        col = self.child.columns.order_by("position").first()
        col.wip_limit = 0
        col.save(update_fields=["wip_limit"])
        Board.objects.filter(pk=self.child.pk).update(enforce_wip_limits=True, enforce_wip_hard=True)
        r = self.add_child(self.member)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "wip_hard_blocked")
        self.assertFalse(CardParentLink.objects.exists())

    def test_create_child_without_a_user_fails_closed(self):
        """#1075: no caller resolves no board."""
        from rest_framework.exceptions import NotFound
        with self.assertRaises(NotFound):
            card_links.resolve_child_board(None, self.parent, self.child.pk)


class ChildBoardOptionsTests(AddChildFixture):
    def options(self, user, card=None):
        card = card or self.parent_card
        return client_for(user).get(f"/api/v1/boards/{card.board_id}/cards/{card.pk}/child-board-options/").json()

    def test_member_sees_qualifying_boards_only(self):
        make_board(self.admin, "Locked", first_column_creates=False)
        viewer_only = make_board(self.admin, "Viewer only")
        BoardMembership.objects.create(board=viewer_only, user=self.member, role=Role.VIEWER)
        other_parent = make_board(self.admin, "Parent 2", parent_tier=True)
        BoardMembership.objects.create(board=other_parent, user=self.member, role=Role.MEMBER)
        out = self.options(self.member)
        self.assertEqual(out, {
            "fixed_board": None, "default": None, "can_set_default": False,
            "boards": [{"id": self.child.pk, "name": "Delivery", "can_set_default": False}],
        })

    def test_admin_of_both_can_set_default_and_sees_it(self):
        self.set_default()
        out = self.options(self.admin)
        self.assertEqual(out["default"], {"id": self.child.pk, "name": "Delivery"})
        self.assertTrue(out["can_set_default"])
        self.assertEqual(out["boards"][0]["can_set_default"], True)

    def test_default_hidden_from_a_viewer_who_cannot_add_there(self):
        self.set_default()
        u = self.user_with("dv", parent=Role.MEMBER, child=Role.VIEWER)
        out = self.options(u)
        self.assertIsNone(out["default"])
        self.assertEqual(out["boards"], [])

    def test_default_that_stopped_qualifying_is_not_offered(self):
        self.set_default()
        Column.objects.filter(board=self.child, position=0).update(allow_card_creation=False)
        self.assertIsNone(self.options(self.admin)["default"])

    def test_fixed_board_is_hidden_when_the_viewer_cannot_open_it(self):
        CardParentLink.objects.create(parent=self.parent_card, child=add_card(self.child), created_by=self.admin)
        self.assertEqual(self.options(self.admin)["fixed_board"], {"hidden": False, "id": self.child.pk, "name": "Delivery"})
        u = self.user_with("fh", parent=Role.MEMBER)
        self.assertEqual(self.options(u)["fixed_board"], {"hidden": True})

    def test_absent_user_fails_closed(self):
        self.assertEqual(card_links.child_board_options_for_viewer(self.parent_card, None)["boards"], [])

    def test_outsider_gets_404(self):
        u = self.user_with("out")
        r = client_for(u).get(f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/")
        self.assertEqual(r.status_code, 404)


HOLD = 10


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class ConcurrentAddChildTests(TransactionTestCase):
    """Add child's rules are decided under its board and parent-card locks."""

    def setUp(self):
        self.admin = User.objects.create_user(username="dcbc_admin", password="pass")
        self.parent = make_board(self.admin, "Pipeline", parent_tier=True)
        self.child = make_board(self.admin, "Delivery")
        for b in (self.parent, self.child):
            BoardMembership.objects.create(board=b, user=self.admin, role=Role.ADMIN)
        self.parent_card = add_card(self.parent, "P")

    def _thread(self, name, fn, results):
        def run():
            try:
                results[name] = fn()
            except Exception as exc:  # surfaced by the assertions
                results[name] = exc
            finally:
                connections.close_all()

        t = threading.Thread(target=run, name=name)
        t.start()
        return t

    def _add(self, board=None, card=None):
        card = card or self.parent_card
        return client_for(self.admin).post(
            f"/api/v1/boards/{card.board_id}/cards/{card.pk}/children/",
            {"board_id": (board or self.child).pk, "title": "T"}, format="json",
        )

    def _race(self, second_name, second_fn):
        """Hold an Add child after its insert, prove ``second_fn`` waits, release."""
        paused, release, results = threading.Event(), threading.Event(), {}
        real = card_links._announce

        def held(*args, **kwargs):
            if threading.current_thread().name == "adder" and not paused.is_set():
                paused.set()
                release.wait(HOLD)
            return real(*args, **kwargs)

        with patch.object(card_links, "_announce", side_effect=held):
            adder = self._thread("adder", self._add, results)
            self.assertTrue(paused.wait(HOLD), "Add child never reached its hold")
            second = self._thread(second_name, second_fn, results)
            assert_blocked_on_lock(self, second, f"{second_name} did not wait for Add child")
            release.set()
            adder.join(HOLD)
            second.join(HOLD)
        for name in ("adder", second_name):
            if isinstance(results.get(name), Exception):
                self.fail(f"{name} raised {results[name]!r}")
        self.assertEqual(results["adder"].status_code, 201)
        return results[second_name]

    def test_target_flag_on_waits_for_add_child_and_is_refused(self):
        res = self._race("flipper", lambda: client_for(self.admin).patch(
            f"/api/v1/boards/{self.child.pk}/", {"cards_can_have_children": True}, format="json",
        ))
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Board.objects.get(pk=self.child.pk).cards_can_have_children)

    def test_two_add_childs_at_99_children_one_wins(self):
        col, lane = self.child.columns.order_by("position").first(), self.child.swimlanes.first()
        kids = Card.objects.bulk_create([
            Card(board=self.child, column=col, swimlane=lane, title=f"k{i}", position=i)
            for i in range(card_links.CHILDREN_PER_PARENT_LIMIT - 1)
        ])
        CardParentLink.objects.bulk_create([CardParentLink(parent=self.parent_card, child=k) for k in kids])
        res = self._race("second", self._add)
        self.assertEqual(res.json()["code"], "children_limit")
        self.assertEqual(CardParentLink.objects.filter(parent=self.parent_card).count(), card_links.CHILDREN_PER_PARENT_LIMIT)

    def test_add_child_racing_a_link_to_another_board_never_splits(self):
        other = make_board(self.admin, "Onboarding")
        BoardMembership.objects.create(board=other, user=self.admin, role=Role.ADMIN)
        other_card = add_card(other, "O")
        res = self._race("linker", lambda: client_for(self.admin).post(
            f"/api/v1/boards/{other.pk}/cards/{other_card.pk}/parent/",
            {"parent_id": self.parent_card.pk}, format="json",
        ))
        self.assertEqual(res.json()["code"], "children_on_other_board")
        self.assertEqual(
            set(CardParentLink.objects.filter(parent=self.parent_card).values_list("child__board_id", flat=True)),
            {self.child.pk},
        )


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class ConcurrentDefaultWriteTests(ConcurrentAddChildTests):
    """The default PATCH locks the target, so the target's flag flip serializes with it."""

    def test_default_write_and_target_flag_on_serialize(self):
        paused, release, results = threading.Event(), threading.Event(), {}
        from boards.serializers import BoardSerializer as BS
        real = BS.recheck_default_child_board_under_lock

        def held(ser, board):
            if threading.current_thread().name == "setter" and not paused.is_set():
                paused.set()
                release.wait(HOLD)
            return real(ser, board)

        with patch.object(BS, "recheck_default_child_board_under_lock", held):
            setter = self._thread("setter", lambda: client_for(self.admin).patch(
                f"/api/v1/boards/{self.parent.pk}/", {"default_child_board": self.child.pk}, format="json",
            ), results)
            self.assertTrue(paused.wait(HOLD))
            flipper = self._thread("flipper", lambda: client_for(self.admin).patch(
                f"/api/v1/boards/{self.child.pk}/", {"cards_can_have_children": True}, format="json",
            ), results)
            assert_blocked_on_lock(self, flipper, "the flip did not wait for the default write")
            release.set()
            setter.join(HOLD)
            flipper.join(HOLD)
        self.assertEqual(results["setter"].status_code, 200)
        self.assertEqual(results["flipper"].status_code, 400)
        self.assertFalse(Board.objects.get(pk=self.child.pk).cards_can_have_children)


from boards.models import BoardEvent  # noqa: E402


class BoardDeleteTests(AddChildFixture):
    def link(self, parent_card, child_card):
        CardParentLink.objects.create(parent=parent_card, child=child_card, created_by=self.admin)

    def delete(self, board, user=None):
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            return client_for(user or self.admin).delete(f"/api/v1/boards/{board.pk}/")

    def test_child_board_delete_records_a_count_on_each_parent_and_no_board_name(self):
        for i in range(3):
            self.link(self.parent_card, add_card(self.child, f"c{i}"))
        self.assertEqual(self.delete(self.child).status_code, 204)
        row = CardActivity.objects.get(card=self.parent_card, event_type="children_removed_board_deleted")
        self.assertEqual(row.to_value, "3")
        self.assertEqual(row.from_value, "")
        self.assertNotIn("Delivery", f"{row.to_value}{row.from_value}{row.item_text}")
        self.assertFalse(CardActivity.objects.filter(card=self.parent_card, event_type="child_unlinked").exists())

    def test_parent_board_delete_leaves_children_as_ordinary_cards(self):
        kid = add_card(self.child, "k")
        self.link(self.parent_card, kid)
        self.assertEqual(self.delete(self.parent).status_code, 204)
        self.assertTrue(Card.objects.filter(pk=kid.pk).exists())
        self.assertTrue(CardActivity.objects.filter(card=kid, event_type="parent_removed_board_deleted").exists())

    def test_deleting_the_default_clears_it_and_announces_board_updated(self):
        self.set_default()
        self.assertEqual(self.delete(self.child).status_code, 204)
        self.parent.refresh_from_db()
        self.assertIsNone(self.parent.default_child_board_id)
        self.assertTrue(self.parent.cards_can_have_children)
        ev = BoardEvent.objects.filter(board_id=self.parent.pk, event="board.updated").last()
        self.assertIsNotNone(ev)
        self.assertIsNone(ev.data["default_child_board"])

    def test_single_card_delete_still_records_a_plain_unlink(self):
        kid = add_card(self.child, "k")
        self.link(self.parent_card, kid)
        with patch(PATCH_BROADCAST):
            client_for(self.admin).delete(f"/api/v1/boards/{self.child.pk}/cards/{kid.pk}/")
        self.assertTrue(CardActivity.objects.filter(card=self.parent_card, event_type="child_unlinked").exists())


class DeleteImpactTests(AddChildFixture):
    def impact(self, user, board):
        return client_for(user).get(f"/api/v1/boards/{board.pk}/delete-impact/")

    def test_counts_and_names_only_visible_parent_boards(self):
        secret = make_board(self.admin, "Secret", parent_tier=True)
        self.link_pair(self.parent_card, add_card(self.child, "a"))
        self.link_pair(add_card(secret, "s"), add_card(self.child, "b"))
        owner_view = self.impact(self.admin, self.child).json()
        self.assertEqual(owner_view["child_cards"], 2)
        self.assertEqual([b["name"] for b in owner_view["parent_boards"]], ["Pipeline", "Secret"])
        self.assertFalse(owner_view["hidden_parent_boards"])
        self.assertEqual(self.impact(self.admin, self.parent).json()["parent_cards"], 1)

    def link_pair(self, p, c):
        CardParentLink.objects.create(parent=p, child=c, created_by=self.admin)

    def test_hidden_parent_board_is_never_named(self):
        owner = User.objects.create_user(username="dcb_owner2", password="pass")
        mine = make_board(owner, "Mine")
        BoardMembership.objects.create(board=mine, user=owner, role=Role.ADMIN)
        self.link_pair(self.parent_card, add_card(mine, "x"))
        out = self.impact(owner, mine).json()
        self.assertEqual(out, {"child_cards": 1, "parent_boards": [], "hidden_parent_boards": True, "parent_cards": 0})

    def test_board_admin_who_is_not_the_owner_is_refused(self):
        a = self.user_with("nonowner", child=Role.ADMIN)
        self.assertEqual(self.impact(a, self.child).status_code, 403)


class DefaultChildBoardOptionsTests(DefaultChildBoardFixture):
    """``GET /boards/{id}/default-child-board-options/``: the Rules select's data."""

    def options(self, user, board):
        return client_for(user).get(f"/api/v1/boards/{board.pk}/default-child-board-options/")

    def test_lists_only_qualifying_boards_the_viewer_administers(self):
        other = User.objects.create_user(username="dcb_other", password="pass")
        member_only = make_board(other, "Member only")
        BoardMembership.objects.create(board=member_only, user=self.admin, role=Role.MEMBER)
        parent_tier = make_board(self.admin, "Parent tier", parent_tier=True)
        no_create = make_board(self.admin, "No create", first_column_creates=False)
        for b in (parent_tier, no_create):
            BoardMembership.objects.create(board=b, user=self.admin, role=Role.ADMIN)
        r = self.options(self.admin, self.parent)
        self.assertEqual(r.status_code, 200)
        names = [b["name"] for b in r.json()["boards"]]
        self.assertIn("Delivery", names)
        self.assertNotIn("Pipeline", names)
        self.assertNotIn("Member only", names)
        self.assertNotIn("Parent tier", names)
        self.assertNotIn("No create", names)

    def test_members_are_refused_and_outsiders_get_404(self):
        member = self.user_with("om", parent=Role.MEMBER, child=Role.ADMIN)
        self.assertEqual(self.options(member, self.parent).status_code, 403)
        outsider = self.user_with("oo")
        self.assertEqual(self.options(outsider, self.parent).status_code, 404)

    def test_no_viewer_fails_closed(self):
        self.assertEqual(card_links.default_child_board_options_for_admin(self.parent, None), [])


class AddChildSchemaTests(TestCase):
    def test_post_children_declares_its_body_and_responses(self):
        """Schema-fuzz only exercises a write whose body and statuses are declared."""
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        path = next(p for p in schema["paths"] if p.endswith("/cards/{id}/children/"))
        post = schema["paths"][path]["post"]
        self.assertIn("requestBody", post)
        self.assertTrue({"201", "400", "403", "404", "409"} <= set(post["responses"]))
        self.assertIn("get", schema["paths"][path])


class AbsentViewerGuardTests(DefaultChildBoardFixture):
    """#1075: a read built without its viewer names nothing and never raises."""

    def test_blockers_with_no_viewer_hide_every_source(self):
        self.set_default()
        out = card_links.default_child_blockers_for_viewer(self.child, None)
        self.assertEqual(out["default_of"], [{"hidden": True}])

    def test_delete_impact_with_no_viewer_names_no_board(self):
        lane = Swimlane.objects.get(board=self.parent)
        p = Card.objects.create(board=self.parent, column=self.parent.columns.first(), swimlane=lane, title="P")
        clane = Swimlane.objects.get(board=self.child)
        c = Card.objects.create(board=self.child, column=self.child.columns.first(), swimlane=clane, title="C")
        CardParentLink.objects.create(parent=p, child=c, created_by=self.admin)
        out = card_links.board_delete_impact_for_viewer(self.child, None)
        self.assertEqual(out["parent_boards"], [])
        self.assertTrue(out["hidden_parent_boards"])

    def test_add_child_rechecks_the_target_role_under_the_lock(self):
        """A member demoted below member between the lookup and the lock creates nothing."""
        from rest_framework.exceptions import NotFound

        member = self.user_with("rl", parent=Role.MEMBER, child=Role.MEMBER)
        lane = Swimlane.objects.get(board=self.parent)
        p = Card.objects.create(board=self.parent, column=self.parent.columns.first(), swimlane=lane, title="P")
        original = card_links.resolve_child_board

        def resolve_then_demote(*a, **k):
            out = original(*a, **k)
            BoardMembership.objects.filter(board=self.child, user=member).update(role=Role.VIEWER)
            return out

        with patch.object(card_links, "resolve_child_board", resolve_then_demote):
            with self.assertRaises(NotFound):
                card_links.create_child(
                    user=member, parent=p, parent_role=Role.MEMBER, board_id=self.child.pk,
                    make_card=lambda **kw: self.fail("must not create"),
                )
        self.assertFalse(Card.objects.filter(board=self.child).exists())
