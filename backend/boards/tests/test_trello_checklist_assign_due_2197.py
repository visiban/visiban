"""Trello import maps a checkItem's ``due`` and ``idMember`` (#2197).

The member goes through the same scoped match as card members
(``match_members``, security invariants Rule 5) and, like a card assignee,
is only set when ``add_matched_members`` makes the user a board member.
Anyone else imports unassigned.
"""
import datetime
import json

from accounts.models import User
from boards.models import Board, BoardMembership, CardChecklist, Notification
from boards.tests.test_trello_import import TrelloImportBase, load_fixture

ADA = "m000000000000000000000001"       # username "ada": visible to the importer below
GRACE = "m000000000000000000000002"     # "grace_trello": no such user
OUTSIDER = "m000000000000000000000003"  # "outsider": exists, shares nothing


def _with_check_items(**by_name):
    """The fixture with extra keys merged into the named checkItems."""
    data = load_fixture()
    for cl in data["checklists"]:
        for ci in cl["checkItems"]:
            ci.update(by_name.get(ci["name"], {}))
    return data


class TrelloChecklistAssignDueTests(TrelloImportBase):
    def setUp(self):
        super().setUp()
        self.ada = User.objects.create_user(username="Ada", password="x")
        shared = Board.objects.create(name="Shared", owner=self.user)
        BoardMembership.objects.create(board=shared, user=self.user, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=shared, user=self.ada)
        self.outsider = User.objects.create_user(username="outsider", password="x")
        self.data = _with_check_items(**{
            "Book venue": {"idMember": ADA, "due": "2024-04-10T12:00:00.000Z"},
            "Send invite": {"idMember": OUTSIDER, "due": "2024-04-11T23:30:00.000-05:00"},
            "Survey": {"idMember": GRACE, "due": None},
            "Reproduce": {"idMember": None, "due": "not a date"},
        })

    def _items(self, mapping=None):
        extra = {"mapping": json.dumps(mapping)} if mapping else {}
        resp = self.post("confirm", data=self.data, **extra)
        self.assertEqual(resp.status_code, 201, resp.data)
        board_id = resp.data["board"]["id"]
        return {
            i.text: i for i in CardChecklist.objects.filter(card__board_id=board_id).select_related("assignee")
        }, resp

    def test_due_dates_map_to_utc_dates(self):
        items, _ = self._items()
        self.assertEqual(items["Launch: Book venue"].due_date, datetime.date(2024, 4, 10))
        # 23:30 at UTC-5 is the next day in UTC, as for card due dates.
        self.assertEqual(items["Launch: Send invite"].due_date, datetime.date(2024, 4, 12))
        self.assertIsNone(items["Follow-up: Survey"].due_date)
        self.assertIsNone(items["Reproduce"].due_date)

    def test_unreadable_item_due_is_counted_in_invalid_due_dates(self):
        preview = self.post("dry_run", data=self.data).data
        warnings = {w["code"]: w["count"] for w in preview["warnings"]}
        self.assertEqual(warnings["invalid_due_dates"], 1)

    def test_matched_visible_member_is_assigned_with_add_matched_members(self):
        items, _ = self._items({"add_matched_members": True})
        self.assertEqual(items["Launch: Book venue"].assignee, self.ada)
        # An existing account the importer cannot see never matches (Rule 5).
        self.assertIsNone(items["Launch: Send invite"].assignee)
        # No such user.
        self.assertIsNone(items["Follow-up: Survey"].assignee)
        self.assertIsNone(items["Reproduce"].assignee)

    def test_assignee_is_a_board_member(self):
        items, resp = self._items({"add_matched_members": True})
        self.assertTrue(BoardMembership.objects.filter(
            board_id=resp.data["board"]["id"], user=self.ada, role=BoardMembership.Role.MEMBER,
        ).exists())

    def test_without_add_matched_members_items_import_unassigned(self):
        items, _ = self._items()
        self.assertFalse(any(i.assignee_id for i in items.values()))

    def test_import_sends_no_notification(self):
        self._items({"add_matched_members": True})
        self.assertFalse(Notification.objects.filter(recipient=self.ada).exists())

    def test_bad_types_are_refused(self):
        for bad in ({"due": 5}, {"idMember": ["x"]}):
            with self.subTest(bad=bad):
                resp = self.post("dry_run", data=_with_check_items(**{"Survey": bad}))
                self.assertEqual(resp.status_code, 400, resp.data)

    def test_unmatched_members_warning_mentions_checklist_items(self):
        preview = self.post("dry_run", data=self.data).data
        [w] = [w for w in preview["warnings"] if w["code"] == "unmatched_members"]
        self.assertIn("checklist items", w["message"])
