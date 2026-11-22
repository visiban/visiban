"""``parents_for_viewer`` joins ONE group-ancestor chain per statement (#2536).

#2443 added a second seven-level ``child__board__group__parent__...`` chain to
the links query, beside the parent board's, so one statement joined the
``groups`` table fourteen times (~20 relations). The query COUNT stayed flat,
which is why the #1104/#2443 query-count pins passed; only the SHAPE grew, and
``backend-test`` shard 1 hung inside that statement. These tests pin the shape:
no statement a parent read issues joins more than one ancestor chain, and the
child board's chain, now loaded by its own query, still resolves a role that
reaches the viewer only through a group ancestor.
"""

import re
from unittest import mock

from django.contrib.auth.models import AnonymousUser
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from boards.models import Board, BoardMembership, CardParentLink
from boards.permissions import _GROUP_TRAVERSAL_MAX_DEPTH, GROUP_ANCESTOR_SELECT_RELATED
from boards.services import card_links
from boards.tests.test_card_parent_links import Role, _LinkFixture
from groups.models import Group, GroupMembership

#: One chain is ``board.group`` plus ``_GROUP_TRAVERSAL_MAX_DEPTH`` parents.
ONE_CHAIN = _GROUP_TRAVERSAL_MAX_DEPTH + 1


def _group_joins(sql):
    return len(re.findall(rf'JOIN "{re.escape(Group._meta.db_table)}"', sql))


class ParentsForViewerQueryShapeTests(_LinkFixture, TestCase):
    def setUp(self):
        self._setup_boards()
        # The child board sits two groups deep; the viewer's only role on it is
        # inherited from the TOP group, so resolving it needs the child board's
        # whole ancestor chain loaded.
        top = Group.objects.create(name="Top 2536", owner=self.owner)
        sub = Group.objects.create(name="Sub 2536", owner=self.owner, parent=top)
        Board.objects.filter(pk=self.cboard.pk).update(group=sub)
        self.viewer = self._user("shape_2536", parent_role=Role.VIEWER)
        GroupMembership.objects.create(group=top, user=self.viewer, role=GroupMembership.Role.MEMBER)
        CardParentLink.objects.create(parent=self.parent, child=self.child, created_by=self.owner)

    def _assert_one_chain_per_statement(self, ctx):
        for q in ctx.captured_queries:
            self.assertLessEqual(
                _group_joins(q["sql"]), ONE_CHAIN,
                "a statement joins more than one group-ancestor chain (#2536): load the second "
                f"board set with its own select_related(GROUP_ANCESTOR_SELECT_RELATED) query.\n{q['sql']}",
            )

    def test_no_statement_joins_two_ancestor_chains(self):
        with CaptureQueriesContext(connection) as ctx:
            out = card_links.parents_for_viewer([self.child.pk], self.viewer)
        self._assert_one_chain_per_statement(ctx)
        # The links query still carries exactly the parent board's chain.
        links_sql = [q["sql"] for q in ctx.captured_queries if CardParentLink._meta.db_table in q["sql"]][0]
        self.assertEqual(_group_joins(links_sql), ONE_CHAIN)
        # Behavior is unchanged: visible parent, siblings counted on the child's
        # board because the group-inherited role there resolved.
        self.assertFalse(out[self.child.pk]["hidden"])
        self.assertEqual((out[self.child.pk]["siblings_total"], out[self.child.pk]["siblings_done"]), (1, 0))
        # links + the child board's own query + get_board_roles' two + one
        # sibling count; no lazy ancestor fetches.
        self.assertEqual(len(ctx), 5, [q["sql"][:120] for q in ctx.captured_queries])

    def test_a_known_board_saves_the_child_board_query(self):
        cboard = Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).get(pk=self.cboard.pk)
        with CaptureQueriesContext(connection) as ctx:
            out = card_links.parents_for_viewer([self.child.pk], self.viewer, known_boards=(cboard,))
        self.assertEqual(len(ctx), 4)
        self.assertEqual(out[self.child.pk]["siblings_total"], 1)

    def test_a_known_board_no_child_sits_on_is_ignored(self):
        """A hint never adds a board to the role batch, so it cannot change an answer.

        The viewer holds a role on a THIRD board (neither the parent's nor the
        child's) and none on the child's board; handing that third board in as
        a hint must neither resolve a role for it nor turn the null sibling
        counts into numbers.
        """
        third = Board.objects.create(name="Third 2536", owner=self.owner)
        stranger = self._user("shape_2536_none", parent_role=Role.VIEWER)
        BoardMembership.objects.create(board=third, user=stranger, role=Role.ADMIN)
        hint = Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).get(pk=third.pk)
        seen = []
        real = card_links.get_board_roles

        def spy(user, boards):
            boards = list(boards)
            seen.extend(b.pk for b in boards)
            return real(user, boards)

        with mock.patch.object(card_links, "get_board_roles", spy):
            out = card_links.parents_for_viewer([self.child.pk], stranger, known_boards=(hint,))
        self.assertNotIn(third.pk, seen)
        self.assertCountEqual(seen, [self.pboard.pk, self.cboard.pk])
        self.assertFalse(out[self.child.pk]["hidden"])
        self.assertIsNone(out[self.child.pk]["siblings_total"])
        self.assertIsNone(out[self.child.pk]["siblings_done"])

    def test_a_child_board_gone_between_the_reads_fails_closed(self):
        """The child-board query finding nothing leaves null counts, never an error or a count."""
        empty = mock.MagicMock()
        empty.objects.select_related.return_value.filter.return_value = []
        with mock.patch.object(card_links, "Board", empty):
            out = card_links.parents_for_viewer([self.child.pk], self.viewer)
        self.assertFalse(out[self.child.pk]["hidden"])
        self.assertIsNone(out[self.child.pk]["siblings_total"])
        self.assertIsNone(out[self.child.pk]["siblings_done"])

    def test_absent_user_fails_closed_without_resolving_boards(self):
        """#1075: no viewer (None or anonymous) means every entry hidden, and only the links query runs."""
        for user in (None, AnonymousUser()):
            with self.subTest(user=user), CaptureQueriesContext(connection) as ctx:
                out = card_links.parents_for_viewer([self.child.pk], user, known_boards=(self.cboard,))
            self.assertEqual(out, {self.child.pk: {"hidden": True}})
            self.assertEqual(len(ctx), 1)

    def test_full_read_joins_one_chain_per_statement(self):
        """The whole ``/full/`` read the issue hung in, not only the helper."""
        with CaptureQueriesContext(connection) as ctx:
            res = self._client(self.viewer).get(f"/api/v1/boards/{self.cboard.pk}/full/")
        self.assertEqual(res.status_code, 200, res.content)
        self._assert_one_chain_per_statement(ctx)
        parent = {c["id"]: c for c in res.json()["cards"]}[self.child.pk]["parent"]
        self.assertEqual(parent["siblings_total"], 1)
