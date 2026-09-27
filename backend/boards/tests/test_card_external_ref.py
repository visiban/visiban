"""Card MR/PR link — ``external_ref`` on the card API (#352).

``external_ref`` is ``{provider, ref, url} | null``, stored in its own table
(``CardExternalRef``) and exposed on ``CardSerializer``. The shape is a stable
public contract (the enterprise auto-link integration reads and writes it), so
these tests pin it, not just exercise it.

* ``ExternalRefReadTests`` — the key is always present, ``null`` when unset.
* ``ExternalRefWriteTests`` — PATCH semantics: set / replace / clear / omit.
* ``ExternalRefValidationTests`` — the url is rendered as a link, so every
  non-http(s) scheme is an XSS vector and must be rejected server-side.
* ``ExternalRefRbacTests`` — viewers cannot set it.
* ``ExternalRefBroadcastTests`` — the ``card.updated`` frame carries it.
* ``ExternalRefExposureTests`` — the anonymous share payload does not.
* ``ExternalRefSurfaceTests`` — the other card read paths (cross-board query,
  JSON export/import) carry it, and adding links does not add queries.
"""

import io
import json
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework import status
from rest_framework.test import APIClient

from boards.models import Board, Card, CardExternalRef
from boards.serializers import PublicCardSerializer
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)

GH = {
    "provider": "github",
    "ref": "visiban/visiban#123",
    "url": "https://github.com/visiban/visiban/pull/123",
}
GL = {
    "provider": "gitlab",
    "ref": "visiban/visiban!45",
    "url": "https://gitlab.com/visiban/visiban/-/merge_requests/45",
}


class _ExternalRefBase(TestCase):
    def setUp(self):
        self.owner = _make_user("xref_owner")
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board, allow_card_creation=True)
        self.lane = _make_swimlane(self.board)
        self.card = _make_card(self.col, self.lane, title="Card A")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()
        self.addCleanup(self._broadcast_patcher.stop)

    def _url(self, card=None):
        return f"/api/v1/boards/{self.board.id}/cards/{(card or self.card).id}/"

    def _patch(self, body, client=None, card=None):
        return (client or self.client).patch(self._url(card), body, format="json")


class ExternalRefReadTests(_ExternalRefBase):
    def test_key_present_and_null_when_unset(self):
        r = self.client.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("external_ref", r.data)
        self.assertIsNone(r.data["external_ref"])

    def test_board_full_payload_carries_it(self):
        CardExternalRef.objects.create(card=self.card, **GH)
        other = _make_card(self.col, self.lane, title="Card B", position=1)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        by_id = {c["id"]: c for c in r.data["cards"]}
        self.assertEqual(by_id[self.card.id]["external_ref"], GH)
        self.assertIsNone(by_id[other.id]["external_ref"])

    def test_exact_contract_shape(self):
        CardExternalRef.objects.create(card=self.card, **GL)
        r = self.client.get(self._url())
        self.assertEqual(set(r.data["external_ref"]), {"provider", "ref", "url"})


class ExternalRefWriteTests(_ExternalRefBase):
    def test_set(self):
        r = self._patch({"external_ref": GH})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["external_ref"], GH)
        self.assertEqual(CardExternalRef.objects.get(card=self.card).ref, GH["ref"])

    def test_replace_is_full_not_merge(self):
        self._patch({"external_ref": GH})
        r = self._patch({"external_ref": GL})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["external_ref"], GL)
        self.assertEqual(CardExternalRef.objects.filter(card=self.card).count(), 1)

    def test_null_clears(self):
        self._patch({"external_ref": GH})
        r = self._patch({"external_ref": None})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertIsNone(r.data["external_ref"])
        self.assertFalse(CardExternalRef.objects.filter(card=self.card).exists())

    def test_null_on_card_without_link_is_noop(self):
        r = self._patch({"external_ref": None})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertIsNone(r.data["external_ref"])

    def test_omitted_leaves_untouched(self):
        self._patch({"external_ref": GH})
        r = self._patch({"title": "Renamed"})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["external_ref"], GH)

    def test_partial_object_rejected_on_patch(self):
        """PATCH makes nested fields optional in DRF; a half link must still 400."""
        self._patch({"external_ref": GH})
        r = self._patch({"external_ref": {"provider": "gitlab"}})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("external_ref", r.data)
        # Unchanged.
        self.assertEqual(CardExternalRef.objects.get(card=self.card).provider, "github")

    def test_set_on_create(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/",
            {"column": self.col.id, "swimlane": self.lane.id, "title": "New", "external_ref": GH},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["external_ref"], GH)

    def test_set_bumps_version(self):
        before = Card.objects.get(pk=self.card.pk).version
        self._patch({"external_ref": GH})
        self.assertEqual(Card.objects.get(pk=self.card.pk).version, before + 1)

    def test_self_hosted_host_accepted(self):
        body = {"provider": "gitlab", "ref": "team/app!7", "url": "http://gitlab:8080/team/app/-/merge_requests/7"}
        r = self._patch({"external_ref": body})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

    def test_card_delete_cascades(self):
        self._patch({"external_ref": GH})
        Card.objects.filter(pk=self.card.pk).delete()
        self.assertFalse(CardExternalRef.objects.exists())


class ExternalRefValidationTests(_ExternalRefBase):
    def _assert_rejected(self, body, field):
        r = self._patch({"external_ref": body})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, body)
        self.assertIn(field, r.data["external_ref"])
        self.assertFalse(CardExternalRef.objects.filter(card=self.card).exists())

    def test_rejects_non_http_schemes(self):
        for url in (
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "ftp://example.com/x",
            "//evil.example.com/x",
            "/relative/path",
            "example.com/pull/1",
        ):
            with self.subTest(url=url):
                self._assert_rejected({**GH, "url": url}, "url")

    def test_rejects_credentials_in_url(self):
        self._assert_rejected({**GH, "url": "https://user:pw@github.com/o/r/pull/1"}, "url")

    def test_rejects_whitespace_and_control_chars_in_url(self):
        for url in ("https://github.com/o r", "https://github.com/\x00", "https://github.com/\nx"):
            with self.subTest(url=url):
                self._assert_rejected({**GH, "url": url}, "url")

    def test_rejects_backslash_host_confusion(self):
        """Browsers read ``\\`` as ``/``; Python's urlsplit does not."""
        for url in ("http://evil.com\\github.com/o/r/pull/1", "https:\\\\evil.com/x"):
            with self.subTest(url=url):
                self._assert_rejected({**GH, "url": url}, "url")

    def test_rejects_percent_encoded_host(self):
        self._assert_rejected({**GH, "url": "https://evil%2Ecom/o/r/pull/1"}, "url")

    def test_percent_encoding_in_path_is_allowed(self):
        body = {**GH, "url": "https://github.com/o/r/pull/1?q=a%20b"}
        r = self._patch({"external_ref": body})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

    def test_rejects_invisible_unicode_formatting(self):
        self._assert_rejected({**GH, "url": "https://git\u200bhub.com/o/r/pull/1"}, "url")
        self._assert_rejected({**GH, "ref": "o/r#1\u202e"}, "ref")

    def test_rejects_hostless_url(self):
        self._assert_rejected({**GH, "url": "https://"}, "url")

    def test_rejects_malformed_port(self):
        self._assert_rejected({**GH, "url": "https://github.com:notaport/x"}, "url")

    def test_rejects_overlong_url(self):
        self._assert_rejected({**GH, "url": "https://github.com/" + "a" * 2048}, "url")

    def test_rejects_unknown_provider(self):
        self._assert_rejected({**GH, "provider": "bitbucket"}, "provider")

    def test_rejects_blank_ref(self):
        self._assert_rejected({**GH, "ref": "   "}, "ref")

    def test_rejects_ref_with_inner_whitespace(self):
        self._assert_rejected({**GH, "ref": "owner/repo #1"}, "ref")

    def test_rejects_overlong_ref(self):
        self._assert_rejected({**GH, "ref": "a" * 256}, "ref")

    def test_ref_surrounding_whitespace_is_trimmed(self):
        r = self._patch({"external_ref": {**GH, "ref": "  o/r#1  "}})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["external_ref"]["ref"], "o/r#1")

    def test_other_provider_freeform_ref(self):
        body = {"provider": "other", "ref": "PROJ-42", "url": "https://tracker.example.com/PROJ-42"}
        r = self._patch({"external_ref": body})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["external_ref"], body)

    def test_non_object_rejected(self):
        r = self._patch({"external_ref": "https://github.com/o/r/pull/1"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)


class ExternalRefModelCleanTests(_ExternalRefBase):
    """Writers that bypass the serializer get the same rules via full_clean()."""

    def test_full_clean_rejects_javascript_url(self):
        from django.core.exceptions import ValidationError

        ref = CardExternalRef(card=self.card, provider="github", ref="o/r#1", url="javascript:alert(1)")
        with self.assertRaises(ValidationError) as ctx:
            ref.full_clean()
        self.assertIn("url", ctx.exception.message_dict)

    def test_full_clean_accepts_valid_link(self):
        CardExternalRef(card=self.card, **GH).full_clean()


class ExternalRefRbacTests(_ExternalRefBase):
    def test_viewer_cannot_set(self):
        viewer = _make_user("xref_viewer")
        _make_membership(self.board, viewer, role="viewer")
        client = APIClient()
        client.force_authenticate(viewer)
        r = self._patch({"external_ref": GH}, client=client)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(CardExternalRef.objects.exists())

    def test_viewer_can_read(self):
        CardExternalRef.objects.create(card=self.card, **GH)
        viewer = _make_user("xref_viewer2")
        _make_membership(self.board, viewer, role="viewer")
        client = APIClient()
        client.force_authenticate(viewer)
        r = client.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["external_ref"], GH)

    def _client_for(self, username, role, **membership_fields):
        user = _make_user(username)
        membership = _make_membership(self.board, user, role=role)
        for k, v in membership_fields.items():
            setattr(membership, k, v)
        if membership_fields:
            membership.save()
        client = APIClient()
        client.force_authenticate(user)
        return client

    def test_collaborator_cannot_set(self):
        client = self._client_for("xref_collab", "collaborator")
        r = self._patch({"external_ref": GH}, client=client)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(CardExternalRef.objects.exists())

    def test_viewer_cannot_clear(self):
        CardExternalRef.objects.create(card=self.card, **GH)
        client = self._client_for("xref_viewer3", "viewer")
        r = self._patch({"external_ref": None}, client=client)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(CardExternalRef.objects.filter(card=self.card).exists())

    def test_viewer_cannot_create_card_with_link(self):
        client = self._client_for("xref_viewer4", "viewer")
        r = client.post(
            f"/api/v1/boards/{self.board.id}/cards/",
            {"column": self.col.id, "swimlane": self.lane.id, "title": "X", "external_ref": GH},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(CardExternalRef.objects.exists())

    def test_member_cannot_set_or_clear_on_another_members_card(self):
        """Ownership gate: the link is a card edit like any other field."""
        client = self._client_for("xref_member", "member")
        r = self._patch({"external_ref": GH}, client=client)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(CardExternalRef.objects.exists())
        CardExternalRef.objects.create(card=self.card, **GH)
        r = self._patch({"external_ref": None}, client=client)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(CardExternalRef.objects.filter(card=self.card).exists())

    def test_moderator_member_can_set_on_another_members_card(self):
        client = self._client_for("xref_mod", "member", is_moderator=True)
        r = self._patch({"external_ref": GH}, client=client)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

    def test_admin_can_set_on_another_users_card(self):
        client = self._client_for("xref_admin", "admin")
        r = self._patch({"external_ref": GH}, client=client)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

    def test_non_member_cannot_set(self):
        stranger = _make_user("xref_stranger")
        client = APIClient()
        client.force_authenticate(stranger)
        r = self._patch({"external_ref": GH}, client=client)
        self.assertIn(r.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))
        self.assertFalse(CardExternalRef.objects.exists())


class ExternalRefBroadcastTests(_ExternalRefBase):
    def setUp(self):
        super().setUp()
        self._broadcast_patcher.stop()
        self.broadcast = patch("boards.broadcast.broadcast_board_event").start()
        self.addCleanup(patch.stopall)

    def _card_updated_payloads(self):
        return [c.args[2] for c in self.broadcast.call_args_list if c.args[1] == "card.updated"]

    def test_set_broadcasts_card_updated_with_link(self):
        with self.captureOnCommitCallbacks(execute=True):
            self._patch({"external_ref": GH})
        payloads = self._card_updated_payloads()
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["external_ref"], GH)

    def test_clear_broadcasts_card_updated_with_null(self):
        self._patch({"external_ref": GH})
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            self._patch({"external_ref": None})
        payloads = self._card_updated_payloads()
        self.assertEqual(len(payloads), 1)
        self.assertIsNone(payloads[0]["external_ref"])

    def test_create_with_link_broadcasts_card_created_with_link(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                f"/api/v1/boards/{self.board.id}/cards/",
                {"column": self.col.id, "swimlane": self.lane.id, "title": "New", "external_ref": GH},
                format="json",
            )
        created = [c.args[2] for c in self.broadcast.call_args_list if c.args[1] == "card.created"]
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["external_ref"], GH)

    def test_no_broadcast_before_commit(self):
        with self.captureOnCommitCallbacks(execute=False):
            self._patch({"external_ref": GH})
        self.assertEqual(self._card_updated_payloads(), [])


class ExternalRefExposureTests(_ExternalRefBase):
    """A PR URL can reveal private repo names — keep it off anonymous links."""

    def test_public_card_serializer_does_not_expose_it(self):
        self.assertNotIn("external_ref", PublicCardSerializer().fields)

    def test_public_board_payload_does_not_leak_it(self):
        CardExternalRef.objects.create(card=self.card, **GH)
        token = self.client.post(f"/api/v1/boards/{self.board.id}/share/").data["share_token"]
        r = APIClient().get(f"/api/share/{token}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        body = json.dumps(r.data)
        self.assertNotIn("external_ref", body)
        self.assertNotIn(GH["url"], body)


class ExternalRefSurfaceTests(_ExternalRefBase):
    def test_cross_board_card_query_carries_it(self):
        CardExternalRef.objects.create(card=self.card, **GH)
        r = self.client.get("/api/v1/cards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        by_id = {c["id"]: c for c in r.data["results"]}
        self.assertEqual(by_id[self.card.id]["external_ref"], GH)

    def test_json_export_carries_it(self):
        CardExternalRef.objects.create(card=self.card, **GH)
        _make_card(self.col, self.lane, title="No link", position=1)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        cards = {c["title"]: c for c in json.loads(r.content)["cards"]}
        self.assertEqual(cards["Card A"]["external_ref"], GH)
        self.assertIsNone(cards["No link"]["external_ref"])

    def test_json_round_trip_restores_it_and_drops_unsafe(self):
        CardExternalRef.objects.create(card=self.card, **GH)
        exported = json.loads(
            self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json").content
        )
        # Tamper: add a second card whose link would be an XSS vector.
        evil = dict(exported["cards"][0])
        evil["title"] = "Evil"
        evil["external_ref"] = {**GH, "url": "javascript:alert(1)"}
        exported["cards"].append(evil)
        exported["name"] = "Imported"
        f = io.BytesIO(json.dumps(exported).encode("utf-8"))
        f.name = "board.json"
        r = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        new_board = Board.objects.get(pk=r.data["id"])
        restored = Card.objects.get(board=new_board, title="Card A")
        self.assertEqual(
            {"provider": restored.external_ref.provider, "ref": restored.external_ref.ref,
             "url": restored.external_ref.url},
            GH,
        )
        evil_card = Card.objects.get(board=new_board, title="Evil")
        self.assertFalse(CardExternalRef.objects.filter(card=evil_card).exists())

    def _full_query_count(self):
        url = f"/api/v1/boards/{self.board.id}/full/"
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return len(ctx)

    def test_full_query_count_constant_as_links_are_added(self):
        cards = [_make_card(self.col, self.lane, title=f"C{i}", position=i + 1) for i in range(10)]
        baseline = self._full_query_count()
        for i, card in enumerate(cards):
            CardExternalRef.objects.create(
                card=card, provider="github", ref=f"o/r#{i}", url=f"https://github.com/o/r/pull/{i}",
            )
        self.assertEqual(baseline, self._full_query_count())
