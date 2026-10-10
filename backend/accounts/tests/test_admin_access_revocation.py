"""Django admin applies the same revocation housekeeping as the admin API (#1563)."""
from django.contrib.admin.sites import site as admin_site
from django.test import RequestFactory, TestCase
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
