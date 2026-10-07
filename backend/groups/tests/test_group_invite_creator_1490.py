"""Group invite links and their creator's standing (#1490).

Deactivating a user revokes their active group invite links (announced on the
group channel), and preview/join refuse a link whose creator is inactive or no
longer a group admin — answering exactly like a revoked link.
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupInviteLink, GroupMembership


def join_url(token):
    return f"/api/v1/groups/join/{token}/"


class GroupInviteCreatorDeactivationTests(TestCase):
    def setUp(self):
        self.site_admin = User.objects.create_user(
            username="siteadmin",
            password="pw",
            is_site_admin=True,
        )
        self.creator = User.objects.create_user(username="creator", password="pw")
        self.other = User.objects.create_user(username="other", password="pw")
        self.group = Group.objects.create(name="G", owner=self.creator)
        GroupMembership.objects.create(
            group=self.group,
            user=self.creator,
            role=GroupMembership.Role.ADMIN,
        )
        GroupMembership.objects.create(
            group=self.group,
            user=self.other,
            role=GroupMembership.Role.ADMIN,
        )
        self.link, self.raw = GroupInviteLink.generate(self.group, self.creator)
        self.other_link, _ = GroupInviteLink.generate(self.group, self.other)
        self.admin_client = APIClient()
        self.admin_client.force_authenticate(self.site_admin)

    def _deactivate(self):
        return self.admin_client.post(
            f"/api/v1/admin/users/{self.creator.pk}/deactivate/",
            {},
            format="json",
        )

    def test_deactivation_revokes_creators_active_group_links_only(self):
        self.assertEqual(self._deactivate().status_code, status.HTTP_200_OK)
        self.link.refresh_from_db()
        self.other_link.refresh_from_db()
        self.assertFalse(self.link.is_active)
        self.assertEqual(self.link.status, "revoked")
        self.assertTrue(self.other_link.is_active)

    def test_deactivation_broadcasts_revoked_on_group_channel_after_commit(self):
        with (
            patch("groups.broadcast.broadcast_group_event") as mock_bc,
            self.captureOnCommitCallbacks(execute=True),
        ):
            self._deactivate()
        mock_bc.assert_called_once_with(
            self.group.pk,
            "invite_link.revoked",
            {"id": self.link.pk},
        )

    def test_broadcast_is_deferred_not_fired_inline(self):
        with patch("groups.broadcast.broadcast_group_event") as mock_bc:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                self._deactivate()
            mock_bc.assert_not_called()
            self.assertTrue(callbacks)

    def test_no_broadcast_when_creator_has_no_group_links(self):
        GroupInviteLink.objects.filter(created_by=self.creator).delete()
        with (
            patch("groups.broadcast.broadcast_group_event") as mock_bc,
            self.captureOnCommitCallbacks(execute=True),
        ):
            self._deactivate()
        mock_bc.assert_not_called()

    def test_already_revoked_link_not_rebroadcast(self):
        GroupInviteLink.objects.filter(pk=self.link.pk).update(is_active=False)
        with (
            patch("groups.broadcast.broadcast_group_event") as mock_bc,
            self.captureOnCommitCallbacks(execute=True),
        ):
            self._deactivate()
        mock_bc.assert_not_called()


class GroupInviteCreatorRecheckTests(TestCase):
    def setUp(self):
        self.creator = User.objects.create_user(username="creator", password="pw")
        self.joiner = User.objects.create_user(username="joiner", password="pw")
        self.group = Group.objects.create(name="G", owner=self.creator)
        self.membership = GroupMembership.objects.create(
            group=self.group,
            user=self.creator,
            role=GroupMembership.Role.ADMIN,
        )
        self.link, self.raw = GroupInviteLink.generate(self.group, self.creator)
        self.client = APIClient()
        self.client.force_authenticate(self.joiner)

    def _revoked_baseline(self):
        """Status/body a genuinely revoked link produces, for shape comparison."""
        link, raw = GroupInviteLink.generate(self.group, self.creator)
        GroupInviteLink.objects.filter(pk=link.pk).update(is_active=False)
        return self.client.post(join_url(raw)), self.client.get(join_url(raw))

    def test_active_admin_creator_link_works(self):
        self.assertEqual(self.client.get(join_url(self.raw)).status_code, 200)
        self.assertEqual(self.client.post(join_url(self.raw)).status_code, 201)

    def test_inactive_creator_refused_like_revoked(self):
        base_post, base_get = self._revoked_baseline()
        User.objects.filter(pk=self.creator.pk).update(is_active=False)
        post = self.client.post(join_url(self.raw))
        get = self.client.get(join_url(self.raw))
        self.assertEqual(post.status_code, base_post.status_code)
        self.assertEqual(post.json(), base_post.json())
        self.assertEqual(get.status_code, base_get.status_code)
        self.assertEqual(get.json(), base_get.json())
        self.assertFalse(
            GroupMembership.objects.filter(group=self.group, user=self.joiner).exists()
        )

    def test_demoted_creator_refused(self):
        self.membership.role = GroupMembership.Role.MEMBER
        self.membership.save(update_fields=["role"])
        self.assertEqual(self.client.get(join_url(self.raw)).status_code, 404)
        self.assertEqual(self.client.post(join_url(self.raw)).status_code, 404)
        self.assertFalse(
            GroupMembership.objects.filter(group=self.group, user=self.joiner).exists()
        )

    def test_removed_creator_refused(self):
        self.membership.delete()
        self.assertEqual(self.client.post(join_url(self.raw)).status_code, 404)

    def test_deleted_creator_refused(self):
        self.creator.delete()
        self.assertEqual(self.client.post(join_url(self.raw)).status_code, 404)

    def test_parent_group_admin_creator_still_admits(self):
        child = Group.objects.create(
            name="Child", owner=self.creator, parent=self.group
        )
        link, raw = GroupInviteLink.generate(child, self.creator)
        self.assertEqual(self.client.post(join_url(raw)).status_code, 201)

    def test_member_of_consumed_single_use_link_still_resolves_after_creator_leaves(
        self,
    ):
        link, raw = GroupInviteLink.generate(self.group, self.creator, single_use=True)
        self.assertEqual(self.client.post(join_url(raw)).status_code, 201)
        User.objects.filter(pk=self.creator.pk).update(is_active=False)
        self.assertEqual(self.client.get(join_url(raw)).status_code, 200)
        self.assertEqual(self.client.post(join_url(raw)).status_code, 200)
