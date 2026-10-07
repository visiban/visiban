"""Concurrent redemption of one single-use board invite (#1444).

``boards.invites.redeem`` stamps ``used_at`` without a conditional update, so
"one invite, one membership" rests on the row lock both callers take first:
``JoinBoardView.post`` and ``validate_board_registration_token``. These tests
race two requests on one token and require exactly one to win.

TransactionTestCase, because TestCase's wrapping transaction is invisible to
the threads. PostgreSQL only: SQLite has no SELECT FOR UPDATE.
"""
import threading
from datetime import timedelta

from django.core.cache import cache
from django.db import connection
from django.test import TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import SiteSetting, User
from boards.models import Board, BoardInviteLink, BoardInviteRedemption, BoardMembership

PASSWORD = "Sup3rS3cr3t!xyz"


def _race(target, args_list):
    """Run ``target`` once per args tuple, all released together."""
    results = []
    barrier = threading.Barrier(len(args_list))

    def run(*args):
        from django.db import connections as _conns

        try:
            barrier.wait()
            results.append(target(*args))
        finally:
            # Release this thread's DB connection, or teardown cannot DROP the
            # test database (backend CLAUDE.md, threaded tests).
            _conns.close_all()

    threads = [threading.Thread(target=run, args=args) for args in args_list]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


class _RaceFixture(TransactionTestCase):

    def setUp(self):
        if connection.vendor == "sqlite":
            self.skipTest("SQLite does not support SELECT FOR UPDATE; this test requires PostgreSQL.")
        cache.clear()
        self.owner = User.objects.create_user(username="race_owner", password="p")
        self.sender = User.objects.create_user(username="race_sender", password="p", is_site_admin=True)
        self.board = Board.objects.create(name="Race Board", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.sender, role="admin")
        self.link, self.raw = BoardInviteLink.generate(
            board=self.board, created_by=self.sender, role="member", single_use=True,
            delivery="email", expires_at=timezone.now() + timedelta(days=7),
        )

    def tearDown(self):
        cache.clear()


class BoardJoinRaceTests(_RaceFixture):

    def test_only_one_of_two_concurrent_joins_succeeds(self):
        users = [User.objects.create_user(username=f"race_u{i}", password="p") for i in range(2)]

        def join(user):
            client = APIClient()
            client.force_authenticate(user)
            return client.post(f"/api/v1/boards/join/{self.raw}/").status_code

        results = _race(join, [(u,) for u in users])
        self.assertEqual(sorted(results), [201, 410], results)
        self.assertEqual(BoardMembership.objects.filter(board=self.board, user__in=users).count(), 1)
        self.assertEqual(BoardInviteRedemption.objects.filter(invite=self.link).count(), 1)
        self.link.refresh_from_db()
        self.assertEqual(self.link.use_count, 1)


class BoardRegistrationRaceTests(_RaceFixture):

    def setUp(self):
        super().setUp()
        if connection.vendor == "sqlite":
            return
        settings_row = SiteSetting.get()
        settings_row.registration_mode = SiteSetting.RegistrationMode.INVITE_ONLY
        settings_row.save()
        cache.clear()  # drop any cached registration mode

    def tearDown(self):
        settings_row = SiteSetting.get()
        settings_row.registration_mode = SiteSetting.RegistrationMode.OPEN
        settings_row.save()
        super().tearDown()

    def test_only_one_concurrent_registration_succeeds(self):
        def register(email):
            return APIClient().post("/api/v1/auth/registration/", {
                "email": email, "password1": PASSWORD, "password2": PASSWORD, "invite_token": self.raw,
            }).status_code

        results = _race(register, [(f"race{i}@example.com",) for i in range(2)])
        self.assertEqual(sum(1 for s in results if s in (201, 204)), 1, results)
        self.assertEqual(User.objects.filter(email__startswith="race").count(), 1)
        self.assertEqual(BoardMembership.objects.filter(board=self.board).exclude(user=self.sender).count(), 1)
        self.link.refresh_from_db()
        self.assertIsNotNone(self.link.used_at)
