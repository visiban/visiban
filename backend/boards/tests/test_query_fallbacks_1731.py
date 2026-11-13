"""Serializer live-query fallbacks are reported outside production (#1731).

The test suite runs with ``SERIALIZER_FALLBACK_GUARD = "raise"``, so any test
that renders a list through one of these serializers without the annotated
queryset fails. These tests pin the guard itself: each mode, the list-only rule,
and one fallback per serializer family.
"""

import logging

from django.test import TestCase, override_settings
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory, force_authenticate

from accounts.admin_views import AdminUserSerializer
from accounts.models import User
from boards.models import Board, BoardMembership
from boards.serializers import BoardFullSerializer, BoardSerializer
from boards.views._helpers import annotate_board_counts
from groups.models import Group, GroupInviteLink, GroupMembership
from groups.serializers import (
    GroupDetailSerializer,
    GroupInviteLinkSerializer,
    GroupSerializer,
)
from visiban.query_fallbacks import UnannotatedFallback, fk_chain_loaded


class FallbackGuardModeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="fb_user", password="pass")
        self.boards = [
            Board.objects.create(name=f"B{i}", owner=self.user) for i in range(2)
        ]
        for b in self.boards:
            BoardMembership.objects.create(
                board=b, user=self.user, role=BoardMembership.Role.ADMIN
            )

    def test_test_suite_runs_with_raise(self):
        from django.conf import settings

        self.assertEqual(settings.SERIALIZER_FALLBACK_GUARD, "raise")

    def test_unannotated_list_raises_naming_the_field(self):
        with self.assertRaises(UnannotatedFallback) as ctx:
            BoardSerializer(Board.objects.filter(owner=self.user), many=True).data
        self.assertIn("BoardSerializer.get_member_count", str(ctx.exception))

    def test_single_object_fallback_is_not_reported(self):
        """One object pays one query: the documented purpose of the fallback."""
        data = BoardSerializer(Board.objects.get(pk=self.boards[0].pk)).data
        self.assertEqual(data["member_count"], 1)

    def test_annotated_list_is_not_reported(self):
        qs = annotate_board_counts(Board.objects.filter(owner=self.user))
        data = BoardSerializer(qs, many=True).data
        self.assertEqual(len(data), 2)

    @override_settings(SERIALIZER_FALLBACK_GUARD="warn")
    def test_warn_mode_logs_and_returns_the_live_value(self):
        with self.assertLogs("visiban.query_fallbacks", level=logging.WARNING) as logs:
            data = BoardSerializer(
                Board.objects.filter(owner=self.user), many=True
            ).data
        self.assertEqual([row["member_count"] for row in data], [1, 1])
        self.assertTrue(any("get_member_count" in line for line in logs.output))

    @override_settings(SERIALIZER_FALLBACK_GUARD="off")
    def test_off_mode_is_silent_and_unchanged(self):
        logger = logging.getLogger("visiban.query_fallbacks")
        with self.assertNoLogs(logger, level=logging.WARNING):
            data = BoardSerializer(
                Board.objects.filter(owner=self.user), many=True
            ).data
        self.assertEqual([row["member_count"] for row in data], [1, 1])


@override_settings(SERIALIZER_FALLBACK_GUARD="warn")
class FallbackCoverageTests(TestCase):
    """Each listed serializer field reports its fallback (#1731)."""

    def setUp(self):
        self.user = User.objects.create_user(username="fb_cov", password="pass")
        self.root = Group.objects.create(name="Root", owner=self.user)
        self.child = Group.objects.create(
            name="Child", owner=self.user, parent=self.root
        )
        for g in (self.root, self.child):
            GroupMembership.objects.create(
                group=g, user=self.user, role=GroupMembership.Role.ADMIN
            )

    def _warned(self, render):
        with self.assertLogs("visiban.query_fallbacks", level=logging.WARNING) as logs:
            render()
        return "\n".join(logs.output)

    def test_group_list_counts(self):
        out = self._warned(lambda: GroupSerializer(Group.objects.all(), many=True).data)
        for field in ("get_member_count", "get_board_count", "get_subgroup_count"):
            self.assertIn(f"GroupSerializer.{field}", out)

    def _request(self):
        # is_starred fallbacks only run for an authenticated request in context.
        raw = APIRequestFactory().get("/")
        force_authenticate(raw, user=self.user)
        return Request(raw)

    def test_board_list_counts_and_star(self):
        Board.objects.create(name="FbBoard", owner=self.user)
        out = self._warned(
            lambda: BoardSerializer(
                Board.objects.all(), many=True, context={"request": self._request()}
            ).data
        )
        for field in (
            "get_member_count",
            "get_card_count",
            "get_archived_card_count",
            "get_is_starred",
        ):
            self.assertIn(f"BoardSerializer.{field}", out)

    def test_board_full_list_archived_card_count(self):
        Board.objects.create(name="FbFull", owner=self.user)
        out = self._warned(
            lambda: BoardFullSerializer(
                Board.objects.all(), many=True, context={"request": self._request()}
            ).data
        )
        self.assertIn("BoardFullSerializer.get_archived_card_count", out)

    def test_group_list_is_starred(self):
        out = self._warned(
            lambda: GroupSerializer(
                Group.objects.all(), many=True, context={"request": self._request()}
            ).data
        )
        self.assertIn("GroupSerializer.get_is_starred", out)

    def test_admin_user_list_owned_boards(self):
        out = self._warned(
            lambda: AdminUserSerializer(User.objects.all(), many=True).data
        )
        self.assertIn("AdminUserSerializer.get_owned_boards", out)

    def test_invite_link_list_created_by(self):
        GroupInviteLink.generate(group=self.root, created_by=self.user, role="member")
        out = self._warned(
            lambda: (
                GroupInviteLinkSerializer(GroupInviteLink.objects.all(), many=True).data
            )
        )
        self.assertIn("GroupInviteLinkSerializer.get_created_by_username", out)

    def test_invite_link_list_with_select_related_is_silent(self):
        GroupInviteLink.generate(group=self.root, created_by=self.user, role="member")
        qs = GroupInviteLink.objects.select_related("created_by")
        with self.assertNoLogs("visiban.query_fallbacks", level=logging.WARNING):
            GroupInviteLinkSerializer(qs, many=True).data

    def test_group_detail_ancestors_without_chain(self):
        # Two levels up: ``parent_name`` loads the first hop on its own.
        leaf = Group.objects.create(name="Leaf", owner=self.user, parent=self.child)
        out = self._warned(
            lambda: GroupDetailSerializer(Group.objects.get(pk=leaf.pk)).data[
                "ancestors"
            ]
        )
        self.assertIn("GroupDetailSerializer.get_ancestors", out)

    def test_fk_chain_loaded(self):
        self.assertFalse(
            fk_chain_loaded(Group.objects.get(pk=self.child.pk), "parent", 6)
        )
        self.assertTrue(
            fk_chain_loaded(
                Group.objects.select_related("parent").get(pk=self.child.pk),
                "parent",
                6,
            )
        )
        self.assertTrue(
            fk_chain_loaded(Group.objects.get(pk=self.root.pk), "parent", 6)
        )
