"""Django admin: read-only Group admin and the superuser-only ownership transfer (#1643)."""

from unittest import mock, skipUnless

from django.contrib.admin.helpers import ACTION_CHECKBOX_NAME
from django.contrib.messages import get_messages
from django.db import connection
from django.test import TestCase, TransactionTestCase, override_settings
from django.urls import reverse

from accounts.models import User
from groups.models import Group, GroupMembership

_PLAIN_STATIC = override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {
            "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"
        },
    }
)
PW = "Str0ng-pass-1234!"


def _user(name, *, staff=False, superuser=False, active=True):
    u = User.objects.create_user(
        username=name, email=f"{name}@example.com", password=PW
    )
    u.is_staff = staff
    u.is_superuser = superuser
    u.is_active = active
    u.save()
    return u


def _msgs(response):
    return [str(m) for m in get_messages(response.wsgi_request)]


@_PLAIN_STATIC
class AdminTransferOwnershipTests(TestCase):
    def setUp(self):
        self.root = _user("root", staff=True, superuser=True)
        self.departed = _user("departed", active=False)
        self.heir = _user("heir")
        self.viewer_member = _user("viewer_member")
        self.inactive_member = _user("inactive_member", active=False)
        self.outsider = _user("outsider")
        self.group = Group.objects.create(name="Departed team", owner=self.departed)
        GroupMembership.objects.create(
            group=self.group, user=self.departed, role=GroupMembership.Role.ADMIN
        )
        GroupMembership.objects.create(
            group=self.group, user=self.heir, role=GroupMembership.Role.MEMBER
        )
        GroupMembership.objects.create(
            group=self.group, user=self.inactive_member, role=GroupMembership.Role.ADMIN
        )
        self.changelist = reverse("admin:groups_group_changelist")
        self.client.force_login(self.root)

    def _action(self, **extra):
        data = {
            "action": "transfer_ownership",
            ACTION_CHECKBOX_NAME: [self.group.pk],
            **extra,
        }
        return self.client.post(self.changelist, data, follow=True)

    def test_superuser_sees_form_with_only_active_members_of_that_group(self):
        r = self._action()
        self.assertEqual(r.status_code, 200)
        form = r.context["form"]
        self.assertEqual(list(form.fields["new_owner"].queryset), [self.heir])

    def test_superuser_transfers_to_active_member(self):
        r = self._action(
            step="confirm", expected_owner=self.departed.pk, new_owner=self.heir.pk
        )
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.heir.pk)
        self.assertTrue(any("transferred to" in m for m in _msgs(r)), _msgs(r))
        # New owner holds the admin role; previous owner stays an admin member.
        roles = dict(
            GroupMembership.objects.filter(group=self.group).values_list(
                "user_id", "role"
            )
        )
        self.assertEqual(roles[self.heir.pk], GroupMembership.Role.ADMIN)
        self.assertEqual(roles[self.departed.pk], GroupMembership.Role.ADMIN)

    def test_repairs_group_whose_owner_has_no_admin_row(self):
        """Rule 11 repair path: the owner's admin row is gone, a superuser transfers."""
        GroupMembership.objects.filter(group=self.group, user=self.departed).delete()
        self._action(
            step="confirm", expected_owner=self.departed.pk, new_owner=self.heir.pk
        )
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.heir.pk)
        roles = dict(
            GroupMembership.objects.filter(group=self.group).values_list(
                "user_id", "role"
            )
        )
        self.assertEqual(roles[self.heir.pk], GroupMembership.Role.ADMIN)
        self.assertEqual(roles[self.departed.pk], GroupMembership.Role.ADMIN)

    def test_stale_form_refused_when_owner_changed_since_render(self):
        # The page showed "departed" as owner; the API moved it to the heir
        # before the superuser confirmed.
        Group.objects.filter(pk=self.group.pk).update(owner=self.heir)
        other = _user("other_stale")
        GroupMembership.objects.create(group=self.group, user=other)
        r = self._action(
            step="confirm", expected_owner=self.departed.pk, new_owner=other.pk
        )
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.heir.pk)
        self.assertTrue(
            any("Ownership changed while this page was open" in m for m in _msgs(r)),
            _msgs(r),
        )

    def test_confirm_without_expected_owner_refused(self):
        self._action(step="confirm", new_owner=self.heir.pk)
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.departed.pk)

    def test_form_renders_expected_owner(self):
        r = self._action()
        self.assertContains(r, f'name="expected_owner" value="{self.departed.pk}"')

    def test_inactive_member_rejected(self):
        self._action(
            step="confirm",
            expected_owner=self.departed.pk,
            new_owner=self.inactive_member.pk,
        )
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.departed.pk)

    def test_non_member_rejected(self):
        self._action(
            step="confirm", expected_owner=self.departed.pk, new_owner=self.outsider.pk
        )
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.departed.pk)

    def test_current_owner_rejected(self):
        self._action(
            step="confirm", expected_owner=self.departed.pk, new_owner=self.departed.pk
        )
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.departed.pk)

    def test_service_refuses_inactive_and_non_member_under_lock(self):
        # The form is the first check; the service judges again.
        from groups.services import GroupTransferError, transfer_group_ownership

        for target in (self.inactive_member, self.outsider):
            with self.assertRaises(GroupTransferError):
                transfer_group_ownership(
                    self.group.pk,
                    target.pk,
                    require_admin_role=False,
                    require_active=True,
                )
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.departed.pk)

    def test_stale_owner_refused(self):
        from groups.services import GroupTransferError, transfer_group_ownership

        with self.assertRaises(GroupTransferError):
            transfer_group_ownership(
                self.group.pk,
                self.heir.pk,
                expected_owner_id=self.root.pk,
                require_admin_role=False,
                require_active=True,
            )

    def test_broadcast_fired_after_transfer(self):
        with mock.patch("groups.broadcast.broadcast_group_event") as bc:
            with self.captureOnCommitCallbacks(execute=True):
                self._action(
                    step="confirm",
                    expected_owner=self.departed.pk,
                    new_owner=self.heir.pk,
                )
        bc.assert_called_once()
        self.assertEqual(bc.call_args.args[0], self.group.pk)
        self.assertEqual(bc.call_args.args[2]["owner"]["id"], self.heir.pk)

    def test_user_deletion_refusal_clears_after_transfer(self):
        delete_url = reverse("admin:accounts_user_delete", args=[self.departed.pk])
        r = self.client.post(delete_url, {"post": "yes"}, follow=True)
        self.assertTrue(User.objects.filter(pk=self.departed.pk).exists())
        refusal = [m for m in _msgs(r) if "owns groups" in m]
        self.assertTrue(refusal, _msgs(r))
        self.assertIn("Transfer ownership", refusal[0])

        self._action(
            step="confirm", expected_owner=self.departed.pk, new_owner=self.heir.pk
        )
        self.client.post(delete_url, {"post": "yes"}, follow=True)
        self.assertFalse(User.objects.filter(pk=self.departed.pk).exists())
        self.assertTrue(Group.objects.filter(pk=self.group.pk).exists())

    def test_group_admin_is_read_only_and_not_deletable(self):
        url = reverse("admin:groups_group_change", args=[self.group.pk])
        self.assertEqual(self.client.get(url).status_code, 200)
        self.client.post(url, {"name": "Renamed", "owner": self.heir.pk})
        self.group.refresh_from_db()
        self.assertEqual(self.group.name, "Departed team")
        self.assertEqual(
            self.client.get(reverse("admin:groups_group_add")).status_code, 403
        )
        delete_url = reverse("admin:groups_group_delete", args=[self.group.pk])
        self.assertEqual(self.client.post(delete_url, {"post": "yes"}).status_code, 403)
        self.assertTrue(Group.objects.filter(pk=self.group.pk).exists())

    def test_delete_selected_not_offered(self):
        r = self.client.get(self.changelist)
        self.assertNotIn(
            "delete_selected", dict(r.context["action_form"].fields["action"].choices)
        )

    def test_multiple_groups_selected_refused(self):
        other = Group.objects.create(name="Other", owner=self.heir)
        data = {
            "action": "transfer_ownership",
            ACTION_CHECKBOX_NAME: [self.group.pk, other.pk],
        }
        r = self.client.post(self.changelist, data, follow=True)
        self.assertTrue(any("exactly one group" in m for m in _msgs(r)), _msgs(r))


@_PLAIN_STATIC
class AdminTransferOwnershipPermissionTests(TestCase):
    def setUp(self):
        self.owner = _user("owner_p")
        self.heir = _user("heir_p")
        self.group = Group.objects.create(name="Perm group", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.heir)
        self.changelist = reverse("admin:groups_group_changelist")
        self.staff = _user("staff_p", staff=True)

    def test_staff_non_superuser_cannot_see_groups_admin(self):
        self.client.force_login(self.staff)
        self.assertEqual(self.client.get(self.changelist).status_code, 403)

    def test_staff_non_superuser_cannot_execute_action(self):
        self.client.force_login(self.staff)
        self.client.post(
            self.changelist,
            {
                "action": "transfer_ownership",
                ACTION_CHECKBOX_NAME: [self.group.pk],
                "step": "confirm",
                "expected_owner": self.owner.pk,
                "new_owner": self.heir.pk,
            },
        )
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.owner.pk)

    def test_action_method_denies_non_superuser_directly(self):
        from django.contrib import admin
        from django.core.exceptions import PermissionDenied
        from django.test import RequestFactory

        request = RequestFactory().post("/")
        request.user = self.staff
        model_admin = admin.site._registry[Group]
        with self.assertRaises(PermissionDenied):
            model_admin.transfer_ownership(request, Group.objects.all())

    def test_inactive_superuser_denied(self):
        from django.contrib import admin
        from django.test import RequestFactory

        root = _user("root_p", staff=True, superuser=True, active=False)
        request = RequestFactory().get("/")
        request.user = root
        self.assertFalse(admin.site._registry[Group].has_view_permission(request))


@_PLAIN_STATIC
class AdminTransferLogTests(TestCase):
    def test_successful_transfer_is_logged(self):
        from django.contrib.admin.models import CHANGE, LogEntry

        root = _user("root_l", staff=True, superuser=True)
        owner = _user("owner_l", active=False)
        heir = _user("heir_l")
        group = Group.objects.create(name="Logged", owner=owner)
        GroupMembership.objects.create(group=group, user=heir)
        self.client.force_login(root)
        self.client.post(
            reverse("admin:groups_group_changelist"),
            {
                "action": "transfer_ownership",
                ACTION_CHECKBOX_NAME: [group.pk],
                "step": "confirm",
                "expected_owner": owner.pk,
                "new_owner": heir.pk,
            },
        )
        entry = LogEntry.objects.get(object_id=str(group.pk))
        self.assertEqual(entry.action_flag, CHANGE)
        self.assertEqual(entry.user_id, root.pk)
        self.assertIn("Transferred ownership to heir_l", entry.change_message)


@_PLAIN_STATIC
class AdminTransferParityTests(TestCase):
    def test_group_updated_payload_keys_match_the_api_path(self):
        from rest_framework.test import APIClient

        root = _user("root_pa", staff=True, superuser=True)
        owner = _user("owner_pa")
        heir = _user("heir_pa")

        def make(name):
            g = Group.objects.create(name=name, owner=owner)
            GroupMembership.objects.create(
                group=g, user=owner, role=GroupMembership.Role.ADMIN
            )
            GroupMembership.objects.create(
                group=g, user=heir, role=GroupMembership.Role.ADMIN
            )
            return g

        api_group, admin_group = make("Api"), make("Adm")
        payloads = {}

        def capture(key):
            return lambda gid, event, data, **_kw: payloads.__setitem__(key, data)

        api = APIClient()
        api.force_authenticate(owner)
        with mock.patch(
            "groups.broadcast.broadcast_group_event", side_effect=capture("api")
        ):
            with self.captureOnCommitCallbacks(execute=True):
                r = api.post(
                    f"/api/v1/groups/{api_group.pk}/transfer-ownership/",
                    {"new_owner_id": heir.pk, "confirmation": api_group.name},
                )
        self.assertEqual(r.status_code, 200)
        self.client.force_login(root)
        with mock.patch(
            "groups.broadcast.broadcast_group_event", side_effect=capture("admin")
        ):
            with self.captureOnCommitCallbacks(execute=True):
                self.client.post(
                    reverse("admin:groups_group_changelist"),
                    {
                        "action": "transfer_ownership",
                        ACTION_CHECKBOX_NAME: [admin_group.pk],
                        "step": "confirm",
                        "expected_owner": owner.pk,
                        "new_owner": heir.pk,
                    },
                )
        self.assertEqual(set(payloads["api"]), set(payloads["admin"]))
        self.assertEqual(set(payloads["api"]["owner"]), set(payloads["admin"]["owner"]))


@skipUnless(
    connection.vendor == "postgresql",
    "interleaving needs separate PostgreSQL connections",
)
@_PLAIN_STATIC
class AdminTransferRaceTests(TransactionTestCase):
    """The admin action and the owner's API transfer race; exactly one wins."""

    def test_exactly_one_transfer_wins(self):
        import threading

        from django.db import connections
        from rest_framework.test import APIClient

        root = _user("root_rc", staff=True, superuser=True)
        owner = _user("owner_rc")
        heir_a = _user("heir_a_rc")
        heir_b = _user("heir_b_rc")
        group = Group.objects.create(name="Race", owner=owner)
        for u in (owner, heir_a, heir_b):
            GroupMembership.objects.create(
                group=group, user=u, role=GroupMembership.Role.ADMIN
            )

        barrier = threading.Barrier(2)
        results = {}

        def api_side():
            try:
                c = APIClient()
                c.force_authenticate(owner)
                barrier.wait(timeout=10)
                r = c.post(
                    f"/api/v1/groups/{group.pk}/transfer-ownership/",
                    {"new_owner_id": heir_a.pk, "confirmation": group.name},
                )
                results["api"] = r.status_code
            finally:
                connections.close_all()

        def admin_side():
            try:
                from django.test import Client

                c = Client()
                c.force_login(root)
                barrier.wait(timeout=10)
                c.post(
                    reverse("admin:groups_group_changelist"),
                    {
                        "action": "transfer_ownership",
                        ACTION_CHECKBOX_NAME: [group.pk],
                        "step": "confirm",
                        "expected_owner": owner.pk,
                        "new_owner": heir_b.pk,
                    },
                )
                results["admin"] = True
            finally:
                connections.close_all()

        threads = [
            threading.Thread(target=api_side),
            threading.Thread(target=admin_side),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)

        from django.contrib.admin.models import LogEntry

        group.refresh_from_db()
        admin_won = LogEntry.objects.filter(object_id=str(group.pk)).exists()
        api_won = results["api"] == 200
        # Exactly one wins; the final owner is the winner's choice and the
        # loser is refused without changing anything.
        self.assertNotEqual(api_won, admin_won, results)
        if api_won:
            self.assertEqual(group.owner_id, heir_a.pk)
        else:
            self.assertEqual(group.owner_id, heir_b.pk)
            # 403 if the admin commit landed before the view loaded the group,
            # 400 if it landed between the view check and the row lock.
            self.assertIn(results["api"], (400, 403))
