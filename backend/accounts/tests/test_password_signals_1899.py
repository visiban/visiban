"""allauth password signal receivers (#1899).

``accounts.password_signals`` had no test reference. The receivers are defense
in depth (see the module docstring): the project URLconf redirects allauth's
HTML password views to the SPA, so nothing in a default install sends these
signals. Sending them directly proves the backstop still finalizes the account.
"""

from unittest.mock import patch

from allauth.account.signals import password_changed, password_reset, password_set
from django.test import TestCase
from rest_framework.authtoken.models import Token

from accounts import credentials, password_signals
from accounts.models import User


class PasswordSignalReceiverTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="sig", password="pass", must_change_password=True
        )
        Token.objects.create(user=self.user)

    def test_password_changed_clears_forced_change_flag_and_revokes_token(self):
        password_changed.send(sender=User, request=None, user=self.user)
        self.user.refresh_from_db()
        self.assertFalse(self.user.must_change_password)
        self.assertFalse(Token.objects.filter(user=self.user).exists())

    def test_password_reset_signal_finalizes_the_account(self):
        password_reset.send(sender=User, request=None, user=self.user)
        self.user.refresh_from_db()
        self.assertFalse(self.user.must_change_password)
        self.assertFalse(Token.objects.filter(user=self.user).exists())

    def test_password_set_signal_finalizes_the_account(self):
        password_set.send(sender=User, request=None, user=self.user)
        self.user.refresh_from_db()
        self.assertFalse(self.user.must_change_password)

    def test_each_signal_calls_the_matching_helper_with_the_right_first_password_flag(self):
        with patch.object(credentials, "finalize_password_change") as change, patch.object(
            credentials, "finalize_password_reset"
        ) as reset:
            password_changed.send(sender=User, request=None, user=self.user)
            change.assert_called_once_with(self.user)
            change.reset_mock()
            # A set is always an account's first password, so the notice applies.
            password_set.send(sender=User, request=None, user=self.user)
            change.assert_called_once_with(self.user, first_password=True)
            # A reset cannot know whether it was the first, so the backstop
            # never repeats the first-password notice.
            password_reset.send(sender=User, request=None, user=self.user)
            reset.assert_called_once_with(self.user)

    def test_receivers_are_connected_exactly_once_after_reconnecting(self):
        """``dispatch_uid`` keeps a second ``connect_password_signals`` call
        (an app reload in tests, for example) from running every receiver twice."""
        password_signals.connect_password_signals()
        password_signals.connect_password_signals()
        with patch.object(credentials, "finalize_password_change") as change:
            password_changed.send(sender=User, request=None, user=self.user)
        self.assertEqual(change.call_count, 1)
