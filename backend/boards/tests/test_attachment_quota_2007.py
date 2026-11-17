"""Per-card attachment quotas, the upload throttle and the content check (#2007).

* ``ATTACHMENT_MAX_PER_CARD`` / ``ATTACHMENT_MAX_BYTES_PER_CARD`` refuse an
  upload that would break either quota with ``400`` ``attachment_quota_exceeded``
  and store nothing; ``0`` turns a quota off.
* The quota is read under the card row lock, so two concurrent uploads cannot
  both take the last slot (PostgreSQL test below).
* ``attachment_upload`` throttles uploads per user, on top of the ``user``
  scope, and does not count the GET that lists attachments.
* ``_validate_upload_mime`` matches the signature to the DECLARED type and
  sniffs the whole text body for markup.
"""

import shutil
import tempfile
import threading
from pathlib import Path
from unittest import mock, skipUnless

from django.conf import settings
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection, connections
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardAttachment, Column, Swimlane
from boards.tests.lock_wait import assert_blocked_on_lock
from boards.views.cards import (
    ATTACHMENT_QUOTA_EXCEEDED,
    AttachmentUploadThrottle,
    _format_bytes,
    _validate_upload_mime,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 92  # 100 bytes
HOLD_TIMEOUT = 10.0


def _png(name="a.png", body=PNG):
    return SimpleUploadedFile(name, body, content_type="image/png")


def _fixture(test, username):
    test.user = User.objects.create_user(username=username, password="pass")
    test.board = Board.objects.create(name="B", owner=test.user)
    BoardMembership.objects.create(board=test.board, user=test.user, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=test.board, name="A", position=0)
    swim = Swimlane.objects.create(board=test.board, name="G", position=0)
    test.card = Card.objects.create(
        board=test.board, column=col, swimlane=swim, title="C", created_by=test.user, position=0,
    )
    test.other = Card.objects.create(
        board=test.board, column=col, swimlane=swim, title="D", created_by=test.user, position=1,
    )
    test.url = f"/api/v1/boards/{test.board.pk}/cards/{test.card.pk}/attachments/"
    test.other_url = f"/api/v1/boards/{test.board.pk}/cards/{test.other.pk}/attachments/"


class _MediaRoot:
    def _use_temp_media(self):
        tmp = tempfile.mkdtemp(prefix="visiban-2007-")
        self.addCleanup(shutil.rmtree, tmp, True)
        override = override_settings(MEDIA_ROOT=tmp)
        override.enable()
        self.addCleanup(override.disable)
        self.media_root = Path(tmp)

    def _stored_files(self):
        return [p for p in self.media_root.rglob("*") if p.is_file()]


class AttachmentQuotaTests(_MediaRoot, TestCase):
    def setUp(self):
        cache.clear()
        self._use_temp_media()
        _fixture(self, "quota2007")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def upload(self, url=None, f=None):
        return self.client.post(url or self.url, {"file": f or _png()}, format="multipart")

    def test_defaults_are_generous(self):
        # Backward compatible defaults (#2007): 100 files and 1 GiB per card.
        self.assertEqual(settings.ATTACHMENT_MAX_PER_CARD, 100)
        self.assertEqual(settings.ATTACHMENT_MAX_BYTES_PER_CARD, 1024 ** 3)

    @override_settings(ATTACHMENT_MAX_PER_CARD=2, ATTACHMENT_MAX_BYTES_PER_CARD=0)
    def test_count_quota_refuses_the_next_upload_and_stores_nothing(self):
        self.assertEqual(self.upload().status_code, 201)
        self.assertEqual(self.upload().status_code, 201)
        files_before = self._stored_files()
        resp = self.upload()
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.data["code"], ATTACHMENT_QUOTA_EXCEEDED)
        self.assertIn("maximum of 2 attachments", resp.data["detail"])
        self.assertEqual(CardAttachment.objects.filter(card=self.card).count(), 2)
        self.assertEqual(self._stored_files(), files_before)

    @override_settings(ATTACHMENT_MAX_PER_CARD=0, ATTACHMENT_MAX_BYTES_PER_CARD=150)
    def test_byte_quota_counts_the_incoming_file(self):
        self.assertEqual(self.upload().status_code, 201)  # 100 of 150 bytes
        resp = self.upload()  # would make 200
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.data["code"], ATTACHMENT_QUOTA_EXCEEDED)
        self.assertIn("150 bytes limit", resp.data["detail"])
        # Exactly filling the quota is allowed.
        self.assertEqual(self.upload(f=_png(body=PNG[:50])).status_code, 201)
        self.assertEqual(CardAttachment.objects.filter(card=self.card).count(), 2)

    @override_settings(ATTACHMENT_MAX_PER_CARD=1)
    def test_quota_is_per_card(self):
        self.assertEqual(self.upload().status_code, 201)
        self.assertEqual(self.upload().status_code, 400)
        self.assertEqual(self.upload(url=self.other_url).status_code, 201)

    @override_settings(ATTACHMENT_MAX_PER_CARD=1)
    def test_deleting_frees_a_slot(self):
        pk = self.upload().data["id"]
        self.assertEqual(self.upload().status_code, 400)
        self.assertEqual(self.client.delete(f"{self.url}{pk}/").status_code, 204)
        self.assertEqual(self.upload().status_code, 201)

    @override_settings(ATTACHMENT_MAX_PER_CARD=0, ATTACHMENT_MAX_BYTES_PER_CARD=0)
    def test_zero_turns_both_quotas_off(self):
        for _ in range(3):
            self.assertEqual(self.upload().status_code, 201)

    def test_existing_attachments_over_a_lowered_quota_are_kept(self):
        for _ in range(3):
            self.assertEqual(self.upload().status_code, 201)
        with override_settings(ATTACHMENT_MAX_PER_CARD=2):
            self.assertEqual(self.upload().status_code, 400)
            # Reads are unaffected.
            self.assertEqual(len(self.client.get(self.url).data), 3)
        self.assertEqual(CardAttachment.objects.filter(card=self.card).count(), 3)

    @override_settings(ATTACHMENT_MAX_PER_CARD=1)
    def test_quota_refusal_broadcasts_nothing(self):
        self.assertEqual(self.upload().status_code, 201)
        with mock.patch("boards.broadcast.record_board_event") as record:
            self.assertEqual(self.upload().status_code, 400)
        record.assert_not_called()


class FormatBytesTests(TestCase):
    def test_units(self):
        self.assertEqual(_format_bytes(150), "150 bytes")
        self.assertEqual(_format_bytes(500 * 1024 * 1024), "500 MB")
        self.assertEqual(_format_bytes(1024 ** 3), "1 GB")
        self.assertEqual(_format_bytes(3 * 1024 ** 3 // 2), "1.5 GB")


class AttachmentUploadThrottleTests(_MediaRoot, TestCase):
    def setUp(self):
        cache.clear()
        self._use_temp_media()
        _fixture(self, "throttle2007")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_scope_is_configured(self):
        rates = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
        self.assertIn("attachment_upload", rates)
        self.assertEqual(AttachmentUploadThrottle.scope, "attachment_upload")

    def test_uploads_are_throttled_and_listing_is_not(self):
        with mock.patch.object(AttachmentUploadThrottle, "get_rate", return_value="2/hour"):
            self.assertEqual(self.client.post(self.url, {"file": _png()}, format="multipart").status_code, 201)
            self.assertEqual(self.client.post(self.url, {"file": _png()}, format="multipart").status_code, 201)
            resp = self.client.post(self.other_url, {"file": _png()}, format="multipart")
            # Per user, not per card.
            self.assertEqual(resp.status_code, 429)
            for _ in range(3):
                self.assertEqual(self.client.get(self.url).status_code, 200)
        self.assertEqual(CardAttachment.objects.count(), 2)

    def test_default_user_scope_still_applies_to_uploads(self):
        """Appended, not replacing: the ``user`` scope keeps counting uploads."""
        from rest_framework.throttling import UserRateThrottle

        with mock.patch.object(UserRateThrottle, "get_rate", autospec=True,
                               side_effect=lambda self: "1/hour" if self.scope == "user" else "100/hour"):
            self.assertEqual(self.client.post(self.url, {"file": _png()}, format="multipart").status_code, 201)
            self.assertEqual(self.client.post(self.url, {"file": _png()}, format="multipart").status_code, 429)


class ValidateUploadMimeDeclaredTypeTests(TestCase):
    """The signature must belong to the declared type (#2007)."""

    def _file(self, content, content_type, name="f"):
        return SimpleUploadedFile(name, content, content_type=content_type)

    def test_signature_of_another_allowed_type_is_rejected(self):
        for body, declared in (
            (b"%PDF-1.7 " + b"\x00" * 20, "image/png"),
            (PNG, "application/pdf"),
            (b"PK\x03\x04" + b"\x00" * 20, "image/jpeg"),
            (b"GIF89a" + b"\x00" * 20, "image/png"),
            (b"\xff\xd8\xff\xe0" + b"\x00" * 20, "image/gif"),
        ):
            with self.subTest(declared=declared):
                error = _validate_upload_mime(self._file(body, declared))
                self.assertIsNotNone(error)
                self.assertIn("does not match its declared type", error)

    def test_riff_that_is_not_webp_is_rejected(self):
        wav = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 20
        self.assertIsNotNone(_validate_upload_mime(self._file(wav, "image/webp")))

    def test_real_webp_is_accepted(self):
        webp = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 20
        self.assertIsNone(_validate_upload_mime(self._file(webp, "image/webp")))

    def test_gif87a_and_ooxml_are_accepted(self):
        self.assertIsNone(_validate_upload_mime(self._file(b"GIF87a" + b"\x00" * 10, "image/gif")))
        for declared in (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ):
            with self.subTest(declared=declared):
                self.assertIsNone(_validate_upload_mime(self._file(b"PK\x03\x04" + b"\x00" * 20, declared)))

    def test_declared_type_parameters_and_case_are_ignored(self):
        self.assertIsNone(_validate_upload_mime(self._file(PNG, "Image/PNG; charset=binary")))


class ValidateUploadMimeFullTextSniffTests(TestCase):
    """The whole text body is sniffed, not the first 4 KB (#2007)."""

    def _text(self, body, content_type="text/plain"):
        return SimpleUploadedFile("notes.txt", body, content_type=content_type)

    def test_markup_after_4kb_of_padding_is_rejected(self):
        body = b"a" * 8192 + b"<script>alert(1)</script>"
        error = _validate_upload_mime(self._text(body))
        self.assertIsNotNone(error)
        self.assertIn("HTML/script", error)

    def test_markup_split_across_a_chunk_boundary_is_found(self):
        from boards.views import cards

        with mock.patch.object(cards, "_TEXT_SNIFF_CHUNK", 16):
            for split in range(1, len(b"<iframe")):
                with self.subTest(split=split):
                    body = b"x" * (16 - split) + b"<IFrame src=x>" + b"y" * 40
                    self.assertIsNotNone(_validate_upload_mime(self._text(body, "text/csv")))

    def test_long_clean_text_passes_and_is_left_readable(self):
        body = (b"Title,Column\nCard,Backlog\n" * 5000)
        f = self._text(body, "text/csv")
        self.assertIsNone(_validate_upload_mime(f))
        self.assertEqual(f.read(), body)


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class AttachmentQuotaConcurrencyTests(_MediaRoot, TransactionTestCase):
    """Two uploads racing for the last slot: exactly one wins (#2007).

    ``first`` passes the quota check and holds its transaction (and the card
    row lock) open; ``second`` must wait on that lock, then read the committed
    count and be refused. A quota read outside the lock would let both in.
    """

    def setUp(self):
        cache.clear()
        self._use_temp_media()
        _fixture(self, "race2007")
        patcher = mock.patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _client(self):
        client = APIClient()
        client.force_authenticate(self.user)
        return client

    @override_settings(ATTACHMENT_MAX_PER_CARD=1)
    def test_two_concurrent_uploads_for_the_last_slot(self):
        from boards.views import cards

        real = cards._attachment_quota_error
        paused, release, results = threading.Event(), threading.Event(), {}

        def holding_check(*args, **kwargs):
            outcome = real(*args, **kwargs)
            if threading.current_thread().name == "first" and not paused.is_set():
                paused.set()
                release.wait(HOLD_TIMEOUT)
            return outcome

        def run(name):
            try:
                results[name] = self._client().post(self.url, {"file": _png(f"{name}.png")}, format="multipart")
            except Exception as exc:  # surfaced by the assertions below
                results[name] = exc
            finally:
                connections.close_all()

        with mock.patch.object(cards, "_attachment_quota_error", side_effect=holding_check):
            first = threading.Thread(target=run, args=("first",), name="first")
            first.start()
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "first upload never reached the quota check")
            second = threading.Thread(target=run, args=("second",), name="second")
            second.start()
            assert_blocked_on_lock(self, second, "second upload did not wait for the card lock")
            release.set()
            first.join(HOLD_TIMEOUT)
            second.join(HOLD_TIMEOUT)

        for name in ("first", "second"):
            if isinstance(results.get(name), Exception):
                self.fail(f"{name} raised {type(results[name]).__name__}: {results[name]}")
        self.assertEqual(results["first"].status_code, 201)
        self.assertEqual(results["second"].status_code, 400)
        self.assertEqual(results["second"].data["code"], ATTACHMENT_QUOTA_EXCEEDED)
        self.assertEqual(CardAttachment.objects.filter(card=self.card).count(), 1)
