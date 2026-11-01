"""Concurrent email-change requests leave at most one change-request row (#1303).

``User.pending_email_address`` marks the one unverified ``EmailAddress`` row a
change request owns. Two ``PATCH /auth/me/`` requests that each read the
pointer before either wrote it used to each create a row, leaving the loser's
row with no pointer: an orphan that ``DELETE /auth/me/pending-email/`` cannot
tell from a secondary address the user wants. ``accounts.email_change`` now
re-reads the pointer under ``credentials.lock_user_row``, so request, cancel
and resend are serialized per user.

PostgreSQL only: SQLite has no row locks, so the tests skip there.
"""

import threading

from allauth.account.models import EmailAddress
from django.core.cache import cache
from django.db import connection, connections, transaction
from django.test import TransactionTestCase, override_settings
from rest_framework import status

from accounts import credentials
from accounts.models import User
from accounts.tests.email_change_helpers import PasswordConfirmingAPIClient
from boards.tests.lock_wait import assert_blocked_on_lock

PASSWORD = (
    "pass12345678"  # gitleaks:allow -- test-only fixture password, not a credential
)
OLD = "lee@old.example"
FIRST = "lee@first.example"
SECOND = "lee@second.example"
PROFILE = "/api/v1/auth/me/"
PENDING = "/api/v1/auth/me/pending-email/"
RESEND = "/api/v1/auth/me/pending-email/resend/"


@override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory")
class ConcurrentEmailChangeTests(TransactionTestCase):
    HOLD_TIMEOUT = 10

    def setUp(self):
        if connection.vendor != "postgresql":
            self.skipTest("row-lock wait behavior needs PostgreSQL")
        cache.clear()
        self.addCleanup(cache.clear)
        self.user = User.objects.create_user(username="lee", email=OLD, password=PASSWORD)
        EmailAddress.objects.create(user=self.user, email=OLD, verified=True, primary=True)

    def _client(self):
        # Signed in up front: force_login writes last_login on the user row,
        # which would itself wait for the lock the holder takes.
        client = PasswordConfirmingAPIClient(password=PASSWORD)
        client.force_login(self.user)
        return client

    def _run_behind_lock(self, requests):
        """Start each ``(name, callable)`` while another transaction holds the user lock.

        Every request is proven to be waiting on the lock before the next
        starts and before the lock is released, so they are queued in the
        listed order. Returns ``{name: response}``.
        """
        holding = threading.Event()
        release = threading.Event()
        responses = {}

        def holder():
            try:
                with transaction.atomic():
                    credentials.lock_user_row(self.user)
                    holding.set()
                    release.wait(self.HOLD_TIMEOUT)
            finally:
                connections.close_all()

        def worker(name, call):
            try:
                responses[name] = call()
            finally:
                connections.close_all()

        holder_thread = threading.Thread(target=holder, name="user-lock-holder")
        threads = []
        holder_thread.start()
        try:
            self.assertTrue(holding.wait(self.HOLD_TIMEOUT))
            for name, call in requests:
                thread = threading.Thread(target=worker, args=(name, call), name=name)
                thread.start()
                threads.append(thread)
                assert_blocked_on_lock(self, thread, f"{name} did not wait for the user lock")
        finally:
            release.set()
            holder_thread.join(self.HOLD_TIMEOUT)
            for thread in threads:
                thread.join(self.HOLD_TIMEOUT)
        return responses

    def _unverified_secondary_emails(self):
        return set(
            EmailAddress.objects.filter(user=self.user, verified=False, primary=False)
            .values_list("email", flat=True)
        )

    def test_two_racing_patches_leave_one_tracked_row_and_no_orphan(self):
        a, b = self._client(), self._client()
        responses = self._run_behind_lock(
            [
                ("patch-first", lambda: a.patch(PROFILE, {"email": FIRST}, format="json")),
                ("patch-second", lambda: b.patch(PROFILE, {"email": SECOND}, format="json")),
            ]
        )
        for response in responses.values():
            self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        # The later request replaced the earlier one; nothing is left behind.
        self.assertEqual(self._unverified_secondary_emails(), {SECOND})
        self.assertEqual(self.user.pending_email_address.email, SECOND)
        self.assertEqual(self.user.email, OLD)

    def test_cancel_after_racing_patches_leaves_no_change_request_row(self):
        a, b, c = self._client(), self._client(), self._client()
        self._run_behind_lock(
            [
                ("patch-first", lambda: a.patch(PROFILE, {"email": FIRST}, format="json")),
                ("patch-second", lambda: b.patch(PROFILE, {"email": SECOND}, format="json")),
            ]
        )
        self.assertEqual(c.delete(PENDING).status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(self._unverified_secondary_emails(), set())

    def test_cancel_queued_behind_a_patch_removes_the_new_row(self):
        a, c = self._client(), self._client()
        responses = self._run_behind_lock(
            [
                ("patch", lambda: a.patch(PROFILE, {"email": FIRST}, format="json")),
                ("cancel", lambda: c.delete(PENDING)),
            ]
        )
        self.assertEqual(responses["patch"].status_code, status.HTTP_200_OK)
        self.assertEqual(responses["cancel"].status_code, status.HTTP_204_NO_CONTENT)
        self.user.refresh_from_db()
        self.assertIsNone(self.user.pending_email_address_id)
        self.assertEqual(self._unverified_secondary_emails(), set())

    def test_resend_waits_for_the_lock_and_mails_the_current_row(self):
        a, r = self._client(), self._client()
        responses = self._run_behind_lock(
            [
                ("patch", lambda: a.patch(PROFILE, {"email": FIRST}, format="json")),
                ("resend", lambda: r.post(RESEND)),
            ]
        )
        self.assertEqual(responses["patch"].status_code, status.HTTP_200_OK)
        # The patch queued first, so the resend saw its row. allauth's
        # cooldown (the patch just mailed that address) skips the send: 429.
        self.assertIn(
            responses["resend"].status_code,
            (status.HTTP_200_OK, status.HTTP_429_TOO_MANY_REQUESTS),
        )
