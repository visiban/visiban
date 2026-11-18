"""Board ``cards_can_have_children`` flag and the two-tier predicate (#2208, part 1).

The flag is a public board field (every member reads it, so it is not in
``ADMIN_ONLY_BOARD_FIELDS``) that only a board admin or site admin can write,
like every board setting. Covers the default, the per-role write gate, the
``board.updated`` frame and feed row, the predicate truth table, and that the
flip-refusal hook is wired into the API write path.
"""
import importlib
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardEvent, BoardMembership
from boards.services import card_links
from boards.serializers import PublicBoardSerializer

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
Role = BoardMembership.Role


class CardsCanHaveChildrenApiTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="cchc_admin", password="pass")
        self.board = Board.objects.create(name="Parent tier", owner=self.admin)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=Role.ADMIN)
        self.url = f"/api/v1/boards/{self.board.pk}/"

    def _client(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def _member(self, role):
        u = User.objects.create_user(username=f"cchc_{role}", password="pass")
        BoardMembership.objects.create(board=self.board, user=u, role=role)
        return self._client(u)

    def _patch(self, client, value=True):
        with patch(PATCH_BROADCAST):
            return client.patch(self.url, {"cards_can_have_children": value}, format="json")

    def test_defaults_false_on_every_read_surface_for_every_role(self):
        for role in (Role.VIEWER, Role.MEMBER, Role.ADMIN):
            client = self._member(role) if role != Role.ADMIN else self._client(self.admin)
            for url in (self.url, f"{self.url}full/"):
                with self.subTest(role=role, url=url):
                    self.assertIs(client.get(url).json()["cards_can_have_children"], False)
        listed = self._client(self.admin).get("/api/v1/boards/").json()
        rows = listed["results"] if isinstance(listed, dict) else listed
        self.assertIs(rows[0]["cards_can_have_children"], False)

    def test_admin_can_set_and_clear(self):
        client = self._client(self.admin)
        self.assertEqual(self._patch(client, True).status_code, 200)
        self.board.refresh_from_db()
        self.assertTrue(self.board.cards_can_have_children)
        self.assertIs(client.get(f"{self.url}full/").json()["cards_can_have_children"], True)
        self.assertEqual(self._patch(client, False).status_code, 200)
        self.board.refresh_from_db()
        self.assertFalse(self.board.cards_can_have_children)

    def test_site_admin_can_write(self):
        site_admin = User.objects.create_user(username="cchc_site", password="pass", is_site_admin=True, can_access_all_content=True)
        self.assertEqual(self._patch(self._client(site_admin), True).status_code, 200)
        self.board.refresh_from_db()
        self.assertTrue(self.board.cards_can_have_children)

    def test_non_admins_get_403_and_nothing_changes(self):
        for role in (Role.VIEWER, Role.MEMBER):
            with self.subTest(role=role):
                self.assertEqual(self._patch(self._member(role), True).status_code, 403)
        self.board.refresh_from_db()
        self.assertFalse(self.board.cards_can_have_children)

    def test_put_and_invalid_body_from_non_admin_are_403_not_400(self):
        client = self._member(Role.MEMBER)
        with patch(PATCH_BROADCAST):
            put = client.put(self.url, {"name": "x", "cards_can_have_children": True}, format="json")
            bad = client.patch(self.url, {"cards_can_have_children": "maybe"}, format="json")
        self.assertEqual(put.status_code, 403)
        self.assertEqual(bad.status_code, 403)

    def test_create_accepts_the_flag_and_creator_becomes_admin(self):
        """Create is open to any signed-in user; they administer the new board, so no privilege gain."""
        with patch(PATCH_BROADCAST):
            r = self._client(self.admin).post("/api/v1/boards/", {"name": "New parent", "cards_can_have_children": True}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIs(r.json()["cards_can_have_children"], True)

    def test_non_member_cannot_write(self):
        stranger = User.objects.create_user(username="cchc_stranger", password="pass")
        self.assertEqual(self._patch(self._client(stranger), True).status_code, 404)

    def test_non_boolean_is_400(self):
        r = self._patch(self._client(self.admin), "maybe")
        self.assertEqual(r.status_code, 400)

    def test_full_serializer_does_not_write_it(self):
        from boards.serializers import BoardFullSerializer

        self.assertIn("cards_can_have_children", BoardFullSerializer.Meta.read_only_fields)

    def test_public_share_payload_does_not_carry_it(self):
        self.assertNotIn("cards_can_have_children", PublicBoardSerializer(self.board).data)

    def test_board_updated_frame_carries_it_deferred_to_commit(self):
        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                r = self._client(self.admin).patch(self.url, {"cards_can_have_children": True}, format="json")
            self.assertEqual(r.status_code, 200)
            mock_broadcast.assert_not_called()
            for cb in callbacks:
                cb()
        payloads = [c[0][2] for c in mock_broadcast.call_args_list if c[0][1] == "board.updated"]
        self.assertEqual(len(payloads), 1)
        self.assertIs(payloads[0]["cards_can_have_children"], True)

    def test_feed_row_serves_it_to_a_viewer_unfiltered(self):
        """Public field: not in ADMIN_ONLY_BOARD_FIELDS, so Rule 8 leaves it in the feed
        and webhook payload (a delivery is the feed row a viewer reads)."""
        from boards.broadcast import ADMIN_ONLY_BOARD_FIELDS

        self.assertNotIn("cards_can_have_children", ADMIN_ONLY_BOARD_FIELDS)
        BoardEvent.objects.create(
            board_id=self.board.id, event="board.updated", actor_id=self.admin.id,
            data={"id": self.board.id, "cards_can_have_children": True},
        )
        resp = self._member(Role.VIEWER).get(f"{self.url}events/")
        self.assertEqual(resp.status_code, 200)
        rows = resp.data["results"] if isinstance(resp.data, dict) and "results" in resp.data else resp.data
        self.assertIs(rows[0]["data"]["cards_can_have_children"], True)

    def test_flip_refusal_hook_is_wired_into_the_write_path(self):
        client = self._client(self.admin)
        with patch("boards.services.card_links.links_blocking_flag_flip", return_value=2) as hook:
            r = self._patch(client, True)
        self.assertEqual(r.status_code, 400)
        self.assertIn("cards_can_have_children", r.json())
        hook.assert_called_once()
        self.board.refresh_from_db()
        self.assertFalse(self.board.cards_can_have_children)

    def test_unchanged_value_never_consults_the_hook(self):
        with patch("boards.services.card_links.links_blocking_flag_flip", return_value=2) as hook:
            r = self._patch(self._client(self.admin), False)
        self.assertEqual(r.status_code, 200)
        hook.assert_not_called()


class LinkAllowedTruthTableTests(TestCase):
    def test_only_parent_tier_over_child_tier_is_allowed(self):
        owner = User.objects.create_user(username="cchc_tt", password="pass")
        parent = Board.objects.create(name="P", owner=owner, cards_can_have_children=True)
        child = Board.objects.create(name="C", owner=owner, cards_can_have_children=False)
        other_parent = Board.objects.create(name="P2", owner=owner, cards_can_have_children=True)
        cases = [
            (parent, child, True),
            (child, parent, False),
            (parent, other_parent, False),
            (child, child, False),
            (parent, parent, False),
        ]
        for p, c, expected in cases:
            with self.subTest(parent=p.name, child=c.name):
                self.assertIs(card_links.link_allowed(p, c), expected)

    def test_hook_refuses_a_flip_under_live_links(self):
        # Filled in by #1104: a flip that would invalidate an existing link
        # is refused, and an unchanged value or a board with no links is not.
        from rest_framework.exceptions import ValidationError

        from boards.models import CardParentLink
        from boards.tests.conftest import _make_card, _make_column, _make_swimlane

        owner = User.objects.create_user(username="cchc_hook", password="pass")
        p = Board.objects.create(name="P", owner=owner, cards_can_have_children=True)
        c = Board.objects.create(name="C", owner=owner)
        lone = Board.objects.create(name="L", owner=owner)
        self.assertEqual(card_links.links_blocking_flag_flip(lone, True), 0)
        card_links.check_flag_flip(lone, True)  # no links: no raise
        pc = _make_card(_make_column(p), _make_swimlane(p))
        cc = _make_card(_make_column(c), _make_swimlane(c))
        CardParentLink.objects.create(parent=pc, child=cc)
        card_links.check_flag_flip(p, True)  # unchanged value: no raise
        for board, value in ((p, False), (c, True)):
            with self.subTest(board=board.name), self.assertRaises(ValidationError) as ctx:
                card_links.check_flag_flip(board, value)
            self.assertIn("cards_can_have_children", ctx.exception.detail)


class CardsCanHaveChildrenMigrationTests(TestCase):
    def test_migration_is_a_single_add_field_with_db_default(self):
        m = importlib.import_module("boards.migrations.0114_board_cards_can_have_children")
        ops = m.Migration.operations
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0].__class__.__name__, "AddField")
        self.assertIs(ops[0].field.db_default, False)

    def test_existing_rows_read_false_from_the_database_default(self):
        owner = User.objects.create_user(username="cchc_mig", password="pass")
        self.assertFalse(Board.objects.create(name="X", owner=owner).cards_can_have_children)
