"""Absent-input tests for the guards the #1075 sweep changed.

#1075: a guard that branches on the presence of an input (a serializer context
key, a URL kwarg, a ``getattr(..., None)``) must deny or raise when that input
is absent, never degrade to "no check". Every test that constructs the
populated case passes whether or not the absent case is safe, so each guard
gets a test here that builds it WITHOUT the input and asserts the safe outcome,
next to one that pins the populated behavior as unchanged.

The full sweep, with the verdict for each guard, is in the #1075 MR.
"""
from types import SimpleNamespace

from django.test import SimpleTestCase, TestCase
from rest_framework import serializers
from rest_framework.test import APIRequestFactory

from boards.models import BoardMembership
from boards.permissions import IsBoardAdminOrOwner, IsBoardMember
from boards.serializers import (
    BROADCAST_PAYLOAD_CONTEXT_KEY,
    BoardMembershipSerializer,
    CardSerializer,
    SwimlaneSerializer,
)
from boards.tests.conftest import _make_board, _make_column, _make_membership, _make_user
from boards.models import Label
from groups.models import Group, GroupMembership
from visiban.invite_recipient import (
    confirmed_address_admits,
    grant_awaits_verification,
    recipient_admits,
    signup_address_admits,
)


class BoardMembershipSerializerAbsentRoleTests(TestCase):
    """``to_representation`` strips both flags when no role can be resolved."""

    def setUp(self):
        self.owner = _make_user()
        self.board = _make_board(self.owner)
        self.target = _make_user(is_site_admin=True)
        self.membership = BoardMembership.objects.create(
            board=self.board, user=self.target, role=BoardMembership.Role.MEMBER,
            is_moderator=True,
        )

    def test_no_context_strips_both_flags(self):
        data = BoardMembershipSerializer(self.membership).data
        self.assertNotIn("is_moderator", data)
        self.assertNotIn("is_site_admin", data)
        self.assertEqual(data["role"], BoardMembership.Role.MEMBER)

    def test_request_without_board_strips_both_flags(self):
        """A request alone cannot resolve a role: no board to resolve it on."""
        request = APIRequestFactory().get("/")
        request.user = self.owner
        data = BoardMembershipSerializer(self.membership, context={"request": request}).data
        self.assertNotIn("is_moderator", data)
        self.assertNotIn("is_site_admin", data)

    def test_unresolved_role_keeps_only_the_viewers_own_moderator_flag(self):
        """The self-row exception still needs a known viewer, as before."""
        request = APIRequestFactory().get("/")
        request.user = self.target
        data = BoardMembershipSerializer(self.membership, context={"request": request}).data
        self.assertIs(data["is_moderator"], True)
        self.assertNotIn("is_site_admin", data)

    def test_explicit_broadcast_context_keeps_both_flags(self):
        data = BoardMembershipSerializer(
            self.membership, context={BROADCAST_PAYLOAD_CONTEXT_KEY: True},
        ).data
        self.assertIs(data["is_moderator"], True)
        self.assertIs(data["is_site_admin"], True)

    def test_broadcast_marker_must_be_exactly_true(self):
        """A truthy non-bool (a stray string) is not the opt-in."""
        data = BoardMembershipSerializer(
            self.membership, context={BROADCAST_PAYLOAD_CONTEXT_KEY: "yes"},
        ).data
        self.assertNotIn("is_moderator", data)

    def test_resolved_admin_role_is_unchanged(self):
        request = APIRequestFactory().get("/")
        request.user = self.owner
        data = BoardMembershipSerializer(
            self.membership, context={"request": request, "board": self.board},
        ).data
        self.assertIs(data["is_moderator"], True)
        self.assertIs(data["is_site_admin"], True)

    def test_invite_redemption_payload_is_unfiltered(self):
        """The invite writer opts in, so the stored member.added keeps both flags.

        The consumer and the change feed strip them per reader (Rule 8).
        """
        from boards.models import BoardEvent, BoardInviteLink
        from boards.invites import redeem

        joiner = _make_user()
        link, _ = BoardInviteLink.generate(
            board=self.board, created_by=self.owner, role=BoardMembership.Role.MEMBER,
        )
        self.assertTrue(redeem(link, joiner, self.board, via="test"))
        event = BoardEvent.objects.filter(board_id=self.board.pk, event="member.added").last()
        self.assertIn("is_moderator", event.data)
        self.assertIn("is_site_admin", event.data)


class CardSerializerAbsentBoardTests(TestCase):
    """``label_ids`` accepts no label until the context names a board."""

    def setUp(self):
        owner = _make_user()
        self.board = _make_board(owner)
        self.other_board = _make_board(owner, name="Other")
        self.label = Label.objects.create(board=self.board, name="L", color="#112233")
        self.foreign_label = Label.objects.create(board=self.other_board, name="F", color="#112233")

    def _resolve(self, serializer, pk):
        return serializer.fields["label_ids"].child_relation.to_internal_value(pk)

    def test_no_board_context_accepts_no_label(self):
        serializer = CardSerializer()
        for pk in (self.label.pk, self.foreign_label.pk):
            with self.assertRaises(serializers.ValidationError):
                self._resolve(serializer, pk)

    def test_board_context_accepts_only_its_own_labels(self):
        serializer = CardSerializer(context={"board": self.board})
        self.assertEqual(self._resolve(serializer, self.label.pk), self.label)
        with self.assertRaises(serializers.ValidationError):
            self._resolve(serializer, self.foreign_label.pk)


class SwimlaneLimitColumnIdsAbsentBoardTests(TestCase):
    """``limit_column_ids`` is refused when there is no board to check it against."""

    def setUp(self):
        owner = _make_user()
        self.board = _make_board(owner)
        self.column = _make_column(self.board)

    def test_no_board_and_no_instance_refuses_ids(self):
        with self.assertRaises(serializers.ValidationError):
            SwimlaneSerializer().validate_limit_column_ids([self.column.pk])

    def test_null_still_means_default_without_a_board(self):
        self.assertIsNone(SwimlaneSerializer().validate_limit_column_ids(None))

    def test_board_context_accepts_its_column(self):
        serializer = SwimlaneSerializer(context={"board": self.board})
        self.assertEqual(serializer.validate_limit_column_ids([self.column.pk]), [self.column.pk])


class BoardPermissionClassAbsentSubjectTests(TestCase):
    """Both permission classes deny a subject that is not, and has no, Board."""

    def setUp(self):
        self.owner = _make_user()
        self.board = _make_board(self.owner)
        self.request = SimpleNamespace(user=self.owner)

    def test_object_without_board_is_denied(self):
        for perm in (IsBoardMember(), IsBoardAdminOrOwner()):
            self.assertFalse(perm.has_object_permission(self.request, None, object()))
            self.assertFalse(
                perm.has_object_permission(self.request, None, SimpleNamespace(board=None))
            )

    def test_group_is_not_judged_as_a_board(self):
        """A Group has ``owner_id`` and ``memberships``; it must not pass as a board.

        Under the old ``getattr(obj, "board", obj)`` the group's own owner
        resolved to board ADMIN here.
        """
        group = Group.objects.create(name="G", owner=self.owner)
        GroupMembership.objects.create(group=group, user=self.owner, role=GroupMembership.Role.ADMIN)
        for perm in (IsBoardMember(), IsBoardAdminOrOwner()):
            self.assertFalse(perm.has_object_permission(self.request, None, group))

    def test_board_and_board_child_are_unchanged(self):
        member = _make_user()
        _make_membership(self.board, member, "member")
        child = SimpleNamespace(board=self.board)
        for obj in (self.board, child):
            self.assertTrue(IsBoardMember().has_object_permission(SimpleNamespace(user=member), None, obj))
            self.assertTrue(IsBoardAdminOrOwner().has_object_permission(self.request, None, obj))


class RecipientAdmitsAbsentAttributeTests(SimpleTestCase):
    """An object that is not an invite link raises instead of admitting everyone."""

    def test_object_without_recipient_hash_raises(self):
        with self.assertRaises(AttributeError):
            recipient_admits(object(), SimpleNamespace(email="a@example.com"))
        with self.assertRaises(AttributeError):
            signup_address_admits(object(), "a@example.com")

    def test_verification_helpers_raise_on_a_non_link(self):
        """``grant_awaits_verification`` read a non-link as unbound ("grant now")."""
        with self.assertRaises(AttributeError):
            grant_awaits_verification(object(), SimpleNamespace(email="a@example.com"))
        with self.assertRaises(AttributeError):
            confirmed_address_admits(object(), SimpleNamespace(email="a@example.com", verified=True))

    def test_unverified_address_is_still_refused_on_a_bound_link(self):
        bound = SimpleNamespace(recipient_hash="0" * 64)
        self.assertFalse(
            confirmed_address_admits(bound, SimpleNamespace(email="a@example.com", verified=False))
        )

    def test_unbound_link_still_admits(self):
        unbound = SimpleNamespace(recipient_hash=None)
        self.assertTrue(recipient_admits(unbound, SimpleNamespace(email="a@example.com")))
        self.assertTrue(signup_address_admits(unbound, "a@example.com"))


class BoardMembershipAdminPayloadTests(TestCase):
    """The Django-admin ``member.*`` payload opts in to the unfiltered row (#1075).

    It used to be filtered by the operator's own board role, which has nothing
    to do with who receives the frame; recipients are filtered by the consumer
    and the change feed (Rule 8).
    """

    def test_payload_is_unfiltered_whatever_the_operators_board_role(self):
        from django.contrib.admin.sites import AdminSite
        from boards.admin import BoardMembershipAdmin

        owner = _make_user()
        board = _make_board(owner)
        operator = _make_user(is_staff=True)
        _make_membership(board, operator, "viewer")
        target = _make_user(is_site_admin=True)
        membership = BoardMembership.objects.create(
            board=board, user=target, role=BoardMembership.Role.MEMBER, is_moderator=True,
        )
        request = APIRequestFactory().get("/")
        request.user = operator
        payload = BoardMembershipAdmin(BoardMembership, AdminSite())._payload(membership, request)
        self.assertIs(payload["is_moderator"], True)
        self.assertIs(payload["is_site_admin"], True)


class GroupPredicateAbsentGroupTests(TestCase):
    """The group access predicates deny when there is no group to judge."""

    def test_no_group_denies(self):
        from groups.models import user_has_group_access, user_is_group_admin

        user = _make_user()
        self.assertFalse(user_has_group_access(user, None))
        self.assertFalse(user_is_group_admin(user, None))
