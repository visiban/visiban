"""Granting all-content access is superuser-only, and access-flag changes are logged (#1830).

``can_access_all_content`` reads and writes every board and group. A site admin
who could set it would hold that access at will, on their own account or on any
account they create, so the grant takes a superuser, judged on a fresh read of
the actor under the target's row lock. Revoking stays with any site admin.

The log half follows the rule in ``test_admin_action_log.py``: what is *not*
written matters as much as what is. A resubmitted value is no event, and a flag
derived from superuser status is recorded once, by the route with an actor.
"""
import os
import tempfile
from io import StringIO
from unittest import mock

from django.contrib import admin as django_admin
from django.contrib.admin.utils import flatten_fieldsets
from django.core.management import call_command
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts import admin_views
from accounts.admin import VisibanUserAdmin
from accounts.models import (
    AdminActionLog,
    PersonalAccessToken,
    SCOPE_ADMIN,
    SCOPE_WRITE,
    User,
)
from accounts.tests.test_admin_access_revocation import _form_data

Action = AdminActionLog.Action
PW = "flagpass123!"
GRANT_MESSAGE = "Only a superuser can grant all-content access."
ACCESS_ACTIONS = (
    Action.USER_SITE_ADMIN_GRANTED,
    Action.USER_SITE_ADMIN_REVOKED,
    Action.USER_ALL_CONTENT_GRANTED,
    Action.USER_ALL_CONTENT_REVOKED,
)


def _site_admin(name):
    user = User.objects.create_user(username=name, password=PW)
    User.objects.filter(pk=user.pk).update(is_site_admin=True)
    return User.objects.get(pk=user.pk)


def _superuser(name):
    return User.objects.create_superuser(
        username=name, email=f"{name}@example.com", password=PW
    )


def _failing_access_log_write():
    """Patch ``record`` to fail on access-flag rows only, leaving other rows alone."""
    real_record = AdminActionLog.record

    def record(*, action, **kwargs):
        if action in ACCESS_ACTIONS:
            raise RuntimeError("log down")
        return real_record(action=action, **kwargs)

    return mock.patch.object(AdminActionLog, "record", side_effect=record)


def _access_rows():
    """The access-flag log rows, oldest first."""
    return list(AdminActionLog.objects.filter(action__in=ACCESS_ACTIONS).order_by("id"))


class AccessFlagTestCase(TestCase):
    def _url(self, user):
        return f"/api/v1/admin/users/{user.pk}/"

    def _patch(self, actor, target, payload):
        client = APIClient()
        client.force_authenticate(actor)
        return client.patch(self._url(target), payload, format="json")

    def assert_grant_refused(self, response, target):
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST, response.content)
        self.assertEqual(
            response.json(),
            {"can_access_all_content": [GRANT_MESSAGE], "detail": GRANT_MESSAGE},
        )
        target.refresh_from_db()
        self.assertFalse(target.can_access_all_content)
        self.assertEqual(_access_rows(), [])

    def assert_row(self, row, action, *, target, actor, source):
        self.assertEqual(row.action, action)
        self.assertEqual(row.source, source)
        self.assertEqual(row.actor_id, actor.pk if actor else None)
        self.assertEqual(row.actor_username, actor.username if actor else "")
        self.assertEqual(
            row.metadata, {"target_id": target.pk, "target_username": target.username}
        )


class AllContentGrantRefusalTests(AccessFlagTestCase):
    def setUp(self):
        self.admin = _site_admin("admin_1830")
        self.other = User.objects.create_user(username="other_1830", password=PW)

    def test_site_admin_cannot_grant_themselves(self):
        self.assert_grant_refused(
            self._patch(self.admin, self.admin, {"can_access_all_content": True}), self.admin
        )

    def test_site_admin_cannot_grant_another_account(self):
        self.assert_grant_refused(
            self._patch(self.admin, self.other, {"can_access_all_content": True}), self.other
        )

    def test_refusal_applies_nothing_else_in_the_request(self):
        r = self._patch(
            self.admin, self.other, {"can_access_all_content": True, "must_change_password": True}
        )
        self.assert_grant_refused(r, self.other)
        self.assertFalse(self.other.must_change_password)

    def test_site_admin_pat_with_admin_scope_is_refused(self):
        _, raw = PersonalAccessToken.generate(
            self.admin, "t-1830", scopes=[SCOPE_ADMIN, SCOPE_WRITE]
        )
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        r = client.patch(self._url(self.other), {"can_access_all_content": True}, format="json")
        self.assert_grant_refused(r, self.other)

    def test_superuser_can_grant_another_account(self):
        root = _superuser("root_1830")
        r = self._patch(root, self.other, {"can_access_all_content": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertTrue(r.json()["can_access_all_content"])
        self.other.refresh_from_db()
        self.assertTrue(self.other.can_access_all_content)

    def test_actor_who_lost_superuser_status_is_refused(self):
        # request.user keeps the values read at sign-in: only the row is current.
        stale_actor = _superuser("stale_1830")
        User.objects.filter(pk=stale_actor.pk).update(is_superuser=False)
        self.assertTrue(stale_actor.is_superuser)
        self.assert_grant_refused(
            self._patch(stale_actor, self.other, {"can_access_all_content": True}), self.other
        )

    def test_deactivated_superuser_actor_is_refused(self):
        stale_actor = _superuser("gone_1830")
        User.objects.filter(pk=stale_actor.pk).update(is_active=False)
        self.assert_grant_refused(
            self._patch(stale_actor, self.other, {"can_access_all_content": True}), self.other
        )

    def test_grant_is_judged_on_the_locked_row(self):
        # The unlocked read saw the flag on, so this looked like a no-op; it was
        # revoked before the lock, which makes the request a grant after all.
        User.objects.filter(pk=self.other.pk).update(can_access_all_content=True)
        real_lock = admin_views.lock_user_row

        def lock_after_concurrent_revoke(pk):
            User.objects.filter(pk=pk).update(can_access_all_content=False)
            return real_lock(pk)

        with mock.patch.object(
            admin_views, "lock_user_row", side_effect=lock_after_concurrent_revoke
        ):
            r = self._patch(self.admin, self.other, {"can_access_all_content": True})
        self.assert_grant_refused(r, self.other)

    def test_site_admin_setting_a_flag_already_on_is_a_no_op(self):
        User.objects.filter(pk=self.other.pk).update(can_access_all_content=True)
        r = self._patch(self.admin, self.other, {"can_access_all_content": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.other.refresh_from_db()
        self.assertTrue(self.other.can_access_all_content)
        self.assertEqual(_access_rows(), [])

    def test_site_admin_can_revoke_and_their_own_flag_too(self):
        for target in (self.other, self.admin):
            with self.subTest(target=target.username):
                User.objects.filter(pk=target.pk).update(can_access_all_content=True)
                r = self._patch(self.admin, target, {"can_access_all_content": False})
                self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
                target.refresh_from_db()
                self.assertFalse(target.can_access_all_content)


class PatchActionLogTests(AccessFlagTestCase):
    def setUp(self):
        self.root = _superuser("root_log_1830")
        self.admin = _site_admin("admin_log_1830")
        self.other = User.objects.create_user(username="other_log_1830", password=PW)

    def test_all_content_grant_is_recorded_with_the_actor(self):
        self._patch(self.root, self.other, {"can_access_all_content": True})
        row, = _access_rows()
        self.assert_row(
            row, Action.USER_ALL_CONTENT_GRANTED,
            target=self.other, actor=self.root, source=AdminActionLog.Source.ADMIN_API,
        )

    def test_all_content_revoke_is_recorded_with_the_actor(self):
        User.objects.filter(pk=self.other.pk).update(can_access_all_content=True)
        self._patch(self.admin, self.other, {"can_access_all_content": False})
        row, = _access_rows()
        self.assert_row(
            row, Action.USER_ALL_CONTENT_REVOKED,
            target=self.other, actor=self.admin, source=AdminActionLog.Source.ADMIN_API,
        )

    def test_site_admin_grant_and_revoke_are_recorded_with_the_actor(self):
        self._patch(self.admin, self.other, {"is_site_admin": True})
        self._patch(self.admin, self.other, {"is_site_admin": False})
        granted, revoked = _access_rows()
        source = AdminActionLog.Source.ADMIN_API
        self.assert_row(
            granted, Action.USER_SITE_ADMIN_GRANTED,
            target=self.other, actor=self.admin, source=source,
        )
        self.assert_row(
            revoked, Action.USER_SITE_ADMIN_REVOKED,
            target=self.other, actor=self.admin, source=source,
        )

    def test_one_request_changing_both_flags_writes_two_rows(self):
        self._patch(
            self.root, self.other, {"is_site_admin": True, "can_access_all_content": True}
        )
        self.assertEqual(
            [row.action for row in _access_rows()],
            [Action.USER_SITE_ADMIN_GRANTED, Action.USER_ALL_CONTENT_GRANTED],
        )

    def test_resubmitted_values_write_nothing(self):
        for actor, payload in (
            (self.admin, {"can_access_all_content": False}),
            (self.admin, {"is_site_admin": False}),
            (self.root, {"can_access_all_content": False}),
        ):
            with self.subTest(payload=payload, actor=actor.username):
                r = self._patch(actor, self.other, payload)
                self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
                self.assertEqual(_access_rows(), [])

    def test_unrelated_patch_writes_nothing(self):
        self._patch(self.admin, self.other, {"must_change_password": True})
        self.assertEqual(_access_rows(), [])

    def test_concurrent_change_to_an_unsubmitted_flag_is_not_recorded_as_a_change(self):
        # Granted after this request's unlocked read: the stale False on the
        # in-memory target must not read as a revoke by this actor, and the
        # response reports the stored value.
        real_lock = admin_views.lock_user_row

        def lock_after_concurrent_grant(pk):
            User.objects.filter(pk=pk).update(can_access_all_content=True)
            return real_lock(pk)

        with mock.patch.object(
            admin_views, "lock_user_row", side_effect=lock_after_concurrent_grant
        ):
            r = self._patch(self.admin, self.other, {"is_site_admin": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertTrue(r.json()["can_access_all_content"])
        self.other.refresh_from_db()
        self.assertTrue(self.other.can_access_all_content)
        self.assertEqual(
            [row.action for row in _access_rows()], [Action.USER_SITE_ADMIN_GRANTED]
        )

    def test_failed_log_write_rolls_the_grant_back(self):
        client = APIClient(raise_request_exception=False)
        client.force_authenticate(self.root)
        with mock.patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            r = client.patch(
                self._url(self.other), {"can_access_all_content": True}, format="json"
            )
        self.assertEqual(r.status_code, status.HTTP_500_INTERNAL_SERVER_ERROR)
        self.other.refresh_from_db()
        self.assertFalse(self.other.can_access_all_content)

    def test_action_log_endpoint_accepts_the_new_actions_as_a_filter(self):
        self._patch(self.root, self.other, {"can_access_all_content": True})
        client = APIClient()
        client.force_authenticate(self.admin)
        r = client.get("/api/v1/admin/action-log/", {"action": "user.all_content_granted"})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(r.json()["count"], 1)
        self.assertEqual(r.json()["results"][0]["actor_username"], self.root.username)


@override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
)
class DjangoAdminAccessFlagTests(AccessFlagTestCase):
    def setUp(self):
        self.root = _superuser("root_dj_1830")
        self.target = User.objects.create_user(
            username="target_dj_1830", email="target_dj_1830@example.com", password=PW
        )
        self.client.force_login(self.root)

    def _post(self, **overrides):
        return self.client.post(
            reverse("admin:accounts_user_change", args=[self.target.pk]),
            _form_data(self.target, **overrides),
        )

    def test_promotion_records_each_derived_flag_once_with_the_actor(self):
        self.assertEqual(self._post(is_superuser="on").status_code, 302)
        self.target.refresh_from_db()
        self.assertTrue(self.target.can_access_all_content)
        site_admin, all_content = _access_rows()
        source = AdminActionLog.Source.DJANGO_ADMIN
        self.assert_row(
            site_admin, Action.USER_SITE_ADMIN_GRANTED,
            target=self.target, actor=self.root, source=source,
        )
        self.assert_row(
            all_content, Action.USER_ALL_CONTENT_GRANTED,
            target=self.target, actor=self.root, source=source,
        )

    def test_demotion_records_each_derived_flag_once_with_the_actor(self):
        self._post(is_superuser="on")
        AdminActionLog.objects.all().delete()
        self.target.refresh_from_db()
        self.assertEqual(self._post(is_superuser="").status_code, 302)
        self.target.refresh_from_db()
        self.assertFalse(self.target.can_access_all_content)
        self.assertEqual(
            [(row.action, row.actor_id) for row in _access_rows()],
            [
                (Action.USER_SITE_ADMIN_REVOKED, self.root.pk),
                (Action.USER_ALL_CONTENT_REVOKED, self.root.pk),
            ],
        )

    def test_edit_that_leaves_the_flags_alone_writes_nothing(self):
        self.assertEqual(self._post(first_name="Renamed").status_code, 302)
        self.assertEqual(_access_rows(), [])

    def test_failed_log_write_rolls_the_promotion_back(self):
        with _failing_access_log_write(), self.assertRaises(RuntimeError):
            self._post(is_superuser="on")
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_superuser)
        self.assertFalse(self.target.is_site_admin)
        self.assertFalse(self.target.can_access_all_content)

    def test_failed_log_write_rolls_the_demotion_back(self):
        self._post(is_superuser="on")
        self.target.refresh_from_db()
        with _failing_access_log_write(), self.assertRaises(RuntimeError):
            self._post(is_superuser="")
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_superuser)
        self.assertTrue(self.target.can_access_all_content)

    def test_promotion_by_an_actor_who_lost_superuser_status_is_refused(self):
        # The form was built for a superuser; the status is gone by the time the
        # target row is locked, the point the save re-checks it.
        def demote_actor(form, stored):
            User.objects.filter(pk=self.root.pk).update(is_superuser=False)

        with mock.patch.object(VisibanUserAdmin, "check_row_version", side_effect=demote_actor):
            self._post(is_superuser="on")
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_superuser)
        self.assertFalse(self.target.can_access_all_content)
        self.assertEqual(_access_rows(), [])


class DjangoAdminFormFieldTests(TestCase):
    def test_user_forms_carry_neither_flag(self):
        # get_readonly_fields covers only is_staff, is_superuser, groups and
        # user_permissions, so a flag added to a fieldset would be writable by
        # any staff account with change_user, and would skip the save_model check.
        model_admin = django_admin.site._registry[User]
        request = RequestFactory().get("/")
        request.user = _superuser("root_form_1830")
        target = User.objects.create_user(username="target_form_1830", password=PW)
        for obj in (None, target):
            with self.subTest(form="add" if obj is None else "change"):
                fields = flatten_fieldsets(model_admin.get_fieldsets(request, obj))
                self.assertNotIn("can_access_all_content", fields)
                self.assertNotIn("is_site_admin", fields)


class CurrentUserApiIgnoresFlagsTests(AccessFlagTestCase):
    URLS = ("/api/v1/auth/me/", "/api/v1/auth/user/")

    def _assert_unchanged(self, user, *, expected):
        client = APIClient()
        client.force_authenticate(user)
        for url in self.URLS:
            with self.subTest(url=url, expected=expected):
                r = client.patch(
                    url,
                    {"can_access_all_content": not expected, "is_site_admin": not expected},
                    format="json",
                )
                self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
                self.assertEqual(r.json()["can_access_all_content"], expected)
                self.assertEqual(r.json()["is_site_admin"], expected)
                user.refresh_from_db()
                self.assertEqual(user.can_access_all_content, expected)
                self.assertEqual(user.is_site_admin, expected)
        self.assertEqual(_access_rows(), [])

    def test_a_user_cannot_set_either_flag_on_their_own_account(self):
        self._assert_unchanged(
            User.objects.create_user(username="plain_me_1830", password=PW), expected=False
        )

    def test_a_holder_cannot_clear_either_flag_here(self):
        holder = User.objects.create_user(username="holder_me_1830", password=PW)
        User.objects.filter(pk=holder.pk).update(is_site_admin=True, can_access_all_content=True)
        self._assert_unchanged(User.objects.get(pk=holder.pk), expected=True)


class SignalWritesNoLogRowTests(AccessFlagTestCase):
    def test_flags_restored_by_a_plain_save_write_no_row(self):
        # No actor to record, and a route with one must not be double-counted.
        root = _superuser("root_signal_1830")
        User.objects.filter(pk=root.pk).update(can_access_all_content=False)
        root.refresh_from_db()
        root.save()
        root.refresh_from_db()
        self.assertTrue(root.can_access_all_content)
        self.assertEqual(_access_rows(), [])

    def test_plain_demotion_writes_no_row(self):
        root = _superuser("root_demote_1830")
        root.is_superuser = False
        root.save()
        root.refresh_from_db()
        self.assertFalse(root.can_access_all_content)
        self.assertEqual(_access_rows(), [])


class ManagementCommandAccessFlagTests(AccessFlagTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="cli_1830", password=PW)

    def _assert_cli_rows(self, *actions, target=None):
        rows = _access_rows()
        self.assertEqual([row.action for row in rows], list(actions))
        for row in rows:
            self.assert_row(
                row, row.action, target=target or self.user, actor=None,
                source=AdminActionLog.Source.CLI,
            )

    def test_set_site_admin_records_both_grants(self):
        call_command("set_site_admin", self.user.username, stdout=StringIO())
        self._assert_cli_rows(Action.USER_SITE_ADMIN_GRANTED, Action.USER_ALL_CONTENT_GRANTED)

    def test_set_site_admin_records_only_the_flag_that_changed(self):
        User.objects.filter(pk=self.user.pk).update(is_site_admin=True)
        call_command("set_site_admin", self.user.username, stdout=StringIO())
        self._assert_cli_rows(Action.USER_ALL_CONTENT_GRANTED)

    def test_set_site_admin_again_writes_nothing(self):
        User.objects.filter(pk=self.user.pk).update(
            is_site_admin=True, can_access_all_content=True
        )
        call_command("set_site_admin", self.user.username, stdout=StringIO())
        self.assertEqual(_access_rows(), [])

    def test_set_site_admin_revoke_records_both_revokes(self):
        User.objects.filter(pk=self.user.pk).update(
            is_site_admin=True, can_access_all_content=True
        )
        call_command("set_site_admin", self.user.username, "--revoke", stdout=StringIO())
        self._assert_cli_rows(Action.USER_SITE_ADMIN_REVOKED, Action.USER_ALL_CONTENT_REVOKED)

    def test_set_site_admin_revoke_on_a_plain_account_writes_nothing(self):
        call_command("set_site_admin", self.user.username, "--revoke", stdout=StringIO())
        self.assertEqual(_access_rows(), [])

    def test_failed_log_write_rolls_the_set_site_admin_grant_back(self):
        with _failing_access_log_write(), self.assertRaises(RuntimeError):
            call_command("set_site_admin", self.user.username, stdout=StringIO())
        self.user.refresh_from_db()
        self.assertFalse(self.user.is_site_admin)
        self.assertFalse(self.user.can_access_all_content)

    def test_failed_log_write_rolls_the_set_site_admin_revoke_back(self):
        User.objects.filter(pk=self.user.pk).update(
            is_site_admin=True, can_access_all_content=True
        )
        with _failing_access_log_write(), self.assertRaises(RuntimeError):
            call_command("set_site_admin", self.user.username, "--revoke", stdout=StringIO())
        self.user.refresh_from_db()
        self.assertTrue(self.user.is_site_admin)
        self.assertTrue(self.user.can_access_all_content)

    def test_failed_log_write_rolls_ensure_site_admin_back(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch(
            "accounts.management.commands.ensure_site_admin._PASSWORD_FILE",
            os.path.join(tmp, "pw_fail_1830"),
        ), mock.patch.dict(
            os.environ, {"DJANGO_SUPERUSER_USERNAME": "boot_fail_1830"}
        ), _failing_access_log_write(), self.assertRaises(RuntimeError):
            call_command("ensure_site_admin", stdout=StringIO())
        self.assertFalse(User.objects.filter(username="boot_fail_1830").exists())

    def test_failed_log_write_leaves_no_createsuperuser_account(self):
        with mock.patch.dict(
            os.environ, {"DJANGO_SUPERUSER_PASSWORD": PW}
        ), _failing_access_log_write(), self.assertRaises(RuntimeError):
            call_command(
                "createsuperuser", "--noinput", username="fail_1830",
                email="fail_1830@example.com", stdout=StringIO(),
            )
        self.assertFalse(User.objects.filter(username="fail_1830").exists())

    def test_ensure_site_admin_records_both_grants(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch(
            "accounts.management.commands.ensure_site_admin._PASSWORD_FILE",
            os.path.join(tmp, "pw_1830"),
        ), mock.patch.dict(os.environ, {"DJANGO_SUPERUSER_USERNAME": "boot_1830"}):
            call_command("ensure_site_admin", stdout=StringIO())
        boot = User.objects.get(username="boot_1830")
        self.assertTrue(boot.is_superuser)
        self._assert_cli_rows(
            Action.USER_SITE_ADMIN_GRANTED, Action.USER_ALL_CONTENT_GRANTED, target=boot
        )

    def test_createsuperuser_records_both_grants_with_or_without_a_password(self):
        for name, env in (
            ("with_pw_1830", {"DJANGO_SUPERUSER_PASSWORD": PW}),
            ("no_pw_1830", {}),
        ):
            with self.subTest(username=name):
                AdminActionLog.objects.all().delete()
                with mock.patch.dict(os.environ, env):
                    if not env:
                        os.environ.pop("DJANGO_SUPERUSER_PASSWORD", None)
                    call_command(
                        "createsuperuser", "--noinput", username=name,
                        email=f"{name}@example.com", stdout=StringIO(),
                    )
                self._assert_cli_rows(
                    Action.USER_SITE_ADMIN_GRANTED, Action.USER_ALL_CONTENT_GRANTED,
                    target=User.objects.get(username=name),
                )
