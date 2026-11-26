"""``target_available`` and server-side mark-read for unreachable targets (#2081).

Owner decision on #2081: the server marks a notification read when its board
is unavailable to the recipient, so it drops out of the bell, and the list
response gains an additive ``target_available`` boolean that never tells a
deleted board from revoked access.

The absent-input cases (#1075) sit next to the populated ones: a serializer
built without the annotation, and the helpers called with no user, must report
"unavailable" and mark nothing.
"""

from django.contrib.auth.models import AnonymousUser
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Notification, Swimlane
from boards.views.notifications import (
    NotificationSerializer,
    _mark_unavailable_targets_read,
    _target_available_q,
)

LIST_URL = "/api/v1/notifications/"
COUNT_URL = "/api/v1/notifications/unread-count/"


def _board(owner, name="B2081"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


def _notify(recipient, board=None, card=None, verb="n2081"):
    return Notification.objects.create(
        recipient=recipient, verb=verb, board=board, card=card,
        action_type=Notification.ActionType.CARD_MOVED, read=False,
    )


class TargetAvailableFieldTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="ta_user", password="pass")
        self.other = User.objects.create_user(username="ta_owner", password="pass")
        self.client.force_authenticate(self.user)

    def _list(self):
        resp = self.client.get(LIST_URL)
        self.assertEqual(resp.status_code, 200)
        return resp.data

    def test_row_on_accessible_board_is_available(self):
        board = _board(self.user)
        col = Column.objects.create(board=board, name="C", position=0)
        swim = Swimlane.objects.create(board=board, name="S", position=0)
        card = Card.objects.create(
            board=board, column=col, swimlane=swim, title="T", created_by=self.user, position=0,
        )
        _notify(self.user, board=board, card=card)
        data = self._list()
        self.assertEqual(len(data), 1)
        self.assertIs(data[0]["target_available"], True)

    def test_boardless_row_is_available(self):
        _notify(self.user)
        data = self._list()
        self.assertEqual(len(data), 1)
        self.assertIs(data[0]["target_available"], True)

    def test_group_inherited_access_is_available_and_not_marked(self):
        from groups.models import Group, GroupMembership

        group = Group.objects.create(name="G2081", owner=self.other)
        GroupMembership.objects.create(group=group, user=self.user, role=GroupMembership.Role.MEMBER)
        board = Board.objects.create(name="GB2081", owner=self.other, group=group)
        n = _notify(self.user, board=board)
        data = self._list()
        self.assertEqual([row["id"] for row in data], [n.id])
        self.assertIs(data[0]["target_available"], True)
        n.refresh_from_db()
        self.assertFalse(n.read)

    def test_site_admin_row_on_foreign_board_is_available(self):
        admin = User.objects.create_user(username="ta_admin", password="pass")
        admin.can_access_all_content = True
        admin.save()
        n = _notify(admin, board=_board(self.other))
        self.client.force_authenticate(admin)
        data = self._list()
        self.assertEqual([row["id"] for row in data], [n.id])
        self.assertIs(data[0]["target_available"], True)
        n.refresh_from_db()
        self.assertFalse(n.read)

    def test_existing_fields_are_unchanged(self):
        """Additive only (1.0 contract): every pre-#2081 key is still present."""
        _notify(self.user, board=_board(self.user))
        row = self._list()[0]
        for key in (
            "id", "verb", "actor", "card_id", "card_title", "board_id", "board_name",
            "action_type", "mention_source", "read", "created_at",
        ):
            self.assertIn(key, row)


class UnavailableTargetMarkedReadTests(TestCase):
    """A row on a board the recipient can no longer open is marked read on list."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="ur_user", password="pass")
        self.other = User.objects.create_user(username="ur_owner", password="pass")
        self.board = _board(self.other)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.MEMBER)
        self.notification = _notify(self.user, board=self.board)
        self.client.force_authenticate(self.user)

    def test_revoked_row_is_marked_read_and_dropped(self):
        BoardMembership.objects.filter(board=self.board, user=self.user).delete()
        resp = self.client.get(LIST_URL)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data, [])
        self.notification.refresh_from_db()
        self.assertTrue(self.notification.read)
        self.assertEqual(self.client.get(COUNT_URL).data["count"], 0)

    def test_row_stays_read_if_access_returns(self):
        BoardMembership.objects.filter(board=self.board, user=self.user).delete()
        self.client.get(LIST_URL)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.MEMBER)
        self.assertEqual(self.client.get(LIST_URL).data, [])

    def test_unread_count_does_not_mark(self):
        """The 30 s badge poll stays read-only; it already excludes the row."""
        BoardMembership.objects.filter(board=self.board, user=self.user).delete()
        self.assertEqual(self.client.get(COUNT_URL).data["count"], 0)
        self.notification.refresh_from_db()
        self.assertFalse(self.notification.read)

    def test_deleted_and_revoked_targets_answer_identically(self):
        """Nothing in the response tells a deleted board from revoked access."""
        own = _board(self.user, name="Own2081")
        kept = _notify(self.user, board=own, verb="kept")

        BoardMembership.objects.filter(board=self.board, user=self.user).delete()
        revoked = self.client.get(LIST_URL)

        # Same starting state for the deleted case: a fresh unread row on a
        # board the user can open, which is then deleted outright.
        doomed = _board(self.other, name="Doomed2081")
        BoardMembership.objects.create(board=doomed, user=self.user, role=BoardMembership.Role.MEMBER)
        _notify(self.user, board=doomed)
        doomed.delete()
        deleted = self.client.get(LIST_URL)

        self.assertEqual(revoked.status_code, deleted.status_code)
        self.assertEqual(revoked.data, deleted.data)
        self.assertEqual([row["id"] for row in deleted.data], [kept.id])

    def test_never_marks_another_users_rows(self):
        """IDOR: the UPDATE is scoped to the requester's own notifications."""
        stranger = User.objects.create_user(username="ur_stranger", password="pass")
        # The stranger also lost access; only *their* list may mark their row.
        theirs = _notify(stranger, board=self.board)
        BoardMembership.objects.filter(board=self.board, user=self.user).delete()
        self.client.get(LIST_URL)
        theirs.refresh_from_db()
        self.assertFalse(theirs.read)

    def test_marked_rows_do_not_crowd_the_window(self):
        own = _board(self.user, name="Own2081b")
        for i in range(5):
            _notify(self.user, board=own, verb=f"own{i}")
        for i in range(60):
            _notify(self.user, board=self.board, verb=f"lost{i}")
        BoardMembership.objects.filter(board=self.board, user=self.user).delete()
        data = self.client.get(LIST_URL).data
        self.assertEqual(len(data), 5)
        self.assertTrue(all(row["target_available"] for row in data))
        self.assertEqual(
            Notification.objects.filter(recipient=self.user, board=self.board, read=False).count(), 0,
        )

    def test_list_query_count_constant_across_revoked_boards(self):
        BoardMembership.objects.filter(board=self.board, user=self.user).delete()

        def measure():
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.client.get(LIST_URL).status_code, 200)
            return len(ctx)

        baseline = measure()
        for i in range(8):
            lost = _board(self.other, name=f"Lost2081-{i}")
            _notify(self.user, board=lost)
        self.assertEqual(measure(), baseline)


class TargetAvailableAbsentInputTests(TestCase):
    """#1075: each guard built without its input fails closed."""

    def setUp(self):
        self.user = User.objects.create_user(username="ai_user", password="pass")
        self.notification = _notify(self.user, board=_board(self.user))

    def test_serializer_without_annotation_reports_unavailable(self):
        row = Notification.objects.get(pk=self.notification.pk)
        self.assertIs(NotificationSerializer(row).data["target_available"], False)

    def test_serializer_with_non_true_annotation_reports_unavailable(self):
        row = Notification.objects.get(pk=self.notification.pk)
        row._target_available = None
        self.assertIs(NotificationSerializer(row).data["target_available"], False)

    def test_predicate_without_user_matches_nothing(self):
        for absent in (None, AnonymousUser()):
            self.assertFalse(Notification.objects.filter(_target_available_q(absent)).exists())

    def test_predicate_with_user_matches_own_board(self):
        self.assertTrue(
            Notification.objects.filter(_target_available_q(self.user), pk=self.notification.pk).exists()
        )

    def test_mark_without_user_marks_nothing(self):
        for absent in (None, AnonymousUser()):
            self.assertEqual(_mark_unavailable_targets_read(absent, _target_available_q(absent)), 0)
        self.assertEqual(Notification.objects.filter(read=True).count(), 0)
