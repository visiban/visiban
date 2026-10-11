"""A card write racing a hard delete of that card (#1587).

Two defects, one mechanism:

* ``update_card``: a delete committing between the request's read and
  ``serializer.save()`` made the UPDATE match no row, and Django fell back to
  an INSERT — the PATCH answered 200 and the deleted card came back under the
  same pk with its children gone.
* Child creates (comment, checklist item, attachment, relation) and the
  checklist PATCH/DELETE activity rows: on PostgreSQL the card foreign keys
  are ``DEFERRABLE INITIALLY DEFERRED``, so a delete committing after the
  request's refetch failed the request's FK check at COMMIT — a 500.

The fix is ``boards.services.cards.lock_card_for_write``: every such write
locks the card row first and answers 404 if it is gone, and ``delete_card``
locks the row before collecting its cascade.

``CardWriteVsDeleteNotFoundTests`` runs on any backend: the delete is injected
on the request's own connection just before the lock, which is the "delete
committed first" outcome. ``CardWriteVsDeleteLockTests`` is PostgreSQL only
and uses real concurrent transactions in both orders (the hold-the-transaction
pattern from ``docs/development/testing.md``). To see the bug, make
``lock_card_for_write`` a no-op: the delete-first tests then fail with an
``IntegrityError`` at COMMIT (or, for PATCH, a 200 that re-creates the card).
"""

import threading
from unittest import skipUnless
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection, connections
from django.db import transaction
from django.test import TransactionTestCase
from django.utils import timezone
from rest_framework.generics import get_object_or_404 as _real_get_object_or_404
from rest_framework.test import APIClient, APITestCase

from accounts.models import User
from boards.models import (
    Board, BoardEvent, BoardMembership, Card, CardActivity, CardAttachment, CardChecklist,
    CardComment, CardMovement, CardRelation, Column, Swimlane,
)
from boards.services import cards as card_services

SERVICES = "boards.services.cards"
HOLD_TIMEOUT = 10.0
# How long the second request is given to (wrongly) get past the lock before
# the test asserts it is still waiting on it.
BLOCK_PROBE = 0.5


def _fixture(test, username):
    test.user = User.objects.create_user(username=username, password="pass")
    test.board = Board.objects.create(name="B", owner=test.user)
    BoardMembership.objects.create(
        board=test.board, user=test.user, role=BoardMembership.Role.ADMIN,
    )
    col = Column.objects.create(board=test.board, name="A", position=0)
    swim = Swimlane.objects.create(board=test.board, name="G", position=0)
    test.card = Card.objects.create(
        board=test.board, column=col, swimlane=swim, title="C",
        created_by=test.user, position=0,
    )
    test.other = Card.objects.create(
        board=test.board, column=col, swimlane=swim, title="D",
        created_by=test.user, position=1,
    )
    test.item = CardChecklist.objects.create(
        card=test.card, text="todo", created_by=test.user, position=0,
    )
    test.base = f"/api/v1/boards/{test.board.pk}/cards/{test.card.pk}"


def _requests(test):
    """The racing writes, each as ``client -> response``."""
    return {
        "patch": lambda c: c.patch(f"{test.base}/", {"title": "again"}, format="json"),
        "comment": lambda c: c.post(f"{test.base}/comments/", {"body": "hi"}, format="json"),
        "checklist_create": lambda c: c.post(f"{test.base}/checklist/", {"text": "x"}, format="json"),
        "checklist_patch": lambda c: c.patch(
            f"{test.base}/checklist/{test.item.pk}/", {"is_checked": True}, format="json",
        ),
        "checklist_delete": lambda c: c.delete(f"{test.base}/checklist/{test.item.pk}/"),
        "attachment": lambda c: c.post(
            f"{test.base}/attachments/",
            {"file": SimpleUploadedFile("doc.txt", b"hello", content_type="text/plain")},
            format="multipart",
        ),
        "relation": lambda c: c.post(
            f"{test.base}/relations/",
            {"to_card": test.other.pk, "direction": "blocks"},
            format="json",
        ),
        "archive": lambda c: c.post(f"{test.base}/archive/"),
        "unarchive": lambda c: c.post(f"{test.base}/unarchive/"),
    }


class CardWriteVsDeleteNotFoundTests(APITestCase):
    """Delete lands just before the write's lock: 404, nothing written or recorded."""

    def setUp(self):
        _fixture(self, "racer1587")
        self.client.force_authenticate(self.user)
        self.events_before = BoardEvent.objects.count()

    def _delete_before_lock(self):
        real = card_services.lock_card_for_write
        pk = self.card.pk

        def racing(card_id):
            Card.objects.filter(pk=pk).delete()
            return real(card_id)

        return patch(f"{SERVICES}.lock_card_for_write", side_effect=racing)

    def _assert_404_and_silent(self, resp):
        self.assertEqual(resp.status_code, 404, getattr(resp, "data", None))
        self.assertEqual(BoardEvent.objects.count(), self.events_before)

    # The injected delete runs inside the request's own transaction, so the
    # 404 rolls it back along with everything else: the card row is restored.
    # What these pin is that nothing the request meant to write survives.

    def test_patch_returns_404_and_does_not_write(self):
        with self._delete_before_lock():
            resp = self.client.patch(f"{self.base}/", {"title": "again"}, format="json")
        self._assert_404_and_silent(resp)
        self.assertFalse(Card.objects.filter(title="again").exists())
        self.assertFalse(CardActivity.objects.exists())

    def test_child_writes_return_404(self):
        """The 404 must come from the lock, before anything is written — not
        from #1584's refetch, which would also 404 but only after the write.
        The refetch is made to fail the test if it is reached at all."""
        reqs = _requests(self)
        refetch_reached = AssertionError("write went past the card lock to the refetch")
        for name in ("comment", "checklist_create", "checklist_patch", "checklist_delete", "attachment"):
            with self.subTest(name), self._delete_before_lock(), patch(
                "boards.views._helpers._card_queryset", side_effect=refetch_reached,
            ):
                with patch("boards.views.cards._validate_upload_mime", return_value=None):
                    resp = reqs[name](self.client)
                self._assert_404_and_silent(resp)
                self.assertEqual(CardComment.objects.count(), 0)
                self.assertEqual(CardAttachment.objects.count(), 0)
                self.assertFalse(CardActivity.objects.exists())
                self.assertEqual(CardChecklist.objects.get(pk=self.item.pk).is_checked, False)
                self.assertEqual(CardChecklist.objects.count(), 1)

    def test_relation_create_returns_404(self):
        pk = self.card.pk

        def racing(*args, **kwargs):
            obj = _real_get_object_or_404(*args, **kwargs)
            if isinstance(obj, Card) and obj.pk == pk:
                Card.objects.filter(pk=pk).delete()
            return obj

        with patch("boards.views.cards.get_object_or_404", side_effect=racing):
            resp = _requests(self)["relation"](self.client)
        # Deleted outside the request's transaction here, so it stays gone.
        self._assert_404_and_silent(resp)
        self.assertFalse(Card.objects.filter(pk=pk).exists())
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_delete_of_already_deleted_card_returns_404(self):
        real = card_services.lock_card_row
        pk = self.card.pk

        def racing(card_id):
            Card.objects.filter(pk=pk).delete()
            return real(card_id)

        with patch(f"{SERVICES}.lock_card_row", side_effect=racing):
            resp = self.client.delete(f"{self.base}/")
        # No second card.deleted for a card another request already deleted.
        self._assert_404_and_silent(resp)

    def test_delete_of_concurrently_archived_card_returns_404(self):
        """Archived under the delete's lock, after the view read it active:
        still refused, as delete_card's docstring promises (#1587)."""
        real = card_services.lock_card_row
        pk = self.card.pk

        def racing(card_id):
            Card.objects.filter(pk=pk).update(archived_at=timezone.now())
            return real(card_id)

        with patch(f"{SERVICES}.lock_card_row", side_effect=racing):
            resp = self.client.delete(f"{self.base}/")
        self._assert_404_and_silent(resp)
        self.assertTrue(Card.objects.filter(pk=pk).exists())

    def test_archive_and_unarchive_return_404(self):
        """Without the lock the update_fields save matches no row and raises
        "did not affect any rows" — a 500."""
        reqs = _requests(self)
        for name in ("archive", "unarchive"):
            if name == "unarchive":
                Card.objects.filter(pk=self.card.pk).update(archived_at=timezone.now())
            with self.subTest(name), self._delete_before_lock():
                resp = reqs[name](self.client)
            self._assert_404_and_silent(resp)
            self.assertFalse(CardMovement.objects.filter(card_id=self.card.pk).exists())

    def test_unraced_writes_still_succeed(self):
        reqs = _requests(self)
        with patch("boards.views.cards._validate_upload_mime", return_value=None):
            for name, expected in (
                ("patch", 200), ("comment", 201), ("checklist_create", 201),
                ("checklist_patch", 200), ("attachment", 201), ("relation", 201),
                ("checklist_delete", 204),
            ):
                with self.subTest(name):
                    self.assertEqual(reqs[name](self.client).status_code, expected)
        self.assertEqual(self.client.delete(f"{self.base}/").status_code, 204)


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class CardWriteVsDeleteLockTests(TransactionTestCase):
    def setUp(self):
        _fixture(self, "racer1587pg")
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        mime = patch("boards.views.cards._validate_upload_mime", return_value=None)
        mime.start()
        self.addCleanup(mime.stop)

    def _client(self):
        client = APIClient()
        client.force_authenticate(self.user)
        return client

    def _thread(self, name, fn, results):
        def run():
            try:
                results[name] = fn(self._client())
            except Exception as exc:  # surfaced by the assertions below
                results[name] = exc
            finally:
                connections.close_all()
        t = threading.Thread(target=run, name=name)
        t.start()
        return t

    def _pause_in(self, target, thread_name, paused, release):
        """Wrap ``target`` so its first call on ``thread_name`` holds the
        caller's open transaction until ``release`` is set."""
        module_path, attr = target.rsplit(".", 1)
        real = getattr(__import__(module_path, fromlist=[attr]), attr)

        def wrapper(*args, **kwargs):
            if threading.current_thread().name == thread_name and not paused.is_set():
                paused.set()
                release.wait(HOLD_TIMEOUT)
            return real(*args, **kwargs)

        return patch(target, side_effect=wrapper)

    def _status(self, results, name):
        value = results.get(name)
        if isinstance(value, Exception):
            self.fail(f"{name} raised {type(value).__name__}: {value}")
        return value.status_code

    def _write_then_delete(self, name, hold_target, expected):
        """The write holds the card lock; the delete queues behind it and then
        cascades the write's new rows away."""
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(hold_target, "writer", paused, release):
            writer = self._thread("writer", _requests(self)[name], results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "writer never reached its hold point")
            deleter = self._thread("deleter", lambda c: c.delete(f"{self.base}/"), results)
            deleter.join(BLOCK_PROBE)
            self.assertTrue(deleter.is_alive(), "delete did not wait for the writer's card lock")
            release.set()
            writer.join(HOLD_TIMEOUT)
            deleter.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "writer"), expected)
        self.assertEqual(self._status(results, "deleter"), 204)
        self._assert_card_and_children_gone()

    def _delete_then_write(self, name):
        """The delete holds the card lock; the write queues behind it, finds
        the card gone, and answers 404 with nothing written or recorded."""
        paused, release, results = threading.Event(), threading.Event(), {}
        events_before = BoardEvent.objects.filter(event="card.updated").count()
        # _blocked_peer_ids runs inside delete_card's transaction, after its lock.
        with self._pause_in(f"{SERVICES}._blocked_peer_ids", "deleter", paused, release):
            deleter = self._thread("deleter", lambda c: c.delete(f"{self.base}/"), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold point")
            writer = self._thread("writer", _requests(self)[name], results)
            writer.join(BLOCK_PROBE)
            self.assertTrue(writer.is_alive(), "write did not wait for the delete's card lock")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            writer.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "deleter"), 204)
        self.assertEqual(self._status(results, "writer"), 404)
        self._assert_card_and_children_gone()
        self.assertEqual(
            BoardEvent.objects.filter(event="card.updated").count(), events_before,
        )

    def _assert_card_and_children_gone(self):
        pk = self.card.pk
        self.assertFalse(Card.objects.filter(pk=pk).exists())
        self.assertFalse(CardComment.objects.filter(card_id=pk).exists())
        self.assertFalse(CardChecklist.objects.filter(card_id=pk).exists())
        self.assertFalse(CardAttachment.objects.filter(card_id=pk).exists())
        self.assertFalse(CardActivity.objects.filter(card_id=pk).exists())
        self.assertFalse(CardRelation.objects.filter(from_card_id=pk).exists())
        self.assertFalse(CardRelation.objects.filter(to_card_id=pk).exists())

    # -- delete first: the write must 404, not 500 at COMMIT / re-insert ----

    def test_patch_after_delete_returns_404(self):
        self._delete_then_write("patch")

    def test_comment_after_delete_returns_404(self):
        self._delete_then_write("comment")

    def test_checklist_create_after_delete_returns_404(self):
        self._delete_then_write("checklist_create")

    def test_checklist_patch_after_delete_returns_404(self):
        self._delete_then_write("checklist_patch")

    def test_attachment_after_delete_returns_404(self):
        self._delete_then_write("attachment")

    def test_relation_after_delete_returns_404(self):
        self._delete_then_write("relation")

    # -- write first: the delete must wait, then remove the new rows too ----
    # Held at the refetch, i.e. after the write and before COMMIT — the
    # window in which a delete used to commit underneath the write.

    def test_patch_then_delete(self):
        self._write_then_delete("patch", "boards.views._helpers._card_queryset", 200)

    def test_comment_then_delete(self):
        self._write_then_delete("comment", "boards.views._helpers._card_queryset", 201)

    def test_checklist_create_then_delete(self):
        self._write_then_delete("checklist_create", "boards.views._helpers._card_queryset", 201)

    def test_attachment_then_delete(self):
        self._write_then_delete("attachment", "boards.views._helpers._card_queryset", 201)

    def test_relation_then_delete(self):
        self._write_then_delete("relation", "boards.views.cards._card_queryset", 201)

    def test_checklist_patch_then_delete(self):
        self._write_then_delete("checklist_patch", "boards.views._helpers._card_queryset", 200)

    # -- archive / unarchive ------------------------------------------------

    def test_archive_after_delete_returns_404(self):
        self._delete_then_write("archive")

    def test_archive_then_delete_refuses_archived_card(self):
        """Write first: the delete waits for the archive, then finds the card
        archived under its own lock and refuses it — the "archived cards are
        rejected" rule, not a hard delete of an archived card."""
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(f"{SERVICES}._archive_movement", "writer", paused, release):
            writer = self._thread("writer", _requests(self)["archive"], results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "archive never reached its hold point")
            deleter = self._thread("deleter", lambda c: c.delete(f"{self.base}/"), results)
            deleter.join(BLOCK_PROBE)
            self.assertTrue(deleter.is_alive(), "delete did not wait for the archive's card lock")
            release.set()
            writer.join(HOLD_TIMEOUT)
            deleter.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "writer"), 200)
        self.assertEqual(self._status(results, "deleter"), 404)
        self.assertIsNotNone(Card.objects.get(pk=self.card.pk).archived_at)

    # The REST delete refuses an archived card before it locks anything, so
    # the unarchive races use a deleter that does what any other hard delete
    # of the row must (#1599): lock the card, then delete it with its cascade.

    def _raw_deleter(self, pause=None):
        pk = self.card.pk

        def run(_client):
            with transaction.atomic():
                card_services.lock_card_row(pk)
                Card.objects.filter(pk=pk).delete()
                if pause is not None:
                    pause[0].set()
                    pause[1].wait(HOLD_TIMEOUT)
            return "deleted"
        return run

    def test_unarchive_after_delete_returns_404(self):
        Card.objects.filter(pk=self.card.pk).update(archived_at=timezone.now())
        paused, release, results = threading.Event(), threading.Event(), {}
        deleter = self._thread("deleter", self._raw_deleter((paused, release)), results)
        self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold point")
        writer = self._thread("writer", _requests(self)["unarchive"], results)
        writer.join(BLOCK_PROBE)
        self.assertTrue(writer.is_alive(), "unarchive did not wait for the delete's card lock")
        release.set()
        deleter.join(HOLD_TIMEOUT)
        writer.join(HOLD_TIMEOUT)
        self.assertEqual(results.get("deleter"), "deleted")
        self.assertEqual(self._status(results, "writer"), 404)
        self._assert_card_and_children_gone()
        self.assertFalse(CardMovement.objects.filter(card_id=self.card.pk).exists())

    def test_unarchive_then_delete(self):
        Card.objects.filter(pk=self.card.pk).update(archived_at=timezone.now())
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(f"{SERVICES}._archive_movement", "writer", paused, release):
            writer = self._thread("writer", _requests(self)["unarchive"], results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "unarchive never reached its hold point")
            deleter = self._thread("deleter", self._raw_deleter(), results)
            deleter.join(BLOCK_PROBE)
            self.assertTrue(deleter.is_alive(), "delete did not wait for the unarchive's card lock")
            release.set()
            writer.join(HOLD_TIMEOUT)
            deleter.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "writer"), 200)
        self.assertIsInstance(results.get("deleter"), str, results.get("deleter"))
        self._assert_card_and_children_gone()
        self.assertFalse(CardMovement.objects.filter(card_id=self.card.pk).exists())
