"""History's Parent filter (#2209, #2499): ``GET /boards/{id}/movements/?parent_id=``.

"Movement history of these children" opens the child board's History with
Parent = the parent card. The parent sits on another board, so the filter
crosses the #1104 boundary: a parent the caller cannot open must answer
exactly like a parent with no children here (absent-input rule, #1075).
"""

from django.test import TestCase

from boards.models import BoardMembership, CardMovement, CardParentLink
from boards.tests.conftest import _make_card
from boards.tests.test_card_parent_links import _LinkFixture

Role = BoardMembership.Role


def _make_board_parent(owner, name):
    from boards.tests.test_card_parent_links import _board_with_card

    board, card = _board_with_card(owner, parent_tier=True, name=name, title=f"{name} card")
    return board, card


class MovementsParentFilterTests(_LinkFixture, TestCase):
    def setUp(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        self.other = _make_card(self.col_c, self.lane_c, title="Not a child")
        for card in (self.child, self.other):
            CardMovement.objects.create(
                card=card, board=self.cboard, to_column=self.col_c, to_column_name=self.col_c.name,
                to_swimlane=self.lane_c, to_swimlane_name=self.lane_c.name,
                movement_type=CardMovement.MovementType.MOVE,
            )
        self.url = f"/api/v1/boards/{self.cboard.pk}/movements/"

    def _ids(self, user, parent_id):
        r = self._client(user).get(self.url, {"parent_id": parent_id})
        self.assertEqual(r.status_code, 200, r.content)
        return {m["card_uid"] for m in r.json()["results"]}, r.json()["count"]

    def test_filters_to_the_children_of_an_openable_parent(self):
        u = self._user("mpf_both", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        uids, count = self._ids(u, self.parent.pk)
        self.assertEqual(uids, {self.child.uid})
        self.assertEqual(count, 1)
        # Without the param, History is unfiltered.
        all_rows = self._client(u).get(self.url).json()["count"]
        self.assertGreaterEqual(all_rows, 2)

    def test_unopenable_parent_answers_like_a_missing_one(self):
        u = self._user("mpf_child_only", child_role=Role.VIEWER)
        hidden = self._ids(u, self.parent.pk)
        missing = self._ids(u, 987654321)
        self.assertEqual(hidden, (set(), 0))
        self.assertEqual(hidden, missing)

    def test_rejects_a_non_integer_parent_id(self):
        u = self._user("mpf_bad", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        r = self._client(u).get(self.url, {"parent_id": "abc"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "invalid_query_param")

    def test_hidden_parent_matches_an_openable_parent_with_no_children(self):
        """No oracle: "hidden, has children here" and "openable, no children here" are one answer."""
        # An openable parent on the same board as the caller's access, with no children linked.
        _, childless = _make_board_parent(self.owner, "Childless portfolio")
        u = self._user("mpf_oracle", child_role=Role.VIEWER)
        BoardMembership.objects.create(board=childless.board, user=u, role=Role.VIEWER)
        hidden = self._ids(u, self.parent.pk)  # parent has a child here, but u cannot open it
        no_children = self._ids(u, childless.pk)  # u can open it, nothing links to it
        self.assertEqual(hidden, (set(), 0))
        self.assertEqual(hidden, no_children)
        # Raw bodies match too, so no other field (next/previous/etc.) differs.
        a = self._client(u).get(self.url, {"parent_id": self.parent.pk}).json()
        b = self._client(u).get(self.url, {"parent_id": childless.pk}).json()
        self.assertEqual(a, b)

    def test_parent_board_reached_through_a_group_role_filters(self):
        from groups.models import Group, GroupMembership

        group = Group.objects.create(name="Portfolio group", owner=self.owner)
        self.pboard.group = group
        self.pboard.save(update_fields=["group"])
        u = self._user("mpf_group", child_role=Role.VIEWER)
        GroupMembership.objects.create(group=group, user=u, role=GroupMembership.Role.VIEWER)
        self.assertEqual(self._ids(u, self.parent.pk), ({self.child.uid}, 1))

    def test_group_role_on_an_unrelated_group_does_not_open_the_parent(self):
        from groups.models import Group, GroupMembership

        other_group = Group.objects.create(name="Unrelated group", owner=self.owner)
        u = self._user("mpf_group_other", child_role=Role.VIEWER)
        GroupMembership.objects.create(group=other_group, user=u, role=GroupMembership.Role.ADMIN)
        self.assertEqual(self._ids(u, self.parent.pk), (set(), 0))

    def test_site_admin_who_is_not_a_member_cannot_open_the_parent(self):
        # is_site_admin alone gates /api/admin/* only; it grants no board access, so the parent
        # stays hidden. (can_access_all_content is what opens every board; see below.)
        u = self._user("mpf_site", child_role=Role.VIEWER)
        u.is_site_admin = True
        u.save(update_fields=["is_site_admin"])
        self.assertEqual(self._ids(u, self.parent.pk), (set(), 0))

    def test_can_access_all_content_user_opens_any_parent(self):
        u = self._user("mpf_all", child_role=Role.VIEWER)
        u.can_access_all_content = True
        u.save(update_fields=["can_access_all_content"])
        self.assertEqual(self._ids(u, self.parent.pk), ({self.child.uid}, 1))

    def test_deleted_parent_board_answers_like_a_missing_parent(self):
        u = self._user("mpf_deleted", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        parent_pk = self.parent.pk
        self.assertEqual(self._ids(u, parent_pk)[1], 1)
        self.pboard.delete()  # cascades the parent card and its link
        deleted = self._ids(u, parent_pk)
        self.assertEqual(deleted, (set(), 0))
        self.assertEqual(deleted, self._ids(u, 987654321))
