"""Shared account-state predicate used by REST permission classes and WebSocket checks."""

from types import SimpleNamespace

from django.test import SimpleTestCase

from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
    has_pending_account_action,
    has_pending_password_change,
    has_pending_username_change,
)


class AccountStatePredicateTests(SimpleTestCase):
    def test_clear_user_has_no_pending_action(self):
        user = SimpleNamespace(must_change_password=False, must_change_username=False)
        self.assertFalse(has_pending_account_action(user))

    def test_each_flag_is_detected(self):
        pw = SimpleNamespace(must_change_password=True, must_change_username=False)
        un = SimpleNamespace(must_change_password=False, must_change_username=True)
        self.assertTrue(has_pending_password_change(pw))
        self.assertFalse(has_pending_username_change(pw))
        self.assertTrue(has_pending_username_change(un))
        self.assertTrue(has_pending_account_action(pw))
        self.assertTrue(has_pending_account_action(un))

    def test_missing_attributes_default_to_clear(self):
        self.assertFalse(has_pending_account_action(SimpleNamespace()))

    def test_drf_classes_agree_with_predicate(self):
        for pw, un in ((False, False), (True, False), (False, True)):
            user = SimpleNamespace(
                is_authenticated=True, must_change_password=pw, must_change_username=un
            )
            request = SimpleNamespace(user=user)
            self.assertEqual(
                MustNotHavePendingPasswordChange().has_permission(request, None), not pw
            )
            self.assertEqual(
                MustNotHavePendingUsernameChange().has_permission(request, None), not un
            )
