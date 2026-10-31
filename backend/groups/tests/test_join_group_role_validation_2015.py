"""JoinGroupView.post validates the link role like registration does (#2015, Rule 9).

``choices`` is not enforced on save, so a link row written outside the API can
hold a role that is not a group membership role. Redemption must refuse it
(same 404 as an admin invite) and must not copy it into a membership.
"""
from django.core.cache import cache
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupInviteLink, GroupMembership


class JoinGroupRoleValidationTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(username="gadmin", password="p", email="gadmin@acme.test")
        self.joiner = User.objects.create_user(username="joiner", password="p", email="joiner@acme.test")
        self.group = Group.objects.create(name="Platform Team", owner=self.admin)
        GroupMembership.objects.create(group=self.group, user=self.admin, role=GroupMembership.Role.ADMIN)

    def tearDown(self):
        cache.clear()

    def join(self, raw):
        client = APIClient()
        client.force_authenticate(self.joiner)
        return client.post(f"/api/v1/groups/join/{raw}/")

    def test_valid_roles_are_copied_to_the_membership(self):
        for role in ("member", "collaborator", "viewer"):
            with self.subTest(role=role):
                GroupMembership.objects.filter(user=self.joiner).delete()
                link, raw = GroupInviteLink.generate(
                    group=self.group, created_by=self.admin, role=role, expires_at=None,
                )
                r = self.join(raw)
                self.assertIn(r.status_code, (status.HTTP_200_OK, status.HTTP_201_CREATED), r.content)
                m = GroupMembership.objects.get(group=self.group, user=self.joiner)
                self.assertEqual(m.role, role)

    def test_stored_out_of_enum_role_is_refused_and_creates_no_membership(self):
        link, raw = GroupInviteLink.generate(group=self.group, created_by=self.admin, expires_at=None)
        GroupInviteLink.objects.filter(pk=link.pk).update(role="superuser")
        r = self.join(raw)
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND, r.content)
        self.assertFalse(GroupMembership.objects.filter(group=self.group, user=self.joiner).exists())

    def test_refused_single_use_link_is_not_consumed(self):
        link, raw = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, expires_at=None, single_use=True,
        )
        GroupInviteLink.objects.filter(pk=link.pk).update(role="")
        r = self.join(raw)
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND, r.content)
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_preview_of_out_of_enum_role_link_is_not_found(self):
        link, raw = GroupInviteLink.generate(group=self.group, created_by=self.admin, expires_at=None)
        GroupInviteLink.objects.filter(pk=link.pk).update(role="superuser")
        client = APIClient()
        client.force_authenticate(self.joiner)
        r = client.get(f"/api/v1/groups/join/{raw}/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND, r.content)
