"""Credential issuance and password-change finalization are serialized on the user row (#1564).

Creating a personal access token and changing the password both take the user
row lock first (``accounts.credentials.lock_user_row``), so for one user they
run one after the other and the later one sees the earlier one's committed
state. The tests use a PostgreSQL pause-and-barrier (as in
``boards/tests/test_concurrent_lock_sites.py``, #1524) to make the ordering
deterministic, and are skipped on SQLite, which has no row locks.
"""

import threading
import time
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from accounts import credentials
from accounts.models import PersonalAccessToken, User

HOLD_SECONDS = 2.5
OLD_PASSWORD = "OldPassword123!"
NEW_PASSWORD = "NewPassword456!"


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class CredentialRowLockTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="locker", password=OLD_PASSWORD)
        PersonalAccessToken.generate(self.user, "existing")

    def _change_password(self):
        user = User.objects.get(pk=self.user.pk)
        client = APIClient()
        client.force_authenticate(user)
        return client.post(
            "/api/v1/auth/change-password/",
            {"current_password": OLD_PASSWORD, "new_password": NEW_PASSWORD},
            format="json",
        )

    def _create_token(self, earlier_user):
        client = APIClient()
        client.force_authenticate(earlier_user)
        return client.post("/api/v1/auth/tokens/", {"name": "racing"}, format="json")

    def _run_pair(self, first, second, patch_obj, attr):
        """Run ``first`` paused inside its transaction, then ``second``."""
        paused = threading.Event()
        results, errors, marks = {}, [], {}
        original = getattr(patch_obj, attr)

        def hold(*args, **kwargs):
            out = original(*args, **kwargs)
            if threading.current_thread().name == "first" and not paused.is_set():
                paused.set()
                threading.Event().wait(HOLD_SECONDS)
                marks["hold_ended"] = time.monotonic()
            return out

        def worker(name, fn):
            try:
                results[name] = (fn(), time.monotonic())
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
            finally:
                connections.close_all()

        with patch.object(patch_obj, attr, side_effect=hold):
            t1 = threading.Thread(target=worker, args=("first", first), name="first")
            t1.start()
            self.assertTrue(paused.wait(timeout=15), "first request never reached the pause")
            t2 = threading.Thread(target=worker, args=("second", second), name="second")
            t2.start()
            t1.join(timeout=30)
            t2.join(timeout=30)
        self.assertEqual(errors, [])
        return results, marks["hold_ended"]

    def test_token_create_after_password_change_is_refused(self):
        earlier_user = User.objects.get(pk=self.user.pk)
        results, hold_ended = self._run_pair(
            self._change_password,
            lambda: self._create_token(earlier_user),
            credentials,
            "lock_user_row",
        )
        # lock_user_row is also called by the second request; only the first
        # thread pauses, and it pauses holding the lock it just took.
        change, _ = results["first"]
        create, create_done = results["second"]
        self.assertEqual(change.status_code, 200)
        self.assertGreaterEqual(create_done, hold_ended)
        self.assertEqual(create.status_code, 401)
        self.assertEqual(PersonalAccessToken.objects.filter(user_id=self.user.pk).count(), 0)

    def test_password_change_after_token_create_removes_token(self):
        earlier_user = User.objects.get(pk=self.user.pk)
        results, hold_ended = self._run_pair(
            lambda: self._create_token(earlier_user),
            self._change_password,
            credentials,
            "lock_user_row",
        )
        create, _ = results["first"]
        change, change_done = results["second"]
        self.assertEqual(create.status_code, 201)
        self.assertEqual(change.status_code, 200)
        self.assertGreaterEqual(change_done, hold_ended)
        self.assertEqual(PersonalAccessToken.objects.filter(user_id=self.user.pk).count(), 0)
