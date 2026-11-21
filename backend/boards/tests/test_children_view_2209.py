"""Parent-side card links (#2209): the Children tab's read and Link existing.

The children read gained what the scoped board draws (assignee, blocked,
position, and the child board's columns with whole-column counts and the
viewer's role there). Link existing searches the parent's one child board.
Both cross the #1104 authorization boundary, so the tests are mostly about
what a viewer without the child board's role is never sent.
"""

from django.utils import timezone

from boards.models import BoardMembership, Card, CardParentLink, CardRelation
from boards.serializers import ChildCandidateSerializer
from boards.tests.conftest import _make_card, _make_column, _make_user
from boards.tests.test_card_parent_links import _board_with_card, _count_queries, _LinkFixture
from django.test import TestCase

Role = BoardMembership.Role


class ChildrenLensReadTests(_LinkFixture, TestCase):
    def setUp(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        self.url = f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/children/"

    def test_visible_read_carries_the_lens_fields(self):
        self.col_c.wip_limit = 4
        self.col_c.save()
        Card.objects.filter(pk=self.child.pk).update(assignee=self.owner)
        # A non-child card in the same column counts toward the whole column.
        _make_card(self.col_c, self.lane_c, title="Unrelated SECRET-U")
        u = self._user("cv_both", parent_role=Role.VIEWER, child_role=Role.MEMBER)
        body = self._client(u).get(self.url).json()
        row = body["results"][0]
        self.assertEqual(row["assignee"]["id"], self.owner.pk)
        self.assertFalse(row["blocked"])
        self.assertIsNone(row["blocked_at"])
        self.assertIn("position", row)
        self.assertEqual(body["board"]["id"], self.cboard.pk)
        self.assertEqual(body["board"]["name"], self.cboard.name)
        self.assertEqual(body["board"]["role"], Role.MEMBER)
        col = body["board"]["columns"][0]
        self.assertEqual(col["id"], self.col_c.pk)
        self.assertEqual(col["wip_limit"], 4)
        self.assertEqual(col["card_count"], 2)
        self.assertEqual(set(col), {"id", "name", "color", "wip_limit", "is_done", "card_count"})

    def test_blocked_is_manual_or_an_active_relation(self):
        blocker = _make_card(self.col_c, self.lane_c, title="Blocker")
        CardRelation.objects.create(
            from_card=blocker, to_card=self.child, relation_type=CardRelation.Type.BLOCKS,
        )
        u = self._user("cv_blk", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        client = self._client(u)
        self.assertTrue(client.get(self.url).json()["results"][0]["blocked"])
        CardRelation.objects.all().delete()
        now = timezone.now()
        Card.objects.filter(pk=self.child.pk).update(blocked_at=now)
        row = client.get(self.url).json()["results"][0]
        self.assertTrue(row["blocked"])
        self.assertIsNotNone(row["blocked_at"])

    def test_hidden_read_still_carries_no_board(self):
        u = self._user("cv_ponly", parent_role=Role.MEMBER)
        res = self._client(u).get(self.url)
        self.assertNotIn("board", res.json())
        self.assertNotIn(self.cboard.name, res.content.decode())

    def test_query_count_stays_flat_with_blocked_and_assigned_children(self):
        u = self._user("cv_perf", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        client = self._client(u)
        one = _count_queries(client, self.url)
        extra_col = _make_column(self.cboard, name="Doing", order=1)
        for i in range(8):
            c = _make_card(extra_col, self.lane_c, title=f"n{i}")
            Card.objects.filter(pk=c.pk).update(assignee=self.owner)
            CardRelation.objects.create(from_card=self.child, to_card=c, relation_type=CardRelation.Type.BLOCKS)
            CardParentLink.objects.create(parent=self.parent, child=c)
        self.assertEqual(_count_queries(client, self.url), one)


class ChildCandidateTests(_LinkFixture, TestCase):
    def setUp(self):
        self._setup_boards()
        self.member = self._user("cc_member", parent_role=Role.MEMBER, child_role=Role.MEMBER)
        self.url = f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/child-candidates/"

    def _get(self, user=None, **params):
        return self._client(user or self.member).get(self.url, params)

    def _results(self, **params):
        res = self._get(**params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["results"]

    def test_shape_and_an_enabled_row(self):
        rows = self._results(board=self.cboard.pk, search="secret-c")
        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]), set(ChildCandidateSerializer().fields))
        self.assertIsNone(rows[0]["disabled_reason"])
        self.assertIsNone(rows[0]["parent_title"])

    def test_short_search_returns_nothing(self):
        for search in ("", " ", "T"):
            self.assertEqual(self._results(board=self.cboard.pk, search=search), [])

    def test_already_this_parents_child_is_link_exists(self):
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        row = self._results(board=self.cboard.pk, search="secret-c")[0]
        self.assertEqual(row["disabled_reason"], "link_exists")

    def test_other_parent_named_only_when_its_board_is_open(self):
        other_pboard, other_parent = _board_with_card(
            _make_user("cc_stranger"), parent_tier=True, name="Hidden P", title="Other SECRET-O",
        )
        CardParentLink.objects.create(parent=other_parent, child=self.child)
        res = self._get(board=self.cboard.pk, search="secret-c")
        row = res.json()["results"][0]
        self.assertEqual(row["disabled_reason"], "already_has_parent")
        self.assertIsNone(row["parent_title"])
        self.assertNotIn("SECRET-O", res.content.decode())
        BoardMembership.objects.create(board=other_pboard, user=self.member, role=Role.VIEWER)
        row = self._results(board=self.cboard.pk, search="secret-c")[0]
        self.assertEqual(row["parent_title"], "Other SECRET-O")

    def test_full_parent_disables_every_row(self):
        for i in range(100):
            CardParentLink.objects.create(
                parent=self.parent, child=_make_card(self.col_c, self.lane_c, title=f"fill {i}"),
            )
        row = self._results(board=self.cboard.pk, search="secret-c")[0]
        self.assertEqual(row["disabled_reason"], "children_limit")

    def test_every_board_refusal_is_one_404(self):
        hidden_board, _ = _board_with_card(
            _make_user("cc_other"), parent_tier=False, name="Hidden C", title="H",
        )
        viewer_board, _ = _board_with_card(self.owner, parent_tier=False, name="Viewer C", title="V")
        BoardMembership.objects.create(board=viewer_board, user=self.member, role=Role.VIEWER)
        collab_board, _ = _board_with_card(self.owner, parent_tier=False, name="Collab C", title="C")
        BoardMembership.objects.create(board=collab_board, user=self.member, role=Role.COLLABORATOR)
        parent_tier, _ = _board_with_card(self.owner, parent_tier=True, name="Tier P", title="P")
        BoardMembership.objects.create(board=parent_tier, user=self.member, role=Role.MEMBER)
        bodies = set()
        for board_id in (hidden_board.pk, hidden_board.pk + 10_000, viewer_board.pk, collab_board.pk, parent_tier.pk, self.pboard.pk):
            res = self._get(board=board_id, search="ab")
            self.assertEqual(res.status_code, 404, board_id)
            bodies.add(res.content)
        self.assertEqual(len(bodies), 1)

    def test_parent_with_children_searches_only_their_board(self):
        second, _ = _board_with_card(self.owner, parent_tier=False, name="Second C", title="S")
        BoardMembership.objects.create(board=second, user=self.member, role=Role.MEMBER)
        self.assertEqual(self._get(board=second.pk, search="ab").status_code, 200)
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        self.assertEqual(self._get(board=second.pk, search="ab").status_code, 404)
        self.assertEqual(self._get(board=self.cboard.pk, search="ab").status_code, 200)

    def test_below_member_on_the_parent_board_is_403(self):
        for role in (Role.VIEWER, Role.COLLABORATOR):
            u = self._user(f"cc_{role}", parent_role=role, child_role=Role.MEMBER)
            self.assertEqual(self._get(u, board=self.cboard.pk, search="ab").status_code, 403)

    def test_no_access_to_the_parent_board_is_404(self):
        u = self._user("cc_conly", child_role=Role.ADMIN)
        self.assertEqual(self._get(u, board=self.cboard.pk, search="ab").status_code, 404)

    def test_bad_board_param_is_the_coded_400(self):
        for raw in ("", "abc", "-1", "1" * 19):
            res = self._get(board=raw, search="ab")
            self.assertEqual(res.status_code, 400, raw)
            self.assertEqual(res.json()["code"], "invalid_query_param")

    def test_search_from_a_child_tier_card_is_404(self):
        # Link existing exists only on a parent tier; from a child card the
        # child board is the card's own board, which is the one 404.
        url = f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/child-candidates/"
        res = self._client(self.member).get(url, {"board": self.cboard.pk, "search": "secret"})
        self.assertEqual(res.status_code, 404)

    def test_linking_a_candidate_goes_through_the_child_boards_link_write(self):
        row = self._results(board=self.cboard.pk, search="secret-c")[0]
        res = self._link(self._client(self.member), parent_id=self.parent.pk)
        self.assertEqual(res.status_code, 201)
        self.assertEqual(row["id"], self.child.pk)
        row = self._results(board=self.cboard.pk, search="secret-c")[0]
        self.assertEqual(row["disabled_reason"], "link_exists")

    def test_admin_and_site_admin_may_search(self):
        admin = self._user("cc_admin", parent_role=Role.ADMIN, child_role=Role.ADMIN)
        self.assertEqual(self._get(admin, board=self.cboard.pk, search="secret").status_code, 200)
        site_admin = _make_user("cc_site")
        site_admin.is_site_admin = True
        site_admin.can_access_all_content = True
        site_admin.save()
        self.assertEqual(self._get(site_admin, board=self.cboard.pk, search="secret").status_code, 200)

    def test_card_from_another_board_under_this_url_is_404(self):
        url = f"/api/v1/boards/{self.pboard.pk}/cards/{self.child.pk}/child-candidates/"
        res = self._client(self.member).get(url, {"board": "abc"})
        self.assertEqual(res.status_code, 404)


class ChildrenLensRoleTests(_LinkFixture, TestCase):
    """``board.role`` is the viewer's own role on the child board; the UI gates Move on it alone."""

    def setUp(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        self.url = f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/children/"

    def test_role_is_the_child_board_role(self):
        for i, (prole, crole) in enumerate([
            (Role.VIEWER, Role.MEMBER), (Role.MEMBER, Role.VIEWER), (Role.MEMBER, Role.ADMIN),
            (Role.ADMIN, Role.COLLABORATOR),
        ]):
            u = self._user(f"cr_{i}", parent_role=prole, child_role=crole)
            self.assertEqual(self._client(u).get(self.url).json()["board"]["role"], crole)

    def test_parent_member_who_only_views_the_child_board_may_unlink(self):
        # The parent side's Unlink needs member on the parent board and any
        # role on the child board (#1104), so the tab offers it to this user.
        u = self._user("cr_unlink", parent_role=Role.MEMBER, child_role=Role.VIEWER)
        res = self._client(u).delete(f"{self.url}{self.child.pk}/")
        self.assertEqual(res.status_code, 204)
        self.assertFalse(CardParentLink.objects.exists())
