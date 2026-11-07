"""Django admin user form: guards and privilege fields for non-superuser staff (#1577)."""
import os
from unittest import mock

from django.contrib.auth.models import Group, Permission
from django.test import TestCase, override_settings
from django.urls import reverse
from rest_framework.test import APIClient

from accounts.models import User
from accounts.tests.test_admin_access_revocation import _form_data
from boards.models import Board

PW = "pw123456!x"


def _staff(name, *, site_admin=False):
    user = User.objects.create_user(username=name, email=f"{name}@example.com", password=PW)
    user.is_staff = True
    user.is_site_admin = site_admin
    user.save()
    user.user_permissions.add(
        *Permission.objects.filter(
            content_type__app_label="accounts",
            content_type__model="user",
            codename__in=["view_user", "change_user"],
        )
    )
    return User.objects.get(pk=user.pk)


# Admin pages render static asset URLs; the manifest storage needs collectstatic.
_PLAIN_STATIC = override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
)


@_PLAIN_STATIC
class _Base(TestCase):
    def setUp(self):
        self.staff = _staff("staff_1577")
        self.client.force_login(self.staff)
        self.target = User.objects.create_user(username="target_1577", password=PW)

    def change_url(self, user):
        return reverse("admin:accounts_user_change", args=[user.pk])

    def post(self, user, **overrides):
        return self.client.post(self.change_url(user), _form_data(user, **overrides))


class PrivilegeFieldTests(_Base):
    def test_privilege_fields_are_not_editable_for_non_superuser(self):
        r = self.client.get(self.change_url(self.target))
        self.assertEqual(r.status_code, 200)
        form_fields = r.context["adminform"].form.fields
        for name in ("is_staff", "is_superuser", "groups", "user_permissions"):
            self.assertNotIn(name, form_fields)
            self.assertIn(name, r.context["adminform"].model_admin.get_readonly_fields(r.wsgi_request, self.target))

    def test_submitted_privilege_values_are_ignored(self):
        group = Group.objects.create(name="g_1577")
        perm = Permission.objects.get(codename="delete_user")
        r = self.post(
            self.target,
            is_staff="on",
            is_superuser="on",
            groups=[group.pk],
            user_permissions=[perm.pk],
            first_name="Ada",
        )
        self.assertEqual(r.status_code, 302)
        self.target.refresh_from_db()
        self.assertEqual(self.target.first_name, "Ada")
        self.assertFalse(self.target.is_staff)
        self.assertFalse(self.target.is_superuser)
        self.assertFalse(self.target.groups.exists())
        self.assertFalse(self.target.user_permissions.exists())

    def test_own_privilege_fields_are_not_editable(self):
        perm = Permission.objects.get(codename="delete_user")
        r = self.post(self.staff, is_superuser="on", user_permissions=[perm.pk])
        self.assertEqual(r.status_code, 302)
        self.staff.refresh_from_db()
        self.assertFalse(self.staff.is_superuser)
        self.assertFalse(self.staff.user_permissions.filter(pk=perm.pk).exists())

    def test_superuser_can_edit_privilege_fields(self):
        root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        self.client.force_login(root)
        r = self.client.get(self.change_url(self.target))
        form_fields = r.context["adminform"].form.fields
        for name in ("is_staff", "is_superuser", "groups", "user_permissions"):
            self.assertIn(name, form_fields)
        r = self.post(self.target, is_staff="on")
        self.assertEqual(r.status_code, 302)
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_staff)


class SuperuserVisibilityTests(_Base):
    def setUp(self):
        super().setUp()
        self.root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)

    def test_changelist_hides_superusers(self):
        r = self.client.get(reverse("admin:accounts_user_changelist"))
        self.assertEqual(r.status_code, 200)
        names = {u.username for u in r.context["cl"].result_list}
        self.assertIn("target_1577", names)
        self.assertNotIn("root_1577", names)

    def test_superuser_change_page_is_unavailable(self):
        # Django's change view redirects to the admin index for a missing object.
        r = self.client.get(self.change_url(self.root))
        self.assertRedirects(r, reverse("admin:index"), fetch_redirect_response=False)
        r = self.post(self.root, first_name="X")
        self.assertRedirects(r, reverse("admin:index"), fetch_redirect_response=False)
        self.root.refresh_from_db()
        self.assertEqual(self.root.first_name, "")

    def test_superuser_sees_superusers(self):
        self.client.force_login(self.root)
        names = {u.username for u in self.client.get(reverse("admin:accounts_user_changelist")).context["cl"].result_list}
        self.assertIn("root_1577", names)


class PasswordFormTests(_Base):
    def url(self, user):
        return reverse("admin:auth_user_password_change", args=[user.pk])

    def post_pw(self, user, pw="Str0ng-new-pass-1577"):
        return self.client.post(self.url(user), {"password1": pw, "password2": pw})

    def test_password_form_refused_for_superuser_target(self):
        root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        before = User.objects.get(pk=root.pk).password
        self.assertEqual(self.client.get(self.url(root)).status_code, 403)
        self.assertEqual(self.post_pw(root).status_code, 403)
        self.assertEqual(User.objects.get(pk=root.pk).password, before)

    def test_password_form_refused_for_site_admin_target(self):
        self.target.is_site_admin = True
        self.target.save()
        before = User.objects.get(pk=self.target.pk).password
        self.assertEqual(self.client.get(self.url(self.target)).status_code, 403)
        self.assertEqual(self.post_pw(self.target).status_code, 403)
        self.assertEqual(User.objects.get(pk=self.target.pk).password, before)

    def test_password_form_allowed_for_ordinary_target(self):
        r = self.post_pw(self.target)
        self.assertEqual(r.status_code, 302)
        self.target.refresh_from_db()
        self.assertTrue(self.target.check_password("Str0ng-new-pass-1577"))

    def test_site_admin_staff_may_set_own_password(self):
        me = _staff("sa_staff_1577", site_admin=True)
        self.client.force_login(me)
        self.assertEqual(self.post_pw(me).status_code, 302)

    def test_superuser_may_set_superuser_password(self):
        root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        other = User.objects.create_superuser(username="root2_1577", email="r21577@example.com", password=PW)
        self.client.force_login(root)
        self.assertEqual(self.post_pw(other).status_code, 302)


class DeactivationGuardFormTests(_Base):
    def assert_refused(self, r, user, text):
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, text)
        user.refresh_from_db()
        self.assertTrue(user.is_active)

    def test_self_deactivation_refused(self):
        r = self.post(self.staff, is_active="")
        self.assert_refused(r, self.staff, "You cannot deactivate your own account.")

    def test_board_owner_deactivation_refused(self):
        Board.objects.create(name="Owned 1577", owner=self.target)
        r = self.post(self.target, is_active="")
        self.assert_refused(r, self.target, "User owns boards that must be transferred before deactivation.")
        self.assertContains(r, "Owned boards: 1.")
        self.assertNotContains(r, "Owned 1577")

    def test_last_active_site_admin_deactivation_refused(self):
        root = User.objects.create_superuser(username="root_sa_1577", email="rsa1577@example.com", password=PW)
        User.objects.filter(pk=root.pk).update(is_site_admin=False)
        self.client.force_login(root)
        self.target.is_site_admin = True
        self.target.save()
        r = self.post(self.target, is_active="")
        self.assert_refused(r, self.target, "Cannot deactivate the last active site admin.")

    def test_site_admin_deactivation_allowed_when_another_remains(self):
        root = User.objects.create_superuser(username="root_sa2_1577", email="rsa2@example.com", password=PW)
        User.objects.filter(pk=root.pk).update(is_site_admin=False)
        self.client.force_login(root)
        self.target.is_site_admin = True
        self.target.save()
        _staff("sa2_1577", site_admin=True)
        self.assertEqual(self.post(self.target, is_active="").status_code, 302)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_active)

    def test_plain_deactivation_allowed(self):
        self.assertEqual(self.post(self.target, is_active="").status_code, 302)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_active)

    def test_superuser_actor_is_refused_for_each_guard(self):
        root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        self.client.force_login(root)
        # self-deactivation
        self.assert_refused(self.post(root, is_active=""), root, "You cannot deactivate your own account.")
        # board owner
        Board.objects.create(name="Owned 1577", owner=self.target)
        self.assert_refused(self.post(self.target, is_active=""), self.target, "must be transferred")
        # last active site admin
        other = User.objects.create_user(username="lastsa_1577", password=PW)
        other.is_site_admin = True
        other.save()
        User.objects.filter(pk=root.pk).update(is_site_admin=False)
        self.assert_refused(self.post(other, is_active=""), other, "last active site admin")

    def test_superuser_actor_may_deactivate_plain_user(self):
        root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        self.client.force_login(root)
        self.assertEqual(self.post(self.target, is_active="").status_code, 302)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_active)


@_PLAIN_STATIC
class DemotionGuardFormTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        self.client.force_login(self.root)

    def post(self, user, **overrides):
        return self.client.post(
            reverse("admin:accounts_user_change", args=[user.pk]), _form_data(user, **overrides)
        )

    def test_self_demotion_refused(self):
        r = self.post(self.root, is_superuser="")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "You cannot remove your own superuser status.")
        self.root.refresh_from_db()
        self.assertTrue(self.root.is_superuser)

    def test_demotion_allowed_when_another_active_superuser_remains(self):
        other = User.objects.create_superuser(username="o2_1577", email="o21577@example.com", password=PW)
        self.assertEqual(self.post(other, is_superuser="").status_code, 302)
        other.refresh_from_db()
        self.assertFalse(other.is_superuser)
        self.assertFalse(other.is_site_admin)

    def test_last_site_admin_cannot_be_demoted(self):
        # Two superusers; the second is demoted while the actor is not a site admin
        # holder: the last-site-admin rule refuses when no other site admin remains.
        other = User.objects.create_superuser(username="o3_1577", email="o31577@example.com", password=PW)
        User.objects.filter(pk=self.root.pk).update(is_site_admin=False)
        r = self.post(other, is_superuser="")
        self.assertContains(r, "Cannot demote the last active site admin.")
        other.refresh_from_db()
        self.assertTrue(other.is_superuser)


class SaveModelRecheckTests(TestCase):
    """The locked re-check in ``save_model`` catches a change made after the form's own check."""

    def setUp(self):
        from django.contrib.admin.sites import site as admin_site
        from django.test import RequestFactory

        self.model_admin = admin_site._registry[User]
        self.root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        self.target = User.objects.create_user(username="t_1577", password=PW)
        self.target.is_site_admin = True
        self.target.save()
        self.other = User.objects.create_user(username="o_1577", password=PW)
        self.other.is_site_admin = True
        self.other.save()
        self.request = RequestFactory().post("/")
        self.request.user = self.root
        User.objects.filter(pk=self.root.pk).update(is_site_admin=False)

    def test_deactivation_refused_after_state_changes_underneath(self):
        from django.core.exceptions import PermissionDenied

        form_cls = self.model_admin.get_form(self.request, self.target)
        form = form_cls(_form_data(self.target, is_active=""), instance=User.objects.get(pk=self.target.pk))
        self.assertTrue(form.is_valid(), form.errors)  # another site admin exists at this point
        User.objects.filter(pk=self.other.pk).update(is_active=False)
        obj = form.save(commit=False)
        with self.assertRaises(PermissionDenied):
            self.model_admin.save_model(self.request, obj, form, change=True)
        self.assertTrue(User.objects.get(pk=self.target.pk).is_active)

    def test_demotion_refused_after_state_changes_underneath(self):
        from django.core.exceptions import PermissionDenied

        sup = User.objects.create_superuser(username="s_1577", email="s1577@example.com", password=PW)
        form_cls = self.model_admin.get_form(self.request, sup)
        form = form_cls(_form_data(sup, is_superuser=""), instance=User.objects.get(pk=sup.pk))
        self.assertTrue(form.is_valid(), form.errors)  # root is another active superuser
        User.objects.filter(pk=self.root.pk).update(is_active=False)
        obj = form.save(commit=False)
        with self.assertRaises(PermissionDenied):
            self.model_admin.save_model(self.request, obj, form, change=True)
        self.assertTrue(User.objects.get(pk=sup.pk).is_superuser)

    def test_recheck_locks_target_and_guard_rows_in_one_ordered_query(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        obj = User.objects.get(pk=self.target.pk)
        obj.is_active = False
        with CaptureQueriesContext(connection) as ctx:
            self.model_admin.save_model(self.request, obj, None, change=True)
        locking = [
            q["sql"]
            for q in ctx.captured_queries
            if '"users"."is_active" AND "users"."is_superuser"' in q["sql"]
            and '"users"."is_active" AND "users"."is_site_admin"' in q["sql"]
            and "ORDER BY" in q["sql"]
        ]
        self.assertEqual(len(locking), 1, locking)


@_PLAIN_STATIC
class EnsureSiteAdminInteractionTests(TestCase):
    """The form cannot leave zero active site admins.

    ``ensure_site_admin`` promotes the environment-configured account (and
    resets its password) only when no site admin exists, so the form guards
    keep that bootstrap path from running on an established instance.

    The setup (``update(is_site_admin=False)`` on a superuser) is a constructed
    state that normal saves cannot reach; it makes ``sole`` the only site admin.
    """

    def test_form_cannot_remove_the_last_site_admin_so_bootstrap_stays_idle(self):
        from django.core.management import call_command

        root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        sole = User.objects.create_superuser(username="sole_1577", email="s1577@example.com", password=PW)
        User.objects.filter(pk=root.pk).update(is_site_admin=False)
        self.client.force_login(root)
        r = self.client.post(
            reverse("admin:accounts_user_change", args=[sole.pk]),
            _form_data(sole, is_superuser=""),
        )
        self.assertContains(r, "Cannot demote the last active site admin.")
        r = self.client.post(
            reverse("admin:accounts_user_change", args=[sole.pk]),
            _form_data(sole, is_active=""),
        )
        self.assertContains(r, "last active site admin")
        self.assertTrue(User.objects.filter(is_site_admin=True, is_active=True).exists())
        # Without the guard the demotion above would leave no site admin and
        # the command would create and promote the configured account.
        with mock.patch.dict(os.environ, {"DJANGO_SUPERUSER_USERNAME": "bootstrap_1577"}):
            call_command("ensure_site_admin")
        self.assertFalse(User.objects.filter(username="bootstrap_1577").exists())
        sole.refresh_from_db()
        self.assertTrue(sole.is_superuser and sole.is_site_admin and sole.is_active)


class AdminApiGuardsUnchangedTests(TestCase):
    """The admin API keeps its refusals and bodies after the guards were shared."""

    def setUp(self):
        self.admin = User.objects.create_user(username="api_admin_1577", password=PW)
        self.admin.is_site_admin = True
        self.admin.save()
        self.target = User.objects.create_user(username="api_target_1577", password=PW)
        self.api = APIClient()
        self.api.force_authenticate(self.admin)

    def url(self, user):
        return f"/api/v1/admin/users/{user.pk}/"

    def test_self_deactivation(self):
        r = self.api.patch(self.url(self.admin), {"is_active": False}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"detail": "You cannot deactivate your own account."})

    def test_board_owner(self):
        board = Board.objects.create(name="Owned API 1577", owner=self.target)
        r = self.api.patch(self.url(self.target), {"is_active": False}, format="json")
        self.assertEqual(r.status_code, 409)
        body = r.json()
        self.assertEqual(body["code"], "owned_boards")
        self.assertEqual(body["detail"], "User owns boards that must be transferred before deactivation.")
        self.assertEqual([b["id"] for b in body["owned_boards"]], [board.id])

    def test_plain_deactivation(self):
        r = self.api.patch(self.url(self.target), {"is_active": False}, format="json")
        self.assertEqual(r.status_code, 200)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_active)


class IdentityFieldTests(_Base):
    def test_site_admin_target_identity_fields_ignored(self):
        self.target.is_site_admin = True
        self.target.save()
        r = self.post(self.target, email="new@example.com", username="renamed_1577", first_name="Ada")
        self.assertEqual(r.status_code, 302)
        self.target.refresh_from_db()
        self.assertEqual(self.target.username, "target_1577")
        self.assertNotEqual(self.target.email, "new@example.com")
        self.assertEqual(self.target.first_name, "")

    def test_ordinary_target_identity_fields_editable(self):
        r = self.post(self.target, email="new@example.com", username="renamed_1577")
        self.assertEqual(r.status_code, 302)
        self.target.refresh_from_db()
        self.assertEqual(self.target.username, "renamed_1577")
        self.assertEqual(self.target.email, "new@example.com")

    def test_own_row_identity_fields_editable(self):
        me = _staff("sa_own_1577", site_admin=True)
        self.client.force_login(me)
        r = self.post(me, email="mine@example.com")
        self.assertEqual(r.status_code, 302)
        me.refresh_from_db()
        self.assertEqual(me.email, "mine@example.com")

    def test_superuser_actor_edits_site_admin_identity(self):
        root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        self.target.is_site_admin = True
        self.target.save()
        self.client.force_login(root)
        r = self.post(self.target, email="new@example.com")
        self.assertEqual(r.status_code, 302)
        self.target.refresh_from_db()
        self.assertEqual(self.target.email, "new@example.com")


class SiteAdminLockTests(_Base):
    def test_deactivation_locks_active_site_admins(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        self.target.is_site_admin = True
        self.target.save()
        _staff("sa3_1577", site_admin=True)
        with CaptureQueriesContext(connection) as ctx:
            r = self.post(self.target, is_active="")
        self.assertEqual(r.status_code, 302)
        if connection.features.has_select_for_update:
            locking = [q["sql"] for q in ctx.captured_queries if "FOR NO KEY UPDATE" in q["sql"] and "is_site_admin" in q["sql"]]
            self.assertTrue(locking)
        else:
            # SQLite has no row locks; the query itself must still be issued.
            site_admin_reads = [q["sql"] for q in ctx.captured_queries if '"is_site_admin"' in q["sql"] and "ORDER BY" in q["sql"]]
            self.assertTrue(site_admin_reads)


class AddViewAndEdgeTests(_Base):
    def test_add_view_creates_plain_user(self):
        self.staff.user_permissions.add(Permission.objects.get(codename="add_user"))
        url = reverse("admin:accounts_user_add")
        r = self.client.post(
            url,
            {
                "username": "added_1577",
                "password1": "Str0ng-new-pass-1577",
                "password2": "Str0ng-new-pass-1577",
                "is_staff": "on",
                "is_superuser": "on",
            },
        )
        self.assertEqual(r.status_code, 302)
        created = User.objects.get(username="added_1577")
        self.assertFalse(created.is_staff)
        self.assertFalse(created.is_superuser)

    def test_history_view_of_hidden_superuser_is_unavailable(self):
        root = User.objects.create_superuser(username="root_1577", email="r1577@example.com", password=PW)
        r = self.client.get(reverse("admin:accounts_user_history", args=[root.pk]))
        self.assertRedirects(r, reverse("admin:index"), fetch_redirect_response=False)

    def test_password_form_with_malformed_id_does_not_error(self):
        url = reverse("admin:auth_user_password_change", args=["not-a-number"])
        self.assertLess(self.client.get(url).status_code, 500)
        self.assertLess(self.client.post(url, {}).status_code, 500)


@_PLAIN_STATIC
class SuperuserAllContentFlagTests(TestCase):
    """A form save cannot leave all-content access cleared on a superuser (#1614)."""

    def test_form_save_regrants_flag_on_a_superuser(self):
        root = User.objects.create_superuser(
            username="root_1614", email="root_1614@example.com", password=PW
        )
        target = User.objects.create_superuser(
            username="target_1614", email="target_1614@example.com", password=PW
        )
        # Legacy row: superuser with the derived flag cleared.
        User.objects.filter(pk=target.pk).update(can_access_all_content=False)
        target.refresh_from_db()
        self.client.force_login(root)
        r = self.client.post(
            reverse("admin:accounts_user_change", args=[target.pk]),
            _form_data(target, first_name="Changed", can_access_all_content=""),
        )
        self.assertEqual(r.status_code, 302, getattr(r, "context", None) and r.context["adminform"].form.errors)
        target.refresh_from_db()
        self.assertEqual(target.first_name, "Changed")
        self.assertTrue(target.is_superuser)
        self.assertTrue(target.can_access_all_content)
        self.assertTrue(target.is_site_admin)
