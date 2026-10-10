"""Django admin applies the same revocation housekeeping as the admin API (#1563)."""
from django.contrib.admin.sites import site as admin_site
from types import SimpleNamespace
from unittest import mock

from django.test import RequestFactory, TestCase, TransactionTestCase
from django.urls import reverse

from accounts.models import InviteLink, PersonalAccessToken, User


def _form_data(user, **overrides):
    data = {
        "username": user.username,
        "email": user.email,
        "first_name": "",
        "last_name": "",
        "is_active": "on" if user.is_active else "",
        "is_staff": "on" if user.is_staff else "",
        "is_superuser": "on" if user.is_superuser else "",
        "date_joined_0": "2026-01-01",
        "date_joined_1": "00:00:00",
    }
    data.update(overrides)
    return {k: v for k, v in data.items() if v != ""}


class DjangoAdminRevocationTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser(
            username="root_1563", email="root1563@example.com", password="rootpass123!"
        )
        self.root.is_site_admin = True
        self.root.save(update_fields=["is_site_admin"])
        self.client.force_login(self.root)
        self.target = User.objects.create_user(username="target_1563", password="pw123456!x")
        self.other = User.objects.create_user(username="other_1563", password="pw123456!x")
        for u in (self.target, self.other):
            PersonalAccessToken.generate(u, "tok")
            InviteLink.generate(created_by=u)

    def _post(self, user, **overrides):
        url = reverse("admin:accounts_user_change", args=[user.pk])
        return self.client.post(url, _form_data(user, **overrides))

    def test_deactivation_revokes_tokens_and_invite_links(self):
        r = self._post(self.target, is_active="")
        self.assertEqual(r.status_code, 302)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_active)
        self.assertEqual(self.target.personal_access_tokens.count(), 0)
        self.assertFalse(
            InviteLink.objects.filter(created_by=self.target, revoked_at__isnull=True).exists()
        )

    def test_unrelated_user_untouched(self):
        self._post(self.target, is_active="")
        self.assertEqual(self.other.personal_access_tokens.count(), 1)
        self.assertTrue(
            InviteLink.objects.filter(created_by=self.other, revoked_at__isnull=True).exists()
        )

    def test_saving_without_deactivation_keeps_tokens_and_links(self):
        r = self._post(self.target, first_name="Ada")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(self.target.personal_access_tokens.count(), 1)
        self.assertTrue(
            InviteLink.objects.filter(created_by=self.target, revoked_at__isnull=True).exists()
        )

    def test_site_admin_loss_revokes_site_invite_links_but_keeps_tokens(self):
        self.target.is_site_admin = True
        self.target.save(update_fields=["is_site_admin"])
        model_admin = admin_site._registry[User]
        request = RequestFactory().post("/")
        request.user = self.root
        self.target.is_site_admin = False
        model_admin.save_model(request, self.target, form=None, change=True)
        self.assertFalse(
            InviteLink.objects.filter(created_by=self.target, revoked_at__isnull=True).exists()
        )
        self.assertEqual(self.target.personal_access_tokens.count(), 1)


class DjangoAdminSaveModelTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser(
            username="root2_1563", email="root21563@example.com", password="rootpass123!"
        )
        self.target = User.objects.create_user(username="t2_1563", password="pw123456!x")
        self.model_admin = admin_site._registry[User]
        self.request = RequestFactory().post("/")
        self.request.user = self.root

    def test_content_access_loss_lapses_real_group_link(self):
        from groups.models import Group, GroupInviteLink

        owner = User.objects.create_user(username="owner_1563", password="pw123456!x")
        bystander = User.objects.create_user(username="by_1563", password="pw123456!x")
        User.objects.filter(pk__in=[self.target.pk, bystander.pk]).update(
            can_access_all_content=True
        )
        group = Group.objects.create(name="G", owner=owner)
        mine, _ = GroupInviteLink.generate(group, self.target)
        theirs, _ = GroupInviteLink.generate(group, bystander)

        stale = User.objects.get(pk=self.target.pk)
        # The stock change form does not carry this flag, so a stub form that
        # does lets the stale-field copy run while the flag is still saved.
        form = SimpleNamespace(fields={"can_access_all_content": None})
        stale.can_access_all_content = False
        with mock.patch("groups.broadcast.broadcast_group_event"), self.captureOnCommitCallbacks(
            execute=True
        ):
            self.model_admin.save_model(self.request, stale, form=form, change=True)

        mine.refresh_from_db()
        theirs.refresh_from_db()
        self.assertFalse(mine.is_active)
        self.assertTrue(theirs.is_active)

    def test_add_path_skips_the_helper(self):
        new = User(username="new_1563")
        new.set_password("pw123456!x")
        with mock.patch("accounts.admin_views.apply_access_loss_revocations") as helper:
            self.model_admin.save_model(self.request, new, form=None, change=False)
        helper.assert_not_called()
        self.assertTrue(User.objects.filter(username="new_1563").exists())

    def test_stale_form_instance_does_not_undo_concurrent_changes(self):
        User.objects.filter(pk=self.target.pk).update(is_site_admin=True)
        stale = User.objects.get(pk=self.target.pk)  # the instance loaded before the lock
        # A concurrent API demotion and pending password change land afterwards.
        User.objects.filter(pk=self.target.pk).update(
            is_site_admin=False, must_change_password=True
        )
        form = self.model_admin.get_form(self.request, stale, change=True)(instance=stale)
        stale.first_name = "Ada"
        self.model_admin.save_model(self.request, stale, form=form, change=True)
        stored = User.objects.get(pk=self.target.pk)
        self.assertFalse(stored.is_site_admin)
        self.assertTrue(stored.must_change_password)
        self.assertEqual(stored.first_name, "Ada")


class DjangoAdminAtomicityTests(TransactionTestCase):
    def test_failed_revocation_rolls_back_the_save(self):
        root = User.objects.create_superuser(
            username="root3_1563", email="root31563@example.com", password="rootpass123!"
        )
        target = User.objects.create_user(username="t3_1563", password="pw123456!x")
        target.is_active = False
        request = RequestFactory().post("/")
        request.user = root
        with mock.patch(
            "accounts.admin_views.apply_access_loss_revocations", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                admin_site._registry[User].save_model(request, target, form=None, change=True)
        self.assertTrue(User.objects.get(pk=target.pk).is_active)
