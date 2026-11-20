"""The child side of card links (#1104): ``Card.parent``, the picker reads, the pings.

``parent`` is resolved per viewer and is opt-in per call: present on the reads
that name a viewer (``/full/``, the card list, retrieve, ``archived``), absent
from write responses and from every frame, feed row and webhook, which are
built with the actor's request and so cannot name the reader (#1075 class).
"""

import json
import os
import types
from unittest import mock, skipUnless

from django.contrib import admin as django_admin
from django.core.cache import cache
from django.db import transaction
from django.test import RequestFactory, TestCase
from django.utils import timezone

from boards.admin import CardAdmin
from boards.models import BoardEvent, BoardMembership, Card, CardParentLink
from boards.serializers import ParentBoardOptionSerializer, ParentCandidateSerializer
from boards.services import card_links
from boards.services.feed import feed_queryset, serialize_feed_rows
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user
from boards.tests.test_card_parent_links import Role, _LinkFixture, _board_with_card
from boards.views.card_query import CardQueryRateThrottle

VISIBLE_KEYS = {
    "hidden", "id", "title", "board_id", "board_name", "column_id", "column_name",
    "swimlane_id", "swimlane_name", "archived",
}


class _ParentFixture(_LinkFixture):
    def _setup_linked(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child, created_by=self.owner)
        self.unlinked = _make_card(self.col_c, self.lane_c, title="Loose")

    def _full_cards(self, user, board=None):
        res = self._client(user).get(f"/api/v1/boards/{(board or self.cboard).pk}/full/")
        self.assertEqual(res.status_code, 200, res.content)
        return {c["id"]: c for c in res.json()["cards"]}


class ParentFieldReadTests(_ParentFixture, TestCase):
    def setUp(self):
        self._setup_linked()

    def test_visible_shape_has_exactly_the_documented_keys(self):
        viewer = self._user("pf_vis", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        cards = self._full_cards(viewer)
        parent = cards[self.child.pk]["parent"]
        self.assertEqual(set(parent), VISIBLE_KEYS)
        self.assertEqual(parent, {
            "hidden": False, "id": self.parent.pk, "title": self.parent.title,
            "board_id": self.pboard.pk, "board_name": self.pboard.name,
            "column_id": self.parent.column_id, "column_name": self.parent.column.name,
            "swimlane_id": self.parent.swimlane_id, "swimlane_name": self.parent.swimlane.name,
            "archived": False,
        })
        self.assertIsNone(cards[self.unlinked.pk]["parent"])

    def test_hidden_shape_is_only_the_discriminator(self):
        outsider = self._user("pf_hid", child_role=Role.MEMBER)
        cards = self._full_cards(outsider)
        self.assertEqual(cards[self.child.pk]["parent"], {"hidden": True})
        self.assertNotIn("SECRET-P", json.dumps(cards))

    def test_archived_parent_is_visible_and_marked(self):
        Card.objects.filter(pk=self.parent.pk).update(archived_at=timezone.now())
        self.assertTrue(self._full_cards(self.owner)[self.child.pk]["parent"]["archived"])

    def test_site_admin_sees_the_parent(self):
        admin = _make_user("pf_site", can_access_all_content=True)
        self.assertFalse(self._full_cards(admin)[self.child.pk]["parent"]["hidden"])

    def test_losing_the_parent_board_hides_it_on_the_next_read(self):
        u = self._user("pf_rev", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        self.assertFalse(self._full_cards(u)[self.child.pk]["parent"]["hidden"])
        BoardMembership.objects.filter(board=self.pboard, user=u).delete()
        self.assertEqual(self._full_cards(u)[self.child.pk]["parent"], {"hidden": True})

    def test_present_on_list_retrieve_and_archived(self):
        client = self._client(self.owner)
        base = f"/api/v1/boards/{self.cboard.pk}/cards/"
        listed = {c["id"]: c for c in client.get(base).json()}
        self.assertEqual(listed[self.child.pk]["parent"]["id"], self.parent.pk)
        self.assertIsNone(listed[self.unlinked.pk]["parent"])
        self.assertEqual(client.get(f"{base}{self.child.pk}/").json()["parent"]["id"], self.parent.pk)
        Card.objects.filter(pk=self.child.pk).update(archived_at=timezone.now())
        archived = client.get(f"{base}archived/").json()["results"]
        self.assertEqual(archived[0]["parent"]["id"], self.parent.pk)

    def test_absent_from_write_responses(self):
        client = self._client(self.owner)
        base = f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/"
        lane2 = _make_swimlane(self.cboard, name="lane two")
        responses = {
            "patch": client.patch(base, {"title": "renamed"}, format="json"),
            "move": client.post(f"{base}move/", {
                "column_id": self.col_c.pk, "swimlane_id": lane2.pk, "position": 0,
            }, format="json"),
            "block": client.post(f"{base}block/", {"reason": "waiting"}, format="json"),
            "archive": client.post(f"{base}archive/"),
        }
        for name, res in responses.items():
            self.assertLess(res.status_code, 300, (name, res.content))
            self.assertNotIn("parent", res.json(), name)

    def test_parent_tier_cards_read_null(self):
        self.assertIsNone(self._full_cards(self.owner, self.pboard)[self.parent.pk]["parent"])


class ParentEventScopingTests(_ParentFixture, TestCase):
    """Frames carry no ``parent``; ``card.parent_changed`` is ids only, child board only."""

    def setUp(self):
        self._setup_linked()
        self.client = self._client(self.owner)
        self.pbase = f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/"

    def _pings(self, board=None):
        return list(
            BoardEvent.objects.filter(board_id=(board or self.cboard).pk, event="card.parent_changed")
            .values_list("data", flat=True)
        )

    def _all_pings(self):
        return list(BoardEvent.objects.filter(event="card.parent_changed"))

    def test_child_frames_feed_and_webhook_carry_no_parent(self):
        lane2 = _make_swimlane(self.cboard, name="lane two")
        base = f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/"
        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(base, {"title": "Task renamed"}, format="json")
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(f"{base}move/", {
                "column_id": self.col_c.pk, "swimlane_id": lane2.pk, "position": 0,
            }, format="json")
        rows = list(BoardEvent.objects.filter(board_id=self.cboard.pk).order_by("id"))
        self.assertEqual({r.event for r in rows} & {"card.updated", "card.moved"}, {"card.updated", "card.moved"})
        for r in rows:
            self.assertNotIn("parent", r.data)
            self.assertNotIn("SECRET-P", json.dumps(r.data))
        feed = list(feed_queryset(self.cboard.pk, role="viewer", reader_id=None).order_by("id"))
        rendered = json.dumps(serialize_feed_rows(self.cboard.pk, feed, role="viewer", reader_id=None))
        self.assertNotIn("SECRET-P", rendered)
        self.assertNotIn('"parent"', rendered)

    def test_rename_pings_the_child_board_ids_only(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(self.pbase, {"title": "Initiative renamed"}, format="json")
        self.assertEqual(self._pings(), [{"card_ids": [self.child.pk]}])
        self.assertEqual(self._pings(self.pboard), [])

    def test_unchanged_title_does_not_ping(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(self.pbase, {"description": "more", "title": self.parent.title}, format="json")
        self.assertEqual(self._all_pings(), [])

    def test_column_and_lane_moves_ping_and_reorder_does_not(self):
        col2 = _make_column(self.pboard, name="col two", order=5)
        lane2 = _make_swimlane(self.pboard, name="lane two")
        _make_card(self.parent.column, self.parent.swimlane, title="sibling")
        move = f"{self.pbase}move/"
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(move, {
                "column_id": self.parent.column_id, "swimlane_id": self.parent.swimlane_id, "position": 1,
            }, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._all_pings(), [])
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(move, {"column_id": col2.pk, "swimlane_id": self.parent.swimlane_id, "position": 0}, format="json")
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(move, {"column_id": col2.pk, "swimlane_id": lane2.pk, "position": 0}, format="json")
        self.assertEqual(self._pings(), [{"card_ids": [self.child.pk]}] * 2)

    def test_archive_and_unarchive_ping(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.post(f"{self.pbase}archive/").status_code, 200)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.post(f"{self.pbase}unarchive/").status_code, 200)
        self.assertEqual(self._pings(), [{"card_ids": [self.child.pk]}] * 2)

    def test_child_tier_writes_never_ping(self):
        base = f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/"
        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(base, {"title": "child renamed"}, format="json")
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(f"{base}archive/")
        self.assertEqual(self._all_pings(), [])

    def test_rolled_back_write_sends_nothing(self):
        with mock.patch("boards.broadcast.broadcast_board_event") as sent:
            with self.captureOnCommitCallbacks(execute=True), self.assertRaises(RuntimeError):
                with transaction.atomic():
                    card_links.announce_parent_changed(self.parent.pk, self.pboard, actor_id=self.owner.pk)
                    raise RuntimeError
        sent.assert_not_called()
        self.assertEqual(self._all_pings(), [])

    def test_ping_publishes_on_commit_only(self):
        with mock.patch("boards.broadcast.broadcast_board_event") as sent:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                card_links.announce_parent_changed(self.parent.pk, self.pboard, actor_id=self.owner.pk)
            sent.assert_not_called()
            for cb in callbacks:
                cb()
        self.assertEqual(sent.call_count, 1)

    def _admin_save(self, changed, **attrs):
        request = RequestFactory().post("/")
        request.user = self.owner
        card = Card.objects.get(pk=self.parent.pk)
        for k, v in attrs.items():
            setattr(card, k, v)
        form = types.SimpleNamespace(changed_data=changed)
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            CardAdmin(Card, django_admin.site).save_model(request, card, form, True)

    def test_admin_edits_ping_only_for_shown_fields(self):
        self._admin_save(["description"], description="x")
        self.assertEqual(self._all_pings(), [])
        self._admin_save(["title"], title="Admin renamed")
        self._admin_save(["archived_at"], archived_at=timezone.now())
        self.assertEqual(self._pings(), [{"card_ids": [self.child.pk]}] * 2)


@skipUnless(os.environ.get("MCP_SERVER_ENABLED", "").lower() == "true", "mcp_server needs MCP_SERVER_ENABLED=true")
class ParentPingMcpTests(_ParentFixture, TestCase):
    def setUp(self):
        self._setup_linked()

    def _call(self, fn, **kwargs):
        with mock.patch("mcp_server.tools.get_current_user", return_value=self.owner):
            with self.captureOnCommitCallbacks(execute=True):
                return fn(**kwargs)

    def test_mcp_rename_move_and_archive_ping(self):
        from mcp_server import tools

        col2 = _make_column(self.pboard, name="mcp col", order=5)
        self._call(tools.update_card, card_id=self.parent.pk, title="Renamed over MCP")
        self._call(tools.move_card, card_id=self.parent.pk, to_column_id=col2.pk)
        self._call(tools.archive_card, card_id=self.parent.pk)
        pings = list(
            BoardEvent.objects.filter(event="card.parent_changed").values_list("board_id", "data")
        )
        self.assertEqual(pings, [(self.cboard.pk, {"card_ids": [self.child.pk]})] * 3)


class ParentBoardsTests(_LinkFixture, TestCase):
    def setUp(self):
        self._setup_boards()
        self.url = f"/api/v1/boards/{self.cboard.pk}/parent-boards/"

    def test_no_access_is_404_and_below_member_is_403(self):
        self.assertEqual(self._client(_make_user("pb_none")).get(self.url).status_code, 404)
        for role in (Role.VIEWER, Role.COLLABORATOR):
            u = self._user(f"pb_{role}", child_role=role, parent_role=Role.MEMBER)
            res = self._client(u).get(self.url)
            self.assertEqual(res.status_code, 403, role)
            self.assertEqual(res.json(), {"detail": "You do not have permission to perform this action."})

    def test_a_parent_board_gets_no_options(self):
        res = self._client(self.owner).get(f"/api/v1/boards/{self.pboard.pk}/parent-boards/")
        self.assertEqual(res.json(), {"results": []})

    def test_lists_parent_boards_with_a_write_role_ordered_by_name(self):
        u = self._user("pb_m", parent_role=Role.MEMBER, child_role=Role.MEMBER)
        b_admin = _make_board(self.owner, name="alpha portfolio", cards_can_have_children=True)
        BoardMembership.objects.create(board=b_admin, user=u, role=Role.ADMIN)
        b_viewer = _make_board(self.owner, name="Viewer portfolio", cards_can_have_children=True)
        BoardMembership.objects.create(board=b_viewer, user=u, role=Role.VIEWER)
        b_plain = _make_board(self.owner, name="Plain", cards_can_have_children=False)
        BoardMembership.objects.create(board=b_plain, user=u, role=Role.ADMIN)
        _make_board(self.owner, name="Not mine", cards_can_have_children=True)
        res = self._client(u).get(self.url)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["results"], [
            {"id": b_admin.pk, "name": "alpha portfolio"},
            {"id": self.pboard.pk, "name": "Portfolio"},
        ])
        self.assertEqual(set(res.json()["results"][0]), set(ParentBoardOptionSerializer().fields))


class ParentCandidatesTests(_LinkFixture, TestCase):
    def setUp(self):
        cache.clear()
        self._setup_boards()
        self.member = self._user("pc_m", parent_role=Role.MEMBER, child_role=Role.MEMBER)
        self.client = self._client(self.member)
        self.url = f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/parent-candidates/"
        self.pcol, self.plane = self.parent.column, self.parent.swimlane

    def _get(self, client=None, **params):
        return (client or self.client).get(self.url, params)

    def _results(self, **params):
        res = self._get(**params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["results"]

    def test_every_unlinkable_board_is_the_same_404(self):
        no_role = _make_board(self.owner, name="Hidden", cards_can_have_children=True)
        viewer_only = _make_board(self.owner, name="Viewer only", cards_can_have_children=True)
        BoardMembership.objects.create(board=viewer_only, user=self.member, role=Role.VIEWER)
        plain = _make_board(self.owner, name="Plain")
        BoardMembership.objects.create(board=plain, user=self.member, role=Role.ADMIN)
        bodies = set()
        for board_id in (999999, no_role.pk, viewer_only.pk, plain.pk, self.cboard.pk):
            res = self._get(board=board_id, search="Init")
            self.assertEqual(res.status_code, 404, board_id)
            bodies.add(res.content)
        self.assertEqual(len(bodies), 1, bodies)

    def test_board_param_is_validated_after_access(self):
        outsider = self._client(_make_user("pc_out"))
        self.assertEqual(self._get(outsider).status_code, 404)
        self.assertEqual(self._get(outsider, board="x").status_code, 404)
        for bad in ({}, {"board": "x"}, {"board": "-1"}, {"board": "1" * 19}):
            res = self._get(**bad, search="Init")
            self.assertEqual(res.status_code, 400, bad)
            self.assertIn("board", res.json())
        self.assertEqual(self._get(board=self.pboard.pk, search="x" * 201).status_code, 400)

    def test_role_and_idor(self):
        viewer = self._user("pc_v", parent_role=Role.MEMBER, child_role=Role.VIEWER)
        self.assertEqual(self._get(self._client(viewer), board=self.pboard.pk, search="Init").status_code, 403)
        other_board, other = _board_with_card(self.owner, parent_tier=False, name="Other", title="o")
        res = self.client.get(
            f"/api/v1/boards/{self.cboard.pk}/cards/{other.pk}/parent-candidates/",
            {"board": self.pboard.pk, "search": "Init"},
        )
        self.assertEqual(res.status_code, 404)

    def test_short_search_returns_nothing(self):
        for search in ("", " ", "I"):
            self.assertEqual(self._results(board=self.pboard.pk, search=search), [])

    def test_title_search_shape_and_assignee(self):
        Card.objects.filter(pk=self.parent.pk).update(assignee=self.owner)
        rows = self._results(board=self.pboard.pk, search="secret-p")
        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]), set(ParentCandidateSerializer().fields))
        self.assertEqual(rows[0]["assignee"]["id"], self.owner.pk)
        self.assertEqual(rows[0]["column_name"], self.pcol.name)
        self.assertIsNone(rows[0]["disabled_reason"])

    def test_digits_match_the_id_first(self):
        target = _make_card(self.pcol, self.plane, title="zzz target")
        _make_card(self.pcol, self.plane, title=f"aaa mentions {target.pk}")
        rows = self._results(board=self.pboard.pk, search=str(target.pk))
        self.assertEqual(rows[0]["id"], target.pk)
        self.assertEqual(len(rows), 2)
        # An id on another board is not returned.
        self.assertEqual(self._results(board=self.pboard.pk, search=str(self.child.pk)), [])

    def test_archived_excluded_and_limit_20(self):
        Card.objects.filter(pk=self.parent.pk).update(archived_at=timezone.now())
        self.assertEqual(self._results(board=self.pboard.pk, search="SECRET"), [])
        for i in range(25):
            _make_card(self.pcol, self.plane, title=f"Bulk {i:02d}")
        rows = self._results(board=self.pboard.pk, search="Bulk")
        self.assertEqual([r["title"] for r in rows], [f"Bulk {i:02d}" for i in range(20)])

    def test_disabled_reasons_and_precedence(self):
        other_board, other_child = _board_with_card(self.owner, parent_tier=False, name="Sales", title="oc")
        elsewhere = _make_card(self.pcol, self.plane, title="Initiative elsewhere")
        CardParentLink.objects.create(parent=elsewhere, child=other_child)
        full = _make_card(self.pcol, self.plane, title="Initiative full")
        CardParentLink.objects.create(parent=full, child=_make_card(self.col_c, self.lane_c, title="c2"))
        with mock.patch.object(card_links, "CHILDREN_PER_PARENT_LIMIT", 1):
            rows = {r["id"]: r for r in self._results(board=self.pboard.pk, search="Initiative")}
        self.assertEqual(rows[elsewhere.pk]["disabled_reason"], "children_on_other_board")
        self.assertIsNone(rows[elsewhere.pk]["children_board_name"])
        self.assertEqual(rows[full.pk]["disabled_reason"], "children_limit")
        self.assertIsNone(rows[self.parent.pk]["disabled_reason"])
        # With a role on that other board, its name is given.
        BoardMembership.objects.create(board=other_board, user=self.member, role=Role.VIEWER)
        rows = {r["id"]: r for r in self._results(board=self.pboard.pk, search="Initiative")}
        self.assertEqual(rows[elsewhere.pk]["children_board_name"], "Sales")

    def test_parent_tier_card_gets_no_candidates(self):
        url = f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/parent-candidates/"
        second = _make_board(self.owner, name="Second portfolio", cards_can_have_children=True)
        res = self._client(self.owner).get(url, {"board": second.pk, "search": "Init"})
        self.assertEqual(res.json(), {"results": []})

    def test_throttled_by_the_card_query_scope(self):
        with mock.patch.object(CardQueryRateThrottle, "get_rate", return_value="2/min"):
            for _ in range(2):
                self.assertEqual(self._get(board=self.pboard.pk, search="Init").status_code, 200)
            self.assertEqual(self._get(board=self.pboard.pk, search="Init").status_code, 429)


class ParentSchemaTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from drf_spectacular.generators import SchemaGenerator

        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def test_parent_is_optional_read_only_and_nullable(self):
        comps = self.schema["components"]["schemas"]
        card = comps["Card"]
        self.assertIn("parent", card["properties"])
        self.assertNotIn("parent", card.get("required", []))
        self.assertTrue(card["properties"]["parent"]["nullable"])
        for name in ("CardRequest", "PatchedCardRequest"):
            self.assertNotIn("parent", comps[name]["properties"], name)

    def test_values_validate_against_the_component(self):
        import jsonschema

        prop = dict(self.schema["components"]["schemas"]["Card"]["properties"]["parent"])
        # OpenAPI 3.0 ``nullable`` is not JSON Schema; express it the 3.1 way.
        prop.pop("nullable")
        prop.pop("readOnly", None)
        prop["oneOf"] = [*prop["oneOf"], {"type": "null"}]
        visible = {
            "hidden": False, "id": 1, "title": "t", "board_id": 2, "board_name": "b",
            "column_id": 3, "column_name": "c", "swimlane_id": 4, "swimlane_name": "s",
            "archived": False,
        }
        for value in (None, {"hidden": True}, visible):
            jsonschema.validate(value, prop)
        for bad in ({"hidden": True, "title": "leak"}, {"hidden": False}, {}):
            with self.assertRaises(jsonschema.ValidationError):
                jsonschema.validate(bad, prop)

    def test_picker_endpoints_are_published(self):
        paths = self.schema["paths"]
        self.assertIn("/api/v1/boards/{id}/parent-boards/", paths)
        self.assertIn("/api/v1/boards/{board_pk}/cards/{id}/parent-candidates/", paths)
