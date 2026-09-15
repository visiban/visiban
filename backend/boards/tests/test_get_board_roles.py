"""``get_board_roles`` must agree with ``get_board_role``, for every rung.

The bulk resolver exists because resolving a role per board is an N+1 on any
board that derives its role from a group — and because re-implementing the
precedence ladder to avoid that N+1 is exactly what happened once already, in
``mcp_server/tools.py::_resolve_roles``, complete with a "must be kept in step
with it" comment (#1107).

So the guarantee worth testing is not "the bulk resolver returns plausible
roles", it is **the two resolvers never disagree**. Every test here asserts
parity rather than a hard-coded expectation, so a change to the ladder that
touches only one of them fails here rather than drifting silently. The one
hard-coded set is the precedence ordering itself, which parity alone would not
catch if both copies were wrong together.
"""
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from accounts.models import User
from boards.models import Board, BoardMembership
from boards.permissions import (
    GROUP_ANCESTOR_SELECT_RELATED, SITE_ADMIN, get_board_role, get_board_roles,
)
from groups.models import Group, GroupMembership


class GetBoardRolesParityTests(TestCase):
    """Each rung of the ladder, resolved both ways, must match."""

    def setUp(self):
        self.owner = User.objects.create_user(username="roles_owner", password="x")
        self.member = User.objects.create_user(username="roles_member", password="x")
        self.viewer = User.objects.create_user(username="roles_viewer", password="x")
        self.outsider = User.objects.create_user(username="roles_outsider", password="x")
        self.site_admin = User.objects.create_user(
            username="roles_siteadmin", password="x", is_site_admin=True,
            can_access_all_content=True,
        )

        # Rung 2/3: an ordinary board with explicit memberships.
        self.plain_board = Board.objects.create(name="Plain", owner=self.owner)
        BoardMembership.objects.create(
            board=self.plain_board, user=self.member, role=BoardMembership.Role.MEMBER,
        )
        BoardMembership.objects.create(
            board=self.plain_board, user=self.viewer, role=BoardMembership.Role.VIEWER,
        )

        # Rung 4: a three-level group chain, with the board on the deepest group.
        self.grandparent = Group.objects.create(name="GP", owner=self.owner)
        self.parent = Group.objects.create(name="P", owner=self.owner, parent=self.grandparent)
        self.child = Group.objects.create(name="C", owner=self.owner, parent=self.parent)
        self.group_board = Board.objects.create(
            name="GroupBoard", owner=self.owner, group=self.child,
        )

        self.near_user = User.objects.create_user(username="roles_near", password="x")
        self.far_user = User.objects.create_user(username="roles_far", password="x")
        GroupMembership.objects.create(
            group=self.child, user=self.near_user, role=BoardMembership.Role.MEMBER,
        )
        GroupMembership.objects.create(
            group=self.grandparent, user=self.far_user, role=BoardMembership.Role.ADMIN,
        )

        self.all_boards = [self.plain_board, self.group_board]

    # ── helpers ───────────────────────────────────────────────────────────

    def _fresh(self, board):
        """Re-load a board the way a request would.

        Both resolvers cache on the instance (``_cached_membership``), and
        ``get_board_roles`` walks ``board.group.parent…`` in memory, so each
        assertion starts from a board loaded with the ancestor chain rather than
        from a shared instance carrying another call's cache.
        """
        return Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).get(pk=board.pk)

    def _assert_parity(self, user, boards):
        """Assert both resolvers agree for *user* across *boards*."""
        singles = {b.pk: get_board_role(user, self._fresh(b)) for b in boards}
        bulk = get_board_roles(user, [self._fresh(b) for b in boards])
        self.assertEqual(
            bulk, singles,
            f"get_board_roles disagreed with get_board_role for {user.username}: "
            f"bulk={bulk} single={singles}",
        )
        return bulk

    # ── the four rungs, as named in the acceptance criteria ───────────────

    def test_parity_for_owner(self):
        roles = self._assert_parity(self.owner, self.all_boards)
        # An owner is implicitly ADMIN on both boards without a membership row
        # on the group board at all.
        self.assertEqual(roles[self.plain_board.pk], BoardMembership.Role.ADMIN)
        self.assertEqual(roles[self.group_board.pk], BoardMembership.Role.ADMIN)

    def test_parity_for_explicit_membership(self):
        roles = self._assert_parity(self.member, self.all_boards)
        self.assertEqual(roles[self.plain_board.pk], BoardMembership.Role.MEMBER)
        # No access to the group board — not a member, not in its groups.
        self.assertIsNone(roles[self.group_board.pk])

    def test_parity_for_viewer_role(self):
        roles = self._assert_parity(self.viewer, self.all_boards)
        self.assertEqual(roles[self.plain_board.pk], BoardMembership.Role.VIEWER)

    def test_parity_for_group_inherited_nearest_ancestor(self):
        roles = self._assert_parity(self.near_user, self.all_boards)
        self.assertEqual(roles[self.group_board.pk], BoardMembership.Role.MEMBER)
        self.assertIsNone(roles[self.plain_board.pk])

    def test_parity_for_group_inherited_distant_ancestor(self):
        """A membership three levels up still confers a role."""
        roles = self._assert_parity(self.far_user, self.all_boards)
        self.assertEqual(roles[self.group_board.pk], BoardMembership.Role.ADMIN)

    def test_parity_for_site_admin(self):
        roles = self._assert_parity(self.site_admin, self.all_boards)
        self.assertEqual(roles[self.plain_board.pk], SITE_ADMIN)
        self.assertEqual(roles[self.group_board.pk], SITE_ADMIN)

    def test_parity_for_user_with_no_access(self):
        roles = self._assert_parity(self.outsider, self.all_boards)
        self.assertIsNone(roles[self.plain_board.pk])
        self.assertIsNone(roles[self.group_board.pk])

    # ── precedence, which parity alone cannot verify ──────────────────────

    def test_site_admin_outranks_an_explicit_lower_membership(self):
        """``can_access_all_content`` wins even against an explicit viewer row.

        Asserted directly, not by parity: if both resolvers got the ordering
        wrong in the same way they would still agree with each other.
        """
        BoardMembership.objects.create(
            board=self.plain_board, user=self.site_admin,
            role=BoardMembership.Role.VIEWER,
        )
        roles = self._assert_parity(self.site_admin, [self.plain_board])
        self.assertEqual(roles[self.plain_board.pk], SITE_ADMIN)

    def test_explicit_membership_outranks_group_inherited(self):
        """An explicit row on the board beats the role the group would confer."""
        GroupMembership.objects.create(
            group=self.child, user=self.member, role=BoardMembership.Role.ADMIN,
        )
        BoardMembership.objects.create(
            board=self.group_board, user=self.member,
            role=BoardMembership.Role.VIEWER,
        )
        roles = self._assert_parity(self.member, [self.group_board])
        self.assertEqual(roles[self.group_board.pk], BoardMembership.Role.VIEWER)

    def test_nearest_group_ancestor_wins(self):
        """With memberships at two levels, the one closest to the board wins."""
        GroupMembership.objects.create(
            group=self.grandparent, user=self.near_user, role=BoardMembership.Role.ADMIN,
        )
        roles = self._assert_parity(self.near_user, [self.group_board])
        # near_user is MEMBER on the child group (nearest) and ADMIN three
        # levels up; the child group decides.
        self.assertEqual(roles[self.group_board.pk], BoardMembership.Role.MEMBER)

    def test_owner_outranks_an_explicit_lower_membership(self):
        BoardMembership.objects.filter(
            board=self.plain_board, user=self.owner,
        ).delete()
        BoardMembership.objects.create(
            board=self.plain_board, user=self.owner, role=BoardMembership.Role.VIEWER,
        )
        roles = self._assert_parity(self.owner, [self.plain_board])
        self.assertEqual(roles[self.plain_board.pk], BoardMembership.Role.ADMIN)

    # ── the N+1 the function exists to remove ─────────────────────────────

    def test_query_count_is_constant_across_board_count(self):
        """Two queries for the whole batch, however many boards there are.

        This is the property the MCP fork was written to get; if it regresses,
        every caller silently goes back to a per-board lookup.
        """
        def _resolve(n):
            boards = list(
                Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED)
                .filter(pk__in=[b.pk for b in self.all_boards])
            )
            extra = []
            for i in range(n):
                extra.append(Board.objects.create(
                    name=f"extra{i}", owner=self.owner, group=self.child,
                ))
            ids = [b.pk for b in self.all_boards] + [b.pk for b in extra]
            boards = list(
                Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED)
                .filter(pk__in=ids)
            )
            with CaptureQueriesContext(connection) as ctx:
                get_board_roles(self.near_user, boards)
            return len(ctx)

        few = _resolve(1)
        many = _resolve(25)
        self.assertEqual(
            few, many,
            f"get_board_roles issued {few} queries for a small batch and {many} for a "
            "large one — the bulk resolver regressed to a per-board lookup.",
        )
        self.assertLessEqual(
            many, 2,
            f"get_board_roles issued {many} queries; it must need at most two "
            "(board memberships, then group memberships).",
        )

    def test_site_admin_needs_no_membership_queries_at_all(self):
        boards = list(
            Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).all()
        )
        with CaptureQueriesContext(connection) as ctx:
            roles = get_board_roles(self.site_admin, boards)
        self.assertEqual(len(ctx), 0)
        self.assertTrue(all(r == SITE_ADMIN for r in roles.values()))

    # ── shape contract ────────────────────────────────────────────────────

    def test_every_board_gets_a_key_even_with_no_access(self):
        """A missing key and a None value must not be confused — callers filter
        on the value, so an absent key would raise instead of skipping."""
        roles = get_board_roles(self.outsider, [self._fresh(b) for b in self.all_boards])
        self.assertEqual(set(roles), {self.plain_board.pk, self.group_board.pk})

    def test_empty_input_returns_empty_dict_without_querying(self):
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(get_board_roles(self.owner, []), {})
        self.assertEqual(len(ctx), 0)

    def test_accepts_any_iterable_not_only_a_list(self):
        qs = Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).filter(
            pk=self.plain_board.pk
        )
        self.assertEqual(
            get_board_roles(self.member, qs),
            {self.plain_board.pk: BoardMembership.Role.MEMBER},
        )

    def test_roles_are_never_read_from_another_users_rows(self):
        """Both batched lookups are filtered to the user before use.

        A membership belonging to somebody else on the same board must not leak
        into the caller's role.
        """
        roles = get_board_roles(
            self.outsider, [self._fresh(self.plain_board)],
        )
        self.assertIsNone(roles[self.plain_board.pk])
