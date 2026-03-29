"""Tests asserting raw_token/token are absent from group invite link list responses (#403)."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupInviteLink, GroupMembership


def _make_group(owner, name="Group"):
    group = Group.objects.create(name=name, owner=owner)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


class GroupInviteLinkTokenExposureTests(TestCase):
    """Covers #403: GET on group invite links must NOT include raw_token or token fields.

    The raw token is only returned once at creation time. Subsequent list
    responses must not leak it — an admin reviewing active links should see
    prefix and metadata but never the full secret.
    """

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        # Create a few invite links
        GroupInviteLink.generate(group=self.group, created_by=self.admin, role="member")
        GroupInviteLink.generate(group=self.group, created_by=self.admin, role="admin")

    def test_list_response_has_no_token_field(self):
        """The 'token' key must not appear in any invite link in the list."""
        r = self.client.get(f"/api/groups/{self.group.id}/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        for link in r.json():
            self.assertNotIn("token", link, "token field leaked in invite link list response")

    def test_list_response_has_no_raw_token_field(self):
        """The 'raw_token' key must not appear in any invite link in the list."""
        r = self.client.get(f"/api/groups/{self.group.id}/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        for link in r.json():
            self.assertNotIn("raw_token", link, "raw_token field leaked in invite link list response")

    def test_list_response_has_no_token_hash_field(self):
        """The internal 'token_hash' must never be exposed via API."""
        r = self.client.get(f"/api/groups/{self.group.id}/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        for link in r.json():
            self.assertNotIn("token_hash", link, "token_hash field leaked in invite link list response")

    def test_list_response_includes_prefix(self):
        """The prefix (safe, truncated identifier) should be present for admin display."""
        r = self.client.get(f"/api/groups/{self.group.id}/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        for link in r.json():
            self.assertIn("prefix", link)

    def test_serializer_fields_do_not_include_token(self):
        """Verify the serializer class itself does not declare token/raw_token fields."""
        from groups.serializers import GroupInviteLinkSerializer
        fields = GroupInviteLinkSerializer.Meta.fields
        self.assertNotIn("token", fields)
        self.assertNotIn("raw_token", fields)
        self.assertNotIn("token_hash", fields)
