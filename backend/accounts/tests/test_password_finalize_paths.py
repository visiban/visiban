"""Every password write runs the shared finalize step, atomically (#1560)."""

from unittest import mock

from allauth.account.adapter import get_adapter
from django.contrib.auth.hashers import check_password
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from rest_framework.test import APIClient

from accounts import credentials
from accounts.models import PersonalAccessToken, User

OLD = "old-password-1234"
NEW = "brand-new-password-5678"
PLAIN_STATIC = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}


def _user(name, **kw):
    user = User.objects.create_user(username=name, email=f"{name}@example.com", password=OLD, **kw)
    user.must_change_password = True
    user.save(update_fields=["must_change_password"])
    PersonalAccessToken.generate(user, "a")
    PersonalAccessToken.generate(user, "b")
    return user


class AdapterSetPasswordTests(TestCase):
    def test_sets_password_clears_flag_and_deletes_pats(self):
        user = _user("adapt")
        get_adapter().set_password(user, NEW)
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW))
        self.assertFalse(user.must_change_password)
        self.assertEqual(user.personal_access_tokens.count(), 0)

    def test_failure_in_finalize_rolls_back_the_password(self):
        user = _user("adapt_rb")
        before = User.objects.get(pk=user.pk).password
        with mock.patch.object(
            type(user.personal_access_tokens.all()), "delete", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                get_adapter().set_password(user, NEW)
        stored = User.objects.get(pk=user.pk)
        self.assertEqual(stored.password, before)
        self.assertTrue(stored.must_change_password)
        self.assertEqual(stored.personal_access_tokens.count(), 2)


class RestResetConfirmAtomicTests(TestCase):
    def test_failure_in_finalize_rolls_back_the_password(self):
        from allauth.account.forms import default_token_generator
        from allauth.account.utils import user_pk_to_url_str

        cache.clear()
        user = _user("restreset")
        before = User.objects.get(pk=user.pk).password
        client = APIClient()
        with mock.patch(
            "accounts.serializers.finalize_password_reset", side_effect=RuntimeError("boom")
        ):
            client.raise_request_exception = False
            r = client.post(
                "/api/v1/auth/password/reset/confirm/",
                {
                    "uid": user_pk_to_url_str(user),
                    "token": default_token_generator.make_token(user),
                    "new_password1": NEW,
                    "new_password2": NEW,
                },
                format="json",
            )
        self.assertGreaterEqual(r.status_code, 500)
        stored = User.objects.get(pk=user.pk)
        self.assertEqual(stored.password, before)
        self.assertEqual(stored.personal_access_tokens.count(), 2)

    def test_success_finalizes(self):
        from allauth.account.forms import default_token_generator
        from allauth.account.utils import user_pk_to_url_str

        cache.clear()
        user = _user("restreset_ok")
        r = APIClient().post(
            "/api/v1/auth/password/reset/confirm/",
            {
                "uid": user_pk_to_url_str(user),
                "token": default_token_generator.make_token(user),
                "new_password1": NEW,
                "new_password2": NEW,
            },
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW))
        self.assertFalse(user.must_change_password)
        self.assertEqual(user.personal_access_tokens.count(), 0)


@override_settings(
    PASSWORD_HASHERS=[
        "django.contrib.auth.hashers.PBKDF2PasswordHasher",
        "django.contrib.auth.hashers.MD5PasswordHasher",
    ]
)
class HasherUpgradeTests(TestCase):
    def test_login_with_outdated_hasher_keeps_tokens_and_flag(self):
        user = _user("legacy")
        # Re-hash with a hasher that is not the preferred one so a successful
        # check_password triggers Django's setter (set_password + save).
        from django.contrib.auth.hashers import make_password

        legacy = make_password(OLD, hasher="md5")
        User.objects.filter(pk=user.pk).update(password=legacy)
        user.refresh_from_db()
        with mock.patch.object(credentials, "finalize_password_change") as spy:
            self.assertTrue(user.check_password(OLD))
        spy.assert_not_called()
        user.refresh_from_db()
        self.assertNotEqual(user.password, legacy)
        self.assertTrue(check_password(OLD, user.password))
        self.assertTrue(user.must_change_password)
        self.assertEqual(user.personal_access_tokens.count(), 2)


@override_settings(STORAGES=PLAIN_STATIC)
class AdminPasswordFormTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin_user = _user("adm", is_staff=True, is_superuser=True)
        self.admin_user.must_change_password = False
        self.admin_user.save(update_fields=["must_change_password"])
        self.client = Client()
        self.client.force_login(self.admin_user)

    def _url(self, user):
        return f"/admin/accounts/user/{user.pk}/password/"

    def _post(self, user, **data):
        return self.client.post(self._url(user), data)

    def test_other_user_gets_flag_set_and_pats_deleted_admin_untouched(self):
        target = _user("tgt")
        target.must_change_password = False
        target.save(update_fields=["must_change_password"])
        r = self._post(target, password1=NEW, password2=NEW, usable_password="true")
        self.assertEqual(r.status_code, 302)
        target.refresh_from_db()
        self.assertTrue(target.check_password(NEW))
        self.assertTrue(target.must_change_password)
        self.assertEqual(target.personal_access_tokens.count(), 0)
        self.assertEqual(self.admin_user.personal_access_tokens.count(), 2)
        # The admin's own session is still valid.
        self.assertEqual(self.client.get("/admin/").status_code, 200)

    def test_self_target_clears_flag_and_deletes_pats(self):
        self.admin_user.must_change_password = False
        self.admin_user.save(update_fields=["must_change_password"])
        r = self._post(self.admin_user, password1=NEW, password2=NEW, usable_password="true")
        self.assertEqual(r.status_code, 302)
        self.admin_user.refresh_from_db()
        self.assertTrue(self.admin_user.check_password(NEW))
        self.assertFalse(self.admin_user.must_change_password)
        self.assertEqual(self.admin_user.personal_access_tokens.count(), 0)

    def test_unusable_password_deletes_pats_without_setting_flag(self):
        target = _user("tgt2")
        target.must_change_password = False
        target.save(update_fields=["must_change_password"])
        r = self._post(target, usable_password="false", **{"unset-password": "1"})
        self.assertEqual(r.status_code, 302)
        target.refresh_from_db()
        self.assertFalse(target.has_usable_password())
        self.assertFalse(target.must_change_password)
        self.assertEqual(target.personal_access_tokens.count(), 0)

    def test_failure_in_follow_up_rolls_back_the_admin_password_write(self):
        target = _user("tgt3")
        before = User.objects.get(pk=target.pk).password
        self.client.raise_request_exception = False
        with mock.patch(
            "accounts.admin.require_password_change_after_admin_set",
            side_effect=RuntimeError("boom"),
        ):
            r = self._post(target, password1=NEW, password2=NEW, usable_password="true")
        self.assertGreaterEqual(r.status_code, 500)
        stored = User.objects.get(pk=target.pk)
        self.assertEqual(stored.password, before)
        self.assertEqual(stored.personal_access_tokens.count(), 2)

    def _snapshot(self, target):
        stored = User.objects.get(pk=target.pk)
        return (stored.password, stored.must_change_password, stored.personal_access_tokens.count())

    def _assert_target_unchanged(self, target, before):
        # Re-read the stored row; never compare against the in-memory object.
        self.assertEqual(self._snapshot(target), before)

    def test_non_staff_user_is_refused(self):
        target = _user("tgt4")
        before = self._snapshot(target)
        plain = _user("plain")
        client = Client()
        client.force_login(plain)
        r = client.post(
            self._url(target), {"password1": NEW, "password2": NEW, "usable_password": "true"}
        )
        self.assertEqual(r.status_code, 403)
        self._assert_target_unchanged(target, before)

    def test_anonymous_request_is_redirected_to_admin_login(self):
        target = _user("tgt6")
        before = self._snapshot(target)
        r = Client().post(
            self._url(target), {"password1": NEW, "password2": NEW, "usable_password": "true"}
        )
        self.assertEqual(r.status_code, 302)
        self.assertIn("/admin/login/", r["Location"])
        self._assert_target_unchanged(target, before)

    def test_view_only_staff_is_refused(self):
        from django.contrib.auth.models import Permission

        target = _user("tgt5")
        before = self._snapshot(target)
        viewer = _user("viewer", is_staff=True)
        viewer.must_change_password = False
        viewer.save(update_fields=["must_change_password"])
        viewer.user_permissions.add(Permission.objects.get(codename="view_user"))
        client = Client()
        client.force_login(viewer)
        r = client.post(
            self._url(target), {"password1": NEW, "password2": NEW, "usable_password": "true"}
        )
        self.assertEqual(r.status_code, 403)
        self._assert_target_unchanged(target, before)
