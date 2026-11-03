"""Django admin user routes and admin API: who may change or delete which accounts.

A non-superuser actor leaves every other staff, superuser, site-admin or
all-content account to superusers (password, email, username, activation, delete), and a
user who owns groups is deleted only after ownership is transferred. The admin
API keeps a superuser's activation, all-content access and password-change
flag with superusers.
"""
from unittest import mock

from django.contrib.admin.models import DELETION, LogEntry
from django.contrib.auth.models import Group as AuthGroup
from django.contrib.auth.models import Permission
from django.test import TestCase, override_settings
from django.urls import reverse
from rest_framework.test import APIClient

import accounts.admin as admin_module
from accounts.models import User
from accounts.tests.test_admin_access_revocation import _form_data
from groups.models import Group

PW = "pw123456!x"

_PLAIN_STATIC = override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
)


def _user(name, *, staff=False, superuser=False, site_admin=False, all_content=False, perms=()):
    user = User.objects.create_user(username=name, email=f"{name}@example.com", password=PW)
    user.is_staff = staff
    user.is_superuser = superuser
    user.is_site_admin = site_admin
    user.can_access_all_content = all_content
    user.save()
    if perms:
        user.user_permissions.add(
            *Permission.objects.filter(
                content_type__app_label="accounts", content_type__model="user",
                codename__in=list(perms),
            )
        )
    return User.objects.get(pk=user.pk)


_PERMS = ("view_user", "change_user", "delete_user")


def _msgs(response):
    return [str(m) for m in response.context["messages"]] if response.context else []


@_PLAIN_STATIC
class StaffTargetFormTests(TestCase):
    def setUp(self):
        self.actor = _user("actor_s", staff=True, perms=_PERMS)
        self.peer = _user("peer_s", staff=True, perms=_PERMS)
        # Broader Django permissions than the actor.
        self.peer.user_permissions.add(Permission.objects.get(codename="add_user"))
        self.peer.groups.add(AuthGroup.objects.create(name="broad_s"))
        self.plain = _user("plain_s")
        self.client.force_login(self.actor)

    def change(self, user, **overrides):
        return self.client.post(
            reverse("admin:accounts_user_change", args=[user.pk]), _form_data(user, **overrides)
        )

    def test_staff_target_identity_and_activation_are_not_writable(self):
        r = self.change(self.peer, email="new@example.com", username="renamed_s", is_active="", last_name="Zed",
                        first_name="Ada")
        self.assertEqual(r.status_code, 302)
        self.peer.refresh_from_db()
        self.assertEqual(self.peer.username, "peer_s")
        self.assertEqual(self.peer.email, "peer_s@example.com")
        self.assertTrue(self.peer.is_active)
        self.assertEqual(self.peer.first_name, "")
        self.assertEqual(self.peer.last_name, "")

    def test_site_admin_target_activation_is_not_writable(self):
        other = _user("sa_other_s", site_admin=True)
        self.assertTrue(other.is_site_admin)
        target = _user("sa_target_s", site_admin=True)
        self.change(target, is_active="")
        target.refresh_from_db()
        self.assertTrue(target.is_active)

    def test_all_content_target_identity_and_activation_are_not_writable(self):
        holder = _user("holder_s", all_content=True)
        r = self.change(holder, email="new@example.com", username="renamed_h", is_active="",
                        first_name="Ada")
        self.assertEqual(r.status_code, 302)
        holder.refresh_from_db()
        self.assertEqual(holder.username, "holder_s")
        self.assertEqual(holder.email, "holder_s@example.com")
        self.assertEqual(holder.first_name, "")
        self.assertTrue(holder.is_active)

    def test_all_content_target_password_form_refused(self):
        holder = _user("holder_pw_s", all_content=True)
        url = reverse("admin:auth_user_password_change", args=[holder.pk])
        before = User.objects.get(pk=holder.pk).password
        self.assertEqual(self.client.get(url).status_code, 403)
        r = self.client.post(url, {"password1": "Str0ng-new-pass-1830", "password2": "Str0ng-new-pass-1830"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(User.objects.get(pk=holder.pk).password, before)

    def test_all_content_target_is_writable_by_a_superuser(self):
        holder = _user("holder_root_s", all_content=True)
        self.client.force_login(_user("root_s", staff=True, superuser=True))
        self.assertEqual(self.change(holder, first_name="Ada").status_code, 302)
        holder.refresh_from_db()
        self.assertEqual(holder.first_name, "Ada")

    def test_all_content_actor_keeps_their_own_account(self):
        own = _user("own_s", staff=True, all_content=True, perms=_PERMS)
        self.client.force_login(own)
        self.assertEqual(self.change(own, first_name="Ada").status_code, 302)
        own.refresh_from_db()
        self.assertEqual(own.first_name, "Ada")

    def test_staff_target_password_form_refused(self):
        url = reverse("admin:auth_user_password_change", args=[self.peer.pk])
        before = User.objects.get(pk=self.peer.pk).password
        self.assertEqual(self.client.get(url).status_code, 403)
        r = self.client.post(url, {"password1": "Str0ng-new-pass-1620", "password2": "Str0ng-new-pass-1620"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(User.objects.get(pk=self.peer.pk).password, before)

    def test_non_staff_target_is_unchanged_behavior(self):
        r = self.change(self.plain, email="new@example.com", username="renamed_plain_s", is_active="")
        self.assertEqual(r.status_code, 302)
        self.plain.refresh_from_db()
        self.assertEqual(self.plain.username, "renamed_plain_s")
        self.assertFalse(self.plain.is_active)

    def test_own_row_identity_stays_editable(self):
        r = self.change(self.actor, email="mine@example.com")
        self.assertEqual(r.status_code, 302)
        self.actor.refresh_from_db()
        self.assertEqual(self.actor.email, "mine@example.com")

    def test_target_promoted_to_staff_before_the_lock_keeps_identity(self):
        from accounts.admin import VisibanUserAdmin

        real_save = VisibanUserAdmin.save_model

        def promote_then_save(admin_self, request, obj, form, change):
            User.objects.filter(pk=obj.pk).update(is_staff=True)
            return real_save(admin_self, request, obj, form, change)

        with mock.patch.object(VisibanUserAdmin, "save_model", promote_then_save):
            r = self.change(self.plain, email="late@example.com")
        self.assertEqual(r.status_code, 403)
        self.plain.refresh_from_db()
        self.assertEqual(self.plain.email, "plain_s@example.com")

    def test_target_promoted_to_staff_before_the_lock_keeps_password(self):
        real_hash = admin_module._stored_password_hash

        def promote_then_lock(pk, *, lock=False):
            if lock:
                User.objects.filter(pk=pk).update(is_staff=True)
            return real_hash(pk, lock=lock)

        url = reverse("admin:auth_user_password_change", args=[self.plain.pk])
        before = User.objects.get(pk=self.plain.pk).password
        with mock.patch.object(admin_module, "_stored_password_hash", promote_then_lock):
            r = self.client.post(
                url, {"password1": "Str0ng-new-pass-1620", "password2": "Str0ng-new-pass-1620"}
            )
        self.assertEqual(r.status_code, 403)
        self.assertEqual(User.objects.get(pk=self.plain.pk).password, before)

    def test_superuser_actor_changes_staff_target(self):
        root = _user("root_s", staff=True, superuser=True)
        self.client.force_login(root)
        r = self.change(self.peer, email="new@example.com", is_active="")
        self.assertEqual(r.status_code, 302)
        self.peer.refresh_from_db()
        self.assertEqual(self.peer.email, "new@example.com")
        self.assertFalse(self.peer.is_active)


@_PLAIN_STATIC
class StaffTargetDeleteTests(TestCase):
    def setUp(self):
        self.actor = _user("actor_d", staff=True, perms=_PERMS)
        self.peer = _user("peer_d", staff=True, perms=_PERMS)
        self.site_admin = _user("sa_d", site_admin=True)
        self.spare_admin = _user("sa2_d", site_admin=True)
        self.plain = _user("plain_d")
        self.client.force_login(self.actor)
        self.changelist = reverse("admin:accounts_user_changelist")

    def delete_url(self, user):
        return reverse("admin:accounts_user_delete", args=[user.pk])

    def bulk(self, users, **extra):
        return self.client.post(
            self.changelist,
            {"action": "delete_selected", "_selected_action": [u.pk for u in users], **extra},
            follow=True,
        )

    def test_delete_view_refused_for_staff_and_site_admin_targets(self):
        for target in (self.peer, self.site_admin):
            for method in ("get", "post"):
                r = getattr(self.client, method)(
                    self.delete_url(target), {"post": "yes"} if method == "post" else {},
                    follow=True,
                )
                self.assertTrue(
                    any("Only a superuser can delete" in m for m in _msgs(r)), _msgs(r)
                )
            self.assertTrue(User.objects.filter(pk=target.pk).exists())

    def test_delete_refused_for_all_content_target(self):
        holder = _user("holder_d", all_content=True)
        r = self.client.post(self.delete_url(holder), {"post": "yes"}, follow=True)
        self.assertTrue(any("Only a superuser can delete" in m for m in _msgs(r)), _msgs(r))
        r = self.bulk([holder], post="yes")
        self.assertTrue(any("Only a superuser can delete" in m for m in _msgs(r)), _msgs(r))
        self.assertTrue(User.objects.filter(pk=holder.pk).exists())

    def test_all_content_target_refused_by_locked_actor_row_check(self):
        # Only the scope check on the locked rows decides here.
        holder = _user("holder_lock_d", all_content=True)
        with mock.patch("accounts.admin.user_deletion_refusals", return_value=[]):
            self.client.post(self.delete_url(holder), {"post": "yes"}, follow=True)
        self.assertTrue(User.objects.filter(pk=holder.pk).exists())

    def test_delete_selected_refused_whole_action(self):
        for extra in ({}, {"post": "yes"}):
            r = self.bulk([self.plain, self.peer], **extra)
            self.assertTrue(any("Only a superuser can delete" in m for m in _msgs(r)))
        self.assertEqual(User.objects.filter(pk__in=[self.plain.pk, self.peer.pk]).count(), 2)
        self.assertFalse(LogEntry.objects.filter(action_flag=DELETION).exists())

    def test_non_staff_target_still_deletable(self):
        self.client.post(self.delete_url(self.plain), {"post": "yes"})
        self.assertFalse(User.objects.filter(pk=self.plain.pk).exists())

    def test_staff_target_refused_by_locked_actor_row_check(self):
        # Every call to the shared refusal helper is bypassed, so only the
        # scope check on the locked rows in ``_lock_and_check_admins`` decides.
        with mock.patch("accounts.admin.user_deletion_refusals", return_value=[]):
            r = self.client.post(self.delete_url(self.peer), {"post": "yes"}, follow=True)
        self.assertTrue(User.objects.filter(pk=self.peer.pk).exists())
        self.assertTrue(any("Only a superuser can delete" in m for m in _msgs(r)), _msgs(r))
        self.assertFalse(LogEntry.objects.filter(action_flag=DELETION).exists())

    def test_superuser_actor_deletes_staff_and_site_admin(self):
        root = _user("root_d", staff=True, superuser=True)
        self.client.force_login(root)
        self.client.post(self.delete_url(self.peer), {"post": "yes"})
        self.client.post(self.delete_url(self.site_admin), {"post": "yes"})
        self.assertFalse(User.objects.filter(pk__in=[self.peer.pk, self.site_admin.pk]).exists())


@_PLAIN_STATIC
class GroupOwnerDeleteTests(TestCase):
    def setUp(self):
        self.root = _user("root_g", staff=True, superuser=True)
        self.client.force_login(self.root)
        self.owner = _user("owner_g")
        self.group = Group.objects.create(name="Owned group", owner=self.owner)
        self.sub = Group.objects.create(name="Sub", owner=self.root, parent=self.group)
        self.changelist = reverse("admin:accounts_user_changelist")

    def delete_url(self, user):
        return reverse("admin:accounts_user_delete", args=[user.pk])

    def assert_kept(self, response):
        self.assertTrue(
            any("owns groups that must be transferred" in m for m in _msgs(response)),
            _msgs(response),
        )
        self.assertTrue(User.objects.filter(pk=self.owner.pk).exists())
        self.assertTrue(Group.objects.filter(pk=self.group.pk).exists())
        self.assertTrue(Group.objects.filter(pk=self.sub.pk).exists())

    def test_delete_view_refused_on_get_and_post(self):
        for method in ("get", "post"):
            r = getattr(self.client, method)(
                self.delete_url(self.owner), {"post": "yes"} if method == "post" else {},
                follow=True,
            )
            self.assert_kept(r)

    def test_delete_selected_refused_and_nothing_deleted(self):
        other = _user("other_g")
        for extra in ({}, {"post": "yes"}):
            r = self.client.post(
                self.changelist,
                {"action": "delete_selected", "_selected_action": [self.owner.pk, other.pk], **extra},
                follow=True,
            )
            self.assert_kept(r)
        self.assertTrue(User.objects.filter(pk=other.pk).exists())

    def test_allowed_once_ownership_is_transferred(self):
        Group.objects.filter(owner=self.owner).update(owner=self.root)
        self.client.post(self.delete_url(self.owner), {"post": "yes"})
        self.assertFalse(User.objects.filter(pk=self.owner.pk).exists())
        self.assertTrue(Group.objects.filter(pk=self.group.pk).exists())

    def test_group_created_after_page_check_refused_by_final_lock_check(self):
        late = _user("late_g")
        real = admin_module.user_deletion_refusals
        calls = {"n": 0}
        # Created inside the delete transaction, so a refusal rolls it back too.

        def side_effect(targets, actor):
            calls["n"] += 1
            if calls["n"] == 1:  # page-level check
                return []
            if calls["n"] == 2:  # first lock statement: the group appears after it
                Group.objects.create(name="Late", owner=late)
                return []
            return real(targets, actor)  # final check, after the target rows lock

        with mock.patch("accounts.admin.user_deletion_refusals", side_effect=side_effect):
            r = self.client.post(self.delete_url(late), {"post": "yes"}, follow=True)
        self.assertEqual(calls["n"], 3)
        self.assertTrue(User.objects.filter(pk=late.pk).exists())
        self.assertTrue(any("owns groups" in m for m in _msgs(r)))


class AdminApiSuperuserTargetTests(TestCase):
    def setUp(self):
        self.site_admin = _user("api_sa", site_admin=True)
        self.root = _user("api_root", staff=True, superuser=True)
        self.api = APIClient()
        self.api.force_authenticate(self.site_admin)

    def url(self, user, suffix=""):
        return f"/api/v1/admin/users/{user.pk}/{suffix}"

    def assert_refused(self, r):
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Only a superuser", r.json()["detail"])

    def test_patch_deactivate_superuser_refused(self):
        self.assert_refused(self.api.patch(self.url(self.root), {"is_active": False}, format="json"))
        self.root.refresh_from_db()
        self.assertTrue(self.root.is_active)

    def test_patch_flags_on_superuser_refused(self):
        for payload in ({"can_access_all_content": True}, {"must_change_password": True}):
            self.assert_refused(self.api.patch(self.url(self.root), payload, format="json"))
        self.root.refresh_from_db()
        self.assertFalse(self.root.must_change_password)

    def test_patch_reactivate_superuser_refused(self):
        User.objects.filter(pk=self.root.pk).update(is_active=False)
        self.assert_refused(self.api.patch(self.url(self.root), {"is_active": True}, format="json"))
        self.root.refresh_from_db()
        self.assertFalse(self.root.is_active)

    def test_deactivate_endpoint_refused_for_superuser(self):
        self.assert_refused(self.api.post(self.url(self.root, "deactivate/"), {}, format="json"))
        self.root.refresh_from_db()
        self.assertTrue(self.root.is_active)

    def test_superuser_promoted_since_read_refused_under_lock(self):
        target = _user("api_late")
        import accounts.admin_views as admin_views

        real_lock = admin_views.lock_user_row

        def lock_after_grant(pk):
            User.objects.filter(pk=pk).update(is_superuser=True)
            return real_lock(pk)

        with mock.patch.object(admin_views, "lock_user_row", side_effect=lock_after_grant):
            r = self.api.patch(self.url(target), {"is_active": False}, format="json")
        self.assert_refused(r)
        target.refresh_from_db()
        self.assertTrue(target.is_active)

    def test_superuser_actor_may_change_superuser(self):
        other_root = _user("api_root2", staff=True, superuser=True)
        api = APIClient()
        api.force_authenticate(self.root)
        r = api.patch(self.url(other_root), {"must_change_password": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        r = api.patch(self.url(other_root), {"is_active": False}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_site_admin_changes_ordinary_account(self):
        target = _user("api_plain")
        r = self.api.patch(self.url(target), {"must_change_password": True, "is_active": False},
                           format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_clear_lockout_of_superuser_refused_for_site_admin(self):
        r = self.api.post(self.url(self.root, "clear-lockout/"), {}, format="json")
        self.assert_refused(r)
        self.assertEqual(
            r.json()["detail"],
            "Only a superuser can clear the sign-in lockout on a superuser account.",
        )
        other = _user("api_locked")
        r = self.api.post(self.url(other, "clear-lockout/"), {}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        api = APIClient()
        api.force_authenticate(self.root)
        r = api.post(self.url(self.root, "clear-lockout/"), {}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_deactivating_group_owner_is_not_refused(self):
        owner = _user("api_owner")
        Group.objects.create(name="Kept", owner=owner)
        r = self.api.post(self.url(owner, "deactivate/"), {}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(Group.objects.filter(name="Kept").exists())
