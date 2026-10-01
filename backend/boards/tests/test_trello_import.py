"""Tests for POST /api/v1/boards/import/trello/ (#456)."""

import io
import json
from pathlib import Path
from unittest import mock

from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardEvent, BoardMembership, Card, CardChecklist, CardComment, CardMovement,
    Column, Label, Notification,
)
from boards.services import trello_import
from boards.views.import_export import TrelloImportThrottle
from groups.models import Group, GroupMembership

URL = "/api/v1/boards/import/trello/"
FIXTURE = Path(__file__).parent / "fixtures" / "trello_export.json"


def load_fixture():
    return json.loads(FIXTURE.read_text())


def as_file(data, name="trello.json"):
    raw = data if isinstance(data, bytes) else json.dumps(data).encode("utf-8")
    f = io.BytesIO(raw)
    f.name = name
    return f


class TrelloImportBase(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def post(self, mode="dry_run", data=None, **extra):
        payload = {"file": as_file(load_fixture() if data is None else data)}
        payload.update(extra)
        qs = f"?{mode}=true" if mode else ""
        return self.client.post(URL + qs, payload, format="multipart")

    def confirm(self, mapping=None, **extra):
        if mapping is not None:
            extra["mapping"] = json.dumps(mapping)
        return self.post("confirm", **extra)


class TrelloImportDryRunTests(TrelloImportBase):
    def test_url_is_pinned(self):
        from django.urls import resolve
        # First multi-segment url_path on BoardViewSet; must not be swallowed
        # by the detail route or by import/.
        self.assertEqual(resolve(URL).url_name, "board-import-trello")

    def test_dry_run_returns_preview_and_creates_nothing(self):
        before = (Board.objects.count(), Card.objects.count(), Label.objects.count())
        resp = self.post("dry_run")
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.data)
        self.assertEqual(before, (Board.objects.count(), Card.objects.count(), Label.objects.count()))
        data = resp.data
        self.assertEqual(data["source"], "trello")
        self.assertEqual(len(data["file_sha256"]), 64)
        self.assertEqual(data["board"]["name"], "Product Roadmap")
        self.assertEqual(data["counts"]["lists"], 4)
        self.assertEqual(data["counts"]["lists_archived"], 1)
        self.assertEqual(data["counts"]["cards"], 4)
        self.assertEqual(data["counts"]["cards_archived"], 1)
        self.assertEqual(data["counts"]["comments"], 3)
        self.assertEqual(data["counts"]["attachments"], 2)
        self.assertEqual(data["counts"]["checklist_items"], 4)
        # Columns ordered by Trello pos; archived list listed but skipped.
        cols = data["mapping"]["columns"]
        self.assertEqual([c["name"] for c in cols], ["To Do", "Doing", "Done", "Icebox"])
        self.assertEqual([c["position"] for c in cols], [0, 1, 2, None])
        self.assertTrue(cols[3]["archived"])
        codes = {w["code"] for w in data["warnings"]}
        self.assertIn("archived_lists_skipped", codes)
        self.assertIn("checklists_flattened", codes)
        kinds = {u["kind"]: u["count"] for u in data["unmappable"]}
        self.assertEqual(kinds["custom_fields"], 2)
        self.assertEqual(kinds["power_up_data"], 2)
        self.assertEqual(kinds["start_dates"], 1)
        self.assertEqual(kinds["stickers"], 1)

    def test_label_colors_mapped_to_hex_and_unnamed_label_named(self):
        labels = {lb["trello_id"]: lb for lb in self.post().data["mapping"]["labels"]}
        self.assertEqual(labels["l1"]["color"], "#4BCE97")
        self.assertEqual(labels["l2"]["color"], "#0C66E4")
        self.assertEqual(labels["l4"]["name"], "Yellow")
        self.assertFalse(labels["l4"]["swimlane_eligible"])
        self.assertEqual(labels["l5"]["color"], trello_import.DEFAULT_LABEL_COLOR)
        for lb in labels.values():
            self.assertRegex(lb["color"], r"^#[0-9A-F]{6}$")

    def test_preview_and_confirm_agree(self):
        mapping = {"swimlane_label_ids": ["l1"], "include_archived_lists": True}
        preview = self.post("dry_run", mapping=json.dumps(mapping)).data
        resp = self.confirm(mapping)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        self.assertEqual(resp.data["summary"]["result"], preview["result"])
        board = Board.objects.get(pk=resp.data["board"]["id"])
        self.assertEqual(board.columns.count(), preview["result"]["columns"])
        self.assertEqual(board.cards.count(), preview["result"]["cards"])
        self.assertEqual(board.swimlanes.count(), preview["result"]["swimlanes"])


class TrelloImportConfirmTests(TrelloImportBase):
    def test_standard_import_creates_board(self):
        resp = self.confirm()
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        board = Board.objects.get(pk=resp.data["board"]["id"])
        self.assertEqual(board.name, "Product Roadmap")
        self.assertEqual(board.owner, self.user)
        self.assertTrue(BoardMembership.objects.filter(
            board=board, user=self.user, role=BoardMembership.Role.ADMIN).exists())
        self.assertEqual(
            list(board.columns.order_by("position").values_list("name", flat=True)),
            ["To Do", "Doing", "Done"],
        )
        # No mapping → a single default swimlane holds every card.
        self.assertEqual(list(board.swimlanes.values_list("name", flat=True)), ["Unassigned"])
        self.assertEqual(board.labels.count(), 5)
        # The card in the archived list is skipped by default.
        self.assertEqual(board.cards.count(), 3)
        self.assertFalse(board.cards.filter(title="Frozen card").exists())

    def test_cards_labels_checklists_and_attachments(self):
        board = Board.objects.get(pk=self.confirm().data["board"]["id"])
        card = board.cards.get(title="Write launch plan")
        self.assertEqual(sorted(card.labels.values_list("name", flat=True)), ["Acme", "Bug"])
        self.assertEqual(card.due_date.isoformat(), "2024-04-15")
        self.assertEqual(card.created_by, self.user)
        items = list(CardChecklist.objects.filter(card=card).order_by("position").values_list("text", "is_checked"))
        self.assertEqual(items, [
            ("Launch: Book venue", True), ("Launch: Send invite", False), ("Follow-up: Survey", False),
        ])
        # Single checklist → no prefix.
        other = board.cards.get(title="Fix checkout bug")
        self.assertEqual(list(other.checklist_items.values_list("text", flat=True)), ["Reproduce"])
        # http(s) attachment links appended; javascript: links dropped.
        self.assertIn("https://docs.example.com/spec", card.description)
        self.assertNotIn("javascript:", card.description)
        # created_at restored from the Trello ObjectId timestamp.
        self.assertEqual(card.created_at.year, 2019)

    def test_archived_cards_are_archived(self):
        board = Board.objects.get(pk=self.confirm().data["board"]["id"])
        archived = board.cards.get(title="Old archived idea")
        self.assertIsNotNone(archived.archived_at)
        self.assertEqual(archived.archived_at.isoformat()[:10], "2023-12-31")
        self.assertIsNone(board.cards.get(title="Write launch plan").archived_at)

    def test_include_archived_lists_imports_cards_as_archived(self):
        board = Board.objects.get(pk=self.confirm({"include_archived_lists": True}).data["board"]["id"])
        self.assertTrue(board.columns.filter(name="Icebox").exists())
        self.assertIsNotNone(board.cards.get(title="Frozen card").archived_at)

    def test_label_to_swimlane_mapping(self):
        board = Board.objects.get(pk=self.confirm({"swimlane_label_ids": ["l2", "l1"]}).data["board"]["id"])
        self.assertEqual(
            list(board.swimlanes.order_by("position").values_list("name", flat=True)),
            ["Globex", "Acme", "Unassigned"],
        )
        # Card's own label order decides: card 1 has [l1, l3] → Acme.
        self.assertEqual(board.cards.get(title="Write launch plan").swimlane.name, "Acme")
        # Card 2 has [l2, l1] → Globex (first of its own labels that is mapped).
        self.assertEqual(board.cards.get(title="Fix checkout bug").swimlane.name, "Globex")
        self.assertEqual(board.cards.get(title="Old archived idea").swimlane.name, "Unassigned")
        # Labels stay on cards even when promoted to swimlanes.
        self.assertIn("Acme", board.cards.get(title="Write launch plan").labels.values_list("name", flat=True))

    def test_default_swimlane_omitted_when_every_card_is_mapped(self):
        data = load_fixture()
        data["cards"] = [data["cards"][0]]
        resp = self.post("confirm", data=data, mapping=json.dumps({"swimlane_label_ids": ["l1"]}))
        board = Board.objects.get(pk=resp.data["board"]["id"])
        self.assertEqual(list(board.swimlanes.values_list("name", flat=True)), ["Acme"])

    def test_comments_keep_timestamps_and_attribute_to_importer_by_default(self):
        board = Board.objects.get(pk=self.confirm().data["board"]["id"])
        comments = CardComment.objects.filter(card__board=board).order_by("created_at")
        self.assertEqual(comments.count(), 3)
        first = comments[0]
        self.assertEqual(first.created_at.isoformat()[:19], "2024-02-01T10:00:00")
        self.assertEqual(first.author, self.user)
        self.assertTrue(first.body.startswith("Ada Lovelace (imported from Trello):\n\n"))
        self.assertNotIn("*", first.body)
        self.assertIn("Looks good to me", first.body)

    def test_custom_board_name(self):
        resp = self.confirm(name="My Imported Board")
        self.assertEqual(resp.data["board"]["name"], "My Imported Board")

    def test_no_notifications_or_movements_created(self):
        User.objects.create_user(username="ada", password="x")
        self.confirm({"add_matched_members": True})
        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(CardMovement.objects.count(), 0)

    def test_board_created_event_persisted(self):
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                resp = self.confirm()
            board_id = resp.data["board"]["id"]
            self.assertTrue(BoardEvent.objects.filter(board_id=board_id, event="board.created").exists())
            # Deferred to on_commit, not sent inline.
            bcast.assert_not_called()
            for cb in callbacks:
                cb()
            self.assertEqual(bcast.call_args[0][:2], (board_id, "board.created"))

    def test_file_sha256_mismatch_rejected(self):
        resp = self.confirm(file_sha256="0" * 64)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Board.objects.count(), 0)

    def test_file_sha256_match_accepted(self):
        sha = self.post().data["file_sha256"]
        self.assertEqual(self.confirm(file_sha256=sha).status_code, status.HTTP_201_CREATED)

    def test_failure_mid_import_rolls_back(self):
        with mock.patch.object(CardComment.objects, "bulk_create", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.confirm()
        self.assertEqual(Board.objects.count(), 0)
        self.assertEqual(Column.objects.count(), 0)
        self.assertEqual(Card.objects.count(), 0)

    def test_all_lists_archived_confirm_rejected(self):
        data = load_fixture()
        for lst in data["lists"]:
            lst["closed"] = True
        self.assertEqual(self.post("dry_run", data=data).status_code, status.HTTP_200_OK)
        resp = self.post("confirm", data=data)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Board.objects.count(), 0)


class TrelloImportMemberMatchingTests(TrelloImportBase):
    def setUp(self):
        super().setUp()
        # "ada" shares a board with the importer → visible.
        self.ada = User.objects.create_user(username="Ada", password="x")
        shared = Board.objects.create(name="Shared", owner=self.user)
        BoardMembership.objects.create(board=shared, user=self.user, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=shared, user=self.ada)
        # "outsider" exists but shares nothing with the importer → never matched.
        self.outsider = User.objects.create_user(username="outsider", password="x")

    def test_only_visible_users_match_and_preview_leaks_no_identities(self):
        data = self.post().data
        self.assertEqual(data["members"]["total"], 3)
        self.assertEqual(data["members"]["matched"], 1)
        unmatched = {m["full_name"] for m in data["members"]["unmatched"]}
        self.assertEqual(unmatched, {"Grace Hopper", "Stranger Danger"})
        body = json.dumps(data)
        # Neither the matched account's identity nor anyone's email appears.
        self.assertEqual(set(data["members"]), {"total", "matched", "unmatched"})
        self.assertNotIn("Ada", json.dumps(data["members"]))
        self.assertNotIn("@", json.dumps(data["members"]))
        self.assertNotIn('"username"', body)

    def test_existence_oracle_closed_for_invisible_users(self):
        data = load_fixture()
        data["members"] = [{"id": "x1", "fullName": "Probe", "username": "outsider"}]
        self.assertEqual(self.post(data=data).data["members"]["matched"], 0)

    def test_group_members_are_visible_when_importing_into_group(self):
        group = Group.objects.create(name="G", owner=self.user)
        GroupMembership.objects.create(group=group, user=self.user)
        GroupMembership.objects.create(group=group, user=self.outsider)
        data = self.post(group_id=group.pk).data
        self.assertEqual(data["members"]["matched"], 2)

    def test_site_admin_can_match_anyone(self):
        self.user.is_site_admin = True
        self.user.save(update_fields=["is_site_admin"])
        self.assertEqual(self.post().data["members"]["matched"], 2)

    def test_matched_members_not_added_by_default(self):
        board = Board.objects.get(pk=self.confirm().data["board"]["id"])
        self.assertFalse(BoardMembership.objects.filter(board=board, user=self.ada).exists())
        self.assertIsNone(board.cards.get(title="Write launch plan").assignee)

    def test_add_matched_members_opt_in(self):
        board = Board.objects.get(pk=self.confirm({"add_matched_members": True}).data["board"]["id"])
        m = BoardMembership.objects.get(board=board, user=self.ada)
        self.assertEqual(m.role, BoardMembership.Role.MEMBER)
        self.assertFalse(BoardMembership.objects.filter(board=board, user=self.outsider).exists())
        self.assertEqual(board.cards.get(title="Write launch plan").assignee, self.ada)
        comments = CardComment.objects.filter(card__board=board)
        ada_comment = comments.get(body__endswith="Looks good to me")
        self.assertEqual(ada_comment.author, self.ada)
        # Provenance is always marked, so an uploaded file cannot produce a
        # comment indistinguishable from one the user posted in Visiban.
        self.assertTrue(ada_comment.body.startswith("(imported from Trello)\n\n"))
        stranger = comments.get(body__contains="Can I help?")
        self.assertEqual(stranger.author, self.user)
        self.assertTrue(stranger.body.startswith("Stranger Danger (imported from Trello):\n\n"))


class TrelloImportValidationTests(TrelloImportBase):
    def test_requires_exactly_one_mode(self):
        self.assertEqual(self.post(mode=None).status_code, status.HTTP_400_BAD_REQUEST)
        resp = self.client.post(URL + "?dry_run=true&confirm=true", {"file": as_file(load_fixture())}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Board.objects.count(), 0)

    def test_missing_file(self):
        resp = self.client.post(URL + "?dry_run=true", {}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_malformed_json_400(self):
        self.assertEqual(self.post(data=b"{not json").status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(self.post("confirm", data=b"{not json").status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Board.objects.count(), 0)

    def test_hostile_inputs_are_400_not_500(self):
        for raw in (
            b"[" * 100000 + b"]" * 100000,        # deep nesting
            b'{"lists": [], "cards": [], "x": NaN}',
            b"\xff\xfe\x00garbage",
            b"[]",
            b'"a string"',
            b'{"name": "no lists"}',
        ):
            with self.subTest(raw=raw[:20]):
                self.assertEqual(self.post(data=raw).status_code, status.HTTP_400_BAD_REQUEST)

    def test_impossible_dates_and_huge_numbers_are_not_500(self):
        data = load_fixture()
        data["cards"][0]["due"] = "2020-02-30T10:00:00Z"
        data["cards"][2]["dateLastActivity"] = "0001-01-01T00:00:00+05:00"
        data["actions"][0]["date"] = "2020-13-45T00:00:00Z"
        data["lists"][0]["pos"] = int("9" * 400)
        data["cards"][1]["pos"] = 1e308 * 10  # json.dumps writes Infinity
        raw = json.dumps(data).replace("Infinity", "1e999").encode()
        resp = self.post("confirm", data=raw)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        card = Card.objects.get(title="Write launch plan")
        self.assertIsNone(card.due_date)
        self.assertIn("invalid_due_dates", {w["code"] for w in resp.data["summary"]["warnings"]})

    def test_container_bomb_rejected_before_parsing(self):
        raw = b'{"lists": [], "cards": [' + b"{}," * (trello_import.MAX_JSON_CONTAINERS + 1) + b"{}]}"
        with mock.patch.object(trello_import.json, "loads", wraps=json.loads) as loads:
            resp = self.post(data=raw)
            loads.assert_not_called()
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_per_kind_caps_checked(self):
        data = load_fixture()
        data["checklists"][0]["checkItems"] = [{"name": "x"}] * (trello_import.MAX_CHECKLIST_ITEMS + 1)
        self.assertEqual(self.post(data=data).status_code, status.HTTP_400_BAD_REQUEST)
        data = load_fixture()
        data["actions"] = [{"type": "x"}] * (trello_import.MAX_ACTIONS + 1)
        self.assertEqual(self.post(data=data).status_code, status.HTTP_400_BAD_REQUEST)
        data = load_fixture()
        data["cards"][0]["idLabels"] = ["l1"] * (trello_import.MAX_REFS_PER_CARD + 1)
        self.assertEqual(self.post(data=data).status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_string_form_fields_are_400(self):
        resp = self.post("confirm", name=as_file(b"x", name="n.txt"))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        resp = self.post("confirm", mapping=as_file(b"{}", name="m.json"))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Board.objects.count(), 0)

    def test_markdown_in_names_and_urls_is_neutralized(self):
        data = load_fixture()
        data["members"][2]["fullName"] = "Eve**\n\n![x](https://evil.example/p.png)<img src=x>"
        data["cards"][0]["attachments"] = [
            {"name": "ok", "url": "https://docs.example.com/a"},
            {"name": "bad", "url": "https://x.example/a)\n[click](https://evil.example"},
        ]
        board = Board.objects.get(pk=self.post("confirm", data=data).data["board"]["id"])
        comment = CardComment.objects.get(card__board=board, body__contains="Can I help?")
        header = comment.body.split("\n\n", 1)[0]
        # Line breaks in the uploaded name are collapsed, so the name cannot
        # forge extra paragraphs ahead of the real comment text.
        self.assertTrue(header.startswith("Eve** "))
        self.assertTrue(header.endswith("(imported from Trello):"))
        self.assertNotIn("\n", header)
        card = board.cards.get(title="Write launch plan")
        self.assertIn("https://docs.example.com/a", card.description)
        self.assertNotIn("evil.example", card.description)

    def test_disallowed_scheme_attachment_urls_are_dropped(self):
        # _safe_url() only allows http(s); this is the only place its output
        # lands (the rendered "Attachments" markdown block in the card
        # description) — assert the disallowed schemes never reach it, with
        # an https URL as a positive control that safe links still survive.
        data = load_fixture()
        data["cards"][0]["attachments"] = [
            {"name": "ok", "url": "https://docs.example.com/a"},
            {"name": "js", "url": "javascript:alert(1)"},
            {"name": "data", "url": "data:text/html,<script>alert(1)</script>"},
            {"name": "mixed", "url": " JavaScript:alert(1)"},
        ]
        board = Board.objects.get(pk=self.post("confirm", data=data).data["board"]["id"])
        card = board.cards.get(title="Write launch plan")
        self.assertIn("https://docs.example.com/a", card.description)
        self.assertNotIn("data:text/html", card.description)
        self.assertNotIn("alert(1)", card.description)
        self.assertNotIn(
            "javascript", card.description.lower(),
            "a disallowed-scheme attachment URL reached the persisted card description",
        )
        # Exactly one attachment line: the three disallowed-scheme URLs were
        # dropped entirely, not merely stripped of their dangerous substring.
        self.assertEqual(card.description.count("- ["), 1)

    def test_attachment_urls_with_markdown_breakout_characters_are_dropped(self):
        # _safe_url() allows the http(s) scheme itself but must still reject
        # `<`, `"`, and backtick inside an otherwise-valid URL body — any of
        # these can break out of the markdown `<...>` link destination (or
        # an HTML attribute, if the markdown is ever rendered as raw HTML).
        data = load_fixture()
        data["cards"][0]["attachments"] = [
            {"name": "ok", "url": "https://docs.example.com/a"},
            {"name": "angle", "url": 'https://evil.example/"><script>alert(1)</script>'},
            {"name": "quote", "url": 'https://evil.example/a"onmouseover=alert(1)'},
            {"name": "backtick", "url": "https://evil.example/a`alert(1)`"},
        ]
        board = Board.objects.get(pk=self.post("confirm", data=data).data["board"]["id"])
        card = board.cards.get(title="Write launch plan")
        self.assertIn("https://docs.example.com/a", card.description)
        self.assertNotIn("evil.example", card.description)
        self.assertNotIn("<script>", card.description)
        self.assertNotIn("onmouseover", card.description)
        # Exactly one attachment line: the three breakout-character URLs
        # were dropped entirely, not merely stripped of the bad character.
        self.assertEqual(card.description.count("- ["), 1)

    def test_safe_url_unit(self):
        # Direct unit coverage of the predicate, alongside the end-to-end
        # import tests above.
        self.assertTrue(trello_import._safe_url("https://docs.example.com/a"))
        self.assertTrue(trello_import._safe_url("http://docs.example.com/a"))
        self.assertFalse(trello_import._safe_url("javascript:alert(1)"))
        self.assertFalse(trello_import._safe_url('https://evil.example/"><script>'))
        self.assertFalse(trello_import._safe_url('https://evil.example/a"onmouseover=1'))
        self.assertFalse(trello_import._safe_url("https://evil.example/a`alert(1)`"))
        self.assertFalse(trello_import._safe_url("https://evil.example/a\tb"))

    def test_long_comments_and_descriptions_truncated_with_warnings(self):
        data = load_fixture()
        data["cards"][1]["desc"] = "d" * 60_000
        data["actions"][0]["data"]["text"] = "c" * 12_000
        preview = self.post(data=data).data
        codes = {w["code"]: w["count"] for w in preview["warnings"]}
        self.assertEqual(codes["descriptions_truncated"], 1)
        self.assertEqual(codes["comments_truncated"], 1)
        board = Board.objects.get(pk=self.post("confirm", data=data).data["board"]["id"])
        self.assertEqual(len(board.cards.get(title="Fix checkout bug").description), 50_000)
        self.assertTrue(all(len(c.body) <= 10_000 for c in CardComment.objects.filter(card__board=board)))
        self.assertEqual(max(len(c.body) for c in CardComment.objects.filter(card__board=board)), 10_000)

    def test_bom_is_tolerated(self):
        raw = b"\xef\xbb\xbf" + json.dumps(load_fixture()).encode()
        self.assertEqual(self.post(data=raw).status_code, status.HTTP_200_OK)

    def test_wrong_types_rejected(self):
        cases = [
            ("lists", "notalist"),
            ("cards", [{"id": "c", "idList": 5}]),
            ("cards", [{"id": "c", "idList": "list-todo", "closed": "yes"}]),
            ("cards", ["just a string"]),
            ("labels", [{"id": "l", "color": 3}]),
            ("checklists", [{"id": "c", "idCard": "x", "checkItems": "nope"}]),
            ("actions", [{"type": "commentCard", "data": "nope"}]),
        ]
        for key, value in cases:
            data = load_fixture()
            data[key] = value
            with self.subTest(key=key, value=value):
                self.assertEqual(self.post(data=data).status_code, status.HTTP_400_BAD_REQUEST)

    def test_nul_bytes_stripped(self):
        data = load_fixture()
        data["cards"][0]["name"] = "Bad\x00name"
        resp = self.post("confirm", data=data)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertTrue(Card.objects.filter(title="Badname").exists())

    def test_long_and_duplicate_names_are_truncated_and_deduped(self):
        data = load_fixture()
        data["lists"][1]["name"] = "Done"  # duplicates "Done"
        data["cards"][0]["name"] = "x" * 900
        data["labels"][2]["name"] = "acme"  # case-insensitive duplicate of "Acme"
        data["labels"][4]["name"] = "L" * 80
        resp = self.post("confirm", data=data)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        board = Board.objects.get(pk=resp.data["board"]["id"])
        self.assertEqual(sorted(board.columns.values_list("name", flat=True)), ["Doing", "Done", "Done (2)"])
        self.assertEqual(len(board.cards.order_by("-title").first().title), 500)
        names = set(board.labels.values_list("name", flat=True))
        self.assertIn("acme (2)", names)
        self.assertTrue(all(len(n) <= 50 for n in names))

    def test_count_caps(self):
        data = load_fixture()
        data["lists"] = [{"id": f"l{i}", "name": f"L{i}"} for i in range(trello_import.MAX_LISTS + 1)]
        resp = self.post(data=data)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("exceeds the limit", resp.data["detail"])

    def test_invalid_mapping(self):
        for mapping in (
            "not json",
            json.dumps([1]),
            json.dumps({"unknown": 1}),
            json.dumps({"swimlane_label_ids": ["nope"]}),
            json.dumps({"swimlane_label_ids": ["l4"]}),  # unnamed → not eligible
            json.dumps({"add_matched_members": "yes"}),
            json.dumps({"default_swimlane_name": "  "}),
            json.dumps({"swimlane_label_ids": ["l1"], "default_swimlane_name": "acme"}),
        ):
            with self.subTest(mapping=mapping):
                resp = self.post("confirm", mapping=mapping)
                self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.data)
        self.assertEqual(Board.objects.count(), 0)

    @override_settings(VISIBAN_IMPORT_MAX_SIZE=1024)
    def test_oversize_413_and_boundary(self):
        big = b" " * 1025
        self.assertEqual(self.post(data=big).status_code, status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        self.assertEqual(self.post("confirm", data=big).status_code, status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        minimal = json.dumps({"lists": [], "cards": []}).encode()
        exact = minimal + b" " * (1024 - len(minimal))
        self.assertEqual(len(exact), 1024)
        self.assertEqual(self.post(data=exact).status_code, status.HTTP_200_OK)

    def test_default_max_size_is_25mb(self):
        from django.conf import settings
        self.assertEqual(settings.VISIBAN_IMPORT_MAX_SIZE, 25 * 1024 * 1024)


class TrelloImportPermissionTests(TrelloImportBase):
    def test_unauthenticated_rejected(self):
        self.client.force_authenticate(None)
        resp = self.post()
        self.assertIn(resp.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))
        self.assertEqual(Board.objects.count(), 0)

    def test_non_member_of_target_group_gets_403(self):
        other = User.objects.create_user(username="other", password="x")
        group = Group.objects.create(name="Private", owner=other)
        for mode in ("dry_run", "confirm"):
            with self.subTest(mode=mode):
                resp = self.post(mode, group_id=group.pk)
                self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Board.objects.count(), 0)

    def test_group_member_imports_into_group(self):
        other = User.objects.create_user(username="other", password="x")
        group = Group.objects.create(name="Team", owner=other)
        GroupMembership.objects.create(group=group, user=self.user)
        resp = self.post("confirm", group_id=group.pk)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Board.objects.get(pk=resp.data["board"]["id"]).group, group)

    def test_group_viewer_can_import_into_group(self):
        # Pins the approved model (#456 I1): the Trello import uses the same
        # _resolve_import_group rule as the native import/ endpoint — any
        # group membership row, not group-admin as /groups/{id}/boards/ does.
        other = User.objects.create_user(username="other", password="x")
        group = Group.objects.create(name="Team", owner=other)
        GroupMembership.objects.create(group=group, user=self.user, role=GroupMembership.Role.VIEWER)
        self.assertEqual(self.post("dry_run", group_id=group.pk).status_code, status.HTTP_200_OK)

    def test_nonexistent_group_404(self):
        self.assertEqual(self.post("dry_run", group_id=999999).status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(self.post("dry_run", group_id="abc").status_code, status.HTTP_404_NOT_FOUND)

    def test_pat_scopes(self):
        from accounts.models import PersonalAccessToken
        self.client.force_authenticate(None)
        _, read_only = PersonalAccessToken.generate(self.user, "ro", scopes=["read"])
        resp = self.client.post(URL + "?dry_run=true", {"file": as_file(load_fixture())},
                                format="multipart", HTTP_AUTHORIZATION=f"Token {read_only}")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        _, writer = PersonalAccessToken.generate(self.user, "rw", scopes=["read", "write"])
        resp = self.client.post(URL + "?confirm=true", {"file": as_file(load_fixture())},
                                format="multipart", HTTP_AUTHORIZATION=f"Token {writer}")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_pending_password_change_blocked(self):
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        self.assertEqual(self.post().status_code, status.HTTP_403_FORBIDDEN)


class TrelloImportThrottleTests(TrelloImportBase):
    def test_scopes_by_mode(self):
        rates = {"board_import": "1/hour", "board_import_preview": "2/hour"}
        with mock.patch.object(TrelloImportThrottle, "get_rate", autospec=True,
                               side_effect=lambda self: rates[self.scope]):
            self.assertEqual(self.post().status_code, 200)
            self.assertEqual(self.post().status_code, 200)
            self.assertEqual(self.post().status_code, status.HTTP_429_TOO_MANY_REQUESTS)
            # Confirm has its own (shared board_import) budget.
            self.assertEqual(self.post("confirm").status_code, 201)
            self.assertEqual(self.post("confirm").status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    def test_rates_configured(self):
        from django.conf import settings
        rates = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
        self.assertIn("board_import_preview", rates)
        self.assertIn("board_import", rates)
