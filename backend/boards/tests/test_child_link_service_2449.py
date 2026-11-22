"""Child-link service follow-ups for 1.3 (#2447, #2443, #2449).

* #2447: no new child under an ARCHIVED parent, on both writes (``create_link``
  and Add child's ``create_child``), with the coded 400 ``parent_archived``;
  re-saving the link a child already has keeps answering ``link_exists``.
  The parent-side pickers say so before the write does.
* #2443: ``Card.parent`` carries ``siblings_total`` / ``siblings_done`` for a
  visible parent, counted per viewer over the child's own board only, and
  nothing for a hidden parent.
* #2449: the two options lists are capped at ``CHILD_BOARD_OPTIONS_LIMIT``
  with ``boards_total``. Their query-count pins live in ``test_query_counts``.
"""
from unittest.mock import patch

from django.utils import timezone

from boards.models import BoardMembership, Card, CardParentLink, Column
from boards.services import card_links
from boards.tests.test_default_child_board_2208 import (
    PATCH_BROADCAST,
    AddChildFixture,
    add_card,
    client_for,
    make_board,
)

Role = BoardMembership.Role


def _archive(card):
    Card.objects.filter(pk=card.pk).update(archived_at=timezone.now())
    card.refresh_from_db()


class ArchivedParentWriteTests(AddChildFixture):
    """#2447: both write paths refuse an archived parent with one code."""

    def link(self, user, child, parent):
        with patch(PATCH_BROADCAST):
            return client_for(user).post(
                f"/api/v1/boards/{child.board_id}/cards/{child.pk}/parent/",
                {"parent_id": parent.pk}, format="json",
            )

    def test_link_to_an_archived_parent_is_a_coded_400(self):
        child = add_card(self.child, "Task")
        _archive(self.parent_card)
        r = self.link(self.member, child, self.parent_card)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["code"], "parent_archived")
        self.assertFalse(CardParentLink.objects.exists())

    def test_add_child_under_an_archived_parent_is_a_coded_400_and_creates_nothing(self):
        _archive(self.parent_card)
        r = self.add_child(self.member)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["code"], "parent_archived")
        self.assertFalse(Card.objects.filter(board=self.child).exists())

    def test_live_parent_still_links(self):
        child = add_card(self.child, "Task")
        self.assertEqual(self.link(self.member, child, self.parent_card).status_code, 201)

    def test_re_saving_an_existing_link_is_not_refused_as_archived(self):
        """The exception: a child already linked to it keeps its link and its old answer."""
        child = add_card(self.child, "Task")
        CardParentLink.objects.create(parent=self.parent_card, child=child, created_by=self.admin)
        _archive(self.parent_card)
        r = self.link(self.member, child, self.parent_card)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "link_exists")
        self.assertTrue(CardParentLink.objects.filter(parent=self.parent_card, child=child).exists())

    def test_restoring_the_parent_lifts_the_refusal(self):
        _archive(self.parent_card)
        self.assertEqual(self.add_child(self.member).json()["code"], "parent_archived")
        Card.objects.filter(pk=self.parent_card.pk).update(archived_at=None)
        self.assertEqual(self.add_child(self.member).status_code, 201)


class ArchivedParentPickerTests(AddChildFixture):
    """#2447: the pickers name the refusal before the write does."""

    def test_child_board_options_disabled_reason(self):
        url = f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/"
        self.assertIsNone(client_for(self.member).get(url).json()["disabled_reason"])
        _archive(self.parent_card)
        self.assertEqual(client_for(self.member).get(url).json()["disabled_reason"], "parent_archived")

    def test_child_candidates_disabled_reason_keeps_the_link_codes_first(self):
        linked = add_card(self.child, "Linked task")
        free = add_card(self.child, "Free task")
        CardParentLink.objects.create(parent=self.parent_card, child=linked, created_by=self.admin)
        _archive(self.parent_card)
        rows = card_links.child_candidates_for_viewer(self.member, self.parent_card, self.child, "task")
        reasons = {r["id"]: r["disabled_reason"] for r in rows}
        self.assertEqual(reasons, {linked.pk: "link_exists", free.pk: "parent_archived"})


class SiblingCountTests(AddChildFixture):
    """#2443: ``Card.parent.siblings_total`` / ``siblings_done``, per viewer."""

    def setUp(self):
        super().setUp()
        done = Column.objects.get(board=self.child, name="Done")
        Column.objects.filter(pk=done.pk).update(is_done=True)
        lane = self.child.swimlanes.first()
        todo = self.child.columns.order_by("position").first()
        self.kids = [add_card(self.child, f"k{i}") for i in range(3)]
        self.kids.append(Card.objects.create(board=self.child, column=done, swimlane=lane, title="done"))
        archived = Card.objects.create(board=self.child, column=todo, swimlane=lane, title="gone")
        self.kids.append(archived)
        for k in self.kids:
            CardParentLink.objects.create(parent=self.parent_card, child=k, created_by=self.admin)
        _archive(archived)

    def parent_of(self, user, card):
        r = client_for(user).get(f"/api/v1/boards/{self.child.pk}/full/")
        self.assertEqual(r.status_code, 200, r.content)
        return {c["id"]: c for c in r.json()["cards"]}[card.pk]["parent"]

    def test_counts_live_siblings_on_this_board_including_the_card(self):
        p = self.parent_of(self.member, self.kids[0])
        self.assertEqual((p["siblings_total"], p["siblings_done"]), (4, 1))

    def test_hidden_parent_carries_no_sibling_data(self):
        outsider = self.user_with("sib_out", child=Role.MEMBER)
        self.assertEqual(self.parent_of(outsider, self.kids[0]), {"hidden": True})

    def test_a_child_on_another_board_is_never_counted(self):
        """One child board per parent has no DB constraint: count only this board."""
        stray_board = make_board(self.admin, "Stray")
        stray = add_card(stray_board, "stray")
        CardParentLink.objects.create(parent=self.parent_card, child=stray, created_by=self.admin)
        self.assertEqual(self.parent_of(self.member, self.kids[0])["siblings_total"], 4)

    def test_no_role_on_the_child_board_gives_null_counts(self):
        """Absent input (#1075): the child's own board unresolved -> nothing counted."""
        parent_only = self.user_with("sib_po", parent=Role.MEMBER)
        out = card_links.parents_for_viewer([self.kids[0].pk], parent_only)[self.kids[0].pk]
        self.assertFalse(out["hidden"])
        self.assertIsNone(out["siblings_total"])
        self.assertIsNone(out["siblings_done"])

    def test_no_viewer_is_hidden_without_counts(self):
        out = card_links.parents_for_viewer([self.kids[0].pk], None)
        self.assertEqual(out, {self.kids[0].pk: {"hidden": True}})

    def test_counts_are_clamped_to_the_children_cap(self):
        lane = self.child.swimlanes.first()
        col = self.child.columns.order_by("position").first()
        extra = Card.objects.bulk_create([
            Card(board=self.child, column=col, swimlane=lane, title=f"x{i}", position=i)
            for i in range(card_links.CHILDREN_PER_PARENT_LIMIT)
        ])
        CardParentLink.objects.bulk_create([CardParentLink(parent=self.parent_card, child=k) for k in extra])
        out = card_links.parents_for_viewer([self.kids[0].pk], self.member)[self.kids[0].pk]
        self.assertEqual(out["siblings_total"], card_links.CHILDREN_PER_PARENT_LIMIT)


class OptionsListCapTests(AddChildFixture):
    """#2449: both options lists stop at the cap and report the full total."""

    def setUp(self):
        super().setUp()
        for name in ("Delivery 2", "Delivery 3"):
            b = make_board(self.admin, name)
            BoardMembership.objects.create(board=b, user=self.admin, role=Role.ADMIN)

    def test_add_child_options_are_capped_and_keep_the_default(self):
        # The default sorts last by name, beyond the page: still resolved.
        last = make_board(self.admin, "Zeta")
        BoardMembership.objects.create(board=last, user=self.admin, role=Role.ADMIN)
        type(self.parent).objects.filter(pk=self.parent.pk).update(default_child_board=last)
        with patch.object(card_links, "CHILD_BOARD_OPTIONS_LIMIT", 2):
            out = client_for(self.admin).get(
                f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/",
            ).json()
        self.assertEqual(len(out["boards"]), 2)
        self.assertEqual(out["boards_total"], 4)
        self.assertEqual(out["default"], {"id": last.pk, "name": "Zeta"})

    def test_default_child_board_options_are_capped(self):
        with patch.object(card_links, "CHILD_BOARD_OPTIONS_LIMIT", 2):
            out = client_for(self.admin).get(
                f"/api/v1/boards/{self.parent.pk}/default-child-board-options/",
            ).json()
        self.assertEqual(len(out["boards"]), 2)
        self.assertEqual(out["boards_total"], 3)

    def test_no_viewer_gets_an_empty_total(self):
        out = card_links.child_board_options_for_viewer(self.parent_card, None)
        self.assertEqual((out["boards"], out["boards_total"]), ([], 0))
        out = card_links.default_child_board_options_for_admin(self.parent, None)
        self.assertEqual(out, {"boards": [], "boards_total": 0})

    def test_boards_total_counts_only_boards_the_caller_may_use(self):
        """A board below the needed role is neither listed nor counted (rbac-check, #2449)."""
        other = self.user_with("cap_other")
        viewer_only = make_board(other, "Viewer only")
        member_only = make_board(other, "Member only")
        BoardMembership.objects.create(board=viewer_only, user=self.admin, role=Role.VIEWER)
        BoardMembership.objects.create(board=member_only, user=self.admin, role=Role.MEMBER)
        add = client_for(self.admin).get(
            f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/",
        ).json()
        names = {b["name"] for b in add["boards"]}
        self.assertNotIn("Viewer only", names)
        self.assertIn("Member only", names)  # member is enough for Add child
        self.assertEqual(add["boards_total"], len(add["boards"]))
        default = client_for(self.admin).get(
            f"/api/v1/boards/{self.parent.pk}/default-child-board-options/",
        ).json()
        names = {b["name"] for b in default["boards"]}
        self.assertFalse({"Viewer only", "Member only"} & names)  # a default needs admin
        self.assertEqual(default["boards_total"], len(default["boards"]))

    def test_no_role_on_the_parent_board_or_below_admin_gets_an_empty_total(self):
        """#1075: a caller the guard cannot authorize gets nothing, not the full count."""
        outsider = self.user_with("cap_out", child=Role.ADMIN)
        out = card_links.child_board_options_for_viewer(self.parent_card, outsider)
        self.assertEqual((out["boards"], out["boards_total"]), ([], 0))
        member = self.user_with("cap_mem", parent=Role.MEMBER, child=Role.ADMIN)
        out = card_links.default_child_board_options_for_admin(self.parent, member)
        self.assertEqual(out, {"boards": [], "boards_total": 0})
