"""Removing superuser status also removes the flags derived from it (#1579)."""
from django.contrib.admin.sites import site as admin_site
from django.test import RequestFactory, TestCase
from django.urls import reverse

from accounts.models import InviteLink, User
from accounts.tests.test_admin_access_revocation import _form_data


def _superuser(name):
    return User.objects.create_superuser(
        username=name, email=f"{name}@example.com", password="pw123456!x"
    )


class SuperuserDemotionTests(TestCase):
    def test_demotion_clears_derived_flags(self):
        u = _superuser("demote_1579")
        u.refresh_from_db()
        self.assertTrue(u.is_site_admin and u.can_access_all_content)
        u.is_superuser = False
        u.save()
        self.assertFalse(u.is_site_admin)
        self.assertFalse(u.can_access_all_content)
        u.refresh_from_db()
        self.assertFalse(u.is_site_admin)
        self.assertFalse(u.can_access_all_content)

    def test_demotion_revokes_site_invite_links(self):
        u = _superuser("links_1579")
        InviteLink.generate(created_by=u)
        u.is_superuser = False
        u.save()
        self.assertFalse(
            InviteLink.objects.filter(created_by=u, revoked_at__isnull=True).exists()
        )

    def test_demotion_via_update_fields(self):
        u = _superuser("uf_1579")
        u.is_superuser = False
        u.save(update_fields=["is_superuser"])
        u.refresh_from_db()
        self.assertFalse(u.is_site_admin)
        self.assertFalse(u.can_access_all_content)

    def test_demotion_lapses_group_invite_links_held_via_all_content(self):
        from groups.models import Group, GroupInviteLink

        u = _superuser("grp_1579")
        owner = User.objects.create_user(username="grpowner_1579", password="pw123456!x")
        group = Group.objects.create(name="G1579", owner=owner)
        link, _ = GroupInviteLink.generate(group=group, created_by=u)
        u.is_superuser = False
        u.save()
        link.refresh_from_db()
        self.assertFalse(link.is_active)

    def test_demotion_with_simultaneous_deactivation(self):
        u = _superuser("both_1579")
        InviteLink.generate(created_by=u)
        u.is_superuser = False
        u.is_active = False
        u.save()
        u.refresh_from_db()
        self.assertFalse(u.is_active)
        self.assertFalse(u.is_site_admin)
        self.assertFalse(u.can_access_all_content)
        self.assertFalse(
            InviteLink.objects.filter(created_by=u, revoked_at__isnull=True).exists()
        )

    def test_demotion_of_already_inactive_superuser(self):
        u = _superuser("inactive_1579")
        User.objects.filter(pk=u.pk).update(is_active=False)
        u.refresh_from_db()
        u.is_superuser = False
        u.save()
        u.refresh_from_db()
        self.assertFalse(u.is_site_admin)
        self.assertFalse(u.can_access_all_content)

    def test_non_superuser_site_admin_untouched(self):
        u = User.objects.create_user(username="plain_1579", password="pw123456!x")
        u.is_site_admin = True
        u.save()
        u.first_name = "x"
        u.save()
        u.refresh_from_db()
        self.assertTrue(u.is_site_admin)

    def test_staying_superuser_keeps_flags(self):
        u = _superuser("stay_1579")
        u.first_name = "x"
        u.save()
        u.refresh_from_db()
        self.assertTrue(u.is_site_admin and u.can_access_all_content)

    def test_stale_instance_does_not_demote(self):
        u = _superuser("stale_1579")
        stale = User.objects.get(pk=u.pk)
        stale.is_superuser = False
        User.objects.filter(pk=u.pk).update(is_superuser=False)
        stale.save()  # stored value already False: no transition
        u.refresh_from_db()
        self.assertTrue(u.is_site_admin)


class DjangoAdminSuperuserFieldTests(TestCase):
    def setUp(self):
        self.root = _superuser("root_1579")
        self.target = _superuser("target_1579")

    def test_admin_form_demotion_clears_flags(self):
        self.client.force_login(self.root)
        r = self.client.post(
            reverse("admin:accounts_user_change", args=[self.target.pk]),
            _form_data(self.target, is_superuser=""),
        )
        self.assertEqual(r.status_code, 302)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_superuser)
        self.assertFalse(self.target.is_site_admin)
        self.assertFalse(self.target.can_access_all_content)

    def test_non_superuser_cannot_edit_is_superuser(self):
        request = RequestFactory().get("/")
        model_admin = admin_site._registry[User]
        request.user = User.objects.create_user(username="staff_1579", password="pw123456!x")
        self.assertIn("is_superuser", model_admin.get_readonly_fields(request, self.target))
        request.user = self.root
        self.assertNotIn("is_superuser", model_admin.get_readonly_fields(request, self.target))
