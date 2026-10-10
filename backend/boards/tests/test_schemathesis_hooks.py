"""Tests for schemathesis_hooks (#1120).

The hook seeds real board/card/etc ids into schemathesis's path-parameter
generation so the `backend-schema-fuzz` job exercises real 200-path logic
instead of mostly 404s. Covers both halves: `_load_real_ids()` (the DB
lookups, including its graceful-degradation-to-None behavior) and
`map_path_parameters()` (the hook itself, which only overrides a parameter
when both a mapping and a real value exist).
"""
import importlib
from types import SimpleNamespace

from django.test import TestCase

from django.core.files.base import ContentFile

from accounts.models import PersonalAccessToken
from boards.models import (
    BoardMembership,
    Card,
    CardAttachment,
    CardChecklist,
    CardComment,
    CustomFieldDefinition,
    Label,
    SavedFilter,
    SwimlaneCustomFieldDefinition,
)
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user
from groups.models import Group, GroupInviteLink, GroupLabel


def _fake_context(path, method="GET"):
    return SimpleNamespace(operation=SimpleNamespace(path=path, method=method))


def _hooks():
    # Imported lazily (not at module scope) because `schemathesis_hooks` runs a
    # DB query at import time (`_IDS = _load_real_ids()`, module.py:151) — fine
    # under `st run`, which loads it once at process startup, but pytest-django
    # blocks DB access during test collection, before any test's transaction
    # is open. Deferring the import into a TestCase method (already inside a
    # DB-allowed transaction) sidesteps that; `importlib` caches it either way,
    # so this costs nothing beyond the first call in the whole test run.
    return importlib.import_module("schemathesis_hooks")


class LoadRealIdsTests(TestCase):
    def test_returns_all_none_when_no_demo_board_exists(self):
        ids = _hooks()._load_real_ids()

        self.assertEqual(
            ids,
            {
                "board_pk": None,
                "column_id": None,
                "swimlane_id": None,
                "label_id": None,
                "card_id": None,
                "checklist_item_id": None,
                "comment_id": None,
                "member_user_id": None,
                "pat_id": None,
                "group_pk": None,
                "custom_field_id": None,
                "swimlane_custom_field_id": None,
                "saved_filter_id": None,
                "attachment_id": None,
                "group_invite_link_id": None,
                "group_label_id": None,
                "relation_id": None,
                "board_join_token": None,
                "group_join_token": None,
                "share_token": None,
                "media_path": None,
            },
        )

    def test_populates_board_and_direct_children(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        label = Label.objects.create(board=board, name="Bug")

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["board_pk"], board.id)
        self.assertEqual(ids["column_id"], column.id)
        self.assertEqual(ids["swimlane_id"], swimlane.id)
        self.assertEqual(ids["label_id"], label.id)
        # No card exists yet — degrades to None rather than raising.
        self.assertIsNone(ids["card_id"])
        self.assertIsNone(ids["checklist_item_id"])
        self.assertIsNone(ids["comment_id"])
        # No group/custom-field/saved-filter/attachment exists on this board
        # either (#1125) — same graceful-degradation-to-None behavior.
        self.assertIsNone(ids["group_pk"])
        self.assertIsNone(ids["custom_field_id"])
        self.assertIsNone(ids["swimlane_custom_field_id"])
        self.assertIsNone(ids["saved_filter_id"])
        self.assertIsNone(ids["attachment_id"])
        self.assertIsNone(ids["group_invite_link_id"])
        self.assertIsNone(ids["group_label_id"])

    def test_populates_group_and_group_sub_resource_ids(self):
        owner = _make_user()
        group = Group.objects.create(name="Demo Group", owner=owner)
        board = _make_board(owner, name="Visiban Demo Board", group=group)
        invite_link, _raw_token = GroupInviteLink.generate(group=group, created_by=owner)
        group_label = GroupLabel.objects.create(group=group, name="Demo")

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["board_pk"], board.id)
        self.assertEqual(ids["group_pk"], group.id)
        self.assertEqual(ids["group_invite_link_id"], invite_link.id)
        self.assertEqual(ids["group_label_id"], group_label.id)

    def test_group_pk_is_none_when_board_has_no_group(self):
        owner = _make_user()
        _make_board(owner, name="Visiban Demo Board")

        ids = _hooks()._load_real_ids()

        self.assertIsNone(ids["group_pk"])
        self.assertIsNone(ids["group_invite_link_id"])
        self.assertIsNone(ids["group_label_id"])

    def test_populates_custom_field_id(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        field = CustomFieldDefinition.objects.create(board=board, name="Story Points")

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["custom_field_id"], field.id)

    def test_populates_swimlane_custom_field_id(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        field = SwimlaneCustomFieldDefinition.objects.create(board=board, name="Region")

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["swimlane_custom_field_id"], field.id)

    def test_populates_saved_filter_id(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        saved_filter = SavedFilter.objects.create(user=owner, board=board, name="My filter")

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["saved_filter_id"], saved_filter.id)

    def test_populates_attachment_id(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        card = _make_card(column, swimlane)
        attachment = CardAttachment.objects.create(
            card=card,
            file=ContentFile(b"hello", name="f.txt"),
            filename="f.txt",
            size=5,
            uploaded_by=owner,
        )

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["attachment_id"], attachment.id)

    def test_prefers_a_card_with_both_checklist_item_and_comment(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        # Bare card — would be picked by the fallback `.order_by("id").first()`
        # if the preferred lookup didn't filter it out.
        _make_card(column, swimlane, title="Bare Card")
        rich_card = _make_card(column, swimlane, title="Rich Card")
        item = CardChecklist.objects.create(card=rich_card, text="Do the thing")
        comment = CardComment.objects.create(card=rich_card, author=owner, body="Looks good")

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["card_id"], rich_card.id)
        self.assertEqual(ids["checklist_item_id"], item.id)
        self.assertEqual(ids["comment_id"], comment.id)

    def test_falls_back_to_any_card_when_none_has_both(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        card = _make_card(column, swimlane)

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["card_id"], card.id)
        self.assertIsNone(ids["checklist_item_id"])
        self.assertIsNone(ids["comment_id"])

    def test_member_user_id_excludes_the_owner(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        other = _make_user()
        BoardMembership.objects.create(board=board, user=other, role=BoardMembership.Role.MEMBER)

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["member_user_id"], other.id)

    def test_pat_id_prefers_the_non_owner_members_token(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        other = _make_user()
        BoardMembership.objects.create(board=board, user=other, role=BoardMembership.Role.MEMBER)
        PersonalAccessToken.generate(owner, "owner-token")
        _, raw = PersonalAccessToken.generate(other, "member-token")
        expected = PersonalAccessToken.objects.get(user=other).id

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["pat_id"], expected)

    def test_pat_id_falls_back_to_owner_token_when_no_other_member(self):
        owner = _make_user()
        _make_board(owner, name="Visiban Demo Board")
        PersonalAccessToken.generate(owner, "owner-token")
        expected = PersonalAccessToken.objects.get(user=owner).id

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["pat_id"], expected)


class PublicTokenAndOwnershipFixtureTests(TestCase):
    """#1570: tokens are minted usable; ids resolve to rows the fuzz user owns."""

    def _demo(self):
        owner = _make_user()
        member = _make_user()
        group = Group.objects.create(name="Demo Group", owner=owner)
        board = _make_board(owner, name="Visiban Demo Board", group=group)
        BoardMembership.objects.create(board=board, user=member, role=BoardMembership.Role.MEMBER)
        return owner, member, group, board

    def test_minted_join_and_share_tokens_resolve(self):
        from boards.models import BoardInviteLink

        _owner, _member, group, board = self._demo()

        ids = _hooks()._load_real_ids()

        self.assertEqual(BoardInviteLink.lookup_by_token(ids["board_join_token"]).board_id, board.id)
        self.assertEqual(GroupInviteLink.lookup_by_token(ids["group_join_token"]).group_id, group.id)
        board.refresh_from_db()
        self.assertEqual(ids["share_token"], str(board.share_token))

    def test_reload_does_not_accumulate_fixture_links_or_rotate_share_token(self):
        from boards.models import BoardInviteLink

        _owner, _member, group, board = self._demo()
        first = _hooks()._load_real_ids()
        second = _hooks()._load_real_ids()

        self.assertEqual(first["share_token"], second["share_token"])
        self.assertEqual(BoardInviteLink.objects.filter(board=board).count(), 1)
        self.assertEqual(GroupInviteLink.objects.filter(group=group, name="schemathesis fuzz fixture").count(), 1)

    def test_group_token_is_none_when_board_has_no_group(self):
        owner = _make_user()
        _make_board(owner, name="Visiban Demo Board")

        ids = _hooks()._load_real_ids()

        self.assertIsNone(ids["group_join_token"])
        self.assertIsNotNone(ids["board_join_token"])

    def test_card_and_children_prefer_rows_owned_by_the_fuzz_user(self):
        from boards.models import CardRelation

        owner, member, _group, board = self._demo()
        column, lane = _make_column(board), _make_swimlane(board)
        other = _make_card(column, lane, created_by=owner)
        mine = _make_card(column, lane, created_by=member)
        CardComment.objects.create(card=mine, author=owner, body="theirs")
        own_comment = CardComment.objects.create(card=mine, author=member, body="mine")
        for uploader, name in ((owner, "a.txt"), (member, "b.txt")):
            CardAttachment.objects.create(
                card=mine, file=ContentFile(b"x", name=name), filename=name, size=1, uploaded_by=uploader,
            )
        mine_attachment = CardAttachment.objects.get(card=mine, uploaded_by=member)
        relation = CardRelation.objects.create(
            from_card=other, to_card=mine, relation_type=CardRelation.Type.RELATES_TO, created_by=member,
        )

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["card_id"], mine.id)
        self.assertEqual(ids["comment_id"], own_comment.id)
        self.assertEqual(ids["attachment_id"], mine_attachment.id)
        self.assertEqual(ids["media_path"], mine_attachment.file.name)
        self.assertEqual(ids["relation_id"], relation.id)

    def test_attachment_always_belongs_to_the_chosen_card(self):
        owner, _member, _group, board = self._demo()
        column, lane = _make_column(board), _make_swimlane(board)
        first = _make_card(column, lane, created_by=owner)
        second = _make_card(column, lane, created_by=owner)
        CardChecklist.objects.create(card=second, text="t")
        CardAttachment.objects.create(
            card=first, file=ContentFile(b"x", name="f.txt"), filename="f.txt", size=1, uploaded_by=owner,
        )

        ids = _hooks()._load_real_ids()

        # `second` wins (checklist); the attachment lives on `first`, so it must
        # not be offered — the view 404s an attachment on a different card.
        self.assertEqual(ids["card_id"], second.id)
        self.assertIsNone(ids["attachment_id"])


class DisposableRowTests(TestCase):
    def _fixture(self):
        owner, member = _make_user(), _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        BoardMembership.objects.create(board=board, user=member, role=BoardMembership.Role.MEMBER)
        column, lane = _make_column(board), _make_swimlane(board)
        _make_card(column, lane, created_by=member)
        hooks = _hooks()
        ids = hooks._load_real_ids()
        original = hooks._DISPOSABLE
        hooks._DISPOSABLE = hooks._load_disposable_context(ids)
        self.addCleanup(setattr, hooks, "_DISPOSABLE", original)
        return hooks, ids, member

    def test_each_kind_mints_a_fresh_row_owned_by_the_member_and_distinct_from_shared(self):
        from boards.models import CardRelation

        hooks, ids, member = self._fixture()

        card_id = hooks._mint_disposable("card")
        self.assertNotEqual(card_id, ids["card_id"])
        self.assertEqual(Card.objects.get(pk=card_id).created_by_id, member.id)
        self.assertNotEqual(hooks._mint_disposable("card"), card_id)  # fresh each call

        for kind, model in (
            ("attachment", CardAttachment), ("comment", CardComment),
            ("relation", CardRelation), ("saved_filter", SavedFilter),
        ):
            with self.subTest(kind=kind):
                minted = hooks._mint_disposable(kind)
                self.assertIsNotNone(minted)
                self.assertTrue(model.objects.filter(pk=minted).exists())
        item = hooks._mint_disposable("checklist_item")
        self.assertTrue(CardChecklist.objects.filter(pk=item, card_id=ids["card_id"]).exists())
        self.assertIsNone(hooks._mint_disposable("unknown"))

    def test_deleting_a_minted_card_leaves_the_shared_card_and_its_attachment(self):
        hooks, ids, _member = self._fixture()
        att = hooks._mint_disposable("attachment")
        Card.objects.filter(pk=hooks._mint_disposable("card")).delete()

        self.assertTrue(Card.objects.filter(pk=ids["card_id"]).exists())
        self.assertTrue(CardAttachment.objects.filter(pk=att).exists())

    def test_a_reload_does_not_pick_a_disposable_card_as_the_shared_one(self):
        hooks, ids, _member = self._fixture()
        for _ in range(3):
            hooks._mint_disposable("card")

        self.assertEqual(hooks._load_real_ids()["card_id"], ids["card_id"])

    def test_context_is_none_without_a_member_fixture(self):
        self.assertIsNone(_hooks()._load_disposable_context({"board_pk": None}))


class MapPathParametersTests(TestCase):
    def setUp(self):
        # `_IDS` is computed once at module import time (against an empty DB
        # during test collection) — tests exercise `map_path_parameters`
        # directly against a controlled substitute rather than relying on it.
        hooks = _hooks()
        self._original_ids = hooks._IDS
        hooks._IDS = {
            "board_join_token": "vbnb_board",
            "group_join_token": "vbng_group",
            "share_token": "11111111-2222-3333-4444-555555555555",
            "media_path": "attachments/2026/10/x.txt",
            "relation_id": 23,
            "member_user_id": 5,
            "board_pk": 7,
            "card_id": None,
            "group_pk": 9,
            "custom_field_id": 11,
            "swimlane_custom_field_id": 21,
            "saved_filter_id": 13,
            "attachment_id": 15,
            "group_invite_link_id": 17,
            "group_label_id": 19,
        }
        self.addCleanup(setattr, hooks, "_IDS", self._original_ids)

    def test_passes_through_when_operation_is_none(self):
        context = SimpleNamespace(operation=None)
        params = {"id": "whatever"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, params)

    def test_passes_through_when_path_parameters_empty(self):
        context = _fake_context("/api/v1/boards/{id}/")

        result = _hooks().map_path_parameters(context, {})

        self.assertEqual(result, {})

    def test_passes_through_for_an_unmapped_path(self):
        context = _fake_context("/api/v1/not-in-the-override-table/{id}/")
        params = {"id": "some-generated-value"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, params)

    def test_sample_route_gets_a_real_manifest_slug(self):
        hooks = _hooks()
        self.assertIsNotNone(hooks._EXTRA_IDS["sample_id"])
        result = hooks.map_path_parameters(
            _fake_context("/api/v1/boards/samples/{sample_id}/"), {"sample_id": "x"}
        )
        self.assertEqual(result, {"sample_id": hooks._EXTRA_IDS["sample_id"]})

    def _stub_mint(self, ids):
        """Make _mint_disposable hand out ids from `ids` (kind -> list)."""
        hooks = _hooks()
        original = hooks._mint_disposable
        hooks._mint_disposable = lambda kind: ids.get(kind, []).pop(0) if ids.get(kind) else None
        self.addCleanup(setattr, hooks, "_mint_disposable", original)
        return hooks

    def test_delete_gets_a_disposable_id_and_other_methods_the_shared_one(self):
        hooks = self._stub_mint({"card": [101, 102]})
        hooks._IDS["card_id"] = 31
        card_path = "/api/v1/boards/{board_pk}/cards/{id}/"
        params = {"board_pk": "x", "id": "y"}

        deleted = hooks.map_path_parameters(_fake_context(card_path, "DELETE"), params)
        again = hooks.map_path_parameters(_fake_context(card_path, "delete"), params)
        read = hooks.map_path_parameters(_fake_context(card_path, "GET"), params)
        patched = hooks.map_path_parameters(_fake_context(card_path, "PATCH"), params)

        self.assertEqual(deleted, {"board_pk": 7, "id": 101})
        self.assertEqual(again, {"board_pk": 7, "id": 102})  # one fresh id per call
        self.assertEqual(read, {"board_pk": 7, "id": 31})
        self.assertEqual(patched, {"board_pk": 7, "id": 31})
        self.assertNotEqual(deleted["id"], read["id"])

    def test_delete_keeps_the_shared_parent_and_swaps_only_the_child(self):
        hooks = self._stub_mint({"attachment": [201]})
        hooks._IDS["card_id"] = 31
        path = "/api/v1/boards/{board_pk}/cards/{id}/attachments/{attachment_pk}/"

        result = hooks.map_path_parameters(
            _fake_context(path, "DELETE"), {"board_pk": "x", "id": "y", "attachment_pk": "z"}
        )

        self.assertEqual(result, {"board_pk": 7, "id": 31, "attachment_pk": 201})

    def test_delete_that_cannot_mint_never_falls_back_to_the_shared_row(self):
        hooks = self._stub_mint({})
        path = "/api/v1/boards/{board_pk}/cards/{id}/comments/{comment_pk}/"

        result = hooks.map_path_parameters(
            _fake_context(path, "DELETE"), {"board_pk": "x", "id": "y", "comment_pk": "generated"}
        )

        self.assertEqual(result["comment_pk"], "generated")

    def test_overrides_group_pk_and_group_sub_resource_ids(self):
        context = _fake_context("/api/v1/groups/{id}/labels/{label_id}/")
        params = {"id": "generated-group", "label_id": "generated-label"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, {"id": 9, "label_id": 19})

    def test_group_routes_added_in_1570_get_a_real_group(self):
        for path, params, expected in (
            ("/api/v1/groups/{id}/members/", {"id": "g"}, {"id": 9}),
            ("/api/v1/groups/{id}/members/{user_id}/", {"id": "g", "user_id": "u"}, {"id": 9, "user_id": 5}),
            ("/api/v1/groups/{id}/transfer-ownership/", {"id": "g"}, {"id": 9}),
            ("/api/v1/groups/{id}/invite-links/send/", {"id": "g"}, {"id": 9}),
        ):
            with self.subTest(path=path):
                result = _hooks().map_path_parameters(_fake_context(path), params)
                self.assertEqual(result, expected)

    def test_join_share_and_media_routes_get_minted_credentials(self):
        for path, params, expected in (
            ("/api/v1/boards/join/{token}/", {"token": "x"}, {"token": "vbnb_board"}),
            ("/api/v1/groups/join/{token}/", {"token": "x"}, {"token": "vbng_group"}),
            ("/api/share/{token}/", {"token": "x"}, {"token": "11111111-2222-3333-4444-555555555555"}),
            ("/media/{path}", {"path": "x"}, {"path": "attachments/2026/10/x.txt"}),
        ):
            with self.subTest(path=path):
                result = _hooks().map_path_parameters(_fake_context(path), params)
                self.assertEqual(result, expected)

    def test_card_collection_and_relation_routes_are_mapped(self):
        hooks = _hooks()
        hooks._IDS["card_id"] = 31
        result = hooks.map_path_parameters(
            _fake_context("/api/v1/boards/{board_pk}/cards/"), {"board_pk": "x"}
        )
        self.assertEqual(result, {"board_pk": 7})
        result = hooks.map_path_parameters(
            _fake_context("/api/v1/boards/{board_pk}/cards/{id}/relations/{relation_pk}/"),
            {"board_pk": "x", "id": "y", "relation_pk": "z"},
        )
        self.assertEqual(result, {"board_pk": 7, "id": 31, "relation_pk": 23})
        for path in (
            "/api/v1/boards/{board_pk}/cards/{id}/relations/",
            "/api/v1/boards/{board_pk}/cards/{id}/checklist/reorder/",
        ):
            with self.subTest(path=path):
                result = hooks.map_path_parameters(
                    _fake_context(path), {"board_pk": "x", "id": "y"}
                )
                self.assertEqual(result, {"board_pk": 7, "id": 31})

    def test_board_invite_paths_get_a_real_board_pk(self):
        """#439: list/create/send must reach the handler, not 404."""
        for path in (
            "/api/v1/boards/{id}/invite-links/",
            "/api/v1/boards/{id}/invite-links/send/",
        ):
            with self.subTest(path=path):
                result = _hooks().map_path_parameters(_fake_context(path), {"id": "generated"})
                self.assertEqual(result, {"id": 7})
        result = _hooks().map_path_parameters(
            _fake_context("/api/v1/boards/{id}/invite-links/{link_id}/"),
            {"id": "generated", "link_id": "generated-link"},
        )
        self.assertEqual(result, {"id": 7, "link_id": "generated-link"})

    def test_overrides_custom_field_id(self):
        context = _fake_context("/api/v1/boards/{board_pk}/custom-fields/{id}/")
        params = {"board_pk": "generated-board", "id": "generated-field"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, {"board_pk": 7, "id": 11})

    def test_swimlane_definition_paths_get_a_real_board_pk(self):
        """#1391: without these mappings a random board_pk 404s in the
        viewset, so definition writes never reach validate_number_format."""
        for path in (
            "/api/v1/boards/{board_pk}/swimlane-custom-fields/",
            "/api/v1/boards/{board_pk}/swimlane-custom-fields/reorder/",
        ):
            with self.subTest(path=path):
                result = _hooks().map_path_parameters(
                    _fake_context(path), {"board_pk": "generated-board"}
                )
                self.assertEqual(result, {"board_pk": 7})

    def test_overrides_swimlane_custom_field_id(self):
        context = _fake_context("/api/v1/boards/{board_pk}/swimlane-custom-fields/{id}/")
        params = {"board_pk": "generated-board", "id": "generated-field"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, {"board_pk": 7, "id": 21})

    def test_overrides_saved_filter_id(self):
        context = _fake_context("/api/v1/boards/{id}/saved-filters/{filter_pk}/")
        params = {"id": "generated-board", "filter_pk": "generated-filter"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, {"id": 7, "filter_pk": 13})

    def test_overrides_attachment_pk(self):
        context = _fake_context(
            "/api/v1/boards/{board_pk}/cards/{id}/attachments/{attachment_pk}/"
        )
        params = {
            "board_pk": "generated-board",
            "id": "generated-card",
            "attachment_pk": "generated-attachment",
        }

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(
            result, {"board_pk": 7, "id": "generated-card", "attachment_pk": 15}
        )

    def test_overrides_group_invite_link_id(self):
        context = _fake_context("/api/v1/groups/{id}/invite-links/{link_id}/")
        params = {"id": "generated-group", "link_id": "generated-link"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, {"id": 9, "link_id": 17})

    def test_overrides_a_mapped_parameter_with_a_real_value(self):
        context = _fake_context("/api/v1/boards/{id}/")
        params = {"id": "some-generated-value"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, {"id": 7})

    def test_leaves_parameter_untouched_when_real_value_is_none(self):
        # card_id maps to None in this test's substitute _IDS.
        context = _fake_context("/api/v1/boards/{board_pk}/cards/{id}/")
        params = {"board_pk": "generated-board", "id": "generated-card"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, {"board_pk": 7, "id": "generated-card"})

    def test_does_not_add_a_param_absent_from_the_generated_set(self):
        # Schemathesis may generate only a subset of a path's declared
        # parameters (e.g. while exploring malformed input) — the hook must
        # not invent keys that were not already present.
        context = _fake_context("/api/v1/boards/{id}/")

        result = _hooks().map_path_parameters(context, {})

        self.assertEqual(result, {})


class FilterFailureTests(TestCase):
    """The narrow drop of the ASGI server's bare multipart 400 (#1165)."""

    @staticmethod
    def _response(status=400, body=b"", response_headers=None, request_type="multipart/form-data; boundary=x"):
        return SimpleNamespace(
            status_code=status,
            content=body,
            headers=response_headers or {},
            request=SimpleNamespace(headers={"Content-Type": [request_type]}),
        )

    def _keep(self, response):
        return _hooks().filter_failure(None, None, None, response)

    def test_drops_bare_400_for_a_multipart_request(self):
        self.assertFalse(self._keep(self._response()))

    def test_keeps_400_with_a_body(self):
        self.assertTrue(self._keep(self._response(body=b'{"a": ["bad"]}')))

    def test_keeps_400_that_has_a_response_content_type(self):
        self.assertTrue(
            self._keep(self._response(response_headers={"Content-Type": ["application/json"]}))
        )

    def test_keeps_bare_400_for_a_non_multipart_request(self):
        self.assertTrue(self._keep(self._response(request_type="application/json")))

    def test_matches_when_request_headers_are_plain_strings(self):
        """schemathesis's requests transport gives str values; other transports give lists."""
        response = self._response()
        response.request.headers = {"content-type": "multipart/form-data; boundary=x"}
        self.assertFalse(self._keep(response))

    def test_keeps_other_statuses_even_when_bodiless_multipart(self):
        for status in (200, 204, 500, 502):
            with self.subTest(status=status):
                self.assertTrue(self._keep(self._response(status=status)))
