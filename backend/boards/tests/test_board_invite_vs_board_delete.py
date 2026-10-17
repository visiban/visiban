"""Board invite redemption racing a board delete (#1631).

A redemption — the join view or invite-only registration — locked the invite
row and inserted the new member's ``BoardMembership`` and
``BoardInviteRedemption`` rows under it, without the board row. A board
delete holds the board row from the start of its cascade and reaches the
invite only at its collector ``DELETE``, so it waited on the redemption, and
when that committed the delete failed its deferred foreign keys at COMMIT (a
500). Every redemption now takes the board row first (``FOR NO KEY UPDATE``),
then the invite row, so the two queue whole in either order:

* redemption first: it commits, then the delete removes the board and the new
  membership with it (204);
* delete first: the redemption finds the board gone and answers 404 (join) or
  ``invite_invalid`` (registration), with nothing written and nothing
  broadcast.

Each race pauses the first request inside its transaction right after it
took its locks, starts the second, checks that the second waits, and
releases. PostgreSQL only: SQLite has no row locks.
``LockInviteBoardTests`` runs everywhere.
"""

import threading
from datetime import timedelta
from unittest import skipUnless
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection, connections, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient

from boards.tests.invite_fixtures import generate_invite
from accounts.invite_utils import InviteTokenError
from accounts.models import SiteSetting, User
from boards import broadcast as _broadcast
from boards.invites import lock_invite_board, redeem_board_registration_token
from boards.models import (
    Board,
    BoardEvent,
    BoardInviteLink,
    BoardInviteRedemption,
    BoardMembership,
)
from boards.tests.lock_wait import wait_until_blocked_on_lock

HOLD_TIMEOUT = 10.0
PASSWORD = "Sup3rS3cr3t!xyz"
# The board destroy holds the board row (and its cards and columns) once this
# returns, and has not yet reached the collector's DELETEs.
CASCADE = "boards.services.cards.lock_cards_for_cascade"
# A redemption holds the board and invite rows and has inserted the
# membership and redemption rows once this returns, still uncommitted.
REDEEM = "boards.invites.redeem"


class LockInviteBoardTests(TestCase):
    """The service-side board lock answers False for a board that is gone."""

    def setUp(self):
        self.owner = User.objects.create_user(username="o1631l", password="p")
        self.sender = User.objects.create_user(
            username="s1631l", password="p", is_site_admin=True
        )
        self.board = Board.objects.create(name="L", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.sender, role="admin")

    def test_present_and_missing_board(self):
        with transaction.atomic():
            self.assertTrue(lock_invite_board(self.board.pk))
            self.assertFalse(lock_invite_board(self.board.pk + 10_000))

    def test_registration_redeem_on_a_deleted_board_is_invite_invalid(self):
        # Proves only the outcome: redeeming an invite whose board is gone
        # raises invite_invalid and writes nothing. The board delete cascades
        # to the invite, so the conditional claim alone already refuses it;
        # this does not isolate the lock_invite_board re-check (which is
        # defense in depth, see redeem_board_registration_token).
        link, _raw = generate_invite(BoardInviteLink, board=self.board,
            created_by=self.sender,
            role="member",
            single_use=True,
            delivery="email",
            expires_at=timezone.now() + timedelta(days=7),
        )
        board_id = link.board_id
        newcomer = User.objects.create_user(username="n1631l", password="p")
        Board.objects.filter(pk=board_id).delete()
        with self.assertRaises(InviteTokenError) as ctx:
            redeem_board_registration_token(link, newcomer)
        self.assertEqual(ctx.exception.code, "invite_invalid")
        self.assertFalse(BoardMembership.objects.filter(user=newcomer).exists())
        self.assertFalse(BoardInviteRedemption.objects.filter(user=newcomer).exists())


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class _InviteDeleteRaceBase(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="o1631", password="p")
        self.sender = User.objects.create_user(
            username="s1631", password="p", is_site_admin=True
        )
        self.joiner = User.objects.create_user(username="j1631", password="p")
        self.board = Board.objects.create(name="B1631", owner=self.owner)
        self.board_id = self.board.pk
        BoardMembership.objects.create(board=self.board, user=self.owner, role="admin")
        BoardMembership.objects.create(board=self.board, user=self.sender, role="admin")
        self.link, self.raw = generate_invite(BoardInviteLink, board=self.board,
            created_by=self.sender,
            role="member",
            single_use=True,
            delivery="email",
            expires_at=timezone.now() + timedelta(days=7),
        )
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(cache.clear)

    # -- requests --------------------------------------------------------

    def _delete(self):
        client = APIClient()
        client.force_authenticate(self.owner)
        return client.delete(f"/api/v1/boards/{self.board_id}/")

    def _join(self):
        client = APIClient()
        client.force_authenticate(self.joiner)
        return client.post(f"/api/v1/boards/join/{self.raw}/")

    def _register(self):
        return APIClient().post(
            "/api/v1/auth/registration/",
            {
                "email": "new1631@example.com",
                "password1": PASSWORD,
                "password2": PASSWORD,
                "invite_token": self.raw,
            },
        )

    # -- harness ---------------------------------------------------------

    def _thread(self, name, fn, results):
        def run():
            try:
                results[name] = fn()
            except Exception as exc:  # surfaced by the assertions
                results[name] = exc
            finally:
                # Release this thread's DB connection, or teardown cannot DROP
                # the test database (backend CLAUDE.md, threaded tests).
                connections.close_all()

        t = threading.Thread(target=run, name=name)
        t.start()
        return t

    def _race(self, hold_target, first, second):
        """Run ``first`` (thread "holder") until ``hold_target`` returns in it,
        start ``second``, require that it waits, then release both."""
        module_path, attr = hold_target.rsplit(".", 1)
        real = getattr(__import__(module_path, fromlist=[attr]), attr)
        paused, release, results = threading.Event(), threading.Event(), {}

        def wrapper(*args, **kwargs):
            out = real(*args, **kwargs)
            if threading.current_thread().name == "holder" and not paused.is_set():
                paused.set()
                release.wait(HOLD_TIMEOUT)
            return out

        with patch(hold_target, side_effect=wrapper):
            holder = self._thread("holder", first, results)
            self.assertTrue(
                paused.wait(HOLD_TIMEOUT), "first request never held its locks"
            )
            second_t = self._thread("second", second, results)
            waited = wait_until_blocked_on_lock(second_t)
            release.set()
            holder.join(HOLD_TIMEOUT)
            second_t.join(HOLD_TIMEOUT)
        for name in ("holder", "second"):
            self.assertNotIsInstance(results.get(name), Exception, results.get(name))
        self.assertTrue(waited, "second request did not wait for the first")
        return results["holder"], results["second"]

    # -- assertions ------------------------------------------------------

    def _assert_board_gone_cleanly(self):
        self.assertFalse(Board.objects.filter(pk=self.board_id).exists())
        self.assertFalse(
            BoardMembership.objects.filter(board_id=self.board_id).exists()
        )
        self.assertFalse(BoardInviteLink.objects.filter(pk=self.link.pk).exists())
        self.assertFalse(
            BoardInviteRedemption.objects.filter(invite_id=self.link.pk).exists()
        )

    def _assert_nothing_redeemed(self):
        events = set(
            BoardEvent.objects.filter(board_id=self.board_id).values_list(
                "event", flat=True
            )
        )
        self.assertNotIn(_broadcast.EVT_MEMBER_ADDED, events)
        self.assertLessEqual(events, {_broadcast.EVT_BOARD_DELETED}, events)


class JoinVsBoardDeleteTests(_InviteDeleteRaceBase):
    def test_board_delete_behind_join(self):
        joined, deleted = self._race(REDEEM, self._join, self._delete)
        self.assertEqual(joined.status_code, 201, joined.content[:300])
        self.assertEqual(deleted.status_code, 204, getattr(deleted, "content", deleted))
        self._assert_board_gone_cleanly()

    def test_join_behind_board_delete(self):
        deleted, joined = self._race(CASCADE, self._delete, self._join)
        self.assertEqual(deleted.status_code, 204, deleted.content[:300])
        self.assertEqual(joined.status_code, 404, joined.content[:300])
        self._assert_board_gone_cleanly()
        self._assert_nothing_redeemed()


class RegistrationVsBoardDeleteTests(_InviteDeleteRaceBase):
    def setUp(self):
        super().setUp()
        settings_row = SiteSetting.get()
        settings_row.registration_mode = SiteSetting.RegistrationMode.INVITE_ONLY
        settings_row.save()
        cache.clear()  # drop any cached registration mode

    def tearDown(self):
        settings_row = SiteSetting.get()
        settings_row.registration_mode = SiteSetting.RegistrationMode.OPEN
        settings_row.save()
        super().tearDown()

    def test_board_delete_behind_registration(self):
        registered, deleted = self._race(REDEEM, self._register, self._delete)
        self.assertIn(registered.status_code, (201, 204), registered.content[:300])
        self.assertEqual(deleted.status_code, 204, getattr(deleted, "content", deleted))
        self.assertTrue(User.objects.filter(email="new1631@example.com").exists())
        self._assert_board_gone_cleanly()

    def test_registration_behind_board_delete(self):
        deleted, registered = self._race(CASCADE, self._delete, self._register)
        self.assertEqual(deleted.status_code, 204, deleted.content[:300])
        self.assertEqual(registered.status_code, 400, registered.content[:300])
        self.assertIn("invite_token", registered.json())
        self.assertFalse(User.objects.filter(email="new1631@example.com").exists())
        self._assert_board_gone_cleanly()
        self._assert_nothing_redeemed()
